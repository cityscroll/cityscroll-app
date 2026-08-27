import assert from "node:assert/strict";
import test from "node:test";

import {
  PILOT_CASES,
  PILOT_NEGATIVE_CASES,
  PILOT_SCOPE,
  REPORT_ENDPOINT,
  replayPilotCase,
  runPilot,
} from "../tools/cc7_round_trip_pilot.mjs";

test("CC-7 exercises four seeded error classes through structured delivery", () => {
  const pilot = runPilot();
  assert.equal(pilot.pilot_scope, PILOT_SCOPE);
  assert.equal(pilot.report_endpoint, REPORT_ENDPOINT);
  assert.deepEqual(pilot.cases.slice(0, 4).map((item) => item.class), [
    "wrong_identity",
    "wrong_relationship",
    "wrong_grouping",
    "missing_relationship",
  ]);
  for (const item of pilot.cases.slice(0, 4)) {
    assert.equal(item.report.path, "POST /feedback");
    assert.equal(item.report.delivery, "structured correction payload validated locally; no external submission");
    assert.equal(item.report.normalized_target_id, item.report.payload.report_target.target_id);
    assert.equal(item.adjudication.verdict, "confirmed");
    assert.equal(item.adjudication.evidence_complete, true);
    assert.equal(item.source_of_truth_change.applied, true);
    assert.equal(item.source_of_truth_change.changed, true);
    assert.equal(item.after.changed, true);
    assert.notEqual(item.before.visible_result, item.after.visible_result);
  }
});

test("each pilot preserves claim addressability, provenance, and failure origin", () => {
  const origins = new Set([
    "ingestion",
    "normalization",
    "entity_resolution",
    "joining",
    "lifecycle_logic",
    "derived_interpretation",
    "presentation",
  ]);
  const pilot = runPilot();
  for (const [index, item] of pilot.cases.slice(0, PILOT_CASES.length).entries()) {
    const target = PILOT_CASES[index].target;
    assert.match(target.target_id, /^cityscroll\.report_target\.v1\|/);
    assert.match(target.claim_anchor.anchor, /#/);
    assert.ok(target.provenance?.source_record_ids?.length, item.id);
    assert.ok(origins.has(item.failure_origin), item.failure_origin);
    assert.equal(item.report.payload.report_target.claim_anchor.anchor, target.claim_anchor.anchor);
    assert.equal(item.report.payload.report.category, item.report.payload.category);
    assert.equal(item.report.payload.report.explanation, item.report.payload.message);
  }
});

test("insufficient evidence remains unresolved and cannot mutate the source truth", () => {
  const item = replayPilotCase(PILOT_NEGATIVE_CASES[0]);
  assert.equal(item.adjudication.verdict, "unresolved");
  assert.equal(item.adjudication.evidence_complete, false);
  assert.equal(item.source_of_truth_change.applied, false);
  assert.equal(item.source_of_truth_change.changed, false);
  assert.equal(item.source_of_truth_change.reason, "unresolved");
  assert.equal(item.after.changed, false);
  assert.equal(item.before.visible_result, item.after.visible_result);
});

test("replaying the same pilot is deterministic and does not mutate case fixtures", () => {
  const before = JSON.stringify(PILOT_CASES);
  const first = runPilot();
  const second = runPilot();
  assert.deepEqual(second, first);
  assert.equal(JSON.stringify(PILOT_CASES), before);
});
