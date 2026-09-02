#!/usr/bin/env node

import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import { evaluateCardReconciliation } from "./card_reconciliation_guard.mjs";

export const RELEASE_SURFACE_RECEIPT_SCHEMA = "cityscroll.release-surface-receipt.v1";
export const RELEASE_SURFACE_STAGES = Object.freeze([
  "generation_output",
  "card_reconciliation",
  "generated_evidence_freshness",
  "served_artifact_freshness",
  "pages_deployment",
  "worker_trigger_coverage",
  "worker_startup",
  "worker_release",
  "data_publication",
  "live_smoke",
  "watchdog",
  "scheduler",
  "alert_delivery",
]);
export const RELEASE_STATUS = Object.freeze(["PASS", "FAIL", "UNKNOWN"]);

function statusResult(status, findings = [], evidence = {}) {
  const uniqueFindings = [...new Set(findings.filter(Boolean))];
  return {
    status,
    reason: uniqueFindings[0] || (status === "PASS" ? "all required evidence matched" : "required evidence was not reconciled"),
    findings: uniqueFindings,
    evidence,
  };
}

function validTimestamp(value) {
  const parsed = Date.parse(value || "");
  return Number.isFinite(parsed) ? parsed : null;
}

function valueFrom(row, fields) {
  for (const field of fields) {
    if (row && typeof row[field] === "string" && row[field].trim()) return row[field].trim();
  }
  return null;
}

function scalarFrom(row, fields) {
  const text = valueFrom(row, fields);
  if (text !== null) return text;
  for (const field of fields) {
    if (row && typeof row[field] === "number" && Number.isFinite(row[field])) return row[field];
  }
  return null;
}

function explicitStatus(row, fields = ["status", "outcome", "provider_status"]) {
  if (typeof row === "string") return row.trim().toLowerCase() || null;
  return valueFrom(row, fields)?.toLowerCase() || null;
}

function isPositiveStatus(status) {
  return ["pass", "passed", "success", "succeeded", "ok", "ready", "healthy", "deployed", "delivered", "sent", "accepted", "terminal"].includes(status);
}

function isNegativeStatus(status) {
  return ["fail", "failed", "failure", "error", "degraded", "unhealthy", "expired", "missing", "partial", "blocked"].includes(status);
}

function validSha(value) {
  return typeof value === "string" && /^[a-f0-9]{40,64}$/i.test(value.trim());
}

function validArtifactHash(value) {
  return typeof value === "string" && /^[a-f0-9]{64}$/i.test(value.trim());
}

function validVersion(value) {
  return (typeof value === "string" && value.trim().length > 0)
    || (typeof value === "number" && Number.isFinite(value));
}

function rowsFrom(value, fields) {
  if (Array.isArray(value)) return value;
  if (!value || typeof value !== "object") return null;
  for (const field of fields) if (Array.isArray(value[field])) return value[field];
  return null;
}

export function reconcileCardProjection({
  sourceCards,
  generatedBoard,
  projections,
  projectionPath,
} = {}) {
  const supplied = [sourceCards, generatedBoard, projections].some((value) => value !== undefined && value !== null);
  if (!supplied) {
    return statusResult("UNKNOWN", ["source card inventory is missing"]);
  }
  const result = evaluateCardReconciliation({
    sourceCards,
    generatedBoard,
    projections,
    projectionPath,
  });
  return statusResult(result.status, result.findings, result.evidence);
}

