-- ============================================================
-- Migration: PO number on orders
-- Run in the Supabase SQL editor:
--   https://supabase.com/dashboard/project/ruwyfesblmaurfuiaofw/sql
-- Adds an optional customer purchase-order number to every order
-- and threads it through the submit_order RPC.
-- ============================================================

alter table public.orders add column if not exists po_number text;

-- Updated submit_order: new trailing optional arg keeps any cached
-- callers without it working (they just store NULL).
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
  p_items jsonb,
  p_po_number text default null
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
  v_default_markup numeric;
begin
  -- Compute the most common markup across markup-mode line items (mode of the multipliers).
  -- If multiple distinct multipliers are used, fall back to the largest.
  select coalesce(
    (mode() within group (order by count(*) desc)),
    0
  ) into v_default_markup
  from (
    select case
      when v_item->>'retail_mode' = 'markup' and (v_item->>'unit_price')::numeric > 0
        then round(((v_item->>'retail_price')::numeric / (v_item->>'unit_price')::numeric)::numeric, 3)
      else null
    end as mult
    from jsonb_array_elements(p_items) v_item
  ) m
  where m.mult is not null;

  insert into public.orders (
    order_number, customer_name, customer_email, customer_phone,
    customer_company, notes, po_number, subtotal, retail_subtotal, item_count
  ) values (
    p_order_number, p_customer_name, p_customer_email, p_customer_phone,
    p_customer_company, p_notes, p_po_number, p_subtotal, p_retail_subtotal, p_item_count
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

  -- Persist customer's preferred markup (if any markup-mode line items existed)
  if v_default_markup > 0 then
    perform public.save_customer_markup(
      p_customer_email, p_customer_name, p_customer_company, v_default_markup
    );
  end if;

  return v_order_id;
end;
$$;

grant execute on function public.submit_order(text, text, text, text, text, text, numeric, numeric, integer, jsonb, text) to anon;
