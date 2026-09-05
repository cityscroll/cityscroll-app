import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { CAPABILITY_REGISTRY } from "../capabilities/registry.mjs";
import { FEDERATED_SEARCH_CAPABILITY_REFERENCE } from "../capabilities/federated_search.mjs";
import { NOTICE_GET_CAPABILITY_REFERENCE } from "../capabilities/notice_get.mjs";
import {
  PRODUCT_UPDATE_JOINS,
  buildProductUpdatesArtifact,
} from "../site/product_updates_source.mjs";
import {
  PRODUCT_UPDATES_HONESTY_METHOD,
  PRODUCT_UPDATES_HONESTY_RECEIPT_SCHEMA,
  checkBatchHonesty,
  deriveDemoRegressionState,
  hashHonestyReceipt,
  serializeHonestyReceipt,
} from "../site/product_updates_honesty.mjs";
import { loadWatermark } from "../tools/architecture_watermark.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const CLI_PATH = fileURLToPath(new URL("../tools/check_product_updates_honesty.mjs", import.meta.url));
const ARTIFACT_PATH = fileURLToPath(new URL("../site/product-updates.json", import.meta.url));
const DEMO_MANIFEST_PATH = fileURLToPath(new URL("../site/demo/demo-links.json", import.meta.url));
const FIXTURE_BATCH_PATH = fileURLToPath(new URL("./fixtures/product_updates_honesty_batch.json", import.meta.url));

const DEMO_MANIFEST = JSON.parse(readFileSync(DEMO_MANIFEST_PATH, "utf8"));
const CHANGELOG = JSON.parse(readFileSync(new URL("../site/changelog-data.json", import.meta.url), "utf8"));
const WATERMARK = loadWatermark();

const HOUSING_JOIN = PRODUCT_UPDATE_JOINS.find((join) => join.demo_id === "semantic-search-housing");
const NOTICE_JOIN = PRODUCT_UPDATE_JOINS.find((join) => join.demo_id === "notice-sanitation-connected-mandate");

function healthyReconciliation(overrides = {}) {
  return {
    schema: "cityscroll.architecture.reconciliation.v1",
    status: "healthy",
    path: "architecture/generated/reconciliation.json",
    observed_commit: WATERMARK.commit,
    as_of: WATERMARK.generated_at,
    baseline: "architecture/watermark.d",
    ...overrides,
  };
}

function sources(overrides = {}) {
  return {
    changelog: CHANGELOG,
    reconciliation: healthyReconciliation(),
    capabilities: CAPABILITY_REGISTRY,
    demoManifest: DEMO_MANIFEST,
    joins: PRODUCT_UPDATE_JOINS,
    ...overrides,
  };
}

function batchCandidateFrom(candidate, overrides = {}) {
  return {
    candidate_id: candidate.id,
    claim: candidate.claim,
    capability_ref: candidate.capability.reference,
    capability_version: candidate.capability.version,
    demo_id: candidate.demo.id,
    demo_route: candidate.demo.pathname,
    source_event: candidate.source_event.kind === "changelog"
      ? { kind: "changelog", path: candidate.source_event.path, pr: candidate.source_event.pr }
      : { kind: "architecture_reconciliation", path: candidate.source_event.path, status: candidate.source_event.status },
    regression_state: "passing",
    as_of: candidate.as_of,
    ...overrides,
  };
}

function groundedBatch(artifact, overrides = {}) {
  const eligible = artifact.candidates.filter((candidate) => candidate.eligible === true);
  return {
    batch_id: "test-batch",
    source_artifact_hash: artifact.content_hash,
    candidates: eligible.map((candidate) => batchCandidateFrom(candidate)),
    ...overrides,
  };
}

function itemFor(receipt, candidateId) {
  return receipt.items.find((item) => item.candidate_id === candidateId);
}

// --- A1: every claimed field is re-derived from the public artifact and demo
// manifest; any single-field mismatch excludes only that item, naming the field.

