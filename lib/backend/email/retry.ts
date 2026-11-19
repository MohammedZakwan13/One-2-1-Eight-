/**
 * Email retry + crash recovery. Runs from POST /api/internal/email-retry (VPS cron, every 5 minutes).
 *
 * What it does, in order:
 *   1. sweeps claims that never finished (crashed worker) to `uncertain`: outcome unknown, so NEVER resent;
 *   2. RECONCILES: for orders whose last 24 h of history should have produced a customer email, makes sure an `email_log` row exists.
 *      A row is missing exactly when the application stopped after the order / status change committed but before the original email
 *      attempt. To stay safe it recovers only
 *         - the order confirmation, and
 *         - the LATEST status notification of each order (never an older "processing" / "packed" once the order has moved on),
 *      and it stamps the recovered row with the ORIGINAL event time, so the 24-hour window is measured from the event, not from recovery;
 *   3. retries eligible rows (queued, failed or skipped with a due `next_attempt_at`, younger than 24 h, under the attempt cap). Eligibility
 *      is applied in the database query BEFORE the row limit, so ineligible rows can never hide eligible ones. Each row is claimed
 *      atomically, so overlapping workers never send the same email twice. A status email that has been superseded by a later status
 *      (e.g. "packed" after "delivered") is dropped instead of sent.
 *
 * Execution budget: the run stops claiming new notifications when the remaining budget could not cover a worst-case send, and it
 * never interrupts a send that is already in flight. It stops early when the provider itself is failing (revoked credentials, quota,
 * repeated outages) instead of hammering it. Uncertain outcomes, accepted rows and permanent errors are never touched.
 */
import {
  RECONCILE_GRACE_MS, RETRY_WINDOW_MS, canStartAnotherSend, isRetryEligible, orderEventEmail, retryQueryBounds, type FailureKind,
} from '@/lib/backend/email/policy';

export type LogRow = {
  id: string; kind: string; to_email: string; subject: string; entity_type: string | null; entity_id: string | null; dedupe_key: string;
  status: string; attempts: number; created_at: string; last_attempt_at: string | null; next_attempt_at: string | null;
};
export type OrderEvent = { orderId: string; toStatus: string; actorType: string; at: string; toEmail: string; orderNumber: string };
export type DeliverResult = { status: 'accepted' | 'failed' | 'skipped_unconfigured' | 'already_sent' | 'uncertain' | 'in_progress' | 'superseded'; failureKind?: FailureKind };

export type CandidateQuery = { sinceIso: string; nowIso: string; graceIso: string; maxAttempts: number; limit: number };
export type RecoveryRow = { kind: string; to_email: string; subject: string; entity_type: string; entity_id: string; dedupe_key: string; /** the ORIGINAL event time */ created_at: string };

export interface EmailStore {
  /** `sending` claims older than the lease become `uncertain`. Returns how many. */
  sweepStale(): Promise<number>;
  orderEvents(sinceIso: string, untilIso: string): Promise<OrderEvent[]>;
  existingKeys(keys: string[]): Promise<Set<string>>;
  /** Inserts a queued row; a duplicate dedupe_key is silently ignored (another worker or the live path got there first). */
  insertQueued(row: RecoveryRow): Promise<void>;
  /**
   * The oldest `limit` rows that are eligible RIGHT NOW: the eligibility rules are applied inside the query, before the limit, so
   * ineligible rows (permanent failures, not-yet-due retries, exhausted rows) can never push eligible ones out of the result.
   */
  candidates(query: CandidateQuery): Promise<LogRow[]>;
  /** The source record is gone or the email is obsolete: stop retrying (permanent). */
  giveUp(id: string, reason: string): Promise<void>;
}

export type RetryDeps = {
  store: EmailStore;
  now: () => Date;
  /** Regenerate the email for `row` and make ONE delivery attempt (claim → provider → record). `null` = the source record is missing. */
  deliver: (row: LogRow) => Promise<DeliverResult | null>;
  onTrip?: (kind: Exclude<FailureKind, 'permanent' | 'uncertain' | 'unconfigured'>) => Promise<void> | void;
};

export type RetrySummary = {
  swept: number; reconciled: number; considered: number; accepted: number; failed: number; uncertain: number; skipped: number; inProgress: number; gaveUp: number;
  tripped: 'auth' | 'quota' | 'transient' | null;
  /** True when the run stopped claiming new notifications because the execution budget was used up (the rest waits for the next run). */
  stoppedForBudget: boolean;
};

const STATUS_ORDER: Record<string, number> = { processing: 2, packed: 3, shipped: 4, delivered: 5, refunded: 6, cancelled: 7 };

