-- ============================================================
-- Reorder feature: get_reorder_items(...)
-- Anonymous RPC: returns order_items for a known order_number +
-- matching customer_email (case-insensitive). SECURITY DEFINER so the
-- anon role can read order_items without a SELECT policy that would
-- let anyone enumerate them.
--
-- Run with the Supabase Management API:
--   POST /v1/projects/{ref}/database/query
--   Authorization: Bearer $(cat ~/.supabase/access-token)
-- ============================================================

create or replace function public.get_reorder_items(
  p_order_number text,
  p_email text
)
returns table (
  plant_name text,
  plant_size text,
  unit_price numeric,
  qty integer
)
language plpgsql
security definer
set search_path = public
as $$
begin
  return query
    select oi.plant_name,
           oi.plant_size,
           oi.unit_price,
           oi.qty
    from public.order_items oi
    join public.orders o on o.id = oi.order_id
    where o.order_number = p_order_number
      and lower(o.customer_email) = lower(p_email)
    order by oi.id;
end;
$$;

revoke all on function public.get_reorder_items(text, text) from public;
grant execute on function public.get_reorder_items(text, text) to anon;

-- Documentation comment for the schema explorer.
comment on function public.get_reorder_items(text, text) is
  'Returns the line items for an order when the caller provides both the
   order number and the matching customer email. Read-only — useful for
   the customer-side Reorder button on confirmation.html and the deep
   link availability.html?reorder=<n>&e=<email>. Returns 0 rows if no
   match, so the client treats both "wrong order number" and "email
   mismatch" as a unified "nothing found, type in your order number"
   experience.';
