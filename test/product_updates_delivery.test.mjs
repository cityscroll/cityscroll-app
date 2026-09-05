import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { CAPABILITY_REGISTRY } from "../capabilities/registry.mjs";
import {
  PRODUCT_UPDATE_JOINS,
  buildProductUpdatesArtifact,
  hashProductUpdatesEvidence,
} from "../site/product_updates_source.mjs";
import { checkBatchHonesty } from "../site/product_updates_honesty.mjs";
import {
  PRODUCT_UPDATES_DELIVERY_AUTHORIZATION_SCHEMA,
  authorizeDelivery,
  hashProductUpdatesBatch,
  recordDelivery,
} from "../site/product_updates_delivery.mjs";
import { loadWatermark } from "../tools/architecture_watermark.mjs";

const DEMO_MANIFEST = JSON.parse(readFileSync(new URL("../site/demo/demo-links.json", import.meta.url), "utf8"));
const CHANGELOG = JSON.parse(readFileSync(new URL("../site/changelog-data.json", import.meta.url), "utf8"));
const WATERMARK = loadWatermark();

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

function batchCandidateFrom(candidate) {
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
  };
}

function groundedBatch(artifact) {
  const eligible = artifact.candidates.filter((candidate) => candidate.eligible === true);
  return {
    batch_id: "delivery-test-batch",
    source_artifact_hash: artifact.content_hash,
    candidates: eligible.map((candidate) => batchCandidateFrom(candidate)),
  };
}

// A fully authorized baseline: an artifact, a batch built exactly from its
// eligible candidates, a review-desk approval bound to that exact batch and
// artifact, and a deliverable honesty receipt for the same pairing.
function authorizedFixture() {
  const artifact = buildProductUpdatesArtifact(sources());
  const batch = groundedBatch(artifact);
  const honestyReceipt = checkBatchHonesty({ artifact, demoManifest: DEMO_MANIFEST, batch });
  assert.equal(honestyReceipt.deliverable, true, "fixture batch must be honestly deliverable");
  const approval = {
    batch_id: batch.batch_id,
    source_artifact_hash: artifact.content_hash,
    content_hash: hashProductUpdatesBatch(batch),
    decision: "approve",
    decided_at: "2026-09-05T12:00:00Z",
    reviewer_id: "reviewer:example",
  };
  return { artifact, batch, honestyReceipt, approval };
}

test("only the exact approval-bound content hash is authorized", () => {
  const { artifact, batch, honestyReceipt, approval } = authorizedFixture();
  const result = authorizeDelivery({ approval, batch, artifact, honestyReceipt, deliveredLedger: new Map() });
  assert.equal(result.authorized, true);
  assert.deepEqual(result.refusals, []);
  assert.equal(result.authorization.schema, PRODUCT_UPDATES_DELIVERY_AUTHORIZATION_SCHEMA);
  assert.equal(result.authorization.batch_id, batch.batch_id);
  assert.equal(result.authorization.content_hash, hashProductUpdatesBatch(batch));
  assert.equal(result.authorization.source_artifact_hash, hashProductUpdatesEvidence(artifact));
  assert.equal(result.authorization.reviewer_id, "reviewer:example");

  const again = authorizeDelivery({ approval, batch, artifact, honestyReceipt, deliveredLedger: new Map() });
  assert.equal(again.authorization.content_hash, result.authorization.content_hash);
  assert.equal(JSON.stringify(again.authorization), JSON.stringify(result.authorization));
});

test("refuses a batch with no approval, and a batch the review desk rejected or sent back for edits", () => {
  const { artifact, batch, honestyReceipt, approval } = authorizedFixture();

  const missing = authorizeDelivery({ batch, artifact, honestyReceipt, deliveredLedger: new Map() });
  assert.equal(missing.authorized, false);
  assert.ok(missing.refusals.some((r) => r.code === "unapproved"));
  assert.equal(missing.authorization, null);

  for (const decision of ["reject", "request_edits"]) {
    const result = authorizeDelivery({
      approval: { ...approval, decision },
      batch,
      artifact,
      honestyReceipt,
      deliveredLedger: new Map(),
    });
    assert.equal(result.authorized, false);
    assert.deepEqual(result.refusals.map((r) => r.code), ["unapproved"]);
  }
});

test("refuses a batch whose recomputed content hash no longer matches the approval-bound hash (edited)", () => {
  const { artifact, batch, honestyReceipt, approval } = authorizedFixture();
  const editedApproval = { ...approval, content_hash: "0".repeat(64) };
  const result = authorizeDelivery({ approval: editedApproval, batch, artifact, honestyReceipt, deliveredLedger: new Map() });
  assert.equal(result.authorized, false);
  assert.deepEqual(result.refusals.map((r) => r.code), ["edited"]);
});

test("refuses a batch when the current public artifact no longer matches the approved source artifact hash (stale)", () => {
  const { artifact, batch, honestyReceipt, approval } = authorizedFixture();
  const staleApproval = { ...approval, source_artifact_hash: "f".repeat(64) };
  const result = authorizeDelivery({ approval: staleApproval, batch, artifact, honestyReceipt, deliveredLedger: new Map() });
  assert.equal(result.authorized, false);
  assert.deepEqual(result.refusals.map((r) => r.code), ["stale"]);
});

