-- Master item catalog table. Loaded from masteritem_.xlsx (9,580 rows).
-- Columns mirror the JS MASTER_ITEM_FULL shape so item_code+upc can be looked up
-- from any browser/edge function via the match_item_code() function below.
create table if not exists public.master_items (
  item_code   text not null,
  size        text not null,
  description text not null,
  price       numeric,
  upc         text,
  primary key (item_code, size)
);
create index if not exists idx_master_items_desc on public.master_items (lower(description));
create index if not exists idx_master_items_size on public.master_items (size);

-- The match_item_code function takes a plant name (with cultivar) and size,
-- then finds the canonical item_code+upc from the master catalog.
-- Handles name variants:
--   "Abelia x grandiflora 'Kaleidoscope'" <-> "Abelia x grand. 'Kaleidoscope' (PP16,988)"
--   "Calamagrostis nutkae. x fol. 'Little Nootka'" <-> "Calamagrostis nutkaensis x foliosa 'Little Nootka'"
--   "(Patented)", "(PP*)" suffixes are stripped before matching
create or replace function public.match_item_code(
  p_plant_name text,
  p_size text
)
returns table(item_code text, upc text, description text)
language plpgsql
stable
as $$
declare
  v_norm_size text;
  v_pn text;
  v_cultivar text;
  v_genus text;
begin
  -- Normalize size: '4"' -> '4inch', '1g' -> '1gal', '50 plug' -> '50plug'
  v_norm_size := lower(regexp_replace(p_size, '\s+', '', 'g'));
  v_norm_size := regexp_replace(v_norm_size, '(\d+)"$', '\1inch');
  v_norm_size := regexp_replace(v_norm_size, '(\d+)g$', '\1gal');

  -- Normalize plant name: strip trailing 'N', normalize quotes, collapse spaces
  v_pn := lower(p_plant_name);
  v_pn := replace(v_pn, '‘', '''');
  v_pn := replace(v_pn, '’', '''');
  v_pn := regexp_replace(v_pn, '\s+n\s*$', '');
  v_pn := regexp_replace(v_pn, '\s+', ' ', 'g');

  -- Extract cultivar from quoted text
  v_cultivar := substring(v_pn from '''([^'']+)''');
  if v_cultivar is null then
    v_cultivar := substring(v_pn from '[‘’]([^‘’]+)[‘’]');
  end if;
  v_cultivar := lower(v_cultivar);

  v_genus := split_part(v_pn, ' ', 1);

  -- Pass 1: full name matches after expansion (handle 'grand.' <-> 'grandiflora')
  return query
    select mi.item_code, mi.upc, mi.description
    from public.master_items mi
    where mi.size = v_norm_size
      and (
        lower(mi.description) = v_pn
        or lower(regexp_replace(mi.description, '\s*\([^)]*\)\s*$', '')) = v_pn
        or lower(regexp_replace(regexp_replace(mi.description, 'grand\.', 'grandiflora'), '\s*\([^)]*\)\s*$', '')) = v_pn
      )
    limit 1;

  if found then return; end if;

  -- Pass 2: cultivar match — find any row matching this genus+size where cultivar is in description
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
