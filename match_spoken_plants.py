#!/usr/bin/env python3
"""Match spoken plant names against the Native Sons master catalog.

Takes a free-text transcript (from voice input or typing) and resolves each
plant mention to an inventory entry: item code, UPC, size, price, botanical
name. Handles botanical names, common names, cultivar variants, and
size/quantity phrases ("5 gallon", "5g", "twenty six").

Usage:
  python3 match_spoken_plants.py "Ceanothus Centennial 5 gallon twenty six and Geranium Biokovo 4 inch"
  echo "..." | python3 match_spoken_plants.py -

Output: one JSON object per resolved mention:
  { "query": ..., "matched": true, "code": "ceacen5", "upc": "...",
    "size": "5g", "price": 20.0, "botanical": "Ceanothus 'Centennial'",
    "qty": 26, "note": null }
  Unmatched mentions get matched:false with a "note" explaining why.
"""
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent

# --------------------------------------------------------------------------
# Load master catalog
# --------------------------------------------------------------------------
def load_master():
    src = (ROOT / "masteritem_full.js").read_text()
    m = re.search(r"=\s*(\[.*\])\s*;?\s*$", src, re.S)
    data = m.group(1) if m else "[]"
    return json.loads(data)

MASTER = load_master()

# Common-name aliases: spoken/common name -> genus fragment or exact botanical
COMMON_ALIASES = {
    "ceanothus": "ceanothus",
    "california lilac": "ceanothus",
    "lavender": "lavandula",
    "salvia": "salvia",
    "sage": "salvia",
    "penstemon": "penstemon",
    "beardtongue": "penstemon",
    "manzanita": "arctostaphylos",
    "toyon": "heteromeles",
    "coffeeberry": "rhamnus",
    "ceano": "ceanothus",
    "yarrow": "achillea",
    "buckwheat": "eriogonum",
    "monkey flower": "mimulus",
    "monkeyflower": "mimulus",
    "flannel bush": "fremontodendron",
    "flannelbush": "fremontodendron",
    "coyote brush": "baccharis",
    "coyotebrush": "baccharis",
    "mugwort": "artemisia",
    "california fuchsia": "epilobium",
    "hummingbird sage": "salvia spathacea",
    "carpet rose": "rosa",
    "deer grass": "muhlenbergia",
    "deergrass": "muhlenbergia",
    "blue grama": "bouteloua",
    "fountain grass": "pennisetum",
    "juncus": "juncus",
    "rush": "juncus",
    "carex": "carex",
    "sedge": "carex",
    "festuca": "festuca",
    "fescue": "festuca",
    "armeria": "armeria",
    "thrift": "armeria",
    "geranium": "geranium",
    "cranesbill": "geranium",
    "heuchera": "heuchera",
    "coral bells": "heuchera",
    "agastache": "agastache",
    "hyssop": "agastache",
    "mint": "mentha",
    "rosemary": "rosmarinus officinalis",
    "rosmarinus": "rosmarinus officinalis",
    "thyme": "thymus",
    "oregano": "origanum",
    "echinacea": "echinacea",
    "coneflower": "echinacea",
    "rudbeckia": "rudbeckia",
    "black eyed susan": "rudbeckia",
    "coreopsis": "coreopsis",
    "tickseed": "coreopsis",
    "gaillardia": "gaillardia",
    "blanket flower": "gaillardia",
    "monarda": "monarda",
    "bee balm": "monarda",
    "lupine": "lupinus",
    "iris": "iris",
    "daylily": "hemerocallis",
    "agapanthus": "agapanthus",
    "lily of the nile": "agapanthus",
    "kniphofia": "kniphofia",
    "red hot poker": "kniphofia",
    "phormium": "phormium",
    "flax lily": "dianella",
    "dianella": "dianella",
    "cistus": "cistus",
    "rockrose": "cistus",
    "rock rose": "cistus",
    "grevillea": "grevillea",
    "leucadendron": "leucadendron",
    "protea": "protea",
    "banksia": "banksia",
    "callistemon": "callistemon",
    "bottlebrush": "callistemon",
    "melaleuca": "melaleuca",
    "westringia": "westringia",
    "australian rosemary": "westringia",
    "correa": "correa",
    "pittosporum": "pittosporum",
    "viburnum": "viburnum",
    "nandina": "nandina",
    "heavenly bamboo": "nandina",
    "berberis": "berberis",
    "barberry": "berberis",
    "mahonia": "mahonia",
    "leucothoe": "leucothoe",
    "pieris": "pieris",
    "azalea": "rhododendron",
    "rhododendron": "rhododendron",
    "camellia": "camellia",
    "hydrangea": "hydrangea",
    "wisteria": "wisteria",
    "clematis": "clematis",
    "lonicera": "lonicera",
    "honeysuckle": "lonicera",
    "jasmine": "jasminum",
    "tecomaria": "tecomaria",
    "cape honeysuckle": "tecomaria",
    "bignonia": "bignonia",
    "trumpet vine": "campsis",
    "aristolochia": "aristolochia",
    "pipevine": "aristolochia",
    "passiflora": "passiflora",
    "passion flower": "passiflora",
    "passionflower": "passiflora",
    "mirabilis": "mirabilis",
    "four o'clock": "mirabilis",
    "four oclock": "mirabilis",
    "plumbago": "plumbago",
    "ceratostigma": "ceratostigma",
    "leadwort": "ceratostigma",
    "lantana": "lantana",
    "verbena": "verbena",
    "gaura": "oenothera",
    "whirling butterfly": "gaura",
    "penstemon heterophyllus": "penstemon heterophyllus",
}

