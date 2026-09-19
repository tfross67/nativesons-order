-- search_analytics table
-- Logs every search query from availability.html so we can build a
-- "what are customers searching for" dashboard. Captures both the raw
-- query and the structured filter breakdown so we can answer:
--
--   1. What's the success rate? (% of searches that returned >= 1 plant)
--   2. What queries fail? (queries with resultCount = 0)
--   3. What plant names are customers looking for?
--   4. Which filter dimensions drive most queries?
--   5. Is Jev's classification matching reality?
--
-- One row per parseQuery() call. Sampled at 100% initially; if volume
-- gets high we can add sampling later. No PII — just the raw query
-- string, which customers already typed into a public form.

create table if not exists public.search_analytics (
  id            bigserial primary key,
  ts            timestamptz not null default now(),
  query         text not null,
  query_length  int generated always as (length(query)) stored,
  result_count  int not null,
  filters_used  jsonb,            -- which filter chips were active (colors, types, etc.)
  free_text     text[],           -- tokens after stripping structured filters
  is_plant_name boolean,          -- Jev's is_plant_name answer (NULL = Jev disabled or failed)
  parse_ms      int,              -- how long parseQuery took end-to-end
  jev_ms        int,              -- how long the Jev call took (NULL = fallback only)
  jev_used      boolean not null default false,  -- whether Jev was actually called
  source        text not null default 'availability.html'
);

create index if not exists search_analytics_ts_idx on public.search_analytics (ts desc);
create index if not exists search_analytics_result_count_idx on public.search_analytics (result_count);
create index if not exists search_analytics_is_plant_name_idx on public.search_analytics (is_plant_name) where is_plant_name is not null;

-- A view that pre-aggregates the daily stats so the dashboard query
-- is fast even when the raw table grows large.
create or replace view public.search_analytics_daily as
select
  date_trunc('day', ts)::date as day,
  count(*)                     as searches,
  count(*) filter (where result_count > 0)       as searches_with_results,
  count(*) filter (where result_count = 0)       as no_result_searches,
  count(*) filter (where jev_used)               as jev_searches,
  count(*) filter (where is_plant_name)          as plant_name_searches,
  avg(result_count)::numeric(10,2)               as avg_result_count,
  avg(parse_ms)::numeric(10,2)                   as avg_parse_ms,
  avg(jev_ms)::numeric(10,2)                     as avg_jev_ms,
  count(distinct query)                          as unique_queries
from public.search_analytics
group by 1;

-- Top queries view — what are people searching for?
create or replace view public.search_analytics_top_queries as
select
  query,
  count(*)              as search_count,
  avg(result_count)::numeric(10,2)  as avg_results,
  max(ts)               as last_seen
from public.search_analytics
where length(query) > 0
group by query
order by search_count desc
limit 100;

-- Top no-result queries — what's failing?
create or replace view public.search_analytics_failed_queries as
select
  query,
  count(*)              as failure_count,
  max(ts)               as last_seen
from public.search_analytics
where result_count = 0 and length(query) > 0
group by query
order by failure_count desc
limit 50;

-- RLS: allow public insert (anon), deny direct select (only Edge Function reads)
alter table public.search_analytics enable row level security;

create policy "anon can insert search_analytics"
  on public.search_analytics
  for insert
  to anon
  with check (true);

-- No select policy for anon — reads go through an Edge Function with service role
