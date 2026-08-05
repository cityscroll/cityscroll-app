#!/bin/bash
# Functional suite: drives every shipped feature in a real headless Chromium.
#
#   ./test/functional/run.sh                     # against an isolated local server
#   CROL_BASE=https://cityscroll.org/ ./test/functional/run.sh    # e2e against production
#
# Env: CROL_BASE (local server when unset) · CROL_TEST_PORT (default 0 / automatic) ·
# CROL_DNS_IP (pin api.cityscroll.org if your resolver has a stale record) · CROL_SHOTS
# (screenshot dir). Requires: python3 + playwright
# (pip install playwright && playwright install chromium).
set -u
cd "$(dirname "$0")/../.." || exit 1   # repo root

SERVER_PID=""
SERVER_READY_FILE=""
if [ -z "${CROL_BASE:-}" ]; then
  SERVER_READY_FILE="$(mktemp "${TMPDIR:-/tmp}/crol-functional-site.XXXXXX")"
  python3 tools/local_site_server.py \
    --directory site \
    --port "${CROL_TEST_PORT:-0}" \
    --ready-file "$SERVER_READY_FILE" >/dev/null &
  SERVER_PID=$!
  for _ in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20; do
    if [ -s "$SERVER_READY_FILE" ]; then
      IFS= read -r CROL_BASE < "$SERVER_READY_FILE"
      if curl -sf -o /dev/null "$CROL_BASE"; then
        export CROL_BASE
        break
      fi
    fi
    if ! kill -0 "$SERVER_PID" 2>/dev/null; then
      echo "local site server exited before becoming ready" >&2
      exit 1
    fi
    sleep 0.25
  done
  if [ -z "${CROL_BASE:-}" ]; then
    echo "timed out waiting for the local site server" >&2
    exit 1
  fi
fi
cleanup_local_server() {
  [ -z "$SERVER_PID" ] || kill "$SERVER_PID" 2>/dev/null || true
  [ -z "$SERVER_READY_FILE" ] || rm -f "$SERVER_READY_FILE"
}
trap cleanup_local_server EXIT

FAILED=0
for spec in test/functional/[0-9]*.py; do
  echo "════ $spec ════"
  if ! python3 "$spec"; then FAILED=$((FAILED+1)); fi
  echo
done

if [ "$FAILED" -gt 0 ]; then echo "❌ $FAILED spec file(s) failed"; exit 1; fi
echo "✅ all functional specs passed"