# Sizes we recognize in speech; maps spoken form -> master size format
SIZE_ALIASES = {
    "4 inch": "4in", "four inch": "4in", "4in": "4in", "4\"": "4in",
    "1 gallon": "1g", "one gallon": "1g", "1gal": "1g", "1g": "1g",
    "2 gallon": "2g", "two gallon": "2g", "2gal": "2g", "2g": "2g",
    "5 gallon": "5g", "five gallon": "5g", "5gal": "5g", "5g": "5g",
    "15 gallon": "15g", "fifteen gallon": "15g", "15gal": "15g", "15g": "15g",
    "20 gallon": "20g", "twenty gallon": "20g",
    "7 gallon": "7g", "seven gallon": "7g",
    "16 gallon": "16g", "sixteen gallon": "16g",
    "24 gallon": "24g", "twenty four gallon": "24g",
    "liner": "liner",
    "plug": "plug",
}

# Hyphenated variants — Whisper and keyboard both produce "4-inch",
# "5-gallon". Normalize hyphens to spaces before alias matching.
SIZE_HYPHEN_ALIASES = {
    "4-inch": "4in", "four-inch": "4in",
    "1-gallon": "1g", "one-gallon": "1g",
    "2-gallon": "2g", "two-gallon": "2g",
    "5-gallon": "5g", "five-gallon": "5g",
    "15-gallon": "15g", "fifteen-gallon": "15g",
    "20-gallon": "20g", "twenty-gallon": "20g",
    "7-gallon": "7g", "seven-gallon": "7g",
    "16-gallon": "16g", "sixteen-gallon": "16g",
    "24-gallon": "24g", "twenty-four-gallon": "24g",
}

# Whisper end-of-speech / filler tokens that carry no plant meaning and
# must be dropped before matching. Whisper emits "Stop." / "stop" when it
# detects the speaker finished; "um", "uh", "like" are filler.
WHISPER_FILLER = {
    "stop", "stop.", "um", "uh", "uhh", "like", "so", "ok", "okay",
    "right", "yeah", "and", "the", "a", "also",
}

# Short common English words that must NOT anchor a cultivar match even
# though they're >= 5 chars — "point" must not match "Point Joe", "blue"
# must not match "Blue Arrow". The anchor guard rejects tokens shorter
# than 6 chars UNLESS the token isn't in this set (a 5-char distinctive
# name fragment like "rosam" → 'Rozanne' is a real signal; "point" is not).
ANCHOR_STOPWORDS = {
    "point", "blue", "green", "white", "black", "gold", "silver", "pink",
    "red", "yellow", "purple", "dwarf", "giant", "small", "large", "rose",
    "lily", "iris", "jade", "moon", "star", "sun", "king", "queen",
    "royal", "dutch", "french", "jap", "chin", "hardy", "sweet", "wild",
}


def strip_whisper_filler(tokens):
    """Drop trailing/leading Whisper fillers and empty tokens."""
    out = []
    for t in tokens:
        t = t.strip(".,;!?")
        if not t:
            continue
        if t.lower() in WHISPER_FILLER:
            continue
        out.append(t)
    return out


