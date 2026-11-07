import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Exercises the REAL Supabase-backed store (lib/backend/email/retry-supabase.ts) against a tiny evaluator of the query-builder calls it makes.
 * This proves the eligibility filters sit inside the query, before the row limit (D4), and that recovered rows keep the event time (D2).
 */
type Row = Record<string, unknown>;
const h = vi.hoisted(() => ({ rows: [] as Record<string, unknown>[], inserted: [] as Record<string, unknown>[], order: null as Record<string, unknown> | null, filtersSeen: [] as string[] }));

function table(rows: Row[]) {
  const filters: ((r: Row) => boolean)[] = [];
  let ascending = true; let orderColumn = ''; let max = Infinity;
  const cmp = (a: unknown, b: unknown) => (String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0);
  const q = {
    select() { return q; },
    eq(c: string, v: unknown) { h.filtersSeen.push(`eq:${c}`); filters.push(r => r[c] === v); return q; },
    neq(c: string, v: unknown) { filters.push(r => r[c] !== v); return q; },
    in(c: string, vs: unknown[]) { filters.push(r => vs.includes(r[c])); return q; },
    gte(c: string, v: string) { filters.push(r => r[c] !== null && cmp(r[c], v) >= 0); return q; },
    lte(c: string, v: string) { h.filtersSeen.push(`lte:${c}`); filters.push(r => r[c] !== null && cmp(r[c], v) <= 0); return q; },
    lt(c: string, v: number) { filters.push(r => Number(r[c]) < v); return q; },
    not(c: string, op: string, v: unknown) { if (op === 'is' && v === null) { h.filtersSeen.push(`notnull:${c}`); filters.push(r => r[c] !== null && r[c] !== undefined); } return q; },
    order(c: string, o: { ascending: boolean }) { orderColumn = c; ascending = o.ascending; return q; },
    limit(n: number) { max = n; return q; },
    then(resolve: (v: { data: Row[]; error: null }) => unknown, reject?: (e: unknown) => unknown) {
      const out = rows.filter(r => filters.every(f => f(r)));
      if (orderColumn) out.sort((a, b) => (ascending ? 1 : -1) * cmp(a[orderColumn], b[orderColumn]));
      return Promise.resolve({ data: out.slice(0, max), error: null }).then(resolve, reject);
    },
  };
  return q;
}

vi.mock('@/lib/backend/core', async importOriginal => ({
  ...(await importOriginal<typeof import('@/lib/backend/core')>()),
  db: () => ({
    from: (name: string) => {
      if (name === 'email_log') return { ...table(h.rows), insert: async (row: Row) => { h.inserted.push(row); return { error: null }; } };
      throw new Error(`unexpected table ${name}`);
    },
  }),
}));
vi.mock('@/lib/backend/data', async importOriginal => ({
  ...(await importOriginal<typeof import('@/lib/backend/data')>()),
  loadOrder: async () => h.order,
  toOrder: (row: Record<string, unknown>) => row,
  orderMailData: (order: Record<string, unknown>) => ({ id: 'o1', number: '1218-1001', status: order.status, total: 100, paymentMethod: 'cod', contact: { name: 'A B', email: 'a@b.co' }, lines: [], shipment: null }),
}));

import { rebuildEmail, supabaseEmailStore } from '@/lib/backend/email/retry-supabase';
import { retryQueryBounds, MAX_ATTEMPTS } from '@/lib/backend/email/policy';
import type { LogRow } from '@/lib/backend/email/retry';

const NOW = new Date('2026-11-10T12:00:00Z');
const minutesAgo = (n: number) => new Date(NOW.getTime() - n * 60_000).toISOString();
const minutesAhead = (n: number) => new Date(NOW.getTime() + n * 60_000).toISOString();
const base = (over: Row): Row => ({ id: `id-${Math.random().toString(36).slice(2)}`, kind: 'order_status', to_email: 'c@example.com', subject: 's', entity_type: 'order', entity_id: 'o1', dedupe_key: `k-${Math.random()}`, status: 'failed', attempts: 1, created_at: minutesAgo(60), last_attempt_at: null, next_attempt_at: null, ...over });
const query = (limit = 25) => ({ ...retryQueryBounds(NOW), limit });

beforeEach(() => { h.rows = []; h.inserted = []; h.order = null; h.filtersSeen = []; });

