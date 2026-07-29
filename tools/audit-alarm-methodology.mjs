import assert from "node:assert/strict";
import { readJson } from "./lib/wave4-build.mjs";

const ledger = readJson("test/fixtures/wave4/generated/alarm_ledger.json");
const text = JSON.stringify(ledger);
assert.equal(ledger.methodology.human_review_required, true);
assert.equal(ledger.methodology.automated_verdict, false);
assert.doesNotMatch(text, /\b(corruption|corrupt|concealment|concealed|overcharge|fraud|guilty)\b/i);
for (const rule of ledger.methodology.rule_families) {
  const rows = ledger.evaluations.filter((row) => row.rule_id === rule);
  assert.deepEqual(new Set(rows.map((row) => row.status)), new Set(["lead", "clear", "insufficient"]));
  for (const row of rows.filter((entry) => entry.status === "lead")) {
    assert.ok(Object.keys(row.triggering_facts).length);
    assert.ok(row.counterfactual);
    assert.ok(Object.keys(row.sources).length);
  }
}
console.log(`audited ${ledger.evaluations.length} alarm fixtures`);
