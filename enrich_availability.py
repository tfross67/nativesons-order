#!/usr/bin/env python3
"""Enrich availability_data.js with metadata from plantdatabase.xlsx.

Reads the weekly availability parsed (already-dict-form) and the master
plant database for common name, origin, height, width, flower_color,
exposure, plant_type, water, soil, hardiness, special_uses, additional_info.

Usage:
  python3 enrich_availability.py [--fresh]

Reads from /tmp/merged_*.json (output of weekly parse step). If --fresh
is passed, parses xlsx and rebuilds. Otherwise enriches an existing
availability_data.js.

Match logic uses several variants of each botanical name:
  1. Normalized: lowercase, curly quotes → straight
  2. Strip parentheses content: "Phyla nodiflora (white)" → "phyla nodiflora"
  3. Strip quotes on cultivar
  4. Drop species epithet: "Thymus doerfleri 'Doone Valley'" → "thymus 'doone valley'"
"""
import json, re, os, sys, argparse
from pathlib import Path

import openpyxl

ROOT = Path(__file__).parent
MASTER_DB = Path('/Users/tfross/.hermes/cache/documents/doc_d5065ec9337c_plantdataexport.xlsx')
AVAIL = ROOT / 'availability_data.js'


def variants(name):
    """Generate plausible key variants for matching."""
    if not name: return []
    s = str(name).strip()
    out = []
    # Normalized
    norm = s.lower().replace('\u2018', "'").replace('\u2019', "'")
    out.append(norm)
    # Strip parens content
    out.append(re.sub(r'\s*\([^)]*\)\s*', '', norm))
    # Strip quotes on cultivar
    out.append(re.sub(r"[\u2018\u2019\']", '', norm))
    # Drop species epithet
    m = re.match(r"^([A-Z][a-z]+)\s+[a-z\.]+(?:\s+x\s+[a-z]+)?\s+(.*)$", s)
    if m:
        out.append(f"{m.group(1).lower()} {m.group(2).lower()}")
    # Drop cultivar (keep binominal)
    m2 = re.match(r"^([A-Z][a-z]+\s+[a-z\.]+(?:\s+x\s+[a-z]+))\s+[\'\u2018\u2019]([^\'\u2018\u2019]+)[\'\u2018\u2019]$", s)
    if m2:
        out.append(m2.group(1).lower())
    return list(set(out))


def load_master():
    """Load master plant database to lookup keyed by normalized name."""
    if not MASTER_DB.exists():
        sys.exit(f'Missing {MASTER_DB}')
    wb = openpyxl.load_workbook(MASTER_DB, data_only=True)
    ws = wb.active
    lookup = {}
    for row_idx in range(2, ws.max_row + 1):
        row = [ws.cell(row_idx, c).value for c in range(1, ws.max_column + 1)]
        if not row[2]: continue
        record = {
            'botanical':        str(row[2]).strip()  if row[2]  else None,
            'common':           str(row[3]).strip()  if row[3]  else None,
            'origin':           str(row[4]).strip()  if row[4]  else None,
            'plant_type':       str(row[5]).strip()  if row[5]  else None,
            'exposure':         str(row[6]).strip()  if row[6]  else None,
            'flower_color':     str(row[7]).strip()  if row[7]  else None,
            'flower_time':      str(row[8]).strip()  if row[8]  else None,
            'height':           str(row[9]).strip()  if row[9]  else None,
            'width':            str(row[10]).strip() if row[10] else None,
            'foliage':          str(row[11]).strip() if row[11] else None,
            'water':            str(row[12]).strip() if row[12] else None,
            # Hardiness is an integer (zone number like 0, 15, 25). 0 is a
            # real value (hardy to 0F), so check for None specifically.
            'hardiness':        row[13]               if row[13] is not None else None,
            'soil':             str(row[14]).strip() if row[14] else None,
            'special_uses':     str(row[15]).strip() if row[15] else None,
            'additional_info':  str(row[16]).strip() if row[16] else None,
        }
        for v in variants(row[2]):
            lookup.setdefault(v, record)
        # Synonyms declared inside Additional Information, e.g.
        # "Synonyms: Isomeris arborea, Peritoma arborea. Large, showy …"
        # Registered so a plant the master has RENAMED still matches its record
        # (and can be renamed on the portal, see propagate()).
        m = re.search(r'Synonyms?:\s*([^.]*)', record['additional_info'] or '', re.I)
        if m:
            for syn in re.split(r',|\band\b', m.group(1)):
                syn = syn.strip()
                if not syn: continue
                record.setdefault('synonyms', []).append(syn)
                for v in variants(syn):
                    lookup.setdefault(v, record)
    print(f'Loaded {len(lookup)} unique master records')
    return lookup


def enrich(plants, master):
    metadata_fields = [
        'common', 'origin', 'plant_type', 'exposure', 'flower_color', 'flower_time',
        'height', 'width', 'foliage', 'water', 'soil', 'special_uses', 'additional_info',
    ]
    enriched = 0
    for p in plants:
        matched = None
        for v in variants(p['botanical']):
            if v in master:
                matched = master[v]
                break
        if matched:
            for k in metadata_fields:
                val = matched.get(k)
                if val and not p.get(k):
                    p[k] = val
            h = matched.get('hardiness')
            if h is not None and not p.get('hardiness'):
                p['hardiness'] = f'{h}\u00b0F'
            enriched += 1
    return enriched