# Numbers in speech (both "26" and "twenty six")
NUM_WORDS = {
    "zero": 0, "one": 1, "two": 2, "three": 3, "four": 4, "five": 5,
    "six": 6, "seven": 7, "eight": 8, "nine": 9, "ten": 10,
    "eleven": 11, "twelve": 12, "thirteen": 13, "fourteen": 14,
    "fifteen": 15, "sixteen": 16, "seventeen": 17, "eighteen": 18,
    "nineteen": 19, "twenty": 20, "thirty": 30, "forty": 40,
    "fifty": 50, "sixty": 60, "seventy": 70, "eighty": 80, "ninety": 90,
    "hundred": 100,
}


def parse_number(tokens):
    """Parse a quantity from tokens: '26', 'twenty six', 'twenty-six'."""
    if not tokens:
        return None
    t = tokens[0].lower()
    if re.fullmatch(r"\d+", t):
        return int(t)
    # word form — handle compound like "twenty six"
    if t in NUM_WORDS:
        val = NUM_WORDS[t]
        if len(tokens) > 1 and tokens[1].lower() in NUM_WORDS and tokens[1].lower() not in ("hundred",):
            val += NUM_WORDS[tokens[1].lower()]
            if len(tokens) > 2 and tokens[2].lower() == "hundred":
                val *= 100
        elif len(tokens) > 1 and tokens[1].lower() == "hundred":
            val *= 100
        return val
    return None


# --------------------------------------------------------------------------
# Normalization (mirrors availability.html lookupItemCode)
# --------------------------------------------------------------------------
def norm(s):
    return re.sub(r"\s+", " ", str(s or "").lower().replace("‘", "'").replace("’", "'")).strip()


def normalize_size(s):
    x = re.sub(r'[\s"]', "", str(s or "").lower())
    if x in ("4pot", "4in", "4inch", "4inchpot"): return "4in"
    if x in ("1gal", "1g", "1gallon", "1gpot"): return "1g"
    if x in ("2gal", "2g", "2gallon", "2gpot"): return "2g"
    if x in ("5gal", "5g", "5gallon", "5gpot"): return "5g"
    if x in ("15gal", "15g", "15gallon", "15gpot"): return "15g"
    if x in ("20gal", "20g", "20gallon"): return "20g"
    if x in ("7gal", "7g"): return "7g"
    if x in ("16gal", "16g"): return "16g"
    if x == "4": return "4in"
    return x


def extract_cultivar(s):
    m = re.search(r"['‘’]([^'‘’]+)['‘’]", str(s or ""))
    return re.sub(r"\s+", "", m.group(1).lower()) if m else None


def consonant_skeleton(s):
    """Vowels-only-mangled names (Whisper drops 'ea' → 'cnothis') still
    share their consonant sequence: cnothis and ceanothus both reduce to
    c-n-t-h-s. Compare skeletons when edit distance fails."""
    return re.sub(r"[aeiouy]+", "", str(s or "").lower())


def metaphone(word):
    """Compact Double-Metaphone-ish encoder — maps a spoken name to its
    sound code so any phonetic spelling of the same word lands on the same
    code. 'cyanothus', 'cnothus', 'cnotus' all → KNTS, matching the real
    'ceanothus'. Pure stdlib, no deps. Covers the Whisper garble class
    that edit distance can't (whole-vowel and syllable reshuffles)."""
    w = re.sub(r"[^a-z]", "", str(word or "").lower())
    if not w:
        return ""
    out = []
    i = 0
    n = len(w)
    while i < n:
        c = w[i]
        nxt = w[i + 1] if i + 1 < n else ""
        if c in "aeiou":
            if not out:  # leading vowel gets a placeholder consonant
                out.append("A")
            i += 1
            continue
        if c == "c":
            if nxt in "eiy":
                out.append("S")
            elif nxt == "h":
                out.append("K")
            else:
                out.append("K")
        elif c in "gk":
            out.append("J" if c == "g" and nxt in "eiy" else "K")
        elif c in "sz":
            out.append("S")
        elif c in "j":
            out.append("J")
        elif c in "t":
            out.append("S" if nxt in "ia" else "T")
        elif c == "d":
            out.append("T")
        elif c in "fv":
            out.append("F")
        elif c in "pb":
            out.append("P")
        elif c == "m":
            out.append("M")
        elif c == "n":
            out.append("N")
        elif c == "r":
            out.append("R")
        elif c == "l":
            out.append("L")
        # h/w/y/x/q dropped (q handled as K above)
        i += 1
    return "".join(out)


