import assert from "node:assert/strict";
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
import { canaryVersionTag } from "./cloudflare_deployment_binding.mjs";
import { runWorkerCostControl } from "./worker_cost_control.mjs";

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
      observed_at: "2026-10-08T22:59:00.000Z",
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
          ["kv_reads", "kv_writes", "d1_rows_read", "d1_rows_written", "storage_bytes", "queue_writes", "analytics_points"].map((meter) => [
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

function acquiredDeployments(baseline, candidate) {
  return {
    baseline: structuredClone(baseline.provider_deployment),
    candidate: structuredClone(candidate.provider_deployment),
  };
}

function evaluate(baseline, candidate) {
  return evaluateWarehouseExperiment({ baseline, candidate, acquiredDeployments: acquiredDeployments(baseline, candidate) });
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
  assert.throws(() => evaluateWarehouseExperiment({ baseline, candidate }), /separately acquired deployment evidence/);
  const acquired = acquiredDeployments(baseline, candidate);
  acquired.candidate.receipt.cloudflare_version.id = "different-provider-version";
  acquired.candidate.provider_receipt_sha256 = providerDeploymentReceiptSha256(acquired.candidate.receipt);
  assert.throws(() => evaluateWarehouseExperiment({
    baseline, candidate, acquiredDeployments: acquired,
  }), /supplied deployment evidence/);
});

test("warehouse command acquires provider status and version-targeted health itself", async () => {
  const baseline = run();
  const candidate = run({
    deployed_revision: "b".repeat(40), observed_at: "2026-10-08T23:10:00Z",
    meters: { ...baseline.meters, native_cpu_ms: 80 },
  });
  const dir = mkdtempSync(join(tmpdir(), "cityscroll-warehouse-"));
  try {
    const paths = Object.fromEntries(Object.entries({ baseline, candidate }).map(([name, value]) => {
      const path = join(dir, `${name}.json`);
      writeFileSync(path, JSON.stringify(value));
      return [name, path];
    }));
    const invocations = [];
    const result = await runWorkerCostControl([
      "warehouse-evaluate",
      "--baseline", paths.baseline,
      "--candidate", paths.candidate,
    ], {
      env: { CLOUDFLARE_API_TOKEN: "injected-test-token" },
      invokeWrangler: async (args) => {
        invocations.push(args);
        if (args[0] === "deployments") return {
          created_on: "2026-10-08T22:59:00.000Z",
          versions: [
            { version_id: baseline.provider_deployment.receipt.cloudflare_version.id, percentage: 95 },
            { version_id: candidate.provider_deployment.receipt.cloudflare_version.id, percentage: 5 },
          ],
        };
        return [
          { id: baseline.provider_deployment.receipt.cloudflare_version.id, annotations: {} },
          {
            id: candidate.provider_deployment.receipt.cloudflare_version.id,
            annotations: { "workers/tag": canaryVersionTag(candidate.deployed_revision) },
          },
        ];
      },
      fetchImpl: async (_url, init) => {
        const override = init.headers["Cloudflare-Workers-Version-Overrides"];
        const revision = override.includes(baseline.provider_deployment.receipt.cloudflare_version.id)
          ? baseline.deployed_revision
          : candidate.deployed_revision;
        return {
          ok: true,
          json: async () => ({ status: "cityscroll-worker ok", environment: "production", commit: revision }),
        };
      },
    });
    assert.equal(result.decision, "candidate-retained");
    assert.deepEqual(invocations, [
      ["deployments", "status", "--json"],
      ["versions", "list", "--json"],
    ]);
    await assert.rejects(() => runWorkerCostControl([
      "warehouse-evaluate", "--baseline", paths.baseline, "--candidate", paths.candidate,
      "--trusted-baseline-deployment", paths.baseline,
    ], { invokeWrangler: async () => ({}) }), /cannot be supplied by callers/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
