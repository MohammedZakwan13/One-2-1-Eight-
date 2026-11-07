-- 0009_email_log_attempts.sql
-- Local draft. NOT applied to production by the assistant. Review and run it yourself in the Supabase SQL Editor.
--
-- Makes public.email_log a safe retry queue (no new table, no stored email bodies: content is regenerated from the order / return / lead):
--   attempts         how many send attempts were made (definitive provider failures only; auth / quota outages do not count)
--   last_attempt_at  when the latest attempt was claimed (doubles as the claim lease)
--   next_attempt_at  when a failed / unconfigured notification may be retried; NULL = never retry (permanent, exhausted or window over)
--   provider         'gmail' | 'resend' | 'mailpit' that handled the latest attempt
--   status           two new values:
--                      'sending'   claimed by exactly one worker (claim_email_log)
--                      'uncertain' the provider may have accepted the message but the answer was lost. NEVER retried automatically,
--                                  so a customer cannot receive a duplicate.
--   claim_email_log(id)        atomic claim: only one concurrent caller gets the row; 'queued' rows, and 'failed' / 'skipped_unconfigured'
--                              rows whose next_attempt_at is due, are claimable. 'uncertain', 'accepted' and permanent rows never are.
--   sweep_stale_email_sending  a claim that never finished (application crash mid-send) becomes 'uncertain', not 'queued': we cannot know
--                              whether the provider already sent it, and a duplicate customer email is worse than a missed one.
--
-- Purely additive and idempotent: nothing existing is dropped (the old status CHECK is replaced by a superset), no data is rewritten,
-- and every existing function (place_order, transition_order, settle_payment, save_product, ...) is untouched.
-- Safe to leave in place if you roll the application back: the previous code only ever writes the old status values.

begin;
set local lock_timeout = '5s';
set local statement_timeout = '60s';

alter table public.email_log add column if not exists attempts        integer not null default 0;
alter table public.email_log add column if not exists last_attempt_at timestamptz;
alter table public.email_log add column if not exists next_attempt_at timestamptz;
alter table public.email_log add column if not exists provider        text;

-- Replace the status CHECK (whatever its generated name) with a superset that adds 'sending' and 'uncertain'.
do $$
declare c record;
begin
  for c in
    select conname from pg_constraint
    where conrelid = 'public.email_log'::regclass and contype = 'c'
      and pg_get_constraintdef(oid) ilike '%status%' and conname <> 'email_log_status_chk'
  loop
    execute format('alter table public.email_log drop constraint %I', c.conname);
  end loop;
  if not exists (select 1 from pg_constraint where conrelid = 'public.email_log'::regclass and conname = 'email_log_status_chk') then
    alter table public.email_log add constraint email_log_status_chk check (status in
      ('queued', 'sending', 'accepted', 'delivered', 'bounced', 'complained', 'failed', 'skipped_unconfigured', 'uncertain'));
  end if;
  if not exists (select 1 from pg_constraint where conrelid = 'public.email_log'::regclass and conname = 'email_log_attempts_chk') then
    alter table public.email_log add constraint email_log_attempts_chk check (attempts >= 0);
  end if;
end $$;

create index if not exists email_log_retry_idx on public.email_log (status, next_attempt_at, created_at)
  where status in ('queued', 'failed', 'skipped_unconfigured', 'sending');

-- Atomic claim. Returns the claimed row as jsonb, or NULL when another worker holds it or it is not claimable.
create or replace function public.claim_email_log(p_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare r public.email_log%rowtype;
begin
  update public.email_log
     set status = 'sending', attempts = attempts + 1, last_attempt_at = now(), next_attempt_at = null, updated_at = now()
   where id = p_id
     and (status = 'queued'
          or (status in ('failed', 'skipped_unconfigured') and next_attempt_at is not null and next_attempt_at <= now()))
  returning * into r;
  if not found then return null; end if;
  return to_jsonb(r);
end $$;

-- A claim older than the lease whose worker never reported back: outcome unknown, so do not resend.
create or replace function public.sweep_stale_email_sending(p_stale_seconds integer default 600)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare n integer;
begin
  update public.email_log
     set status = 'uncertain', error = coalesce(error, 'worker stopped mid-send; outcome unknown'), next_attempt_at = null, updated_at = now()
   where status = 'sending' and last_attempt_at < now() - make_interval(secs => greatest(p_stale_seconds, 60));
  get diagnostics n = row_count;
  return n;
end $$;

revoke all on function public.claim_email_log(uuid) from public, anon, authenticated;
revoke all on function public.sweep_stale_email_sending(integer) from public, anon, authenticated;
grant execute on function public.claim_email_log(uuid) to service_role;
grant execute on function public.sweep_stale_email_sending(integer) to service_role;

commit;