test("refuses a batch whose honesty receipt is missing, mismatched, or not deliverable (inconsistent)", () => {
  const { artifact, batch, honestyReceipt, approval } = authorizedFixture();

  const missing = authorizeDelivery({ approval, batch, artifact, honestyReceipt: null, deliveredLedger: new Map() });
  assert.equal(missing.authorized, false);
  assert.deepEqual(missing.refusals.map((r) => r.code), ["inconsistent"]);

  const notDeliverable = authorizeDelivery({
    approval,
    batch,
    artifact,
    honestyReceipt: { ...honestyReceipt, deliverable: false },
    deliveredLedger: new Map(),
  });
  assert.equal(notDeliverable.authorized, false);
  assert.deepEqual(notDeliverable.refusals.map((r) => r.code), ["inconsistent"]);

  const wrongBatch = authorizeDelivery({
    approval,
    batch,
    artifact,
    honestyReceipt: { ...honestyReceipt, batch_id: "some-other-batch" },
    deliveredLedger: new Map(),
  });
  assert.equal(wrongBatch.authorized, false);
  assert.deepEqual(wrongBatch.refusals.map((r) => r.code), ["inconsistent"]);
});

test("refuses a batch id or content hash already present in the delivered ledger (duplicate)", () => {
  const { artifact, batch, honestyReceipt, approval } = authorizedFixture();
  const first = authorizeDelivery({ approval, batch, artifact, honestyReceipt, deliveredLedger: new Map() });
  assert.equal(first.authorized, true);

  const ledger = new Map([[first.authorization.content_hash, first.authorization]]);
  const second = authorizeDelivery({ approval, batch, artifact, honestyReceipt, deliveredLedger: ledger });
  assert.equal(second.authorized, false);
  assert.deepEqual(second.refusals.map((r) => r.code), ["duplicate"]);

  const byBatchIdOnly = new Map([["different-content-hash", { batch_id: batch.batch_id }]]);
  const third = authorizeDelivery({ approval, batch, artifact, honestyReceipt, deliveredLedger: byBatchIdOnly });
  assert.equal(third.authorized, false);
  assert.ok(third.refusals.some((r) => r.code === "duplicate"));
});

test("any single-field mutation of an authorized batch is refused", () => {
  const { artifact, batch, honestyReceipt, approval } = authorizedFixture();
  const baseline = authorizeDelivery({ approval, batch, artifact, honestyReceipt, deliveredLedger: new Map() });
  assert.equal(baseline.authorized, true, "fixture must start out authorized");

  const mutations = [
    (b) => ({ ...b, batch_id: `${b.batch_id}-mutated` }),
    (b) => ({ ...b, source_artifact_hash: "1".repeat(64) }),
    (b) => ({ ...b, candidates: [...b.candidates, b.candidates[0]] }),
    (b) => ({ ...b, candidates: b.candidates.slice(1) }),
    (b) => ({ ...b, candidates: b.candidates.map((c, i) => (i === 0 ? { ...c, claim: `${c.claim} (mutated)` } : c)) }),
    (b) => ({ ...b, candidates: b.candidates.map((c, i) => (i === 0 ? { ...c, as_of: "1999-01-01T00:00:00Z" } : c)) }),
  ];

  for (const mutate of mutations) {
    const mutatedBatch = mutate(batch);
    const result = authorizeDelivery({
      approval,
      batch: mutatedBatch,
      artifact,
      honestyReceipt,
      deliveredLedger: new Map(),
    });
    assert.equal(result.authorized, false, `mutation must be refused: ${JSON.stringify(mutatedBatch).slice(0, 80)}`);
    assert.ok(result.refusals.length > 0);
  }
});

test("recordDelivery is a pure ledger append that refuses a repeat end to end", () => {
  const { artifact, batch, honestyReceipt, approval } = authorizedFixture();
  const authorized = authorizeDelivery({ approval, batch, artifact, honestyReceipt, deliveredLedger: new Map() });
  assert.equal(authorized.authorized, true);

  const empty = new Map();
  const first = recordDelivery(empty, authorized.authorization);
  assert.equal(first.recorded, true);
  assert.equal(first.refusal, null);
  assert.equal(empty.size, 0, "recordDelivery must not mutate the ledger it was given");
  assert.equal(first.ledger.size, 1);
  assert.equal(first.ledger.get(authorized.authorization.content_hash), authorized.authorization);

  const second = recordDelivery(first.ledger, authorized.authorization);
  assert.equal(second.recorded, false);
  assert.equal(second.refusal.code, "duplicate");
  assert.equal(second.ledger.size, 1);

  const rejectedAsDuplicate = authorizeDelivery({
    approval,
    batch,
    artifact,
    honestyReceipt,
    deliveredLedger: first.ledger,
  });
  assert.equal(rejectedAsDuplicate.authorized, false);
  assert.deepEqual(rejectedAsDuplicate.refusals.map((r) => r.code), ["duplicate"]);
});
