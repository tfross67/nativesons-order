"""Parse clientshoo.xlsx into structured customer data for the delivery portal.

Reads:  clientshoo.xlsx (FileMaker export)
Writes: delivery-data-YYYY-MM-DD.js with window.DELIVERY_CUSTOMERS = [...]

Drops: 'Routing Order', 'Sales Person' per user 2026-07-31.
"""
import json
import re
import sys
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path

import openpyxl

SOURCE_XLSX = Path("/Users/tfross/.hermes/cache/documents/doc_eae129a5d82a_clientshoo.xlsx")
OUTPUT_DIR = Path("/Users/tfross/.hermes/nativesons-order")

# Columns to keep (others are dropped from the customer master export)
KEEP_COLUMNS = [
    "Customer Number", "Name", "Address", "City", "Comment", "Contact",
    "Email Address", "Fax", "Hours of Operation", "Labeling",
    "Mobile/Cell Phone", "Resale Number", "Ship Via",
    "Shipping Address", "Shipping Charge", "Shipping City", "Shipping Name",
    "Shipping State", "Shipping Zip", "State", "Telephone", "Terms",
    "Type", "Website Address", "Zip",
]

# All seven day codes (used in the parsed hours JSON)
DAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"]


# ---------- Hours parsing ----------

def _to24(h, m, ap):
    """Convert 12h h/m/ap to 24h string 'HH:MM'. ap may be None for implicit am."""
    h, m = int(h), int(m or 0)
    if ap and ap.lower() == "pm" and h < 12:
        h += 12
    elif ap and ap.lower() == "am" and h == 12:
        h = 0
    # no ap: assume am (most common case for incomplete data)
    return f"{h:02d}:{m:02d}"


_TIME_RE = re.compile(
    r"(\d{1,2})(?::(\d{2}))?\s*([ap]\.?m\.?)?",
    re.IGNORECASE,
)

_RANGE_DAYS = {
    "mon-fri": {"mon", "tue", "wed", "thu", "fri"},
    "m-f": {"mon", "tue", "wed", "thu", "fri"},
    "mon-sat": {"mon", "tue", "wed", "thu", "fri", "sat"},
    "m-sat": {"mon", "tue", "wed", "thu", "fri", "sat"},
    "mon-sun": set(DAYS),
    "mon-thu": {"mon", "tue", "wed", "thu"},
    "mon-thurs": {"mon", "tue", "wed", "thu"},
    "m-th": {"mon", "tue", "wed", "thu"},
    "mon-wed": {"mon", "tue", "wed"},
    "m-w": {"mon", "tue", "wed"},
    "tue-fri": {"tue", "wed", "thu", "fri"},
    "tue-sat": {"tue", "wed", "thu", "fri", "sat"},
    "thu-mon": {"thu", "fri", "sat", "sun", "mon"},
    "thru-fri": {"mon", "tue", "wed", "thu", "fri"},
    "wed-sun": {"wed", "thu", "fri", "sat", "sun"},
    "w-sun": {"wed", "thu", "fri", "sat", "sun"},
    "thu-sun": {"thu", "fri", "sat", "sun"},
    "thu-sat": {"thu", "fri", "sat"},
    "thu-mon": {"thu", "fri", "sat", "sun", "mon"},
    "thurs-mon": {"thu", "fri", "sat", "sun", "mon"},
    "fri-mon": {"fri", "sat", "sun", "mon"},
}

DAY_ALIASES = {
    "mon": "mon", "m": "mon", "monday": "mon",
    "tue": "tue", "tues": "tue", "tuesday": "tue",
    "wed": "wed", "w": "wed", "wednesday": "wed",
    "thu": "thu", "th": "thu", "thurs": "thu", "thursday": "thu", "r": "thu",
    "fri": "fri", "f": "fri", "friday": "fri",
    "sat": "sat", "saturday": "sat",
    "sun": "sun", "sunday": "sun",
}

CLOSED_PHRASES = [
    r"closed\s+(?:on\s+)?(\w+days?|\w+)",  # "closed Tuesdays", "closed Sundays"
    r"\bclosed\b",
]


