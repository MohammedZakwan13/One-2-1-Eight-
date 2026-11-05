-- 0007_save_product_policies.sql
-- Migration-history correction (documentation only). NOT a functional change.
--
-- Production's public.save_product(jsonb, uuid) already contains the four product policy fields
-- (returnable, exchangeable, cod_enabled, online_payment_enabled). It was verified read-only against
-- production on 2026-11-05 and is identical to the definition below:
--   * SECURITY DEFINER, search_path = public, language plpgsql, returns uuid
--   * EXECUTE granted to postgres and service_role only; no anon / authenticated / PUBLIC grants
--
-- This file records that definition so the migration history rebuilds the same function.
-- Applying it to production is a no-op (create or replace with an identical body; same revoke/grant).
-- Depends on 0004 (stock_message), 0005 (returnable) and 0006 (exchangeable, cod_enabled, online_payment_enabled).
-- Rollback: re-apply the save_product definition from 0004_stock_message.sql (the policy fields would again be
-- written only by the application's follow-up update).

create or replace function public.save_product(p jsonb, p_actor uuid)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid := nullif(p->>'id', '')::uuid;
  v_slug text := p->>'slug';
  v   jsonb;
  ex  product_variants%rowtype;
  v_idx integer := 0;
  v_sizes text[] := array[]::text[];
  v_stock integer;
begin
  if v_id is null then
    insert into products (slug, name, category_id, price, compare_at, color, color_hex, badge, images, fit, material, description,
                          best_seller, new_arrival, luxe, status, stock_display, stock_message,
                          returnable, exchangeable, cod_enabled, online_payment_enabled)
    values (v_slug, p->>'name', (p->>'category_id')::uuid, (p->>'price')::numeric, (p->>'compare_at')::numeric, p->>'color', p->>'color_hex',
            nullif(p->>'badge', ''), array(select jsonb_array_elements_text(p->'images')), p->>'fit', p->>'material', p->>'description',
            (p->>'best_seller')::boolean, (p->>'new_arrival')::boolean, (p->>'luxe')::boolean, p->>'status', coalesce(p->>'stock_display', 'status'), nullif(btrim(coalesce(p->>'stock_message', '')), ''),
            coalesce((p->>'returnable')::boolean, true),
            coalesce((p->>'exchangeable')::boolean, (p->>'returnable')::boolean, true),
            coalesce((p->>'cod_enabled')::boolean, true),
            coalesce((p->>'online_payment_enabled')::boolean, true))
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
      updated_at = now()
    where id = v_id;
    if not found then raise exception 'not_found'; end if;
  end if;

  for v in select * from jsonb_array_elements(p->'variants') loop
    v_idx := v_idx + 1;
    v_stock := (v->>'stock')::integer;
    v_sizes := v_sizes || (v->>'size');
    select * into ex from product_variants where product_id = v_id and size = v->>'size' for update;
    if found then
      update product_variants set stock = v_stock, active = true, sort_order = v_idx,
        sku = coalesce(nullif(v->>'sku', ''), sku) where id = ex.id;
      if ex.stock <> v_stock then
        insert into inventory_movements (variant_id, delta, stock_after, reason, actor_id) values (ex.id, v_stock - ex.stock, v_stock, 'admin_adjustment', p_actor);
      end if;
    else
      insert into product_variants (product_id, sku, size, stock, sort_order)
      values (v_id, coalesce(nullif(v->>'sku', ''), upper(left(v_slug, 18)) || '-' || (v->>'size')), v->>'size', v_stock, v_idx)
      returning id into ex.id;
      insert into inventory_movements (variant_id, delta, stock_after, reason, actor_id) values (ex.id, v_stock, v_stock, 'initial', p_actor);
    end if;
  end loop;

  for ex in select * from product_variants where product_id = v_id and active and not (size = any(v_sizes)) for update loop
    update product_variants set active = false, stock = 0 where id = ex.id;
    if ex.stock <> 0 then
      insert into inventory_movements (variant_id, delta, stock_after, reason, actor_id) values (ex.id, -ex.stock, 0, 'size_removed', p_actor);
    end if;
  end loop;
  return v_id;
end $$;

revoke all on function public.save_product(jsonb, uuid) from public, anon, authenticated;
grant execute on function public.save_product(jsonb, uuid) to service_role;