def _cmp(s):
    """Comparison form: case-, whitespace- and quote-insensitive.

    The master is not typographically consistent ('Coyote Brush' vs 'Coyote
    Bush' is real, "glossy abelia" vs "Glossy Abelia" is not), so a plain
    string compare reports ~300 phantom changes.
    """
    if s is None: return ''
    t = str(s).strip().lower()
    for a, b in (('\u2018', "'"), ('\u2019', "'"), ('\u201c', '"'), ('\u201d', '"')):
        t = t.replace(a, b)
    return re.sub(r'\s+', ' ', t)


def _documented_synonym(plant_botanical, record):
    """True when the plant's current name is a synonym the master declares.

    Only these may be renamed. A match found by stripping a qualifier or a
    cultivar is NOT licence to rename: 'Phyla nodiflora (pink)' must not become
    'Phyla nodiflora', and Teucrium 'Compactum' must not become 'Gwen'.
    """
    return _cmp(plant_botanical) in {_cmp(x) for x in (record.get('synonyms') or [])}


def propagate(plants, master, rename=False, typography=False):
    """Overwrite portal metadata that DIFFERS from the master (opt-in).

    enrich() only fills EMPTY fields, so a corrected master value — a fixed
    common name, a new exposure, or a botanical rename — never reaches the
    portal. This pass is the other half.

    It is deliberately conservative:
      * case/quote/whitespace-only differences are skipped unless
        typography=True (they are the master's formatting, not a correction);
      * hardiness is compared numerically, so '0' -> '0°F' is not a change;
      * a botanical is renamed ONLY when the master explicitly declares the
        current name as a synonym (see _documented_synonym), stashing the old
        name in `botanical_prev` so the change is reversible.

    Returns (changes, renamed); each change is (botanical, field, old, new).
    """
    metadata_fields = [
        'common', 'origin', 'plant_type', 'exposure', 'flower_color', 'flower_time',
        'height', 'width', 'foliage', 'water', 'soil', 'special_uses', 'additional_info',
    ]
    changes, renamed = [], []
    for p in plants:
        matched = None
        for v in variants(p['botanical']):
            if v in master:
                matched = master[v]
                break
        if not matched:
            continue

        if rename:
            canonical = matched.get('botanical')
            if canonical and canonical != p.get('botanical') \
                    and _documented_synonym(p.get('botanical'), matched):
                renamed.append((p.get('botanical'), canonical))
                p['botanical_prev'] = p.get('botanical')
                p['botanical'] = canonical
                if matched.get('synonyms'):
                    p['synonyms'] = matched['synonyms']

        for k in metadata_fields:
            val = matched.get(k)
            if not val:
                continue
            cur = p.get(k)
            if cur is None:
                continue            # enrich() already fills empties
            if _cmp(cur) == _cmp(val):
                if cur == val or not typography:
                    continue        # identical, or formatting-only
            changes.append((p.get('botanical'), k, cur, val))
            p[k] = val

        h = matched.get('hardiness')
        if h is not None:
            new_h = f'{h}\u00b0F'
            try:
                same_number = int(re.sub(r'[^0-9-]', '', str(p.get('hardiness') or '')) or 'x') == int(h)
            except ValueError:
                same_number = False
            if not same_number:
                changes.append((p.get('botanical'), 'hardiness', p.get('hardiness'), new_h))
                p['hardiness'] = new_h
    return changes, renamed


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--input', help='Path to JSON availability dict (default: existing availability_data.js)')
    ap.add_argument('--propagate', action='store_true',
                    help='also overwrite metadata that DIFFERS from the master (default: fill empty fields only)')
    ap.add_argument('--propagate-botanical', action='store_true',
                    help='with --propagate, also align the botanical name with the master (implies --propagate)')
    ap.add_argument('--dry-run', action='store_true', help='report changes without writing availability_data.js')
    args = ap.parse_args()
    if args.propagate_botanical:
        args.propagate = True

    master = load_master()

    if args.input:
        with open(args.input) as f:
            data = json.load(f)
    else:
        if not AVAIL.exists():
            sys.exit(f'No {AVAIL}')
        text = AVAIL.read_text()
        m = re.search(r'window\.AVAILABILITY = (\{[\s\S]*?\});', text)
        if not m:
            sys.exit(f'Could not parse AVAILABILITY from {AVAIL}')
        # Same trailing-comma tolerance as regen_availability.py (Round 74).
        payload = re.sub(r',(\s*\n\s*[}\]])', r'\1', m.group(1))
        data = json.loads(payload)

    n = enrich(data['plants'], master)
    print(f'Enriched {n}/{len(data["plants"])} plants')

    if args.propagate:
        changes, renamed = propagate(data['plants'], master, rename=args.propagate_botanical)
        print(f'Propagated {len(changes)} field change(s); renamed {len(renamed)} plant(s)')
        for b, f, old, new in changes:
            print(f'  ~ {b} | {f}: {str(old)[:70]!r} -> {str(new)[:70]!r}')
        for old, new in renamed:
            print(f'  -> renamed: {old} -> {new}')

    if args.dry_run:
        print('DRY RUN: availability_data.js not written')
        return

    # Re-emit
    plants_json = json.dumps(data['plants'], indent=2, ensure_ascii=False)
    js = (
        '/* Native Sons Weekly Availability - generated */\n'
        '/*global window */\n'
        'window.AVAILABILITY = {\n'
        f'  "week": {json.dumps(data["week"])},\n'
        f'  "generated": {json.dumps(data["generated"])},\n'
        f'  "source": {json.dumps(data["source"])},\n'
        f'  "contact": {json.dumps(data["contact"])},\n'
        f'  "plants": {plants_json}\n'
        '};\n'
    )
    AVAIL.write_text(js)
    print(f'Wrote {os.path.getsize(AVAIL)} bytes to {AVAIL}')


if __name__ == '__main__':
    main()