def parse_hours(raw):
    """Parse a freeform hours-of-operation string.

    Returns dict:
      {
        "mon": "07:00-16:30" | "closed" | "by appointment" | None,
        ...,
        "sun": "...",
        "earliest_delivery": "06:30" | None,
        "latest_delivery": "16:00" | None,
        "notes": "breaks 9:10-10:00 & 11:30-12:30" | None,
        "raw": "7:00am - 4:30pm M - F",
        "quality": "structured" | "partial" | "raw" | "empty" | "by_appointment",
      }
    """
    empty = {d: None for d in DAYS}
    empty.update({"earliest_delivery": None, "latest_delivery": None,
                  "notes": None, "raw": raw or "", "quality": "empty"})

    if not raw or not str(raw).strip():
        return empty

    s = str(raw).strip()
    result = {**empty, "raw": s}

    sl = s.lower()

    # 'by appointment' / 'call first' / 'varies' — but ONLY if no time pattern exists.
    # Some entries like "Wed - Sun 10am - 5pm, Mon & Tues by appointment" have BOTH
    # a time pattern AND the "by appointment" phrase; in that case keep the parsed
    # times and don't override to by_appointment quality.
    has_time = bool(re.search(
        r"(\d{1,2})(?::(\d{2}))?\s*([ap]\.?m\.?)?\s*[-–to]+\s*(\d{1,2})(?::(\d{2}))?\s*([ap]\.?m\.?)?",
        s, re.IGNORECASE,
    ))
    if re.search(r"\bby appointment\b", sl) and not has_time:
        return {**result, "quality": "by_appointment"}
    if re.search(r"\b(call first|call ahead|please call|call before|call for)\b", sl) \
            and not has_time:
        return {**result, "quality": "by_appointment"}
    if re.search(r"\bvaries\b|\bvariable\b|\bflexible\b|\bany\b|\banytime\b|\bany time\b", sl) \
            and not has_time:
        return {**result, "quality": "by_appointment"}

    # 24/7
    if re.search(r"\b24[/\\]7\b", sl):
        return {**result, **{d: "00:00-24:00" for d in DAYS},
                "quality": "structured"}

    # Find time ranges: 'H[:MM][ap]m - H[:MM][ap]m'
    # Look for the FIRST time range (the main hours), with optional second range
    time_ranges = []
    for m in re.finditer(
        r"(\d{1,2})(?::(\d{2}))?\s*([ap]\.?m\.?)?\s*[-–to]+\s*(\d{1,2})(?::(\d{2}))?\s*([ap]\.?m\.?)?",
        s,
        re.IGNORECASE,
    ):
        h1, m1, ap1, h2, m2, ap2 = m.groups()
        # Require at least one ap marker on either side OR both be obvious
        # (handles '8-5' → '08:00-17:00' assuming am/pm from context)
        # If neither has ap, try to disambiguate by range:
        #   if h2 < h1 and h2 < 12, assume pm on h2
        #   if h2 >= h1 and h2 <= 11, assume pm on h2
        #   default: assume am for first, pm for second
        ih1, im1 = int(h1), int(m1 or 0)
        ih2, im2 = int(h2), int(m2 or 0)
        a1 = (ap1 or "").lower().replace(".", "").replace(" ", "") or None
        a2 = (ap2 or "").lower().replace(".", "").replace(" ", "") or None

        if not a1 and not a2:
            # heuristic: h1 is opening (am unless > 12), h2 is closing (pm unless > 12 or h2 < h1)
            if ih1 > 12:
                a1 = "am"
            if ih2 > 12:
                a2 = "pm"
            elif ih2 < ih1:
                a2 = "pm"
                a1 = a1 or "am"
            else:
                a1 = a1 or "am"
                a2 = "pm"

        time_ranges.append((_to24(ih1, im1, a1), _to24(ih2, im2, a2)))

    if not time_ranges:
        return {**result, "quality": "raw"}

    open_t, close_t = time_ranges[0]

    # Day detection — first check explicit ranges, then look for closed days
    matched_days = set()

    # Look for range like "M-F", "Mon-Fri", "Mon through Fri", "M - F" (with spaces).
    # Also handles full day names: "Monday thru Saturday" → Mon-Sat.
    # We use a normalized form: replace any 1-3 letter day abbreviation with its 2-letter
    # form, then check _RANGE_DAYS. e.g. "monday thru saturday" → "mon thru sat" (no hit)
    # so add explicit handling for "thru/through/to/until/til" connectors.
    thru_pattern = re.search(
        r"\b(mondays?|tuesdays?|wednesdays?|thursdays?|fridays?|saturdays?|sundays?)"
        r"\s+(?:thru|through|to|until|til|-)\s+"
        r"(mondays?|tuesdays?|wednesdays?|thursdays?|fridays?|saturdays?|sundays?)\b",
        sl,
    )
    if thru_pattern:
        start_full, end_full = thru_pattern.groups()
        # Look up canonical code for each
        start = DAY_ALIASES.get(start_full[:3])
        end = DAY_ALIASES.get(end_full[:3])
        if start and end:
            # Walk days from start to end (with wrap-around at sun → mon)
            si = DAYS.index(start)
            ei = DAYS.index(end)
            if ei >= si:
                matched_days = set(DAYS[si:ei+1])
            else:
                # wrap around
                matched_days = set(DAYS[si:] + DAYS[:ei+1])

    if not matched_days:
        for pattern, day_set in _RANGE_DAYS.items():
            # Make spaces optional: "M - F" matches "m-f"
            flex_pattern = pattern.replace("-", r"\s*[-–]\s*")
            if re.search(r"\b" + flex_pattern + r"\b", sl):
                matched_days = day_set
                break

    if not matched_days:
        # Look for individual day tokens (comma-separated or with "and").
        # DAY_ALIASES is keyed by alias → code, so iterate aliases and add the
        # canonical code to matched_days.
        for alias, code in DAY_ALIASES.items():
            if re.search(r"\b" + re.escape(alias) + r"\b", sl):
                matched_days.add(code)

    if not matched_days:
        # Default: weekdays
        matched_days = {"mon", "tue", "wed", "thu", "fri"}

    # Build day dict
    day_dict = {d: None for d in DAYS}
    for d in matched_days:
        day_dict[d] = f"{open_t}-{close_t}"

    # Closed days
    for code in DAYS:
        if code in matched_days:
            continue
        # explicit closed: "closed Sundays", "closed Tuesday"
        # Match any alias of this day code (e.g. "mon", "m", "monday")
        aliases = [a for a, c in DAY_ALIASES.items() if c == code]
        alias_re = "|".join(re.escape(a) for a in sorted(aliases, key=len, reverse=True))
        # plural variants: "Tuesdays" → "Tuesday" + "s"; "Mondays" → "Monday" + "s"; "Sundays" → "Sunday" + "s"
        for phrase in [
            rf"closed\s+(?:on\s+)?(?:{alias_re})(?:s|es)?\b",
        ]:
            if re.search(phrase, sl):
                day_dict[code] = "closed"
                break

    # Earliest delivery annotation
    earliest = None
    m = re.search(
        r"(\d{1,2})(?::(\d{2}))?\s*([ap]\.?m\.?)?\s*earliest\s*(?:delivery)?",
        sl,
    )
    if m:
        h, mm, ap = m.groups()
        earliest = _to24(int(h), int(mm or 0), (ap or "am") if (ap or int(h) < 12) else "pm")

    # Latest delivery annotation
    latest = None
    m = re.search(
        r"(\d{1,2})(?::(\d{2}))?\s*([ap]\.?m\.?)?\s*(?:latest|by)\s*(?:delivery|latest)",
        sl,
    )
    if not m:
        m = re.search(r"deliver(?:y|ies)?\s+(?:anyway\s+)?by\s+(\d{1,2})(?::(\d{2}))?\s*([ap]\.?m\.?)?", sl)
    if m:
        h, mm, ap = m.groups()
        latest = _to24(int(h), int(mm or 0), ap)

    # Notes — anything matching "(...)" or "lunch 12-1" / "breaks: ..."
    notes = None
    notes_match = re.search(r"\(([^)]{3,})\)", s)
    if notes_match:
        notes = notes_match.group(1).strip()
    elif "lunch" in sl or "break" in sl:
        notes_match = re.search(r"((?:lunch|break)[^,]*?(?:\d{1,2}(?::\d{2})?[^,]*))", sl)
        if notes_match:
            notes = notes_match.group(1).strip()

    # Quality assessment
    days_with_hours = sum(1 for d in DAYS if day_dict[d] and day_dict[d] not in ("closed", None))
    if days_with_hours == 0:
        quality = "raw"
    elif days_with_hours == len(matched_days):
        quality = "structured"
    else:
        quality = "partial"

    return {
        **result,
        **day_dict,
        "earliest_delivery": earliest,
        "latest_delivery": latest,
        "notes": notes,
        "quality": quality,
    }


