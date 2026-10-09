import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  COST_METERS,
  WAREHOUSE_EXPERIMENT_COHORTS,
  WAREHOUSE_EXPERIMENT_SAMPLES_PER_COHORT,
  evaluateWarehouseExperiment,
  providerDeploymentReceiptSha256,
} from "./lib/worker_cost_control.mjs";

function run(overrides = {}) {
  const result = {
    schema: "cityscroll.warehouse_cost_experiment_run.v1",
    evidence_mode: "actual-production",
    deployed_revision: "a".repeat(40),
    observed_at: "2026-10-08T23:00:00Z",
    workload_id: "fixed-zap-bbl-zap-project-doing-business-v1",
    workload_count: WAREHOUSE_EXPERIMENT_COHORTS.length * WAREHOUSE_EXPERIMENT_SAMPLES_PER_COHORT,
    correctness: {
      input_digest: "inputs", joins_digest: "joins", provenance_digest: "provenance",
      miss_digest: "miss", freshness_digest: "freshness",
    },
    meters: Object.fromEntries(COST_METERS.map((meter) => [meter, 100])),
    error_count: 0,
    ...overrides,
  };
  if (!result.provider_deployment) {
    const receipt = {
      schema: "cityscroll.cloudflare_deployment_binding.v1",
      evidence_mode: "actual-production",
      observed_at: "2026-10-08T22:59:00Z",
      production_health: { source: "cityscroll-production-health", revision: result.deployed_revision },
      cloudflare_version: { source: "cloudflare-versions-api", id: `provider-${result.deployed_revision.slice(0, 12)}` },
    };
    result.provider_deployment = {
      source: "cloudflare-deployment-receipt+health",
      receipt,
      provider_receipt_sha256: providerDeploymentReceiptSha256(receipt),
    };
  }
  result.cohorts ||= Object.fromEntries(WAREHOUSE_EXPERIMENT_COHORTS.map((name, cohortIndex) => [name, {
    sample_count: WAREHOUSE_EXPERIMENT_SAMPLES_PER_COHORT,
    samples: Array.from({ length: WAREHOUSE_EXPERIMENT_SAMPLES_PER_COHORT }, (_, sampleIndex) => {
      const carriesTotals = cohortIndex === 0 && sampleIndex === 0;
      return {
        revision: result.deployed_revision,
        native_cpu_ms: carriesTotals ? result.meters.native_cpu_ms : 0,
        collector_cpu_ms: carriesTotals ? result.meters.collector_cpu_ms : 0,
        native_cpu_source: { field: "cpuTime", unit: "milliseconds", precision: "provider" },
        script_version_id: result.provider_deployment.receipt.cloudflare_version.id,
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

function trustedDeployments(baseline, candidate) {
  return {
    baseline: structuredClone(baseline.provider_deployment),
    candidate: structuredClone(candidate.provider_deployment),
  };
}

function evaluate(baseline, candidate) {
  return evaluateWarehouseExperiment({ baseline, candidate, trustedDeployments: trustedDeployments(baseline, candidate) });
}

test("the fixed three-lookup experiment retains a Pareto-improving candidate", () => {
  const baseline = run();
  const candidate = run({
    deployed_revision: "b".repeat(40), observed_at: "2026-10-08T23:10:00Z",
    meters: { ...baseline.meters, native_cpu_ms: 80 },
  });
  const result = evaluate(baseline, candidate);
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
  const result = evaluate(baseline, candidate);
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
    assert.throws(() => evaluate(baseline, candidate), new RegExp(field));
  }
  const candidate = run({ deployed_revision: "b".repeat(40), observed_at: "2026-10-08T23:10:00Z" });
  delete candidate.cohorts["zap-bbl:cold"];
  assert.throws(() => evaluate(baseline, candidate), /missing/);
});

test("failed materialization and higher errors retain the static baseline", () => {
  const baseline = run();
  const candidate = run({
    deployed_revision: "b".repeat(40), observed_at: "2026-10-08T23:10:00Z",
    error_count: 1, meters: { ...baseline.meters, native_cpu_ms: 50 },
  });
  assert.equal(evaluate(baseline, candidate).decision, "candidate-rejected");
});

test("experiment evidence must be actual, ordered, matched, integral, and privacy-safe", () => {
  const baseline = run();
  const validCandidate = {
    deployed_revision: "b".repeat(40), observed_at: "2026-10-08T23:10:00Z",
  };
  for (const [overrides, error] of [
    [{ ...validCandidate, evidence_mode: "fixture" }, /actual production/],
    [{ ...validCandidate, workload_id: "" }, /workload_id/],
    [{ ...validCandidate, observed_at: baseline.observed_at }, /follow baseline/],
    [{ ...validCandidate, meters: { ...baseline.meters, kv_reads: 1.5 } }, /integer/],
    [{ ...validCandidate, correctness: { ...baseline.correctness, request_url: "private" } }, /forbidden/],
  ]) {
    const candidate = run(overrides);
    assert.throws(() => evaluate(baseline, candidate), error);
  }
});

test("experiment cohorts require the fixed matched 100-sample count", () => {
  const baseline = run();
  const validCandidate = { deployed_revision: "b".repeat(40), observed_at: "2026-10-08T23:10:00Z" };
  for (const count of [-1, 1.5]) {
    const candidate = run(validCandidate);
    candidate.cohorts["zap-bbl:cold"].sample_count = count;
    assert.throws(() => evaluate(baseline, candidate), /sample_count|sample counts/);
  }
  const candidate = run(validCandidate);
  candidate.cohorts["zap-bbl:cold"].sample_count = 99;
  assert.throws(() => evaluate(baseline, candidate), /fixed 100-sample cohort/);
});

test("experiment totals and errors are derived from retained provider samples", () => {
  const baseline = run();
  const candidate = run({
    deployed_revision: "b".repeat(40), observed_at: "2026-10-08T23:10:00Z",
    meters: { ...baseline.meters, native_cpu_ms: 80 },
  });
  candidate.meters.native_cpu_ms = 79;
  assert.throws(() => evaluate(baseline, candidate), /does not match retained warehouse samples/);
  candidate.meters.native_cpu_ms = 80;
  candidate.cohorts["zap-bbl:cold"].samples[0].outcome = "exception";
  candidate.cohorts["zap-bbl:cold"].samples[0].error_count = 0;
  assert.throws(() => evaluate(baseline, candidate), /failed provider outcome/);
});

test("experiment workload normalization equals the retained population", () => {
  const baseline = run();
  const candidate = run({
    deployed_revision: "b".repeat(40), observed_at: "2026-10-08T23:10:00Z",
  });
  baseline.workload_count -= 1;
  candidate.workload_count -= 1;
  assert.throws(() => evaluate(baseline, candidate), /workload_count does not match retained warehouse samples/);
});

test("warehouse evaluation requires independent deployment bindings", () => {
  const baseline = run();
  const candidate = run({
    deployed_revision: "b".repeat(40), observed_at: "2026-10-08T23:10:00Z",
    meters: { ...baseline.meters, native_cpu_ms: 80 },
  });
  assert.throws(() => evaluateWarehouseExperiment({ baseline, candidate }), /independent trusted deployment evidence/);
  const trusted = trustedDeployments(baseline, candidate);
  trusted.candidate.receipt.cloudflare_version.id = "different-provider-version";
  trusted.candidate.provider_receipt_sha256 = providerDeploymentReceiptSha256(trusted.candidate.receipt);
  assert.throws(() => evaluateWarehouseExperiment({
    baseline, candidate, trustedDeployments: trusted,
  }), /trusted deployment evidence/);
});

test("warehouse CLI requires and consumes trusted deployment bindings", () => {
  const baseline = run();
  const candidate = run({
    deployed_revision: "b".repeat(40), observed_at: "2026-10-08T23:10:00Z",
    meters: { ...baseline.meters, native_cpu_ms: 80 },
  });
  const trusted = trustedDeployments(baseline, candidate);
  const dir = mkdtempSync(join(tmpdir(), "cityscroll-warehouse-"));
  try {
    const paths = Object.fromEntries(Object.entries({
      baseline,
      candidate,
      trustedBaseline: trusted.baseline,
      trustedCandidate: trusted.candidate,
    }).map(([name, value]) => {
      const path = join(dir, `${name}.json`);
      writeFileSync(path, JSON.stringify(value));
      return [name, path];
    }));
    const args = [
      "tools/worker_cost_control.mjs", "warehouse-evaluate",
      "--baseline", paths.baseline,
      "--candidate", paths.candidate,
      "--trusted-baseline-deployment", paths.trustedBaseline,
      "--trusted-candidate-deployment", paths.trustedCandidate,
    ];
    const accepted = spawnSync(process.execPath, args, { encoding: "utf8" });
    assert.equal(accepted.status, 0);
    assert.equal(JSON.parse(accepted.stdout).decision, "candidate-retained");
    const missingTrust = spawnSync(process.execPath, args.slice(0, -4), { encoding: "utf8" });
    assert.notEqual(missingTrust.status, 0);
    assert.match(missingTrust.stderr, /trusted-baseline-deployment/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
