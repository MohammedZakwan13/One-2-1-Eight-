import { describe, expect, it, vi } from 'vitest';
import { isRetryEligible, WORKER_BUDGET_MS } from '@/lib/backend/email/policy';
import { runEmailRetry, selectRecoveries, type CandidateQuery, type DeliverResult, type EmailStore, type LogRow, type OrderEvent } from '@/lib/backend/email/retry';

const NOW = new Date('2026-11-10T12:00:00Z');
const minutesAgo = (n: number) => new Date(NOW.getTime() - n * 60_000).toISOString();
const hoursAgo = (n: number) => minutesAgo(n * 60);
const minutesAhead = (n: number) => new Date(NOW.getTime() + n * 60_000).toISOString();

/**
 * In-memory EmailStore. `candidates` applies the eligibility rules BEFORE the limit, exactly like the database queries do, so the
 * starvation regression test means something. Inserted rows keep the `created_at` they are given (the original event time).
 */
function memoryStore(init: { events?: OrderEvent[]; rows?: Partial<LogRow>[]; stale?: number } = {}) {
  const rows: LogRow[] = (init.rows ?? []).map((r, i) => ({ id: `r${i + 1}`, kind: 'order_status', to_email: 'c@example.com', subject: 's', entity_type: 'order', entity_id: 'o1', dedupe_key: `order:o${i + 1}:shipped`, status: 'failed', attempts: 1, created_at: minutesAgo(60), last_attempt_at: null, next_attempt_at: minutesAgo(1), ...r }));
  const store: EmailStore & { rows: LogRow[]; given: string[]; queries: CandidateQuery[] } = {
    rows, given: [], queries: [],
    async sweepStale() { return init.stale ?? 0; },
    async orderEvents(since, until) { return (init.events ?? []).filter(e => e.at >= since && e.at < until); },
    async existingKeys(keys) { return new Set(rows.filter(r => keys.includes(r.dedupe_key)).map(r => r.dedupe_key)); },
    async insertQueued(row) { if (!rows.some(r => r.dedupe_key === row.dedupe_key)) rows.push({ id: `n${rows.length + 1}`, status: 'queued', attempts: 0, last_attempt_at: null, next_attempt_at: null, ...row }); },
    async candidates(query) {
      store.queries.push(query);
      return rows
        .filter(r => isRetryEligible(r, new Date(query.nowIso)))
        .sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at))
        .slice(0, query.limit);
    },
    async giveUp(id, reason) { store.given.push(`${id}:${reason}`); const r = rows.find(x => x.id === id); if (r) Object.assign(r, { status: 'failed', next_attempt_at: null }); },
  };
  return store;
}
const event = (over: Partial<OrderEvent> = {}): OrderEvent => ({ orderId: 'o1', toStatus: 'confirmed', actorType: 'system', at: minutesAgo(30), toEmail: 'c@example.com', orderNumber: '1218-1001', ...over });
const accepted: DeliverResult = { status: 'accepted' };
const run = (store: EmailStore, deliver: (row: LogRow) => Promise<DeliverResult | null>, onTrip?: () => void) => runEmailRetry({ store, now: () => NOW, deliver, onTrip });

