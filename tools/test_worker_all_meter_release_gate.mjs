import assert from "node:assert/strict";
import test from "node:test";

import {
  COST_METERS,
  REQUIRED_COST_COHORTS,
  buildWorkerCostProfile,
  evaluateAllMeterRelease,
} from "./lib/worker_cost_control.mjs";

const revision = "b".repeat(40);
function profile() {
  const samples = REQUIRED_COST_COHORTS.map((cohort) => ({
    cohort, condition: { mode: "controlled" }, revision, native_cpu_ms: 1,
    native_cpu_source: { field: "cpuTime", unit: "milliseconds", precision: "integer" },
    outcome: "ok", script_version_id: "v", operations: {}, error_count: 0,
  }));
  return buildWorkerCostProfile(samples, {
    revision, observedAt: "2026-10-08T23:30:00Z", durationSeconds: 30, eventCount: samples.length,
  });
}
function receipt(meters = {}) {
  return {
    schema: "cityscroll.all_meter_release.v1",
    workload_id: "fixed-workload-v1",
    publication: { unchanged: { route_key_puts: 0, manifest_puts: 0 } },
    rum: { full_batch: { accepted: 16, kv_puts: 3 } },
    d1: { authority: "independent", complete: true },
    profile: profile(),
    meters: Object.fromEntries(COST_METERS.map((meter) => [meter, meters[meter] ?? 10])),
    errors: 0,
  };
}

test("a complete tariff-free cost vector passes when no meter regresses", () => {
  const result = evaluateAllMeterRelease({ baseline: receipt(), candidate: receipt({ native_cpu_ms: 9 }) });
  assert.deepEqual(result, {
    schema: "cityscroll.all_meter_release_decision.v1", pass: true, regressions: [], tariff_free: true,
  });
});

test("D1 savings cannot hide redundant KV writes", () => {
  const candidate = receipt({ d1_rows_written: 0, kv_writes: 11 });
  const result = evaluateAllMeterRelease({ baseline: receipt(), candidate });
  assert.equal(result.pass, false);
  assert.deepEqual(result.regressions, ["kv_writes"]);
});

test("incomplete profiles, nonzero unchanged publication and broadened RUM budgets fail", () => {
  const missing = receipt();
  missing.profile.cohorts["queue.digest"] = { status: "unknown", sample_count: null, native_cpu_ms: null };
  assert.throws(() => evaluateAllMeterRelease({ baseline: receipt(), candidate: missing }), /unknown/);
  const publication = receipt();
  publication.publication.unchanged.route_key_puts = 1;
  assert.throws(() => evaluateAllMeterRelease({ baseline: receipt(), candidate: publication }), /zero-write/);
  const rum = receipt();
  rum.rum.full_batch.kv_puts = 4;
  assert.throws(() => evaluateAllMeterRelease({ baseline: receipt(), candidate: rum }), /weighted RUM/);
});

test("the independent D1 control cannot be silently collapsed", () => {
  const candidate = receipt();
  candidate.d1.authority = "all-meter-gate";
  assert.throws(() => evaluateAllMeterRelease({ baseline: receipt(), candidate }), /independent D1/);
});
