import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import { buildKnownFlakeRerun, canonicalJson } from "../tools/known_flake_rerun.mjs";

const read = (file) => JSON.parse(fs.readFileSync(new URL(file, import.meta.url), "utf8"));
const registry = read("../data/known-flake-signatures.v1.json");
const corpus = read("../data/incident-corpus.json");
const source = read("./fixtures/merge-throughput/known-flake-source.json");

function resultFor(input = source) {
  return buildKnownFlakeRerun({ registry, corpus, source: input });
}

test("live routes-focus recoveries are joined to MT-1 and remain bounded", () => {
  const result = resultFor();
  const live = result.receipts.filter((row) => [1367, 1373, 1374].includes(row.pull_request));
  assert.equal(live.length, 3);
  assert.ok(live.every((row) => row.decision.exact_signature_match));
  assert.ok(live.every((row) => row.decision.rerun_count === 1));
  assert.ok(live.every((row) => row.decision.retry_cleared_failure));
  assert.ok(live.every((row) => row.decision.required_aggregate_green));
  assert.ok(live.every((row) => row.ejection_impact.telemetry_ejection_count === 1));
  assert.ok(live.every((row) => row.telemetry_join.required_check_receipt_id));
  assert.equal(result.rates.retries_cleared.value, 3);
});

test("an eligible failure without a retry requests exactly one fresh-runner retry", () => {
  const pending = structuredClone(source);
  pending.observations = [pending.observations[0]];
  pending.observations[0].retry = null;
  const row = resultFor(pending).receipts[0];
  assert.equal(row.decision.eligible, true);
  assert.equal(row.decision.rerun_requested, true);
  assert.equal(row.decision.rerun_count, 1);
  assert.equal(row.decision.action, "request_auto_rerun_once");
  assert.equal(row.decision.required_aggregate_green, false);
});

test("a real failure on the same check is not rerun when its signature is unknown", () => {
  const row = resultFor().receipts.find((receipt) => receipt.pull_request === 1361);
  assert.equal(row.signature.registry_match, false);
  assert.equal(row.decision.eligible, false);
  assert.equal(row.decision.rerun_count, 0);
  assert.equal(row.decision.action, "surface_without_auto_rerun");
});

test("three consistent failures escalate and stop automatic reruns", () => {
  const rows = resultFor().receipts.filter((row) => row.pull_request === 1400);
  assert.deepEqual(rows.map((row) => row.decision.consistent_failure_streak), [1, 2, 3]);
  assert.deepEqual(rows.map((row) => row.decision.action), [
    "surface_after_bounded_rerun",
    "surface_after_bounded_rerun",
    "escalate_real_failure",
  ]);
  assert.equal(rows[2].decision.rerun_count, 0);
  assert.equal(resultFor().rates.escalated_real_failures.value, 2);
});

test("unknown, changed-input, and missing-identity observations never auto-rerun", () => {
  const result = resultFor();
  for (const pullRequest of [1401, 1402, 1403]) {
    const row = result.receipts.find((receipt) => receipt.pull_request === pullRequest);
    assert.equal(row.decision.eligible, false, `PR ${pullRequest} should not be eligible`);
    assert.equal(row.decision.rerun_count, 0, `PR ${pullRequest} should not be rerun`);
  }
  assert.match(result.receipts.find((row) => row.pull_request === 1402).decision.reasons.join(" "), /identity/);
  assert.match(result.receipts.find((row) => row.pull_request === 1403).decision.reasons.join(" "), /identity/);
});

test("a recovery cannot turn the required aggregate green without its declared condition", () => {
  const changed = structuredClone(source);
  changed.observations[0].aggregate.other_required_checks_green = false;
  const row = resultFor(changed).receipts[0];
  assert.equal(row.decision.retry_cleared_failure, true);
  assert.equal(row.decision.required_aggregate_green, false);
  assert.equal(row.declared_success_condition.required_aggregate_green, false);
});

test("replay is deterministic and rates are recomputed from the receipt rows", () => {
  const first = resultFor();
  const second = resultFor(JSON.parse(JSON.stringify(source)));
  assert.equal(canonicalJson(first), canonicalJson(second));
  assert.equal(first.rates.automatic_reruns.denominator, first.receipts.length);
  assert.equal(first.rates.rerun_clears_it_rate.numerator, first.rates.retries_cleared.numerator);
  assert.equal(first.rates.rerun_clears_it_rate.denominator, first.rates.automatic_reruns.numerator);
  assert.equal(first.rates.rerun_clears_it_rate.value, 0.6);
});
