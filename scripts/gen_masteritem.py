#!/usr/bin/env python3
"""Regenerate masteritem_data.js + masteritem_full.js from plantmaterialsync xlsx.

Reproduces the existing on-disk format exactly:
  masteritem_data.js : window.MASTER_ITEM = {"i":[{c,s,p,u},...]};
  masteritem_full.js : window.MASTER_ITEM_FULL = [{c,s,p,u,d},...];
Row order follows the xlsx (NOT sorted) — matches the current production files.
"""
import json, re, sys, warnings
from pathlib import Path
import openpyxl

warnings.filterwarnings("ignore")

def norm_size(s):
    if not s: return ""
    s = str(s).replace("\n", "").strip().lower()
    if not s: return ""
    if s.endswith('"'):
        try: return f"{int(s[:-1])}inch"
        except ValueError: return s
    if re.fullmatch(r"\d+gal", s):
        return s
    if re.fullmatch(r"\d+g", s):
        return f"{int(s[:-1])}gal"
    return s.replace(" ", "")


def size_vocab(ref_path):
    """Distinct size spellings already shipping in masteritem_data.js."""
    try:
        s = open(ref_path, encoding="utf-8").read()
        data = json.loads(re.search(r"window\.MASTER_ITEM\s*=\s*(\{.*\});", s, re.S).group(1))
        return {it["s"] for it in data["i"]}
    except Exception:
        return set()


def code_sizes(ref_path):
    """code -> list of size spellings already shipping, for per-code identity."""
    try:
        s = open(ref_path, encoding="utf-8").read()
        data = json.loads(re.search(r"window\.MASTER_ITEM\s*=\s*(\{.*\});", s, re.S).group(1))
        out = {}
        for it in data["i"]:
            out.setdefault(it["c"], []).append(it["s"])
        return out
    except Exception:
        return {}


def canon_size(raw, vocab, prior_sizes=()):
    """Canonicalize a raw size, preserving the spelling this code already used.

    The historical file is inconsistent (Book AND book, 4inch AND 4, 16g not
    16gal). Matching a code's own previous spelling first keeps item identity
    stable; only genuinely new codes fall back to the global vocabulary.
    """
    n = norm_size(raw)
    if not n:
        return ""
    prior = list(prior_sizes)
    if n in prior:
        return n
    for p in prior:
        if norm_size(p) == n:
            return p
    if n in vocab:
        return n
    raw_l = str(raw).replace("\n", "").strip().lower()
    if raw_l in vocab:
        return raw_l
    # bare numbers in this catalog are inch pots ("4" means 4", not 4 gallon)
    if re.fullmatch(r"\d{1,2}", n):
        return f"{int(n)}inch"
    for v in vocab:
        if v.lower() == n:
            return v
    return n

def num(v):
    if v in (None, ""): return None
    try:
        f = float(v)
    except (TypeError, ValueError):
        return None
    return int(f) if f == int(f) else f

def build(src, vocab, prior):
    wb = openpyxl.load_workbook(src, data_only=True)
    ws = wb.active
    if ws is None:
        raise SystemExit(f"no active sheet in {src}")
    items, skipped = [], []
    for i, row in enumerate(ws.iter_rows(min_row=2, values_only=True), start=2):
        code = (str(row[0]).strip().lower() if row[0] else "")
        size = canon_size(row[1], vocab, prior.get(code, ()))
        desc = (str(row[3]).strip() if len(row) > 3 and row[3] else "")
        upc  = (str(row[6]).strip() if len(row) > 6 and row[6] else "")
        price = num(row[2] if len(row) > 2 else None)
        if not code or not size:
            if code or size: skipped.append((i, code, size, "missing code or size"))
            continue
        items.append({"c": code, "s": size, "p": price if price is not None else 0,
                      "u": upc, "d": desc})
    wb.close()
    return items, skipped

def main():
    src = sys.argv[1]
    outdir = Path(sys.argv[2]) if len(sys.argv) > 2 else Path("/tmp/masteritem_new")
    ref = Path(sys.argv[3]) if len(sys.argv) > 3 else Path(__file__).parent.parent / "masteritem_data.js"
    outdir.mkdir(parents=True, exist_ok=True)
    vocab = size_vocab(ref)
    print(f"size vocabulary from {ref.name}: {len(vocab)} distinct spellings")
    prior = code_sizes(ref)
    items, skipped = build(src, vocab, prior)

    compact = [{k: it[k] for k in ("c", "s", "p", "u")} for it in items]
    data_js = ("// Auto-generated from plantmaterialsync.xlsx — "
               f"{len(compact)} plant/size combinations\n"
               "window.MASTER_ITEM = " + json.dumps({"i": compact}, separators=(",", ":")) + ";\n")
    (outdir / "masteritem_data.js").write_text(data_js, encoding="utf-8")

    full_rows = ",\n".join(json.dumps(it, ensure_ascii=False) for it in items)
    full_js = ("// Auto-generated from plantmaterialsync.xlsx — full version with descriptions.\n"
               "// Each item has: c=item_code, s=normalized_size, p=wholesale_price, u=UPC-12, d=description.\n"
               "window.MASTER_ITEM_FULL = [\n" + full_rows + "\n];\n")
    (outdir / "masteritem_full.js").write_text(full_js, encoding="utf-8")

    print(f"source rows -> items: {len(items)}  skipped: {len(skipped)}")
    for s in skipped[:10]: print("   skipped:", s)
    print(f"wrote {outdir}/masteritem_data.js ({(outdir/'masteritem_data.js').stat().st_size} B)")
    print(f"wrote {outdir}/masteritem_full.js ({(outdir/'masteritem_full.js').stat().st_size} B)")

if __name__ == "__main__":
    main()
