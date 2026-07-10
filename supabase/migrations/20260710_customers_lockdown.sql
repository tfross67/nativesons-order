-- Lock down customers table: remove public read policy.
-- The customer-facing portal should NOT have access to this table — it
-- contains emails, phones, addresses, sales-tax rates, terms, routing
-- lanes, sales rep info — all office-side metadata.
--
-- Reads via service role (used by admin.html) still work; only anon/authenticated
-- roles are denied.

drop policy if exists "customers_read_for_portal" on public.customers;

-- RLS stays enabled (default-deny for non-service-role requests).
-- Writes only via service role from load_customers.py.

-- Sanity: confirm no anon read works
-- select * from customers limit 1;  -- should now error with 401/403
