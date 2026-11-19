/**
 * Pure retry / duplicate-prevention rules for outbound email. No I/O here so every rule is unit-testable.
 *
 * Principle: a customer must never receive the same notification twice, and a provider problem must never lose a
 * notification silently. So:
 *   - definitive failures (we know nothing was sent) are retried with exponential backoff, within a bounded window;
 *   - uncertain outcomes (the provider may have sent it, the answer was lost) are NEVER retried automatically;
 *   - permanent errors (bad request) are never retried;
 *   - provider-wide problems (revoked credentials, quota) are retried later without burning the notification's attempts.
 */

export const MAX_ATTEMPTS = 6;
export const RETRY_WINDOW_MS = 24 * 60 * 60 * 1000;
/** A claim older than this whose worker never reported back is treated as uncertain (never resent). */
export const STALE_SENDING_MS = 10 * 60 * 1000;
/** The live path inserts the log row a moment after the order commits; the reconciler waits this long before it steps in. */
export const RECONCILE_GRACE_MS = 2 * 60 * 1000;
/** Backoff after attempt 1, 2, 3, ... (the last value repeats). */
export const BACKOFF_MS = [5, 15, 45, 120, 360].map(minutes => minutes * 60_000);
const AUTH_RETRY_MS = 15 * 60_000;
const UNCONFIGURED_RETRY_MS = 15 * 60_000;

export type FailureKind = 'auth' | 'quota' | 'transient' | 'permanent' | 'uncertain' | 'unconfigured';

export const backoffMs = (attempts: number) => BACKOFF_MS[Math.min(Math.max(attempts, 1), BACKOFF_MS.length) - 1];

export type RetryDecision = {
  status: 'failed' | 'uncertain' | 'skipped_unconfigured';
  /** null = never retry */
  nextAttemptAt: Date | null;
  /** false for provider-wide problems (auth, quota, missing credentials): they are not this notification's fault */
  countsAttempt: boolean;
};

/** `attempts` is the count INCLUDING the attempt that just failed. */
export function decideRetry(input: { kind: FailureKind; attempts: number; createdAt: Date; now: Date; retryAfterMs?: number | null }): RetryDecision {
  const { kind, attempts, createdAt, now } = input;
  const windowEnd = createdAt.getTime() + RETRY_WINDOW_MS;
  const within = (at: Date) => at.getTime() <= windowEnd;
  const at = (ms: number) => new Date(now.getTime() + ms);

  if (kind === 'uncertain') return { status: 'uncertain', nextAttemptAt: null, countsAttempt: true };
  if (kind === 'permanent') return { status: 'failed', nextAttemptAt: null, countsAttempt: true };

  if (kind === 'unconfigured') {
    const next = at(UNCONFIGURED_RETRY_MS);
    return { status: 'skipped_unconfigured', nextAttemptAt: within(next) ? next : null, countsAttempt: false };
  }
  if (kind === 'auth') {
    const next = at(AUTH_RETRY_MS);
    return { status: 'failed', nextAttemptAt: within(next) ? next : null, countsAttempt: false };
  }
  if (kind === 'quota') {
    const next = at(Math.max(input.retryAfterMs ?? 0, backoffMs(Math.max(attempts, 1))));
    return { status: 'failed', nextAttemptAt: within(next) ? next : null, countsAttempt: false };
  }
  // transient
  if (attempts >= MAX_ATTEMPTS) return { status: 'failed', nextAttemptAt: null, countsAttempt: true };
  const next = at(backoffMs(attempts));
  return { status: 'failed', nextAttemptAt: within(next) ? next : null, countsAttempt: true };
}

export type RetryableRow = { status: string; attempts: number; created_at: string; next_attempt_at: string | null; kind: string };

/** Is this log row eligible for a (re)send right now? */
export function isRetryEligible(row: RetryableRow, now: Date): boolean {
  if (row.kind === 'system_alert') return false;
  if (now.getTime() - Date.parse(row.created_at) > RETRY_WINDOW_MS) return false;
  if (row.attempts >= MAX_ATTEMPTS) return false;
  if (row.status === 'queued') return now.getTime() - Date.parse(row.created_at) >= RECONCILE_GRACE_MS;
  if (row.status === 'failed' || row.status === 'skipped_unconfigured') return row.next_attempt_at !== null && Date.parse(row.next_attempt_at) <= now.getTime();
  return false; // sending (someone else holds it), accepted, delivered, bounced, complained, uncertain
}

