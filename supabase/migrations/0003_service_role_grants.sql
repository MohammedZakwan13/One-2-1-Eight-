-- 0003: give the server's service_role access to the app's tables, and lock every public API role out.
--
-- Why: Supabase no longer auto-grants new tables to API roles, so after 0001/0002 the service-role key got
-- "permission denied for table ...". The Next.js server is the ONLY database client (service role); the browser never
-- talks to Postgres. anon / authenticated / PUBLIC therefore get nothing in `public` (RLS stays on, with no policies).
--
-- Idempotent: safe to re-run. It touches privileges only (no data, no tables, no 0001/0002 objects are altered).

-- 1. service_role: schema, tables, sequences, functions (app functions only, never extension-owned ones)
grant usage on schema public to service_role;
grant all on all tables in schema public to service_role;
grant all on all sequences in schema public to service_role;

do $$
declare f record;
begin
  for f in
    select p.oid::regprocedure as signature
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.prokind = 'f'
      and not exists (select 1 from pg_depend d where d.objid = p.oid and d.deptype = 'e')
  loop
    execute format('revoke all on function %s from public, anon, authenticated', f.signature);
    execute format('grant execute on function %s to service_role', f.signature);
  end loop;
end $$;

-- 2. anon / authenticated / PUBLIC: nothing in public (explicit, so an earlier default grant cannot linger)
revoke all on all tables in schema public from public, anon, authenticated;
revoke all on all sequences in schema public from public, anon, authenticated;

-- 3. Future objects created by this role in `public`: service_role only
alter default privileges in schema public grant all on tables to service_role;
alter default privileges in schema public grant all on sequences to service_role;
alter default privileges in schema public grant execute on functions to service_role;
alter default privileges in schema public revoke all on tables from public, anon, authenticated;
alter default privileges in schema public revoke all on sequences from public, anon, authenticated;
alter default privileges in schema public revoke execute on functions from public, anon, authenticated;

-- RLS stays enabled on every table (set in 0001/0002). The schema USAGE grant to anon/authenticated is left as Supabase
-- configured it: without table/function privileges it exposes nothing.
