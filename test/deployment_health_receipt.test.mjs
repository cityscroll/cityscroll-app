import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { buildReleaseSurfaceReceipt } from "../tools/release_surface_reconciliation.mjs";
import {
  CLOUDFLARE_PAGES_BOUNDARY,
  CLOUDFLARE_WORKER_BOUNDARY,
  DEPLOYMENT_HEALTH_RECEIPT_SCHEMA,
  DEPLOYMENT_RECONCILIATION_COMPLETE,
  DEPLOYMENT_RECONCILIATION_INCOMPLETE,
  buildDeploymentHealthReceipt,
  classifyEvidence,
  loadDeclaredProductionBoundaries,
  reconcileDeploymentHealth,
} from "../tools/deployment_health_receipt.mjs";

const MERGED_SHA = "a".repeat(40);
const PRIOR_SHA = "b".repeat(40);
const ARTIFACT_HASH = "c".repeat(64);
const OBSERVED_AT = "2026-08-29T12:00:00.000Z";
const FIXTURE_DIR = new URL("./fixtures/deployment-health/", import.meta.url);

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const fixture = (name) => JSON.parse(readFileSync(new URL(name, FIXTURE_DIR), "utf8"));

function pagesReceipt(overrides = {}) {
  return buildDeploymentHealthReceipt({
    boundary: CLOUDFLARE_PAGES_BOUNDARY,
    pipeline: "deploy-cloudflare-pages",
    mergedSourceSha: MERGED_SHA,
    deployedCommitSha: MERGED_SHA,
    artifactType: "pages-artifact-hash",
    artifactValue: ARTIFACT_HASH,
    deploymentId: "https://pages.example.invalid/deploy-pages",
    deploymentUrl: "https://pages.example.invalid/deploy-pages",
    providerStatus: "success",
    guardResults: [
      { name: "generation_output", status: "PASS" },
      { name: "wrangler_pages_deploy", status: "PASS" },
    ],
    observedAt: OBSERVED_AT,
    workflowRunUrl: "https://github.example.invalid/pages-run",
    ...overrides,
  });
}

function workerReceipt(overrides = {}) {
  return buildDeploymentHealthReceipt({
    boundary: CLOUDFLARE_WORKER_BOUNDARY,
    pipeline: "deploy-worker",
    mergedSourceSha: MERGED_SHA,
    deployedCommitSha: MERGED_SHA,
    artifactType: "worker-commit",
    artifactValue: MERGED_SHA,
    deploymentId: `cityscroll-worker@${MERGED_SHA}`,
    deploymentUrl: "https://github.example.invalid/worker-run",
    providerStatus: "success",
    guardResults: [
      { name: "worker_trigger_coverage", status: "PASS" },
      { name: "wrangler_worker_deploy", status: "PASS" },
    ],
    observedAt: OBSERVED_AT,
    workflowRunUrl: "https://github.example.invalid/worker-run",
    ...overrides,
  });
}

test("declared production set is exactly Cloudflare Pages and Cloudflare Worker", () => {
  const config = JSON.parse(read("docs/release/cloudflare-native-builds.json"));
  const declared = loadDeclaredProductionBoundaries(config);
  assert.deepEqual(declared.map((row) => row.id), [CLOUDFLARE_PAGES_BOUNDARY, CLOUDFLARE_WORKER_BOUNDARY]);
  assert.deepEqual(declared.map((row) => row.name), ["Cloudflare Pages", "Cloudflare Worker"]);
  assert.throws(
    () => loadDeclaredProductionBoundaries({ required_production_boundaries: declared.slice(0, 1) }),
    /exactly Cloudflare Pages and Cloudflare Worker/,
  );
});

test("a successful pipeline receipt carries schema, boundary, SHAs, artifact, reference, guards, and time", () => {
  const pages = pagesReceipt();
  const worker = workerReceipt();
  for (const receipt of [pages, worker]) {
    assert.equal(receipt.schema, DEPLOYMENT_HEALTH_RECEIPT_SCHEMA);
    assert.equal(receipt.kind, "deployment");
    assert.equal(receipt.status, "PASS");
    assert.equal(receipt.merged_source_sha, MERGED_SHA);
    assert.equal(receipt.deployed_commit_sha, MERGED_SHA);
    assert.equal(receipt.observed_at, OBSERVED_AT);
    assert.ok(receipt.deployment_reference.id);
    assert.ok(receipt.deployment_reference.url);
    assert.ok(receipt.guard_results.length >= 1);
    assert.deepEqual(receipt.findings, []);
  }
  assert.equal(pages.boundary, CLOUDFLARE_PAGES_BOUNDARY);
  assert.equal(pages.boundary_name, "Cloudflare Pages");
  assert.equal(pages.artifact_identity.type, "pages-artifact-hash");
  assert.equal(worker.boundary, CLOUDFLARE_WORKER_BOUNDARY);
  assert.equal(worker.boundary_name, "Cloudflare Worker");
  assert.equal(worker.artifact_identity.value, MERGED_SHA);
});

