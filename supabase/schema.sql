-- ============================================================
-- Native Sons — Order Portal schema
-- Run this once in the Supabase SQL editor:
--   https://supabase.com/dashboard/project/ruwyfesblmaurfuiaofw/sql
-- ============================================================

-- ----- orders -----
create table if not exists public.orders (
  id uuid primary key default gen_random_uuid(),
  order_number text not null unique,
  customer_name text not null,
  customer_email text not null,
  customer_phone text,
  customer_company text,
  notes text,
  status text not null default 'new' check (status in ('new','confirmed','fulfilled','cancelled')),
  subtotal numeric(10,2) not null default 0,
  item_count integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_orders_status on public.orders(status);
create index if not exists idx_orders_created_at on public.orders(created_at desc);
create index if not exists idx_orders_email on public.orders(customer_email);

-- ----- order_items -----
create table if not exists public.order_items (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.orders(id) on delete cascade,
  plant_key text not null,
  plant_name text not null,
  plant_size text,
  unit_price numeric(10,2) not null default 0,
  qty integer not null check (qty > 0),
  line_total numeric(10,2) not null default 0
);

create index if not exists idx_order_items_order_id on public.order_items(order_id);

-- ----- updated_at trigger -----
create or replace function public.touch_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists trg_orders_updated_at on public.orders;
create trigger trg_orders_updated_at
  before update on public.orders
  for each row execute function public.touch_updated_at();

-- ============================================================
-- Row-Level Security
-- ============================================================

alter table public.orders enable row level security;
alter table public.order_items enable row level security;

-- Public (anon) can INSERT orders. The app uses the anon key,
-- and we want anyone (customers) to be able to submit an order.
-- We do NOT allow anon to SELECT — that prevents random people
-- from enumerating order numbers.
drop policy if exists "anon_insert_orders" on public.orders;
create policy "anon_insert_orders"
  on public.orders
  for insert
  to anon
  with check (true);

-- Customers can read their own orders by order_number + email.
-- This lets the confirmation page work without auth. RLS still
-- blocks random SELECTs. Note: requires either a SECURITY DEFINER
-- function or trusted client to do the lookup. For simplicity, the
-- confirmation page just shows the order number that was returned
-- from the insert — no follow-up SELECT needed.

-- Anon can INSERT order_items linked to an order they just created.
-- The anon_insert policy above allows the parent insert; this allows
-- the child insert. We rely on the application layer to send both
-- inserts in sequence. For full safety, switch to a SECURITY DEFINER
-- function that does both in a transaction (see OPTIONAL block below).
drop policy if exists "anon_insert_order_items" on public.order_items;
create policy "anon_insert_order_items"
  on public.order_items
  for insert
  to anon
  with check (true);

-- Service role (used by admin.html with the service_role key)
-- bypasses RLS automatically, so admin can read/update everything.

-- ============================================================
-- OPTIONAL: atomic insert via RPC
-- For bulletproof correctness, use this stored function instead
-- of two separate inserts. The app already handles a partial-failure
-- rollback, but this is the cleanest path.
-- ============================================================

create or replace function public.submit_order(
  p_order_number text,
  p_customer_name text,
  p_customer_email text,
  p_customer_phone text,
  p_customer_company text,
  p_notes text,
  p_subtotal numeric,
  p_item_count integer,
  p_items jsonb
)
returns uuid
language plpgsql
security definer
as $$
declare
  v_order_id uuid;
  v_item jsonb;
begin
  insert into public.orders (
    order_number, customer_name, customer_email, customer_phone,
    customer_company, notes, subtotal, item_count
  ) values (
    p_order_number, p_customer_name, p_customer_email, p_customer_phone,
    p_customer_company, p_notes, p_subtotal, p_item_count
  )
  returning id into v_order_id;

  for v_item in select * from jsonb_array_elements(p_items)
  loop
    insert into public.order_items (
      order_id, plant_key, plant_name, plant_size, unit_price, qty, line_total
    ) values (
      v_order_id,
      v_item->>'plant_key',
      v_item->>'plant_name',
      v_item->>'plant_size',
      (v_item->>'unit_price')::numeric,
      (v_item->>'qty')::integer,
      (v_item->>'line_total')::numeric
    );
  end loop;

  return v_order_id;
end;
$$;

-- Grant anon execute on the RPC
grant execute on function public.submit_order to anon;

-- ============================================================
-- Realtime: enable for orders so admin.html could (later) live-update
-- DO block skips if already added (avoids "already member of publication" error).
-- ============================================================
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and tablename = 'orders'
  ) then
    alter publication supabase_realtime add table public.orders;
  end if;
end
$$;
