-- 0014_product_size_guides.sql
-- Product-specific size guides (customer-facing garment measurements).
--
-- ADDITIVE ONLY. Nothing existing is altered: products, product_variants, inventory_movements and public.save_product are untouched.
-- A guide is informational: its row "size" labels are plain text with NO relation to product_variants, SKUs or stock.
-- Products without a row (or with enabled = false) keep showing the storefront's generic size guide.
--
-- Rollback:  drop function if exists public.save_product_with_size_guide(jsonb, uuid, jsonb, boolean);
--            drop table if exists public.product_size_guides;

create table if not exists public.product_size_guides (
  product_id uuid primary key references public.products(id) on delete cascade,
  enabled    boolean not null default true,
  unit       text    not null check (unit in ('in', 'cm')),
  columns    jsonb   not null check (jsonb_typeof(columns) = 'array' and jsonb_array_length(columns) between 1 and 8),
  rows       jsonb   not null check (jsonb_typeof(rows) = 'array' and jsonb_array_length(rows) between 1 and 12),
  updated_at timestamptz not null default now()
);

-- Same convention as every other table: RLS on, no direct access for the public API roles. Only the trusted server (service role) reads and writes it.
alter table public.product_size_guides enable row level security;
revoke all on public.product_size_guides from anon, authenticated;

-- Saves a product AND its size guide in ONE transaction by calling the unchanged public.save_product, so a guide error rolls the product save back too.
--   p_guide  : the guide (jsonb object) to create/replace, or null to leave any existing guide untouched.
--   p_remove : true deletes the guide. Deletion is explicit: a null p_guide with p_remove = false never deletes anything.
create or replace function public.save_product_with_size_guide(p jsonb, p_actor uuid, p_guide jsonb, p_remove boolean default false)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid;
  c jsonb;
  r jsonb;
  v_keys text[] := array[]::text[];
begin
  if p_guide is not null and jsonb_typeof(p_guide) = 'object' and not coalesce(p_remove, false) then
    if p_guide->>'unit' not in ('in', 'cm') or jsonb_typeof(p_guide->'enabled') <> 'boolean'
       or jsonb_typeof(p_guide->'columns') <> 'array' or jsonb_typeof(p_guide->'rows') <> 'array'
       or jsonb_array_length(p_guide->'columns') not between 1 and 8 or jsonb_array_length(p_guide->'rows') not between 1 and 12 then
      raise exception 'invalid_size_guide';
    end if;
    for c in select * from jsonb_array_elements(p_guide->'columns') loop
      if jsonb_typeof(c->'key') <> 'string' or jsonb_typeof(c->'label') <> 'string'
         or length(btrim(c->>'label')) not between 1 and 24 or (c->>'key') !~ '^[a-z0-9_]{1,12}$' or (c->>'key') = any (v_keys) then
        raise exception 'invalid_size_guide';
      end if;
      v_keys := v_keys || (c->>'key');
    end loop;
    for r in select * from jsonb_array_elements(p_guide->'rows') loop
      if jsonb_typeof(r->'size') <> 'string' or length(btrim(r->>'size')) not between 1 and 16 or jsonb_typeof(r->'values') <> 'object' then
        raise exception 'invalid_size_guide';
      end if;
    end loop;
  end if;

  v_id := public.save_product(p, p_actor);

  if coalesce(p_remove, false) then
    delete from public.product_size_guides where product_id = v_id;
  elsif p_guide is not null and jsonb_typeof(p_guide) = 'object' then
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
