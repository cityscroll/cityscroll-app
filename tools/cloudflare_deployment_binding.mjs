#!/usr/bin/env node

import { readFileSync, writeFileSync } from "node:fs";

import { providerDeploymentReceiptSha256 } from "./lib/worker_cost_control.mjs";

const IDENTIFIED_USER_AGENT = "Mozilla/5.0 (compatible; CityScrollCostControl/1.0; +https://cityscroll.org)";
export const CANARY_TRAFFIC_PERCENTAGE = 5;

function fail(message) {
  throw new Error(message);
}

function arg(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : null;
}

function requireRevision(revision) {
  if (!/^[a-f0-9]{40}$/.test(String(revision || ""))) fail("expected revision must be a full commit SHA");
  return revision;
}

export function canaryVersionTag(revision) {
  return `cityscroll-canary-${requireRevision(revision)}`;
}

function providerVersions(versions) {
  if (!Array.isArray(versions)) fail("provider versions must be an array");
  return versions.map((version) => {
    if (typeof version?.id !== "string" || !version.id.trim()) fail("provider version id is required");
    const annotations = version.annotations;
    if (!annotations || typeof annotations !== "object" || Array.isArray(annotations)) {
      fail("provider version annotations are required");
    }
    const tag = annotations["workers/tag"];
    if (tag != null && typeof tag !== "string") fail("provider version tag must be a string");
    return { id: version.id, tag: tag || null };
  });
}

function activeVersions(status) {
  const versions = status?.versions;
  if (!Array.isArray(versions) || ![1, 2].includes(versions.length)) {
    fail("provider status must contain one or two active versions");
  }
  const seen = new Set();
  const active = versions.map((version) => {
    if (typeof version?.version_id !== "string" || !version.version_id.trim()) {
      fail("provider status version_id is required");
    }
    const percentage = Number(version.percentage);
    if (!Number.isFinite(percentage) || percentage < 0 || percentage > 100) {
      fail("provider status percentage is invalid");
    }
    if (seen.has(version.version_id)) fail("provider status contains a duplicate version");
    seen.add(version.version_id);
    return { id: version.version_id, percentage };
  });
  if (active.reduce((sum, version) => sum + version.percentage, 0) !== 100) {
    fail("provider status traffic percentages must total 100");
  }
  return active;
}

function taggedCandidate(versions, revision) {
  const tag = canaryVersionTag(revision);
  const matches = providerVersions(versions).filter((version) => version.tag === tag);
  if (matches.length > 1) fail("provider versions contain an ambiguous candidate tag");
  return { tag, candidate: matches[0] || null };
}

export function planCanaryStage({ eventName, releaseMode, status, versions, revision } = {}) {
  if (eventName !== "workflow_dispatch" || releaseMode !== "stage") {
    fail("canary staging is allowed only by an explicit workflow_dispatch stage request");
  }
  const active = activeVersions(status);
  const { tag, candidate } = taggedCandidate(versions, revision);
  if (active.length === 1) {
    if (active[0].percentage !== 100) fail("single-version deployment must receive 100 percent traffic");
    if (candidate?.id === active[0].id) fail("candidate is already promoted and cannot be staged again");
    return {
      action: candidate ? "deploy-existing" : "upload",
      tag,
      candidate_version_id: candidate?.id || null,
      rollback_version_id: active[0].id,
      candidate_percentage: CANARY_TRAFFIC_PERCENTAGE,
      rollback_percentage: 100 - CANARY_TRAFFIC_PERCENTAGE,
    };
  }
  if (!candidate) fail("split deployment does not contain the tagged candidate");
  const candidateActive = active.find((version) => version.id === candidate.id);
  const rollback = active.find((version) => version.id !== candidate.id);
  if (!candidateActive || !rollback) fail("split deployment contains an unrelated version");
  if (
    candidateActive.percentage !== CANARY_TRAFFIC_PERCENTAGE
    || rollback.percentage !== 100 - CANARY_TRAFFIC_PERCENTAGE
  ) fail("split deployment does not match the bounded canary allocation");
  return {
    action: "already-staged",
    tag,
    candidate_version_id: candidate.id,
    rollback_version_id: rollback.id,
    candidate_percentage: candidateActive.percentage,
    rollback_percentage: rollback.percentage,
  };
}

