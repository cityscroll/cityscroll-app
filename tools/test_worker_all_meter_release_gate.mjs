import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  COST_METERS,
  REQUIRED_COST_COHORTS,
  buildWorkerCostProfile,
  evaluateAllMeterRelease,
} from "./lib/worker_cost_control.mjs";

const revision = "b".repeat(40);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
function profile(profileRevision = revision, totals = {}, samplesPerCohort = 1) {
  const routeCohortCount = REQUIRED_COST_COHORTS.length - 1;
  const samples = REQUIRED_COST_COHORTS.flatMap((cohort, cohortIndex) => Array.from({ length: samplesPerCohort }, (_, sampleIndex) => ({
    cohort,
    condition: cohort.endsWith(":cold") || cohort.endsWith(":warm")
      ? { mode: "provider-observed", source: "$metadata.coldStart", cold_start: cohort.endsWith(":cold") }
      : { mode: "bounded-production-execution" },
    revision: profileRevision,
    native_cpu_ms: cohort === "collector-overhead"
      ? (totals.collector_cpu_ms ?? 1) / samplesPerCohort
      : (totals.native_cpu_ms ?? routeCohortCount) / routeCohortCount / samplesPerCohort,
    native_cpu_source: { field: "cpuTime", unit: "milliseconds", precision: "integer" },
    outcome: "ok", script_version_id: "v",
    operations: Object.fromEntries(
      ["kv_reads", "kv_writes", "d1_rows_read", "d1_rows_written", "storage_bytes"].map((meter) => [
        meter,
        {
          attempted: cohortIndex === 0 && sampleIndex === 0 ? (totals[meter] ?? 0) : 0,
          confirmed: cohortIndex === 0 && sampleIndex === 0 ? (totals[meter] ?? 0) : 0,
        },
      ]),
    ),
    error_count: cohortIndex === 0 && sampleIndex === 0 ? (totals.errors ?? 0) : 0,
  })));
  return buildWorkerCostProfile(samples, {
    revision: profileRevision, observedAt: "2026-10-08T23:30:00Z", durationSeconds: 30, eventCount: samples.length,
  });
}
function receipt(meters = {}, overrides = {}) {
  const deployedRevision = overrides.deployed_revision || revision;
  const measuredMeters = {
    native_cpu_ms: 24,
    collector_cpu_ms: 1,
    kv_reads: 0,
    kv_writes: 0,
    d1_rows_read: 0,
    d1_rows_written: 0,
    storage_bytes: 10,
    ...meters,
  };
  const errors = overrides.errors ?? 0;
  return {
    schema: "cityscroll.all_meter_release.v1",
    evidence_mode: "actual-production",
    deployed_revision: deployedRevision,
    observed_at: overrides.observed_at || "2026-10-08T23:30:00Z",
    workload_id: "fixed-workload-v1",
    workload_count: REQUIRED_COST_COHORTS.length,
    publication: { unchanged: { route_key_puts: 0, manifest_puts: 0 } },
    rum: { full_batch: { accepted: 16, kv_puts: 3 } },
    d1: { authority: "independent", complete: true },
    profile: profile(deployedRevision, { ...measuredMeters, errors }),
    meters: Object.fromEntries(COST_METERS.map((meter) => [meter, measuredMeters[meter]])),
    errors,
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
  assert.equal(result.candidate_normalized.native_cpu_ms, 0.375);
  assert.equal(result.candidate_normalized.collector_cpu_ms, 1);
  assert.equal(result.candidate_populations.native_cpu_ms, REQUIRED_COST_COHORTS.length - 1);
  assert.equal(result.candidate_populations.collector_cpu_ms, 1);
  assert.equal(result.candidate_populations.kv_reads, REQUIRED_COST_COHORTS.length);
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
  for (const malformed of [undefined, -1, 1.5, "3"]) {
    const pairWithMalformedRum = pair();
    pairWithMalformedRum.candidate.rum.full_batch.kv_puts = malformed;
    assert.throws(() => evaluateAllMeterRelease(pairWithMalformedRum), /weighted RUM/);
  }
});

test("release meters cannot contradict provider-native samples", () => {
  const evidence = pair();
  evidence.candidate.meters.native_cpu_ms -= 1;
  assert.throws(() => evaluateAllMeterRelease(evidence), /does not match provider profile samples/);
  const storageEvidence = pair();
  storageEvidence.candidate.meters.storage_bytes -= 1;
  assert.throws(() => evaluateAllMeterRelease(storageEvidence), /storage_bytes does not match provider profile samples/);
});

test("failed provider outcomes cannot be retained as zero errors", () => {
  const evidence = pair();
  const sample = evidence.candidate.profile.cohorts["health:cold"].samples[0];
  sample.outcome = "exception";
  sample.error_count = 0;
  assert.throws(() => evaluateAllMeterRelease(evidence), /failed provider outcome/);
});

test("release profiles require matched cohort sample counts", () => {
  const evidence = pair();
  evidence.candidate.profile = profile(evidence.candidate.deployed_revision, evidence.candidate.meters, 2);
  assert.throws(() => evaluateAllMeterRelease(evidence), /workload_count does not match retained profile samples/);
});

test("the independent D1 control cannot be silently collapsed", () => {
  const { baseline, candidate } = pair();
  candidate.d1.authority = "all-meter-gate";
  assert.throws(() => evaluateAllMeterRelease({ baseline, candidate }), /independent D1/);
});

test("baseline may expose the old write behavior but evidence must stay actual and matched", () => {
  assert.equal(evaluateAllMeterRelease(pair()).pass, true);
  const { baseline, candidate } = pair();
  candidate.workload_count = REQUIRED_COST_COHORTS.length + 1;
  assert.throws(() => evaluateAllMeterRelease({ baseline, candidate }), /workload_count does not match retained profile samples/);
  const invalid = pair();
  invalid.candidate.evidence_mode = "fixture";
  assert.throws(() => evaluateAllMeterRelease(invalid), /actual production/);
});

test("release CLI gates the exact candidate revision from configured evidence", () => {
  const { baseline, candidate } = pair({ native_cpu_ms: 9 });
  const run = (expected) => spawnSync(process.execPath, [
    "tools/worker_cost_control.mjs", "release-evaluate",
    "--baseline-env", "TEST_WORKER_COST_BASELINE",
    "--candidate-env", "TEST_WORKER_COST_CANDIDATE",
    "--expected-candidate-revision", expected,
  ], {
    cwd: ROOT,
    encoding: "utf8",
    env: {
      ...process.env,
      TEST_WORKER_COST_BASELINE: JSON.stringify(baseline),
      TEST_WORKER_COST_CANDIDATE: JSON.stringify(candidate),
    },
  });
  assert.equal(run(candidate.deployed_revision).status, 0);
  const mismatch = run("c".repeat(40));
  assert.notEqual(mismatch.status, 0);
  assert.match(mismatch.stderr, /does not match the release revision/);
});