export function evaluateGenerationReceipt(receipt, { sourceCommitSha, expectedManifest } = {}) {
  if (!receipt || typeof receipt !== "object") {
    return statusResult("FAIL", ["generation output receipt is missing"]);
  }
  const findings = [];
  if (receipt.schema !== "cityscroll.generation-output-receipt.v1") {
    findings.push("generation output receipt has an invalid schema");
  }
  if (receipt.status !== "passed") findings.push(`generation output status is ${receipt.status || "missing"}`);
  if (!Array.isArray(receipt.expected_artifacts) || receipt.expected_artifacts.length === 0) {
    findings.push("generation output receipt has no expected artifacts");
  }
  if (Array.isArray(receipt.findings) && receipt.findings.length) {
    findings.push(...receipt.findings.map((finding) => `generation: ${finding}`));
  }
  if (sourceCommitSha && receipt.source_commit_sha !== sourceCommitSha) {
    findings.push("generation output receipt source commit mismatch");
  }
  if (expectedManifest !== undefined) {
    if (!expectedManifest || typeof expectedManifest !== "object") {
      findings.push("served artifact manifest is missing");
    } else {
      if (expectedManifest.schema !== "cityscroll.served-artifact-manifest.v1") {
        findings.push("served artifact manifest has an invalid schema");
      }
      if (sourceCommitSha && expectedManifest.source_commit_sha !== sourceCommitSha) {
        findings.push("served artifact manifest source commit mismatch");
      }
      if (!/^[a-f0-9]{64}$/.test(String(expectedManifest.artifact_hash || ""))) {
        findings.push("served artifact manifest artifact hash is missing or invalid");
      }
    }
  }
  if (!validTimestamp(receipt.generated_at)) findings.push("generation output receipt timestamp is missing or invalid");
  return statusResult(findings.length ? "FAIL" : "PASS", findings, {
    boundary: receipt.boundary || null,
    expected_artifacts: receipt.expected_artifacts || [],
    source_commit_sha: receipt.source_commit_sha || null,
    artifact_hash: expectedManifest?.artifact_hash || null,
  });
}

export function evaluatePagesDeployment({
  status,
  providerStatus,
  provider_status,
  deploymentId,
  deployment_id,
  deploymentUrl,
  deployment_url,
  sourceCommitSha,
  source_commit_sha,
  expectedSourceCommitSha,
  expected_source_commit_sha,
  artifactHash,
  artifact_hash,
  expectedArtifactHash,
  expected_artifact_hash,
} = {}) {
  const findings = [];
  const provider = String(providerStatus ?? provider_status ?? status ?? "").trim().toLowerCase();
  const deployment = deploymentId ?? deployment_id;
  const url = deploymentUrl ?? deployment_url;
  const source = sourceCommitSha ?? source_commit_sha;
  const expectedSource = expectedSourceCommitSha ?? expected_source_commit_sha;
  const artifact = artifactHash ?? artifact_hash;
  const expectedArtifact = expectedArtifactHash ?? expected_artifact_hash;
  if (!provider) findings.push("Pages provider deployment status is missing");
  else if (isNegativeStatus(provider)) findings.push(`Pages provider deployment status is ${provider}`);
  else if (!isPositiveStatus(provider)) findings.push(`Pages provider deployment status is unrecognized: ${provider}`);
  if (!scalarFrom({ deploymentId: deployment, deploymentUrl: url }, ["deploymentId", "deploymentUrl"])) {
    findings.push("Pages deployment identity is missing");
  }
  if (!source || !validSha(source)) findings.push("Pages source commit SHA is missing or invalid");
  if (expectedSource && source !== expectedSource) findings.push("Pages source commit SHA mismatch");
  if (!artifact || !validArtifactHash(artifact)) findings.push("Pages artifact hash is missing or invalid");
  if (expectedArtifact && artifact !== expectedArtifact) findings.push("Pages artifact hash mismatch");
  const statusResultValue = findings.length
    ? (provider && isNegativeStatus(provider) ? "FAIL" : "UNKNOWN")
    : "PASS";
  return statusResult(statusResultValue, findings, {
    provider: "cloudflare-pages",
    provider_status: provider || null,
    deployment_id: deployment || null,
    deployment_url: url || null,
    source_commit_sha: source || null,
    artifact_hash: artifact || null,
  });
}