# Precompute per-row fields for matching speed
ROWS = []
for row in MASTER:
    d = row.get("d", "") or ""
    n = norm(d)
    ROWS.append({
        "code": row.get("c", ""),
        "upc": row.get("u", "") or "",
        "size": row.get("s", ""),
        "price": row.get("p"),
        "desc": d,
        "norm": n,
        "cultivar": extract_cultivar(d),
        # Tokens with apostrophes stripped — spoken names rarely include
        # them ("margarita bop", "elk blue", "munstead"), and a glued
        # quote ('margarita) breaks token-overlap matching entirely.
        "tokens": [t.strip("'‘’\"") for t in n.split()],
        # Letters-only cultivar (e.g. "margaritabop") for substring checks
        # against spoken tokens that lost their apostrophes.
        "cultivar_letters": re.sub(r"[^a-z]", "", extract_cultivar(d) or ""),
        "genus_meta": metaphone((d.split() or [""])[0]),
        "desc_meta": metaphone(d),
    })

# Genus index: first token -> rows (fast candidate filter)
GENUS_INDEX = {}
for i, r in enumerate(ROWS):
    if r["tokens"]:
        GENUS_INDEX.setdefault(r["tokens"][0], []).append(i)

# Phonetic genus index: metaphone code -> rows (sound-based fallback)
META_INDEX = {}
for i, r in enumerate(ROWS):
    if r["genus_meta"]:
        META_INDEX.setdefault(r["genus_meta"], []).append(i)


def levenshtein(a, b, limit=3):
    """Cheap bounded Levenshtein for typo tolerance."""
    if abs(len(a) - len(b)) > limit:
        return limit + 1
    if a == b:
        return 0
    dp = list(range(len(b) + 1))
    for i, ca in enumerate(a, 1):
        prev = dp[0]
        dp[0] = i
        for j, cb in enumerate(b, 1):
            cur = dp[j]
            dp[j] = min(dp[j] + 1, dp[j - 1] + 1, prev + (ca != cb))
            prev = cur
        if min(dp) > limit:
            return limit + 1
    return dp[-1]


