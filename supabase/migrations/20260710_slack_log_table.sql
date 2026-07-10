-- Audit log for orders posted to Slack via the send-order-slack Edge Function.
-- Each row records one POST to Slack so the office can see what got sent.

create table if not exists public.slack_log (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.orders(id) on delete cascade,
  order_number text not null,
  ok boolean not null,
  error_message text,
  sent_at timestamptz not null default now()
);

create index if not exists idx_slack_log_order_id on public.slack_log(order_id);
create index if not exists idx_slack_log_sent_at on public.slack_log(sent_at desc);

-- Enable RLS but leave it off-by-default (write-only from Edge Function via service role).
alter table public.slack_log enable row level security;

-- No policies: reads/writes only via service role (admin.html already uses service role).
