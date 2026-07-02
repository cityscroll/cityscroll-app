#!/bin/bash
# Functional suite: drives every shipped feature in a real headless Chromium.
#
#   ./test/functional/run.sh                     # against a local server (started for you, port 8000)
#   CROL_BASE=https://crol-list.org/ ./test/functional/run.sh    # e2e against production
#
# Env: CROL_BASE (default http://localhost:8000/) · CROL_DNS_IP (pin api.crol-list.org if your
# resolver has a stale record) · CROL_SHOTS (screenshot dir). Requires: python3 + playwright
# (pip install playwright && playwright install chromium).
set -u
cd "$(dirname "$0")/../.."   # repo root

SERVER_PID=""
if [ -z "${CROL_BASE:-}" ]; then
  python3 -m http.server 8000 >/dev/null 2>&1 &
  SERVER_PID=$!
  sleep 1
fi
trap '[ -n "$SERVER_PID" ] && kill $SERVER_PID 2>/dev/null' EXIT

FAILED=0
for spec in test/functional/[0-9]*.py; do
  echo "════ $spec ════"
  if ! python3 "$spec"; then FAILED=$((FAILED+1)); fi
  echo
done

if [ "$FAILED" -gt 0 ]; then echo "❌ $FAILED spec file(s) failed"; exit 1; fi
echo "✅ all functional specs passed"
