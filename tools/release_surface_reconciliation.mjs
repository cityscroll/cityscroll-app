#!/usr/bin/env node

import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

export const RELEASE_SURFACE_RECEIPT_SCHEMA = "cityscroll.release-surface-receipt.v1";
export const RELEASE_SURFACE_STAGES = Object.freeze([
  "generation_output",
  "card_reconciliation",
  "generated_evidence_freshness",
  "served_artifact_freshness",
  "pages_deployment",
  "worker_release",
  "data_publication",
  "live_smoke",
  "watchdog",
]);
export const RELEASE_STATUS = Object.freeze(["PASS", "FAIL", "UNKNOWN"]);

function statusResult(status, findings = [], evidence = {}) {
  return { status, findings, evidence };
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

function rowsFrom(value, fields) {
  if (Array.isArray(value)) return value;
  if (!value || typeof value !== "object") return null;
  for (const field of fields) if (Array.isArray(value[field])) return value[field];
  return null;
}

function rowId(row) {
  return valueFrom(row, ["id", "card_id", "source_id", "key", "slug"]);
}

function sourceFingerprint(row) {
  return valueFrom(row, ["fingerprint", "content_hash", "sha256", "source_hash", "updated_at"]);
}

function projectionFingerprint(row) {
  return valueFrom(row, ["source_fingerprint", "source_hash", "fingerprint", "source_updated_at", "updated_at"]);
}

export function reconcileCardProjection({ sourceCards, generatedBoard } = {}) {
  const sourceRows = rowsFrom(sourceCards, ["cards", "entries", "items"]);
  const boardRows = rowsFrom(generatedBoard, ["cards", "entries", "items"]);
  if (!sourceRows) return statusResult("UNKNOWN", ["source card inventory is missing"]);
  if (!boardRows) return statusResult("UNKNOWN", ["generated board inventory is missing"]);

  const findings = [];
  const sourceById = new Map();
  const boardById = new Map();
  for (const row of sourceRows) {
    const id = rowId(row);
    if (!id) findings.push("source card is missing an id");
    else if (sourceById.has(id)) findings.push(`duplicate source card: ${id}`);
    else sourceById.set(id, row);
  }
  for (const row of boardRows) {
    const id = rowId(row);
    if (!id) findings.push("generated board entry is missing an id");
    else if (boardById.has(id)) findings.push(`duplicate generated board entry: ${id}`);
    else boardById.set(id, row);
  }

  for (const [id, source] of sourceById) {
    const projection = boardById.get(id);
    if (!projection) {
      findings.push(`source card ${id} is missing from generated board`);
      continue;
    }
    const expected = sourceFingerprint(source);
    const actual = projectionFingerprint(projection);
    if (expected && actual && expected !== actual) {
      findings.push(`generated board projection for card ${id} is stale`);
    } else if (expected && !actual) {
      findings.push(`generated board projection for card ${id} has no source receipt`);
    }
  }
  for (const id of boardById.keys()) {
    if (!sourceById.has(id)) findings.push(`generated board has no source card: ${id}`);
  }

  return statusResult(findings.length ? "FAIL" : "PASS", findings, {
    source_card_count: sourceRows.length,
    generated_board_count: boardRows.length,
  });
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

export function evaluateServedArtifactFreshness({ liveManifest, expectedManifest, freshnessFindings } = {}) {
  if (!liveManifest) return statusResult("UNKNOWN", ["served artifact manifest was not observed"]);
  const findings = typeof freshnessFindings === "function"
    ? freshnessFindings(liveManifest, expectedManifest)
    : [];
  return statusResult(findings.length ? "FAIL" : "PASS", findings, {
    live_artifact_hash: liveManifest.artifact_hash || null,
    live_source_commit_sha: liveManifest.source_commit_sha || null,
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
  const required = new Set(requiredStages);
  const requiredRows = RELEASE_SURFACE_STAGES
    .filter((stage) => required.has(stage))
    .map((stage) => normalizedStages[stage]);
  const status = requiredRows.some((row) => row.status === "FAIL")
    ? "FAIL"
    : requiredRows.some((row) => row.status === "UNKNOWN")
      ? "UNKNOWN"
      : "PASS";
  const findings = requiredRows.flatMap((row) => row.findings || []);
  return {
    schema: RELEASE_SURFACE_RECEIPT_SCHEMA,
    version: 1,
    source_commit_sha: sourceCommitSha || null,
    status,
    required_stages: [...required],
    generated_at: generatedAt,
    stages: normalizedStages,
    findings,
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
