#!/usr/bin/env node

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const DEPLOYMENT_HEALTH_RECEIPT_SCHEMA = "cityscroll.deployment-health-receipt.v1";
export const DEPLOYMENT_HEALTH_RECONCILIATION_SCHEMA = "cityscroll.deployment-health-reconciliation.v1";
export const DEPLOYMENT_HEALTH_KIND = "deployment";
export const RELEASE_SURFACE_KIND = "release-surface";
export const DEPLOYMENT_HEALTH_STATUSES = Object.freeze(["PASS", "FAIL", "UNKNOWN"]);
export const DEPLOYMENT_RECONCILIATION_COMPLETE = "COMPLETE";
export const DEPLOYMENT_RECONCILIATION_INCOMPLETE = "INCOMPLETE";

export const CLOUDFLARE_PAGES_BOUNDARY = "cloudflare-pages";
export const CLOUDFLARE_WORKER_BOUNDARY = "cloudflare-worker";

export const DEPLOYMENT_HEALTH_BOUNDARIES = Object.freeze({
  [CLOUDFLARE_PAGES_BOUNDARY]: Object.freeze({
    id: CLOUDFLARE_PAGES_BOUNDARY,
    name: "Cloudflare Pages",
    pipeline: "deploy-cloudflare-pages",
    workflow: ".github/workflows/deploy-cloudflare-pages.yml",
    artifact_type: "pages-artifact-hash",
    provider: "cloudflare-pages",
  }),
  [CLOUDFLARE_WORKER_BOUNDARY]: Object.freeze({
    id: CLOUDFLARE_WORKER_BOUNDARY,
    name: "Cloudflare Worker",
    pipeline: "deploy-worker",
    workflow: ".github/workflows/deploy-worker.yml",
    artifact_type: "worker-commit",
    provider: "cloudflare-workers",
  }),
});

export const REQUIRED_PRODUCTION_BOUNDARIES = Object.freeze([
  CLOUDFLARE_PAGES_BOUNDARY,
  CLOUDFLARE_WORKER_BOUNDARY,
]);

const RUNTIME_WATCHDOG_SCHEMAS = new Set([
  "cityscroll.digest-shadow-ready-receipt.v1",
  "cityscroll.digest-terminal-delivery-receipt.v1",
  "cityscroll.digest-shadow-degraded-decision.v1",
]);

const POSITIVE = new Set(["pass", "passed", "success", "succeeded", "ok", "healthy", "deployed"]);
const NEGATIVE = new Set(["fail", "failed", "failure", "error", "unhealthy", "missing", "skipped", "cancelled"]);

function validSha(value) {
  return typeof value === "string" && /^[a-f0-9]{40,64}$/i.test(value.trim());
}

function validArtifactHash(value) {
  return typeof value === "string" && /^[a-f0-9]{64}$/i.test(value.trim());
}

