import 'server-only';
import { getServerEnv } from '@/lib/env';
import { db, trackingUrl } from '@/lib/backend/core';
import { loadOrder, orderMailData, toOrder, type Row } from '@/lib/backend/data';
import { alertAdmin, attemptDelivery, emailRetryQueueReady, leadAckEmail, leadInternalEmail, orderEmail, returnEmail, type EmailInput } from '@/lib/backend/integrations';
import { EMAIL_KIND_FROM_KEY, STALE_SENDING_MS, isSupersededStatus } from '@/lib/backend/email/policy';
import { runEmailRetry, type EmailStore, type LogRow, type OrderEvent, type RetryDeps } from '@/lib/backend/email/retry';

const LOG_COLUMNS = 'id, kind, to_email, subject, entity_type, entity_id, dedupe_key, status, attempts, created_at, last_attempt_at, next_attempt_at';
const chunk = <T,>(items: T[], size: number) => Array.from({ length: Math.ceil(items.length / size) }, (_, i) => items.slice(i * size, (i + 1) * size));

export class QueueMigrationRequired extends Error {}

export const supabaseEmailStore: EmailStore = {
  async sweepStale() {
    const { data, error } = await db().rpc('sweep_stale_email_sending', { p_stale_seconds: Math.round(STALE_SENDING_MS / 1000) });
    if (error) {
      if (/does not exist|schema cache|PGRST202|42883/.test(error.message ?? '')) throw new QueueMigrationRequired('migration 0009 is not applied');
      throw new Error(error.message);
    }
    return Number(data ?? 0);
  },
  async orderEvents(sinceIso, untilIso) {
    const { data, error } = await db().from('order_status_history')
      .select('order_id, to_status, actor_type, created_at, orders(number, contact)')
      .gte('created_at', sinceIso).lt('created_at', untilIso)
      .in('to_status', ['confirmed', 'processing', 'packed', 'shipped', 'delivered', 'cancelled', 'refunded'])
      .order('created_at', { ascending: true }).limit(2000);
    if (error) throw new Error(error.message);
    return ((data ?? []) as unknown as Row[]).map((r): OrderEvent => {
      const order = (Array.isArray(r.orders) ? r.orders[0] : r.orders) as { number?: string; contact?: { email?: string } } | null;
      return { orderId: r.order_id, toStatus: r.to_status, actorType: r.actor_type, at: r.created_at, toEmail: order?.contact?.email ?? '', orderNumber: order?.number ?? '' };
    });
  },
  async existingKeys(keys) {
    const found = new Set<string>();
    for (const part of chunk(keys, 100)) {
      const { data, error } = await db().from('email_log').select('dedupe_key').in('dedupe_key', part);
      if (error) throw new Error(error.message);
      for (const row of data ?? []) found.add(row.dedupe_key as string);
    }
    return found;
  },
  async insertQueued(row) {
    const { error } = await db().from('email_log').insert({ ...row, status: 'queued' });
    if (error && error.code !== '23505') throw new Error(error.message);
  },
  async candidates({ sinceIso, nowIso, graceIso, maxAttempts, limit }) {
    // Eligibility is part of each query, so the limit only ever applies to ELIGIBLE rows (no starvation by ineligible ones).
    // Group 1: brand-new / crash-orphaned rows that were never claimed and are past the live request's two-minute grace.
    const fresh = await db().from('email_log').select(LOG_COLUMNS)
      .eq('status', 'queued').lte('created_at', graceIso)
      .gte('created_at', sinceIso).lt('attempts', maxAttempts).neq('kind', 'system_alert')
      .order('created_at', { ascending: true }).limit(limit);
    // Group 2: rows scheduled for a retry whose time has come (no next_attempt_at = permanent / exhausted / pre-0009, never retried).
    const due = await db().from('email_log').select(LOG_COLUMNS)
      .in('status', ['failed', 'skipped_unconfigured']).not('next_attempt_at', 'is', null).lte('next_attempt_at', nowIso)
      .gte('created_at', sinceIso).lt('attempts', maxAttempts).neq('kind', 'system_alert')
      .order('created_at', { ascending: true }).limit(limit);
    if (fresh.error) throw new Error(fresh.error.message);
    if (due.error) throw new Error(due.error.message);
    // The oldest `limit` eligible rows overall are always inside the union of each group's oldest `limit`.
    return [...((fresh.data ?? []) as LogRow[]), ...((due.data ?? []) as LogRow[])]
      .sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at) || a.id.localeCompare(b.id))
      .slice(0, limit);
  },
  async giveUp(id, reason) {
    await db().from('email_log').update({ status: 'failed', next_attempt_at: null, error: `permanent:${reason}`.slice(0, 300), updated_at: new Date().toISOString() }).eq('id', id).in('status', ['queued', 'failed', 'skipped_unconfigured']);
  },
};

