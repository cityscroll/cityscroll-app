import assert from "node:assert/strict";
import test from "node:test";

import {
  COST_METERS,
  WAREHOUSE_EXPERIMENT_COHORTS,
  evaluateWarehouseExperiment,
} from "./lib/worker_cost_control.mjs";

function run(overrides = {}) {
  return {
    schema: "cityscroll.warehouse_cost_experiment_run.v1",
    workload_count: 10,
    cohorts: Object.fromEntries(WAREHOUSE_EXPERIMENT_COHORTS.map((name) => [name, {
      sample_count: 2, cpu_source: "provider-native-invocation",
    }])),
    correctness: {
      input_digest: "inputs", joins_digest: "joins", provenance_digest: "provenance",
      miss_digest: "miss", freshness_digest: "freshness",
    },
    meters: Object.fromEntries(COST_METERS.map((meter) => [meter, 100])),
    error_count: 0,
    ...overrides,
  };
}

test("the fixed three-lookup experiment retains a Pareto-improving candidate", () => {
  const baseline = run();
  const candidate = run({ meters: { ...baseline.meters, native_cpu_ms: 80 } });
  const result = evaluateWarehouseExperiment({ baseline, candidate });
  assert.equal(result.decision, "candidate-retained");
  assert.equal(result.shipped_savings, true);
});

test("a cross-meter regression rejects the candidate and records no shipped savings", () => {
  const baseline = run();
  const candidate = run({ meters: { ...baseline.meters, native_cpu_ms: 80, kv_reads: 101 } });
  const result = evaluateWarehouseExperiment({ baseline, candidate });
  assert.equal(result.decision, "candidate-rejected");
  assert.equal(result.retained, "baseline");
  assert.equal(result.shipped_savings, false);
  assert.deepEqual(result.regressions, ["kv_reads"]);
});

test("changed joins, provenance, misses, freshness or cohort coverage fail closed", () => {
  const baseline = run();
  for (const field of ["joins_digest", "provenance_digest", "miss_digest", "freshness_digest"]) {
    const candidate = run({ correctness: { ...baseline.correctness, [field]: "changed" } });
    assert.throws(() => evaluateWarehouseExperiment({ baseline, candidate }), new RegExp(field));
  }
  const candidate = run();
  delete candidate.cohorts["lookup.zap-bbl.cold"];
  assert.throws(() => evaluateWarehouseExperiment({ baseline, candidate }), /missing/);
});

test("failed materialization and higher errors retain the static baseline", () => {
  const baseline = run();
  const candidate = run({ error_count: 1, meters: { ...baseline.meters, native_cpu_ms: 50 } });
  assert.equal(evaluateWarehouseExperiment({ baseline, candidate }).decision, "candidate-rejected");
});
