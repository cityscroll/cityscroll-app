import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import test from "node:test";

import { buildTrainPolicy } from "../tools/merge_train_policy.mjs";

const fixture = JSON.parse(fs.readFileSync(new URL("./fixtures/merge-throughput/train-policy/source.json", import.meta.url), "utf8"));

test("reports one, three, five, and observed six-car batches with bounded recommendation", () => {
  const { report, serialization } = buildTrainPolicy(fixture);
  assert.deepEqual(report.measurements.map((measurement) => measurement.batch_size), [1, 3, 5, 6]);
  assert.ok(report.measurements.every((measurement) => measurement.sample_sufficiency.sufficient));
  assert.equal(report.measurements[3].observation_kind, "observed");
  assert.equal(report.measurements[3].ejection_rate.value, 0);
  assert.equal(report.recommendation.status, "recommended");
  assert.equal(report.recommendation.recommended_batch_bound, 5);
  assert.deepEqual(report.ceiling_guard.over_ceiling_observations, [6]);
  assert.equal(report.policy.allgreen_unchanged, true);
  assert.equal(report.composition_guard.same_group_batches_preserved, true);
  assert.equal(report.elder_protection.reservation.seat.number, 1301);
  assert.equal(report.elder_protection.cannot_starve_eligible_elder, true);
  assert.equal(serialization.groups.length, 4);
  assert.ok(serialization.groups.every((group) => group.action === "serialize"));
  assert.match(serialization.watermark_decision.note, /does not implement a watermark remedy/);
});

test("runner saturation cannot increase the recommended bound", () => {
  const baseline = buildTrainPolicy(fixture).report.recommendation.recommended_batch_bound;
  const saturated = structuredClone(fixture);
  for (const observation of saturated.batch_observations) {
    for (const sample of observation.samples) sample.runner_wait_minutes += observation.batch_size * 4;
  }
  const result = buildTrainPolicy(saturated).report.recommendation.recommended_batch_bound;
  assert.ok(result <= baseline);
});

test("missing samples suppress the recommendation instead of inventing confidence", () => {
  const sparse = structuredClone(fixture);
  sparse.batch_observations.find((observation) => observation.batch_size === 5).samples.pop();
  const report = buildTrainPolicy(sparse).report;
  assert.equal(report.recommendation.status, "insufficient-evidence");
  assert.equal(report.recommendation.recommended_batch_bound, null);
});

test("the committed fixture replay is deterministic", () => {
  const output = execFileSync(process.execPath, [
    "tools/merge_train_policy.mjs",
    "--fixture",
    "test/fixtures/merge-throughput",
    "--check",
  ], { encoding: "utf8" });
  assert.match(output, /merge-train policy valid/);
});

test("ALLGREEN is a hard composition guard", () => {
  const invalid = structuredClone(fixture);
  invalid.batch_observations[1].samples[0].grouping_strategy = "ANYGREEN";
  assert.throws(() => buildTrainPolicy(invalid), /ALLGREEN/);
});