/**
 * From an order's recent history events, the emails worth recovering: the confirmation (if it happened) and ONLY the latest status event.
 * Pure, so it is unit-tested directly.
 */
export function selectRecoveries(events: OrderEvent[]): { event: OrderEvent; kind: 'order_confirmation' | 'order_status'; dedupeKey: string }[] {
  const confirmations = new Map<string, { event: OrderEvent; dedupeKey: string }>();
  const latestStatus = new Map<string, { event: OrderEvent; dedupeKey: string }>();
  for (const event of events) {
    if (!event.toEmail) continue;
    const mapped = orderEventEmail({ orderId: event.orderId, toStatus: event.toStatus, actorType: event.actorType });
    if (!mapped) continue;
    if (mapped.kind === 'order_confirmation') {
      if (!confirmations.has(event.orderId)) confirmations.set(event.orderId, { event, dedupeKey: mapped.dedupeKey });
      continue;
    }
    const current = latestStatus.get(event.orderId);
    const newer = !current || event.at > current.event.at || (event.at === current.event.at && (STATUS_ORDER[event.toStatus] ?? 0) > (STATUS_ORDER[current.event.toStatus] ?? 0));
    if (newer) latestStatus.set(event.orderId, { event, dedupeKey: mapped.dedupeKey });
  }
  return [
    ...[...confirmations.values()].map(item => ({ ...item, kind: 'order_confirmation' as const })),
    ...[...latestStatus.values()].map(item => ({ ...item, kind: 'order_status' as const })),
  ];
}

export async function runEmailRetry(deps: RetryDeps, options: { limit?: number; budgetMs?: number; sendReserveMs?: number } = {}): Promise<RetrySummary> {
  const { store } = deps;
  const startedAt = deps.now();
  const limit = options.limit ?? 25;
  const summary: RetrySummary = { swept: 0, reconciled: 0, considered: 0, accepted: 0, failed: 0, uncertain: 0, skipped: 0, inProgress: 0, gaveUp: 0, tripped: null, stoppedForBudget: false };

  summary.swept = await store.sweepStale();

  // 2. reconcile: confirmation + latest status per order, stamped with the original event time
  const since = new Date(startedAt.getTime() - RETRY_WINDOW_MS).toISOString();
  const until = new Date(startedAt.getTime() - RECONCILE_GRACE_MS).toISOString();
  const recoveries = selectRecoveries(await store.orderEvents(since, until));
  const have = await store.existingKeys(recoveries.map(item => item.dedupeKey));
  for (const { event, kind, dedupeKey } of recoveries) {
    if (have.has(dedupeKey)) continue;
    await store.insertQueued({
      kind, to_email: event.toEmail, subject: `Order ${event.orderNumber}: ${event.toStatus.replace(/_/g, ' ')}`,
      entity_type: 'order', entity_id: event.orderId, dedupe_key: dedupeKey, created_at: event.at,
    });
    summary.reconciled += 1;
  }

  // 3. retry: eligibility is decided by the database query (before the limit); the in-memory check is only a second guard
  const rows = (await store.candidates({ ...retryQueryBounds(startedAt), limit }))
    .filter(row => isRetryEligible(row, startedAt))
    .sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at));
  let transientStreak = 0;
  for (const row of rows) {
    // Never start a send that could overrun the budget; never interrupt one that has started.
    if (!canStartAnotherSend(deps.now().getTime() - startedAt.getTime(), options.budgetMs, options.sendReserveMs)) { summary.stoppedForBudget = true; break; }
    summary.considered += 1;
    const result = await deps.deliver(row);
    if (!result) { await store.giveUp(row.id, 'source record no longer exists'); summary.gaveUp += 1; continue; }
    if (result.status === 'superseded') { await store.giveUp(row.id, 'superseded by a later order status'); summary.gaveUp += 1; continue; }
    if (result.status === 'accepted' || result.status === 'already_sent') { summary.accepted += 1; transientStreak = 0; continue; }
    if (result.status === 'in_progress') { summary.inProgress += 1; continue; }
    if (result.status === 'uncertain') { summary.uncertain += 1; continue; }
    if (result.status === 'skipped_unconfigured') { summary.skipped += 1; summary.tripped = null; break; } // no provider credentials: every other row would be skipped too
    summary.failed += 1;
    const kind = result.failureKind;
    if (kind === 'auth' || kind === 'quota') { summary.tripped = kind; await deps.onTrip?.(kind); break; }
    if (kind === 'transient') {
      transientStreak += 1;
      if (transientStreak >= 3) { summary.tripped = 'transient'; await deps.onTrip?.('transient'); break; }
    } else transientStreak = 0;
  }
  return summary;
}
