import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import {
  buildReleaseInfrastructureFacts,
  classifyBindings,
  parseWorkflowTriggers,
  parseWranglerConfig,
  verifyReleaseInfrastructureDocumentation,
} from "../tools/release_infrastructure_facts.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

const PUSH_AND_DISPATCH = `name: Deploy worker

on:
  push:
    branches: [main]
    paths:
      - "worker/**"
      - "site/following_view.mjs"
  workflow_dispatch:
    inputs:
      force_d1_publication:
        type: boolean

jobs:
  deploy:
    runs-on: ubuntu-latest
`;

const DISPATCH_ONLY = `name: Rollback

on:
  workflow_dispatch:

jobs:
  rollback:
    runs-on: ubuntu-latest
`;

const PUSH_ONLY = `name: Publish

on:
  push:
    branches:
      - main

jobs:
  publish:
    runs-on: ubuntu-latest
`;

test("a main-push workflow that also accepts a manual run is automatic, not a fallback", () => {
  const triggers = parseWorkflowTriggers(PUSH_AND_DISPATCH);
  assert.deepEqual(triggers.classifications, ["automatic_on_push", "manual_dispatch"]);
  assert.equal(triggers.manual_only, false);
  assert.deepEqual(triggers.push_branches, ["main"]);
  assert.deepEqual(triggers.push_paths, ["worker/**", "site/following_view.mjs"]);
  assert.equal(triggers.has_workflow_dispatch, true);
});

test("a workflow with only a manual trigger is classified manual-only", () => {
  const triggers = parseWorkflowTriggers(DISPATCH_ONLY);
  assert.deepEqual(triggers.classifications, ["manual_dispatch"]);
  assert.equal(triggers.manual_only, true);
  assert.deepEqual(triggers.push_branches, []);
});

test("a push-only workflow keeps no manual trigger", () => {
  const triggers = parseWorkflowTriggers(PUSH_ONLY);
  assert.deepEqual(triggers.classifications, ["automatic_on_push"]);
  assert.equal(triggers.has_workflow_dispatch, false);
  assert.equal(triggers.manual_only, false);
});

test("a commented-out binding is never counted active", () => {
  const parsed = parseWranglerConfig(`
[vars]
SOURCE_VAULT_ENABLED = "false"

# [[r2_buckets]]
# binding = "SOURCE_VAULT"

[[kv_namespaces]]
binding = "ALERT_STATE"
id = "abc"
`);
  const bindings = classifyBindings(parsed);
  const vault = bindings.find((binding) => binding.name === "SOURCE_VAULT");
  assert.equal(vault.state, "commented_out");
  assert.equal(vault.active, false);
  assert.deepEqual(vault.gate, { key: "SOURCE_VAULT_ENABLED", value: "false" });
  assert.equal(bindings.find((binding) => binding.name === "ALERT_STATE").active, true);
  assert.equal(bindings.filter((binding) => binding.active).length, 1);
});

test("an uncommented binding whose enable flag is off is not counted active", () => {
  const bindings = classifyBindings(parseWranglerConfig(`
[vars]
SOURCE_VAULT_ENABLED = "false"

[[r2_buckets]]
binding = "SOURCE_VAULT"
bucket_name = "vault"
`));
  const vault = bindings.find((binding) => binding.name === "SOURCE_VAULT");
  assert.equal(vault.state, "configured");
  assert.equal(vault.active, false);
});

test("cron schedules are read from the triggers table only", () => {
  const parsed = parseWranglerConfig(`
# crons = [ "0 1 * * *" ]

[triggers]
crons = [
  "0 8 * * *",
  "0 10 * * *",
  "0 13 * * *",
]

[vars]
CONFIRM_BASE = "https://api.cityscroll.org"
`);
  assert.deepEqual(parsed.crons.map((entry) => entry.schedule), ["0 8 * * *", "0 10 * * *", "0 13 * * *"]);
  assert.deepEqual(Object.keys(parsed.vars), ["CONFIRM_BASE"]);
});

test("the committed configuration deploys the Worker on a main push and keeps a manual trigger", () => {
  const facts = buildReleaseInfrastructureFacts({ rootDir: ROOT });
  const worker = facts.pipelines["cloudflare-worker"];
  assert.equal(worker.manual_only, false);
  assert.ok(worker.classifications.includes("automatic_on_push"));
  assert.ok(worker.classifications.includes("manual_dispatch"));
  assert.deepEqual(worker.push_branches, ["main"]);
  assert.ok(worker.push_paths.includes("worker/**"));
  assert.equal(facts.contract.worker.manual_fallback_workflow, undefined);
  assert.equal(facts.contract.worker.automatic_deploy_workflow, ".github/workflows/deploy-worker.yml");
});

test("the committed configuration declares three cron triggers and no active R2 binding", () => {
  const facts = buildReleaseInfrastructureFacts({ rootDir: ROOT });
  assert.deepEqual(facts.crons.map((entry) => entry.schedule), ["0 8 * * *", "0 10 * * *", "0 13 * * *"]);
  const vault = facts.bindings.find((binding) => binding.name === "SOURCE_VAULT");
  assert.equal(vault.active, false);
  assert.equal(facts.vars.SOURCE_VAULT_ENABLED, "false");
  assert.equal(facts.bindings.filter((binding) => binding.active && binding.section === "r2_buckets").length, 0);
});

test("the native Workers Builds connection is not asserted as verified", () => {
  const facts = buildReleaseInfrastructureFacts({ rootDir: ROOT });
  assert.equal(facts.externally_observed.worker_native_builds_connection, "unverified");
});

test("the owned release reference agrees with the committed configuration", () => {
  const report = verifyReleaseInfrastructureDocumentation({ rootDir: ROOT });
  assert.deepEqual(report.findings, []);
  assert.equal(report.status, "PASS");
});

test("the release reconciliation check exits zero on the current tree", () => {
  const result = spawnSync(process.execPath, ["tools/release_infrastructure_facts.mjs", "--check"], {
    cwd: ROOT,
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
});