test("2/2 COMPLETE requires matching Pages and Worker receipts for the merged SHA", () => {
  const view = reconcileDeploymentHealth({
    mergedSourceSha: MERGED_SHA,
    receipts: [pagesReceipt(), workerReceipt()],
  });
  assert.equal(view.status, DEPLOYMENT_RECONCILIATION_COMPLETE);
  assert.equal(view.healthy_count, 2);
  assert.deepEqual(view.affected_boundaries, []);
  assert.equal(view.boundaries[CLOUDFLARE_PAGES_BOUNDARY].receipt.boundary_name, "Cloudflare Pages");
  assert.equal(view.boundaries[CLOUDFLARE_WORKER_BOUNDARY].receipt.boundary_name, "Cloudflare Worker");
});

test("missing, failed, stale, mismatched, and 1-of-2 shapes never produce COMPLETE", () => {
  const healthyPages = pagesReceipt();
  const cases = [
    {
      name: "missing Worker",
      receipts: [healthyPages],
      affected: CLOUDFLARE_WORKER_BOUNDARY,
      pattern: /Cloudflare Worker receipt is missing/,
    },
    {
      name: "failed Worker",
      receipts: [healthyPages, workerReceipt({ providerStatus: "failure" })],
      affected: CLOUDFLARE_WORKER_BOUNDARY,
      pattern: /Cloudflare Worker provider deployment failed/,
    },
    {
      name: "stale Worker SHA",
      receipts: [healthyPages, workerReceipt({
        mergedSourceSha: PRIOR_SHA,
        deployedCommitSha: PRIOR_SHA,
        artifactValue: PRIOR_SHA,
        deploymentId: `cityscroll-worker@${PRIOR_SHA}`,
      })],
      affected: CLOUDFLARE_WORKER_BOUNDARY,
      pattern: /Cloudflare Worker .*does not match merged SHA/,
    },
    {
      name: "mismatched Worker artifact",
      receipts: [healthyPages, workerReceipt({ artifactValue: PRIOR_SHA })],
      affected: CLOUDFLARE_WORKER_BOUNDARY,
      pattern: /Cloudflare Worker artifact identity does not match/,
    },
  ];
  for (const fixtureCase of cases) {
    const view = reconcileDeploymentHealth({
      mergedSourceSha: MERGED_SHA,
      receipts: fixtureCase.receipts,
    });
    assert.equal(view.status, DEPLOYMENT_RECONCILIATION_INCOMPLETE, fixtureCase.name);
    assert.notEqual(view.status, DEPLOYMENT_RECONCILIATION_COMPLETE, fixtureCase.name);
    assert.ok(view.affected_boundaries.includes(fixtureCase.affected), fixtureCase.name);
    assert.ok(view.findings.some((finding) => fixtureCase.pattern.test(finding)), `${fixtureCase.name}: ${view.findings.join("; ")}`);
    assert.equal(view.boundaries[CLOUDFLARE_PAGES_BOUNDARY].status, "PASS", fixtureCase.name);
    assert.equal(view.boundaries[CLOUDFLARE_PAGES_BOUNDARY].receipt.boundary_name, "Cloudflare Pages");
    assert.equal(view.healthy_boundaries.includes(CLOUDFLARE_PAGES_BOUNDARY), true, fixtureCase.name);
  }
});

