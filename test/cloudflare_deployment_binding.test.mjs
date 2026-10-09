import assert from "node:assert/strict";
import test from "node:test";

import { acquireDeploymentBinding, activeProviderVersion } from "../tools/cloudflare_deployment_binding.mjs";

const revision = "b".repeat(40);
const providerStatus = {
  created_on: "2026-10-09T01:00:00.000Z",
  versions: [{ version_id: "provider-version", percentage: 100 }],
};

test("deployment binding joins authenticated provider status to exact production health", async () => {
  const binding = await acquireDeploymentBinding({
    providerStatus,
    healthUrl: "https://example.test/health",
    expectedRevision: revision,
    fetchImpl: async (_url, init) => {
      assert.equal(init.headers["User-Agent"], "Mozilla/5.0 (compatible; CityScrollCostControl/1.0; +https://cityscroll.org)");
      return { ok: true, json: async () => ({ status: "ok", environment: "production", commit: revision }) };
    },
  });
  assert.equal(binding.receipt.production_health.revision, revision);
  assert.equal(binding.receipt.cloudflare_version.id, "provider-version");
  assert.equal(binding.receipt.observed_at, providerStatus.created_on);
  assert.match(binding.provider_receipt_sha256, /^[a-f0-9]{64}$/);
});

test("deployment binding rejects rollout ambiguity and mismatched health", async () => {
  assert.throws(() => activeProviderVersion({ versions: [
    { version_id: "old", percentage: 50 },
    { version_id: "new", percentage: 50 },
  ] }), /exactly one active version/);
  await assert.rejects(() => acquireDeploymentBinding({
    providerStatus,
    healthUrl: "https://example.test/health",
    expectedRevision: revision,
    fetchImpl: async () => ({ ok: true, json: async () => ({ status: "ok", environment: "production", commit: "a".repeat(40) }) }),
  }), /does not match expected revision/);
});
