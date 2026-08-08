-- ============================================================
-- Migration: trade-customer pricing gate
-- Run this ONCE in Supabase SQL editor:
--   https://supabase.com/dashboard/project/ruwyfesblmaurfuiaofw/sql
--
-- Idempotent — safe to re-run.
--
-- Purpose: a public visitor sees the catalog (botanical name, photo,
-- description, type) but no prices. To see prices, they enter their
-- email and receive a 6-digit PIN by email. Anyone whose email is in
-- customer_preferences is a trade customer and gets a PIN. Anyone else
-- gets a friendly "not on our trade list" error.
--
-- After verifying the PIN, the client sets a localStorage flag that
-- unlocks pricing for 90 days. No server session is required.
-- ============================================================

-- PIN attempts log. Stores bcrypt-style hashed PIN (we'll use SHA-256 +
-- server-side pepper for simplicity since this isn't high-value).
create table if not exists public.pricing_pins (
  id uuid primary key default gen_random_uuid(),
  email text not null,
  pin_hash text not null,         -- SHA-256(email + pin + PEPPER)
  expires_at timestamptz not null,
  consumed_at timestamptz,        -- set when the PIN is used successfully
  created_at timestamptz not null default now()
);

create index if not exists idx_pricing_pins_email on public.pricing_pins (lower(email));
create index if not exists idx_pricing_pins_expires on public.pricing_pins (expires_at);

-- RLS: pricing_pins is service-role-only. The anon key has no access.
-- All reads/writes go through SECURITY DEFINER RPCs below.
alter table public.pricing_pins enable row level security;

-- No anon policies — anon can neither read nor write this table directly.

-- ============================================================
-- Helper RPC: request_pricing_pin(email)
-- Returns { ok: true } if the email is on the trade list and a PIN was
-- generated (and emailed by the calling Edge Function). Returns
-- { ok: false, reason: 'not_trade_customer' } if the email is unknown.
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
  -- Look up the trade customer
  select exists (
    select 1 from public.customer_preferences where email = v_email
  ) into v_is_trade;

  if not v_is_trade then
    return query select false, 'not_trade_customer'::text, null::text;
    return;
  end if;

  -- Generate 6-digit PIN. Range 100000..999999 (always 6 digits).
  v_pin := (100000 + floor(random() * 900000))::int::text;
  -- Hash with email + pepper (the pepper is a Supabase secret set via
  -- `supabase secrets set PRICING_PIN_PEPPER=...`). If the pepper isn't
  -- configured, we still hash but log a warning (the Edge Function
  -- will catch this and surface it).
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

-- ============================================================
-- Helper RPC: verify_pricing_pin(email, pin)
-- Returns { ok: true } if PIN matches an unconsumed, unexpired row.
-- Returns { ok: false, reason: ... } otherwise.
-- ============================================================
create or replace function public.verify_pricing_pin(p_email text, p_pin text)
returns table(ok boolean, reason text)
language plpgsql
security definer
as $$
declare
  v_email text := lower(trim(p_email));
  v_pin text := trim(p_pin);
  v_pin_hash text;
  v_pepper text := current_setting('app.pricing_pin_pepper', true);
  v_match_id uuid;
begin
  -- Validate PIN format
  if v_pin !~ '^\d{6}$' then
    return query select false, 'invalid_format'::text;
    return;
  end if;

  v_pin_hash := encode(
    digest(v_email || ':' || v_pin || ':' || coalesce(v_pepper, ''), 'sha256'),
    'hex'
  );

  -- Find a matching, unconsumed, unexpired PIN
  select id into v_match_id
    from public.pricing_pins
    where lower(email) = v_email
      and pin_hash = v_pin_hash
      and consumed_at is null
      and expires_at > now()
    order by created_at desc
    limit 1;

  if v_match_id is null then
    return query select false, 'invalid_or_expired'::text;
    return;
  end if;

  -- Mark as consumed
  update public.pricing_pins set consumed_at = now() where id = v_match_id;

  return query select true, 'verified'::text;
end;
$$;
grant execute on function public.verify_pricing_pin to anon;

-- ============================================================
-- Add yourself to the trade customer list (for testing)
-- Replace 'tfross@nativeson.com' with whatever email you want to test.
-- ============================================================
insert into public.customer_preferences (email, name, company, default_markup)
  values ('tfross@nativeson.com', 'Tim Fross', 'Native Sons', 1.0)
  on conflict (email) do nothing;