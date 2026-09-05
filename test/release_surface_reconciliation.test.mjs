import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import test from "node:test";

import { withTempDir } from "../tools/lib/with_temp_dir.mjs";

import {
  buildReleaseSurfaceReceipt,
  evaluateAlertDelivery,
  evaluateDataPublication,
  evaluateGeneratedEvidenceFreshness,
  evaluateGenerationReceipt,
  evaluateLiveProbe,
  evaluateMonitorState,
  evaluatePagesDeployment,
  reconcileCardProjection,
  evaluateWorkerRelease,
  evaluateWorkerStartup,
  evaluateWorkerTriggerCoverage,
  writeReleaseSurfaceReceipt,
} from "../tools/release_surface_reconciliation.mjs";
import { verifyWorkerTriggerCoverage } from "../tools/worker_trigger_coverage.mjs";

const SOURCE_SHA = "a".repeat(40);
const NOW = new Date("2026-08-27T12:00:00.000Z");
const ARTIFACT_HASH = "b".repeat(64);

function completeTriggerCoverage() {
  return {
    status: "PASS",
    dependency_paths: ["worker/src/worker.mjs"],
    configured_patterns: ["worker/**"],
    missing_paths: [],
  };
}

function completePublications() {
  return {
    status: "PASS",
    complete: true,
    publications: {
      d1_migrations: { status: "PASS", version: "migration-42" },
      d1_read_models: { status: "PASS", version: "d1-2026-08-28" },
      kv_route_slices: { status: "PASS", version: "kv-2026-08-28" },
      kv_manifests: { status: "PASS", version: "manifest-2026-08-28" },
    },
  };
}

test("generation stage fails with the exact missing-output evidence", () => {
  const result = evaluateGenerationReceipt({
    schema: "cityscroll.generation-output-receipt.v1",
    boundary: "public-site-generation",
    status: "failed",
    source_commit_sha: SOURCE_SHA,
    expected_artifacts: ["_site/index.html"],
    findings: ["missing generated output: _site/index.html"],
    generated_at: "2026-08-27T11:00:00.000Z",
  }, { sourceCommitSha: SOURCE_SHA });
  assert.equal(result.status, "FAIL");
  assert.match(result.findings.join("; "), /missing generated output: _site\/index\.html/);
});

test("card reconciliation catches omission and stale projection without mutating either inventory", () => {
  const sourceCards = { cards: [
    { id: "rel-03", updated_at: "2026-08-27T10:00:00Z" },
    { id: "rel-04", updated_at: "2026-08-27T10:00:00Z" },
  ] };
  const generatedBoard = { cards: [
    { id: "rel-03", source_updated_at: "2026-08-26T10:00:00Z" },
  ] };
  const before = JSON.stringify({ sourceCards, generatedBoard });
  const result = reconcileCardProjection({ sourceCards, generatedBoard });
  assert.equal(result.status, "FAIL");
  assert.ok(result.findings.includes("generated projection generated-board for card rel-03 is stale"));
  assert.ok(result.findings.includes("source card rel-04 is missing from projection generated-board"));
  assert.equal(JSON.stringify({ sourceCards, generatedBoard }), before);
});

test("complete card reconciliation passes and optional fields do not change semantics", () => {
  const result = reconcileCardProjection({
    sourceCards: [{ id: "rel-03", status: "implemented" }],
    generatedBoard: [{ id: "rel-03", status: "implemented" }],
  });
  assert.equal(result.status, "PASS");
  assert.deepEqual(result.findings, []);
});

test("card reconciliation does not let a missing source receipt masquerade as current", () => {
  const result = reconcileCardProjection({
    sourceCards: [{ id: "rel-06", updated_at: "2026-08-27T10:00:00Z" }],
    generatedBoard: [{ id: "rel-06", status: "implemented" }],
  });
  assert.equal(result.status, "FAIL");
  assert.deepEqual(result.findings, ["generated projection generated-board for card rel-06 has no source receipt"]);
});

