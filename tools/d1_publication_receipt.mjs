#!/usr/bin/env node

/**
 * One durable, append-only receipt per D1 publication decision and generation
 * (release-control card d1-07).
 *
 * Cloudflare's bill is an aggregate. Nothing today explains, per deploy, how
 * much D1 write work a release attempted, or distinguishes a deliberately
 * skipped publication from a failed one. This module is the single place that
 * composes a closed-shape "publication receipt" from the artifacts the
 * existing D1 release-control tools already produce — the deploy fingerprint
 * decision (tools/d1_deploy_fingerprint.mjs), the partition snapshot and delta
 * plan (tools/d1_delta_plan.mjs), the generation fence
 * (tools/d1_generation_fence.mjs), and the bounded publisher's batch plan,
 * dry-run report, and checkpoint receipt (tools/d1_bounded_publisher.mjs) —
 * and records it both locally (an append-only JSONL under .artifacts/) and to
 * the same KV binding the fence uses, under a receipt key prefix.
 *
 * A receipt never carries a secret or a source row: every field is either a
 * closed enum, a bounded count, or a bounded, pattern-restricted identifier.
 * validatePublicationReceipt() enforces that shape and refuses an unknown
 * field, an oversize string, or a token-shaped value before anything is
 * written.
 *
 * Every run (one workflow, run id, and attempt) gets exactly one terminal
 * receipt. A rollback is never a rewrite of a prior receipt: it is a new
 * run's own receipt, with outcome "rolled_back" and a rollback pointer naming
 * the receipt it compensates plus the explicit rebuild command used.
 *
 * Usage:
 *   node tools/d1_publication_receipt.mjs build --workflow <w> --run-id <id> --attempt <n>
 *                                                --deploy-fingerprint <sha256> --outcome <o> --reason "<text>"
 *                                                [--generation <n>] [--previous-fingerprint <sha256>]
 *                                                [--snapshot <path>] [--batch-plan <path>] [--dry-run <path>]
 *                                                [--publish-receipt <path>] [--duration-ms <n>]
 *                                                [--verification-status <s>] [--verification-detail "<text>"]
 *                                                [--rollback-compensates <id>] [--rollback-command "<text>"] [--rollback-reason "<text>"]
 *                                                [--canary-evidence <path>] [--reconcile-report <path>]
 *                                                [--out <path>]
 *   node tools/d1_publication_receipt.mjs record  (same flags as build, plus)
 *                                                --local <path> [--state-file <path> | --binding <b> --config <path> --remote]
 *   node tools/d1_publication_receipt.mjs summarize --receipts <jsonl>
 *   node tools/d1_publication_receipt.mjs compare --receipts <jsonl> --from <iso> --to <iso>
 */

import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import { SNAPSHOT_SCHEMA } from "./d1_delta_plan.mjs";
import {
  D1_BOUNDED_PUBLISH_DRYRUN_SCHEMA,
  D1_BOUNDED_PUBLISH_PLAN_SCHEMA,
  D1_BOUNDED_PUBLISH_RECEIPT_SCHEMA,
} from "./d1_bounded_publisher.mjs";
import { D1_CANARY_EVIDENCE_SCHEMA, FINDING_CLASSIFICATIONS } from "./d1_canary.mjs";
import { D1_RECONCILE_REPORT_SCHEMA } from "./d1_reconcile.mjs";

const execFileAsync = promisify(execFile);
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export const D1_PUBLICATION_RECEIPT_SCHEMA = "cityscroll.d1-publication-receipt.v2";
export const RECEIPT_KEY_PREFIX = "d1-publication:receipt:v1:";
export const DEFAULT_LOCAL_RECEIPT_PATH = resolve(ROOT, ".artifacts/d1-publication-receipts.jsonl");

/** Every exit path a D1 publication run can terminate in. Closed: nothing else is valid. */
export const OUTCOMES = Object.freeze([
  "skipped_fingerprint_unchanged",
  "skipped_fence_busy",
  "published",
  "failed_transient_exhausted",
  "failed_permanent",
  "abandoned",
  "rolled_back",
]);

const VERIFICATION_STATUSES = Object.freeze(["not_run", "passed", "failed"]);

const MAX_IDENTIFIER_LENGTH = 200;
const MAX_TEXT_LENGTH = 500;
const MAX_MODELS = 50;

const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const PRINTABLE_TEXT_PATTERN = /^[\x09\x0a\x20-\x7e]*$/;

// A conservative, defense-in-depth heuristic for a secret accidentally routed
// into an identifier or free-text field: a dense, delimiter-free run of mixed
// upper/lower/digit characters, the general shape shared by API keys, session
// tokens, and JWT segments. Our own identifiers are lowercase/delimited
// (snake_case model ids, "workflow:run_id:attempt" holders) and our sha256
// fingerprints are pure lowercase hex, so neither trips this check. This is a
// shape check, not a denylist of specific providers' token formats.
const DENSE_OPAQUE_RUN_PATTERN = /^[A-Za-z0-9+/_=.-]{20,}$/;