export function planCanaryPromotion({ status, versions, revision } = {}) {
  const active = activeVersions(status);
  const { tag, candidate } = taggedCandidate(versions, revision);
  if (!candidate) fail("tagged candidate version is unavailable");
  if (active.length === 1) {
    if (active[0].id !== candidate.id || active[0].percentage !== 100) {
      fail("active deployment is not the staged candidate or its safe retry");
    }
    return {
      state: "already-promoted",
      tag,
      candidate_version_id: candidate.id,
      rollback_version_id: null,
      candidate_percentage: 100,
    };
  }
  const candidateActive = active.find((version) => version.id === candidate.id);
  const rollback = active.find((version) => version.id !== candidate.id);
  if (!candidateActive || !rollback) fail("split deployment contains an unrelated version");
  if (
    candidateActive.percentage !== CANARY_TRAFFIC_PERCENTAGE
    || rollback.percentage !== 100 - CANARY_TRAFFIC_PERCENTAGE
  ) fail("candidate is not receiving the bounded positive canary allocation");
  return {
    state: "staged",
    tag,
    candidate_version_id: candidate.id,
    rollback_version_id: rollback.id,
    candidate_percentage: candidateActive.percentage,
  };
}

export function recheckCanaryStage({ initialPlan, status, versions, revision } = {}) {
  if (!initialPlan || !["upload", "deploy-existing"].includes(initialPlan.action)) {
    fail("initial stage plan does not authorize a traffic mutation");
  }
  const current = planCanaryStage({
    eventName: "workflow_dispatch",
    releaseMode: "stage",
    status,
    versions,
    revision,
  });
  if (current.action === "upload") fail("tagged candidate version is still unavailable");
  if (current.tag !== initialPlan.tag) fail("candidate tag changed after initial stage planning");
  if (current.rollback_version_id !== initialPlan.rollback_version_id) {
    fail("rollback identity changed after initial stage planning");
  }
  if (initialPlan.candidate_version_id && current.candidate_version_id !== initialPlan.candidate_version_id) {
    fail("candidate identity changed after initial stage planning");
  }
  return current;
}

export function recheckCanaryPromotion({ initialPlan, status, versions, revision } = {}) {
  if (!initialPlan || !["staged", "already-promoted"].includes(initialPlan.state)) {
    fail("initial promotion plan is invalid");
  }
  const current = planCanaryPromotion({ status, versions, revision });
  if (current.tag !== initialPlan.tag || current.candidate_version_id !== initialPlan.candidate_version_id) {
    fail("candidate identity changed after initial promotion planning");
  }
  if (initialPlan.state === "already-promoted" && current.state !== "already-promoted") {
    fail("promoted candidate changed after initial promotion planning");
  }
  if (
    current.state === "staged"
    && current.rollback_version_id !== initialPlan.rollback_version_id
  ) fail("rollback identity changed after initial promotion planning");
  return current;
}

function activeFullTrafficVersion(status) {
  const active = activeVersions(status);
  if (active.length !== 1 || active[0].percentage !== 100) {
    fail("baseline provider status must contain one full-traffic version");
  }
  return active[0].id;
}

