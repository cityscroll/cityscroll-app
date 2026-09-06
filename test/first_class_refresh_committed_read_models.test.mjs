import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  ROOT,
  readRegistry,
  registryBuilders,
  registryDrift,
  describeDrift,
  workflowGateBuilders,
} from "../ops/first-class-refresh/rebuild-committed-read-models.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const WORKFLOW = path.join(REPO_ROOT, ".github/workflows/first-class-refresh.yml");
const WAREHOUSE_SCRIPT = path.join(REPO_ROOT, "ops/first-class-refresh/run-warehouse-refresh.sh");
const DERIVED_MANIFEST = path.join(REPO_ROOT, "warehouse/derived_json_build_manifest.json");

test("the rebuild registry resolves against the repository it ships in", () => {
  assert.equal(ROOT, REPO_ROOT);
  const registry = readRegistry(REPO_ROOT);
  assert.equal(registry.gate_workflow, ".github/workflows/ci.yml");
  assert.equal(registry.gate_family, "static-standards");
  for (const step of registry.rebuild_sequence) {
    assert.ok(step.id, "every rebuild step needs an id");
    assert.ok(step.command?.length, `rebuild step ${step.id} needs a command`);
    assert.ok(existsSync(path.join(REPO_ROOT, step.command[0])), `missing tool for ${step.id}`);
    assert.ok(step.covers?.length, `rebuild step ${step.id} must say which gates it covers`);
  }
  for (const entry of registry.not_rebuilt) {
    assert.ok(existsSync(path.join(REPO_ROOT, entry.builder)), `missing builder ${entry.builder}`);
    assert.ok(entry.disposition, `${entry.builder} needs a disposition`);
    assert.ok(entry.reason && entry.reason.length > 20, `${entry.builder} needs a stated reason`);
  }
});

test("the workflow reader finds the check-mode gates it is pointed at", () => {
  const gates = workflowGateBuilders(REPO_ROOT);
  assert.ok(gates.length >= 14, `expected the static-standards family to declare many gates, saw ${gates.length}`);
  assert.ok(gates.includes("tools/build_keyword_search_index.mjs"));
  assert.ok(gates.includes("tools/build_agency_constellation_documents.mjs"));
  // Gates that belong to other unit families must not leak into the comparison.
  assert.ok(!gates.includes("tools/build_geocoder_address_index.mjs"));
  assert.ok(!gates.includes("tools/no_live_external_reads.mjs"));
});

test("every committed-freshness gate is accounted for by the refresh", () => {
  // This is the drift guard. A new "Committed … freshness" step in the
  // static-standards family fails here until the refresh either rebuilds its
  // read model or records why it cannot.
  const drift = registryDrift(REPO_ROOT);
  assert.deepEqual(describeDrift(drift), []);
});

test("no builder is accounted for twice", () => {
  const builders = registryBuilders(readRegistry(REPO_ROOT));
  assert.equal(new Set(builders).size, builders.length);
});

test("the derived JSON boundary really does build the gates it is credited with", () => {
  const registry = readRegistry(REPO_ROOT);
  const boundary = registry.rebuild_sequence.find((step) => step.id === "derived-json-build-boundary");
  assert.ok(boundary, "the boundary step is the refresh's ordered rebuild for derived JSON");
  const manifest = JSON.parse(readFileSync(DERIVED_MANIFEST, "utf8"));
  const generators = new Set(manifest.generated_families.map((family) => family.generator));
  for (const builder of boundary.covers) {
    assert.ok(generators.has(builder), `${builder} is credited to the boundary but is not a declared family`);
  }
});

test("both halves of the refresh run the rebuild", () => {
  // The hosted workflow refreshes everything a runner can reach; the
  // warehouse-held script refreshes the rest. Neither may commit inputs without
  // their read models.
  const workflow = readFileSync(WORKFLOW, "utf8");
  assert.match(workflow, /rebuild-committed-read-models\.mjs/);
  const rebuildAt = workflow.indexOf("rebuild-committed-read-models.mjs");
  const publishAt = workflow.indexOf("open_first_class_refresh_pr.sh");
  assert.ok(rebuildAt > 0 && publishAt > rebuildAt, "the rebuild must run before the pull request is opened");

  const warehouse = readFileSync(WAREHOUSE_SCRIPT, "utf8");
  assert.match(warehouse, /rebuild-committed-read-models\.mjs/);
  const warehouseRebuildAt = warehouse.indexOf("rebuild-committed-read-models.mjs");
  const warehouseCommitAt = warehouse.indexOf("git commit");
  assert.ok(
    warehouseRebuildAt > 0 && warehouseCommitAt > warehouseRebuildAt,
    "the warehouse-held refresh must rebuild before it commits",
  );
});
