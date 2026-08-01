#!/usr/bin/env bash
# Verify gate for ontology engine + multi-dimension autonomous flywheel.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

echo "== ontology registry + intelligence flywheel =="
node --test test/ontology_registry.test.mjs test/intelligence_flywheel.test.mjs

echo "== multi-dimension flywheel characterization =="
node --test test/multi_flywheel.test.mjs test/multi_flywheel_dimensions.test.mjs

echo "== cross-spine fixture suite =="
node tools/cross_spine_validate.mjs

echo "== multi flywheel emit (fixture) =="
OUT="${TMPDIR:-/tmp}/cs-multi-flywheel-verify-$$"
node tools/flywheel-run.mjs --fixture --emit "$OUT" --generated-at 1970-01-01T00:00:00.000Z
test -f "$OUT/queue.json"
test -f "$OUT/receipt.json"
test -f "$OUT/cards.jsonl"
python3 - <<PY
import json
q=json.load(open("$OUT/queue.json"))
assert q["schema"]=="cityscroll.multi_flywheel_queue.v0", q.get("schema")
assert q["stats"]["card_count"]>=1
dims=set(c["dimension"] for c in q["cards"])
assert dims, "expected at least one dimension in queue"
for c in q["cards"]:
    assert c.get("verify"), c.get("id")
    assert c.get("demo_win"), c.get("id")
print("queue ok cards", q["stats"]["card_count"], "dims", sorted(dims), "hash", q.get("content_hash"))
PY

echo "== legacy intelligence flywheel still works =="
OUT2="${TMPDIR:-/tmp}/cs-ontology-flywheel-verify-$$"
node tools/intelligence_flywheel.mjs --fixture --emit-cards "$OUT2" --generated-at 1970-01-01T00:00:00.000Z
test -f "$OUT2/receipt.json"

echo "verify_multi_flywheel: OK"