test("A1 positive: a batch that matches the public artifact exactly is fully eligible", () => {
  const artifact = buildProductUpdatesArtifact(sources());
  const batch = groundedBatch(artifact);
  const receipt = checkBatchHonesty({ artifact, demoManifest: DEMO_MANIFEST, batch });
  assert.equal(receipt.deliverable, true);
  assert.deepEqual(receipt.excluded_ids, []);
  assert.deepEqual(receipt.eligible_ids.slice().sort(), [HOUSING_JOIN.id, NOTICE_JOIN.id].sort());
  for (const item of receipt.items) {
    assert.equal(item.outcome, "eligible");
    assert.deepEqual(item.mismatched_fields, []);
    assert.ok(item.predicates.some((p) => p.name === "claim" && p.pass === true));
  }
});

test("A1 negative: a mismatched claim excludes only that item and names the field", () => {
  const artifact = buildProductUpdatesArtifact(sources());
  const batch = groundedBatch(artifact, {
    candidates: artifact.candidates.filter((c) => c.eligible).map((candidate) =>
      candidate.id === HOUSING_JOIN.id
        ? batchCandidateFrom(candidate, { claim: "This is a different claim than the public artifact records." })
        : batchCandidateFrom(candidate)),
  });
  const receipt = checkBatchHonesty({ artifact, demoManifest: DEMO_MANIFEST, batch });
  assert.equal(receipt.deliverable, false);
  const housing = itemFor(receipt, HOUSING_JOIN.id);
  assert.equal(housing.outcome, "excluded");
  assert.deepEqual(housing.mismatched_fields, ["claim"]);
  assert.ok(housing.excluded_reasons.includes("field_mismatch"));
  const claimPredicate = housing.predicates.find((p) => p.name === "claim");
  assert.equal(claimPredicate.pass, false);
  const notice = itemFor(receipt, NOTICE_JOIN.id);
  assert.equal(notice.outcome, "eligible");
});

test("A1 negative: capability reference, version, demo id, demo route, source event, and as_of mismatches are each named", () => {
  const artifact = buildProductUpdatesArtifact(sources());
  const housing = artifact.candidates.find((c) => c.id === HOUSING_JOIN.id);
  const cases = [
    [{ capability_ref: "search.federated@2" }, "capability_ref"],
    [{ capability_version: "9.9.9" }, "capability_version"],
    [{ demo_id: "semantic-search-jobs" }, "demo_id"],
    [{ demo_route: "/search/other" }, "demo_route"],
    [{ source_event: { kind: "architecture_reconciliation", path: housing.source_event.path, status: "stale" } }, "source_event"],
    [{ as_of: "2020-01-01T00:00:00Z" }, "as_of"],
  ];
  for (const [override, field] of cases) {
    const batch = {
      batch_id: "test-batch",
      source_artifact_hash: artifact.content_hash,
      candidates: [batchCandidateFrom(housing, override)],
    };
    const receipt = checkBatchHonesty({ artifact, demoManifest: DEMO_MANIFEST, batch });
    const item = itemFor(receipt, HOUSING_JOIN.id);
    assert.equal(item.outcome, "excluded", `expected exclusion for ${field}`);
    assert.deepEqual(item.mismatched_fields, [field], `expected only ${field} to mismatch`);
    assert.equal(receipt.deliverable, false);
  }
});

test("A1 negative: an unknown candidate id is excluded without crediting any field", () => {
  const artifact = buildProductUpdatesArtifact(sources());
  const batch = {
    batch_id: "test-batch",
    source_artifact_hash: artifact.content_hash,
    candidates: [{
      candidate_id: "search.federated@1::nonexistent-demo",
      claim: "invented",
      capability_ref: FEDERATED_SEARCH_CAPABILITY_REFERENCE,
      capability_version: "1.0.0",
      demo_id: "nonexistent-demo",
      demo_route: "/nowhere",
      source_event: { kind: "architecture_reconciliation", path: "architecture/generated/reconciliation.json" },
      regression_state: "passing",
      as_of: "2026-01-01T00:00:00Z",
    }],
  };
  const receipt = checkBatchHonesty({ artifact, demoManifest: DEMO_MANIFEST, batch });
  const item = receipt.items[0];
  assert.equal(item.outcome, "excluded");
  assert.deepEqual(item.excluded_reasons, ["unknown_candidate"]);
  assert.equal(receipt.deliverable, false);
});