export class PublicationReceiptError extends Error {
  constructor(field, detail) {
    super(`d1 publication receipt: ${field} ${detail}`);
    this.name = "PublicationReceiptError";
    this.field = field;
  }
}

function fail(field, detail) {
  throw new PublicationReceiptError(field, detail);
}

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function isSecretShaped(value) {
  if (!DENSE_OPAQUE_RUN_PATTERN.test(value)) return false;
  return /[a-z]/.test(value) && /[A-Z]/.test(value) && /[0-9]/.test(value);
}

function requirePlainObject(value, field) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(field, "must be an object");
  return value;
}

function requireKnownKeys(value, allowed, field) {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) fail(`${field}.${key}`, "is not a known field");
  }
  return value;
}

/** A bounded, delimiter-restricted identifier: no secret shape, no free text, no row payload. */
function assertIdentifier(value, field, { maxLength = MAX_IDENTIFIER_LENGTH } = {}) {
  if (typeof value !== "string" || value === "") fail(field, "must be a non-empty string");
  if (value.length > maxLength) fail(field, `must be at most ${maxLength} characters`);
  if (!IDENTIFIER_PATTERN.test(value)) fail(field, "must be a bounded identifier (letters, digits, . _ : / -)");
  if (isSecretShaped(value)) fail(field, "looks like a secret or access token, not an identifier");
  return value;
}

/** Bounded free text: printable, length-capped, still refused if it smuggles a secret shape. */
function assertText(value, field, { maxLength = MAX_TEXT_LENGTH, allowEmpty = false } = {}) {
  if (typeof value !== "string" || (!allowEmpty && value.trim() === "")) fail(field, "must be a non-empty string");
  if (value.length > maxLength) fail(field, `must be at most ${maxLength} characters`);
  if (!PRINTABLE_TEXT_PATTERN.test(value)) fail(field, "must be printable text");
  if (isSecretShaped(value.trim())) fail(field, "looks like a secret or access token, not a description");
  return value;
}

function assertNullableText(value, field, opts) {
  if (value === null) return null;
  return assertText(value, field, opts);
}

function assertSha256(value, field) {
  if (typeof value !== "string" || !SHA256_PATTERN.test(value)) fail(field, "must be a sha256 hex digest");
  return value;
}

function assertNullableSha256(value, field) {
  if (value === null) return null;
  return assertSha256(value, field);
}

function requirePositiveInteger(value, field) {
  if (!Number.isInteger(value) || value < 1) fail(field, "must be a positive integer");
  return value;
}

function requireNonNegativeInteger(value, field) {
  if (!Number.isInteger(value) || value < 0) fail(field, "must be a non-negative integer");
  return value;
}

function assertNullableNonNegativeInteger(value, field) {
  if (value === null) return null;
  return requireNonNegativeInteger(value, field);
}

function assertNullablePositiveInteger(value, field) {
  if (value === null) return null;
  return requirePositiveInteger(value, field);
}

function assertIsoTimestamp(value, field) {
  if (typeof value !== "string" || Number.isNaN(Date.parse(value))) fail(field, "must be an ISO timestamp string");
  if (value.length > 40) fail(field, "must be at most 40 characters");
  return value;
}

const RUN_KEYS = Object.freeze(["workflow", "run_id", "attempt"]);
const MODEL_KEYS = Object.freeze([
  "model_id",
  "model_version",
  "watermark_summary",
  "delta_counts",
  "batch_count",
  "estimated_writes",
  "observed_writes",
]);
const WATERMARK_SUMMARY_KEYS = Object.freeze(["partition_count", "min_watermark", "max_watermark"]);
const DELTA_COUNTS_KEYS = Object.freeze(["insert", "update", "delete", "unchanged", "total_ops"]);
const TOTALS_KEYS = Object.freeze(["estimated_writes", "observed_writes", "total_ops", "batch_count"]);
const RETRIES_KEYS = Object.freeze(["attempts", "transient_failures"]);
const VERIFICATION_KEYS = Object.freeze(["status", "detail"]);
const ROLLBACK_KEYS = Object.freeze(["compensates_receipt", "rebuild_command", "reason"]);
const CANARY_STATUSES = Object.freeze(["passed", "failed"]);
const CANARY_KEYS = Object.freeze([
  "status",
  "generation",
  "findings_count",
  "watermark_mismatch_count",
  "representative_query_failed_count",
  "content_hash",
]);
const RECONCILE_KEYS = Object.freeze([
  "consistent",
  "truncated",
  "generation",
  "findings_count",
  "findings_by_classification",
  "content_hash",
]);
const RECONCILE_CLASSIFICATION_KEYS = Object.freeze([...FINDING_CLASSIFICATIONS]);
const TOP_LEVEL_KEYS = Object.freeze([
  "schema",
  "receipt_id",
  "recorded_at",
  "run",
  "generation",
  "deploy_fingerprint",
  "previous_fingerprint",
  "outcome",
  "reason",
  "models",
  "totals",
  "retries",
  "duration_ms",
  "verification",
  "rollback",
  "canary",
  "reconcile",
]);

