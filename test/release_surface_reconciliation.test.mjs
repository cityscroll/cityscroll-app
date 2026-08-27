import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  buildReleaseSurfaceReceipt,
  evaluateGeneratedEvidenceFreshness,
  evaluateGenerationReceipt,
  reconcileCardProjection,
  writeReleaseSurfaceReceipt,
} from "../tools/release_surface_reconciliation.mjs";

const SOURCE_SHA = "a".repeat(40);
const NOW = new Date("2026-08-27T12:00:00.000Z");

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
  assert.ok(result.findings.includes("generated board projection for card rel-03 is stale"));
  assert.ok(result.findings.includes("source card rel-04 is missing from generated board"));
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
  assert.deepEqual(result.findings, ["generated board projection for card rel-06 has no source receipt"]);
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
  const directory = await mkdtemp(join(tmpdir(), "cityscroll-release-surface-"));
  const path = join(directory, "release-surface-receipt.json");
  const receipt = buildReleaseSurfaceReceipt({
    sourceCommitSha: SOURCE_SHA,
    requiredStages: ["generation_output", "card_reconciliation", "generated_evidence_freshness"],
    stages: {
      generation_output: { status: "PASS", findings: [], evidence: {} },
      card_reconciliation: { status: "FAIL", findings: ["source card rel-04 is missing from generated board"], evidence: {} },
      generated_evidence_freshness: { status: "PASS", findings: [], evidence: {} },
    },
  });
  writeReleaseSurfaceReceipt(receipt, path);
  const persisted = JSON.parse(await readFile(path, "utf8"));
  assert.equal(persisted.schema, "cityscroll.release-surface-receipt.v1");
  assert.equal(persisted.status, "FAIL");
  assert.match(persisted.findings[0], /rel-04/);
});

test("Pages deployment evidence can be joined to the existing release receipt", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cityscroll-release-pages-"));
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

test("CLI failure injection writes a receipt before returning nonzero", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cityscroll-release-cli-"));
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
