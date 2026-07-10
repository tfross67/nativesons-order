-- Master customer table.
-- Populated from customers2026.xlsx via load_customers.py.
-- Used by the order-entry autocomplete dropdown in the customer portal.

create table if not exists public.customers (
  id uuid primary key default gen_random_uuid(),
  customer_code text unique,
  name text not null,
  contact_name text,
  address text,
  city text,
  state text,
  zip text,
  email text,
  phone text,
  -- Text form e.g. 'None', '10%', 'STD' — preserved as-is from the source
  discount text,
  -- Numeric form of the same — null when not numeric
  default_markup_pct numeric(6,3),
  resale_no text,
  routing text,
  sales_person text,
  sales_tax_pct numeric(6,4),
  terms text,
  type text,
  website text,
  ship_to_name text,
  ship_to_address text,
  ship_to_city text,
  ship_to_state text,
  ship_to_zip text,
  ship_via text,
  shipping_charge numeric(10,2),
  comment text,
  search_text text,
  -- Defaults for new orders. Surfaced in the portal when this customer is picked.
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Search columns
create index if not exists idx_customers_search_text on public.customers using gin (to_tsvector('english', search_text));
create index if not exists idx_customers_email on public.customers(email) where email is not null;
create index if not exists idx_customers_phone on public.customers(phone) where phone is not null;
create index if not exists idx_customers_name on public.customers using gin (to_tsvector('english', name));
create index if not exists idx_customers_customer_code on public.customers(customer_code) where customer_code is not null;
create index if not exists idx_customers_active on public.customers(active) where active;

-- RLS: customer data is office-side only. The portal reads from this table only when
-- populating the autocomplete dropdown (allowed via anon key + read-only policy).
alter table public.customers enable row level security;

-- Read access for the customer portal (it has the anon key)
create policy "customers_read_for_portal"
  on public.customers
  for select
  to anon, authenticated
  using (active = true);

-- Writes only via service role (from load_customers.py / Edge Function)
-- (No policy means anon/authenticated roles can't INSERT/UPDATE/DELETE.)