function validateRun(run) {
  requirePlainObject(run, "receipt.run");
  requireKnownKeys(run, RUN_KEYS, "receipt.run");
  // The workflow display name (github.workflow) is human-authored and may
  // carry spaces or punctuation ("Deploy worker"), so it is bounded text
  // rather than a delimiter-restricted identifier; run_id and attempt stay
  // strict identifiers since they are machine-generated tokens.
  assertText(run.workflow, "receipt.run.workflow", { maxLength: 100 });
  assertIdentifier(String(run.run_id), "receipt.run.run_id");
  requirePositiveInteger(run.attempt, "receipt.run.attempt");
}

function validateWatermarkSummary(summary, field) {
  if (summary === null) return;
  requirePlainObject(summary, field);
  requireKnownKeys(summary, WATERMARK_SUMMARY_KEYS, field);
  requireNonNegativeInteger(summary.partition_count, `${field}.partition_count`);
  assertNullableText(summary.min_watermark, `${field}.min_watermark`, { maxLength: 120 });
  assertNullableText(summary.max_watermark, `${field}.max_watermark`, { maxLength: 120 });
}

function validateDeltaCounts(counts, field) {
  if (counts === null) return;
  requirePlainObject(counts, field);
  requireKnownKeys(counts, DELTA_COUNTS_KEYS, field);
  for (const key of DELTA_COUNTS_KEYS) requireNonNegativeInteger(counts[key], `${field}.${key}`);
}

function validateModel(model, index) {
  const field = `receipt.models[${index}]`;
  requirePlainObject(model, field);
  requireKnownKeys(model, MODEL_KEYS, field);
  assertIdentifier(model.model_id, `${field}.model_id`);
  assertNullablePositiveInteger(model.model_version, `${field}.model_version`);
  validateWatermarkSummary(model.watermark_summary, `${field}.watermark_summary`);
  validateDeltaCounts(model.delta_counts, `${field}.delta_counts`);
  assertNullableNonNegativeInteger(model.batch_count, `${field}.batch_count`);
  assertNullableNonNegativeInteger(model.estimated_writes, `${field}.estimated_writes`);
  assertNullableNonNegativeInteger(model.observed_writes, `${field}.observed_writes`);
}

function validateTotals(totals) {
  if (totals === null) return;
  requirePlainObject(totals, "receipt.totals");
  requireKnownKeys(totals, TOTALS_KEYS, "receipt.totals");
  for (const key of TOTALS_KEYS) assertNullableNonNegativeInteger(totals[key], `receipt.totals.${key}`);
}

function validateRetries(retries) {
  requirePlainObject(retries, "receipt.retries");
  requireKnownKeys(retries, RETRIES_KEYS, "receipt.retries");
  requireNonNegativeInteger(retries.attempts, "receipt.retries.attempts");
  requireNonNegativeInteger(retries.transient_failures, "receipt.retries.transient_failures");
}

function validateVerification(verification) {
  requirePlainObject(verification, "receipt.verification");
  requireKnownKeys(verification, VERIFICATION_KEYS, "receipt.verification");
  if (!VERIFICATION_STATUSES.includes(verification.status)) {
    fail("receipt.verification.status", `must be one of ${VERIFICATION_STATUSES.join(", ")}`);
  }
  assertNullableText(verification.detail, "receipt.verification.detail", { maxLength: MAX_TEXT_LENGTH });
}

function validateRollback(rollback, outcome) {
  if (outcome !== "rolled_back") {
    if (rollback !== null) fail("receipt.rollback", `must be null unless outcome is "rolled_back"`);
    return;
  }
  requirePlainObject(rollback, "receipt.rollback");
  requireKnownKeys(rollback, ROLLBACK_KEYS, "receipt.rollback");
  assertIdentifier(rollback.compensates_receipt, "receipt.rollback.compensates_receipt");
  assertText(rollback.rebuild_command, "receipt.rollback.rebuild_command", { maxLength: 300 });
  assertText(rollback.reason, "receipt.rollback.reason");
}

/**
 * The canary and reconcile sections (release-control card d1-08) are bounded
 * summaries of the evidence tools/d1_canary.mjs and tools/d1_reconcile.mjs
 * produce, not the full findings array: a receipt never carries a source row
 * or an unbounded list, only counts, a status/consistency flag, and the
 * content hash a reader can use to fetch the full evidence elsewhere.
 */