export function evaluateWorkerTriggerCoverage(coverage = {}) {
  if (!coverage || typeof coverage !== "object") return statusResult("UNKNOWN", ["Worker trigger coverage evidence is missing"]);
  const status = explicitStatus(coverage);
  const missing = [...new Set([
    ...(Array.isArray(coverage.missing_paths) ? coverage.missing_paths : []),
    ...(Array.isArray(coverage.uncovered_paths) ? coverage.uncovered_paths : []),
    ...(Array.isArray(coverage.workflow_missing_paths) ? coverage.workflow_missing_paths : []),
    ...(Array.isArray(coverage.native_missing_paths) ? coverage.native_missing_paths : []),
  ].filter(Boolean))];
  const findings = [];
  if (!status) findings.push("Worker trigger coverage status is missing");
  else if (isNegativeStatus(status)) findings.push(`Worker trigger coverage status is ${status}`);
  else if (!isPositiveStatus(status)) findings.push(`Worker trigger coverage status is unrecognized: ${status}`);
  if (missing.length) findings.push(`Worker trigger coverage misses ${missing.join(", ")}`);
  if (!Array.isArray(coverage.dependency_paths) || coverage.dependency_paths.length === 0) {
    findings.push("Worker dependency surface is missing");
  }
  const resultStatus = findings.length ? (isNegativeStatus(status) ? "FAIL" : "UNKNOWN") : "PASS";
  return statusResult(resultStatus, findings, {
    dependency_paths: coverage.dependency_paths || [],
    configured_patterns: coverage.configured_patterns || [],
    missing_paths: missing,
  });
}

export function evaluateWorkerStartup({
  startupMs,
  startup_ms,
  startupReport,
  startup_report,
  status,
  limitMs = 1000,
} = {}) {
  const findings = [];
  const explicitStartup = startupMs ?? startup_ms;
  const report = String(startupReport ?? startup_report ?? "");
  const parsed = explicitStartup !== undefined && explicitStartup !== null && String(explicitStartup).trim() !== ""
    ? Number(explicitStartup)
    : (() => {
      const match = report.match(/startup(?:\s+time)?[^\d]*(\d+(?:\.\d+)?)\s*(ms|s)\b/i);
      return match ? Number(match[1]) * (match[2].toLowerCase() === "s" ? 1000 : 1) : null;
    })();
  if (!Number.isFinite(parsed)) findings.push("Worker startup measurement is missing or nonnumeric");
  else if (parsed > limitMs) findings.push(`Worker startup ${parsed}ms exceeds ${limitMs}ms budget`);
  if (status !== undefined && status !== null && !isPositiveStatus(String(status).toLowerCase())) {
    findings.push(`Worker startup provider status is ${status}`);
  }
  return statusResult(findings.length ? (Number.isFinite(parsed) && parsed > limitMs ? "FAIL" : "UNKNOWN") : "PASS", findings, {
    startup_ms: Number.isFinite(parsed) ? parsed : null,
    startup_budget_ms: limitMs,
  });
}

