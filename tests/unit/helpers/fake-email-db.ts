/**
 * In-memory stand-in for the slice of Supabase the email code uses (table `email_log` + the two 0009 functions).
 * The claim / sweep semantics deliberately mirror supabase/migrations/0009_email_log_attempts.sql, and the real SQL is
 * exercised separately by supabase/tests/db-email-retry.sh against a throwaway Postgres.
 */
export type FakeRow = Record<string, unknown> & { id: string; status: string; attempts: number; dedupe_key?: string | null };

export function createFakeEmailDb(clock: { now: () => number }, options: { migrated?: boolean } = {}) {
  const migrated = options.migrated ?? true;
  const rows: FakeRow[] = [];
  let seq = 0;
  const iso = (ms: number) => new Date(ms).toISOString();

  const api = {
    rows,
    from(table: string) {
      if (table !== 'email_log') throw new Error(`unexpected table ${table}`);
      return {
        insert(row: Record<string, unknown>) {
          const duplicate = row.dedupe_key ? rows.find(r => r.dedupe_key === row.dedupe_key) : undefined;
          let result: { data: { id: string } | null; error: { code: string; message: string } | null };
          if (duplicate) result = { data: null, error: { code: '23505', message: 'duplicate key' } };
          else {
            const created: FakeRow = { id: `log-${++seq}`, status: 'queued', attempts: 0, created_at: iso(clock.now()), last_attempt_at: null, next_attempt_at: null, provider: null, error: null, provider_message_id: null, ...row } as FakeRow;
            rows.push(created);
            result = { data: { id: created.id }, error: null };
          }
          return Object.assign(Promise.resolve(result), { select: () => ({ single: async () => result }) });
        },
        select() {
          return {
            eq(column: string, value: unknown) {
              const found = rows.filter(r => r[column] === value);
              return { single: async () => ({ data: found[0] ?? null, error: null }), maybeSingle: async () => ({ data: found[0] ?? null, error: null }) };
            },
          };
        },
        update(patch: Record<string, unknown>) {
          const filters: [string, unknown][] = [];
          const query = {
            eq(column: string, value: unknown) { filters.push([column, value]); return query; },
            then(resolve: (value: { error: null }) => unknown, reject: (reason: unknown) => unknown) {
              for (const row of rows.filter(r => filters.every(([c, v]) => r[c] === v))) Object.assign(row, patch);
              return Promise.resolve({ error: null }).then(resolve, reject);
            },
          };
          return query;
        },
      };
    },
    async rpc(name: string, args: Record<string, unknown>) {
      if (!migrated) return { data: null, error: { message: 'function public.claim_email_log(uuid) does not exist', code: '42883' } };
      const now = clock.now();
      if (name === 'claim_email_log') {
        const row = rows.find(r => r.id === args.p_id);
        const next = row?.next_attempt_at ? Date.parse(String(row.next_attempt_at)) : null;
        const claimable = row && (row.status === 'queued' || ((row.status === 'failed' || row.status === 'skipped_unconfigured') && next !== null && next <= now));
        if (!row || !claimable) return { data: null, error: null };
        Object.assign(row, { status: 'sending', attempts: row.attempts + 1, last_attempt_at: iso(now), next_attempt_at: null });
        return { data: { ...row }, error: null };
      }
      if (name === 'sweep_stale_email_sending') {
        const staleMs = Math.max(Number(args.p_stale_seconds ?? 600), 60) * 1000;
        let n = 0;
        for (const row of rows) {
          if (row.status === 'sending' && row.last_attempt_at && Date.parse(String(row.last_attempt_at)) < now - staleMs) { Object.assign(row, { status: 'uncertain', next_attempt_at: null }); n += 1; }
        }
        return { data: n, error: null };
      }
      throw new Error(`unexpected rpc ${name}`);
    },
  };
  return api;
}
