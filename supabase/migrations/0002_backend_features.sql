-- 0002: truthful stock display, audit trails, wishlist, addresses, lead activity, email log, and atomic
-- order / product / payment functions. Applies on top of 0001_init.sql. Idempotent.

-- ───────────── catalogue changes ─────────────

alter table public.cart_items add column if not exists created_at timestamptz not null default now();

alter table public.products drop column if exists show_stock;
alter table public.products drop column if exists display_stock;
-- How the REAL stock is presented to shoppers. Never alters stored inventory or low-stock alerts.
alter table public.products add column if not exists stock_display text not null default 'status'
  check (stock_display in ('exact', 'status', 'low_stock'));
alter table public.product_variants add column if not exists active boolean not null default true;

alter table public.orders add column if not exists carrier text;
alter table public.orders add column if not exists tracking_number text;
alter table public.orders add column if not exists tracking_url text;

-- ───────────── new tables ─────────────

create table if not exists public.order_status_history (
  id          bigserial primary key,
  order_id    uuid not null references public.orders(id) on delete cascade,
  from_status text,
  to_status   text not null,
  actor_type  text not null default 'system' check (actor_type in ('system', 'admin', 'customer', 'payment')),
  actor_id    uuid,
  note        text,
  created_at  timestamptz not null default now()
);
create index if not exists osh_order_idx on public.order_status_history(order_id, created_at);

create table if not exists public.inventory_movements (
  id          bigserial primary key,
  variant_id  uuid not null references public.product_variants(id) on delete cascade,
  delta       integer not null,
  stock_after integer not null,
  reason      text not null check (reason in ('order', 'restock', 'admin_adjustment', 'initial', 'size_removed')),
  order_id    uuid references public.orders(id) on delete set null,
  actor_id    uuid,
  created_at  timestamptz not null default now()
);
create index if not exists inv_variant_idx on public.inventory_movements(variant_id, created_at desc);

create table if not exists public.wishlist_items (
  customer_id uuid not null references public.customers(id) on delete cascade,
  product_id  uuid not null references public.products(id) on delete cascade,
  created_at  timestamptz not null default now(),
  primary key (customer_id, product_id)
);

create table if not exists public.customer_addresses (
  id          uuid primary key default gen_random_uuid(),
  customer_id uuid not null references public.customers(id) on delete cascade,
  label       text not null default 'Home',
  name        text not null,
  phone       text not null,
  line1       text not null,
  line2       text,
  city        text not null,
  state       text not null,
  pincode     text not null,
  is_default  boolean not null default false,
  created_at  timestamptz not null default now()
);
create index if not exists addr_customer_idx on public.customer_addresses(customer_id);

alter table public.leads add column if not exists source text not null default 'website';
alter table public.leads add column if not exists dedupe_key text;
create unique index if not exists leads_dedupe_idx on public.leads(dedupe_key) where dedupe_key is not null;

create table if not exists public.lead_activity (
  id          bigserial primary key,
  lead_id     uuid not null references public.leads(id) on delete cascade,
  actor_id    uuid,
  kind        text not null,
  note        text,
  created_at  timestamptz not null default now()
);

-- Delivery state of outbound email is kept apart from order / lead state.
create table if not exists public.email_log (
  id                  uuid primary key default gen_random_uuid(),
  kind                text not null,
  to_email            text not null,
  subject             text not null,
  entity_type         text,
  entity_id           uuid,
  dedupe_key          text unique,
  status              text not null default 'queued'
    check (status in ('queued', 'accepted', 'delivered', 'bounced', 'complained', 'failed', 'skipped_unconfigured')),
  provider_message_id text,
  error               text,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);
create index if not exists email_provider_idx on public.email_log(provider_message_id);

create table if not exists public.webhook_events (
  provider    text not null,
  event_id    text not null,
  created_at  timestamptz not null default now(),
  primary key (provider, event_id)
);