# ---------- Customer assembly ----------

def parse_address(addr, city, state, zip_):
    """Build a single-line address with city/state/zip appended."""
    parts = []
    if addr and str(addr).strip():
        parts.append(str(addr).strip())
    city_line = ", ".join(p for p in [city, state] if p and str(p).strip())
    if zip_ and str(zip_).strip():
        city_line = (city_line + " " + str(zip_).strip()).strip()
    if city_line:
        parts.append(city_line)
    return ", ".join(parts) if parts else None


def parse_customers():
    wb = openpyxl.load_workbook(SOURCE_XLSX, data_only=True, read_only=True)
    ws = wb.active
    rows = list(ws.iter_rows(values_only=True))
    header = list(rows[0])

    col_idx = {h: i for i, h in enumerate(header)}
    customers = []
    skipped = 0
    quality_counts = Counter()

    for r in rows[1:]:
        if not any(c is not None for c in r):
            skipped += 1
            continue

        def cell(col_name):
            i = col_idx.get(col_name)
            if i is None or i >= len(r):
                return None
            v = r[i]
            return v if v is not None else None

        name = str(cell("Name") or "").strip()
        if not name:
            skipped += 1
            continue

        cust_num = str(cell("Customer Number") or "").strip()
        # Strip leading apostrophes FileMaker puts on numeric IDs
        cust_num = cust_num.lstrip("'")

        hours = parse_hours(cell("Hours of Operation"))
        quality_counts[hours["quality"]] += 1

        phone = (str(cell("Telephone") or "").strip() or
                 str(cell("Mobile/Cell Phone") or "").strip() or None)

        addr = parse_address(cell("Address"), cell("City"), cell("State"), cell("Zip"))
        ship_addr = parse_address(cell("Shipping Address"),
                                  cell("Shipping City"),
                                  cell("Shipping State"),
                                  cell("Shipping Zip"))

        # Shipping addr > mailing addr when present and different
        primary_addr = ship_addr if ship_addr and ship_addr != addr else addr

        customer = {
            "id": cust_num or None,
            "name": name,
            "type": str(cell("Type") or "").strip() or None,
            "address": primary_addr,
            "shipping_address": ship_addr,
            "city": str(cell("City") or "").strip() or None,
            "state": str(cell("State") or "").strip() or None,
            "zip": str(cell("Zip") or "").strip() or None,
            "telephone": str(cell("Telephone") or "").strip() or None,
            "mobile": str(cell("Mobile/Cell Phone") or "").strip() or None,
            "contact": str(cell("Contact") or "").strip() or None,
            "email": str(cell("Email Address") or "").strip() or None,
            "comment": str(cell("Comment") or "").strip() or None,
            "terms": str(cell("Terms") or "").strip() or None,
            "resale": str(cell("Resale Number") or "").strip() or None,
            "website": str(cell("Website Address") or "").strip() or None,
            "ship_via": str(cell("Ship Via") or "").strip() or None,
            "hours": hours,
        }
        customers.append(customer)

    wb.close()

    return customers, skipped, dict(quality_counts)


