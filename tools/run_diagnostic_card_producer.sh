#!/usr/bin/env bash
# Hourly Desk → engineering-card producer. Pins PATH for the bare launchd
# environment, honors the kill switch, retries queue collection, and never
# writes public resident copy.
set -euo pipefail
PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
export PATH

ROOT="${CITYSCROLL_REPO:-$(cd "$(dirname "$0")/.." && pwd -P)}"
cd "$ROOT"
STATE="${CITYSCROLL_DIAGNOSTIC_CARD_STATE_DIR:-$ROOT/.diagnostic-card-producer}"
mkdir -p "$STATE/receipts" "$STATE/queue"

if [ "${CITYSCROLL_DIAGNOSTIC_CARD_PRODUCER:-on}" = "off" ] \
  || [ "${CITYSCROLL_DIAGNOSTIC_CARD_PRODUCER:-}" = "0" ] \
  || [ "${CITYSCROLL_DIAGNOSTIC_CARD_PRODUCER:-}" = "false" ] \
  || [ -f "$ROOT/.diagnostic-card-producer.off" ] \
  || [ -f "$STATE/.diagnostic-card-producer.off" ]; then
  CITYSCROLL_DIAGNOSTIC_CARD_PRODUCER=off python3 "$ROOT/tools/diagnostic_card_producer.py" \
    --repo-root "$ROOT" --state-dir "$STATE"
  exit 0
fi

QUEUE="$STATE/queue/current.json"
GRAPH_JSON="$ROOT/docs/data-source-graph.json"
ATTEMPTS=0
LIMIT=3
COLLECT_OK=0
while [ "$ATTEMPTS" -lt "$LIMIT" ]; do
  ATTEMPTS=$((ATTEMPTS + 1))
  if node "$ROOT/tools/data_source_graph.mjs" >/dev/null 2>"$STATE/receipts/collect.err" \
    && python3 - "$GRAPH_JSON" "$QUEUE" <<'PY'
import json, sys
from pathlib import Path
src, dest = Path(sys.argv[1]), Path(sys.argv[2])
graph = json.loads(src.read_text(encoding="utf-8"))
queue = graph.get("repair_queue")
if not isinstance(queue, dict):
    raise SystemExit("repair queue missing from desk graph")
dest.parent.mkdir(parents=True, exist_ok=True)
dest.write_text(json.dumps(queue), encoding="utf-8")
PY
  then
    COLLECT_OK=1
    break
  fi
done
if [ "$COLLECT_OK" -ne 1 ]; then
  python3 "$ROOT/tools/diagnostic_card_producer.py" \
    --repo-root "$ROOT" --state-dir "$STATE" --queue "$QUEUE"
  exit $?
fi

exec python3 "$ROOT/tools/diagnostic_card_producer.py" \
  --repo-root "$ROOT" \
  --state-dir "$STATE" \
  --queue "$QUEUE" \
  ${CITYSCROLL_DIAGNOSTIC_CARD_DRY_RUN:+--dry-run}