test("generated evidence freshness uses the source-declared age and hash", () => {
  const sourceContract = {
    id: "fixture-source",
    freshness_contract: { max_stale_days: 2 },
  };
  const current = evaluateGeneratedEvidenceFreshness({
    sourceReceipt: {
      source_contract_id: "fixture-source",
      status: "succeeded",
      observed_at: "2026-08-26T12:00:00.000Z",
      source_hash: "hash-current",
    },
    sourceContract,
    expectedSourceHash: "hash-current",
    now: NOW,
  });
  assert.equal(current.status, "PASS");

  const stale = evaluateGeneratedEvidenceFreshness({
    sourceReceipt: {
      source_contract_id: "fixture-source",
      status: "succeeded",
      observed_at: "2026-08-20T12:00:00.000Z",
      source_hash: "hash-old",
    },
    sourceContract,
    expectedSourceHash: "hash-current",
    now: NOW,
  });
  assert.equal(stale.status, "FAIL");
  assert.ok(stale.findings.some((finding) => /older than its 2-day/.test(finding)));
  assert.ok(stale.findings.includes("generated evidence source receipt source hash mismatch"));

  const missing = evaluateGeneratedEvidenceFreshness({ sourceContract, now: NOW });
  assert.equal(missing.status, "FAIL");
  assert.deepEqual(missing.findings, ["generated evidence source receipt is missing"]);
});

test("release receipt retains stage failures and can be written as durable evidence", async () => {
  await withTempDir("release-surface", async (directory) => {
    const path = join(directory, "release-surface-receipt.json");
    const receipt = buildReleaseSurfaceReceipt({
      sourceCommitSha: SOURCE_SHA,
      requiredStages: ["generation_output", "card_reconciliation", "generated_evidence_freshness"],
      stages: {
        generation_output: { status: "PASS", findings: [], evidence: {} },
        card_reconciliation: { status: "FAIL", findings: ["source card rel-04 is missing from projection generated-board"], evidence: {} },
        generated_evidence_freshness: { status: "PASS", findings: [], evidence: {} },
      },
    });
    writeReleaseSurfaceReceipt(receipt, path);
    const persisted = JSON.parse(await readFile(path, "utf8"));
    assert.equal(persisted.schema, "cityscroll.release-surface-receipt.v1");
    assert.equal(persisted.kind, "release-surface");
    assert.equal(persisted.status, "FAIL");
    assert.match(persisted.findings[0], /rel-04/);
  });
});

