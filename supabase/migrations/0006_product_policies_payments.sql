-- 0006_product_policies_payments.sql
-- Product Return, Exchange and Payment Method Controls
-- Additive and backward-compatible.
-- Preserves existing product configurations and historical order eligibility.

-- 1. Products table extensions:
alter table public.products add column if not exists exchangeable boolean;
-- Safe migration default: existing non-returnable products stay non-exchangeable; returnable stay exchangeable
update public.products set exchangeable = returnable where exchangeable is null;
alter table public.products alter column exchangeable set default true;
alter table public.products alter column exchangeable set not null;

-- Payment method controls for products:
alter table public.products add column if not exists cod_enabled boolean not null default true;
alter table public.products add column if not exists online_payment_enabled boolean not null default true;

-- 2. Order items table extension:
alter table public.order_items add column if not exists exchangeable boolean;
-- Safe migration default for historical order items: matches historical returnable snapshot
update public.order_items set exchangeable = returnable where exchangeable is null;
alter table public.order_items alter column exchangeable set default true;
alter table public.order_items alter column exchangeable set not null;

-- 3. Extend the order item snapshot trigger to capture both returnable and exchangeable at purchase time
create or replace function public.snapshot_item_returnable() returns trigger language plpgsql set search_path = public as $$
begin
  select coalesce(returnable, true), coalesce(exchangeable, returnable, true)
  into new.returnable, new.exchangeable
  from products where id = new.product_id;
  return new;
end $$;

drop trigger if exists order_items_snapshot_returnable on public.order_items;
create trigger order_items_snapshot_returnable before insert on public.order_items for each row execute function public.snapshot_item_returnable();
