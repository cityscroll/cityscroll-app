import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  COST_METERS,
  WAREHOUSE_CACHE_STATES,
  WAREHOUSE_EXPERIMENT_BASE_ROUTES,
  WAREHOUSE_EXPERIMENT_COHORTS,
  WAREHOUSE_COLD_START_FLAG_CAPABILITIES,
  resolveWarehouseExperimentCohorts,
  WAREHOUSE_EXPERIMENT_SAMPLES_PER_COHORT,
  WAREHOUSE_MATERIALIZATION_KINDS,
  buildWarehouseExperimentReport,
  isAllowedRetainedCostKey,
  coldStartFlagRawCohort,
  evaluateRouteScopedWarehouseCandidate,
  evaluateWarehouseExperiment,
  parseColdStartFlagRaw,
  planWarehouseRollback,
  providerDeploymentReceiptSha256,
  validateWarehouseIsolateReuseSample,
} from "./lib/worker_cost_control.mjs";
import { canaryVersionTag } from "./cloudflare_deployment_binding.mjs";
import { runWorkerCostControl } from "./worker_cost_control.mjs";

function flagCapableCapability() {
  return {
    carries_numeric_raw: true,
    documented_source: "$metadata.coldStart",
    status: WAREHOUSE_COLD_START_FLAG_CAPABILITIES.DOCUMENTED_NUMERIC_RAW,
  };
}

function flagAbsentCapability() {
  return {
    carries_numeric_raw: false,
    documented_source: null,
    status: WAREHOUSE_COLD_START_FLAG_CAPABILITIES.ABSENT,
  };
}