function validateCanarySection(canary) {
  if (canary === null) return;
  requirePlainObject(canary, "receipt.canary");
  requireKnownKeys(canary, CANARY_KEYS, "receipt.canary");
  if (!CANARY_STATUSES.includes(canary.status)) fail("receipt.canary.status", `must be one of ${CANARY_STATUSES.join(", ")}`);
  assertNullablePositiveInteger(canary.generation, "receipt.canary.generation");
  requireNonNegativeInteger(canary.findings_count, "receipt.canary.findings_count");
  requireNonNegativeInteger(canary.watermark_mismatch_count, "receipt.canary.watermark_mismatch_count");
  requireNonNegativeInteger(canary.representative_query_failed_count, "receipt.canary.representative_query_failed_count");
  assertSha256(canary.content_hash, "receipt.canary.content_hash");
  if (canary.status === "passed" && (canary.findings_count > 0 || canary.watermark_mismatch_count > 0 || canary.representative_query_failed_count > 0)) {
    fail("receipt.canary.status", `must not be "passed" while a finding, watermark mismatch, or representative-query failure is recorded`);
  }
}

function validateReconcileSection(reconcile) {
  if (reconcile === null) return;
  requirePlainObject(reconcile, "receipt.reconcile");
  requireKnownKeys(reconcile, RECONCILE_KEYS, "receipt.reconcile");
  if (typeof reconcile.consistent !== "boolean") fail("receipt.reconcile.consistent", "must be a boolean");
  if (typeof reconcile.truncated !== "boolean") fail("receipt.reconcile.truncated", "must be a boolean");
  assertNullablePositiveInteger(reconcile.generation, "receipt.reconcile.generation");
  requireNonNegativeInteger(reconcile.findings_count, "receipt.reconcile.findings_count");
  requirePlainObject(reconcile.findings_by_classification, "receipt.reconcile.findings_by_classification");
  requireKnownKeys(reconcile.findings_by_classification, RECONCILE_CLASSIFICATION_KEYS, "receipt.reconcile.findings_by_classification");
  for (const classification of RECONCILE_CLASSIFICATION_KEYS) {
    requireNonNegativeInteger(reconcile.findings_by_classification[classification], `receipt.reconcile.findings_by_classification.${classification}`);
  }
  assertSha256(reconcile.content_hash, "receipt.reconcile.content_hash");
  if (reconcile.truncated && reconcile.consistent) fail("receipt.reconcile.consistent", "must be false while truncated is true");
  if (reconcile.findings_count > 0 && reconcile.consistent) fail("receipt.reconcile.consistent", "must be false while a finding is recorded");
}

/**
 * Validate a publication receipt against the closed schema: no unknown field
 * anywhere, every string bounded and non-secret-shaped, exactly one closed
 * outcome, and a rollback pointer present if and only if the outcome is
 * "rolled_back". Throws PublicationReceiptError and never returns a partial
 * receipt.
 */
export function validatePublicationReceipt(receipt) {
  requirePlainObject(receipt, "receipt");
  requireKnownKeys(receipt, TOP_LEVEL_KEYS, "receipt");
  if (receipt.schema !== D1_PUBLICATION_RECEIPT_SCHEMA) fail("receipt.schema", `must be ${D1_PUBLICATION_RECEIPT_SCHEMA}`);
  assertIdentifier(receipt.receipt_id, "receipt.receipt_id");
  assertIsoTimestamp(receipt.recorded_at, "receipt.recorded_at");
  validateRun(receipt.run);
  assertNullablePositiveInteger(receipt.generation, "receipt.generation");
  assertSha256(receipt.deploy_fingerprint, "receipt.deploy_fingerprint");
  assertNullableSha256(receipt.previous_fingerprint, "receipt.previous_fingerprint");
  if (!OUTCOMES.includes(receipt.outcome)) fail("receipt.outcome", `must be one of ${OUTCOMES.join(", ")}`);
  assertText(receipt.reason, "receipt.reason");
  if (receipt.models !== null) {
    if (!Array.isArray(receipt.models)) fail("receipt.models", "must be an array or null");
    if (receipt.models.length > MAX_MODELS) fail("receipt.models", `must have at most ${MAX_MODELS} entries`);
    receipt.models.forEach(validateModel);
  }
  validateTotals(receipt.totals);
  validateRetries(receipt.retries);
  assertNullableNonNegativeInteger(receipt.duration_ms, "receipt.duration_ms");
  validateVerification(receipt.verification);
  validateRollback(receipt.rollback, receipt.outcome);
  validateCanarySection(receipt.canary);
  validateReconcileSection(receipt.reconcile);
  return receipt;
}

