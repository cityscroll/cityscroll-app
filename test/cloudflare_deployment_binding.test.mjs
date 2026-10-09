import assert from "node:assert/strict";
import test from "node:test";

import {
  acquireDeploymentBinding,
  canaryVersionTag,
  planCanaryPromotion,
  planCanaryStage,
} from "../tools/cloudflare_deployment_binding.mjs";

const revision = "b".repeat(40);
const candidate = "candidate-version";
const rollback = "rollback-version";
const versions = [
  { id: candidate, annotations: { "workers/tag": canaryVersionTag(revision) } },
  { id: rollback, annotations: {} },
];
const stagedStatus = {
  created_on: "2026-10-09T01:00:00.000Z",
  versions: [
    { version_id: rollback, percentage: 95 },
    { version_id: candidate, percentage: 5 },
  ],
};

test("manual staging uploads once and preserves the rollback version", () => {
  const status = {
    created_on: stagedStatus.created_on,
    versions: [{ version_id: rollback, percentage: 100 }],
  };
  const upload = planCanaryStage({
    eventName: "workflow_dispatch",
    releaseMode: "stage",
    status,
    versions: [{ id: rollback, annotations: {} }],
    revision,
  });
  assert.deepEqual(upload, {
    action: "upload",
    tag: canaryVersionTag(revision),
    candidate_version_id: null,
    rollback_version_id: rollback,
    candidate_percentage: 5,
    rollback_percentage: 95,
  });
  assert.equal(planCanaryStage({
    eventName: "workflow_dispatch",
    releaseMode: "stage",
    status,
    versions,
    revision,
  }).action, "deploy-existing");
  assert.equal(planCanaryStage({
    eventName: "workflow_dispatch",
    releaseMode: "stage",
    status: stagedStatus,
    versions,
    revision,
  }).action, "already-staged");
});

test("automatic and ambiguous staging fail closed", () => {
  const status = { versions: [{ version_id: rollback, percentage: 100 }] };
  assert.throws(() => planCanaryStage({
    eventName: "push", releaseMode: "stage", status, versions, revision,
  }), /workflow_dispatch/);
  assert.throws(() => planCanaryStage({
    eventName: "workflow_dispatch",
    releaseMode: "stage",
    status: stagedStatus,
    versions: [...versions, { id: "duplicate", annotations: { "workers/tag": canaryVersionTag(revision) } }],
    revision,
  }), /ambiguous candidate tag/);
  assert.throws(() => planCanaryStage({
    eventName: "workflow_dispatch",
    releaseMode: "stage",
    status: {
      versions: [
        { version_id: rollback, percentage: 90 },
        { version_id: candidate, percentage: 10 },
      ],
    },
    versions,
    revision,
  }), /bounded canary allocation/);
});

test("promotion accepts only the exact staged version and its safe retry", () => {
  const staged = planCanaryPromotion({ status: stagedStatus, versions, revision });
  assert.deepEqual(staged, {
    state: "staged",
    tag: canaryVersionTag(revision),
    candidate_version_id: candidate,
    rollback_version_id: rollback,
    candidate_percentage: 5,
  });
  assert.equal(planCanaryPromotion({
    status: {
      created_on: stagedStatus.created_on,
      versions: [{ version_id: candidate, percentage: 100 }],
    },
    versions,
    revision,
  }).state, "already-promoted");
  assert.throws(() => planCanaryPromotion({
    status: {
      versions: [
        { version_id: "unrelated", percentage: 95 },
        { version_id: "also-unrelated", percentage: 5 },
      ],
    },
    versions,
    revision,
  }), /unrelated version/);
});

test("deployment binding targets candidate health and joins exact provider identity", async () => {
  const binding = await acquireDeploymentBinding({
    providerStatus: stagedStatus,
    providerVersions: versions,
    healthUrl: "https://example.test/health",
    workerName: "cityscroll-worker",
    expectedRevision: revision,
    fetchImpl: async (_url, init) => {
      assert.equal(init.headers["User-Agent"], "Mozilla/5.0 (compatible; CityScrollCostControl/1.0; +https://cityscroll.org)");
      assert.equal(init.headers["Cloudflare-Workers-Version-Overrides"], `cityscroll-worker="${candidate}"`);
      return {
        ok: true,
        json: async () => ({ status: "cityscroll-worker ok", environment: "production", commit: revision }),
      };
    },
  });
  assert.equal(binding.receipt.production_health.revision, revision);
  assert.equal(binding.receipt.cloudflare_version.id, candidate);
  assert.equal(binding.receipt.observed_at, stagedStatus.created_on);
  assert.match(binding.provider_receipt_sha256, /^[a-f0-9]{64}$/);
});

test("deployment binding rejects mismatched candidate health", async () => {
  await assert.rejects(() => acquireDeploymentBinding({
    providerStatus: stagedStatus,
    providerVersions: versions,
    healthUrl: "https://example.test/health",
    workerName: "cityscroll-worker",
    expectedRevision: revision,
    fetchImpl: async () => ({
      ok: true,
      json: async () => ({
        status: "cityscroll-worker ok",
        environment: "production",
        commit: "a".repeat(40),
      }),
    }),
  }), /does not match expected revision/);
});
