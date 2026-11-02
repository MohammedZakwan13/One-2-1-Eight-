-- 0005 — product returnability, delivery/cancel timestamps, customer cancellation, returns and refunds.
-- Additive and idempotent: no data is rewritten except the new columns' defaults. Existing orders keep their rows;
-- legacy order items snapshot as returnable=true (the store's current policy) and legacy orders have no delivered_at.
-- NOT applied automatically. Run in the Supabase SQL Editor, then record it in supabase_migrations.schema_migrations.

alter table public.products add column if not exists returnable boolean not null default true;
alter table public.store_settings add column if not exists return_window_days integer not null default 7 check (return_window_days between 0 and 90);
alter table public.order_items add column if not exists returnable boolean not null default true;
alter table public.orders add column if not exists shipped_at timestamptz;
alter table public.orders add column if not exists delivered_at timestamptz;
alter table public.orders add column if not exists cancel_reason text;
alter table public.orders add column if not exists cancelled_by text check (cancelled_by in ('customer', 'admin', 'system'));

-- Snapshot the product's returnability when an order line is created, so later product edits never change an old purchase.
create or replace function public.snapshot_item_returnable() returns trigger language plpgsql set search_path = public as $$
begin
  select returnable into new.returnable from products where id = new.product_id;
  return new;
end $$;
drop trigger if exists order_items_snapshot_returnable on public.order_items;
create trigger order_items_snapshot_returnable before insert on public.order_items for each row execute function public.snapshot_item_returnable();

create table if not exists public.returns (
  id          uuid primary key default gen_random_uuid(),
  number      text not null unique,
  order_id    uuid not null references public.orders(id) on delete cascade,
  customer_id uuid references public.customers(id) on delete set null,
  status      text not null default 'requested' check (status in ('requested', 'approved', 'rejected', 'received', 'refund_pending', 'completed')),
  reason      text not null check (char_length(reason) between 3 and 500),
  admin_note  text,
  restocked   boolean not null default false,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index if not exists returns_order_idx on public.returns(order_id);
create index if not exists returns_status_idx on public.returns(status, created_at desc);

create table if not exists public.return_items (
  id            uuid primary key default gen_random_uuid(),
  return_id     uuid not null references public.returns(id) on delete cascade,
  order_item_id uuid not null references public.order_items(id) on delete restrict,
  quantity      integer not null check (quantity > 0)
);
create index if not exists return_items_return_idx on public.return_items(return_id);

create table if not exists public.return_history (
  id         bigserial primary key,
  return_id  uuid not null references public.returns(id) on delete cascade,
  from_status text,
  to_status  text not null,
  actor_type text not null default 'system' check (actor_type in ('system', 'admin', 'customer')),
  actor_id   uuid,
  note       text,
  created_at timestamptz not null default now()
);

-- A refund is only 'completed' once a person (COD / manual) or a verified provider result says so. Never inferred.
create table if not exists public.refunds (
  id                 uuid primary key default gen_random_uuid(),
  order_id           uuid not null references public.orders(id) on delete cascade,
  return_id          uuid references public.returns(id) on delete set null,
  amount             numeric(10,2) not null check (amount > 0),
  status             text not null default 'pending' check (status in ('pending', 'completed', 'failed')),
  provider           text not null default 'manual',
  provider_refund_id text,
  note               text,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);
create unique index if not exists refunds_one_per_return on public.refunds(return_id) where return_id is not null;
create unique index if not exists refunds_one_per_cancel on public.refunds(order_id) where return_id is null;

alter table public.returns enable row level security;
alter table public.return_items enable row level security;
alter table public.return_history enable row level security;
alter table public.refunds enable row level security;

-- transition_order: same graph as 0002, plus timestamps and a pending refund when a PAID order is cancelled.
create or replace function public.transition_order(
  p_order uuid, p_to text, p_actor uuid, p_note text default null,
  p_carrier text default null, p_tracking text default null, p_url text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare o orders%rowtype; allowed text[];
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
  if p_to = 'cancelled' then
    perform restock_order(p_order);
    if o.payment_status = 'paid' then
      insert into refunds (order_id, amount, provider, note) values (p_order, o.total, case when o.payment_method = 'cod' then 'manual' else 'razorpay' end, 'Order cancelled after payment')
      on conflict do nothing;
    end if;
  end if;
  update orders set
    status = p_to,
    shipped_at = case when p_to = 'shipped' then now() else shipped_at end,
    delivered_at = case when p_to = 'delivered' then now() else delivered_at end,
    cancel_reason = case when p_to = 'cancelled' then coalesce(p_note, cancel_reason) else cancel_reason end,
    cancelled_by = case when p_to = 'cancelled' then case when p_actor is null then 'system' else 'admin' end else cancelled_by end,
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

-- Customer cancellation: only before the parcel ships. Idempotent; stock is restored once by restock_order.
create or replace function public.cancel_order_customer(p_order uuid, p_reason text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare o orders%rowtype;
begin
  select * into o from orders where id = p_order for update;
  if not found then raise exception 'not_found'; end if;
  if o.status = 'cancelled' then return jsonb_build_object('changed', false); end if;
  if o.status not in ('pending_payment', 'confirmed', 'processing', 'packed') then raise exception 'not_cancellable' using detail = o.status; end if;
  perform restock_order(p_order);
  if o.payment_status = 'paid' then
    insert into refunds (order_id, amount, provider, note) values (p_order, o.total, 'razorpay', 'Cancelled by customer after payment') on conflict do nothing;
  end if;
  update orders set status = 'cancelled', cancel_reason = left(coalesce(p_reason, ''), 300), cancelled_by = 'customer', updated_at = now() where id = p_order;
  insert into order_status_history (order_id, from_status, to_status, actor_type, note) values (p_order, o.status, 'cancelled', 'customer', left(coalesce(p_reason, ''), 300));
  return jsonb_build_object('changed', true, 'from', o.status);
end $$;

-- Return request. Eligibility is enforced here, not only in the UI: delivered, inside the window, returnable snapshot,
-- and quantity never exceeds what was bought minus what is already requested (rejected returns do not count).
create or replace function public.create_return(p_order uuid, p_customer uuid, p_items jsonb, p_reason text)
returns uuid language plpgsql security definer set search_path = public as $$
declare o orders%rowtype; window_days integer; it jsonb; oi order_items%rowtype; reserved integer; rid uuid; seq integer; n integer := 0;
begin
  select * into o from orders where id = p_order for update;
  if not found then raise exception 'not_found'; end if;
  if o.status <> 'delivered' or o.delivered_at is null then raise exception 'not_delivered'; end if;
  select return_window_days into window_days from store_settings limit 1;
  if now() > o.delivered_at + make_interval(days => coalesce(window_days, 7)) then raise exception 'window_closed'; end if;
  if jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then raise exception 'no_items'; end if;
  select count(*) + 1 into seq from returns where order_id = p_order;
  insert into returns (number, order_id, customer_id, reason) values ('R' || o.number || '-' || seq, p_order, p_customer, p_reason) returning id into rid;
  for it in select * from jsonb_array_elements(p_items) loop
    select * into oi from order_items where id = (it->>'order_item_id')::uuid and order_id = p_order;
    if not found then raise exception 'bad_item'; end if;
    if not oi.returnable then raise exception 'not_returnable' using detail = oi.name; end if;
    select coalesce(sum(ri.quantity), 0) into reserved from return_items ri join returns r on r.id = ri.return_id
      where ri.order_item_id = oi.id and r.status <> 'rejected' and r.id <> rid;
    if (it->>'quantity')::int < 1 or (it->>'quantity')::int + reserved > oi.quantity then raise exception 'quantity_exceeded' using detail = oi.name; end if;
    insert into return_items (return_id, order_item_id, quantity) values (rid, oi.id, (it->>'quantity')::int);
    n := n + 1;
  end loop;
  insert into return_history (return_id, to_status, actor_type, actor_id, note) values (rid, 'requested', case when p_customer is null then 'system' else 'customer' end, p_customer, p_reason);
  return rid;
end $$;

-- Admin processing. Graph: requested→approved|rejected, approved→received, received→refund_pending|completed, refund_pending→completed.
-- Stock returns ONLY at 'received' and only when p_restock is true (item inspected as resellable), exactly once per return.
-- 'completed' with money owed needs a refund reference: the refund row becomes completed only then.
create or replace function public.process_return(p_return uuid, p_to text, p_actor uuid, p_note text default null, p_restock boolean default false, p_ref text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare r returns%rowtype; o orders%rowtype; v_amount numeric; v_paid numeric; it record; v_after integer; owed boolean;
begin
  select * into r from returns where id = p_return for update;
  if not found then raise exception 'not_found'; end if;
  if r.status = p_to then return jsonb_build_object('changed', false, 'to', r.status); end if;
  if not (p_to = any (case r.status
      when 'requested' then array['approved', 'rejected']
      when 'approved' then array['received']
      when 'received' then array['refund_pending', 'completed']
      when 'refund_pending' then array['completed']
      else array[]::text[] end)) then raise exception 'invalid_transition' using detail = r.status || '->' || p_to; end if;
  select * into o from orders where id = r.order_id for update;
  owed := o.payment_status in ('paid', 'refunded');
  if p_to = 'received' and p_restock and not r.restocked then
    for it in select oi.variant_id, ri.quantity from return_items ri join order_items oi on oi.id = ri.order_item_id where ri.return_id = p_return order by oi.variant_id loop
      update product_variants set stock = stock + it.quantity where id = it.variant_id returning stock into v_after;
      insert into inventory_movements (variant_id, delta, stock_after, reason, order_id) values (it.variant_id, it.quantity, v_after, 'restock', r.order_id);
    end loop;
    update returns set restocked = true where id = p_return;
  end if;
  if p_to in ('refund_pending', 'completed') and owed then
    select coalesce(sum(oi.unit_price * ri.quantity), 0) into v_amount from return_items ri join order_items oi on oi.id = ri.order_item_id where ri.return_id = p_return;
    select coalesce(sum(f.amount), 0) into v_paid from refunds f where f.order_id = r.order_id and f.return_id is distinct from p_return and f.status <> 'failed';
    if v_amount + v_paid > o.total then raise exception 'refund_exceeds_paid'; end if;
    insert into refunds (order_id, return_id, amount, provider, note) values (r.order_id, p_return, v_amount, case when o.payment_method = 'cod' then 'manual' else 'razorpay' end, 'Return ' || r.number) on conflict do nothing;
    if p_to = 'completed' then
      if coalesce(trim(p_ref), '') = '' then raise exception 'refund_reference_required'; end if;
      update refunds set status = 'completed', provider_refund_id = left(p_ref, 120), updated_at = now() where return_id = p_return;
      if (select coalesce(sum(f.amount), 0) from refunds f where f.order_id = r.order_id and f.status = 'completed') >= o.total then
        update orders set payment_status = 'refunded', updated_at = now() where id = r.order_id;
      end if;
    end if;
  end if;
  update returns set status = p_to, admin_note = coalesce(p_note, admin_note), updated_at = now() where id = p_return;
  insert into return_history (return_id, from_status, to_status, actor_type, actor_id, note) values (p_return, r.status, p_to, 'admin', p_actor, p_note);
  return jsonb_build_object('changed', true, 'from', r.status, 'to', p_to);
end $$;

-- Same lock-down as 0003 for the new objects.
revoke all on public.returns, public.return_items, public.return_history, public.refunds from public, anon, authenticated;
grant all on public.returns, public.return_items, public.return_history, public.refunds to service_role;
grant usage, select on all sequences in schema public to service_role;
do $$ declare f record; begin
  for f in select p.oid::regprocedure as sig from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname in ('snapshot_item_returnable', 'transition_order', 'cancel_order_customer', 'create_return', 'process_return') loop
    execute format('revoke all on function %s from public, anon, authenticated', f.sig);
    execute format('grant execute on function %s to service_role', f.sig);
  end loop;
end $$;
