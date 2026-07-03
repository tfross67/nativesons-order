#!/usr/bin/env bash
# ============================================================
# setup.sh — One-shot setup for the Native Sons order portal
# Run this from the project root:
#   bash setup.sh
# ============================================================
set -euo pipefail

# Color helpers
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; BLUE='\033[0;34m'; NC='\033[0m'
say()   { echo -e "${BLUE}==>${NC} $1"; }
ok()    { echo -e "${GREEN}✓${NC} $1"; }
warn()  { echo -e "${YELLOW}!${NC} $1"; }
die()   { echo -e "${RED}✗${NC} $1"; exit 1; }

# ----- Preflight -----
say "Preflight checks"
command -v git      >/dev/null || die "git not installed"
command -v gh       >/dev/null || warn "gh CLI not found (we'll use git + token instead)"
command -v supabase >/dev/null || warn "supabase CLI not found — install: brew install supabase/tap/supabase"
command -v deno     >/dev/null || warn "deno not found (only needed for Edge Function deploy)"

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$PROJECT_ROOT"

# ----- Step 1: Supabase schema -----
say "Step 1/4 — Apply Supabase schema"
if [ -t 0 ]; then
  read -rp "  Apply schema to ruwyfesblmaurfuiaofw now? [Y/n] " ans
  ans="${ans:-Y}"
else
  ans="Y"
fi
if [[ "$ans" =~ ^[Yy]$ ]]; then
  if command -v supabase >/dev/null; then
    say "  Linking project…"
    supabase link --project-ref ruwyfesblmaurfuiaofw
    say "  Pushing schema…"
    supabase db push --db-url "postgresql://postgres:$(supabase status 2>/dev/null | awk -F'│' '/DB URL/ {gsub(/ /,"",$3); print $3}')" < supabase/schema.sql \
      || { warn "  supabase db push failed. Falling back to manual instructions."; }
  else
    warn "  Install supabase CLI and run manually, OR paste supabase/schema.sql into:"
    warn "    https://supabase.com/dashboard/project/ruwyfesblmaurfuiaofw/sql"
  fi
else
  warn "  Skipped. Apply supabase/schema.sql manually via the Supabase SQL editor."
fi

# ----- Step 2: Edge Function -----
say "Step 2/4 — Deploy email Edge Function"
if command -v supabase >/dev/null; then
  if [ -t 0 ]; then
    read -rp "  Deploy Edge Function now? [Y/n] " ans
    ans="${ans:-Y}"
  else
    ans="Y"
  fi
  if [[ "$ans" =~ ^[Yy]$ ]]; then
    warn "  You'll be prompted for the AgentMail API key. Get it from https://console.agentmail.to"
    read -rp "  Paste your AgentMail API key (starts with am_us_): " AGENTMAIL_KEY
    supabase functions deploy send-order-email --project-ref ruwyfesblmaurfuiaofw --no-verify-jwt
    supabase secrets set \
      AGENTMAIL_API_KEY="$AGENTMAIL_KEY" \
      AGENTMAIL_INBOX=afterimage@agentmail.to \
      OFFICE_EMAIL=orders@nativeson.com \
      --project-ref ruwyfesblmaurfuiaofw
    ok "  Function deployed."
  fi
else
  warn "  Install supabase CLI: brew install supabase/tap/supabase"
  warn "  Then run from this directory:"
  warn "    supabase functions deploy send-order-email --project-ref ruwyfesblmaurfuiaofw --no-verify-jwt"
  warn "    supabase secrets set AGENTMAIL_API_KEY=am_us_your-key AGENTMAIL_INBOX=afterimage@agentmail.to OFFICE_EMAIL=orders@nativeson.com"
fi

# ----- Step 3: GitHub -----
say "Step 3/4 — Push to GitHub"
REPO="nativesons-order"
if [ -t 0 ]; then
  read -rp "  GitHub username [tfross67]: " GH_USER
  GH_USER="${GH_USER:-tfross67}"
  read -rp "  Create repo $REPO if missing? [Y/n] " ans
  ans="${ans:-Y}"
  if [[ "$ans" =~ ^[Yy]$ ]]; then
    if command -v gh >/dev/null; then
      gh repo create "$GH_USER/$REPO" --public --source=. --remote=origin --push 2>/dev/null \
        || warn "  Repo may already exist or auth failed. Falling back to git."
    fi
  fi
else
  GH_USER="tfross67"
fi

if ! git remote get-url origin >/dev/null 2>&1; then
  git remote add origin "https://github.com/$GH_USER/$REPO.git"
fi

git add -A
if ! git diff --cached --quiet; then
  git commit -m "Initial deploy: Native Sons order portal"
fi
git branch -M main 2>/dev/null || true
git push -u origin main || die "  git push failed. Check your credentials."
ok "  Pushed to GitHub."

# ----- Step 4: Enable GitHub Pages -----
say "Step 4/4 — Enable GitHub Pages"
if command -v gh >/dev/null; then
  gh api -X POST "repos/$GH_USER/$REPO/pages" -f source='{"branch":"main","path":"/"}' 2>/dev/null \
    || warn "  Pages may already be enabled. Check: https://github.com/$GH_USER/$REPO/settings/pages"
  ok "  Pages enabled. Site will be live at:"
  ok "    https://$GH_USER.github.io/$REPO/"
else
  warn "  Enable Pages manually: https://github.com/$GH_USER/$REPO/settings/pages"
  warn "  Source: main branch, / (root)"
fi

echo
ok "Done. Next:"
echo "  1. Edit supabase-config.js and paste your SUPABASE_ANON_KEY"
echo "  2. Edit admin.html and paste your SUPABASE_SERVICE_ROLE_KEY"
echo "  3. Edit admin-config.js and change the admin password"
echo "  4. Commit + push:"
echo "       git add -A && git commit -m 'Configure keys' && git push"
echo "  5. Visit https://$GH_USER.github.io/$REPO/ to test the customer flow"
echo "  6. Visit https://$GH_USER.github.io/$REPO/admin.html to see orders"