/** Reduce a full canary evidence object (tools/d1_canary.mjs) to the receipt's bounded section. */
export function summarizeCanaryEvidence(evidence) {
  if (!evidence) return null;
  if (evidence.schema !== D1_CANARY_EVIDENCE_SCHEMA) fail("canaryEvidence", "has the wrong schema");
  return {
    status: evidence.status,
    generation: evidence.generation ?? null,
    findings_count: evidence.findings_count,
    watermark_mismatch_count: (evidence.watermarks || []).filter((watermark) => watermark.status === "mismatch").length,
    representative_query_failed_count: (evidence.representative_queries || []).filter((query) => query.status === "failed").length,
    content_hash: evidence.content_hash,
  };
}

/** Reduce a full reconcile report (tools/d1_reconcile.mjs) to the receipt's bounded section. */
export function summarizeReconcileReport(report) {
  if (!report) return null;
  if (report.schema !== D1_RECONCILE_REPORT_SCHEMA) fail("reconcileReport", "has the wrong schema");
  return {
    consistent: report.consistent,
    truncated: report.truncated,
    generation: report.generation ?? null,
    findings_count: report.findings_count,
    findings_by_classification: { ...report.findings_by_classification },
    content_hash: report.content_hash,
  };
}

/**
 * Every receipt in a log must belong to a distinct run (workflow, run id, and
 * attempt): the "exactly one terminal outcome per run" invariant. A rollback
 * is a separate run compensating an earlier one, so it never collides here —
 * it carries its own run identity and points at the original via
 * rollback.compensates_receipt instead of reusing its run key.
 */
export function assertOneTerminalOutcomePerRun(receipts) {
  const seen = new Map();
  for (const receipt of receipts) {
    const key = `${receipt.run.workflow}:${receipt.run.run_id}:${receipt.run.attempt}`;
    if (seen.has(key)) {
      fail("receipts", `run ${key} already has a terminal receipt (${seen.get(key)}); found a second (${receipt.outcome})`);
    }
    seen.set(key, receipt.outcome);
  }
  return receipts;
}

function runKey(run) {
  return `${run.workflow}:${run.run_id}:${run.attempt}`;
}

function watermarkSummaryFromSnapshotModel(model) {
  const partitions = model?.partitions || {};
  const values = Object.values(partitions)
    .map((partition) => partition?.watermark)
    .filter((watermark) => typeof watermark === "string" && watermark !== "");
  if (!values.length) return { partition_count: Object.keys(partitions).length, min_watermark: null, max_watermark: null };
  const sorted = [...values].sort(compareText);
  return { partition_count: Object.keys(partitions).length, min_watermark: sorted[0], max_watermark: sorted[sorted.length - 1] };
}

/**
 * batchPlan.models and dryRunReport().models share this shape; either can
 * supply delta/batch/estimated counts. delta_counts carries the delta plan's
 * raw per-model totals (tools/d1_delta_plan.mjs), which also includes
 * per-status partition counts; only the five row-level counts are part of
 * this receipt's closed shape.
 */
function countsSourceModels(countsSource) {
  if (!countsSource) return new Map();
  return new Map((countsSource.models || []).map((model) => [
    model.model_id,
    {
      ...model,
      delta_counts: model.delta_counts
        ? Object.fromEntries(DELTA_COUNTS_KEYS.map((key) => [key, model.delta_counts[key]]))
        : null,
    },
  ]));
}

function observedWritesByModel(batchPlan, publishReceipt) {
  if (!batchPlan || !publishReceipt) return new Map();
  const byBatchId = new Map(batchPlan.batches.map((batch) => [batch.batch_id, batch]));
  const totals = new Map();
  for (const completed of publishReceipt.completed_batches || []) {
    const batch = byBatchId.get(completed.batch_id);
    if (!batch) continue;
    totals.set(batch.model_id, (totals.get(batch.model_id) || 0) + batch.estimated_writes);
  }
  return totals;
}

/**
 * Merge whatever publication evidence exists for this run into one sorted,
 * closed-shape model list: watermark provenance from a partition snapshot
 * (tools/d1_delta_plan.mjs), delta/batch/estimated counts from a bounded-publish
 * plan or its dry-run report (tools/d1_bounded_publisher.mjs), and observed
 * writes from that plan joined against a publisher checkpoint receipt. Any
 * input that does not exist for this run is simply omitted; the corresponding
 * fields stay null. Returns null when nothing at all was supplied.
 */
