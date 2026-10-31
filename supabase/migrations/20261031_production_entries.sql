-- ============================================================
-- Migration: production entries + propagator access codes
-- Applied 2026-10-31 to project ruwyfesblmaurfuiaofw
--
-- Purpose: let nursery propagation staff record production rows
-- directly (liners / 4" / 1 gal / 5 gal) instead of those rows
-- existing only as xlsx exports that get folded into the static
-- CSVs on tfross67.github.io/liveinventory.
--
-- Access model:
--   * propagators: one row per person, holding a SHA-256 of their
--     access code. The plaintext code is never stored.
--   * production_entries: rows entered from the portal.
--   * RLS is ON with NO anon/authenticated policies, so neither
--     role can read or write these tables directly. Everything goes
--     through the `prop-entry` Edge Function, which holds the
--     service role and verifies the code server-side.
--   * `reconciled` marks a row already folded into the weekly CSV
--     refresh; the tracker only renders unreconciled rows.
-- ============================================================

create table if not exists public.propagators (
  id           uuid primary key default gen_random_uuid(),
  name         text not null unique,
  code_hash    text not null,                 -- sha256 hex of the access code
  active       boolean not null default true,
  created_at   timestamptz not null default now(),
  last_seen_at timestamptz
);

comment on table public.propagators is
  'People allowed to enter production data via liveinventory/enter.html. code_hash = sha256(access code).';

create table if not exists public.production_entries (
  id              uuid primary key default gen_random_uuid(),
  propagator_id   uuid references public.propagators(id) on delete set null,
  entered_by      text not null default '',
  tab             text not null check (tab in ('liners','4inch','1gallon','5gallon')),
  plant_name      text not null,
  item_code       text,
  catalog_size    text,                       -- master_items size used for the lookup (4inch/1gal/5gal)
  row_size        text not null default '',    -- exact SIZE string written into the CSV for that tab
  production_date date not null,
  qty             integer not null check (qty > 0 and qty <= 1000000),
  source          text,                       -- cuttings | seed | division | ''
  notes           text,
  reconciled      boolean not null default false,
  created_at      timestamptz not null default now()
);

comment on table public.production_entries is
  'Propagation rows entered from liveinventory/enter.html. Unreconciled rows render on the tracker; reconciled rows live in the CSV.';

create index if not exists idx_production_entries_pending
  on public.production_entries (reconciled, tab, production_date desc);
create index if not exists idx_production_entries_created
  on public.production_entries (created_at desc);

alter table public.propagators        enable row level security;
alter table public.production_entries enable row level security;

-- No policies on purpose: anon and authenticated get nothing.
revoke all on public.propagators        from anon, authenticated;
revoke all on public.production_entries from anon, authenticated;

grant all on public.propagators        to service_role;
grant all on public.production_entries to service_role;

-- Reconciliation helper: mark rows as folded into the CSVs.
create or replace function public.mark_entries_reconciled(p_ids uuid[])
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  n integer;
begin
  update public.production_entries
     set reconciled = true
   where id = any(p_ids) and reconciled = false;
  get diagnostics n = row_count;
  return n;
end;
$$;

revoke all on function public.mark_entries_reconciled(uuid[]) from anon, authenticated;
grant execute on function public.mark_entries_reconciled(uuid[]) to service_role;