test("runtime watchdog and aggregate release-surface receipts are not deployment substitutes", () => {
  const watchdog = {
    schema: "cityscroll.digest-terminal-delivery-receipt.v1",
    status: "healthy",
    observed_at: OBSERVED_AT,
  };
  const scheduler = {
    schema: "cityscroll.digest-shadow-ready-receipt.v1",
    status: "READY",
    observed_at: OBSERVED_AT,
  };
  const aggregate = buildReleaseSurfaceReceipt({
    sourceCommitSha: MERGED_SHA,
    requiredStages: ["pages_deployment", "worker_release", "watchdog", "scheduler"],
    stages: {
      pages_deployment: { status: "PASS", findings: [], evidence: { source_commit_sha: MERGED_SHA } },
      worker_release: { status: "PASS", findings: [], evidence: { source_commit_sha: MERGED_SHA } },
      watchdog: { status: "PASS", findings: [], evidence: {} },
      scheduler: { status: "PASS", findings: [], evidence: {} },
    },
  });
  assert.equal(aggregate.status, "PASS");
  assert.equal(aggregate.kind, "release-surface");
  assert.equal(classifyEvidence(watchdog).kind, "runtime-watchdog");
  assert.equal(classifyEvidence(aggregate).kind, "release-surface");

  const fromWatchdogs = reconcileDeploymentHealth({
    mergedSourceSha: MERGED_SHA,
    receipts: [pagesReceipt(), watchdog, scheduler],
  });
  assert.equal(fromWatchdogs.status, DEPLOYMENT_RECONCILIATION_INCOMPLETE);
  assert.ok(fromWatchdogs.findings.some((finding) => /runtime watchdog\/digest\/scheduler receipt is not a deployment-health receipt/.test(finding)));
  assert.ok(fromWatchdogs.findings.some((finding) => /Cloudflare Worker receipt is missing/.test(finding)));
  assert.equal(fromWatchdogs.boundaries[CLOUDFLARE_PAGES_BOUNDARY].status, "PASS");

  const fromAggregate = reconcileDeploymentHealth({
    mergedSourceSha: MERGED_SHA,
    receipts: [aggregate],
  });
  assert.equal(fromAggregate.status, DEPLOYMENT_RECONCILIATION_INCOMPLETE);
  assert.ok(fromAggregate.findings.some((finding) => /aggregate release-surface receipt is not a deployment-health receipt/.test(finding)));
  assert.deepEqual(fromAggregate.affected_boundaries, [CLOUDFLARE_PAGES_BOUNDARY, CLOUDFLARE_WORKER_BOUNDARY]);
  assert.equal(fromAggregate.healthy_count, 0);
});

test("committed fixtures keep exact boundary names, SHA matching, and the 1-of-2 incident", () => {
  const pages = fixture("cloudflare-pages.json");
  const worker = fixture("cloudflare-worker.json");
  const stale = fixture("cloudflare-worker-stale.json");
  const failed = fixture("cloudflare-worker-failed.json");
  const watchdog = fixture("digest-watchdog.json");
  assert.equal(pages.boundary_name, "Cloudflare Pages");
  assert.equal(worker.boundary_name, "Cloudflare Worker");
  assert.equal(pages.merged_source_sha, worker.merged_source_sha);
  assert.equal(pages.deployed_commit_sha, worker.deployed_commit_sha);

  const complete = reconcileDeploymentHealth({ mergedSourceSha: pages.merged_source_sha, receipts: [pages, worker] });
  assert.equal(complete.status, DEPLOYMENT_RECONCILIATION_COMPLETE);

  const oneOfTwo = reconcileDeploymentHealth({ mergedSourceSha: pages.merged_source_sha, receipts: [pages] });
  assert.equal(oneOfTwo.status, DEPLOYMENT_RECONCILIATION_INCOMPLETE);
  assert.deepEqual(oneOfTwo.affected_boundaries, [CLOUDFLARE_WORKER_BOUNDARY]);
  assert.equal(oneOfTwo.boundaries[CLOUDFLARE_PAGES_BOUNDARY].receipt.deployment_reference.url, pages.deployment_reference.url);

  const staleView = reconcileDeploymentHealth({ mergedSourceSha: pages.merged_source_sha, receipts: [pages, stale] });
  assert.equal(staleView.status, DEPLOYMENT_RECONCILIATION_INCOMPLETE);
  assert.ok(staleView.findings.some((finding) => /Cloudflare Worker/.test(finding) && /does not match merged SHA/.test(finding)));

  const failedView = reconcileDeploymentHealth({ mergedSourceSha: pages.merged_source_sha, receipts: [pages, failed] });
  assert.equal(failedView.status, DEPLOYMENT_RECONCILIATION_INCOMPLETE);
  assert.ok(failedView.findings.some((finding) => /Cloudflare Worker provider deployment failed/.test(finding)));

  const watchdogView = reconcileDeploymentHealth({ mergedSourceSha: pages.merged_source_sha, receipts: [pages, watchdog] });
  assert.notEqual(watchdogView.status, DEPLOYMENT_RECONCILIATION_COMPLETE);
});