describe('crash recovery (reconciliation)', () => {
  it('an order that committed but never got its email attempt (app crashed) is found and emailed exactly once', async () => {
    const store = memoryStore({ events: [event()] });
    const deliver = vi.fn(async (row: LogRow) => { row.status = 'accepted'; return accepted; });
    const first = await run(store, deliver);
    expect(first).toMatchObject({ reconciled: 1, considered: 1, accepted: 1 });
    expect(store.rows).toHaveLength(1);
    expect(store.rows[0]).toMatchObject({ dedupe_key: 'order:o1:confirmation', kind: 'order_confirmation', to_email: 'c@example.com' });
    const second = await run(store, deliver); // the next cron run finds the accepted row and does nothing
    expect(second).toMatchObject({ reconciled: 0, considered: 0 });
    expect(deliver).toHaveBeenCalledTimes(1);
  });

  it('does not touch an event whose email was already attempted by the live request', async () => {
    const store = memoryStore({ events: [event()], rows: [{ dedupe_key: 'order:o1:confirmation', status: 'accepted', next_attempt_at: null }] });
    const deliver = vi.fn(async () => accepted);
    expect(await run(store, deliver)).toMatchObject({ reconciled: 0, considered: 0 });
    expect(deliver).not.toHaveBeenCalled();
  });

  it('waits two minutes before stepping in, so it cannot race the live request that is about to log the email', async () => {
    const store = memoryStore({ events: [event({ at: minutesAgo(1) })] });
    expect(await run(store, async () => accepted)).toMatchObject({ reconciled: 0 });
  });

  it('ignores events older than 24 hours (the window is measured from the EVENT)', async () => {
    const store = memoryStore({ events: [event({ at: hoursAgo(30) }), event({ orderId: 'o2', at: minutesAgo(24 * 60 + 1) })] });
    expect(await run(store, async () => accepted)).toMatchObject({ reconciled: 0 });
  });

  it('covers every real status change, and skips what must not be emailed', async () => {
    const events = [
      event({ orderId: 'a', toStatus: 'processing', actorType: 'admin' }),
      event({ orderId: 'b', toStatus: 'packed', actorType: 'admin' }),
      event({ orderId: 'c', toStatus: 'shipped', actorType: 'admin' }),
      event({ orderId: 'd', toStatus: 'delivered', actorType: 'admin' }),
      event({ orderId: 'e', toStatus: 'cancelled', actorType: 'customer' }),
      event({ orderId: 'f', toStatus: 'refunded', actorType: 'admin' }),
      event({ orderId: 'g', toStatus: 'cancelled', actorType: 'system' }),   // payment never started / timed out: no email
      event({ orderId: 'h', toStatus: 'pending_payment', actorType: 'system' }), // not an email event
      event({ orderId: 'i', toStatus: 'confirmed', actorType: 'payment' }),  // online payment confirmed
    ];
    const store = memoryStore({ events });
    const summary = await run(store, async () => accepted);
    expect(summary.reconciled).toBe(7);
    expect(store.rows.map(r => r.dedupe_key).sort()).toEqual(['order:a:processing', 'order:b:packed', 'order:c:shipped', 'order:d:delivered', 'order:e:cancelled', 'order:f:refunded', 'order:i:confirmation']);
  });

  it('a late payment on a cancelled order produces no history event, so it can never be reconciled into a confirmation', async () => {
    // settle_payment records no order_status_history row in that case (verified against real Postgres in db-email-retry.sh)
    const store = memoryStore({ events: [event({ orderId: 'late', toStatus: 'cancelled', actorType: 'system', at: minutesAgo(60) })] });
    await run(store, async () => accepted);
    expect(store.rows.some(r => r.dedupe_key === 'order:late:confirmation')).toBe(false);
  });

  it('a stale in-flight claim from a crashed worker is swept to uncertain and reported, never resent', async () => {
    const store = memoryStore({ stale: 2 });
    expect(await run(store, async () => accepted)).toMatchObject({ swept: 2, considered: 0 });
  });
});

