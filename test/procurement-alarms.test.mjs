import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { ALARM_RULES, evaluateAlarm, evaluateAlarmFixtures } from "../worker/src/lib/procurement_alarms.mjs";

const fixtures = JSON.parse(readFileSync(new URL("./fixtures/wave4/alarm-fixtures.json", import.meta.url)));
const ledger = JSON.parse(readFileSync(new URL("./fixtures/wave4/generated/alarm_ledger.json", import.meta.url)));

test("all five forensic rule families have positive, near-miss, and missing-data fixtures", () => {
  for (const rule of Object.keys(ALARM_RULES)) {
    const rows = fixtures.cases.filter((row) => row.rule === rule);
    assert.deepEqual(new Set(rows.map((row) => row.expected)), new Set(["lead", "clear", "insufficient"]));
  }
});

test("fixtures produce their declared outcomes", () => {
  const evaluations = evaluateAlarmFixtures(fixtures.cases);
  for (let index = 0; index < evaluations.length; index++) {
    assert.equal(evaluations[index].status, fixtures.cases[index].expected, fixtures.cases[index].id);
  }
  assert.deepEqual(evaluations, ledger.evaluations);
});

test("a review lead cannot render without triggering facts, sources, and a counterfactual", () => {
  for (const lead of ledger.evaluations.filter((row) => row.status === "lead")) {
    assert.ok(Object.keys(lead.triggering_facts).length);
    assert.ok(Object.keys(lead.sources).length);
    assert.ok(lead.counterfactual);
    assert.match(lead.language, /Review lead/);
  }
});

test("missing evidence produces an explicit insufficient state", () => {
  const record = fixtures.cases.find((row) => row.id === "date-order-missing");
  const result = evaluateAlarm(record.rule, record);
  assert.deepEqual(result.missing_fields, ["notice_date"]);
  assert.equal(result.status, "insufficient");
  assert.equal(result.language, "No published notice date found for this matter.");
});

test("methodology language never declares wrongdoing", () => {
  assert.doesNotMatch(JSON.stringify(ledger), /\b(corruption|corrupt|concealment|overcharge|fraud|guilty)\b/i);
  assert.equal(ledger.methodology.output_term, "review lead");
  assert.equal(ledger.methodology.human_review_required, true);
});
