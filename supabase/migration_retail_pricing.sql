-- ============================================================
-- Migration: retail pricing columns
-- Run this ONCE in Supabase SQL editor:
--   https://supabase.com/dashboard/project/ruwyfesblmaurfuiaofw/sql
--
-- Safe to run repeatedly: uses IF NOT EXISTS / OR REPLACE.
-- Existing rows default to wholesale-mode retail (= wholesale price).
-- ============================================================

-- ----- orders: add retail_subtotal -----
alter table public.orders
  add column if not exists retail_subtotal numeric(10,2) not null default 0;

-- ----- order_items: add retail columns -----
alter table public.order_items
  add column if not exists retail_mode text not null default 'wholesale'
    check (retail_mode in ('wholesale','markup','manual')),
  add column if not exists retail_price numeric(10,2) not null default 0,
  add column if not exists retail_line_total numeric(10,2) not null default 0;

-- Backfill any pre-existing rows so retail == wholesale.
update public.order_items
  set retail_price = unit_price,
      retail_line_total = line_total
  where retail_price = 0 and unit_price > 0;

update public.orders o
  set retail_subtotal = o.subtotal
  where retail_subtotal = 0;

-- ============================================================
-- Update submit_order RPC to accept retail pricing
-- ============================================================
create or replace function public.submit_order(
  p_order_number text,
  p_customer_name text,
  p_customer_email text,
  p_customer_phone text,
  p_customer_company text,
  p_notes text,
  p_subtotal numeric,
  p_retail_subtotal numeric,
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
  v_retail_mode text;
  v_retail_price numeric;
  v_qty integer;
  v_retail_line_total numeric;
begin
  insert into public.orders (
    order_number, customer_name, customer_email, customer_phone,
    customer_company, notes, subtotal, retail_subtotal, item_count
  ) values (
    p_order_number, p_customer_name, p_customer_email, p_customer_phone,
    p_customer_company, p_notes, p_subtotal, p_retail_subtotal, p_item_count
  )
  returning id into v_order_id;

  for v_item in select * from jsonb_array_elements(p_items)
  loop
    v_retail_mode := coalesce(v_item->>'retail_mode', 'wholesale');
    v_retail_price := coalesce(nullif(v_item->>'retail_price','')::numeric, (v_item->>'unit_price')::numeric, 0);
    v_qty := (v_item->>'qty')::integer;
    v_retail_line_total := coalesce(nullif(v_item->>'retail_line_total','')::numeric, v_retail_price * v_qty, 0);

    insert into public.order_items (
      order_id, plant_key, plant_name, plant_size,
      unit_price, qty, line_total,
      retail_mode, retail_price, retail_line_total
    ) values (
      v_order_id,
      v_item->>'plant_key',
      v_item->>'plant_name',
      v_item->>'plant_size',
      (v_item->>'unit_price')::numeric,
      v_qty,
      (v_item->>'line_total')::numeric,
      v_retail_mode,
      v_retail_price,
      v_retail_line_total
    );
  end loop;

  return v_order_id;
end;
$$;

grant execute on function public.submit_order to anon;