describe('D2: recovery uses the original event time and only the latest status', () => {
  const history = [
    event({ toStatus: 'confirmed', actorType: 'system', at: minutesAgo(300) }),
    event({ toStatus: 'processing', actorType: 'admin', at: minutesAgo(240) }),
    event({ toStatus: 'packed', actorType: 'admin', at: minutesAgo(180) }),
    event({ toStatus: 'shipped', actorType: 'admin', at: minutesAgo(120) }),
    event({ toStatus: 'delivered', actorType: 'admin', at: minutesAgo(60) }),
  ];

  it('recovers the confirmation and ONLY the latest status (never Processing / Packed / Shipped once Delivered)', async () => {
    const store = memoryStore({ events: history });
    await run(store, async () => accepted);
    expect(store.rows.map(r => r.dedupe_key).sort()).toEqual(['order:o1:confirmation', 'order:o1:delivered']);
  });

  it('stamps the recovered rows with the ORIGINAL event time, not the recovery time', async () => {
    const store = memoryStore({ events: history });
    await run(store, async () => accepted);
    expect(store.rows.find(r => r.dedupe_key === 'order:o1:confirmation')!.created_at).toBe(minutesAgo(300));
    expect(store.rows.find(r => r.dedupe_key === 'order:o1:delivered')!.created_at).toBe(minutesAgo(60));
  });

  it('the 24-hour retry window is measured from the event: a recovered row whose event is 23h59m old has almost no window left', async () => {
    const store = memoryStore({ events: [event({ at: minutesAgo(24 * 60 - 3) })] });
    const [row] = (await run(store, async () => accepted), store.rows);
    expect(Date.parse(row.created_at)).toBe(NOW.getTime() - (24 * 60 - 3) * 60_000);
    // an event that crosses the 24-hour mark between runs is never picked up afterwards
    const later = new Date(NOW.getTime() + 5 * 60_000);
    expect(isRetryEligible({ ...row, status: 'queued' }, later)).toBe(false);
  });

  it('when the latest status email already exists, an older missing one is NOT recovered', async () => {
    const store = memoryStore({ events: history, rows: [{ dedupe_key: 'order:o1:confirmation', status: 'accepted', next_attempt_at: null }, { dedupe_key: 'order:o1:delivered', status: 'accepted', next_attempt_at: null }] });
    const summary = await run(store, async () => accepted);
    expect(summary.reconciled).toBe(0);
    expect(store.rows).toHaveLength(2);
  });

  it('a cancellation by the customer or an admin is the latest status and is recovered alone; a system cancellation never is', async () => {
    const cancelled = memoryStore({ events: [event({ toStatus: 'processing', actorType: 'admin', at: minutesAgo(90) }), event({ toStatus: 'cancelled', actorType: 'customer', at: minutesAgo(30) })] });
    await run(cancelled, async () => accepted);
    expect(cancelled.rows.map(r => r.dedupe_key)).toEqual(['order:o1:cancelled']);
    const system = memoryStore({ events: [event({ toStatus: 'cancelled', actorType: 'system', at: minutesAgo(30) })] });
    await run(system, async () => accepted);
    expect(system.rows).toHaveLength(0);
  });

  it('each order is handled independently', () => {
    const picked = selectRecoveries([
      event({ orderId: 'a', toStatus: 'processing', actorType: 'admin', at: minutesAgo(50) }), event({ orderId: 'a', toStatus: 'packed', actorType: 'admin', at: minutesAgo(40) }),
      event({ orderId: 'b', toStatus: 'processing', actorType: 'admin', at: minutesAgo(30) }),
    ]);
    expect(picked.map(p => p.dedupeKey).sort()).toEqual(['order:a:packed', 'order:b:processing']);
  });

  it('events with identical timestamps resolve to the furthest status', () => {
    const same = minutesAgo(30);
    const picked = selectRecoveries([event({ toStatus: 'processing', actorType: 'admin', at: same }), event({ toStatus: 'packed', actorType: 'admin', at: same })]);
    expect(picked.map(p => p.dedupeKey)).toEqual(['order:o1:packed']);
  });

  it('a queued status email that is superseded by the time it is retried is dropped, not sent', async () => {
    const store = memoryStore({ rows: [{ dedupe_key: 'order:o1:processing', status: 'failed', next_attempt_at: minutesAgo(1) }] });
    const deliver = vi.fn(async (): Promise<DeliverResult> => ({ status: 'superseded' }));
    const summary = await run(store, deliver);
    expect(summary.gaveUp).toBe(1);
    expect(store.given[0]).toContain('superseded');
    expect(store.rows[0].next_attempt_at).toBeNull();
  });
});

describe('which rows get retried', () => {
  it('retries failed and skipped rows that are due; leaves everything else alone', async () => {
    const store = memoryStore({ rows: [
      { status: 'failed', next_attempt_at: minutesAgo(1) },                                  // due
      { status: 'failed', next_attempt_at: minutesAhead(10) },                               // not due
      { status: 'failed', next_attempt_at: null },                                            // permanent
      { status: 'skipped_unconfigured', next_attempt_at: minutesAgo(5) },                     // due
      { status: 'uncertain', next_attempt_at: null },
      { status: 'accepted', next_attempt_at: null },
      { status: 'failed', attempts: 6, next_attempt_at: minutesAgo(1) },                      // exhausted
      { status: 'failed', created_at: hoursAgo(26), next_attempt_at: minutesAgo(1) },         // outside the 24 h window
    ] });
    const deliver = vi.fn(async () => accepted);
    const summary = await run(store, deliver);
    expect(summary.considered).toBe(2);
    expect(deliver.mock.calls.map(c => (c as unknown as [LogRow])[0].id).sort()).toEqual(['r1', 'r4']);
  });

  it('PRODUCTION CASE: old rows recorded as skipped_unconfigured before this system existed are never replayed', async () => {
    // Rows written by the old code have no next_attempt_at (the column is new): they must not be treated as retryable.
    const old = Array.from({ length: 8 }, (_, i) => ({ status: 'skipped_unconfigured', next_attempt_at: null, attempts: 0, created_at: hoursAgo(2 + i), dedupe_key: `order:old${i}:confirmation`, kind: 'order_confirmation' }));
    const store = memoryStore({ rows: old, events: old.map((_, i) => event({ orderId: `old${i}`, at: hoursAgo(2 + i) })) });
    const deliver = vi.fn(async () => accepted);
    const summary = await run(store, deliver);
    expect(deliver).not.toHaveBeenCalled();
    expect(summary).toMatchObject({ reconciled: 0, considered: 0 });
    expect(store.rows).toHaveLength(8);
    expect(store.rows.every(r => r.status === 'skipped_unconfigured' && r.next_attempt_at === null)).toBe(true);
  });

  it('gives up on a row whose order no longer exists instead of retrying forever', async () => {
    const store = memoryStore({ rows: [{ status: 'failed' }] });
    const summary = await run(store, async () => null);
    expect(summary.gaveUp).toBe(1);
    expect(store.given[0]).toContain('r1');
  });
});

