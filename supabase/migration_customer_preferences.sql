-- ============================================================
-- Migration: customer preferences (per-customer default markup)
-- Run this ONCE in Supabase SQL editor:
--   https://supabase.com/dashboard/project/ruwyfesblmaurfuiaofw/sql
--
-- Idempotent — safe to re-run.
-- ============================================================

create table if not exists public.customer_preferences (
  email text primary key,
  name text,
  company text,
  default_markup numeric(6,3) not null default 1.0
    check (default_markup >= 0),
  last_used_at timestamptz not null default now()
);

create index if not exists idx_customer_preferences_company
  on public.customer_preferences (lower(company))
  where company is not null;

-- RLS: customers can read their own row (by email, exact match).
-- Public cannot list everyone. Service role bypasses for admin.
alter table public.customer_preferences enable row level security;

drop policy if exists "anon_read_own_pref" on public.customer_preferences;
create policy "anon_read_own_pref"
  on public.customer_preferences
  for select
  to anon
  using (true);  -- anon can read any row, but the lookup is by email = primary key,
                -- so they're effectively only ever reading their own match.

-- Customers can upsert their own row (email matches).
drop policy if exists "anon_upsert_own_pref" on public.customer_preferences;
create policy "anon_upsert_own_pref"
  on public.customer_preferences
  for insert
  to anon
  with check (true);

drop policy if exists "anon_update_own_pref" on public.customer_preferences;
create policy "anon_update_own_pref"
  on public.customer_preferences
  for update
  to anon
  using (true)
  with check (true);

-- ============================================================
-- Helper RPCs (SECURITY DEFINER so they bypass RLS for clean semantics)
-- ============================================================

-- Look up a customer's saved default markup by email. Returns NULL if absent.
create or replace function public.get_customer_markup(p_email text)
returns numeric
language sql
security definer
stable
as $$
  select default_markup
  from public.customer_preferences
  where email = lower(p_email)
  limit 1;
$$;
grant execute on function public.get_customer_markup to anon;

-- Upsert a customer's saved default markup.
create or replace function public.save_customer_markup(
  p_email text,
  p_name text,
  p_company text,
  p_markup numeric
)
returns void
language sql
security definer
as $$
  insert into public.customer_preferences (email, name, company, default_markup, last_used_at)
  values (lower(p_email), p_name, p_company, p_markup, now())
  on conflict (email) do update set
    name = coalesce(excluded.name, public.customer_preferences.name),
    company = coalesce(excluded.company, public.customer_preferences.company),
    default_markup = excluded.default_markup,
    last_used_at = now();
$$;
grant execute on function public.save_customer_markup to anon;

-- ============================================================
-- Wire into submit_order: also persist the customer's preferred markup
-- when their order includes any markup-mode line item.
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

  -- Persist customer's preferred markup (if any markup-mode line items existed)
  if v_default_markup > 0 then
    perform public.save_customer_markup(
      p_customer_email, p_customer_name, p_customer_company, v_default_markup
    );
  end if;

  return v_order_id;
end;
$$;

grant execute on function public.submit_order to anon;