-- ============================================================
-- Migration: order email delivery log
-- Run this ONCE in Supabase SQL editor:
--   https://supabase.com/dashboard/project/ruwyfesblmaurfuiaofw/sql
--
-- Idempotent — safe to re-run.
-- ============================================================

create table if not exists public.order_email_log (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.orders(id) on delete cascade,
  recipient text not null,
  message_id text,
  kind text not null check (kind in ('office','customer')),
  sent_at timestamptz not null default now()
);
create index if not exists idx_order_email_log_order_id on public.order_email_log(order_id);

alter table public.order_email_log enable row level security;

drop policy if exists "anon_insert_email_log" on public.order_email_log;
create policy "anon_insert_email_log"
  on public.order_email_log
  for insert
  to anon
  with check (true);

-- Service role reads (admin dashboard). Anon can also read to verify their own orders.
drop policy if exists "anon_read_email_log" on public.order_email_log;
create policy "anon_read_email_log"
  on public.order_email_log
  for select
  to anon
  using (true);

-- RPC used by app.js to log a sent email (after AgentMail returns a message_id).
create or replace function public.log_order_email(
  p_order_id uuid,
  p_recipient text,
  p_message_id text,
  p_kind text
)
returns void
language sql
security definer
as $$
  insert into public.order_email_log (order_id, recipient, message_id, kind)
  values (p_order_id, p_recipient, p_message_id, p_kind);
$$;
grant execute on function public.log_order_email to anon;