def match_botanical(query_tokens, size=None, anchor_allowed=False):
    """Match a normalized botanical phrase against master. Returns best row or None.

    anchor_allowed=True enables the cultivar-anchored fallback (genus too
    mangled to use, e.g. "duringium biocopo" → Biokovo). Callers should
    enable it ONLY as a last resort, after the common-name alias path —
    otherwise a common name that happens to be a cultivar ("lavender")
    hijacks the match.
    """
    q = " ".join(query_tokens)
    # Lowercase and strip stray hyphens/punct — Whisper capitalizes tokens
    # ("Duranium") and glues hyphens into names ("CNOTHIS-EA") but the
    # genus index is all-lowercase and hyphen-free; a case-sensitive or
    # hyphenated compare silently rejects every such name.
    query_tokens = [t.lower().strip("-—–") for t in query_tokens]
    q = " ".join(query_tokens)
    q_cultivar = extract_cultivar(q)
    q_genus = query_tokens[0] if query_tokens else ""

    candidates = GENUS_INDEX.get(q_genus, [])
    fuzzy_genus = None
    cultivar_anchored = False
    # Collect candidates from EVERY genus layer (exact, phonetic, edit,
    # skeleton) into ONE pool and let the scorer rank them. First-wins
    # per-layer is wrong: "duranium" is 2 edits from geranium AND
    # phonetically TRNM-something-else — the right genus is whichever row
    # scores best overall (cultivar overlap, exact tokens), so merging the
    # pools and scoring together beats layer precedence.
    candidate_sets = []
    if not candidates:
        # Phonetic genus (metaphone) — sound is the strongest garble
        # signal. Exact, prefix (min 3 chars), or 1-edit codes.
        q_meta = metaphone(q_genus)
        if len(q_meta) >= 3:
            cands = META_INDEX.get(q_meta, [])
            if not cands:
                for code, idxs in META_INDEX.items():
                    if code == q_meta:
                        continue
                    if (code.startswith(q_meta) or q_meta.startswith(code)) and len(q_meta) >= 3:
                        cands = idxs
                        break
                    if not cands and levenshtein(code, q_meta, 1) <= 1:
                        cands = idxs
            if cands:
                candidate_sets.append(cands)
                if fuzzy_genus is None:
                    fuzzy_genus = ROWS[cands[0]]["tokens"][0] if ROWS[cands[0]]["tokens"] else q_genus
        # fuzzy genus — allow 2 edits ("duranium" → "geranium" is 2)
        for g, idxs in GENUS_INDEX.items():
            if levenshtein(g, q_genus, 2) <= 2:
                candidate_sets.append(idxs)
                if fuzzy_genus is None:
                    fuzzy_genus = g
                break
        # Consonant-skeleton genus: "cnothis" shares c-n-t-h-s with
        # "ceanothus" even at 4+ edits.
        q_skel = consonant_skeleton(q_genus)
        if len(q_skel) >= 4:
            for g, idxs in GENUS_INDEX.items():
                g_skel = consonant_skeleton(g)
                if g_skel == q_skel and g_skel[:1] == q_skel[:1]:
                    candidate_sets.append(idxs)
                    if fuzzy_genus is None:
                        fuzzy_genus = g
                    break
        # Merge, dedupe preserving order.
        seen = set()
        merged = []
        for s in candidate_sets:
            for i in s:
                if i not in seen:
                    seen.add(i)
                    merged.append(i)
        candidates = merged
    # Cultivar-anchored candidates ALWAYS join the pool (not just when
    # every genus layer failed). "duringium" phonetically grazes Hydrangea
    # (TRNJ) but its cultivar anchor biocopo→biokovo is the real signal —
    # the scorer must see gerbio4 even when a wrong genus pool exists.
    if anchor_allowed:
        for i, r in enumerate(ROWS):
            cl = r["cultivar_letters"]
            if not cl or len(cl) < 5:
                continue
            for t in query_tokens:
                tl = t.strip(".,;!?-")
                d = levenshtein(tl, cl, 3)
                if d <= 2:
                    if i not in set(candidates):
                        candidates.append(i)
                    break
                # shared prefix of 3+ chars → allow up to 4 edits
                if d <= 4 and len(tl) >= 3 and len(cl) >= 3 and tl[:3] == cl[:3]:
                    if i not in set(candidates):
                        candidates.append(i)
                    break
        cultivar_anchored = True
    if not candidates:
        return None

    best, best_score = None, 1e9
    best_common = -1
    for i in candidates:
        r = ROWS[i]
        common = 0
        if size and normalize_size(r["size"]) != normalize_size(size):
            continue
        d = r["norm"]
        # Exact / prefix on the normalized description. If the genus came in
        # fuzzy (e.g. "penstemmon"), rewrite the first token to the real
        # genus so the prefix/overlap comparisons still work.
        comp_tokens = [fuzzy_genus] + query_tokens[1:] if fuzzy_genus else query_tokens
        comp_q = " ".join(comp_tokens)
        # Non-plant SKUs (book, shirt, pot, liner) get a penalty in EVERY
        # branch so a bare "ceanothus" prefers a container size over a
        # book item even when the book is an exact description match.
        nonplant_penalty = 3.0 if r["size"].lower() in ("book", "shirt", "pot", "liner", "plug") else 0.0
        # exact / prefix — perfect matches beat everything
        if d == comp_q:
            score = -10 + nonplant_penalty
        elif d.startswith(comp_q + " ") or comp_q.startswith(d + " "):
            score = -8 + nonplant_penalty
        else:
            # token overlap score (apostrophes already stripped); allow one
            # edit per remaining token so typos like "margaritta" still hit.
            dt = r["tokens"]
            qt = comp_tokens
            common = 0
            anchor_count = 0
            anchor_prefix_hit = False
            cl = r["cultivar_letters"]
            # The FIRST token is the genus — it has its own matching layers
            # (exact/phonetic/edit) and must NOT participate in the cultivar
            # anchor. "geranium"→JRNM grazes "plenum"→PLNM at metaphone
            # distance 2, falsely anchoring every plenum/nanum-like cultivar
            # and drowning the real signal from the cultivar token.
            anchor_tokens = qt[1:] if len(qt) > 1 else qt
            for tq in anchor_tokens:
                tq_clean = tq.strip(".,;!?-")
                hit = tq_clean in dt or any(levenshtein(tq_clean, td, 1) <= 1 for td in dt)
                if hit:
                    common += 1
                # Cultivar anchor — computed for EVERY row so a mangled
                # cultivar ("biocobal" → "biokovo") can carry the match in
                # the fuzzy-genus path too, not just the anchor-only path.
                # Min token length 6 — a 5-char common word ("point") must
                # not anchor onto "Point Joe" via a shared 3-char prefix.
                # Exception: 5-char DISTINCTIVE fragments (not in
                # ANCHOR_STOPWORDS) like "rosam" → 'Rozanne' are real
                # signals and may anchor.
                if cl and len(cl) >= 5 and len(tq_clean) >= 6 or (
                    cl and len(cl) >= 5 and len(tq_clean) == 5
                    and tq_clean not in ANCHOR_STOPWORDS
                ):
                    d_anchor = levenshtein(tq_clean, cl, 4)
                    if d_anchor <= 2 or (
                        d_anchor <= 4 and len(tq_clean) >= 3 and tq_clean[:3] == cl[:3]
                    ):
                        anchor_count += 1
                    else:
                        # Phonetic cultivar: "apoblossum" vs "appleblossom"
                        # is 4+ spelling edits but their metaphone codes
                        # (APPLSM vs APLPLSM) are only 2 edits apart.
                        # The tq_meta minimum is 3 (a 5-char word like
                        # "rosam" encodes to RSM — demanding >=5 would
                        # reject every short distinctive fragment).
                        # Require a shared 2-char code prefix: 3-char codes
                        # graze too easily ("yankee"→ANK vs "heart"→ARS is
                        # distance 2 but a pure coincidence — different
                        # sounds). Same first-two consonants = same sound.
                        tq_meta = metaphone(tq_clean)
                        cl_meta = metaphone(cl)
                        if (
                            len(tq_meta) >= 3
                            and len(cl_meta) >= 3
                            and tq_meta[:2] == cl_meta[:2]
                            and levenshtein(tq_meta, cl_meta, 2) <= 2
                        ):
                            anchor_count += 1
                            # Phonetic-PREFIX: "rosam" vs "rozanne" — 'ros'
                            # and 'roz' share the same metaphone (s/z both →
                            # S), same SOUND at the start; "rosam" vs
                            # "robustum" ('rob' → RP) is not. A phonetic-
                            # prefix anchor is closer than a loose graze.
                            if (
                                len(tq_clean) >= 3
                                and len(cl) >= 3
                                and metaphone(tq_clean[:3]) == metaphone(cl[:3])
                            ):
                                anchor_prefix_hit = True
            if common == 0 and anchor_count == 0:
                continue
            # cultivar must match if both present
            rc = r["cultivar"]
            if q_cultivar and rc and q_cultivar != rc:
                continue
            if q_cultivar and not rc:
                continue
            # EXACT token overlap dominates the score: a row matching two
            # query tokens exactly IS the plant ("yankee point" → 'Yankee
            # Point' has common=2 and must beat any anchor-only row). Each
            # exact/fuzzy token hit is -3; each cultivar anchor is -1.5
            # (a garbled cultivar token); phonetic-prefix anchors get an
            # extra -1. Non-plant SKUs pay the penalty in every branch.
            score = -3 * common - 1.5 * anchor_count + nonplant_penalty
            if anchor_prefix_hit:
                score -= 1.0
        if score < best_score:
            best_score = score
            best = r
            best_common = common
        elif score == best_score and common > best_common:
            # Tiebreaker: prefer the row with more exact token overlaps.
            best = r
            best_common = common
    return best if best_score <= 2 else None