describe('D4 on the real store: eligibility is applied before the limit', () => {
  it('250 ineligible rows older than the eligible ones do not hide them', async () => {
    const ineligible: Row[] = [];
    for (let i = 0; i < 250; i += 1) {
      ineligible.push(base({ id: `bad-${i}`, created_at: minutesAgo(1000 - i), status: i % 2 ? 'failed' : 'skipped_unconfigured', next_attempt_at: i % 3 === 0 ? null : minutesAhead(30) }));
    }
    const eligible = [
      base({ id: 'good-queued', status: 'queued', attempts: 0, created_at: minutesAgo(30) }),
      base({ id: 'good-failed', status: 'failed', created_at: minutesAgo(20), next_attempt_at: minutesAgo(1) }),
      base({ id: 'good-skipped', status: 'skipped_unconfigured', attempts: 0, created_at: minutesAgo(10), next_attempt_at: minutesAgo(1) }),
    ];
    h.rows = [...ineligible, ...eligible];
    expect(h.rows.length).toBeGreaterThan(250);
    const out = await supabaseEmailStore.candidates(query(200));
    expect(out.map(r => r.id)).toEqual(['good-queued', 'good-failed', 'good-skipped']);
  });

  it('never returns ineligible rows, whatever their number', async () => {
    h.rows = [
      base({ id: 'accepted', status: 'accepted' }), base({ id: 'delivered', status: 'delivered' }), base({ id: 'uncertain', status: 'uncertain' }), base({ id: 'sending', status: 'sending' }),
      base({ id: 'bounced', status: 'bounced' }), base({ id: 'complained', status: 'complained' }),
      base({ id: 'permanent', status: 'failed', next_attempt_at: null }),                                  // permanent / exhausted / pre-0009
      base({ id: 'pre-0009-skipped', status: 'skipped_unconfigured', attempts: 0, next_attempt_at: null }), // the production rows
      base({ id: 'not-due', status: 'failed', next_attempt_at: minutesAhead(5) }),
      base({ id: 'exhausted', status: 'failed', attempts: MAX_ATTEMPTS, next_attempt_at: minutesAgo(1) }),
      base({ id: 'too-old', status: 'failed', created_at: minutesAgo(25 * 60), next_attempt_at: minutesAgo(1) }),
      base({ id: 'queued-too-fresh', status: 'queued', attempts: 0, created_at: minutesAgo(1) }),         // the live request still owns it
      base({ id: 'alert', kind: 'system_alert', status: 'queued', attempts: 0 }),
      base({ id: 'ok', status: 'failed', next_attempt_at: minutesAgo(1) }),
    ];
    expect((await supabaseEmailStore.candidates(query())).map(r => r.id)).toEqual(['ok']);
  });

  it('keeps the existing ordering (oldest first) across both groups, and the limit applies to eligible rows only', async () => {
    h.rows = [
      base({ id: 'q1', status: 'queued', attempts: 0, created_at: minutesAgo(50) }),
      base({ id: 'f1', status: 'failed', created_at: minutesAgo(45), next_attempt_at: minutesAgo(1) }),
      base({ id: 'q2', status: 'queued', attempts: 0, created_at: minutesAgo(40) }),
      base({ id: 'f2', status: 'failed', created_at: minutesAgo(35), next_attempt_at: minutesAgo(1) }),
      ...Array.from({ length: 300 }, (_, i) => base({ id: `bad-${i}`, status: 'failed', created_at: minutesAgo(900 + i), next_attempt_at: null })),
    ];
    expect((await supabaseEmailStore.candidates(query(3))).map(r => r.id)).toEqual(['q1', 'f1', 'q2']);
  });

  it('puts the eligibility conditions in the database query itself (queued + grace, due retry + not-null next attempt)', async () => {
    await supabaseEmailStore.candidates(query());
    expect(h.filtersSeen).toEqual(expect.arrayContaining(['eq:status', 'lte:created_at', 'notnull:next_attempt_at', 'lte:next_attempt_at']));
  });
});

describe('D2 on the real store: recovered rows keep the original event time and dedupe on the existing unique key', () => {
  it('inserts with created_at = the event time, status queued', async () => {
    await supabaseEmailStore.insertQueued({ kind: 'order_status', to_email: 'c@example.com', subject: 'Order 1: delivered', entity_type: 'order', entity_id: 'o1', dedupe_key: 'order:o1:delivered', created_at: minutesAgo(90) });
    expect(h.inserted).toEqual([expect.objectContaining({ status: 'queued', created_at: minutesAgo(90), dedupe_key: 'order:o1:delivered' })]);
  });
});

describe('D2 on the real store: a superseded notice is never rebuilt for sending', () => {
  const row = (part: string): LogRow => ({ id: 'r1', kind: 'order_status', to_email: 'a@b.co', subject: 's', entity_type: 'order', entity_id: 'o1', dedupe_key: `order:o1:${part}`, status: 'failed', attempts: 1, created_at: minutesAgo(60), last_attempt_at: null, next_attempt_at: minutesAgo(1) });

  it('processing / packed / shipped after the order is delivered → superseded', async () => {
    h.order = { status: 'delivered', contact: { name: 'A B', email: 'a@b.co' } };
    for (const part of ['processing', 'packed', 'shipped']) expect(await rebuildEmail(row(part)), part).toBe('superseded');
  });
  it('anything but a cancellation is superseded once the order is cancelled; a cancellation never is', async () => {
    h.order = { status: 'cancelled', contact: { name: 'A B', email: 'a@b.co' } };
    expect(await rebuildEmail(row('processing'))).toBe('superseded');
    expect(await rebuildEmail(row('cancelled'))).toMatchObject({ kind: 'order_status' });
  });
  it('the current status itself, and the confirmation, are still rebuilt', async () => {
    h.order = { status: 'delivered', contact: { name: 'A B', email: 'a@b.co' } };
    expect(await rebuildEmail(row('delivered'))).toMatchObject({ kind: 'order_status', dedupeKey: 'order:o1:delivered' });
    expect(await rebuildEmail(row('confirmation'))).toMatchObject({ kind: 'order_confirmation', dedupeKey: 'order:o1:confirmation' });
  });
  it('a missing order is reported as gone, not superseded', async () => {
    h.order = null;
    expect(await rebuildEmail(row('processing'))).toBeNull();
  });
});