function validTimestamp(value) {
  const parsed = Date.parse(value || "");
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeSha(value) {
  return validSha(value) ? value.trim().toLowerCase() : null;
}

function normalizeStatus(value) {
  if (value == null) return null;
  const text = String(value).trim().toLowerCase();
  if (!text) return null;
  if (POSITIVE.has(text)) return "PASS";
  if (NEGATIVE.has(text)) return "FAIL";
  if (text === "unknown") return "UNKNOWN";
  return null;
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function boundaryMeta(id) {
  return DEPLOYMENT_HEALTH_BOUNDARIES[id] || null;
}

function boundaryName(id) {
  return boundaryMeta(id)?.name || id || "unknown boundary";
}

export function loadDeclaredProductionBoundaries(config) {
  const rows = config?.required_production_boundaries;
  if (!Array.isArray(rows) || rows.length !== REQUIRED_PRODUCTION_BOUNDARIES.length) {
    throw new Error("required production boundaries must be exactly Cloudflare Pages and Cloudflare Worker");
  }
  const findings = [];
  const declared = rows.map((row, index) => {
    const expectedId = REQUIRED_PRODUCTION_BOUNDARIES[index];
    const expected = DEPLOYMENT_HEALTH_BOUNDARIES[expectedId];
    if (!row || row.id !== expected.id) {
      findings.push(`required production boundary ${index + 1} must be ${expected.id}`);
    }
    if (row?.name !== expected.name) {
      findings.push(`${expected.id} must be named ${expected.name}`);
    }
    if (row?.pipeline !== expected.pipeline) {
      findings.push(`${expected.id} pipeline must be ${expected.pipeline}`);
    }
    if (row?.workflow !== expected.workflow) {
      findings.push(`${expected.id} workflow must be ${expected.workflow}`);
    }
    return expected;
  });
  if (findings.length) {
    throw new Error(findings.join("; "));
  }
  return declared;
}

export function classifyEvidence(value) {
  if (!value || typeof value !== "object") return { kind: "missing", schema: null };
  const schema = typeof value.schema === "string" ? value.schema : null;
  if (schema === DEPLOYMENT_HEALTH_RECEIPT_SCHEMA) {
    return { kind: DEPLOYMENT_HEALTH_KIND, schema };
  }
  if (schema === "cityscroll.release-surface-receipt.v1" || value.kind === RELEASE_SURFACE_KIND) {
    return { kind: RELEASE_SURFACE_KIND, schema: schema || "cityscroll.release-surface-receipt.v1" };
  }
  if (schema === "cityscroll.generation-output-receipt.v1") {
    return { kind: "generation", schema };
  }
  if (RUNTIME_WATCHDOG_SCHEMAS.has(schema) || /watchdog|scheduler|digest/i.test(schema || "")) {
    return { kind: "runtime-watchdog", schema };
  }
  if (value.stages && (value.stages.watchdog || value.stages.scheduler || value.stages.alert_delivery)) {
    return { kind: RELEASE_SURFACE_KIND, schema: schema || "cityscroll.release-surface-receipt.v1" };
  }
  return { kind: "unknown", schema };
}

function statusFromFindings(findings, failed = false) {
  if (failed || findings.some((finding) => /failed|failure|mismatch|does not match|invalid schema/i.test(finding))) {
    return findings.length ? "FAIL" : "PASS";
  }
  return findings.length ? "UNKNOWN" : "PASS";
}

export function buildGuardResult(name, status, findings = []) {
  const normalized = normalizeStatus(status) || "UNKNOWN";
  return {
    name,
    status: normalized,
    findings: unique(findings),
  };
}

export function guardsFromGenerationReceipt(receipt) {
  if (!receipt || typeof receipt !== "object") {
    return [buildGuardResult("generation_output", "UNKNOWN", ["generation output receipt is missing"])];
  }
  const findings = [];
  if (receipt.schema !== "cityscroll.generation-output-receipt.v1") {
    findings.push("generation output receipt has an invalid schema");
  }
  if (Array.isArray(receipt.findings) && receipt.findings.length) findings.push(...receipt.findings);
  if (receipt.status !== "passed" && receipt.status !== "PASS") {
    findings.push(`generation output status is ${receipt.status || "missing"}`);
  }
  return [buildGuardResult("generation_output", findings.length ? "FAIL" : "PASS", findings)];
}

export function buildDeploymentHealthReceipt({
  boundary,
  pipeline,
  mergedSourceSha,
  deployedCommitSha,
  artifactType,
  artifactValue,
  deploymentId,
  deploymentUrl,
  providerStatus,
  guardResults = [],
  observedAt = new Date().toISOString(),
  workflowRunUrl = null,
} = {}) {
  const meta = boundaryMeta(boundary);
  const findings = [];
  if (!meta) findings.push(`unknown production boundary: ${boundary || "missing"}`);
  const expectedPipeline = meta?.pipeline;
  const resolvedPipeline = pipeline || expectedPipeline || null;
  if (meta && resolvedPipeline !== expectedPipeline) {
    findings.push(`${meta.name} pipeline must be ${expectedPipeline}`);
  }
  const merged = normalizeSha(mergedSourceSha);
  const deployed = normalizeSha(deployedCommitSha);
  if (!merged) findings.push(`${boundaryName(boundary)} merged source SHA is missing or invalid`);
  if (!deployed) findings.push(`${boundaryName(boundary)} deployed commit SHA is missing or invalid`);
  if (merged && deployed && merged !== deployed) {
    findings.push(`${boundaryName(boundary)} deployed SHA does not match merged SHA`);
  }
  const type = artifactType || meta?.artifact_type || null;
  const artifactOk = type === "pages-artifact-hash" ? validArtifactHash(artifactValue) : validSha(artifactValue);
  if (!type || !artifactOk) {
    findings.push(`${boundaryName(boundary)} artifact identity is missing or invalid`);
  }
  if (type === "worker-commit" && deployed && artifactOk && normalizeSha(artifactValue) !== deployed) {
    findings.push("Cloudflare Worker artifact identity does not match the deployed commit");
  }
  const referenceId = typeof deploymentId === "string" && deploymentId.trim() ? deploymentId.trim() : null;
  const referenceUrl = typeof deploymentUrl === "string" && deploymentUrl.trim() ? deploymentUrl.trim() : null;
  if (!referenceId && !referenceUrl) {
    findings.push(`${boundaryName(boundary)} deployment reference is missing`);
  }
  const provider = normalizeStatus(providerStatus);
  if (!providerStatus) findings.push(`${boundaryName(boundary)} provider deployment status is missing`);
  else if (!provider) findings.push(`${boundaryName(boundary)} provider deployment status is unrecognized: ${providerStatus}`);
  else if (provider === "FAIL") findings.push(`${boundaryName(boundary)} provider deployment failed`);

  const guards = (Array.isArray(guardResults) ? guardResults : []).map((row) => buildGuardResult(
    row?.name || "unnamed-guard",
    row?.status,
    Array.isArray(row?.findings) ? row.findings : [],
  ));
  if (!guards.length) findings.push(`${boundaryName(boundary)} guard results are missing`);
  for (const guard of guards) {
    if (guard.status !== "PASS") {
      findings.push(`${boundaryName(boundary)} guard ${guard.name} is ${guard.status}`);
      findings.push(...guard.findings.map((finding) => `${guard.name}: ${finding}`));
    }
  }
  if (!validTimestamp(observedAt)) findings.push(`${boundaryName(boundary)} observation time is missing or invalid`);

  const uniqueFindings = unique(findings);
  const failed = provider === "FAIL" || uniqueFindings.some((finding) => /failed|does not match/i.test(finding));
  const status = statusFromFindings(uniqueFindings, failed);
  return {
    schema: DEPLOYMENT_HEALTH_RECEIPT_SCHEMA,
    kind: DEPLOYMENT_HEALTH_KIND,
    boundary: meta?.id || boundary || null,
    boundary_name: meta?.name || null,
    pipeline: resolvedPipeline,
    workflow: meta?.workflow || null,
    merged_source_sha: merged,
    deployed_commit_sha: deployed,
    artifact_identity: {
      type,
      value: artifactOk ? String(artifactValue).trim().toLowerCase() : (artifactValue || null),
    },
    deployment_reference: {
      id: referenceId,
      url: referenceUrl,
      provider: meta?.provider || null,
      workflow_run_url: workflowRunUrl || null,
    },
    guard_results: guards,
    provider_status: provider,
    observed_at: validTimestamp(observedAt) ? new Date(observedAt).toISOString() : observedAt || null,
    status,
    findings: uniqueFindings,
    reason: uniqueFindings[0] || (status === "PASS"
      ? `${meta?.name || "boundary"} deployment-health receipt is independently verifiable`
      : `${boundaryName(boundary)} deployment-health receipt is not independently verifiable`),
  };
}

export function evaluateDeploymentHealthReceipt(receipt, { expectedMergedSourceSha } = {}) {
  const classified = classifyEvidence(receipt);
  if (classified.kind === "missing") {
    return {
      status: "UNKNOWN",
      verifiable: false,
      findings: ["deployment-health receipt is missing"],
      receipt: null,
    };
  }
  if (classified.kind !== DEPLOYMENT_HEALTH_KIND) {
    const label = classified.kind === "runtime-watchdog"
      ? "runtime watchdog/digest/scheduler receipt"
      : classified.kind === RELEASE_SURFACE_KIND
        ? "aggregate release-surface receipt"
        : classified.kind === "generation"
          ? "generation output receipt"
          : "non-deployment receipt";
    return {
      status: "FAIL",
      verifiable: false,
      findings: [`${label} is not a deployment-health receipt`],
      receipt: null,
      evidence_kind: classified.kind,
      schema: classified.schema,
    };
  }
  const rebuilt = buildDeploymentHealthReceipt({
    boundary: receipt.boundary,
    pipeline: receipt.pipeline,
    mergedSourceSha: receipt.merged_source_sha,
    deployedCommitSha: receipt.deployed_commit_sha,
    artifactType: receipt.artifact_identity?.type,
    artifactValue: receipt.artifact_identity?.value,
    deploymentId: receipt.deployment_reference?.id,
    deploymentUrl: receipt.deployment_reference?.url,
    providerStatus: receipt.provider_status || receipt.status,
    guardResults: receipt.guard_results,
    observedAt: receipt.observed_at,
    workflowRunUrl: receipt.deployment_reference?.workflow_run_url,
  });
  const findings = [...rebuilt.findings];
  if (receipt.schema !== DEPLOYMENT_HEALTH_RECEIPT_SCHEMA) {
    findings.unshift("deployment-health receipt has an invalid schema");
  }
  if (receipt.kind !== DEPLOYMENT_HEALTH_KIND) {
    findings.push("deployment-health receipt kind must be deployment");
  }
  const expected = normalizeSha(expectedMergedSourceSha);
  if (expected) {
    if (rebuilt.merged_source_sha !== expected) {
      findings.push(`${rebuilt.boundary_name || boundaryName(rebuilt.boundary)} receipt merged SHA does not match the merged source SHA`);
    }
    if (rebuilt.deployed_commit_sha !== expected) {
      findings.push(`${rebuilt.boundary_name || boundaryName(rebuilt.boundary)} deployed SHA does not match merged SHA`);
    }
  }
  const uniqueFindings = unique(findings);
  const status = uniqueFindings.length
    ? (rebuilt.status === "FAIL" || uniqueFindings.some((finding) => /does not match|failed|invalid schema/i.test(finding)) ? "FAIL" : "UNKNOWN")
    : "PASS";
  return {
    status,
    verifiable: status === "PASS",
    findings: uniqueFindings,
    receipt: rebuilt,
    evidence_kind: DEPLOYMENT_HEALTH_KIND,
    schema: DEPLOYMENT_HEALTH_RECEIPT_SCHEMA,
  };
}

function emptyBoundaryState(id) {
  const meta = boundaryMeta(id);
  return {
    boundary: id,
    boundary_name: meta?.name || id,
    pipeline: meta?.pipeline || null,
    status: "UNKNOWN",
    verifiable: false,
    findings: [`${meta?.name || id} receipt is missing`],
    receipt: null,
  };
}

export function reconcileDeploymentHealth({
  mergedSourceSha,
  receipts = [],
  requiredBoundaries = REQUIRED_PRODUCTION_BOUNDARIES,
  observedAt = new Date().toISOString(),
} = {}) {
  if (JSON.stringify([...requiredBoundaries]) !== JSON.stringify([...REQUIRED_PRODUCTION_BOUNDARIES])) {
    throw new Error("required production boundaries must be exactly Cloudflare Pages and Cloudflare Worker");
  }
  const merged = normalizeSha(mergedSourceSha);
  const findings = [];
  if (!merged) findings.push("merged source SHA is missing or invalid");

  const ignored = [];
  const byBoundary = new Map();
  for (const value of receipts.filter((row) => row != null)) {
    const evaluated = evaluateDeploymentHealthReceipt(value, { expectedMergedSourceSha: merged });
    if (evaluated.evidence_kind !== DEPLOYMENT_HEALTH_KIND) {
      ignored.push({
        kind: evaluated.evidence_kind,
        schema: evaluated.schema,
        findings: evaluated.findings,
      });
      findings.push(...evaluated.findings);
      continue;
    }
    const id = evaluated.receipt?.boundary;
    if (!REQUIRED_PRODUCTION_BOUNDARIES.includes(id)) {
      findings.push(`unexpected production boundary: ${id || "missing"}`);
      continue;
    }
    if (byBoundary.has(id)) findings.push(`${boundaryName(id)} has duplicate deployment-health receipts`);
    byBoundary.set(id, evaluated);
  }

  const boundaries = {};
  const healthy = [];
  const affected = [];
  for (const id of REQUIRED_PRODUCTION_BOUNDARIES) {
    const evaluated = byBoundary.get(id) || {
      status: "UNKNOWN",
      verifiable: false,
      findings: [`${boundaryName(id)} receipt is missing`],
      receipt: null,
    };
    const row = {
      ...emptyBoundaryState(id),
      status: evaluated.status,
      verifiable: evaluated.verifiable === true,
      findings: unique(evaluated.findings),
      receipt: evaluated.receipt,
    };
    boundaries[id] = row;
    findings.push(...row.findings.map((finding) => finding.includes(row.boundary_name) ? finding : `${row.boundary_name}: ${finding}`));
    if (row.verifiable && row.status === "PASS" && row.receipt?.merged_source_sha === merged && row.receipt?.deployed_commit_sha === merged) {
      healthy.push(id);
    } else {
      affected.push(id);
    }
  }

  const uniqueFindings = unique(findings);
  const complete = Boolean(merged)
    && healthy.length === REQUIRED_PRODUCTION_BOUNDARIES.length
    && affected.length === 0
    && ignored.length === 0;
  return {
    schema: DEPLOYMENT_HEALTH_RECONCILIATION_SCHEMA,
    kind: "deployment-reconciliation",
    required_boundaries: [...REQUIRED_PRODUCTION_BOUNDARIES],
    required_boundary_names: REQUIRED_PRODUCTION_BOUNDARIES.map(boundaryName),
    merged_source_sha: merged,
    status: complete ? DEPLOYMENT_RECONCILIATION_COMPLETE : DEPLOYMENT_RECONCILIATION_INCOMPLETE,
    healthy_count: healthy.length,
    required_count: REQUIRED_PRODUCTION_BOUNDARIES.length,
    healthy_boundaries: healthy,
    affected_boundaries: affected,
    boundaries,
    ignored_evidence: ignored,
    findings: uniqueFindings,
    observed_at: observedAt,
    reason: complete
      ? "2/2 required production boundaries have independently verifiable deployment-health receipts matching the merged SHA"
      : (uniqueFindings[0] || "required production boundaries are not independently verified"),
  };
}

export function writeJson(path, value) {
  const resolved = resolve(path);
  mkdirSync(dirname(resolved), { recursive: true });
  writeFileSync(resolved, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  return resolved;
}

export function readJson(path) {
  return JSON.parse(readFileSync(resolve(path), "utf8"));
}

export function defaultNativeBuildsPath() {
  return resolve(fileURLToPath(new URL("..", import.meta.url)), "docs/release/cloudflare-native-builds.json");
}

export function assertWorkflowEmitsBoundary(workflowText, boundaryId) {
  const meta = boundaryMeta(boundaryId);
  const findings = [];
  if (!workflowText.includes("tools/check_deployment_health.mjs")) {
    findings.push(`${meta.name} workflow does not write a deployment-health receipt`);
  }
  if (!workflowText.includes(`--boundary ${boundaryId}`)) {
    findings.push(`${meta.name} workflow does not emit boundary ${boundaryId}`);
  }
  if (!workflowText.includes(".artifacts/deployment-health/")) {
    findings.push(`${meta.name} workflow does not retain the deployment-health receipt`);
  }
  return findings;
}
