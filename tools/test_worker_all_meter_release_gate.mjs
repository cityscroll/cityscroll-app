import assert from "node:assert/strict";
import test from "node:test";

import {
  COST_METERS,
  REQUIRED_COST_COHORTS,
  buildWorkerCostProfile,
  evaluateAllMeterRelease,
} from "./lib/worker_cost_control.mjs";

const revision = "b".repeat(40);
function profile(profileRevision = revision) {
  const samples = REQUIRED_COST_COHORTS.map((cohort) => ({
    cohort,
    condition: cohort.endsWith(":cold") || cohort.endsWith(":warm")
      ? { mode: "provider-observed", source: "$metadata.coldStart", cold_start: cohort.endsWith(":cold") }
      : { mode: "bounded-production-execution" },
    revision: profileRevision, native_cpu_ms: 1,
    native_cpu_source: { field: "cpuTime", unit: "milliseconds", precision: "integer" },
    outcome: "ok", script_version_id: "v", operations: {}, error_count: 0,
  }));
  return buildWorkerCostProfile(samples, {
    revision: profileRevision, observedAt: "2026-10-08T23:30:00Z", durationSeconds: 30, eventCount: samples.length,
  });
}
function receipt(meters = {}, overrides = {}) {
  const deployedRevision = overrides.deployed_revision || revision;
  return {
    schema: "cityscroll.all_meter_release.v1",
    evidence_mode: "actual-production",
    deployed_revision: deployedRevision,
    observed_at: overrides.observed_at || "2026-10-08T23:30:00Z",
    workload_id: "fixed-workload-v1",
    workload_count: 10,
    publication: { unchanged: { route_key_puts: 0, manifest_puts: 0 } },
    rum: { full_batch: { accepted: 16, kv_puts: 3 } },
    d1: { authority: "independent", complete: true },
    profile: profile(deployedRevision),
    meters: Object.fromEntries(COST_METERS.map((meter) => [meter, meters[meter] ?? 10])),
    errors: 0,
    ...overrides,
  };
}

function pair(candidateMeters = {}, candidateOverrides = {}) {
  return {
    baseline: receipt({}, {
      deployed_revision: "a".repeat(40), observed_at: "2026-10-08T23:00:00Z",
      publication: { unchanged: { route_key_puts: 400, manifest_puts: 2 } },
      rum: { full_batch: { accepted: 16, kv_puts: 18 } },
    }),
    candidate: receipt(candidateMeters, {
      deployed_revision: "b".repeat(40), observed_at: "2026-10-08T23:10:00Z",
      ...candidateOverrides,
    }),
  };
}

test("a complete tariff-free cost vector passes when no meter regresses", () => {
  const result = evaluateAllMeterRelease(pair({ native_cpu_ms: 9 }));
  assert.equal(result.pass, true);
  assert.deepEqual(result.regressions, []);
  assert.equal(result.tariff_free, true);
  assert.equal(result.candidate_normalized.native_cpu_ms, 0.9);
});

test("D1 savings cannot hide redundant KV writes", () => {
  const result = evaluateAllMeterRelease(pair({ d1_rows_written: 0, kv_writes: 11 }));
  assert.equal(result.pass, false);
  assert.deepEqual(result.regressions, ["kv_writes"]);
});

test("incomplete profiles, nonzero unchanged publication and broadened RUM budgets fail", () => {
  const { baseline, candidate: missing } = pair();
  missing.profile.cohorts.queue = { status: "unknown", sample_count: null, native_cpu_ms: null };
  assert.throws(() => evaluateAllMeterRelease({ baseline, candidate: missing }), /unknown/);
  const { candidate: publication } = pair();
  publication.publication.unchanged.route_key_puts = 1;
  assert.throws(() => evaluateAllMeterRelease({ baseline, candidate: publication }), /zero-write/);
  const { candidate: rum } = pair();
  rum.rum.full_batch.kv_puts = 4;
  assert.throws(() => evaluateAllMeterRelease({ baseline, candidate: rum }), /weighted RUM/);
});

test("the independent D1 control cannot be silently collapsed", () => {
  const { baseline, candidate } = pair();
  candidate.d1.authority = "all-meter-gate";
  assert.throws(() => evaluateAllMeterRelease({ baseline, candidate }), /independent D1/);
});

test("baseline may expose the old write behavior but evidence must stay actual and matched", () => {
  assert.equal(evaluateAllMeterRelease(pair()).pass, true);
  const { baseline, candidate } = pair();
  candidate.workload_count = 11;
  assert.throws(() => evaluateAllMeterRelease({ baseline, candidate }), /equivalent/);
  const invalid = pair();
  invalid.candidate.evidence_mode = "fixture";
  assert.throws(() => evaluateAllMeterRelease(invalid), /actual production/);
});
