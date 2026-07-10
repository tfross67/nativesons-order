-- Drop and recreate submit_order to:
-- 1. Match the columns JS actually sends in p_items:
--    plant_key, plant_name, plant_size, unit_price, qty, line_total,
--    retail_mode, retail_price, retail_line_total, special_order
-- 2. Persist special_order to order_items.special_order

drop function if exists public.submit_order (
  p_order_number text,
  p_customer_name text,
  p_customer_email text,
  p_customer_phone text,
  p_customer_company text,
  p_notes text,
  p_subtotal numeric,
  p_item_count integer,
  p_retail_subtotal numeric,
  p_items jsonb
);

create function public.submit_order(
  p_order_number text,
  p_customer_name text,
  p_customer_email text,
  p_customer_phone text,
  p_customer_company text,
  p_notes text,
  p_subtotal numeric,
  p_item_count integer,
  p_retail_subtotal numeric,
  p_items jsonb
)
returns uuid
language plpgsql
security definer
as $$
declare
  v_order_id uuid;
  v_item jsonb;
  v_special_order boolean;
begin
  insert into public.orders (
    order_number, customer_name, customer_email, customer_phone,
    customer_company, notes, subtotal, item_count, retail_subtotal
  ) values (
    p_order_number, p_customer_name, p_customer_email, p_customer_phone,
    p_customer_company, p_notes, p_subtotal, p_item_count, p_retail_subtotal
  )
  returning id into v_order_id;

  for v_item in select * from jsonb_array_elements(p_items)
  loop
    v_special_order := coalesce(nullif(v_item->>'special_order','')::boolean, false);

    insert into public.order_items (
      order_id, plant_key, plant_name, plant_size,
      unit_price, qty, line_total,
      retail_mode, retail_price, retail_line_total,
      special_order
    ) values (
      v_order_id,
      v_item->>'plant_key',
      v_item->>'plant_name',
      v_item->>'plant_size',
      (v_item->>'unit_price')::numeric,
      (v_item->>'qty')::integer,
      (v_item->>'line_total')::numeric,
      v_item->>'retail_mode',
      (v_item->>'retail_price')::numeric,
      (v_item->>'retail_line_total')::numeric,
      v_special_order
    );
  end loop;

  return v_order_id;
end;
$$;

grant execute on function public.submit_order to anon;