export function evaluateWorkerRelease({
  status,
  providerStatus,
  provider_status,
  provider = "cloudflare-workers-builds",
  buildId,
  build_id,
  deploymentId,
  deployment_id,
  sourceCommitSha,
  source_commit_sha,
  expectedSourceCommitSha,
  expected_source_commit_sha,
  triggerCoverage,
  trigger_coverage,
  startupMs,
  startup_ms,
  startupReport,
  startup_report,
} = {}) {
  const findings = [];
  const providerState = String(providerStatus ?? provider_status ?? status ?? "").trim().toLowerCase();
  const build = buildId ?? build_id;
  const deployment = deploymentId ?? deployment_id;
  const source = sourceCommitSha ?? source_commit_sha;
  const expectedSource = expectedSourceCommitSha ?? expected_source_commit_sha;
  const coverage = triggerCoverage ?? trigger_coverage;
  const startup = startupMs ?? startup_ms;
  const report = startupReport ?? startup_report;
  if (!providerState) findings.push("Worker provider/build status is missing");
  else if (isNegativeStatus(providerState)) findings.push(`Worker provider/build status is ${providerState}`);
  else if (!isPositiveStatus(providerState)) findings.push(`Worker provider/build status is unrecognized: ${providerState}`);
  if (!build && !deployment) findings.push("Worker provider/build identity is missing");
  if (!source || !validSha(source)) findings.push("Worker source commit SHA is missing or invalid");
  if (expectedSource && source !== expectedSource) findings.push("Worker source commit SHA mismatch");
  const coverageResult = evaluateWorkerTriggerCoverage(coverage);
  const startupResult = evaluateWorkerStartup({ startupMs: startup, startupReport: report });
  findings.push(...coverageResult.findings, ...startupResult.findings);
  const resultStatus = findings.length
    ? (isNegativeStatus(providerState) || startupResult.status === "FAIL" || coverageResult.status === "FAIL" ? "FAIL" : "UNKNOWN")
    : "PASS";
  return statusResult(resultStatus, findings, {
    provider,
    provider_status: providerState || null,
    build_id: build || null,
    deployment_id: deployment || null,
    source_commit_sha: source || null,
    trigger_coverage: coverageResult.evidence,
    startup: startupResult.evidence,
  });
}

export function evaluateDataPublication({
  status,
  complete,
  publications,
  requiredPublications = ["d1_migrations", "d1_read_models", "kv_route_slices", "kv_manifests"],
} = {}) {
  const entries = Array.isArray(publications)
    ? publications.map((row) => [String(row?.name || row?.kind || row?.id || ""), row])
    : publications && typeof publications === "object" ? Object.entries(publications) : [];
  const byName = new Map(entries.filter(([name]) => name));
  const findings = [];
  const overall = explicitStatus({ status });
  if (overall && isNegativeStatus(overall)) findings.push(`data publication status is ${overall}`);
  if (complete === false) findings.push("data publication is partial");
  for (const name of requiredPublications) {
    const row = byName.get(name);
    if (!row) {
      findings.push(`data publication ${name} is missing`);
      continue;
    }
    const rowStatus = explicitStatus(row);
    if (!rowStatus) findings.push(`data publication ${name} status is missing`);
    else if (!isPositiveStatus(rowStatus)) findings.push(`data publication ${name} status is ${rowStatus}`);
    if (!validVersion(scalarFrom(row, ["version", "publication_version", "manifest_version"]))) {
      findings.push(`data publication ${name} version is missing`);
    }
  }
  const hasAny = byName.size > 0;
  const resultStatus = findings.length
    ? (overall && isNegativeStatus(overall) || complete === false || [...byName.values()].some((row) => isNegativeStatus(explicitStatus(row))) ? "FAIL" : "UNKNOWN")
    : (hasAny ? "PASS" : "UNKNOWN");
  return statusResult(resultStatus, findings, {
    complete: complete === true,
    required_publications: requiredPublications,
    publications: Object.fromEntries(entries),
  });
}

export function evaluateMonitorState({
  status,
  watchdog,
  scheduler,
  freshness,
  now = new Date(),
  maxAgeMs = 26 * 60 * 60 * 1000,
} = {}) {
  const findings = [];
  const states = { watchdog, scheduler, freshness };
  const observed = {};
  for (const [name, state] of Object.entries(states)) {
    if (state === undefined) continue;
    const stateStatus = explicitStatus(state);
    const at = scalarFrom(state, ["observed_at", "last_run_at", "checked_at", "generated_at"]);
    const timestamp = validTimestamp(at);
    observed[name] = { status: stateStatus || null, observed_at: at || null };
    if (!stateStatus) findings.push(`${name} monitor status is missing`);
    else if (!isPositiveStatus(stateStatus)) findings.push(`${name} monitor status is ${stateStatus}`);
    if (timestamp === null) findings.push(`${name} monitor run timestamp is missing or invalid`);
    else if (timestamp > now.getTime()) findings.push(`${name} monitor run timestamp is in the future`);
    else if (now.getTime() - timestamp > maxAgeMs) findings.push(`${name} monitor run is older than its freshness window`);
  }
  if (!Object.keys(observed).length) findings.push("watchdog/scheduler monitor evidence is missing");
  if (status !== undefined && status !== null && !isPositiveStatus(String(status).toLowerCase())) findings.push(`monitor aggregate status is ${status}`);
  const resultStatus = findings.length
    ? (Object.values(states).some((state) => isNegativeStatus(explicitStatus(state))) ? "FAIL" : "UNKNOWN")
    : "PASS";
  return statusResult(resultStatus, findings, { monitors: observed, max_age_ms: maxAgeMs });
}

