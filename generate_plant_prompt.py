#!/usr/bin/env python3
"""Generate the Whisper initial_prompt vocabulary hint for plant-speech entry.

Whisper mangles Latin botanical names ('cnothis' for 'Ceanothus') because
they're rare tokens. Feeding it a short vocabulary hint biases transcription
toward the real names — the fuzzy matcher then becomes a fallback instead
of the front line.

Prompt = this week's availability genera (what staff actually orders) + the
full master genus list appended. Written to ~/.hermes/plant_speech_prompt.txt
for reference and printed for direct config use.

Usage:
  python3 generate_plant_prompt.py
"""
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent


def load_availability():
    """availability_data.js is valid JS but not strict JSON (double-escaped
    quotes). Load it the same way the portal does — via node."""
    import subprocess

    code = (
        "const fs=require('fs');"
        "eval(fs.readFileSync(process.argv[1],'utf8').replace('window.AVAILABILITY','global.AV'));"
        "console.log(JSON.stringify(global.AV));"
    )
    out = subprocess.run(
        ["node", "-e", code, str(ROOT / "availability_data.js")],
        capture_output=True, text=True, timeout=60,
    )
    if out.returncode != 0:
        return {}
    return json.loads(out.stdout)


def load_master():
    src = (ROOT / "masteritem_full.js").read_text()
    m = re.search(r"=\s*(\[.*\])\s*;?\s*$", src, re.S)
    data = m.group(1) if m else "[]"
    return json.loads(data)


def genera_of(names):
    out = set()
    for n in names:
        parts = str(n or "").split()
        if parts:
            out.add(re.sub(r"[^a-z]", "", parts[0].lower()))
    return sorted(out)


def main():
    av = load_availability()
    master = load_master()

    weekly = genera_of(p.get("botanical") for p in av.get("plants", []))
    all_genus = genera_of(r.get("d") for r in master)

    # Weekly first (staff's actual vocabulary), then any master-only genera.
    # Cap the prompt ~2.5K chars — Whisper's initial_prompt degrades past a
    # few hundred tokens; the weekly genera (what staff actually orders) are
    # the high-value bias and always fit.
    prompt_words = list(weekly)
    for g in all_genus:
        if g not in weekly:
            if len(" ".join(prompt_words + [g])) > 2500:
                break
            prompt_words.append(g)
    prompt = " ".join(prompt_words)

    out = Path.home() / ".hermes" / "plant_speech_prompt.txt"
    out.write_text(prompt)
    print(f"weekly genera: {len(weekly)}  total genera: {len(all_genus)}")
    print(f"prompt: {len(prompt)} chars  -> {out}")
    print(prompt[:200] + " …")


if __name__ == "__main__":
    main()
