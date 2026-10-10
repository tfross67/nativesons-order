#!/usr/bin/env python3
"""Build the weekly "Native Sons — California Native Plants" note into Obsidian.

Source of truth: the portal's own availability_data.js (already cleaned, with
this week's sizes/flags), so the note can never disagree with the portal.

Format is copied from the reviewed notes (Week of Sep 21 / Sep 28 / Oct 5, 2026):
frontmatter with title+week, HTML logo, contact line, a `## 4" Production` table
(Botanical | Common | Origin) and a `## 1gal / 5gal / 15gal` table
(Botanical | Common | Container | H×W | Flower | Origin), alphabetical within
each, no prices, no links, no photos.

CA-native filter is the STRICT one (origin contains "California", or the
ca_native tag) — a loose `western`/`oregon`/`baja` substring match pulls in
Blechnum spicant, Euphorbia amygdaloides 'Purpurea', Halimium lasianthum
'Sandling' and Teucrium fruticans 'Azureum' (verified 2026-08-01).

A plant with BOTH a 4in and a 1gal+ size goes in the 1gal+ table once, with the
container column reading "4in / 1gal" — the sections stay one-row-per-plant the
way Tim reviewed them, and the 4in availability is still visible. (Until
2026-10-09 the 4in size was missing from the data for such plants, so this case
never arose; see native-sons-availability/references/weekly-refresh-both-sheets-4in-loss-2026-10-09.md.)

Usage:
  build_natives_note.py [--dry-run] [--quiet]
Exit 0 always unless the data file is unreadable; prints a one-line summary.
"""
from __future__ import annotations

import argparse
import json
import os
import re
import sys
from pathlib import Path

AVAIL = Path('/Users/tfross/.hermes/nativesons-order/availability_data.js')
ICLOUD = Path("/Users/tfross/Library/Mobile Documents/iCloud~md~obsidian/"
              "Documents/Tim's Vault/Native Sons")
LOCAL = Path("/Users/tfross/Documents/Tim's Vault/Native Sons Notes")
LOGO = '_assets/native-sons-logo-586x143.png'
SIZE_ORDER = {'4in': 0, '1gal': 1, '2gal': 2, '5gal': 3, '15gal': 4}
CONTACT = 'Tim Fross · 714.801.8581 · tfross@nativeson.com'


def load_avail(path: Path = AVAIL) -> dict:
    text = path.read_text(encoding='utf-8')
    m = re.search(r'window\.AVAILABILITY\s*=\s*(\{[\s\S]*?\});', text)
    if not m:
        raise SystemExit(f'{path}: no window.AVAILABILITY block')
    # tolerate the JS-style trailing commas the backfill used to emit (P85)
    return json.loads(re.sub(r',(\s*\n\s*[}\]])', r'\1', m.group(1)))


def is_ca(p: dict) -> bool:
    """STRICT California-native test. Do not loosen this."""
    return 'california' in (p.get('origin') or '').lower() or bool(p.get('ca_native'))


def botan_md(p: dict) -> str:
    """Italic binomial, cultivar outside the italics: *Genus species* 'Cultivar'.

    Exception that matches the reviewed notes: a GENUS-ONLY name carries its
    cultivar inside the italics (*Arctostaphylos 'Pacific Mist'*, *Salvia
    'Dara's Choice'*), while a genus+epithet name puts it outside
    (*Arctostaphylos manzanita* 'Hood Mountain'). Verified against
    'Native Plants Availability — Week of October 5, 2026.md'.
    """
    name = (p.get('botanical') or '').strip()
    m = re.match(r"^(.*?)\s*(['\u2018\u2019].*['\u2018\u2019])$", name)
    if not m:
        return f'*{name}*'
    prefix, cultivar = m.group(1).strip(), m.group(2).strip()
    if len(prefix.split()) == 1:
        return f'*{name}*'
    return f'*{prefix}* {cultivar}'


def containers(p: dict) -> str:
    cs = {s['container'] for s in p.get('sizes') or []}
    return ' / '.join(sorted(cs, key=lambda c: SIZE_ORDER.get(c, 99)))


def cell(v) -> str:
    v = ('' if v is None else str(v)).strip()
    return v.replace('|', '\\|') or 'N/A'


def note_body(data: dict) -> tuple[str, dict]:
    plants = [p for p in data['plants'] if is_ca(p)]
    plants.sort(key=lambda p: (p.get('botanical') or '').lower())
    four, main = [], []
    for p in plants:
        cs = {s['container'] for s in p.get('sizes') or []}
        if cs == {'4in'}:
            four.append(p)
        else:
            main.append(p)

    L = []
    L.append('---')
    L.append('title: Native Sons — California Native Plants')
    L.append(f"week: {data['week']}")
    L.append('---')
    L.append('')
    L.append('<div style="text-align: left;">')
    L.append(f'<img src="{LOGO}" alt="Native Sons Wholesale Nursery" width="300">')
    L.append('</div>')
    L.append('# Native Sons — California Native Plants')
    L.append(f"**{data['week']}** · {CONTACT}")
    L.append('*Native Sons Wholesale Nursery · Wholesale Availability*')
    L.append('')
    L.append('---')
    L.append('## 4" Production')
    L.append('')
    L.append('| Botanical | Common | Origin |')
    L.append('| --- | --- | --- |')
    for p in four:
        L.append(f"| {botan_md(p)} | {cell(p.get('common'))} | {cell(p.get('origin'))} |")
    L.append('')
    L.append('---')
    L.append('## 1gal / 5gal / 15gal')
    L.append('')
    L.append('| Botanical | Common | Container | H×W | Flower | Origin |')
    L.append('| --- | --- | --- | --- | --- | --- |')
    for p in main:
        h, w = cell(p.get('height')), cell(p.get('width'))
        hw = f'{h} × {w}'
        colour, time = cell(p.get('flower_color')), cell(p.get('flower_time'))
        flower = f'{colour} ({time})'
        L.append(f"| {botan_md(p)} | {cell(p.get('common'))} | {containers(p)} | "
                 f"{hw} | {flower} | {cell(p.get('origin'))} |")
    L.append('')
    return '\n'.join(L), {'plants': len(plants), 'four': len(four), 'main': len(main)}


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument('--dry-run', action='store_true')
    ap.add_argument('--quiet', action='store_true')
    a = ap.parse_args()

    data = load_avail()
    body, counts = note_body(data)
    # filename uses "Week of {Month D, YYYY}" with NO ordinal in the weekday
    # number even though the body's contact line says "DDth" (verified rule)
    label = re.sub(r'(\d+)(st|nd|rd|th)', r'\1', data['week'])
    fname = f'Native Plants Availability — {label}.md'

    targets = []
    for d in (ICLOUD, LOCAL):
        if d.exists() or a.dry_run:
            targets.append(d / fname)

    changed = []
    for t in targets:
        old = t.read_text(encoding='utf-8') if t.exists() else None
        if old == body:
            continue
        changed.append(t)
        if not a.dry_run:
            t.parent.mkdir(parents=True, exist_ok=True)
            t.write_text(body, encoding='utf-8')

    if not a.quiet:
        print(f"{data['week']} · CA natives {counts['plants']} "
              f"(4\": {counts['four']}, 1gal+: {counts['main']})")
        for t in targets:
            state = ('would write' if a.dry_run else
                     ('updated' if t in changed else 'unchanged'))
            print(f'  {state}: {t}')
        if not targets:
            print('  WARNING: neither vault path exists')
    return 0


if __name__ == '__main__':
    sys.exit(main())
