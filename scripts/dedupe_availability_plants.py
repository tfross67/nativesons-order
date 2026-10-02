#!/usr/bin/env python3
"""Merge duplicate plants in availability_data.js — the same plant listed twice
under mismatched names between the weekly xlsx's sheets.

Why this exists
---------------
Irene's workbook carries the same plant twice with different names:

  1g sheet:  "Achillea 'Terra Cotta'"              (genus + cultivar, no species)
  4" sheet:  "Achillea millefolium 'Terra Cotta'"  (full name, from sticky genus)

  1g sheet:  "Armeria 'Dreameria Daydream'"
  4" sheet:  "Armeria pseud. 'Dreameria™ Daydream'"

regen_availability.py keys its merge on the normalized full name, so these land
as two records with different keys. The customer-facing table then shows two
rows for one plant. This happened for Achillea on 2026-09-25 (fixed by hand in
commit e1ad853, which filed this as the long-term fix) and again for 2026-10-05.

Merge rule (deliberately narrow — never manufacture a match)
------------------------------------------------------------
Two records merge only when ALL hold:
  * same leading genus token (normalized), and
  * same cultivar (the last quoted segment, normalized, non-empty), and
  * one name's tokens are a prefix-subsequence of the other's — so
    "Achillea" + "Terra Cotta" merges with "Achillea millefolium" + "Terra Cotta",
    but "Salvia greggii 'Pink'" is NOT merged with "Salvia leucantha 'Pink'".

The more-qualified (longer) name wins; sizes are unioned by container (existing
container wins, so the 1g sheet's price is authoritative); flags are OR-ed;
non-empty enrichment fields are taken from whichever record has them.

Usage: python3 scripts/dedupe_availability_plants.py [path/to/availability_data.js]
"""
from __future__ import annotations
import json
import re
import sys
import unicodedata
from pathlib import Path

ROOT = Path(__file__).parent.parent
DEFAULT = ROOT / 'availability_data.js'

RE_QUOTED = re.compile(r"['\u2018\u2019\u201c\u201d]([^'\u2018\u2019\u201c\u201d]+)['\u2018\u2019\u201c\u201d]")
META_FIELDS = ('common', 'origin', 'height', 'width', 'hardiness', 'exposure',
               'flower_color', 'flower_time', 'foliage', 'water', 'soil',
               'special_uses', 'plant_type', 'description', 'nativeson_url', 'notes')


def nk(s) -> str:
    s = unicodedata.normalize('NFKC', str(s)).lower()
    for a, b in (('\u00ae', ''), ('\u2122', ''), ('\u00a9', ''),
                 ('\u2018', "'"), ('\u2019', "'"), ('\u201c', '"'), ('\u201d', '"'), ('\u00d7', ' x ')):
        s = s.replace(a, b)
    return re.sub(r'\s+', ' ', s).strip()


def merge_key(botanical: str):
    """(genus, cultivar) for duplicate detection, or None when there's no cultivar."""
    text = str(botanical)
    quoted = RE_QUOTED.findall(text)
    if not quoted:
        return None
    cultivar = nk(quoted[-1])
    if not cultivar:
        return None
    genus = nk(text.split()[0]) if text.split() else ''
    if not genus:
        return None
    return (genus, cultivar)


def tokens(botanical: str):
    """Name tokens with quotes/punct stripped, for the prefix-compatibility test."""
    s = RE_QUOTED.sub(' ', str(botanical))
    return [t for t in re.split(r'[\s.]+', nk(s)) if t and t != 'x']


def compatible(a: str, b: str) -> bool:
    """True when one name's tokens are a prefix of the other's — same plant, abbreviated."""
    ta, tb = tokens(a), tokens(b)
    if not ta or not tb:
        return False
    short, long_ = (ta, tb) if len(ta) <= len(tb) else (tb, ta)
    return long_[:len(short)] == short


def merge_pair(keep: dict, drop: dict) -> dict:
    merged = dict(keep)
    existing_containers = {s['container'] for s in merged.get('sizes') or []}
    sizes = list(merged.get('sizes') or [])
    for s in drop.get('sizes') or []:
        if s['container'] not in existing_containers:
            sizes.append(s)
            existing_containers.add(s['container'])
    merged['sizes'] = sizes
    for flag in ('bloom', 'bud', 'new'):
        if drop.get(flag):
            merged[flag] = True
    for f in META_FIELDS:
        if not merged.get(f) and drop.get(f):
            merged[f] = drop[f]
    if not merged.get('section') and drop.get('section'):
        merged['section'] = drop['section']
    return merged


def dedupe(plants: list):
    by_key, merged_count, detail = {}, 0, []
    for p in plants:
        k = merge_key(p.get('botanical', ''))
        if not k or k not in by_key:
            if k:
                by_key[k] = p
            else:
                by_key[(id(p),)] = p          # no cultivar → never a merge candidate
            continue
        other = by_key[k]
        if not compatible(other['botanical'], p['botanical']):
            by_key[(k, id(p))] = p            # different plant, same genus+cultivar text
            continue
        keep, drop = (other, p) if len(tokens(other['botanical'])) >= len(tokens(p['botanical'])) else (p, other)
        by_key[k] = merge_pair(keep, drop)
        merged_count += 1
        detail.append(f"{drop['botanical']!r} → {keep['botanical']!r}")
    out, seen = [], set()
    for v in by_key.values():
        if id(v) in seen:
            continue
        seen.add(id(v))
        out.append(v)
    out.sort(key=lambda p: p['botanical'].lower())
    return out, merged_count, detail


def main(path: Path):
    raw = path.read_text(encoding='utf-8')
    m = re.search(r'window\.AVAILABILITY = (\{.*\});\s*$', raw, re.S)
    if not m:
        print('ERROR: could not locate window.AVAILABILITY block', file=sys.stderr)
        sys.exit(1)
    data = json.loads(m.group(1))
    plants = data['plants']
    before = len(plants)
    plants, merged_count, detail = dedupe(plants)
    data['plants'] = plants

    if merged_count:
        js = (
            '/* Native Sons Weekly Availability - generated */\n'
            '/*global window */\n'
            'window.AVAILABILITY = {\n'
            f'  "week": {json.dumps(data["week"], ensure_ascii=False)},\n'
            f'  "generated": {json.dumps(data["generated"])},\n'
            f'  "source": {json.dumps(data.get("source", "Native Sons Wholesale Nursery weekly availability list"), ensure_ascii=False)},\n'
            f'  "contact": {json.dumps(data.get("contact", {"email": "orders@nativeson.com", "phone": "805.481.5996"}), ensure_ascii=False)},\n'
            f'  "plants": {json.dumps(plants, indent=2, ensure_ascii=False)}\n'
            '};'
        )
        path.write_text(js, encoding='utf-8')
    print(f'✓ dedupe: {before} → {len(plants)} plants ({merged_count} merged)')
    for d in detail:
        print(f'    {d}')


if __name__ == '__main__':
    main(Path(sys.argv[1]) if len(sys.argv) > 1 else DEFAULT)