// --- A2: eligibility is recomputed from current public evidence — a removed
// capability, a changed capability version, a broken demo regression, or an
// aged source excludes the item, and the predicate never substitutes a new
// claim or route to rescue it.

test("A2: a capability removed from the current registry excludes the item via re-derived eligibility, not a field diff", () => {
  const withoutCapability = CAPABILITY_REGISTRY.filter((c) => c.reference !== FEDERATED_SEARCH_CAPABILITY_REFERENCE);
  const groundedArtifact = buildProductUpdatesArtifact(sources());
  const housing = groundedArtifact.candidates.find((c) => c.id === HOUSING_JOIN.id);
  const currentArtifact = buildProductUpdatesArtifact(sources({ capabilities: withoutCapability }));
  const batch = {
    batch_id: "test-batch",
    source_artifact_hash: currentArtifact.content_hash,
    candidates: [batchCandidateFrom(housing)],
  };
  const receipt = checkBatchHonesty({ artifact: currentArtifact, demoManifest: DEMO_MANIFEST, batch });
  const item = itemFor(receipt, HOUSING_JOIN.id);
  assert.equal(item.outcome, "excluded");
  assert.ok(item.excluded_reasons.includes("artifact_ineligible"));
  const eligibility = item.predicates.find((p) => p.name === "artifact_currently_eligible");
  assert.equal(eligibility.pass, false);
  assert.match(eligibility.detail, /unregistered|not in the frozen registry/);
  assert.equal(receipt.deliverable, false);
});

test("A2: a capability version bump since the batch was assembled excludes the item and reports the real current version", () => {
  const groundedArtifact = buildProductUpdatesArtifact(sources());
  const housing = groundedArtifact.candidates.find((c) => c.id === HOUSING_JOIN.id);
  const bumped = CAPABILITY_REGISTRY.map((c) =>
    c.reference === FEDERATED_SEARCH_CAPABILITY_REFERENCE ? { ...c, version: "2.0.0" } : c);
  const currentArtifact = buildProductUpdatesArtifact(sources({ capabilities: bumped }));
  const batch = {
    batch_id: "test-batch",
    source_artifact_hash: currentArtifact.content_hash,
    candidates: [batchCandidateFrom(housing)],
  };
  const receipt = checkBatchHonesty({ artifact: currentArtifact, demoManifest: DEMO_MANIFEST, batch });
  const item = itemFor(receipt, HOUSING_JOIN.id);
  assert.equal(item.outcome, "excluded");
  assert.deepEqual(item.mismatched_fields, ["capability_version"]);
  const field = item.predicates.find((p) => p.name === "capability_version");
  assert.equal(field.expected, "2.0.0");
  assert.equal(field.actual, housing.capability.version);
  assert.notEqual(field.expected, field.actual);
  assert.equal(receipt.deliverable, false);
});

test("A2: a demo entry that lost its regression coverage excludes the item without touching its route or claim", () => {
  const artifact = buildProductUpdatesArtifact(sources());
  const housing = artifact.candidates.find((c) => c.id === HOUSING_JOIN.id);
  const brokenManifest = {
    entries: DEMO_MANIFEST.entries.map((entry) =>
      entry.id === "semantic-search-housing" ? { ...entry, expectations: { ...entry.expectations, visible: [] } } : entry),
  };
  const batch = {
    batch_id: "test-batch",
    source_artifact_hash: artifact.content_hash,
    candidates: [batchCandidateFrom(housing)],
  };
  const receipt = checkBatchHonesty({ artifact, demoManifest: brokenManifest, batch });
  const item = itemFor(receipt, HOUSING_JOIN.id);
  assert.equal(item.outcome, "excluded");
  assert.ok(item.excluded_reasons.includes("regression_mismatch"));
  assert.deepEqual(item.mismatched_fields, []);
  const routeField = item.predicates.find((p) => p.name === "demo_route");
  assert.equal(routeField.pass, true);
  assert.equal(routeField.expected, housing.demo.pathname);
  const claimField = item.predicates.find((p) => p.name === "claim");
  assert.equal(claimField.pass, true);
  assert.equal(receipt.deliverable, false);
});