export function summarizeModels({ snapshot = null, batchPlan = null, dryRun = null, publishReceipt = null } = {}) {
  if (snapshot && snapshot.schema !== SNAPSHOT_SCHEMA) fail("snapshot", "has the wrong schema");
  if (batchPlan && batchPlan.schema !== D1_BOUNDED_PUBLISH_PLAN_SCHEMA) fail("batchPlan", "has the wrong schema");
  if (dryRun && dryRun.schema !== D1_BOUNDED_PUBLISH_DRYRUN_SCHEMA) fail("dryRun", "has the wrong schema");
  if (publishReceipt && publishReceipt.schema !== D1_BOUNDED_PUBLISH_RECEIPT_SCHEMA) fail("publishReceipt", "has the wrong schema");
  if (publishReceipt && !batchPlan) fail("batchPlan", "is required to attribute a publish receipt's observed writes to a model");

  const countsSource = batchPlan || dryRun;
  const counts = countsSourceModels(countsSource);
  const observed = observedWritesByModel(batchPlan, publishReceipt);

  const modelIds = new Set([...Object.keys(snapshot?.models || {}), ...counts.keys()]);
  if (!modelIds.size) return null;

  // observed_writes is 0, not null, for a model in an actually-attempted publish
  // (batchPlan + publishReceipt both present) that simply completed no batches —
  // that is a real observation ("zero writes landed"), not an absence of one.
  // It stays null only when no publish was attempted at all.
  const attempted = Boolean(batchPlan && publishReceipt);

  return [...modelIds].sort(compareText).map((modelId) => {
    const snapshotModel = snapshot?.models?.[modelId] ?? null;
    const countsModel = counts.get(modelId) ?? null;
    return {
      model_id: modelId,
      model_version: snapshotModel?.model_version ?? null,
      watermark_summary: snapshotModel ? watermarkSummaryFromSnapshotModel(snapshotModel) : null,
      delta_counts: countsModel?.delta_counts ?? null,
      batch_count: countsModel?.batch_count ?? null,
      estimated_writes: countsModel?.estimated_writes ?? null,
      observed_writes: attempted ? (observed.get(modelId) ?? 0) : null,
    };
  });
}

function sumNullable(values) {
  const present = values.filter((value) => value !== null && value !== undefined);
  return present.length ? present.reduce((sum, value) => sum + value, 0) : null;
}

export function totalsFromModels(models) {
  if (!models || !models.length) return null;
  return {
    estimated_writes: sumNullable(models.map((model) => model.estimated_writes)),
    observed_writes: sumNullable(models.map((model) => model.observed_writes)),
    total_ops: sumNullable(models.map((model) => model.delta_counts?.total_ops ?? null)),
    batch_count: sumNullable(models.map((model) => model.batch_count)),
  };
}

// tools/d1_bounded_publisher.mjs stamps this exact shape into stopped_reason
// (see publishBounded); it is the only place the final, never-completed
// batch's attempt count and failure classification are recorded.
const STOPPED_REASON_PATTERN = /^(transient|permanent) error on attempt (\d+) of batch/;

/**
 * Retry accounting derived from a bounded-publisher checkpoint receipt: every
 * completed batch's attempt count, plus — when the run stopped on a failure —
 * the attempts spent on the batch that never completed. A permanent failure
 * never retries, so its one attempt never counts as a transient failure; a
 * transient run that exhausted its retry budget counts every attempt on that
 * batch as a transient failure, since none of them succeeded.
 */
export function retriesFromPublishReceipt(publishReceipt) {
  if (!publishReceipt) return { attempts: 0, transient_failures: 0 };
  const completed = publishReceipt.completed_batches || [];
  let attempts = completed.reduce((sum, batch) => sum + (batch.attempt || 1), 0);
  let transientFailures = completed.reduce((sum, batch) => sum + Math.max(0, (batch.attempt || 1) - 1), 0);
  const match = STOPPED_REASON_PATTERN.exec(publishReceipt.stopped_reason || "");
  if (match) {
    const [, classification, attemptText] = match;
    const failedAttempts = Number(attemptText);
    attempts += failedAttempts;
    transientFailures += classification === "transient" ? failedAttempts : failedAttempts - 1;
  }
  return { attempts, transient_failures: transientFailures };
}

/**
 * Compose one publication receipt (release-control card d1-07). Pure: every
 * input is already-loaded data, never a file path. Always returns a receipt
 * that passes validatePublicationReceipt, or throws before returning one.
 */
