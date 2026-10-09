import assert from "node:assert/strict";
import test from "node:test";

import {
  COST_METERS,
  WAREHOUSE_EXPERIMENT_COHORTS,
  WAREHOUSE_EXPERIMENT_SAMPLES_PER_COHORT,
  evaluateWarehouseExperiment,
} from "./lib/worker_cost_control.mjs";

function run(overrides = {}) {
  const result = {
    schema: "cityscroll.warehouse_cost_experiment_run.v1",
    evidence_mode: "actual-production",
    deployed_revision: "a".repeat(40),
    observed_at: "2026-10-08T23:00:00Z",
    workload_id: "fixed-zap-bbl-zap-project-doing-business-v1",
    workload_count: 10,
    correctness: {
      input_digest: "inputs", joins_digest: "joins", provenance_digest: "provenance",
      miss_digest: "miss", freshness_digest: "freshness",
    },
    meters: Object.fromEntries(COST_METERS.map((meter) => [meter, 100])),
    error_count: 0,
    ...overrides,
  };
  result.cohorts ||= Object.fromEntries(WAREHOUSE_EXPERIMENT_COHORTS.map((name, cohortIndex) => [name, {
    sample_count: WAREHOUSE_EXPERIMENT_SAMPLES_PER_COHORT,
    samples: Array.from({ length: WAREHOUSE_EXPERIMENT_SAMPLES_PER_COHORT }, (_, sampleIndex) => {
      const carriesTotals = cohortIndex === 0 && sampleIndex === 0;
      return {
        revision: result.deployed_revision,
        native_cpu_ms: carriesTotals ? result.meters.native_cpu_ms : 0,
        collector_cpu_ms: carriesTotals ? result.meters.collector_cpu_ms : 0,
        native_cpu_source: { field: "cpuTime", unit: "milliseconds", precision: "provider" },
        condition: {
          mode: "provider-observed", source: "$metadata.coldStart", cold_start: name.endsWith(":cold"),
        },
        outcome: carriesTotals && result.error_count > 0 ? "exception" : "ok",
        operations: Object.fromEntries(
          ["kv_reads", "kv_writes", "d1_rows_read", "d1_rows_written", "storage_bytes"].map((meter) => [
            meter,
            { attempted: carriesTotals ? result.meters[meter] : 0, confirmed: carriesTotals ? result.meters[meter] : 0 },
          ]),
        ),
        error_count: carriesTotals ? result.error_count : 0,
      };
    }),
  }]));
  return result;
}

test("the fixed three-lookup experiment retains a Pareto-improving candidate", () => {
  const baseline = run();
  const candidate = run({
    deployed_revision: "b".repeat(40), observed_at: "2026-10-08T23:10:00Z",
    meters: { ...baseline.meters, native_cpu_ms: 80 },
  });
  const result = evaluateWarehouseExperiment({ baseline, candidate });
  assert.equal(result.decision, "candidate-retained");
  assert.equal(result.operation_recommendation, "retain-candidate");
  assert.equal(result.financial_savings_confirmed, false);
});

test("a cross-meter regression rejects the candidate and records no shipped savings", () => {
  const baseline = run();
  const candidate = run({
    deployed_revision: "b".repeat(40), observed_at: "2026-10-08T23:10:00Z",
    meters: { ...baseline.meters, native_cpu_ms: 80, kv_reads: 101 },
  });
  const result = evaluateWarehouseExperiment({ baseline, candidate });
  assert.equal(result.decision, "candidate-rejected");
  assert.equal(result.retained, "baseline");
  assert.equal(result.financial_savings_confirmed, false);
  assert.deepEqual(result.regressions, ["kv_reads"]);
});

test("changed joins, provenance, misses, freshness or cohort coverage fail closed", () => {
  const baseline = run();
  for (const field of ["joins_digest", "provenance_digest", "miss_digest", "freshness_digest"]) {
    const candidate = run({
      deployed_revision: "b".repeat(40), observed_at: "2026-10-08T23:10:00Z",
      correctness: { ...baseline.correctness, [field]: "changed" },
    });
    assert.throws(() => evaluateWarehouseExperiment({ baseline, candidate }), new RegExp(field));
  }
  const candidate = run({ deployed_revision: "b".repeat(40), observed_at: "2026-10-08T23:10:00Z" });
  delete candidate.cohorts["zap-bbl:cold"];
  assert.throws(() => evaluateWarehouseExperiment({ baseline, candidate }), /missing/);
});

test("failed materialization and higher errors retain the static baseline", () => {
  const baseline = run();
  const candidate = run({
    deployed_revision: "b".repeat(40), observed_at: "2026-10-08T23:10:00Z",
    error_count: 1, meters: { ...baseline.meters, native_cpu_ms: 50 },
  });
  assert.equal(evaluateWarehouseExperiment({ baseline, candidate }).decision, "candidate-rejected");
});

test("experiment evidence must be actual, ordered, matched, integral, and privacy-safe", () => {
  const baseline = run();
  const validCandidate = {
    deployed_revision: "b".repeat(40), observed_at: "2026-10-08T23:10:00Z",
  };
  assert.throws(() => evaluateWarehouseExperiment({ baseline, candidate: run({ ...validCandidate, evidence_mode: "fixture" }) }), /actual production/);
  assert.throws(() => evaluateWarehouseExperiment({ baseline, candidate: run({ ...validCandidate, workload_id: "" }) }), /workload_id/);
  assert.throws(() => evaluateWarehouseExperiment({ baseline, candidate: run({ ...validCandidate, observed_at: baseline.observed_at }) }), /follow baseline/);
  assert.throws(() => evaluateWarehouseExperiment({ baseline, candidate: run({ ...validCandidate, meters: { ...baseline.meters, kv_reads: 1.5 } }) }), /integer/);
  assert.throws(() => evaluateWarehouseExperiment({ baseline, candidate: run({ ...validCandidate, correctness: { ...baseline.correctness, request_url: "private" } }) }), /forbidden/);
});

test("experiment cohorts require the fixed matched 100-sample count", () => {
  const baseline = run();
  const validCandidate = { deployed_revision: "b".repeat(40), observed_at: "2026-10-08T23:10:00Z" };
  for (const count of [-1, 1.5]) {
    const candidate = run(validCandidate);
    candidate.cohorts["zap-bbl:cold"].sample_count = count;
    assert.throws(() => evaluateWarehouseExperiment({ baseline, candidate }), /sample_count|sample counts/);
  }
  const candidate = run(validCandidate);
  candidate.cohorts["zap-bbl:cold"].sample_count = 99;
  assert.throws(() => evaluateWarehouseExperiment({ baseline, candidate }), /fixed 100-sample cohort/);
});

test("experiment totals and errors are derived from retained provider samples", () => {
  const baseline = run();
  const candidate = run({
    deployed_revision: "b".repeat(40), observed_at: "2026-10-08T23:10:00Z",
    meters: { ...baseline.meters, native_cpu_ms: 80 },
  });
  candidate.meters.native_cpu_ms = 79;
  assert.throws(() => evaluateWarehouseExperiment({ baseline, candidate }), /does not match retained warehouse samples/);
  candidate.meters.native_cpu_ms = 80;
  candidate.cohorts["zap-bbl:cold"].samples[0].outcome = "exception";
  candidate.cohorts["zap-bbl:cold"].samples[0].error_count = 0;
  assert.throws(() => evaluateWarehouseExperiment({ baseline, candidate }), /failed provider outcome/);
});