test("A2: a stale (aged) source excludes the item via re-derived eligibility", () => {
  const artifact = buildProductUpdatesArtifact(sources({ reconciliation: healthyReconciliation({ status: "stale" }) }));
  const housing = artifact.candidates.find((c) => c.id === HOUSING_JOIN.id);
  assert.equal(housing.state, "ineligible");
  assert.equal(housing.reason, "stale");
  const batch = {
    batch_id: "test-batch",
    source_artifact_hash: artifact.content_hash,
    candidates: [batchCandidateFrom({ ...housing, claim: "a claim invented for the stale candidate" })],
  };
  const receipt = checkBatchHonesty({ artifact, demoManifest: DEMO_MANIFEST, batch });
  const item = itemFor(receipt, HOUSING_JOIN.id);
  assert.equal(item.outcome, "excluded");
  assert.ok(item.excluded_reasons.includes("artifact_ineligible"));
  assert.equal(receipt.deliverable, false);
  assert.deepEqual(receipt.eligible_ids, []);
});

test("deriveDemoRegressionState reads only the public demo manifest and fails closed", () => {
  assert.equal(deriveDemoRegressionState(DEMO_MANIFEST, "semantic-search-housing"), "passing");
  assert.equal(deriveDemoRegressionState(DEMO_MANIFEST, "does-not-exist"), "missing");
  assert.equal(deriveDemoRegressionState({ entries: [] }, "semantic-search-housing"), "missing");
  assert.equal(
    deriveDemoRegressionState({
      entries: [{ id: "x", url: "y", expectations: { visible: [] } }],
    }, "x"),
    "broken",
  );
  assert.equal(
    deriveDemoRegressionState({
      entries: [{ id: "x", url: "", expectations: { visible: [{ selector: "#a" }] } }],
    }, "x"),
    "broken",
  );
});

// --- A3: the receipt is schema-versioned, deterministic, names every
// predicate for every item, and is only deliverable when every item and the
// batch-level artifact hash check all pass.

test("A3: the receipt is schema-versioned and deterministic across repeat calls", () => {
  const artifact = buildProductUpdatesArtifact(sources());
  const batch = groundedBatch(artifact);
  const first = checkBatchHonesty({ artifact, demoManifest: DEMO_MANIFEST, batch });
  const second = checkBatchHonesty({ artifact, demoManifest: DEMO_MANIFEST, batch });
  assert.equal(first.schema, PRODUCT_UPDATES_HONESTY_RECEIPT_SCHEMA);
  assert.equal(first.method, PRODUCT_UPDATES_HONESTY_METHOD);
  assert.equal(JSON.stringify(first), JSON.stringify(second));
  assert.equal(first.content_hash, hashHonestyReceipt(first));
  assert.equal(first.content_hash, second.content_hash);
  assert.equal(serializeHonestyReceipt(first), `${JSON.stringify(first, null, 2)}\n`);
});

