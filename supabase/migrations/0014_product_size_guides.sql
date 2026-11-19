-- 0014_product_size_guides.sql
-- Product-specific size guides (customer-facing garment measurements).
--
-- ADDITIVE ONLY. Nothing existing is altered: products, product_variants, inventory_movements and public.save_product are untouched.
-- A guide is informational: its row "size" labels are plain text with NO relation to product_variants, SKUs or stock.
-- Products without a row (or with enabled = false) keep showing the storefront's generic size guide.
--
-- Run it as one transaction (wrap in begin; ... commit; in the SQL editor). It is safe to re-run.
-- Rollback:  drop function if exists public.save_product_with_size_guide(jsonb, uuid, jsonb, boolean);
--            drop table if exists public.product_size_guides;
--            drop function if exists public.size_guide_complete(jsonb, jsonb);
--            drop function if exists public.size_guide_valid(jsonb, jsonb);

-- The ONE definition of "a well-formed guide body", used both by the table's CHECK constraint and by the save function below.
-- columns: 1-8 objects, each { key: string matching ^[a-z0-9_]{1,12}$ and unique, label: string of 1-24 characters after trimming }
-- rows   : 1-12 objects, each { size: string of 1-16 characters after trimming, values: object }, where every value is a string of at most 20
--          characters and every value key is one of the declared column keys.
-- Anything missing, null, mistyped or malformed returns false (never null), so a CHECK can never pass by accident.
create or replace function public.size_guide_valid(p_columns jsonb, p_rows jsonb)
returns boolean
language plpgsql
immutable
set search_path = public, pg_temp
as $$
declare
  c jsonb;
  r jsonb;
  k text;
  val jsonb;
  v_keys text[] := array[]::text[];
