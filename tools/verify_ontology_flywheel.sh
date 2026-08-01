#!/usr/bin/env bash
# Verify gate for ontology registry v0 + MAPE intelligence flywheel.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

echo "== ontology registry + flywheel characterization =="
node --test test/ontology_registry.test.mjs test/intelligence_flywheel.test.mjs

echo "== cross-spine fixture suite =="
node tools/cross_spine_validate.mjs

echo "== flywheel emit (fixture) =="
OUT="${TMPDIR:-/tmp}/cs-ontology-flywheel-verify-$$"
node tools/intelligence_flywheel.mjs --fixture --emit-cards "$OUT" --generated-at 1970-01-01T00:00:00.000Z
test -f "$OUT/receipt.json"
test -f "$OUT/cards.jsonl"
python3 - <<PY
import json,sys
r=json.load(open("$OUT/receipt.json"))
assert r["schema"]=="cityscroll.intelligence_receipt.v0", r.get("schema")
assert r["metrics"]["registry_sync_ok"] is True
assert len(r.get("cards_emitted") or [])>0
print("receipt ok cards", len(r["cards_emitted"]), "coverage", r["metrics"]["source_coverage_rate"])
PY

echo "verify_ontology_flywheel: OK"
