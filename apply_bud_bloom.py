#!/usr/bin/env python3
"""Apply bud/bloom overrides to availability_data.js.

This script reads bud_bloom_overrides.json (manually maintained) and stamps the
flags onto each plant in availability_data.js. Run after regenerating
availability from the weekly xlsx.

Usage:
  python3 apply_bud_bloom.py
"""
import json, re, sys, os
from pathlib import Path

ROOT = Path(__file__).parent
AVAIL = ROOT / 'availability_data.js'
OVERRIDES = ROOT / 'bud_bloom_overrides.json'


def norm_key(name):
    if not name: return ''
    s = name.lower()
    s = s.replace('\u2018', "'").replace('\u2019', "'")
    s = s.replace('\u201c', '"').replace('\u201d', '"')
    return s.strip()


def main():
    if not AVAIL.exists():
        sys.exit(f'No availability_data.js at {AVAIL}')
    if not OVERRIDES.exists():
        print(f'No overrides at {OVERRIDES} — skipping')
        return

    text = AVAIL.read_text()
    m = re.search(r'window\.AVAILABILITY = (\{[\s\S]*?\});', text)
    if not m:
        sys.exit('Could not parse AVAILABILITY from availability_data.js')

    data = json.loads(m.group(1))
    overrides = json.loads(OVERRIDES.read_text())

    bloom_set = {norm_key(n) for n in overrides.get('bloom', [])}
    bud_set = {norm_key(n) for n in overrides.get('bud', [])}

    bloom_count = 0
    bud_count = 0
    for p in data['plants']:
        k = norm_key(p['botanical'])
        p['bloom'] = k in bloom_set
        p['bud'] = k in bud_set
        if p['bloom']: bloom_count += 1
        if p['bud']: bud_count += 1

    # Re-emit the file
    plants_json = json.dumps(data['plants'], indent=2, ensure_ascii=False)
    js = (
        f'/* Native Sons Weekly Availability - generated */\n'
        f'/*global window */\n'
        f'window.AVAILABILITY = {{\n'
        f'  "week": {json.dumps(data["week"])},\n'
        f'  "generated": {json.dumps(data["generated"])},\n'
        f'  "source": {json.dumps(data["source"])},\n'
        f'  "contact": {json.dumps(data["contact"])},\n'
        f'  "plants": {plants_json}\n'
        f'}};\n'
    )
    AVAIL.write_text(js)
    print(f'\u2713 Applied bud/bloom overrides: {bloom_count} blooming, {bud_count} budding')
    print(f'  updated {AVAIL} ({os.path.getsize(AVAIL)} bytes)')


if __name__ == '__main__':
    main()
