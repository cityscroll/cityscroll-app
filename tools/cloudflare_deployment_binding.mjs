#!/usr/bin/env node

import { readFileSync, writeFileSync } from "node:fs";

import { providerDeploymentReceiptSha256 } from "./lib/worker_cost_control.mjs";

const IDENTIFIED_USER_AGENT = "Mozilla/5.0 (compatible; CityScrollCostControl/1.0; +https://cityscroll.org)";

function fail(message) {
  throw new Error(message);
}

function arg(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : null;
}

export function activeProviderVersion(status) {
  const versions = status?.versions;
  if (!Array.isArray(versions) || versions.length !== 1) fail("provider status must contain exactly one active version");
  const active = versions[0];
  if (Number(active?.percentage) !== 100) fail("provider status must route 100 percent to the active version");
  if (typeof active?.version_id !== "string" || !active.version_id.trim()) fail("provider status version_id is required");
  return active.version_id;
}

export async function acquireDeploymentBinding({ providerStatus, healthUrl, expectedRevision, fetchImpl = fetch }) {
  if (!/^https:\/\//.test(String(healthUrl || ""))) fail("health URL must use HTTPS");
  if (!/^[a-f0-9]{40}$/.test(String(expectedRevision || ""))) fail("expected revision must be a full commit SHA");
  const response = await fetchImpl(healthUrl, {
    headers: { Accept: "application/json", "User-Agent": IDENTIFIED_USER_AGENT },
    redirect: "error",
  });
  if (!response.ok) fail(`production health returned HTTP ${response.status}`);
  const health = await response.json();
  if (health?.status !== "ok" || health?.environment !== "production") fail("production health identity is invalid");
  if (health?.commit !== expectedRevision) fail("production health revision does not match expected revision");
  const deployedAt = new Date(providerStatus?.created_on);
  if (!Number.isFinite(deployedAt.getTime())) fail("provider status created_on is invalid");
  const receipt = {
    schema: "cityscroll.cloudflare_deployment_binding.v1",
    evidence_mode: "actual-production",
    observed_at: deployedAt.toISOString(),
    production_health: { source: "cityscroll-production-health", revision: health.commit },
    cloudflare_version: { source: "cloudflare-versions-api", id: activeProviderVersion(providerStatus) },
  };
  return {
    source: "cloudflare-deployment-receipt+health",
    receipt,
    provider_receipt_sha256: providerDeploymentReceiptSha256(receipt),
  };
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  if (process.argv[2] !== "acquire") fail("usage: cloudflare_deployment_binding.mjs acquire --provider-status <path> --health-url <url> --expected-revision <sha> --out <path>");
  const providerStatusPath = arg("--provider-status");
  const healthUrl = arg("--health-url");
  const expectedRevision = arg("--expected-revision");
  const out = arg("--out");
  if (!providerStatusPath || !out) fail("provider status and output paths are required");
  const binding = await acquireDeploymentBinding({
    providerStatus: JSON.parse(readFileSync(providerStatusPath, "utf8")),
    healthUrl,
    expectedRevision,
  });
  writeFileSync(out, `${JSON.stringify(binding, null, 2)}\n`, { mode: 0o600 });
  console.log(JSON.stringify({ ok: true, receipt: out, provider_receipt_sha256: binding.provider_receipt_sha256 }));
}