export function evaluateLiveProbe({
  status,
  probeStatus,
  probe_status,
  httpStatus,
  http_status,
  sourceCommitSha,
  source_commit_sha,
  expectedSourceCommitSha,
  expected_source_commit_sha,
  servedArtifactHash,
  served_artifact_hash,
  expectedArtifactHash,
  expected_artifact_hash,
} = {}) {
  const findings = [];
  const state = String(probeStatus ?? probe_status ?? status ?? "").trim().toLowerCase();
  const http = httpStatus ?? http_status;
  const source = sourceCommitSha ?? source_commit_sha;
  const expectedSource = expectedSourceCommitSha ?? expected_source_commit_sha;
  const servedHash = servedArtifactHash ?? served_artifact_hash;
  const expectedHash = expectedArtifactHash ?? expected_artifact_hash;
  if (!state) findings.push("live probe result is missing");
  if (http !== undefined && http !== null && (!Number.isFinite(Number(http)) || Number(http) < 200 || Number(http) >= 400)) {
    findings.push("live probe HTTP status is invalid or unsuccessful: " + http);
  }
  if (state && !isPositiveStatus(state)) findings.push("live probe result is " + state);
  if (httpStatus !== undefined && httpStatus !== null && (Number(httpStatus) < 200 || Number(httpStatus) >= 400)) {
    findings.push(`live probe HTTP status is ${httpStatus}`);
  }
  if (!servedHash || !validArtifactHash(servedHash)) findings.push("served artifact hash is missing or invalid");
  if (expectedHash && servedHash !== expectedHash) findings.push("served artifact hash mismatch");
  if (expectedSource && source !== expectedSource) findings.push("served source commit SHA mismatch");
  if (expectedSource && (!source || !validSha(source))) findings.push("served source commit SHA is missing or invalid");
  const resultStatus = findings.length
    ? (state && !isPositiveStatus(state) || (http !== undefined && Number.isFinite(Number(http)) && Number(http) >= 400) || findings.some((finding) => finding.includes("mismatch") || finding.includes("unsuccessful") || finding.includes("invalid")) ? "FAIL" : "UNKNOWN")
    : "PASS";
  return statusResult(resultStatus, findings, {
    probe_status: state || null,
    http_status: http ?? null,
    source_commit_sha: source || null,
    served_artifact_hash: servedHash || null,
  });
}

export function evaluateAlertDelivery({
  status,
  outcome,
  delivery_outcome,
  provider,
  messageId,
  message_id,
  recipient,
} = {}) {
  const state = String(outcome ?? delivery_outcome ?? status ?? "").trim().toLowerCase();
  const id = messageId ?? message_id;
  const findings = [];
  if (!state) findings.push("alert-delivery outcome is missing");
  else if (!isPositiveStatus(state)) findings.push(`alert-delivery outcome is ${state}`);
  const resultStatus = findings.length ? (state && isNegativeStatus(state) ? "FAIL" : "UNKNOWN") : "PASS";
  return statusResult(resultStatus, findings, {
    outcome: state || null,
    provider: provider || null,
    message_id: id || null,
    recipient: recipient || null,
  });
}