def match_common(phrase):
    """Match a common-name phrase via alias table."""
    p = phrase.lower().strip()
    for alias, genus in COMMON_ALIASES.items():
        if alias in p:
            return genus
    return None


# --------------------------------------------------------------------------
# Chunk the transcript into plant mentions
# --------------------------------------------------------------------------
# Container sizes actually carried in the catalog — used to split glued
# qty+size tokens ("31-gallon" = "3 1-gallon"): a number that isn't one of
# these is a qty-digit glued onto a size digit.
KNOWN_CONTAINER_SIZES = {"1g", "2g", "3g", "5g", "7g", "15g", "16g", "20g", "24g", "4in"}

SIZE_RE = re.compile(
    r"\b(\d{1,2}\s*(?:gallon|gal|g|inch|in|in\.|inch pot|\")\b|"
    r"(?:four|five|one|two|fifteen|seven|sixteen|twenty|twenty[- ]four)\s*(?:gallon|inch)\b)",
    re.I,
)

QTY_RE = re.compile(
    r"\b(\d{1,3}|(?:twenty[- ]?six|twenty[- ]?four|fifty|forty|thirty|sixty|one|two|three|four|five|six|seven|eight|nine|ten|twelve|fifteen|twenty|hundred))\b",
    re.I,
)


