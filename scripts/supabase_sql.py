#!/usr/bin/env python3
"""Run SQL on Supabase via the Management API (no DB password needed).

Usage:
  python3 supabase_sql.py "select 1"          # inline SQL
  python3 supabase_sql.py --file q.sql        # SQL from a file

Token: ~/.supabase/access-token (sbp_... personal access token).
Project ref: SUPABASE_PROJECT_REF env, else parsed from supabase/config.toml.
Never prints the token.
"""
import json, os, re, sys, urllib.error, urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
REF = os.environ.get("SUPABASE_PROJECT_REF") or "ruwyfesblmaurfuiaofw"

def token() -> str:
    p = Path.home() / ".supabase" / "access-token"
    t = p.read_text().strip() if p.exists() else ""
    if not t:
        sys.exit("no access token at ~/.supabase/access-token")
    return t

def run(query: str) -> int:
    req = urllib.request.Request(
        f"https://api.supabase.com/v1/projects/{REF}/database/query",
        data=json.dumps({"query": query}).encode(),
        headers={"Authorization": f"Bearer {token()}", "Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=120) as r:
            body = r.read().decode()
            status = r.status
    except urllib.error.HTTPError as e:
        body = e.read().decode()
        status = e.code
    print(f"HTTP {status}")
    try:
        print(json.dumps(json.loads(body), indent=2)[:4000])
    except Exception:
        print(body[:4000])
    return 0 if status in (200, 201) else 1

if __name__ == "__main__":
    if len(sys.argv) > 2 and sys.argv[1] == "--file":
        sys.exit(run(Path(sys.argv[2]).read_text()))
    if len(sys.argv) < 2:
        sys.exit(__doc__)
    sys.exit(run(sys.argv[1]))