export function evaluateGeneratedEvidenceFreshness({
  sourceReceipt,
  sourceContract,
  expectedSourceHash,
  expectedReceiptHash,
  now = new Date(),
} = {}) {
  if (!sourceReceipt || typeof sourceReceipt !== "object") {
    return statusResult("FAIL", ["generated evidence source receipt is missing"]);
  }
  const findings = [];
  const sourceId = valueFrom(sourceReceipt, ["source_contract_id", "source_id"]);
  if (!sourceId) findings.push("generated evidence source receipt has no source id");
  if (sourceContract?.id && sourceId && sourceContract.id !== sourceId) {
    findings.push(`generated evidence source receipt belongs to ${sourceId}, expected ${sourceContract.id}`);
  }
  const receiptStatus = String(sourceReceipt.status || "").toLowerCase();
  if (!["succeeded", "success", "ok", "current"].includes(receiptStatus)) {
    findings.push(`generated evidence source receipt status is ${sourceReceipt.status || "missing"}`);
  }
  const observedAt = valueFrom(sourceReceipt, ["observed_at", "observed_on", "generated_at", "materialized_at"]);
  const observedMs = validTimestamp(observedAt);
  if (observedMs === null) findings.push("generated evidence source receipt timestamp is missing or invalid");
  const receiptHash = valueFrom(sourceReceipt, ["source_hash", "content_hash", "sha256", "contract_fingerprint"]);
  if (!receiptHash) findings.push("generated evidence source receipt source hash is missing");
  if (expectedSourceHash && receiptHash && receiptHash !== expectedSourceHash) {
    findings.push("generated evidence source receipt source hash mismatch");
  }
  if (expectedReceiptHash && receiptHash && receiptHash !== expectedReceiptHash) {
    findings.push("generated evidence source receipt does not match the served manifest");
  }

  const maxAgeDays = Number(
    sourceContract?.freshness_contract?.max_stale_days
      ?? sourceContract?.freshness_contract?.serving_max_age_days,
  );
  if (observedMs !== null && observedMs > now.getTime()) findings.push("generated evidence source receipt is in the future");
  if (observedMs !== null && Number.isFinite(maxAgeDays) && maxAgeDays > 0
    && now.getTime() - observedMs > maxAgeDays * 24 * 60 * 60 * 1000) {
    findings.push(`generated evidence source receipt is older than its ${maxAgeDays}-day freshness limit`);
  }

  return statusResult(findings.length ? "FAIL" : "PASS", findings, {
    source_id: sourceId,
    observed_at: observedAt || null,
    source_hash: receiptHash || null,
    max_age_days: Number.isFinite(maxAgeDays) && maxAgeDays > 0 ? maxAgeDays : null,
  });
}

/**
 * The served artifact is compared against the manifest a deploy actually
 * published, not against a fresh local rebuild. The production build refreshes
 * decision outcomes from live sources, so rebuilding the same revision does not
 * reproduce the deployed bytes and a hash comparison against it can never pass.
 *
 * Deploy lag is a separate finding from a byte mismatch: an artifact that is
 * exactly some earlier deploy is a different failure from one that matches no
 * deploy at all, and neither is allowed to pass.
 */