def write_data_js(customers, output_date, secret):
    """Write the signed JS file for the given date.

    Includes a signature so delivery.html can verify the URL is for today's date.
    """
    # Simple signature: SHA-256 of date+secret, first 16 hex chars
    import hashlib
    sig_input = f"delivery:{output_date}:{secret}".encode()
    sig = hashlib.sha256(sig_input).hexdigest()[:16]

    payload = {
        "date": output_date,
        "generated": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "count": len(customers),
        "customers": customers,
    }

    js = (
        "// Auto-generated for the delivery portal. Do not edit by hand.\n"
        f"// Date: {output_date}\n"
        f"// Signature: {sig} (HMAC of date+secret)\n"
        f"window.DELIVERY_DATA = {json.dumps(payload, ensure_ascii=False, separators=(',', ':'))};\n"
        f"window.DELIVERY_SIG = \"{sig}\";\n"
    )
    return js, sig


# ---------- Main ----------

def main():
    if len(sys.argv) < 3:
        print("Usage: parse_customers.py <YYYY-MM-DD> <secret>")
        sys.exit(1)
    output_date = sys.argv[1]
    secret = sys.argv[2]

    print(f"Reading {SOURCE_XLSX}...")
    customers, skipped, quality_counts = parse_customers()
    print(f"Parsed {len(customers)} customers ({skipped} skipped)")
    print(f"Hours quality breakdown:")
    for k, v in sorted(quality_counts.items(), key=lambda x: -x[1]):
        print(f"  {k}: {v} ({100*v/len(customers):.1f}%)")

    js, sig = write_data_js(customers, output_date, secret)

    out_path = OUTPUT_DIR / f"delivery-data-{output_date}.js"
    out_path.write_text(js, encoding="utf-8")
    print(f"Wrote {out_path} ({len(js):,} bytes, sig={sig})")


if __name__ == "__main__":
    main()