function run(overrides = {}) {
  const capability = overrides.cold_start_flag_capability || flagCapableCapability();
  const requiredCohorts = resolveWarehouseExperimentCohorts(capability);
  const result = {
    schema: "cityscroll.warehouse_cost_experiment_run.v1",
    evidence_mode: "actual-production",
    deployed_revision: "a".repeat(40),
    observed_at: "2026-10-08T23:00:00Z",
    workload_id: "fixed-zap-bbl-zap-project-doing-business-v1",
    workload_count: requiredCohorts.length * WAREHOUSE_EXPERIMENT_SAMPLES_PER_COHORT,
    cold_start_flag_capability: capability,
    correctness: {
      input_digest: "inputs", joins_digest: "joins", provenance_digest: "provenance",
      miss_digest: "miss", freshness_digest: "freshness",
    },
    meters: Object.fromEntries(COST_METERS.map((meter) => [meter, 100])),
    error_count: 0,
    ...overrides,
  };
  result.cold_start_flag_capability = overrides.cold_start_flag_capability || capability;
  // Recompute workload_count if caller overrode capability after spread.
  const cohortsForCount = resolveWarehouseExperimentCohorts(result.cold_start_flag_capability);
  if (overrides.workload_count === undefined) {
    result.workload_count = cohortsForCount.length * WAREHOUSE_EXPERIMENT_SAMPLES_PER_COHORT;
  }
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
  if (!overrides.cohorts) {
    result.cohorts = Object.fromEntries(cohortsForCount.map((name, cohortIndex) => [name, {
      sample_count: WAREHOUSE_EXPERIMENT_SAMPLES_PER_COHORT,
      samples: Array.from({ length: WAREHOUSE_EXPERIMENT_SAMPLES_PER_COHORT }, (_, sampleIndex) => {
        const carriesTotals = cohortIndex === 0 && sampleIndex === 0;
        const flagRaw = parseColdStartFlagRaw(name);
        const isolate_observation = result.cold_start_flag_capability.carries_numeric_raw
          ? {
            present: true,
            raw: flagRaw,
            provisional_label: "unverified-raw",
            semantics: "unverified-provider-flag",
          }
          : {
            present: false,
            raw: null,
            provisional_label: "unknown",
            semantics: "unverified-provider-flag",
          };
        return {
          revision: result.deployed_revision,
          native_cpu_ms: carriesTotals ? result.meters.native_cpu_ms : 0,
          collector_cpu_ms: carriesTotals ? result.meters.collector_cpu_ms : 0,
          native_cpu_source: { field: "cpuTime", unit: "milliseconds", precision: "provider" },
          script_version_id: result.provider_deployment.receipt.cloudflare_version.id,
          condition: {
            mode: "bounded-production-execution",
            source: "owned-http-probe",
            isolate_observation,
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
  }
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
  delete candidate.cohorts[coldStartFlagRawCohort("zap-bbl", 1)];
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
    candidate.cohorts[coldStartFlagRawCohort("zap-bbl", 1)].sample_count = count;
    assert.throws(() => evaluate(baseline, candidate), /sample_count|sample counts/);
  }
  const candidate = run(validCandidate);
  candidate.cohorts[coldStartFlagRawCohort("zap-bbl", 1)].sample_count = 99;
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
  candidate.cohorts[coldStartFlagRawCohort("zap-bbl", 1)].samples[0].outcome = "exception";
  candidate.cohorts[coldStartFlagRawCohort("zap-bbl", 1)].samples[0].error_count = 0;
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

test("controlled route-scoped candidate is evaluated under fixed cohorts without inventing savings", () => {
  const baseline = run({
    materialization: { kind: "static-baseline" },
  });
  const candidate = run({
    deployed_revision: "b".repeat(40),
    observed_at: "2026-10-08T23:10:00Z",
    meters: { ...baseline.meters, native_cpu_ms: 80 },
    materialization: {
      kind: "route-scoped-shards",
      routes: ["zap-bbl", "zap-project", "doing-business"],
    },
  });
  const { decision, report } = evaluateRouteScopedWarehouseCandidate({
    baseline,
    candidate,
    acquiredDeployments: acquiredDeployments(baseline, candidate),
  });
  assert.equal(decision.decision, "candidate-retained");
  assert.equal(decision.financial_savings_confirmed, false);
  assert.equal(report.materialization_kind, "route-scoped-shards");
  assert.equal(report.shipped_savings_claimed, false);
  assert.equal(report.startup_time.status, "unknown");
  assert.equal(report.invocation_cpu.field, "cpuTime");
  assert.notEqual(report.startup_time.status, report.invocation_cpu.source);

  const wholeKv = run({
    deployed_revision: "c".repeat(40),
    observed_at: "2026-10-08T23:20:00Z",
    materialization: { kind: "whole-kv-materialization" },
  });
  assert.throws(
    () => evaluateRouteScopedWarehouseCandidate({
      baseline,
      candidate: wholeKv,
      acquiredDeployments: acquiredDeployments(baseline, wholeKv),
    }),
    /route-scoped-shards/,
  );
  assert.ok(WAREHOUSE_MATERIALIZATION_KINDS.includes("route-scoped-shards"));
});

test("route-scoped materialization routes must be canonical HTTP route cohorts", () => {
  const baseline = run({ materialization: { kind: "static-baseline" } });
  for (const bad of [
    "https://example.invalid/zap",
    "/zap-bbl?x=1",
    "accountId",
    "zap-bbl:cold_start_flag_raw=1",
    "cron:0 8 * * *",
  ]) {
    const candidate = run({
      deployed_revision: "b".repeat(40),
      observed_at: "2026-10-08T23:10:00Z",
      meters: { ...baseline.meters, native_cpu_ms: 80 },
      materialization: { kind: "route-scoped-shards", routes: [bad] },
    });
    assert.throws(
      () => evaluateRouteScopedWarehouseCandidate({
        baseline,
        candidate,
        acquiredDeployments: acquiredDeployments(baseline, candidate),
      }),
      /canonical HTTP route cohorts/,
      bad,
    );
  }
});

test("rollback evidence restores original baseline a after retained tip b regresses", () => {
  const revisionA = "a".repeat(40);
  const revisionB = "b".repeat(40);
  const baselineA = run({
    deployed_revision: revisionA,
    materialization: { kind: "static-baseline" },
  });
  const retainedB = run({
    deployed_revision: revisionB,
    observed_at: "2026-10-08T23:10:00Z",
    meters: { ...baselineA.meters, native_cpu_ms: 80 },
    materialization: {
      kind: "route-scoped-shards",
      routes: ["zap-bbl", "zap-project", "doing-business"],
    },
  });
  const retained = evaluate(baselineA, retainedB);
  assert.equal(retained.decision, "candidate-retained");
  assert.equal(retained.baseline_identity.deployed_revision, revisionA);
  assert.equal(retained.candidate_identity.deployed_revision, revisionB);
  assert.equal(retained.baseline_identity.evidence_source, "cloudflare-deployment-receipt+health");
  assert.match(retained.candidate_identity.provider_receipt_sha256, /^[a-f0-9]{64}$/);

  // Live tip is still b, but meters now regress versus original a → reject tip, restore a.
  const liveBRegressed = run({
    deployed_revision: revisionB,
    observed_at: "2026-10-08T23:40:00Z",
    meters: { ...baselineA.meters, native_cpu_ms: 80, kv_reads: 120 },
    materialization: retainedB.materialization,
  });
  const followOn = evaluate(baselineA, liveBRegressed);
  assert.equal(followOn.decision, "candidate-rejected");
  assert.equal(followOn.operation_recommendation, "retain-baseline");
  assert.deepEqual(followOn.regressions, ["kv_reads"]);
  assert.equal(followOn.baseline_identity.deployed_revision, revisionA);
  assert.equal(followOn.candidate_identity.deployed_revision, revisionB);
  assert.equal(followOn.candidate_identity.provider_receipt_sha256, retained.candidate_identity.provider_receipt_sha256);

  const rollback = planWarehouseRollback({
    retainedDecision: retained,
    followOnDecision: followOn,
  });
  assert.equal(rollback.action, "rollback-to-baseline");
  assert.equal(rollback.restore_to_revision, revisionA);
  assert.equal(rollback.prior_retained_revision, revisionB);
  assert.equal(rollback.live_tip_revision, revisionB);
  assert.deepEqual(rollback.baseline_identity, retained.baseline_identity);
  assert.deepEqual(rollback.candidate_identity, retained.candidate_identity);
  assert.equal(rollback.chain[0].role, "original-baseline");
  assert.equal(rollback.chain[1].role, "retained-candidate");
  assert.equal(rollback.chain[2].role, "rollback-to-baseline");
  assert.equal(rollback.chain[0].revision, revisionA);
  assert.equal(rollback.chain[1].revision, revisionB);
  assert.equal(rollback.chain[2].revision, revisionA);
  assert.equal(rollback.shipped_savings_claimed, false);

  // Unrelated retained decision (different A'/B') cannot be paired with this follow-on.
  const otherA = run({
    deployed_revision: "c".repeat(40),
    observed_at: "2026-10-08T22:00:00Z",
    materialization: { kind: "static-baseline" },
  });
  const otherB = run({
    deployed_revision: "d".repeat(40),
    observed_at: "2026-10-08T22:10:00Z",
    meters: { ...otherA.meters, native_cpu_ms: 80 },
    materialization: {
      kind: "route-scoped-shards",
      routes: ["zap-bbl", "zap-project", "doing-business"],
    },
  });
  const unrelatedRetained = evaluate(otherA, otherB);
  assert.equal(unrelatedRetained.decision, "candidate-retained");
  assert.throws(
    () => planWarehouseRollback({ retainedDecision: unrelatedRetained, followOnDecision: followOn }),
    /follow-on baseline identity must match/,
  );

  // Unrelated follow-on rejecting decision for a different pair.
  const unrelatedFollowOn = evaluate(otherA, run({
    deployed_revision: "d".repeat(40),
    observed_at: "2026-10-08T22:40:00Z",
    meters: { ...otherA.meters, native_cpu_ms: 80, kv_reads: 120 },
    materialization: otherB.materialization,
  }));
  assert.equal(unrelatedFollowOn.decision, "candidate-rejected");
  assert.throws(
    () => planWarehouseRollback({ retainedDecision: retained, followOnDecision: unrelatedFollowOn }),
    /follow-on baseline identity must match/,
  );

  // Swapped baseline/candidate on the follow-on decision object.
  const swapped = {
    ...followOn,
    baseline_identity: followOn.candidate_identity,
    candidate_identity: followOn.baseline_identity,
  };
  assert.throws(
    () => planWarehouseRollback({ retainedDecision: retained, followOnDecision: swapped }),
    /follow-on baseline identity must match|follow-on candidate identity must match/,
  );

  // Follow-on whose candidate is not the live tip B (different revision identity).
  const otherLive = run({
    deployed_revision: "e".repeat(40),
    observed_at: "2026-10-08T23:50:00Z",
    meters: { ...baselineA.meters, native_cpu_ms: 80, kv_reads: 120 },
    materialization: retainedB.materialization,
  });
  const wrongTipFollowOn = evaluate(baselineA, otherLive);
  assert.equal(wrongTipFollowOn.decision, "candidate-rejected");
  assert.throws(
    () => planWarehouseRollback({ retainedDecision: retained, followOnDecision: wrongTipFollowOn }),
    /follow-on candidate identity must match/,
  );

  assert.throws(
    () => planWarehouseRollback({ retainedDecision: followOn, followOnDecision: followOn }),
    /previously retained candidate/,
  );
});

test("isolate reuse is distinct from index-cold reset and never invents cold or warm", () => {
  const reuse = validateWarehouseIsolateReuseSample({
    cache_state: "isolate-reuse-hit",
    native_cpu_ms: 2,
  });
  assert.equal(reuse.isolate_reuse, true);
  assert.equal(reuse.index_cold_reset, false);
  assert.equal(reuse.semantic_cold_warm, "unknown");

  const reset = validateWarehouseIsolateReuseSample({
    cache_state: "index-cold-reset",
    native_cpu_ms: 40,
  });
  assert.equal(reset.isolate_reuse, false);
  assert.equal(reset.index_cold_reset, true);
  assert.equal(reset.semantic_cold_warm, "unknown");

  assert.throws(
    () => validateWarehouseIsolateReuseSample({ cache_state: "isolate-reuse-hit", cold_start: true }),
    /cold_start/,
  );
  assert.throws(
    () => validateWarehouseIsolateReuseSample({ cache_state: "isolate-reuse-hit", isolate_class: "warm" }),
    /isolate_class/,
  );
  assert.throws(
    () => validateWarehouseIsolateReuseSample({ cache_state: "isolate-reuse-hit", startup_time_ms: 12 }),
    /startup_time_ms/,
  );
  assert.ok(WAREHOUSE_CACHE_STATES.includes("isolate-reuse-hit"));
});

test("experiment report distinguishes startup time from invocation CPU and never claims shipped savings", () => {
  const baseline = run();
  const rejectedCandidate = run({
    deployed_revision: "b".repeat(40),
    observed_at: "2026-10-08T23:10:00Z",
    meters: { ...baseline.meters, native_cpu_ms: 80, kv_reads: 101 },
  });
  const decision = evaluate(baseline, rejectedCandidate);
  assert.equal(decision.decision, "candidate-rejected");
  const report = buildWarehouseExperimentReport(decision, {
    materializationKind: "whole-kv-materialization",
  });
  assert.equal(report.rejected, true);
  assert.equal(report.shipped_savings_claimed, false);
  assert.equal(report.financial_savings_confirmed, false);
  assert.equal(report.startup_time.status, "unknown");
  assert.equal(report.startup_time.reason, "provider-capability");
  assert.ok(report.startup_time.never_infer_from.includes("startup-time"));
  assert.equal(report.invocation_cpu.field, "cpuTime");
  assert.equal(report.invocation_cpu.candidate_normalized_ms, decision.candidate_normalized.native_cpu_ms);
  assert.notEqual(report.startup_time.status, "measured");
  assert.notEqual(report.startup_time, report.invocation_cpu);
});

test("route-scoped materialization keys pass the closed retained-key allowlist with fixed domains", () => {
  assert.equal(isAllowedRetainedCostKey("materialization"), true);
  assert.equal(isAllowedRetainedCostKey("routes"), true);
  assert.equal(isAllowedRetainedCostKey("kind"), true);
  assert.equal(isAllowedRetainedCostKey("accountId"), false);

  const baseline = run({ materialization: { kind: "static-baseline" } });
  const candidate = run({
    deployed_revision: "b".repeat(40),
    observed_at: "2026-10-08T23:10:00Z",
    meters: { ...baseline.meters, native_cpu_ms: 80 },
    materialization: {
      kind: "route-scoped-shards",
      routes: ["zap-bbl", "zap-project", "doing-business"],
    },
  });
  // evaluateWarehouseExperiment assertSanitized must accept materialization under closed schema.
  const decision = evaluateWarehouseExperiment({
    baseline,
    candidate,
    acquiredDeployments: acquiredDeployments(baseline, candidate),
  });
  assert.equal(decision.decision, "candidate-retained");

  const polluted = run({
    deployed_revision: "c".repeat(40),
    observed_at: "2026-10-08T23:20:00Z",
    meters: { ...baseline.meters, native_cpu_ms: 80 },
    materialization: {
      kind: "route-scoped-shards",
      routes: ["zap-bbl"],
      accountId: "nope",
    },
  });
  assert.throws(
    () => evaluateWarehouseExperiment({
      baseline,
      candidate: polluted,
      acquiredDeployments: acquiredDeployments(baseline, polluted),
    }),
    /forbidden|unsupported fields/,
  );
});


test("flag-less Tail-backed warehouse runs partition by route and keep cold_start_flag_raw unknown", () => {
  const baseline = run({ cold_start_flag_capability: flagAbsentCapability() });
  const candidate = run({
    cold_start_flag_capability: flagAbsentCapability(),
    deployed_revision: "b".repeat(40),
    observed_at: "2026-10-08T23:10:00Z",
    meters: { ...baseline.meters, native_cpu_ms: 80 },
  });
  assert.deepEqual(
    resolveWarehouseExperimentCohorts(baseline.cold_start_flag_capability),
    [...WAREHOUSE_EXPERIMENT_BASE_ROUTES],
  );
  assert.equal(baseline.workload_count, WAREHOUSE_EXPERIMENT_BASE_ROUTES.length * WAREHOUSE_EXPERIMENT_SAMPLES_PER_COHORT);
  const decision = evaluate(baseline, candidate);
  assert.equal(decision.decision, "candidate-retained");
  assert.equal(decision.cold_start_flag_raw.status, "unknown");
  assert.equal(decision.cold_start_flag_capability.carries_numeric_raw, false);
  assert.equal(decision.financial_savings_confirmed, false);
});

test("flag-capable sources still require every raw 0/1 partition", () => {
  const baseline = run(); // flag-capable default
  const incomplete = run({
    deployed_revision: "b".repeat(40),
    observed_at: "2026-10-08T23:10:00Z",
    meters: { ...baseline.meters, native_cpu_ms: 80 },
  });
  const missing = coldStartFlagRawCohort("browse", 0);
  delete incomplete.cohorts[missing];
  // Keep matched workload_count so the missing raw partition is the fail-closed signal.
  assert.throws(() => evaluate(baseline, incomplete), /missing browse:cold_start_flag_raw=0/);
});

test("flag-less sources fail when a route cohort is missing", () => {
  const baseline = run({ cold_start_flag_capability: flagAbsentCapability() });
  const incomplete = run({
    cold_start_flag_capability: flagAbsentCapability(),
    deployed_revision: "b".repeat(40),
    observed_at: "2026-10-08T23:10:00Z",
    meters: { ...baseline.meters, native_cpu_ms: 80 },
  });
  delete incomplete.cohorts.browse;
  // Keep matched workload_count so the missing route cohort is the fail-closed signal.
  assert.throws(() => evaluate(baseline, incomplete), /missing browse/);
});

test("flag-less sources reject fabricated cold_start_flag_raw partitions", () => {
  const baseline = run({ cold_start_flag_capability: flagAbsentCapability() });
  const fabricated = run({
    cold_start_flag_capability: flagAbsentCapability(),
    deployed_revision: "b".repeat(40),
    observed_at: "2026-10-08T23:10:00Z",
    meters: { ...baseline.meters, native_cpu_ms: 80 },
  });
  const fakeName = coldStartFlagRawCohort("browse", 1);
  fabricated.cohorts[fakeName] = structuredClone(fabricated.cohorts.browse);
  for (const sample of fabricated.cohorts[fakeName].samples) {
    sample.condition.isolate_observation = {
      present: true,
      raw: 1,
      provisional_label: "unverified-raw",
      semantics: "unverified-provider-flag",
    };
  }
  assert.throws(
    () => evaluate(baseline, fabricated),
    /fabricated cold_start_flag_raw|flag-less source must not supply/,
  );
});

test("experiment arms fail closed when cold_start_flag_capability values diverge", () => {
  const baseline = run({ cold_start_flag_capability: flagAbsentCapability() });
  const candidate = run({
    cold_start_flag_capability: flagCapableCapability(),
    deployed_revision: "b".repeat(40),
    observed_at: "2026-10-08T23:10:00Z",
    meters: { ...baseline.meters, native_cpu_ms: 80 },
  });
  assert.throws(
    () => evaluate(baseline, candidate),
    /cold_start_flag_capability is not matched/,
  );
});