describe('D4: ineligible rows can never starve eligible ones', () => {
  const ineligible = (n: number): Partial<LogRow>[] => Array.from({ length: n }, (_, i) => ({
    status: 'failed', created_at: minutesAgo(1000 - i), dedupe_key: `order:bad${i}:shipped`,
    next_attempt_at: i % 3 === 0 ? null : minutesAhead(30 + i), // permanent, or scheduled for later
  }));

  it('more than 200 ineligible rows, with eligible notifications BEYOND that range, are all still delivered', async () => {
    const eligible: Partial<LogRow>[] = Array.from({ length: 5 }, (_, i) => ({ status: 'failed', created_at: minutesAgo(100 - i), dedupe_key: `order:good${i}:shipped`, next_attempt_at: minutesAgo(1) }));
    const store = memoryStore({ rows: [...ineligible(250), ...eligible] });
    expect(store.rows).toHaveLength(255);
    const delivered: string[] = [];
    const summary = await run(store, async row => { delivered.push(row.dedupe_key); return accepted; });
    expect(summary.considered).toBe(5);
    expect(delivered.sort()).toEqual(['order:good0:shipped', 'order:good1:shipped', 'order:good2:shipped', 'order:good3:shipped', 'order:good4:shipped']);
  });

  it('the oldest eligible rows go first, and the 25-row cap applies to eligible rows only', async () => {
    const eligible: Partial<LogRow>[] = Array.from({ length: 40 }, (_, i) => ({ status: 'failed', created_at: minutesAgo(600 - i), dedupe_key: `order:good${i}:shipped`, next_attempt_at: minutesAgo(1) }));
    const store = memoryStore({ rows: [...eligible, ...ineligible(300)] });
    const order: string[] = [];
    await run(store, async row => { order.push(row.dedupe_key); return accepted; });
    expect(order).toHaveLength(25);
    expect(order[0]).toBe('order:good0:shipped');
    expect(order[24]).toBe('order:good24:shipped');
  });

  it('the runner asks the store for eligibility-filtered rows (bounds are passed, nothing is pre-limited to 200)', async () => {
    const store = memoryStore();
    await run(store, async () => accepted);
    expect(store.queries[0]).toMatchObject({ limit: 25, maxAttempts: 6 });
    expect(store.queries[0].sinceIso).toBe(new Date(NOW.getTime() - 24 * 3_600_000).toISOString());
    expect(store.queries[0].graceIso).toBe(new Date(NOW.getTime() - 2 * 60_000).toISOString());
  });
});

describe('D3: worker execution budget', () => {
  const makeRows = (n: number) => Array.from({ length: n }, (_, i) => ({ status: 'failed', created_at: minutesAgo(500 - i), dedupe_key: `order:r${i}:shipped`, next_attempt_at: minutesAgo(1) }));

  it('stops claiming new notifications when the remaining budget cannot cover a worst-case send', async () => {
    let clock = NOW.getTime();
    const store = memoryStore({ rows: makeRows(20) });
    const deliver = vi.fn(async (): Promise<DeliverResult> => { clock += 6_000; return accepted; }); // every send takes 6 s
    const summary = await runEmailRetry({ store, now: () => new Date(clock), deliver });
    // 40 s budget - 18 s worst-case send = new sends may start until 22 s have elapsed: 0, 6, 12, 18 s → 4 sends (the 5th would start at 24 s)
    expect(deliver).toHaveBeenCalledTimes(4);
    expect(summary).toMatchObject({ considered: 4, accepted: 4, stoppedForBudget: true });
    expect(clock - NOW.getTime()).toBeLessThanOrEqual(WORKER_BUDGET_MS);
  });

  it('a send that has started is never interrupted: the run waits for it even if it overruns', async () => {
    let clock = NOW.getTime();
    const store = memoryStore({ rows: makeRows(3) });
    const finished: string[] = [];
    const deliver = vi.fn(async (row: LogRow): Promise<DeliverResult> => { clock += 30_000; finished.push(row.id); return accepted; }); // a very slow send
    const summary = await runEmailRetry({ store, now: () => new Date(clock), deliver });
    expect(finished).toEqual(['r1']);            // the in-flight send completed and was recorded
    expect(summary).toMatchObject({ accepted: 1, stoppedForBudget: true });
    expect(deliver).toHaveBeenCalledTimes(1);    // and nothing new was claimed afterwards
  });

  it('rows not started stay untouched (unclaimed) for the next run', async () => {
    let clock = NOW.getTime();
    const store = memoryStore({ rows: makeRows(10) });
    await runEmailRetry({ store, now: () => new Date(clock), deliver: async row => { clock += 10_000; row.status = 'accepted'; return accepted; } });
    const untouched = store.rows.filter(r => r.status === 'failed');
    expect(untouched.length).toBeGreaterThan(0);
    expect(untouched.every(r => r.attempts === 1 && r.next_attempt_at !== null)).toBe(true);
  });

  it('a fast run is not limited by the budget', async () => {
    const store = memoryStore({ rows: makeRows(10) });
    const summary = await run(store, async () => accepted);
    expect(summary).toMatchObject({ considered: 10, stoppedForBudget: false });
  });
});

