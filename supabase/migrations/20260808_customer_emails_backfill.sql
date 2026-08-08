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

-- Step 1: dedupe (one row per customer per email, lowercase, trimmed)
WITH src AS (
  SELECT
    c.id AS customer_id,
    lower(trim(token)) AS email,
    row_number() OVER (PARTITION BY c.id ORDER BY token) AS rn
  FROM public.customers c,
  regexp_split_to_table(coalesce(c.email, ''), '[;,[:space:]]+') AS token
  WHERE c.email IS NOT NULL
    AND length(trim(c.email)) > 0
    AND length(trim(token)) > 0
),
dedup AS (
  SELECT customer_id, email, MIN(rn) AS rn
  FROM src
  GROUP BY customer_id, email
)
-- Step 2: insert, mark is_primary=true only for the first email per customer
INSERT INTO public.customer_emails (customer_id, email, is_primary)
SELECT
  customer_id,
  email,
  (rn = 1) AS is_primary
FROM dedup
-- Step 3: drop rows where this email is already claimed by ANOTHER customer
-- (keep the existing owner; new claim is skipped)
ON CONFLICT (lower(email)) DO NOTHING;

-- Summary
SELECT
  count(*) AS total_customer_emails,
  count(*) FILTER (WHERE is_primary) AS primary_emails,
  count(DISTINCT customer_id) AS customers_with_emails
FROM public.customer_emails;