test("A3: deliverable is false the moment any single item in the batch fails any predicate", () => {
  const artifact = buildProductUpdatesArtifact(sources());
  const eligible = artifact.candidates.filter((c) => c.eligible);
  const batch = {
    batch_id: "test-batch",
    source_artifact_hash: artifact.content_hash,
    candidates: eligible.map((candidate) =>
      candidate.id === NOTICE_JOIN.id
        ? batchCandidateFrom(candidate, { as_of: "1999-01-01T00:00:00Z" })
        : batchCandidateFrom(candidate)),
  };
  const receipt = checkBatchHonesty({ artifact, demoManifest: DEMO_MANIFEST, batch });
  assert.equal(itemFor(receipt, HOUSING_JOIN.id).outcome, "eligible");
  assert.equal(itemFor(receipt, NOTICE_JOIN.id).outcome, "excluded");
  assert.equal(receipt.deliverable, false, "one bad item must taint the whole batch");
});

test("A3: a batch whose source_artifact_hash does not match the checked artifact is refused as a whole", () => {
  const artifact = buildProductUpdatesArtifact(sources());
  const batch = groundedBatch(artifact, { source_artifact_hash: "0".repeat(64) });
  const receipt = checkBatchHonesty({ artifact, demoManifest: DEMO_MANIFEST, batch });
  assert.equal(receipt.source_artifact_hash_match, false);
  assert.equal(receipt.deliverable, false);
  assert.deepEqual(receipt.eligible_ids, []);
  for (const item of receipt.items) {
    assert.equal(item.outcome, "excluded");
    assert.ok(item.excluded_reasons.includes("source_artifact_hash_mismatch"));
  }
});

test("A3: an empty candidate batch is not deliverable", () => {
  const artifact = buildProductUpdatesArtifact(sources());
  const batch = { batch_id: "test-batch", source_artifact_hash: artifact.content_hash, candidates: [] };
  const receipt = checkBatchHonesty({ artifact, demoManifest: DEMO_MANIFEST, batch });
  assert.equal(receipt.deliverable, false);
  assert.deepEqual(receipt.items, []);
});

test("A3: an invalid public artifact is refused as a whole and reports validation errors", () => {
  const artifact = buildProductUpdatesArtifact(sources());
  const tampered = { ...artifact, content_hash: "f".repeat(64) };
  const batch = groundedBatch(artifact, { source_artifact_hash: artifact.content_hash });
  const receipt = checkBatchHonesty({ artifact: tampered, demoManifest: DEMO_MANIFEST, batch });
  assert.equal(receipt.artifact_valid, false);
  assert.ok(receipt.artifact_errors.length > 0);
  assert.equal(receipt.deliverable, false);
});

test("A3: the committed fixture batch checks deliverable against the committed public artifact", () => {
  const artifact = JSON.parse(readFileSync(ARTIFACT_PATH, "utf8"));
  const batch = JSON.parse(readFileSync(FIXTURE_BATCH_PATH, "utf8"));
  const receipt = checkBatchHonesty({ artifact, demoManifest: DEMO_MANIFEST, batch });
  assert.deepEqual(receipt.artifact_errors, []);
  assert.equal(receipt.deliverable, true);
  assert.deepEqual(receipt.excluded_ids, []);
});

test("the CLI prints a receipt and exits non-zero exactly when the batch is not deliverable", () => {
  const good = spawnSync(process.execPath, [CLI_PATH, FIXTURE_BATCH_PATH], { cwd: ROOT, encoding: "utf8" });
  assert.equal(good.status, 0, good.stderr || good.stdout);
  const goodReceipt = JSON.parse(good.stdout);
  assert.equal(goodReceipt.deliverable, true);

  const directory = mkdtempSync(join(tmpdir(), "product-updates-honesty-"));
  try {
    const brokenBatch = JSON.parse(readFileSync(FIXTURE_BATCH_PATH, "utf8"));
    brokenBatch.candidates[0].claim = "a claim the public artifact does not record";
    const brokenPath = join(directory, "batch.json");
    writeFileSync(brokenPath, JSON.stringify(brokenBatch));
    const bad = spawnSync(process.execPath, [CLI_PATH, brokenPath], { cwd: ROOT, encoding: "utf8" });
    assert.equal(bad.status, 1);
    const badReceipt = JSON.parse(bad.stdout);
    assert.equal(badReceipt.deliverable, false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