test("Pages deployment evidence can be joined to the existing release receipt", async () => {
  await withTempDir("release-pages", async (directory) => {
    const path = join(directory, "receipt.json");
    const initial = buildReleaseSurfaceReceipt({
      sourceCommitSha: SOURCE_SHA,
      requiredStages: ["generation_output"],
      stages: { generation_output: { status: "PASS", findings: [], evidence: {} } },
    });
    await writeFile(path, JSON.stringify(initial) + "\n");
    const result = spawnSync(process.execPath, [
      "tools/update_release_surface_receipt.mjs",
      "--receipt", path,
      "--stage", "pages_deployment",
      "--status", "PASS",
      "--required-stage", "pages_deployment",
      "--deployment-url", "https://pages.example.invalid/deploy-1",
    ], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    const updated = JSON.parse(await readFile(path, "utf8"));
    assert.equal(updated.status, "PASS");
    assert.equal(updated.stages.pages_deployment.evidence.deployment_url, "https://pages.example.invalid/deploy-1");
    assert.ok(updated.required_stages.includes("pages_deployment"));
  });
});

test("CLI failure injection writes a receipt before returning nonzero", async () => {
  await withTempDir("release-cli", async (directory) => {
    const output = join(directory, "receipt.json");
    const result = spawnSync(process.execPath, [
      "tools/check_release_surface_reconciliation.mjs",
      "--generation-receipt", join(directory, "missing-generation.json"),
      "--output", output,
      "--required-stages", "generation_output",
    ], { encoding: "utf8" });
    assert.notEqual(result.status, 0);
    const receipt = JSON.parse(await readFile(output, "utf8"));
    assert.equal(receipt.status, "FAIL");
    assert.ok(receipt.findings.some((finding) => /generation output receipt is missing/.test(finding)));
  });
});

test("Pages provider identity and artifact binding fail closed", () => {
  const base = {
    status: "success",
    deployment_id: "pages-deployment-1",
    source_commit_sha: SOURCE_SHA,
    artifact_hash: ARTIFACT_HASH,
  };
  assert.equal(evaluatePagesDeployment({ ...base, status: undefined, provider_status: undefined }).status, "UNKNOWN");
  assert.equal(evaluatePagesDeployment({ ...base, provider_status: "failed" }).status, "FAIL");
  assert.equal(evaluatePagesDeployment(base).status, "PASS");
  assert.notEqual(evaluatePagesDeployment({ ...base, artifact_hash: "old" }).status, "PASS");
});

test("Worker release cannot pass without provider status, trigger coverage, or startup measurement", () => {
  const base = {
    status: "success",
    build_id: "workers-build-1",
    source_commit_sha: SOURCE_SHA,
    trigger_coverage: completeTriggerCoverage(),
    startup_ms: 120,
  };
  assert.equal(evaluateWorkerRelease({ ...base, status: undefined, provider_status: undefined }).status, "UNKNOWN");
  assert.notEqual(evaluateWorkerRelease({
    ...base,
    trigger_coverage: { status: "PASS", dependency_paths: ["site/shared.mjs"], missing_paths: ["site/shared.mjs"] },
  }).status, "PASS");
  assert.equal(evaluateWorkerRelease({ ...base, startup_ms: "" }).status, "UNKNOWN");
  assert.equal(evaluateWorkerRelease({
    ...base,
    startup_ms: undefined,
    startup_report: "startup check completed successfully",
  }).status, "UNKNOWN");
  assert.equal(evaluateWorkerRelease(base).status, "PASS");
});

test("startup guard preserves a missing profiler measurement instead of zero", () => {
  assert.equal(evaluateWorkerStartup({ startupReport: "startup check completed successfully" }).status, "UNKNOWN");
  assert.equal(evaluateWorkerStartup({ startupMs: 0 }).status, "PASS");
  assert.equal(evaluateWorkerStartup({ startupMs: 1001 }).status, "FAIL");
});

test("data publication rejects partial and unversioned D1/KV state", () => {
  assert.equal(evaluateDataPublication({ publications: {} }).status, "UNKNOWN");
  assert.equal(evaluateDataPublication({
    ...completePublications(),
    complete: false,
  }).status, "FAIL");
  assert.notEqual(evaluateDataPublication({
    ...completePublications(),
    publications: { ...completePublications().publications, kv_manifests: { status: "PASS" } },
  }).status, "PASS");
  assert.equal(evaluateDataPublication(completePublications()).status, "PASS");
});

test("live serving, monitor liveness, and alert delivery retain non-PASS reasons", () => {
  assert.notEqual(evaluateLiveProbe({
    status: "success",
    http_status: 200,
    source_commit_sha: SOURCE_SHA,
  }).status, "PASS");
  assert.equal(evaluateLiveProbe({
    status: "success",
    http_status: 200,
    source_commit_sha: SOURCE_SHA,
    expected_source_commit_sha: SOURCE_SHA,
    served_artifact_hash: "c".repeat(64),
    expected_artifact_hash: ARTIFACT_HASH,
  }).status, "FAIL");
  assert.equal(evaluateMonitorState({}).status, "UNKNOWN");
  assert.equal(evaluateMonitorState({
    watchdog: { status: "healthy", observed_at: NOW.toISOString() },
    scheduler: { status: "healthy", observed_at: NOW.toISOString() },
    now: NOW,
  }).status, "PASS");
  assert.equal(evaluateMonitorState({
    watchdog: { status: "expired", observed_at: NOW.toISOString() },
    now: NOW,
  }).status, "FAIL");
  assert.equal(evaluateAlertDelivery({}).status, "UNKNOWN");
  assert.equal(evaluateAlertDelivery({ outcome: "failed", provider: "resend" }).status, "FAIL");
  assert.equal(evaluateAlertDelivery({ outcome: "delivered", provider: "resend", message_id: "msg-1" }).status, "PASS");
});

test("the repository trigger report is generated from the Worker dependency graph", () => {
  const report = verifyWorkerTriggerCoverage({ rootDir: process.cwd() });
  assert.equal(report.schema, "cityscroll.worker-trigger-coverage.v1");
  assert.equal(report.status, "PASS");
  assert.ok(report.dependency_paths.includes("worker/src/worker.mjs"));
  assert.deepEqual(report.missing_paths, []);
});

test("an aggregate receipt cannot be a complete PASS without its source SHA", () => {
  const receipt = buildReleaseSurfaceReceipt({
    requiredStages: ["generation_output"],
    stages: { generation_output: { status: "PASS", findings: [], evidence: {} } },
  });
  assert.equal(receipt.status, "UNKNOWN");
  assert.ok(receipt.findings.includes("source commit SHA is missing or invalid"));
});