export function evaluateServedArtifactFreshness({
  liveManifest,
  expectedManifest,
  freshnessFindings,
  mainRevision = null,
} = {}) {
  if (!liveManifest) return statusResult("UNKNOWN", ["served artifact manifest was not observed"]);
  if (!expectedManifest) return statusResult("UNKNOWN", ["expected artifact manifest was not supplied"]);
  const findings = typeof freshnessFindings === "function"
    ? freshnessFindings(liveManifest, expectedManifest)
    : [
      liveManifest.schema !== expectedManifest.schema ? "served artifact manifest schema mismatch" : null,
      liveManifest.artifact_hash !== expectedManifest.artifact_hash ? "artifact hash mismatch" : null,
      liveManifest.source_commit_sha !== expectedManifest.source_commit_sha ? "source commit mismatch" : null,
    ].filter(Boolean);
  if (mainRevision && expectedManifest.source_commit_sha
    && String(expectedManifest.source_commit_sha) !== String(mainRevision)) {
    findings.push(`deployed revision ${expectedManifest.source_commit_sha} is behind main revision ${mainRevision}`);
  }
  return statusResult(findings.length ? "FAIL" : "PASS", findings, {
    live_artifact_hash: liveManifest.artifact_hash || null,
    live_source_commit_sha: liveManifest.source_commit_sha || null,
    deployed_artifact_hash: expectedManifest.artifact_hash || null,
    deployed_source_commit_sha: expectedManifest.source_commit_sha || null,
    main_source_commit_sha: mainRevision || null,
  });
}

export function buildReleaseSurfaceReceipt({
  sourceCommitSha = null,
  stages = {},
  requiredStages = RELEASE_SURFACE_STAGES,
  generatedAt = new Date().toISOString(),
} = {}) {
  const invalidRequiredStages = requiredStages.filter((stage) => !RELEASE_SURFACE_STAGES.includes(stage));
  if (invalidRequiredStages.length) throw new Error(`unknown release-surface stage(s): ${invalidRequiredStages.join(", ")}`);
  const normalizedStages = Object.fromEntries(RELEASE_SURFACE_STAGES.map((stage) => [
    stage,
    !stages[stage]
      ? statusResult("UNKNOWN", [`${stage} evidence was not supplied`])
      : RELEASE_STATUS.includes(stages[stage].status)
        ? stages[stage]
        : statusResult("UNKNOWN", [`${stage} evidence has an invalid status`]),
  ]));
  for (const stage of RELEASE_SURFACE_STAGES) {
    const row = normalizedStages[stage];
    if (!row || !RELEASE_STATUS.includes(row.status)) continue;
    normalizedStages[stage] = {
      ...row,
      findings: Array.isArray(row.findings) ? row.findings : [],
      reason: row.reason || row.findings?.[0] || (row.status === "PASS" ? "evidence reconciled" : "required evidence was not reconciled"),
      evidence: row.evidence || {},
    };
  }
  const required = new Set(requiredStages);
  const requiredRows = RELEASE_SURFACE_STAGES
    .filter((stage) => required.has(stage))
    .map((stage) => normalizedStages[stage]);
  const findings = requiredRows.flatMap((row) => row.findings || []);
  if (!sourceCommitSha || !validSha(sourceCommitSha)) findings.unshift("source commit SHA is missing or invalid");
  const status = requiredRows.some((row) => row.status === "FAIL")
    ? "FAIL"
    : !sourceCommitSha || !validSha(sourceCommitSha) || requiredRows.some((row) => row.status === "UNKNOWN")
      ? "UNKNOWN"
      : "PASS";
  return {
    schema: RELEASE_SURFACE_RECEIPT_SCHEMA,
    kind: "release-surface",
    version: 1,
    source_commit_sha: sourceCommitSha || null,
    status,
    required_stages: [...required],
    generated_at: generatedAt,
    artifact_hash: normalizedStages.served_artifact_freshness.evidence?.live_artifact_hash
      || normalizedStages.pages_deployment.evidence?.artifact_hash
      || normalizedStages.generation_output.evidence?.artifact_hash
      || null,
    stages: normalizedStages,
    findings,
    reason: findings[0] || (status === "PASS" ? "all required release-surface evidence matched" : "required release-surface evidence was not reconciled"),
  };
}

export function writeReleaseSurfaceReceipt(receipt, receiptPath) {
  const path = resolve(receiptPath);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(receipt, null, 2)}\n`, "utf8");
  return receipt;
}

export function sha256Text(value) {
  return createHash("sha256").update(String(value), "utf8").digest("hex");
}
