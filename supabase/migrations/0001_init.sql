-- ONE 2 1 EIGHT — production schema (Supabase / Postgres)
--
-- Run this once in: Supabase Dashboard → SQL Editor → New query → paste → Run.
-- It is safe to re-run: every statement is idempotent.
--
-- Security model
--   * Row Level Security is ENABLED on every table and NO policies are created, so the public
--     anon/authenticated keys can read or write nothing. Only the Next.js server (service-role key)
--     touches the database. The service-role key must never reach a browser.
--   * Order placement and stock changes happen inside Postgres functions that lock the stock rows,
--     so two shoppers can never buy the same last unit.

create extension if not exists pgcrypto;

-- ───────────────────────── catalogue ─────────────────────────

create table if not exists public.categories (
  id          uuid primary key default gen_random_uuid(),
  slug        text not null unique,
  name        text not null,
  image       text not null,
  active      boolean not null default true,
  sort_order  integer not null default 0,
  created_at  timestamptz not null default now()
);

create table if not exists public.products (
  id            uuid primary key default gen_random_uuid(),
  slug          text not null unique,
  name          text not null,
  category_id   uuid not null references public.categories(id) on delete restrict,
  price         numeric(10,2) not null check (price >= 0),
  compare_at    numeric(10,2) not null default 0 check (compare_at >= 0),
  color         text not null,
  color_hex     text not null default '#242424',
  badge         text,
  images        text[] not null default '{}',
  fit           text not null default '',
  material      text not null default '',
  description   text not null default '',
  best_seller   boolean not null default false,
  new_arrival   boolean not null default false,
  luxe          boolean not null default false,
  status        text not null default 'draft' check (status in ('active', 'draft')),
  -- "Hype" stock: when show_stock is true the storefront shows display_stock instead of the real count.
  -- The real per-size stock lives in product_variants.stock and is only ever shown in the admin dashboard.
  show_stock    boolean not null default false,
  display_stock integer check (display_stock is null or display_stock >= 0),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create index if not exists products_category_idx on public.products(category_id);
create index if not exists products_status_idx on public.products(status);

create table if not exists public.product_variants (
  id          uuid primary key default gen_random_uuid(),
  product_id  uuid not null references public.products(id) on delete cascade,
  sku         text not null unique,
  size        text not null,
  stock       integer not null default 0 check (stock >= 0),
  sort_order  integer not null default 0,
  unique (product_id, size)
);
create index if not exists variants_product_idx on public.product_variants(product_id);

create table if not exists public.coupons (
  code          text primary key,
  description   text not null default '',
  kind          text not null check (kind in ('percent', 'flat')),
  value         numeric(10,2) not null check (value > 0),
  min_subtotal  numeric(10,2) not null default 0,
  requires_luxe boolean not null default false,
  active        boolean not null default true,
  starts_at     timestamptz,
  ends_at       timestamptz,
  usage_limit   integer,
  used_count    integer not null default 0
);

-- ───────────────────────── content / CMS ─────────────────────────

create table if not exists public.store_settings (
  id                      integer primary key default 1 check (id = 1),
  brand_name              text not null default 'ONE 2 1 EIGHT',
  brand_line              text not null default '',
  promo_text              text not null default '',
  announcement_enabled    boolean not null default true,
  free_shipping_threshold numeric(10,2) not null default 1499,
  shipping_fee            numeric(10,2) not null default 79,
  low_stock_threshold     integer not null default 5,
  return_policy           text not null default '',
  seo_title               text not null default '',
  seo_description         text not null default '',
  contact_email           text not null default 'care@example.com',
  contact_phone           text not null default '',
  instagram_url           text,
  whatsapp_number         text,
  product_offer_code      text,
  product_offer_text      text,
  updated_at              timestamptz not null default now()
);

create table if not exists public.hero_slides (
  id            uuid primary key default gen_random_uuid(),
  kicker        text not null default '',
  title         text not null default '',
  body          text not null default '',
  desktop_image text not null,
  mobile_image  text not null,
  cta           text not null default '',
  href          text not null default '/collections/all',
  active        boolean not null default true,
  sort_order    integer not null default 0
);

create table if not exists public.legal_pages (
  slug        text primary key check (slug ~ '^[a-z0-9-]{1,60}$'),
  title       text not null,
  body        text not null default '',
  published   boolean not null default true,
  updated_at  timestamptz not null default now()
);

-- Longest matching pincode prefix wins. The '' row is the default for everything else.
create table if not exists public.pincode_rules (
  prefix        text primary key,
  serviceable   boolean not null default true,
  cod_available boolean not null default true,
  min_days      integer not null default 3,
  max_days      integer not null default 7,
  message       text
);

-- ───────────────────────── customers ─────────────────────────

create table if not exists public.customers (
  id          uuid primary key default gen_random_uuid(),
  phone       text not null unique,
  name        text,
  email       text,
  created_at  timestamptz not null default now()
);

create table if not exists public.customer_sessions (
  token_hash  text primary key,
  customer_id uuid not null references public.customers(id) on delete cascade,
  expires_at  timestamptz not null,
  created_at  timestamptz not null default now()
);

create table if not exists public.otp_requests (
  id          uuid primary key default gen_random_uuid(),
  phone       text not null,
  code_hash   text not null,
  attempts    integer not null default 0,
  expires_at  timestamptz not null,
  created_at  timestamptz not null default now()
);
create index if not exists otp_phone_idx on public.otp_requests(phone, created_at desc);

-- ───────────────────────── cart ─────────────────────────

create table if not exists public.carts (
  id          uuid primary key default gen_random_uuid(),
  coupon_code text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create table if not exists public.cart_items (
  id          uuid primary key default gen_random_uuid(),
  cart_id     uuid not null references public.carts(id) on delete cascade,
  variant_id  uuid not null references public.product_variants(id) on delete cascade,
  quantity    integer not null check (quantity > 0),
  unique (cart_id, variant_id)
);

-- ───────────────────────── orders ─────────────────────────

create sequence if not exists public.order_number_seq start 1001;

create table if not exists public.orders (
  id                uuid primary key default gen_random_uuid(),
  number            text not null unique,
  customer_id       uuid references public.customers(id) on delete set null,
  lookup_token_hash text not null,
  status            text not null default 'pending_payment'
    check (status in ('pending_payment','confirmed','processing','packed','shipped','delivered','cancelled','refunded')),
  payment_status    text not null default 'unpaid'
    check (payment_status in ('unpaid','pending','paid','failed','cod_pending','refunded')),
  payment_method    text not null check (payment_method in ('upi','card','cod')),
  currency          text not null default 'INR',
  subtotal          numeric(10,2) not null,
  discount          numeric(10,2) not null default 0,
  shipping          numeric(10,2) not null default 0,
  total             numeric(10,2) not null,
  coupon_code       text,
  contact           jsonb not null,
  shipping_address  jsonb not null,
  stock_restored    boolean not null default false,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);
create index if not exists orders_customer_idx on public.orders(customer_id, created_at desc);
create index if not exists orders_created_idx on public.orders(created_at desc);

create table if not exists public.order_items (
  id          uuid primary key default gen_random_uuid(),
  order_id    uuid not null references public.orders(id) on delete cascade,
  product_id  uuid not null references public.products(id) on delete restrict,
  variant_id  uuid not null references public.product_variants(id) on delete restrict,
  name        text not null,
  image       text not null,
  size        text not null,
  color       text not null,
  quantity    integer not null check (quantity > 0),
  unit_price  numeric(10,2) not null,
  line_total  numeric(10,2) not null
);
create index if not exists order_items_order_idx on public.order_items(order_id);

create table if not exists public.payments (
  id                   uuid primary key default gen_random_uuid(),
  order_id             uuid not null references public.orders(id) on delete cascade,
  provider             text not null,
  provider_order_id    text,
  provider_payment_id  text,
  status               text not null default 'pending',
  amount               numeric(10,2) not null,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);
create index if not exists payments_order_idx on public.payments(order_id);
create index if not exists payments_provider_order_idx on public.payments(provider_order_id);

create table if not exists public.idempotency_keys (
  key         text primary key,
  fingerprint text not null,
  response    jsonb not null,
  created_at  timestamptz not null default now()
);

-- ───────────────────────── engagement ─────────────────────────

create table if not exists public.reviews (
  id                uuid primary key default gen_random_uuid(),
  product_id        uuid not null references public.products(id) on delete cascade,
  customer_id       uuid references public.customers(id) on delete set null,
  author            text not null,
  rating            integer not null check (rating between 1 and 5),
  title             text not null,
  body              text not null,
  status            text not null default 'pending' check (status in ('pending','published','hidden')),
  verified_purchase boolean not null default false,
  created_at        timestamptz not null default now()
);
create index if not exists reviews_product_idx on public.reviews(product_id, status);

create table if not exists public.leads (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  email       text not null,
  phone       text not null,
  type        text not null,
  quantity    text not null,
  message     text not null default '',
  status      text not null default 'new' check (status in ('new','contacted','qualified','closed')),
  created_at  timestamptz not null default now()
);

create table if not exists public.newsletter_subscriptions (
  email       text primary key,
  status      text not null default 'subscribed',
  created_at  timestamptz not null default now()
);

-- ───────────────────────── admin ─────────────────────────

-- Admin passwords live in Supabase Auth (auth.users). This table decides WHO is an admin and their role.
create table if not exists public.admin_users (
  id          uuid primary key,
  email       text not null unique,
  name        text not null default '',
  role        text not null default 'owner' check (role in ('owner','manager','content','support')),
  active      boolean not null default true,
  created_at  timestamptz not null default now()
);

create table if not exists public.admin_sessions (
  token_hash  text primary key,
  admin_id    uuid not null references public.admin_users(id) on delete cascade,
  expires_at  timestamptz not null,
  created_at  timestamptz not null default now()
);

-- Failed-login / OTP-request throttling.
create table if not exists public.rate_events (
  id          bigserial primary key,
  bucket      text not null,
  created_at  timestamptz not null default now()
);
create index if not exists rate_events_bucket_idx on public.rate_events(bucket, created_at desc);

-- ───────────────────────── lock everything down (RLS, no policies) ─────────────────────────

do $$
declare t text;
begin
  foreach t in array array[
    'categories','products','product_variants','coupons','store_settings','hero_slides','legal_pages','pincode_rules',
    'customers','customer_sessions','otp_requests','carts','cart_items','orders','order_items','payments','idempotency_keys',
    'reviews','leads','newsletter_subscriptions','admin_users','admin_sessions','rate_events'
  ] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from anon, authenticated', t);
  end loop;
end $$;

-- ───────────────────────── business functions ─────────────────────────

-- Places an order atomically: locks the variant rows, verifies stock, decrements it, writes the order,
-- its lines and its payment, and empties the cart. Raises 'cart_empty' | 'out_of_stock' | 'price_changed'.
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
  v_method    text := p->>'payment_method';
  v_cod       boolean := (p->>'payment_method') = 'cod';
  r           record;
begin
  -- Lock in a stable order so concurrent checkouts cannot deadlock.
  for r in
    select ci.id as item_id, ci.quantity, v.id as variant_id, v.size, v.stock, v.product_id,
           pr.name, pr.price, pr.color, pr.images, pr.status
    from cart_items ci
    join product_variants v on v.id = ci.variant_id
    join products pr on pr.id = v.product_id
    where ci.cart_id = v_cart
    order by v.id
    for update of v
  loop
    if r.status <> 'active' then raise exception 'out_of_stock' using detail = r.variant_id::text; end if;
    if r.stock < r.quantity then raise exception 'out_of_stock' using detail = r.variant_id::text; end if;
    v_subtotal := v_subtotal + r.price * r.quantity;
  end loop;

  if v_subtotal = 0 then raise exception 'cart_empty'; end if;
  if abs(v_subtotal - (p->>'expected_subtotal')::numeric) > 0.009 then raise exception 'price_changed'; end if;

  insert into orders (id, number, customer_id, lookup_token_hash, status, payment_status, payment_method,
                      subtotal, discount, shipping, total, coupon_code, contact, shipping_address)
  values (v_order, '1218-' || nextval('order_number_seq'), nullif(p->>'customer_id', '')::uuid, p->>'lookup_token_hash',
          case when v_cod then 'confirmed' else 'pending_payment' end,
          case when v_cod then 'cod_pending' else 'pending' end,
          v_method, v_subtotal, v_discount, v_shipping, greatest(0, v_subtotal - v_discount + v_shipping),
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
    update product_variants set stock = stock - r.quantity where id = r.variant_id;
  end loop;

  insert into payments (order_id, provider, status, amount)
  values (v_order, coalesce(p->>'provider', 'cod'), case when v_cod then 'cod_pending' else 'pending' end,
          greatest(0, v_subtotal - v_discount + v_shipping));

  if nullif(p->>'coupon_code', '') is not null then
    update coupons set used_count = used_count + 1 where code = p->>'coupon_code';
  end if;

  delete from cart_items where cart_id = v_cart;
  update carts set coupon_code = null, updated_at = now() where id = v_cart;
  return v_order;
end $$;

-- Returns the units of a cancelled / failed order to stock. Safe to call twice.
create or replace function public.restock_order(p_order uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare r record;
begin
  perform 1 from orders where id = p_order and stock_restored = false for update;
  if not found then return; end if;
  for r in select variant_id, quantity from order_items where order_id = p_order order by variant_id loop
    update product_variants set stock = stock + r.quantity where id = r.variant_id;
  end loop;
  update orders set stock_restored = true, updated_at = now() where id = p_order;
end $$;

-- Cancels online-payment orders that were never paid within p_minutes and releases their stock.
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
    n := n + 1;
  end loop;
  return n;
end $$;

-- Everything the admin dashboard needs in one round trip. Low stock uses the REAL per-size stock.
create or replace function public.dashboard_stats(p_low integer default 5)
returns jsonb
language sql
security definer
set search_path = public
as $$
  with live as (
    select * from orders where status not in ('cancelled', 'refunded')
  ),
  days as (
    select d::date as day from generate_series(current_date - 6, current_date, interval '1 day') d
  ),
  series as (
    select days.day, coalesce(sum(live.total), 0) as amount
    from days left join live on live.created_at::date = days.day
    group by days.day order by days.day
  ),
  cur as (select count(*) as n, coalesce(sum(total), 0) as rev from live where created_at >= now() - interval '7 days'),
  prev as (select count(*) as n, coalesce(sum(total), 0) as rev from live where created_at >= now() - interval '14 days' and created_at < now() - interval '7 days'),
  low as (
    select pr.name, v.size, v.sku, v.stock
    from product_variants v join products pr on pr.id = v.product_id
    where v.stock <= p_low and pr.status = 'active'
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

-- Only the server (service role) may call these.
revoke all on function public.place_order(jsonb) from public, anon, authenticated;
revoke all on function public.restock_order(uuid) from public, anon, authenticated;
revoke all on function public.release_stale_orders(integer) from public, anon, authenticated;
revoke all on function public.dashboard_stats(integer) from public, anon, authenticated;
grant execute on function public.place_order(jsonb) to service_role;
grant execute on function public.restock_order(uuid) to service_role;
grant execute on function public.release_stale_orders(integer) to service_role;
grant execute on function public.dashboard_stats(integer) to service_role;

-- ───────────────────────── image storage ─────────────────────────

-- Public-read bucket for product / category / banner images. Uploads go through the admin API only.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('media', 'media', true, 5242880, array['image/jpeg', 'image/png', 'image/webp', 'image/avif'])
on conflict (id) do update set public = true, file_size_limit = 5242880,
  allowed_mime_types = array['image/jpeg', 'image/png', 'image/webp', 'image/avif'];

-- ───────────────────────── housekeeping job (optional) ─────────────────────────

-- Releases stock held by abandoned online-payment orders every 15 minutes.
-- Needs the pg_cron extension (Dashboard → Database → Extensions → pg_cron). If it is not enabled this block is skipped.
do $$
begin
  create extension if not exists pg_cron;
  perform cron.schedule('release-stale-orders', '*/15 * * * *', $job$select public.release_stale_orders(60)$job$);
exception when others then
  raise notice 'pg_cron not available - enable it in Database > Extensions and re-run this block to schedule stale-order release.';
end $$;