/** Rebuilds the email for a log row from the live order / return / lead. `null` = the source record no longer exists; `'superseded'` = a later order status makes this notice stale. */
export async function rebuildEmail(row: LogRow): Promise<EmailInput | null | 'superseded'> {
  const ref = EMAIL_KIND_FROM_KEY(row.dedupe_key);
  const base = { dedupeKey: row.dedupe_key, entityType: row.entity_type ?? undefined, entityId: row.entity_id ?? undefined };

  if (ref.type === 'order') {
    const data = await loadOrder(ref.id);
    if (!data) return null;
    const order = toOrder(data);
    const mail = orderMailData(order);
    // Never send an older notice (processing, packed, ...) after the order has already moved on (delivered, cancelled, ...).
    if (isSupersededStatus(ref.part, order.status)) return 'superseded';
    if (ref.part === 'confirmation') return { kind: 'order_confirmation', to: order.contact.email, ...orderEmail(mail, 'confirmation'), ...base };
    // The email describes the event it was queued for, not whatever the order has moved on to since.
    return { kind: 'order_status', to: order.contact.email, ...orderEmail({ ...mail, status: ref.part }, 'status'), ...base };
  }

  if (ref.type === 'return') {
    const { data } = await db().from('returns').select('id, number, status, orders(id, number, contact)').eq('id', ref.id).maybeSingle();
    const ret = data as unknown as { id: string; number: string; orders: { id: string; number: string; contact: { name: string; email: string } } | { id: string; number: string; contact: { name: string; email: string } }[] } | null;
    const order = Array.isArray(ret?.orders) ? ret?.orders[0] : ret?.orders;
    if (!ret || !order) return null;
    const refund = (await db().from('refunds').select('amount, provider_refund_id').eq('return_id', ret.id).maybeSingle()).data as { amount?: number; provider_refund_id?: string | null } | null;
    return { kind: 'return_status', to: order.contact.email, ...returnEmail({ id: ret.id, number: ret.number, orderNumber: order.number, status: ref.part, to: order.contact.email, name: order.contact.name, trackUrl: trackingUrl(order.id), refundAmount: refund?.amount ?? null, refundReference: refund?.provider_refund_id ?? null }), ...base };
  }

  if (ref.type === 'lead') {
    const { data } = await db().from('leads').select('id, name, email, phone, type, quantity, message').eq('id', ref.id).maybeSingle();
    if (!data) return null;
    const lead = data as { id: string; name: string; email: string; phone: string; type: string; quantity: string; message: string };
    if (ref.part === 'internal') {
      const to = getServerEnv().internalNotificationEmail;
      return to ? { kind: 'lead_internal', to, ...leadInternalEmail(lead), ...base } : null;
    }
    return { kind: 'lead_ack', to: lead.email, ...leadAckEmail(lead), ...base };
  }
  return null;
}

export function supabaseRetryDeps(): RetryDeps {
  return {
    store: supabaseEmailStore,
    now: () => new Date(),
    deliver: async row => {
      const input = await rebuildEmail(row);
      if (input === 'superseded') return { status: 'superseded' };
      if (!input) return null;
      const result = await attemptDelivery(row.id, input, new Date(row.created_at));
      return { status: result.status, failureKind: result.failureKind };
    },
    onTrip: async kind => {
      // An authentication failure is already alerted by the delivery attempt itself (`email_auth`), so only the other kinds are raised here.
      if (kind !== 'auth' && getServerEnv().emailProvider === 'resend') {
        await alertAdmin('email_stalled', 'Email sending is stalled', `Customer emails are queued but Resend keeps failing (${kind}). They are kept and retried automatically for up to 24 hours from the order. If this continues, check the Resend dashboard (status, sending limits, domain verification).`);
      }
    },
  };
}

export const runSupabaseEmailRetry = async () => {
  try {
    const summary = await runEmailRetry(supabaseRetryDeps());
    return { ...summary, queueReady: emailRetryQueueReady() !== false, migrationRequired: false as const };
  } catch (error) {
    if (error instanceof QueueMigrationRequired) return { migrationRequired: true as const };
    throw error;
  }
};
