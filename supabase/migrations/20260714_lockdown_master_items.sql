-- ============================================================
-- Migration: lockdown master_items (RLS not enabled)
-- Run ONCE in Supabase SQL editor:
--   https://supabase.com/dashboard/project/ruwyfesblmaurfuiaofw/sql
--
-- Background:
--   Supabase security alert flagged master_items as publicly
--   accessible because RLS was never enabled on it. Anyone with
--   the project URL could read, edit, and delete all 9,580 rows.
--
-- Fix:
--   1. Enable RLS on master_items
--   2. Allow anon SELECT (the read-only office catalog is meant to
--      be browsable, matching how the public portal reads it for
--      size/price lookups via the match_item_code() RPC)
--   3. Block all writes from anon/authenticated roles — only the
--      service_role (used by load_master_items.py and the Edge
--      Functions) can INSERT/UPDATE/DELETE.
--   4. Recreate match_item_code() as SECURITY DEFINER so it
--      continues to read master_items regardless of RLS, even when
--      invoked by an anon caller.
-- ============================================================

alter table public.master_items enable row level security;

-- Read-only for anon + authenticated. The catalog is intentional
-- public read so the portal can show prices. Writes are reserved
-- for service role (load scripts, edge functions).
drop policy if exists "anon_read_master_items" on public.master_items;
create policy "anon_read_master_items"
  on public.master_items
  for select
  to anon, authenticated
  using (true);

-- No insert/update/delete policies for anon or authenticated roles
-- means those roles cannot write. Only service_role (which bypasses
-- RLS) can modify the catalog.

-- ============================================================
-- match_item_code: re-create as SECURITY DEFINER so anon callers
-- can still resolve item_code/upc lookups even with RLS now on.
-- ============================================================
create or replace function public.match_item_code(
  p_plant_name text,
  p_size text
)
returns table(item_code text, upc text, description text)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_norm_size text;
  v_pn text;
  v_cultivar text;
  v_genus text;
begin
  v_norm_size := lower(regexp_replace(p_size, '\s+', '', 'g'));
  v_norm_size := regexp_replace(v_norm_size, '(\d+)"$', '\1inch');
  v_norm_size := regexp_replace(v_norm_size, '(\d+)g$', '\1gal');

  v_pn := lower(p_plant_name);
  v_pn := replace(v_pn, '''', '''');
  v_pn := replace(v_pn, '''', '''');
  v_pn := regexp_replace(v_pn, '\s+n\s*$', '');
  v_pn := regexp_replace(v_pn, '\s+', ' ', 'g');

  v_cultivar := substring(v_pn from '''([^'']+)''');
  if v_cultivar is null then
    v_cultivar := substring(v_pn from ''''([^'']+)''');
  end if;
  v_cultivar := lower(v_cultivar);

  v_genus := split_part(v_pn, ' ', 1);

  return query
    select mi.item_code, mi.upc, mi.description
    from public.master_items mi
    where mi.size = v_norm_size
      and (
        lower(mi.description) = v_pn
        or lower(regexp_replace(mi.description, '\s*\([^)]*\)\s*$', '')) = v_pn
        or lower(regexp_replace(regexp_replace(mi.description, '\bgrand\.\b', 'grandiflora'), '\s*\([^)]*\)\s*$', '')) = v_pn
      )
    limit 1;

  if found then return; end if;

  if v_cultivar is not null then
    return query
      select mi.item_code, mi.upc, mi.description
      from public.master_items mi
      where mi.size = v_norm_size
        and lower(mi.description) like '%' || v_cultivar || '%'
        and split_part(lower(mi.description), ' ', 1) = v_genus
      order by
        case when lower(mi.description) like '%''' || v_cultivar || '''%' then 0 else 1 end
      limit 1;
  end if;
end;
$$;

grant execute on function public.match_item_code to anon;
grant execute on function public.match_item_code to service_role;

-- ============================================================
-- Belt-and-suspenders: also tighten customer_preferences SELECT
-- to only return rows matching the requesting email. Currently it
-- allows SELECT * on the entire table.
--
-- In practice the app only ever looks up by email (the primary key)
-- so this is mostly defensive. Note this DOES require dropping the
-- existing "anon_read_own_pref" policy first if you want a stricter
-- one keyed off auth.email() — but auth.email() is null for anon
-- callers, so the simpler fix is to keep SELECT-by-PK access and
-- trust that the JS layer only ever queries by email.
-- ============================================================
-- (Skipping for now — primary-key access by email is enough.
--  Re-evaluate after the customer portal's auth model is finalized.)

-- ============================================================
-- Verify the lockdown by listing tables and their RLS state.
-- ============================================================
select schemaname, tablename, rowsecurity
  from pg_tables
 where schemaname = 'public'
 order by tablename;