begin
  if p_columns is null or p_rows is null then return false; end if;
  if jsonb_typeof(p_columns) is distinct from 'array' or jsonb_typeof(p_rows) is distinct from 'array' then return false; end if;
  if jsonb_array_length(p_columns) not between 1 and 8 or jsonb_array_length(p_rows) not between 1 and 12 then return false; end if;

  for c in select e.value from jsonb_array_elements(p_columns) as e loop
    if jsonb_typeof(c) is distinct from 'object' then return false; end if;
    if jsonb_typeof(c->'key') is distinct from 'string' or jsonb_typeof(c->'label') is distinct from 'string' then return false; end if;
    if (c->>'key') !~ '^[a-z0-9_]{1,12}$' then return false; end if;
    if char_length(btrim(c->>'label')) not between 1 and 24 then return false; end if;
    if (c->>'key') = any (v_keys) then return false; end if;
    v_keys := v_keys || (c->>'key');
  end loop;

  for r in select e.value from jsonb_array_elements(p_rows) as e loop
    if jsonb_typeof(r) is distinct from 'object' then return false; end if;
    if jsonb_typeof(r->'size') is distinct from 'string' or char_length(btrim(r->>'size')) not between 1 and 16 then return false; end if;
    if jsonb_typeof(r->'values') is distinct from 'object' then return false; end if;
    for k, val in select e.key, e.value from jsonb_each(r->'values') as e loop
      if not (k = any (v_keys)) then return false; end if;
      if jsonb_typeof(val) is distinct from 'string' or char_length(val #>> '{}') > 20 then return false; end if;
    end loop;
  end loop;
  return true;
end;
$$;

revoke all on function public.size_guide_valid(jsonb, jsonb) from public, anon, authenticated;
grant execute on function public.size_guide_valid(jsonb, jsonb) to service_role;

-- "A complete table": the body is well-formed AND every row has a non-blank measurement for every declared column.
-- Required only while a guide is ENABLED (customers can see it); a disabled guide may keep blank or missing cells.
create or replace function public.size_guide_complete(p_columns jsonb, p_rows jsonb)
returns boolean
language plpgsql
immutable
set search_path = public, pg_temp
as $$
declare
  c jsonb;
  r jsonb;
begin
  if not public.size_guide_valid(p_columns, p_rows) then return false; end if;
  for r in select e.value from jsonb_array_elements(p_rows) as e loop
    for c in select e.value from jsonb_array_elements(p_columns) as e loop
      if jsonb_typeof(r->'values'->(c->>'key')) is distinct from 'string' or char_length(btrim(r->'values'->>(c->>'key'))) < 1 then return false; end if;
    end loop;
  end loop;
  return true;
end;
$$;

revoke all on function public.size_guide_complete(jsonb, jsonb) from public, anon, authenticated;
grant execute on function public.size_guide_complete(jsonb, jsonb) to service_role;

create table if not exists public.product_size_guides (
  product_id uuid primary key references public.products(id) on delete cascade,
  enabled    boolean not null default true,
  unit       text    not null check (unit in ('in', 'cm')),
  columns    jsonb   not null check (jsonb_typeof(columns) = 'array' and jsonb_array_length(columns) between 1 and 8),
  rows       jsonb   not null check (jsonb_typeof(rows) = 'array' and jsonb_array_length(rows) between 1 and 12),
  updated_at timestamptz not null default now(),
  constraint product_size_guides_body_valid check (public.size_guide_valid(columns, rows)),
  constraint product_size_guides_complete_when_enabled check (not enabled or public.size_guide_complete(columns, rows))
);

-- Same convention as every other table: RLS on, no direct access for the public API roles. Only the trusted server (service role) reads and writes it.
alter table public.product_size_guides enable row level security;
revoke all on public.product_size_guides from anon, authenticated;

-- Saves a product AND its size guide in ONE transaction by calling the unchanged public.save_product, so a guide error rolls the product save back too.
--   p        : the product payload, passed through to save_product unchanged.
--   p_actor  : the admin's id, passed through to save_product unchanged.
--   p_guide  : the guide (jsonb object) to create/replace. SQL NULL or JSON null means "no guide instruction": any existing guide is left untouched.
--   p_remove : true deletes the guide. Deletion is explicit: a null p_guide with p_remove = false never deletes anything.
-- A p_guide that is not an object (an array, string, number, ...) is rejected rather than silently ignored.
create or replace function public.save_product_with_size_guide(p jsonb, p_actor uuid, p_guide jsonb, p_remove boolean default false)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_id uuid;
begin
  if p_guide is not null and jsonb_typeof(p_guide) not in ('object', 'null') then
    raise exception 'invalid_size_guide';
  end if;

  if jsonb_typeof(p_guide) = 'object' and not coalesce(p_remove, false) then
    if jsonb_typeof(p_guide->'enabled') is distinct from 'boolean'
       or jsonb_typeof(p_guide->'unit') is distinct from 'string' or (p_guide->>'unit') not in ('in', 'cm')
       or not public.size_guide_valid(p_guide->'columns', p_guide->'rows')
       or ((p_guide->>'enabled')::boolean and not public.size_guide_complete(p_guide->'columns', p_guide->'rows')) then
      raise exception 'invalid_size_guide';
    end if;
  end if;

  v_id := public.save_product(p, p_actor);

  if coalesce(p_remove, false) then
    delete from public.product_size_guides where product_id = v_id;
  elsif jsonb_typeof(p_guide) = 'object' then
    insert into public.product_size_guides (product_id, enabled, unit, columns, rows)
    values (v_id, (p_guide->>'enabled')::boolean, p_guide->>'unit', p_guide->'columns', p_guide->'rows')
    on conflict (product_id) do update
      set enabled = excluded.enabled, unit = excluded.unit, columns = excluded.columns, rows = excluded.rows, updated_at = now();
  end if;
  return v_id;
end;
$$;

revoke all on function public.save_product_with_size_guide(jsonb, uuid, jsonb, boolean) from public, anon, authenticated;
grant execute on function public.save_product_with_size_guide(jsonb, uuid, jsonb, boolean) to service_role;
