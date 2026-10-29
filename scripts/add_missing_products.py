#!/usr/bin/env python3
"""Add missing new products to availability_data.js, preserving the file's format.

Adds only plants that exist in the master item export with a container size the
portal supports, and that are absent from the current availability list.
Attributes are filled afterwards by enrich_availability.py from the plantdata
export, so nothing here is invented.
"""
import json, re, sys
from pathlib import Path

ROOT = Path("/Users/tfross/.hermes/nativesons-order")
AVAIL = ROOT / "availability_data.js"
MASTER = ROOT / "masteritem_full.js"

SIZE_MAP = {"4inch": "4in", "1gal": "1gal", "2gal": "2gal", "5gal": "5gal", "15gal": "15gal"}


def load_avail():
    s = AVAIL.read_text(encoding="utf-8")
    m = re.search(r"window\.AVAILABILITY\s*=\s*(\{.*\});\s*$", s, re.S)
    return json.loads(m.group(1))


def render(obj):
    body = json.dumps(obj, indent=1, ensure_ascii=False)
    return ("/* Native Sons Weekly Availability - generated */\n"
            "/*global window */\n"
            "window.AVAILABILITY = " + body + ";")


def norm(s):
    s = str(s or "").strip().replace("\u2018", "'").replace("\u2019", "'")
    return re.sub(r"\s+", " ", s).lower()


def variants(name):
    n = norm(name)
    out = {n, re.sub(r"\s*\([^)]*\)\s*", "", n), re.sub(r"['\u2018\u2019]", "", n)}
    m = re.match(r"^([A-Z][a-z]+)\s+[a-z\.]+(?:\s+x\s+[a-z]+)?\s+(.*)$", str(name).strip())
    if m:
        out.add(f"{m.group(1).lower()} {m.group(2).lower()}")
    return out


def main():
    apply = "--apply" in sys.argv
    prev_path = None
    for i, a in enumerate(sys.argv):
        if a == "--prev" and i + 1 < len(sys.argv):
            prev_path = Path(sys.argv[i + 1])

    prev_keys = set()
    if prev_path and prev_path.exists():
        pv = json.loads(re.search(r"window\.MASTER_ITEM\s*=\s*(\{.*\});",
                                  prev_path.read_text(encoding="utf-8"), re.S).group(1))["i"]
        prev_keys = {(x["c"], x["s"]) for x in pv}

    avail = load_avail()
    plants = avail["plants"]
    present = set()
    for p in plants:
        present |= variants(p["botanical"])

    master = json.loads(re.search(r"window\.MASTER_ITEM_FULL\s*=\s*(\[.*\]);",
                                  MASTER.read_text(encoding="utf-8"), re.S).group(1))

    # Only rows introduced since the previous master snapshot are "new products".
    if prev_keys:
        master = [it for it in master if (it["c"], it["s"]) not in prev_keys]
    else:
        sys.exit("refusing to run without --prev (would add the entire catalog)")

    # group master rows by plant description
    by_desc = {}
    for it in master:
        by_desc.setdefault(it["d"], []).append(it)

    to_add = []
    for desc, items in by_desc.items():
        if variants(desc) & present:
            continue
        sizes = [{"container": SIZE_MAP[i["s"]], "price": i["p"], "order": ""}
                 for i in items if i["s"] in SIZE_MAP]
        if not sizes:
            continue
        # de-dupe containers, keep cheapest/first occurrence
        seen, uniq = set(), []
        for s in sizes:
            if s["container"] in seen:
                continue
            seen.add(s["container"])
            uniq.append(s)
        to_add.append({
            "botanical": str(desc).replace("\u2018", "'").replace("\u2019", "'").strip(),
            "section": "General Nursery",
            "sizes": uniq,
            "bloom": False,
            "bud": False,
            "new": True,
        })

    to_add.sort(key=lambda p: p["botanical"].lower())
    print(f"plants on portal: {len(plants)}")
    print(f"candidate additions: {len(to_add)}")
    for p in to_add:
        print(f"   {p['botanical'][:48]:<50} {[(s['container'], s['price']) for s in p['sizes']]}")

    if not apply:
        print("\nDRY RUN — pass --apply to write")
        return

    plants.extend(to_add)
    avail["plants"] = plants
    AVAIL.write_text(render(avail), encoding="utf-8")
    print(f"\nwrote {AVAIL} with {len(plants)} plants")


if __name__ == "__main__":
    main()