async function acquireHealthBinding({
  providerStatus,
  healthUrl,
  workerName,
  expectedRevision,
  providerVersionId,
  overrideVersion,
  fetchImpl,
}) {
  if (!/^https:\/\//.test(String(healthUrl || ""))) fail("health URL must use HTTPS");
  if (!/^[a-z0-9-]+$/.test(String(workerName || ""))) fail("worker name is invalid");
  requireRevision(expectedRevision);
  const headers = { Accept: "application/json", "User-Agent": IDENTIFIED_USER_AGENT };
  if (overrideVersion) {
    headers["Cloudflare-Workers-Version-Overrides"] = `${workerName}="${providerVersionId}"`;
  }
  const response = await fetchImpl(healthUrl, { headers, redirect: "error" });
  if (!response.ok) fail(`production health returned HTTP ${response.status}`);
  const health = await response.json();
  if (health?.status !== "cityscroll-worker ok" || health?.environment !== "production") {
    fail("production health identity is invalid");
  }
  if (health?.commit !== expectedRevision) fail("production health revision does not match expected revision");
  const deployedAt = new Date(providerStatus?.created_on);
  if (!Number.isFinite(deployedAt.getTime())) fail("provider status created_on is invalid");
  const receipt = {
    schema: "cityscroll.cloudflare_deployment_binding.v1",
    evidence_mode: "actual-production",
    observed_at: deployedAt.toISOString(),
    production_health: { source: "cityscroll-production-health", revision: health.commit },
    cloudflare_version: { source: "cloudflare-versions-api", id: providerVersionId },
  };
  return {
    source: "cloudflare-deployment-receipt+health",
    receipt,
    provider_receipt_sha256: providerDeploymentReceiptSha256(receipt),
  };
}

export async function acquireDeploymentBinding({
  providerStatus,
  providerVersions: versions,
  healthUrl,
  workerName,
  expectedRevision,
  fetchImpl = fetch,
}) {
  const plan = planCanaryPromotion({ status: providerStatus, versions, revision: expectedRevision });
  return acquireHealthBinding({
    providerStatus,
    healthUrl,
    workerName,
    expectedRevision,
    providerVersionId: plan.candidate_version_id,
    overrideVersion: true,
    fetchImpl,
  });
}

export async function acquireActiveDeploymentBinding({
  providerStatus,
  healthUrl,
  workerName,
  expectedRevision,
  fetchImpl = fetch,
}) {
  return acquireHealthBinding({
    providerStatus,
    healthUrl,
    workerName,
    expectedRevision,
    providerVersionId: activeFullTrafficVersion(providerStatus),
    overrideVersion: false,
    fetchImpl,
  });
}

function readJson(path, label) {
  if (!path) fail(`${label} path is required`);
  return JSON.parse(readFileSync(path, "utf8"));
}

function writePrivateJson(path, value) {
  if (!path) fail("output path is required");
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  const command = process.argv[2];
  const providerStatus = readJson(arg("--provider-status"), "provider status");
  const expectedRevision = arg("--expected-revision");
  const out = arg("--out");
  let result;
  if (command === "stage-plan") {
    const versions = readJson(arg("--provider-versions"), "provider versions");
    result = planCanaryStage({
      eventName: arg("--event-name"),
      releaseMode: arg("--release-mode"),
      status: providerStatus,
      versions,
      revision: expectedRevision,
    });
  } else if (command === "stage-recheck") {
    const versions = readJson(arg("--provider-versions"), "provider versions");
    result = recheckCanaryStage({
      initialPlan: readJson(arg("--initial-plan"), "initial plan"),
      status: providerStatus,
      versions,
      revision: expectedRevision,
    });
  } else if (command === "promotion-plan") {
    const versions = readJson(arg("--provider-versions"), "provider versions");
    result = planCanaryPromotion({ status: providerStatus, versions, revision: expectedRevision });
  } else if (command === "promotion-recheck") {
    const versions = readJson(arg("--provider-versions"), "provider versions");
    result = recheckCanaryPromotion({
      initialPlan: readJson(arg("--initial-plan"), "initial plan"),
      status: providerStatus,
      versions,
      revision: expectedRevision,
    });
  } else if (command === "acquire") {
    const versions = readJson(arg("--provider-versions"), "provider versions");
    result = await acquireDeploymentBinding({
      providerStatus,
      providerVersions: versions,
      healthUrl: arg("--health-url"),
      workerName: arg("--worker-name"),
      expectedRevision,
    });
  } else if (command === "acquire-active") {
    result = await acquireActiveDeploymentBinding({
      providerStatus,
      healthUrl: arg("--health-url"),
      workerName: arg("--worker-name"),
      expectedRevision,
    });
  } else {
    fail("usage: cloudflare_deployment_binding.mjs <stage-plan|stage-recheck|promotion-plan|promotion-recheck|acquire|acquire-active> [options]");
  }
  writePrivateJson(out, result);
  const state = result.action || result.state || "acquired";
  console.log(JSON.stringify({ ok: true, state }));
}