def chunk_transcript(text):
    """Split transcript into segments, each hopefully one plant mention.

    Strategy: split on separators ("and", "plus", commas, periods, newlines,
    "also", "next", "then"), then further split segments that contain two
    botanical names (detected by genus repetition) at the genus boundary.
    """
    text = re.sub(r"[\n\r]+", ", ", text)
    parts = re.split(r",|\band\b|\bplus\b|\balso\b|\bthen\b|\bnext\b", text, flags=re.I)
    chunks = []
    for p in parts:
        p = p.strip().strip(".,;")
        if not p:
            continue
        # If the segment contains TWO genus-level botanical starts (e.g.
        # "ceanothus centennial ... and geranium" already split, but a
        # missed 'and' inside), split at second genus occurrence.
        words = p.split()
        seen_genus = None
        split_at = None
        for i, w in enumerate(words):
            wl = w.lower().strip(".,;")
            if wl in GENUS_INDEX and wl != seen_genus:
                if seen_genus is not None:
                    split_at = i
                    break
                seen_genus = wl
        if split_at:
            chunks.append(" ".join(words[:split_at]))
            chunks.append(" ".join(words[split_at:]))
        else:
            chunks.append(p)
    return [c for c in chunks if c]


def resolve_chunk(chunk):
    """Resolve one chunk to an inventory entry (or best-effort note)."""
    words = chunk.split()

    # Extract size phrase FIRST — "5 gallon" must stay together, otherwise
    # the "5" gets eaten as a quantity and "gallon" loses its number.
    size = None
    chunk_joined = " ".join(words)
    # Hyphenated sizes first ("4-inch", "5-gallon") — Whisper + typing both
    # emit hyphens and the space-aliases below won't match them.
    for alias, canonical in sorted(SIZE_HYPHEN_ALIASES.items(), key=lambda kv: -len(kv[0])):
        if re.search(r"\b" + re.escape(alias) + r"\b", chunk_joined, re.I):
            size = canonical
            chunk_joined = re.sub(r"\b" + re.escape(alias) + r"\b", " ", chunk_joined, flags=re.I)
            break
    if not size:
        for alias, canonical in sorted(SIZE_ALIASES.items(), key=lambda kv: -len(kv[0])):
            if re.search(r"\b" + re.escape(alias) + r"\b", chunk_joined, re.I):
                size = canonical
                chunk_joined = re.sub(r"\b" + re.escape(alias) + r"\b", " ", chunk_joined, flags=re.I)
                break
    if not size:
        # Fuzzy size: Whisper mangles the size word too ("1-Gellen" →
        # "1 gallon", "fove galln" → "5 gallon"). Match digit/hyphen
        # tokens against the size-word vocabulary with 2-edit tolerance.
        for tok in re.findall(r"\b\d{1,2}[- ]?[a-z]+", chunk_joined, re.I):
            tokl = tok.lower().strip(".,;!?-")
            num_part = re.match(r"(\d{1,2})", tokl)
            word_part = re.sub(r"^[\d\- ]+", "", tokl)
            if not num_part:
                continue
            for word, canonical in (("gallon", "g"), ("gal", "g"), ("inch", "in"), ("in", "in")):
                if levenshtein(word_part, word, 2) <= 2:
                    size = f"{num_part.group(1)}{canonical}"
                    size = {"4in": "4in", "1g": "1g", "2g": "2g", "5g": "5g",
                            "15g": "15g", "20g": "20g", "7g": "7g",
                            "16g": "16g", "24g": "24g"}.get(size, size)
                    # Whisper glues qty+size into one token ("31-gallon" =
                    # "3 1-gallon", "41-gallon" = "4 1-gallon"). If the
                    # number isn't a container size we carry, split it:
                    # trailing 1-2 digits that DO form a known size become
                    # the size, the leading digits re-enter as quantity.
                    if size not in KNOWN_CONTAINER_SIZES:
                        digits = num_part.group(1)
                        for cut in (1, 2):
                            tail = digits[-cut:]
                            if tail and f"{tail}{canonical}" in KNOWN_CONTAINER_SIZES:
                                leading = digits[:-cut]
                                size = f"{tail}{canonical}"
                                if leading:
                                    chunk_joined = f"{leading} {chunk_joined}"
                                break
                    chunk_joined = re.sub(r"\b" + re.escape(tok) + r"\b", " ", chunk_joined, flags=re.I)
                    break
            if size:
                break
    words = chunk_joined.split()

    # Drop Whisper fillers ("Stop.", "um", "and") before matching — they
    # carry no plant meaning and would otherwise poison the botanical match.
    words = strip_whisper_filler(words)
    if not words:
        return {"query": chunk, "matched": False, "note": "Only filler words — nothing to match"}

    # Extract quantity (usually leading or trailing). Handle a digit glued
    # to the size by a hyphen ("48-4-inch") — the size extraction above
    # consumed "4-inch" and left "48-" behind.
    qty = None
    for idx, w in enumerate(words):
        n = parse_number([w.rstrip('-')])
        if n is not None and n <= 500:
            qty = n
            # remove the token (and a following word-number if compound)
            del words[idx]
            if idx < len(words) and words[idx].lower() in NUM_WORDS and words[idx].lower() not in ("hundred",):
                qty += NUM_WORDS[words[idx].lower()]
                del words[idx]
            break

    if not words:
        return {"query": chunk, "matched": False, "note": "Empty mention"}

    # Common-name alias FIRST — when the query starts with a known common
    # name ("rosemary", "california lilac") the alias is unambiguous, while
    # the botanical path can mis-fire phonetically ("rosemary" → RSMR
    # grazes Rhus → RS). Only fall through to botanical when no alias hits.
    row = None
    genus = match_common(chunk_joined)
    if genus:
        gwords = genus.split()
        row = match_botanical(gwords + words[1:], size) or match_botanical(gwords, size)
    # Try botanical match (with the extracted size — without it, a
    # "5 gallon" query can silently resolve to the 1g SKU of the same plant)
    if not row:
        row = match_botanical(words, size)
    # Last resort: cultivar-anchored fuzzy (genus garbled beyond use).
    # Runs AFTER the common-name path so a common name that is also a
    # cultivar ("lavender" → Penstemon 'Lavender') can't hijack the match.
    if not row:
        row = match_botanical(words, size, anchor_allowed=True)

    if not row:
        return {
            "query": chunk, "matched": False,
            "note": f"No match for {chunk_joined!r} — check spelling or try the botanical name",
        }

    return {
        "query": chunk,
        "matched": True,
        "code": row["code"],
        "upc": row["upc"],
        "size": row["size"],
        "price": row["price"],
        "botanical": row["desc"],
        "qty": qty,
        "note": None,
    }


def main():
    if len(sys.argv) > 1 and sys.argv[1] == "-":
        text = sys.stdin.read()
    elif len(sys.argv) > 1:
        text = " ".join(sys.argv[1:])
    else:
        text = sys.stdin.read()

    chunks = chunk_transcript(text)
    results = [resolve_chunk(c) for c in chunks]

    print(json.dumps({"transcript": text, "mentions": results}, indent=2, ensure_ascii=False))

    matched = [r for r in results if r["matched"]]
    print(f"\n--- {len(matched)}/{len(results)} resolved ---", file=sys.stderr)
    for r in results:
        if r["matched"]:
            qty = f" qty={r['qty']}" if r["qty"] else ""
            print(f"  ✓ {r['botanical']} [{r['code']}] {r['size']} ${r['price']}{qty}", file=sys.stderr)
        else:
            print(f"  ✗ {r['query']}: {r['note']}", file=sys.stderr)


if __name__ == "__main__":
    main()
