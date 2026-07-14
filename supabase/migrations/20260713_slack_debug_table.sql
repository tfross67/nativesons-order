-- DEBUG: capture exact items payload sent to send-order-slack Edge Function.
-- Used to diagnose "no retail in Slack" reports. Each row stores the items
-- that came in to the function so we can verify the client is sending the
-- right data. Read-only access via service_role (admin.html already uses it).

create table if not exists public.slack_debug (
  id uuid primary key default gen_random_uuid(),
  order_number text not null,
  customer_name text,
  items jsonb not null,
  internal_order boolean default false,
  show_retail boolean default true,
  has_any_markup boolean default false,
  total_wholesale numeric(10,2),
  total_retail numeric(10,2),
  created_at timestamptz not null default now()
);

create index if not exists idx_slack_debug_order_number on public.slack_debug(order_number);
create index if not exists idx_slack_debug_created_at on public.slack_debug(created_at desc);

-- Enable RLS but leave it off-by-default (write-only from Edge Function via service role).
alter table public.slack_debug enable row level security;

-- No policies: reads/writes only via service role.