/**
 * Late payment on an order that was already cancelled: settle_payment keeps the money, flags `needs_refund`, and still reports
 * `changed: true`. That must NEVER produce a normal order-confirmation email. Every other settlement is unchanged.
 */
export function shouldSendConfirmation(settled: unknown): boolean {
  if (!settled || typeof settled !== 'object') return false;
  const s = settled as { changed?: unknown; needs_refund?: unknown };
  return s.changed === true && s.needs_refund !== true;
}

/** Which order-history events deserve a customer email, and under which dedupe key. null = no email. */
export function orderEventEmail(event: { orderId: string; toStatus: string; actorType: string }): { kind: 'order_confirmation' | 'order_status'; dedupeKey: string } | null {
  const { orderId, toStatus, actorType } = event;
  if (toStatus === 'confirmed') return { kind: 'order_confirmation', dedupeKey: `order:${orderId}:confirmation` };
  if (['processing', 'packed', 'shipped', 'delivered', 'refunded'].includes(toStatus)) return { kind: 'order_status', dedupeKey: `order:${orderId}:${toStatus}` };
  // Cancellations the customer or an admin made are emailed; the system's own cancellation (payment never started / timed out) is not.
  if (toStatus === 'cancelled' && actorType !== 'system') return { kind: 'order_status', dedupeKey: `order:${orderId}:cancelled` };
  return null;
}

export const EMAIL_KIND_FROM_KEY = (dedupeKey: string): { type: 'order' | 'return' | 'lead' | 'unknown'; id: string; part: string } => {
  const [type, id, part] = dedupeKey.split(':');
  if ((type === 'order' || type === 'return' || type === 'lead') && id && part) return { type, id, part };
  return { type: 'unknown', id: '', part: '' };
};

// ───────────── worker execution budget (a cron run must finish well inside the 5-minute cron interval) ─────────────

/** A retry run stops claiming new notifications so that it ends within about this long. */
export const WORKER_BUDGET_MS = 40_000;
/**
 * Worst case for ONE send already in flight: the Resend request (8 s timeout) plus the claim and result database calls, with generous
 * slack. A new notification is only
 * claimed while at least this much of the budget remains, so a send is never started that could overrun it, and an in-flight send is
 * never interrupted to meet it.
 */
export const SEND_WORST_CASE_MS = 18_000;

export const canStartAnotherSend = (elapsedMs: number, budgetMs = WORKER_BUDGET_MS, reserveMs = SEND_WORST_CASE_MS) => elapsedMs + reserveMs <= budgetMs;

// ───────────── never send an older status after a later one ─────────────

const STATUS_RANK: Record<string, number> = { confirmed: 1, processing: 2, packed: 3, shipped: 4, delivered: 5, refunded: 6 };

/**
 * True when an email about `emailStatus` would now be stale because the order has already moved on (e.g. a "processing" or "packed"
 * email after the order is delivered or cancelled). A cancellation email is never superseded: it is a terminal fact in its own right.
 */
export function isSupersededStatus(emailStatus: string, currentStatus: string): boolean {
  if (emailStatus === 'cancelled' || emailStatus === 'confirmation') return false;
  const emailRank = STATUS_RANK[emailStatus];
  if (emailRank === undefined) return false;
  if (currentStatus === 'cancelled') return true; // processing / packed / shipped / delivered / refunded notices are stale once cancelled
  const currentRank = STATUS_RANK[currentStatus];
  return currentRank !== undefined && currentRank > emailRank;
}

/** Eligibility bounds shared by the in-memory check and the database query, so both always agree. */
export function retryQueryBounds(now: Date) {
  return {
    sinceIso: new Date(now.getTime() - RETRY_WINDOW_MS).toISOString(),
    nowIso: now.toISOString(),
    graceIso: new Date(now.getTime() - RECONCILE_GRACE_MS).toISOString(),
    maxAttempts: MAX_ATTEMPTS,
  };
}