do $$
declare t text;
begin
  foreach t in array array['order_status_history','inventory_movements','wishlist_items','customer_addresses','lead_activity','email_log','webhook_events'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from anon, authenticated', t);
  end loop;
end $$;

-- ───────────── functions ─────────────

create or replace function public.place_order(p jsonb)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_cart      uuid := (p->>'cart_id')::uuid;
  v_order     uuid := gen_random_uuid();
  v_subtotal  numeric(10,2) := 0;
  v_discount  numeric(10,2) := coalesce((p->>'discount')::numeric, 0);
  v_shipping  numeric(10,2) := coalesce((p->>'shipping')::numeric, 0);
  v_cod       boolean := (p->>'payment_method') = 'cod';
  v_status    text;
  v_after     integer;
  r           record;
begin
  for r in
    select ci.quantity, v.id as variant_id, v.stock, v.active, pr.price, pr.status
    from cart_items ci
    join product_variants v on v.id = ci.variant_id
    join products pr on pr.id = v.product_id
    where ci.cart_id = v_cart
    order by v.id
    for update of v
  loop
    if r.status <> 'active' or not r.active or r.stock < r.quantity then
      raise exception 'out_of_stock' using detail = r.variant_id::text;
    end if;
    v_subtotal := v_subtotal + r.price * r.quantity;
  end loop;

  if v_subtotal = 0 then raise exception 'cart_empty'; end if;
  if abs(v_subtotal - (p->>'expected_subtotal')::numeric) > 0.009 then raise exception 'price_changed'; end if;

  v_status := case when v_cod then 'confirmed' else 'pending_payment' end;
  insert into orders (id, number, customer_id, lookup_token_hash, status, payment_status, payment_method,
                      subtotal, discount, shipping, total, coupon_code, contact, shipping_address)
  values (v_order, '1218-' || nextval('order_number_seq'), nullif(p->>'customer_id', '')::uuid, p->>'lookup_token_hash',
          v_status, case when v_cod then 'cod_pending' else 'pending' end,
          p->>'payment_method', v_subtotal, v_discount, v_shipping, greatest(0, v_subtotal - v_discount + v_shipping),
          nullif(p->>'coupon_code', ''), p->'contact', p->'shipping_address');

  for r in
    select ci.quantity, v.id as variant_id, v.size, v.product_id, pr.name, pr.price, pr.color, pr.images
    from cart_items ci
    join product_variants v on v.id = ci.variant_id
    join products pr on pr.id = v.product_id
    where ci.cart_id = v_cart
  loop
    insert into order_items (order_id, product_id, variant_id, name, image, size, color, quantity, unit_price, line_total)
    values (v_order, r.product_id, r.variant_id, r.name, coalesce(r.images[1], ''), r.size, r.color, r.quantity, r.price, r.price * r.quantity);
    update product_variants set stock = stock - r.quantity where id = r.variant_id returning stock into v_after;
    insert into inventory_movements (variant_id, delta, stock_after, reason, order_id) values (r.variant_id, -r.quantity, v_after, 'order', v_order);
  end loop;

  insert into payments (order_id, provider, status, amount)
  values (v_order, coalesce(p->>'provider', 'cod'), case when v_cod then 'cod_pending' else 'pending' end,
          greatest(0, v_subtotal - v_discount + v_shipping));
  insert into order_status_history (order_id, from_status, to_status, actor_type) values (v_order, null, v_status, 'system');

  if nullif(p->>'coupon_code', '') is not null then
    update coupons set used_count = used_count + 1 where code = p->>'coupon_code';
  end if;
  delete from cart_items where cart_id = v_cart;
  update carts set coupon_code = null, updated_at = now() where id = v_cart;
  return v_order;
end $$;

create or replace function public.restock_order(p_order uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare r record; v_after integer;
begin
  perform 1 from orders where id = p_order and stock_restored = false for update;
  if not found then return; end if;
  for r in select variant_id, quantity from order_items where order_id = p_order order by variant_id loop
    update product_variants set stock = stock + r.quantity where id = r.variant_id returning stock into v_after;
    insert into inventory_movements (variant_id, delta, stock_after, reason, order_id) values (r.variant_id, r.quantity, v_after, 'restock', p_order);
  end loop;
  update orders set stock_restored = true, updated_at = now() where id = p_order;
end $$;

create or replace function public.release_stale_orders(p_minutes integer default 60)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare r record; n integer := 0;
begin
  for r in select id from orders
           where status = 'pending_payment' and payment_status in ('pending','unpaid','failed')
             and created_at < now() - make_interval(mins => p_minutes)
  loop
    perform restock_order(r.id);
    update orders set status = 'cancelled', updated_at = now() where id = r.id;
    insert into order_status_history (order_id, from_status, to_status, actor_type, note)
    values (r.id, 'pending_payment', 'cancelled', 'system', 'Payment not completed in time');
    n := n + 1;
  end loop;
  return n;
end $$;

-- Fulfilment transition. Fulfilment and payment are separate: only COD delivery (cash collected) and an
-- admin-recorded refund touch payment_status. Raises 'not_found' | 'invalid_transition'.
create or replace function public.transition_order(
  p_order uuid, p_to text, p_actor uuid, p_note text default null,
  p_carrier text default null, p_tracking text default null, p_url text default null)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  o orders%rowtype;
  allowed text[];
begin
  select * into o from orders where id = p_order for update;
  if not found then raise exception 'not_found'; end if;
  if o.status = p_to then return jsonb_build_object('from', o.status, 'to', o.status, 'changed', false); end if;

  allowed := case o.status
    when 'pending_payment' then array['cancelled']
    when 'confirmed'  then array['processing', 'cancelled']
    when 'processing' then array['packed', 'cancelled']
    when 'packed'     then array['shipped', 'cancelled']
    when 'shipped'    then array['delivered']
    when 'delivered'  then array['refunded']
    else array[]::text[] end;
  if not (p_to = any(allowed)) then raise exception 'invalid_transition' using detail = o.status || '->' || p_to; end if;

  if p_to = 'cancelled' then perform restock_order(p_order); end if;

  update orders set
    status = p_to,
    carrier = case when p_to = 'shipped' then coalesce(p_carrier, carrier) else carrier end,
    tracking_number = case when p_to = 'shipped' then coalesce(p_tracking, tracking_number) else tracking_number end,
    tracking_url = case when p_to = 'shipped' then coalesce(p_url, tracking_url) else tracking_url end,
    payment_status = case
      when p_to = 'delivered' and o.payment_method = 'cod' and o.payment_status = 'cod_pending' then 'paid'
      when p_to = 'refunded' and o.payment_status = 'paid' then 'refunded'
      else o.payment_status end,
    updated_at = now()
  where id = p_order;

  insert into order_status_history (order_id, from_status, to_status, actor_type, actor_id, note)
  values (p_order, o.status, p_to, case when p_actor is null then 'system' else 'admin' end, p_actor, p_note);
  return jsonb_build_object('from', o.status, 'to', p_to, 'changed', true);
end $$;

-- Records a payment outcome reported by the provider (verified server-side). Idempotent.
create or replace function public.settle_payment(p_order uuid, p_provider_payment text, p_success boolean)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare o orders%rowtype;
begin
  select * into o from orders where id = p_order for update;
  if not found then raise exception 'not_found'; end if;
  if o.payment_status in ('paid', 'refunded') then return jsonb_build_object('changed', false, 'payment_status', o.payment_status); end if;
  if o.status = 'cancelled' and p_success then
    -- Money arrived for an order we already released; keep the fact, flag it for manual refund.
    update payments set provider_payment_id = p_provider_payment, status = 'captured_after_cancel', updated_at = now() where order_id = p_order;
    update orders set payment_status = 'paid', updated_at = now() where id = p_order;
    return jsonb_build_object('changed', true, 'payment_status', 'paid', 'needs_refund', true);
  end if;
  if p_success then
    update payments set provider_payment_id = p_provider_payment, status = 'paid', updated_at = now() where order_id = p_order;
    update orders set payment_status = 'paid', status = case when status = 'pending_payment' then 'confirmed' else status end, updated_at = now() where id = p_order;
    if o.status = 'pending_payment' then
      insert into order_status_history (order_id, from_status, to_status, actor_type, note) values (p_order, 'pending_payment', 'confirmed', 'payment', 'Payment verified');
    end if;
    return jsonb_build_object('changed', true, 'payment_status', 'paid');
  end if;
  update payments set status = 'failed', updated_at = now() where order_id = p_order;
  update orders set payment_status = 'failed', updated_at = now() where id = p_order;
  return jsonb_build_object('changed', true, 'payment_status', 'failed');
end $$;

-- Creates or updates a product and its size variants in ONE transaction. Stock changes are logged.
-- Sizes omitted from the list are deactivated (stock 0) rather than deleted, so past orders stay intact.
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
                          best_seller, new_arrival, luxe, status, stock_display)
    values (v_slug, p->>'name', (p->>'category_id')::uuid, (p->>'price')::numeric, (p->>'compare_at')::numeric, p->>'color', p->>'color_hex',
            nullif(p->>'badge', ''), array(select jsonb_array_elements_text(p->'images')), p->>'fit', p->>'material', p->>'description',
            (p->>'best_seller')::boolean, (p->>'new_arrival')::boolean, (p->>'luxe')::boolean, p->>'status', p->>'stock_display')
    returning id into v_id;
  else
    update products set slug = v_slug, name = p->>'name', category_id = (p->>'category_id')::uuid, price = (p->>'price')::numeric,
      compare_at = (p->>'compare_at')::numeric, color = p->>'color', color_hex = p->>'color_hex', badge = nullif(p->>'badge', ''),
      images = array(select jsonb_array_elements_text(p->'images')), fit = p->>'fit', material = p->>'material', description = p->>'description',
      best_seller = (p->>'best_seller')::boolean, new_arrival = (p->>'new_arrival')::boolean, luxe = (p->>'luxe')::boolean,
      status = p->>'status', stock_display = p->>'stock_display', updated_at = now()
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

create or replace function public.dashboard_stats(p_low integer default 5)
returns jsonb
language sql
security definer
set search_path = public
as $$
  with live as (select * from orders where status not in ('cancelled', 'refunded')),
  days as (select d::date as day from generate_series(current_date - 6, current_date, interval '1 day') d),
  series as (
    select days.day, coalesce(sum(live.total), 0) as amount
    from days left join live on live.created_at::date = days.day group by days.day order by days.day
  ),
  cur as (select count(*) as n, coalesce(sum(total), 0) as rev from live where created_at >= now() - interval '7 days'),
  prev as (select count(*) as n, coalesce(sum(total), 0) as rev from live where created_at >= now() - interval '14 days' and created_at < now() - interval '7 days'),
  low as (
    select pr.name, v.size, v.sku, v.stock
    from product_variants v join products pr on pr.id = v.product_id
    where v.active and pr.status = 'active' and v.stock <= p_low
    order by v.stock asc, pr.name asc
  )
  select jsonb_build_object(
    'order_count', (select count(*) from orders),
    'gross_revenue', (select coalesce(sum(total), 0) from live),
    'product_count', (select count(*) from products),
    'low_stock_count', (select count(*) from low),
    'low_stock_items', coalesce((select jsonb_agg(jsonb_build_object('name', name, 'size', size, 'sku', sku, 'stock', stock)) from (select * from low limit 12) l), '[]'::jsonb),
    'new_arrival_count', (select count(*) from products where new_arrival and status = 'active'),
    'new_lead_count', (select count(*) from leads where status = 'new'),
    'pending_review_count', (select count(*) from reviews where status = 'pending'),
    'order_delta', case when (select n from prev) = 0 then null else round(((select n from cur) - (select n from prev))::numeric * 100 / (select n from prev), 1) end,
    'revenue_delta', case when (select rev from prev) = 0 then null else round(((select rev from cur) - (select rev from prev)) * 100 / (select rev from prev), 1) end,
    'series', (select jsonb_agg(jsonb_build_object('date', to_char(day, 'YYYY-MM-DD'), 'amount', amount) order by day) from series)
  );
$$;

do $$
declare f text;
begin
  foreach f in array array[
    'place_order(jsonb)', 'restock_order(uuid)', 'release_stale_orders(integer)', 'dashboard_stats(integer)',
    'transition_order(uuid,text,uuid,text,text,text,text)', 'settle_payment(uuid,text,boolean)', 'save_product(jsonb,uuid)'
  ] loop
    execute format('revoke all on function public.%s from public, anon, authenticated', f);
    execute format('grant execute on function public.%s to service_role', f);
  end loop;
end $$;
