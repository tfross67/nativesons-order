-- ============================================================
-- Migration: customer_emails schema + RPCs
-- Run this FIRST in Supabase SQL editor:
--   https://supabase.com/dashboard/project/ruwyfesblmaurfuiaofw/sql
--
-- Idempotent — safe to re-run.
--
-- Purpose: customers often have multiple email addresses on file
-- (e.g. "purchasing@x.com; owner@y.com"). The loader stored them
-- as a single delimited string in customers.email, which made
-- exact-match lookups fragile (only the literal full string ever
-- matched). Normalize: one row per email, with a flag for the
-- primary contact.
--
-- The trade-pricing gate (request_pricing_pin) consults this
-- table instead of customer_preferences. customer_preferences is
-- left in place for future opt-out / per-customer settings.
--
-- USAGE:
--   1. Run this file (creates schema + RPCs)
--   2. Run python3 load_customers_to_supabase.py (imports customers)
--   3. Run 20260808_customer_emails_backfill.sql (populates customer_emails)
-- ============================================================

create table if not exists public.customer_emails (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid not null references public.customers(id) on delete cascade,
  email text not null,
  is_primary boolean not null default false,
  created_at timestamptz not null default now()
);

create unique index if not exists idx_customer_emails_email_unique on public.customer_emails (lower(email));
create index if not exists idx_customer_emails_customer on public.customer_emails (customer_id);
create index if not exists idx_customer_emails_email_lower on public.customer_emails (lower(email));

alter table public.customer_emails enable row level security;
-- No anon policies — only the service role (via RPCs / Edge Functions)
-- reads or writes this table. The anon key can't enumerate trade
-- customers via this table.

-- ============================================================
-- Helper RPC: lookup_customer_by_email(email)
-- Returns the customer record (name, customer_code) if the email
-- belongs to a known customer. Used by the pricing PIN email so
-- the message can say "Hi {company} team" instead of a generic.
-- Returns 0 rows if the email is unknown.
-- ============================================================
create or replace function public.lookup_customer_by_email(p_email text)
returns table(id uuid, name text, customer_code text)
language sql
security definer
stable
as $$
  select c.id, c.name, c.customer_code
    from public.customer_emails ce
    join public.customers c on c.id = ce.customer_id
    where lower(ce.email) = lower(trim(p_email))
    order by ce.is_primary desc
    limit 1;
$$;
grant execute on function public.lookup_customer_by_email to anon;

-- ============================================================
-- Update trade-pricing gate to consult customer_emails.
-- Behavior is unchanged from the customer's perspective: they
-- enter an email, get a PIN if it's on file. But the lookup is
-- now case-insensitive on a normalized index.
-- ============================================================
create or replace function public.request_pricing_pin(p_email text)
returns table(ok boolean, reason text, pin text)
language plpgsql
security definer
as $$
declare
  v_email text := lower(trim(p_email));
  v_pin text;
  v_pin_hash text;
  v_pepper text := current_setting('app.pricing_pin_pepper', true);
  v_expires timestamptz := now() + interval '15 minutes';
  v_is_trade boolean;
begin
  -- Look up the trade customer in the normalized email table
  select exists (
    select 1 from public.customer_emails where lower(email) = v_email
  ) into v_is_trade;

  if not v_is_trade then
    return query select false, 'not_trade_customer'::text, null::text;
    return;
  end if;

  -- Generate 6-digit PIN. Range 100000..999999 (always 6 digits).
  v_pin := (100000 + floor(random() * 900000))::int::text;
  v_pin_hash := encode(
    digest(v_email || ':' || v_pin || ':' || coalesce(v_pepper, ''), 'sha256'),
    'hex'
  );

  -- Invalidate any prior unconsumed PINs for this email
  update public.pricing_pins
    set consumed_at = now()
    where lower(email) = v_email and consumed_at is null;

  insert into public.pricing_pins (email, pin_hash, expires_at)
    values (v_email, v_pin_hash, v_expires);

  return query select true, 'sent'::text, v_pin;
end;
$$;
grant execute on function public.request_pricing_pin to anon;
