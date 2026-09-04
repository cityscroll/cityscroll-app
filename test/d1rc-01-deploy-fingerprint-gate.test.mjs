import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  D1_PUBLICATION_RECEIPT_SCHEMA,
  D1_PUBLICATION_STATE_SCHEMA,
  computeDeployFingerprint,
  decidePublication,
  resolveFingerprintInputs,
} from "../tools/d1_deploy_fingerprint.mjs";

const ROOT = new URL("../", import.meta.url);
const FIXTURE = new URL("fixtures/d1rc-01/", import.meta.url);
const read = (path) => readFileSync(new URL(path, ROOT), "utf8");

test("deploy fingerprint is deterministic and changes with source, builder, or schema bytes", () => {
  const root = mkdtempSync(join(tmpdir(), "cityscroll-d1rc-01-"));
  try {
    cpSync(FIXTURE, root, { recursive: true });
    const inputs = ["source", "builder.mjs", "schema.sql"];
    const first = computeDeployFingerprint({ root, inputPaths: inputs });
    const reordered = computeDeployFingerprint({ root, inputPaths: [...inputs].reverse() });
    assert.equal(first.fingerprint, reordered.fingerprint);
    assert.deepEqual(first.files, ["builder.mjs", "schema.sql", "source/model.json"]);

    writeFileSync(join(root, "source/model.json"), '{"rows":[{"id":"fixture-1","payload":"changed"}]}\n');
    const changedSource = computeDeployFingerprint({ root, inputPaths: inputs });
    assert.notEqual(changedSource.fingerprint, first.fingerprint);

    writeFileSync(join(root, "source/model.json"), readFileSync(new URL("source/model.json", FIXTURE)));
    writeFileSync(join(root, "builder.mjs"), 'export const buildVersion = "fixture-v2";\n');
    const changedBuilder = computeDeployFingerprint({ root, inputPaths: inputs });
    assert.notEqual(changedBuilder.fingerprint, first.fingerprint);

    writeFileSync(join(root, "builder.mjs"), readFileSync(new URL("builder.mjs", FIXTURE)));
    writeFileSync(join(root, "schema.sql"), "CREATE TABLE read_model_v2 (id TEXT PRIMARY KEY);\n");
    const changedSchema = computeDeployFingerprint({ root, inputPaths: inputs });
    assert.notEqual(changedSchema.fingerprint, first.fingerprint);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("unchanged published fingerprint emits an explicit zero-write skip receipt", () => {
  const fingerprint = "a".repeat(64);
  const root = mkdtempSync(join(tmpdir(), "cityscroll-d1rc-01-receipt-"));
  try {
    const state = join(root, "published.json");
    const receipt = join(root, "receipt.json");
    const output = join(root, "github-output.txt");
    writeFileSync(state, `${JSON.stringify({
      schema: D1_PUBLICATION_STATE_SCHEMA,
      status: "published",
      fingerprint,
    })}\n`);
    const result = spawnSync(process.execPath, [
      "tools/d1_deploy_fingerprint.mjs",
      "decide",
      "--fingerprint", fingerprint,
      "--state", state,
      "--force", "false",
      "--receipt", receipt,
      "--github-output", output,
    ], { cwd: fileURLToPath(ROOT), encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(readFileSync(output, "utf8"), /^should-publish=false$/m);
    assert.deepEqual(JSON.parse(readFileSync(receipt, "utf8")), {
      schema: D1_PUBLICATION_RECEIPT_SCHEMA,
      fingerprint,
      previous_fingerprint: fingerprint,
      decision: "skip",
      reason: "fingerprint_unchanged",
      operator_bypass: false,
      d1_writes: { commands: 0, rows: 0 },
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("operator bypass publishes an unchanged fingerprint", () => {
  const fingerprint = "b".repeat(64);
  const result = decidePublication({
    fingerprint,
    priorState: { status: "published", fingerprint },
    force: true,
  });
  assert.equal(result.shouldPublish, true);
  assert.equal(result.receipt.reason, "operator_bypass");
  assert.equal(result.receipt.operator_bypass, true);
});

test("a later model manifest can extend the deploy fingerprint without becoming a d1-01 dependency", async () => {
  const root = mkdtempSync(join(tmpdir(), "cityscroll-d1rc-01-extension-"));
  try {
    mkdirSync(join(root, "tools"), { recursive: true });
    mkdirSync(join(root, "worker"), { recursive: true });
    writeFileSync(join(root, "builder.mjs"), "export const version = 1;\n");
    writeFileSync(join(root, "worker/d1-read-models.manifest.json"), '{"version":1}\n');
    writeFileSync(
      join(root, "tools/d1_manifest.mjs"),
      'export function fingerprintInputs() { return ["worker/d1-read-models.manifest.json"]; }\n',
    );
    const inputs = await resolveFingerprintInputs({ root, baseInputs: ["builder.mjs"] });
    assert.deepEqual(inputs, [
      "builder.mjs",
      "tools/d1_manifest.mjs",
      "worker/d1-read-models.manifest.json",
    ]);
    const first = computeDeployFingerprint({ root, inputPaths: inputs });
    writeFileSync(join(root, "worker/d1-read-models.manifest.json"), '{"version":2}\n');
    const changed = computeDeployFingerprint({ root, inputPaths: inputs });
    assert.notEqual(changed.fingerprint, first.fingerprint);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("workflow gates every D1 mutation without gating the Worker deploy", () => {
  const workflow = read(".github/workflows/deploy-worker.yml");
  assert.match(workflow, /force_d1_publication:[\s\S]*type: boolean/);
  assert.match(workflow, /id: d1-publication-gate/);
  assert.match(workflow, /fingerprint_unchanged/);
  assert.match(workflow, /kv key get d1-publication:state:v1/);
  assert.match(workflow, /kv key put d1-publication:state:v1/);

  const d1Steps = [
    "Apply D1 migrations",
    "Build D1 search, OCP, and entity-intelligence read models",
    "Publish D1 search, OCP, and entity-intelligence read models",
    "Record published D1 fingerprint",
  ];
  for (const [index, name] of d1Steps.entries()) {
    const start = workflow.indexOf(`- name: ${name}`);
    const next = workflow.indexOf("\n      - name:", start + 1);
    const step = workflow.slice(start, next === -1 ? undefined : next);
    assert.ok(start >= 0, `${name} step is missing`);
    assert.match(step, /if: steps\.d1-publication-gate\.outputs\.should-publish == 'true'/, `${name} is not gated`);
    if (index < 3) assert.match(step, /(?:d1 migrations apply|d1 execute|build_worker_d1_read_models)/);
  }

  const deployStart = workflow.indexOf("- name: Deploy");
  const deployEnd = workflow.indexOf("\n      - name:", deployStart + 1);
  const workerDeploy = workflow.slice(deployStart, deployEnd);
  assert.match(workerDeploy, /command: deploy /);
  assert.doesNotMatch(workerDeploy, /d1-publication-gate/);
});