export function buildPublicationReceipt({
  run,
  outcome,
  reason,
  deployFingerprint,
  previousFingerprint = null,
  generation = null,
  snapshot = null,
  batchPlan = null,
  dryRun = null,
  publishReceipt = null,
  retries = null,
  durationMs = null,
  verification = null,
  rollback = null,
  canaryEvidence = null,
  reconcileReport = null,
  recordedAt = new Date().toISOString(),
  receiptId = null,
}) {
  const models = summarizeModels({ snapshot, batchPlan, dryRun, publishReceipt });
  const receipt = {
    schema: D1_PUBLICATION_RECEIPT_SCHEMA,
    receipt_id: receiptId || `${run.run_id}:${run.attempt}:${generation ?? "none"}`,
    recorded_at: recordedAt,
    run: { workflow: run.workflow, run_id: String(run.run_id), attempt: run.attempt },
    generation,
    deploy_fingerprint: deployFingerprint,
    previous_fingerprint: previousFingerprint,
    outcome,
    reason,
    models,
    totals: totalsFromModels(models),
    retries: retries || retriesFromPublishReceipt(publishReceipt),
    duration_ms: durationMs,
    verification: verification || { status: "not_run", detail: null },
    rollback: rollback
      ? {
          compensates_receipt: rollback.compensatesReceipt,
          rebuild_command: rollback.rebuildCommand,
          reason: rollback.reason,
        }
      : null,
    canary: summarizeCanaryEvidence(canaryEvidence),
    reconcile: summarizeReconcileReport(reconcileReport),
  };
  return validatePublicationReceipt(receipt);
}

/** A single compact line for one receipt, for eyeballing a run's shape without parsing JSON. */
export function summarizeReceipt(receipt) {
  const writes = `est=${receipt.totals?.estimated_writes ?? "-"} obs=${receipt.totals?.observed_writes ?? "-"}`;
  const generation = receipt.generation === null ? "-" : receipt.generation;
  return `run=${runKey(receipt.run)} generation=${generation} outcome=${receipt.outcome} ${writes} duration_ms=${receipt.duration_ms ?? "-"} :: ${receipt.reason}`;
}

/**
 * Deterministically total estimated vs. observed writes across every receipt
 * whose recorded_at falls in [from, to), for the billing-vs-cadence
 * comparison. Ordering never affects the totals; receipts are still sorted so
 * two calls over the same set always print identically.
 */
export function compareReceipts(receipts, { from = null, to = null } = {}) {
  const fromMs = from ? Date.parse(from) : -Infinity;
  const toMs = to ? Date.parse(to) : Infinity;
  const inRange = receipts
    .filter((receipt) => {
      const at = Date.parse(receipt.recorded_at);
      return at >= fromMs && at < toMs;
    })
    .sort((left, right) => compareText(left.recorded_at, right.recorded_at) || compareText(left.receipt_id, right.receipt_id));

  const byOutcome = {};
  for (const outcome of OUTCOMES) byOutcome[outcome] = 0;
  for (const receipt of inRange) byOutcome[receipt.outcome] += 1;

  return {
    from: from || null,
    to: to || null,
    run_count: inRange.length,
    by_outcome: byOutcome,
    estimated_writes: sumNullable(inRange.map((receipt) => receipt.totals?.estimated_writes ?? null)),
    observed_writes: sumNullable(inRange.map((receipt) => receipt.totals?.observed_writes ?? null)),
    receipt_ids: inRange.map((receipt) => receipt.receipt_id),
  };
}