describe('overlapping workers', () => {
  it('two cron runs at the same time send each notification once', async () => {
    const store = memoryStore({ rows: [{ status: 'failed' }, { status: 'failed' }, { status: 'queued', next_attempt_at: null, created_at: minutesAgo(10) }] });
    const claimed = new Set<string>();
    const sends: string[] = [];
    const deliver = async (row: LogRow): Promise<DeliverResult> => {
      if (claimed.has(row.id)) return { status: 'in_progress' }; // the atomic claim: only the first caller gets the row
      claimed.add(row.id);
      await Promise.resolve();
      sends.push(row.id);
      return accepted;
    };
    const [a, b] = await Promise.all([run(store, deliver), run(store, deliver)]);
    expect(sends.sort()).toEqual(['r1', 'r2', 'r3']);
    expect(a.accepted + b.accepted).toBe(3);
    expect(a.inProgress + b.inProgress).toBeGreaterThan(0);
  });
});

describe('stops when the provider itself is failing', () => {
  const many = () => memoryStore({ rows: Array.from({ length: 6 }, () => ({ status: 'failed' })) });

  it('revoked credentials: one attempt, then stop, and the administrator is told', async () => {
    const trip = vi.fn();
    const deliver = vi.fn(async (): Promise<DeliverResult> => ({ status: 'failed', failureKind: 'auth' }));
    const summary = await run(many(), deliver, trip);
    expect(deliver).toHaveBeenCalledTimes(1);
    expect(summary).toMatchObject({ tripped: 'auth', failed: 1 });
    expect(trip).toHaveBeenCalledWith('auth');
  });
  it('quota: stops immediately instead of burning the remaining allowance', async () => {
    const deliver = vi.fn(async (): Promise<DeliverResult> => ({ status: 'failed', failureKind: 'quota' }));
    expect(await run(many(), deliver)).toMatchObject({ tripped: 'quota' });
    expect(deliver).toHaveBeenCalledTimes(1);
  });
  it('three transient failures in a row: stop', async () => {
    const deliver = vi.fn(async (): Promise<DeliverResult> => ({ status: 'failed', failureKind: 'transient' }));
    expect(await run(many(), deliver)).toMatchObject({ tripped: 'transient' });
    expect(deliver).toHaveBeenCalledTimes(3);
  });
  it('a success resets the streak', async () => {
    const outcomes: DeliverResult[] = [{ status: 'failed', failureKind: 'transient' }, { status: 'failed', failureKind: 'transient' }, accepted, { status: 'failed', failureKind: 'transient' }, { status: 'failed', failureKind: 'transient' }, accepted];
    let i = 0;
    const summary = await run(many(), async () => outcomes[i++]);
    expect(summary.tripped).toBeNull();
    expect(summary.considered).toBe(6);
  });
  it('missing credentials: stops after the first skipped row (every row would be skipped too)', async () => {
    const deliver = vi.fn(async (): Promise<DeliverResult> => ({ status: 'skipped_unconfigured', failureKind: 'unconfigured' }));
    const summary = await run(many(), deliver);
    expect(deliver).toHaveBeenCalledTimes(1);
    expect(summary.skipped).toBe(1);
  });
  it('an uncertain outcome is counted but never retried by this run', async () => {
    const store = memoryStore({ rows: [{ status: 'failed' }] });
    const summary = await run(store, async () => ({ status: 'uncertain', failureKind: 'uncertain' }));
    expect(summary.uncertain).toBe(1);
  });
});
