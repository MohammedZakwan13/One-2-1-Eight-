-- 0008_stock_message_modes.sql
-- Local draft. NOT applied to production by the assistant. Review and run it yourself in the Supabase SQL Editor.
--
-- 1. Stock message modes (display text only; nothing here reads or writes product_variants.stock):
--      stock_message_mode   'none' (default) | 'real' (show real per-size stock + message) | 'custom' (admin display number + message)
--      stock_message_number optional integer, ONLY allowed in 'custom' mode (CHECK + enforced by save_product): a display/promotional
--                           value, NEVER inventory (never read by stock, availability, checkout, inventory_movements or Low Stock)
--      stock_message_review true while a pre-existing message has not been reviewed by an admin
--    Existing products that already have a stock_message keep it unchanged: they become mode 'custom' (number empty) and are flagged
--    for review. Old manually entered numbers are NOT treated as inventory. The backfill runs only in the run that creates the mode
--    column, so re-running this file never overwrites later admin choices.
-- 2. save_product (replaces 0007's definition; same signature, security settings and grants), STRICT about inventory:
--    a. Inventory is written ONLY on explicit intent. A payload without "variants" never touches product_variants (no stock write, no
--       size removal).
--    b. An UPDATE that contains "variants" MUST also contain "expected_stock" (the stock the admin saw). Otherwise it is rejected with
--       'stock_snapshot_required' BEFORE anything is written: no metadata, no stock, no movement. There is deliberately NO legacy path:
--       the pre-0008 admin application (which sends variants without a snapshot) can no longer save existing products, so it cannot
--       overwrite stock that an order changed. Creating a product still accepts variants without a snapshot (nothing to overwrite).
--    c. With a snapshot, each existing size is locked and compared:
--         - size unchanged by the admin  -> stock is NOT written (a concurrent order's change is kept)
--         - size changed by the admin    -> allowed only if live stock still equals expected_stock, else raises 'stock_conflict'
--         - size removed by the admin    -> allowed only if live stock still equals expected_stock, else 'stock_conflict'
--         - size the admin never saw     -> left alone (or 'stock_conflict' if the admin tries to add it while it is active)
--       A conflict aborts the whole save (nothing is written). Genuine adjustments still log inventory_movements as before.
--    d. Creating a product requires "variants" (raises 'variants_required').
--    e. stock_message_number is stored only when the effective mode is 'custom'; it is cleared (null) for 'real' and 'none'.
--    f. stock_message_review is cleared only when a mode is submitted AND the mode or the message text actually changed.
--    Order processing (place order, settle payment, cancel/restock) is NOT touched by this migration.
-- Low Stock KPI is NOT part of this migration: the admin dashboard route computes it server-side from product_variants
-- (distinct ACTIVE products with an ACTIVE size where 0 < stock <= low_stock_threshold); dashboard_stats is left untouched.
--
-- Execution: the whole file is ONE transaction (all-or-nothing) with short lock/statement timeouts so it can never stall the storefront
-- waiting for a lock: if it fails or times out, nothing is applied and it can simply be re-run. Every step is independently
-- idempotent (add column if not exists, constraints guarded by pg_constraint), so re-running after any outcome is safe.
--
-- Order of use: apply this BEFORE deploying the matching code. The new code refuses metadata-only saves ("migration required") if this
-- has not been applied, because the previous function would deactivate every size when "variants" is absent.
-- ROLLBACK / SAFETY: do NOT re-apply the 0007 save_product after this migration: it overwrites stock with whatever the admin form
-- loaded. If the new application must be rolled back, leave this migration in place: the previous application can still read and sell
-- everything; it just cannot save existing products (create still works) until the new code is redeployed. Fix forward with a new
-- numbered migration. The three added columns are harmless and can stay.

begin;
set local lock_timeout = '5s';
set local statement_timeout = '60s';

do $$
declare
  v_first_run boolean := not exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'products' and column_name = 'stock_message_mode');
begin
  alter table public.products add column if not exists stock_message_mode text not null default 'none';
  alter table public.products add column if not exists stock_message_number integer;
  alter table public.products add column if not exists stock_message_review boolean not null default false;

  if not exists (select 1 from pg_constraint where conrelid = 'public.products'::regclass and conname = 'products_stock_message_mode_chk') then
    alter table public.products add constraint products_stock_message_mode_chk check (stock_message_mode in ('none', 'real', 'custom'));
  end if;
  if not exists (select 1 from pg_constraint where conrelid = 'public.products'::regclass and conname = 'products_stock_message_number_chk') then
    alter table public.products add constraint products_stock_message_number_chk check (stock_message_number is null or stock_message_number between 0 and 100000);
  end if;
  if not exists (select 1 from pg_constraint where conrelid = 'public.products'::regclass and conname = 'products_stock_message_number_mode_chk') then
    alter table public.products add constraint products_stock_message_number_mode_chk check (stock_message_number is null or stock_message_mode = 'custom');
  end if;

  -- One-time backfill: only in the run that created the mode column.
  if v_first_run then
    update public.products
       set stock_message_mode = 'custom', stock_message_review = true
     where stock_message is not null and btrim(stock_message) <> '';
  end if;
end $$;

create or replace function public.save_product(p jsonb, p_actor uuid)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid := nullif(p->>'id', '')::uuid;
  v_is_create boolean := (nullif(p->>'id', '') is null);
  v_slug text := p->>'slug';
  v   jsonb;
  ex  product_variants%rowtype;
  v_idx integer := 0;
  v_sizes text[] := array[]::text[];
  v_stock integer;
  v_has_variants boolean := (p ? 'variants' and jsonb_typeof(p->'variants') = 'array');
  v_has_expected boolean := (p ? 'expected_stock' and jsonb_typeof(p->'expected_stock') = 'object');
  v_exp integer;
begin
  -- Guards first: nothing has been written yet.
  if v_is_create and not v_has_variants then
    raise exception 'variants_required';
  end if;
  if not v_is_create and v_has_variants and not v_has_expected then
    raise exception 'stock_snapshot_required';
  end if;

  if v_is_create then
    insert into products (slug, name, category_id, price, compare_at, color, color_hex, badge, images, fit, material, description,
                          best_seller, new_arrival, luxe, status, stock_display, stock_message,
                          returnable, exchangeable, cod_enabled, online_payment_enabled, stock_message_mode, stock_message_number)
    values (v_slug, p->>'name', (p->>'category_id')::uuid, (p->>'price')::numeric, (p->>'compare_at')::numeric, p->>'color', p->>'color_hex',
            nullif(p->>'badge', ''), array(select jsonb_array_elements_text(p->'images')), p->>'fit', p->>'material', p->>'description',
            (p->>'best_seller')::boolean, (p->>'new_arrival')::boolean, (p->>'luxe')::boolean, p->>'status', coalesce(p->>'stock_display', 'status'), nullif(btrim(coalesce(p->>'stock_message', '')), ''),
            coalesce((p->>'returnable')::boolean, true),
            coalesce((p->>'exchangeable')::boolean, (p->>'returnable')::boolean, true),
            coalesce((p->>'cod_enabled')::boolean, true),
            coalesce((p->>'online_payment_enabled')::boolean, true),
            coalesce(nullif(p->>'stock_message_mode', ''), 'none'),
            case when coalesce(nullif(p->>'stock_message_mode', ''), 'none') = 'custom' then nullif(p->>'stock_message_number', '')::integer else null end)
    returning id into v_id;
  else
    update products set slug = v_slug, name = p->>'name', category_id = (p->>'category_id')::uuid, price = (p->>'price')::numeric,
      compare_at = (p->>'compare_at')::numeric, color = p->>'color', color_hex = p->>'color_hex', badge = nullif(p->>'badge', ''),
      images = array(select jsonb_array_elements_text(p->'images')), fit = p->>'fit', material = p->>'material', description = p->>'description',
      best_seller = (p->>'best_seller')::boolean, new_arrival = (p->>'new_arrival')::boolean, luxe = (p->>'luxe')::boolean,
      status = p->>'status', stock_display = coalesce(p->>'stock_display', stock_display),
      stock_message = case when p ? 'stock_message' then nullif(btrim(coalesce(p->>'stock_message', '')), '') else stock_message end,
      returnable = case when p ? 'returnable' then coalesce((p->>'returnable')::boolean, true) else returnable end,
      exchangeable = case when p ? 'exchangeable' then coalesce((p->>'exchangeable')::boolean, true) else exchangeable end,
      cod_enabled = case when p ? 'cod_enabled' then coalesce((p->>'cod_enabled')::boolean, true) else cod_enabled end,
      online_payment_enabled = case when p ? 'online_payment_enabled' then coalesce((p->>'online_payment_enabled')::boolean, true) else online_payment_enabled end,
      -- (every right-hand side below reads the OLD row values)
      stock_message_mode = case when p ? 'stock_message_mode' then coalesce(nullif(p->>'stock_message_mode', ''), 'none') else stock_message_mode end,
      stock_message_number = case
        when (case when p ? 'stock_message_mode' then coalesce(nullif(p->>'stock_message_mode', ''), 'none') else stock_message_mode end) = 'custom'
          then (case when p ? 'stock_message_number' then nullif(p->>'stock_message_number', '')::integer else stock_message_number end)
        else null end,
      stock_message_review = case
        when p ? 'stock_message_mode'
         and (coalesce(nullif(p->>'stock_message_mode', ''), 'none') is distinct from stock_message_mode
              or nullif(btrim(coalesce(p->>'stock_message', '')), '') is distinct from stock_message)
          then false
        else stock_message_review end,
      updated_at = now()
    where id = v_id;
    if not found then raise exception 'not_found'; end if;
  end if;

  -- Inventory: only when the caller explicitly sent variants (and, for updates, the snapshot: guaranteed by the guard above).
  if v_has_variants then
    for v in select * from jsonb_array_elements(p->'variants') loop
      v_idx := v_idx + 1;
      v_stock := (v->>'stock')::integer;
      v_sizes := v_sizes || (v->>'size');
      select * into ex from product_variants where product_id = v_id and size = v->>'size' for update;
      if found then
        if v_is_create then
          -- The same size listed twice inside a brand-new product's payload: nothing existed before, so nothing can be overwritten.
          update product_variants set stock = v_stock, sort_order = v_idx, sku = coalesce(nullif(v->>'sku', ''), sku) where id = ex.id;
        else
          v_exp := nullif(p->'expected_stock'->>(v->>'size'), '')::integer;
          if v_exp is null then
            -- A size the admin did not have loaded: only a previously removed (inactive) size may be brought back.
            if ex.active then raise exception 'stock_conflict' using detail = v->>'size'; end if;
            update product_variants set stock = v_stock, active = true, sort_order = v_idx,
              sku = coalesce(nullif(v->>'sku', ''), sku) where id = ex.id;
            if ex.stock <> v_stock then
              insert into inventory_movements (variant_id, delta, stock_after, reason, actor_id) values (ex.id, v_stock - ex.stock, v_stock, 'admin_adjustment', p_actor);
            end if;
          elsif v_stock = v_exp then
            -- Unchanged by the admin: never write stock (keeps any concurrent order's change).
            if not ex.active then raise exception 'stock_conflict' using detail = v->>'size'; end if;
            update product_variants set sort_order = v_idx, sku = coalesce(nullif(v->>'sku', ''), sku) where id = ex.id;
          else
            -- Changed by the admin: only if live stock is still what the admin saw.
            if not ex.active or ex.stock <> v_exp then raise exception 'stock_conflict' using detail = v->>'size'; end if;
            update product_variants set stock = v_stock, sort_order = v_idx,
              sku = coalesce(nullif(v->>'sku', ''), sku) where id = ex.id;
            insert into inventory_movements (variant_id, delta, stock_after, reason, actor_id) values (ex.id, v_stock - ex.stock, v_stock, 'admin_adjustment', p_actor);
          end if;
        end if;
      else
        insert into product_variants (product_id, sku, size, stock, sort_order)
        values (v_id, coalesce(nullif(v->>'sku', ''), upper(left(v_slug, 18)) || '-' || (v->>'size')), v->>'size', v_stock, v_idx)
        returning id into ex.id;
        insert into inventory_movements (variant_id, delta, stock_after, reason, actor_id) values (ex.id, v_stock, v_stock, 'initial', p_actor);
      end if;
    end loop;

    for ex in select * from product_variants where product_id = v_id and active and not (size = any(v_sizes)) for update loop
      if not v_is_create then
        -- Only sizes the admin actually saw can be removed, and only if their stock is unchanged.
        if not ((p->'expected_stock') ? ex.size) then continue; end if;
        if ex.stock <> (p->'expected_stock'->>ex.size)::integer then raise exception 'stock_conflict' using detail = ex.size; end if;
      end if;
      update product_variants set active = false, stock = 0 where id = ex.id;
      if ex.stock <> 0 then
        insert into inventory_movements (variant_id, delta, stock_after, reason, actor_id) values (ex.id, -ex.stock, 0, 'size_removed', p_actor);
      end if;
    end loop;
  end if;

  return v_id;
end $$;

revoke all on function public.save_product(jsonb, uuid) from public, anon, authenticated;
grant execute on function public.save_product(jsonb, uuid) to service_role;

commit;
