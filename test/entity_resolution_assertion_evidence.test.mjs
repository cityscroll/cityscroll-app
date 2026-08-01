import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { buildAssertionEvidence } from "../entity_resolution/review/assertion_evidence.mjs";

const fixture = JSON.parse(readFileSync(
  new URL("../worker/test/fixtures/assertion_evidence.json", import.meta.url),
  "utf8",
));

test("conflicting amount and date assertions remain source-attributed", () => {
  const evidence = buildAssertionEvidence(fixture.left, fixture.right);
  assert.equal(evidence.version, "assertion_interpretation_v1");
  assert.deepEqual(evidence.conflicts.map((entry) => entry.fact), ["contract_amount", "start_date"]);

  const amount = evidence.conflicts[0];
  assert.deepEqual(amount.assertions.map((assertion) => ({
    classification: assertion.classification,
    source: assertion.source_system,
    field: assertion.source_field,
    value: assertion.value,
  })), [
    {
      classification: "source_assertion",
      source: "city_record",
      field: "contract_amount",
      value: "$1,000,000.00",
    },
    {
      classification: "source_assertion",
      source: "checkbook",
      field: "prime_contract_current_amount",
      value: "1250000",
    },
  ]);
  assert.equal(amount.assertions[0].source_record_id, fixture.left.source_record_id);
  assert.equal(amount.assertions[1].source_url, fixture.right.source_url);
});

test("CityScroll comparison is explicit interpretation and never silently resolves a conflict", () => {
  const evidence = buildAssertionEvidence(fixture.left, fixture.right);
  for (const conflict of evidence.conflicts) {
    assert.equal(conflict.interpretation.classification, "cityscroll_interpretation");
    assert.equal(conflict.interpretation.status, "conflict");
    assert.equal(conflict.interpretation.resolution, "unresolved");
    assert.equal(Object.hasOwn(conflict.interpretation, "selected_value"), false);
  }
  assert.deepEqual(evidence.conflicts[0].interpretation.comparison_values, [1000000, 1250000]);
  assert.deepEqual(evidence.conflicts[1].interpretation.comparison_values, ["2026-07-01", "2026-07-15"]);
});

test("equivalent assertions are not mislabeled as conflicts", () => {
  const evidence = buildAssertionEvidence(fixture.left, fixture.right);
  assert.equal(evidence.conflicts.some((entry) => entry.fact === "end_date"), false);
});