function readJsonlReceipts(path) {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

/**
 * Append one validated receipt to the local JSONL log and, when a KV store is
 * given, write it under the receipt key prefix through the same store-adapter
 * pattern as the generation fence. Refuses a second terminal receipt for the
 * same run already present in the local log — append-only, never a rewrite.
 */
export function recordPublicationReceipt({ receipt, localPath = DEFAULT_LOCAL_RECEIPT_PATH, kvStore = null }) {
  validatePublicationReceipt(receipt);
  const existing = readJsonlReceipts(localPath);
  assertOneTerminalOutcomePerRun([...existing, receipt]);
  mkdirSync(dirname(localPath), { recursive: true });
  writeFileSync(localPath, `${JSON.stringify(receipt)}\n`, { flag: "a" });
  return receipt;
}

export async function appendReceiptToKv(kvStore, receipt) {
  if (!kvStore) return;
  await kvStore.put(`${RECEIPT_KEY_PREFIX}${receipt.receipt_id}`, receipt);
}

/** Deterministic fixture store used by tests and local rehearsals. */
export function createMemoryReceiptStore() {
  const puts = [];
  return {
    async put(key, value) {
      puts.push({ key, value: structuredClone(value) });
    },
    get puts() {
      return puts.map((entry) => ({ key: entry.key, value: structuredClone(entry.value) }));
    },
  };
}

/** One JSON file per receipt under a directory, for a file-based rehearsal of the KV path. */
export function fileReceiptStore(dir) {
  return {
    async put(key, value) {
      mkdirSync(dir, { recursive: true });
      const safeName = key.replace(/[^A-Za-z0-9._:-]/g, "_");
      writeFileSync(resolve(dir, `${safeName}.json`), `${JSON.stringify(value, null, 2)}\n`);
    },
  };
}

/** Adapter for the same wrangler KV binding the generation fence writes to, under a receipt key prefix. */
export function createWranglerKvReceiptStore({
  binding = "ALERT_STATE",
  config = "worker/wrangler.toml",
  remote = true,
  wranglerVersion = "4.126.0",
  run = null,
} = {}) {
  const invoke = run || (async (args) => execFileAsync("npx", [`wrangler@${wranglerVersion}`, ...args], { encoding: "utf8" }));
  return {
    async put(key, value) {
      await invoke([
        "kv",
        "key",
        "put",
        key,
        JSON.stringify(value),
        "--binding",
        binding,
        ...(remote ? ["--remote"] : []),
        "--config",
        config,
      ]);
    },
  };
}

function parseArgs(argv) {
  const args = { command: argv[2] };
  for (let index = 3; index < argv.length; index += 1) {
    const flag = argv[index];
    if (!flag.startsWith("--")) fail("argv", `unknown argument ${flag}`);
    args[flag.slice(2)] = argv[++index];
  }
  return args;
}

function required(args, name) {
  if (args[name] === undefined || args[name] === "") fail("argv", `missing --${name}`);
  return args[name];
}

function readJsonIfGiven(path) {
  return path ? JSON.parse(readFileSync(path, "utf8")) : null;
}

function receiptFromArgs(args) {
  const rollback = args["rollback-compensates"]
    ? {
        compensatesReceipt: args["rollback-compensates"],
        rebuildCommand: required(args, "rollback-command"),
        reason: required(args, "rollback-reason"),
      }
    : null;
  return buildPublicationReceipt({
    run: { workflow: required(args, "workflow"), run_id: required(args, "run-id"), attempt: Number(required(args, "attempt")) },
    outcome: required(args, "outcome"),
    reason: required(args, "reason"),
    deployFingerprint: required(args, "deploy-fingerprint"),
    previousFingerprint: args["previous-fingerprint"] || null,
    generation: args.generation ? Number(args.generation) : null,
    snapshot: readJsonIfGiven(args.snapshot),
    batchPlan: readJsonIfGiven(args["batch-plan"]),
    dryRun: readJsonIfGiven(args["dry-run"]),
    publishReceipt: readJsonIfGiven(args["publish-receipt"]),
    durationMs: args["duration-ms"] ? Number(args["duration-ms"]) : null,
    verification: args["verification-status"]
      ? { status: args["verification-status"], detail: args["verification-detail"] || null }
      : null,
    rollback,
    canaryEvidence: readJsonIfGiven(args["canary-evidence"]),
    reconcileReport: readJsonIfGiven(args["reconcile-report"]),
  });
}

function storeFromArgs(args) {
  if (args["kv-dir"]) return fileReceiptStore(args["kv-dir"]);
  if (!args.binding && !args.remote && !args.config) return null;
  return createWranglerKvReceiptStore({
    binding: args.binding || "ALERT_STATE",
    config: args.config || "worker/wrangler.toml",
    remote: args.remote !== "false",
    wranglerVersion: args["wrangler-version"] || "4.126.0",
  });
}

function writeOutput(path, value) {
  const text = `${JSON.stringify(value, null, 2)}\n`;
  if (!path) {
    process.stdout.write(text);
    return;
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}

async function main(argv) {
  const args = parseArgs(argv);
  if (args.command === "build") {
    writeOutput(args.out, receiptFromArgs(args));
    return 0;
  }
  if (args.command === "record") {
    // The local JSONL append is the durable CI record and any failure to
    // validate or write it must surface. The KV mirror is best-effort: a
    // transient KV error must never turn an otherwise-successful publication
    // (whose durable receipt already landed) into a failed deploy.
    const receipt = receiptFromArgs(args);
    recordPublicationReceipt({ receipt, localPath: args.local || DEFAULT_LOCAL_RECEIPT_PATH, kvStore: null });
    const kvStore = storeFromArgs(args);
    if (kvStore) {
      try {
        await appendReceiptToKv(kvStore, receipt);
      } catch (error) {
        console.error(`d1_publication_receipt: warning: failed to mirror receipt to KV: ${error?.message || error}`);
      }
    }
    writeOutput(args.out, receipt);
    return 0;
  }
  if (args.command === "summarize") {
    for (const receipt of readJsonlReceipts(required(args, "receipts"))) {
      console.log(summarizeReceipt(receipt));
    }
    return 0;
  }
  if (args.command === "compare") {
    const receipts = readJsonlReceipts(required(args, "receipts"));
    writeOutput(args.out, compareReceipts(receipts, { from: args.from || null, to: args.to || null }));
    return 0;
  }
  console.error("d1_publication_receipt: usage: build | record | summarize | compare (see file header)");
  return 2;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv).then((code) => {
    process.exitCode = code;
  }).catch((error) => {
    console.error(error?.stack || error);
    process.exitCode = 1;
  });
}
