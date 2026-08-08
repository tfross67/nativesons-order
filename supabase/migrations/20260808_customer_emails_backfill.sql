-- ============================================================
-- Migration: customer_emails backfill (run AFTER schema migration
-- and after load_customers_to_supabase.py has imported customers)
--
-- Run this in Supabase SQL editor:
--   https://supabase.com/dashboard/project/ruwyfesblmaurfuiaofw/sql
--
-- Idempotent — uses ON CONFLICT. Re-run any time after re-importing
-- customers to pick up new emails.
--
-- Splits each customer's email field on ; , or whitespace, then
-- inserts one row per email into customer_emails. The FIRST parsed
-- email per customer is flagged is_primary=true (the rest are
-- secondary contacts).
-- ============================================================

insert into public.customer_emails (customer_id, email, is_primary)
select
  c.id,
  lower(trim(token)) as email,
  (row_number() over (partition by c.id order by ordinality)) = 1 as is_primary
from public.customers c,
lateral (
  select token, ordinality
  from unnest(regexp_split_to_array(coalesce(c.email, ''), '[;,[:space:]]+')) as token
  where length(trim(token)) > 0
) tokens
where c.email is not null and length(trim(c.email)) > 0
on conflict (lower(email)) do update
  set is_primary = excluded.is_primary or customer_emails.is_primary;

-- Summary
select
  count(*) as total_customer_emails,
  count(*) filter (where is_primary) as primary_emails,
  count(distinct customer_id) as customers_with_emails
from public.customer_emails;