test("CLI writes a boundary receipt, reconciles 1-of-2 as incomplete, and checks workflow integration", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cityscroll-deployment-health-"));
  const pagesPath = join(directory, "cloudflare-pages.json");
  const workerPath = join(directory, "cloudflare-worker.json");
  const reconPath = join(directory, "reconciliation.json");
  const generationPath = join(directory, "generation.json");
  await writeFile(generationPath, `${JSON.stringify({
    schema: "cityscroll.generation-output-receipt.v1",
    boundary: "public-site-generation",
    status: "passed",
    findings: [],
  })}\n`);

  const writePages = spawnSync(process.execPath, [
    "tools/check_deployment_health.mjs", "--write",
    "--boundary", "cloudflare-pages",
    "--pipeline", "deploy-cloudflare-pages",
    "--merged-source-sha", MERGED_SHA,
    "--deployed-commit-sha", MERGED_SHA,
    "--artifact-type", "pages-artifact-hash",
    "--artifact-value", ARTIFACT_HASH,
    "--deployment-id", "pages-1",
    "--deployment-url", "https://pages.example.invalid/1",
    "--provider-status", "success",
    "--generation-receipt", generationPath,
    "--guard", "wrangler_pages_deploy:success",
    "--output", pagesPath,
  ], { encoding: "utf8" });
  assert.equal(writePages.status, 0, writePages.stderr);

  const incomplete = spawnSync(process.execPath, [
    "tools/check_deployment_health.mjs", "--reconcile",
    "--merged-source-sha", MERGED_SHA,
    "--receipt", pagesPath,
    "--output", reconPath,
  ], { encoding: "utf8" });
  assert.notEqual(incomplete.status, 0);
  const incompleteView = JSON.parse(await readFile(reconPath, "utf8"));
  assert.equal(incompleteView.status, DEPLOYMENT_RECONCILIATION_INCOMPLETE);
  assert.ok(incompleteView.findings.some((finding) => /Cloudflare Worker receipt is missing/.test(finding)));

  const writeWorker = spawnSync(process.execPath, [
    "tools/check_deployment_health.mjs", "--write",
    "--boundary", "cloudflare-worker",
    "--pipeline", "deploy-worker",
    "--merged-source-sha", MERGED_SHA,
    "--deployed-commit-sha", MERGED_SHA,
    "--artifact-type", "worker-commit",
    "--artifact-value", MERGED_SHA,
    "--deployment-id", `cityscroll-worker@${MERGED_SHA}`,
    "--deployment-url", "https://github.example.invalid/worker",
    "--provider-status", "success",
    "--guard", "worker_trigger_coverage:PASS",
    "--guard", "wrangler_worker_deploy:success",
    "--output", workerPath,
  ], { encoding: "utf8" });
  assert.equal(writeWorker.status, 0, writeWorker.stderr);

  const complete = spawnSync(process.execPath, [
    "tools/check_deployment_health.mjs", "--reconcile",
    "--merged-source-sha", MERGED_SHA,
    "--receipt", pagesPath,
    "--receipt", workerPath,
  ], { encoding: "utf8" });
  assert.equal(complete.status, 0, complete.stderr);
  assert.equal(JSON.parse(complete.stdout).status, DEPLOYMENT_RECONCILIATION_COMPLETE);

  const contract = spawnSync(process.execPath, ["tools/check_deployment_health.mjs", "--check"], { encoding: "utf8" });
  assert.equal(contract.status, 0, contract.stderr || contract.stdout);
});

test("Pages and Worker workflows emit only their own deployment-health receipt", () => {
  const pages = read(".github/workflows/deploy-cloudflare-pages.yml");
  const worker = read(".github/workflows/deploy-worker.yml");
  const watchdogs = read(".github/workflows/reliability-watchdogs.yml");
  assert.match(pages, /tools\/check_deployment_health\.mjs --write/);
  assert.match(pages, /--boundary cloudflare-pages/);
  assert.match(pages, /\.artifacts\/deployment-health\/cloudflare-pages\.json/);
  assert.doesNotMatch(pages, /--boundary cloudflare-worker/);
  assert.match(worker, /tools\/check_deployment_health\.mjs --write/);
  assert.match(worker, /--boundary cloudflare-worker/);
  assert.match(worker, /\.artifacts\/deployment-health\/cloudflare-worker\.json/);
  assert.doesNotMatch(worker, /--boundary cloudflare-pages/);
  assert.doesNotMatch(watchdogs, /check_deployment_health\.mjs/);
});
