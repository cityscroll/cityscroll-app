#!/usr/bin/env node

/**
 * Canary a bounded partition set before a production-wide D1 publication
 * (release-control card d1-08).
 *
 * Nothing in the ladder so far proves, before letting a generation's delta
 * plan run against every partition, that a small applied slice actually
 * matches what the source documents say it should be. This module selects a
 * small partition set from a delta plan (bounded by the production policy at
 * worker/d1-release-policy.json), applies only that slice through the
 * existing bounded publisher (tools/d1_bounded_publisher.mjs) against an
 * injected target adapter, and then compares source-derived expectations
 * (tools/d1_stable_keys.mjs tableRows) against what the target actually
 * returns: key presence, per-table row counts for the partition, the stored
 * watermark, and one representative query per model.
 *
 * The target adapter is the same shape the bounded publisher's executor
 * already uses, extended with a read side:
 *   { execute(sql, batch) -> Promise<void>, select(sql, params) -> Promise<object[]> }
 * so a test can point both the publisher and this module at the same
 * in-memory/SQLite double.
 *
 * Any invariant failure — the canary publish itself not completing, a missing/
 * duplicate/stale/unexpected row, a watermark mismatch, or a failed
 * representative query — produces a failing evidence object. This module
 * never marks a generation accepted; it only ever reports pass or fail. A
 * caller must treat "failed" as "stop the generation, preserve the receipt,
 * and only rebuild explicitly" (release-control card d1-09).
 *
 * Usage:
 *   node tools/d1_canary.mjs select --plan <deltaplan.json> [--policy <path>]
 *                                    [--max-partitions <n>] [--max-rows <n>] [--out <path>]
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { DEFAULT_MAX_OPS_PER_BATCH, planBatches, publishBounded } from "./d1_bounded_publisher.mjs";
import { PLAN_SCHEMA } from "./d1_delta_plan.mjs";
import { modelEntry } from "./d1_manifest.mjs";
import { TABLE_COLUMNS, keyColumns, tableRows } from "./d1_stable_keys.mjs";
import { readSourceDocument, sqlLiteral } from "./build_worker_d1_read_models.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export const D1_CANARY_EVIDENCE_SCHEMA = "cityscroll.d1-canary-evidence.v1";
export const D1_RELEASE_POLICY_SCHEMA = "cityscroll.d1-release-policy.v1";
export const DEFAULT_RELEASE_POLICY_PATH = resolve(ROOT, "worker/d1-release-policy.json");

export const FINDING_CLASSIFICATIONS = Object.freeze(["missing", "duplicate", "stale", "unexpected"]);

export class D1ReleasePolicyError extends Error {
  constructor(detail) {
    super(`d1 release policy: ${detail}`);
    this.name = "D1ReleasePolicyError";
  }
}

export class D1CanaryError extends Error {
  constructor(detail) {
    super(`d1 canary: ${detail}`);
    this.name = "D1CanaryError";
  }
}

function policyFail(detail) {
  throw new D1ReleasePolicyError(detail);
}

function canaryFail(detail) {
  throw new D1CanaryError(detail);
}

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  }
  return value;
}

export function stableStringify(value) {
  return JSON.stringify(canonical(value));
}

export function sha256Hex(text) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function requirePlainObject(value, field) {
  if (!value || typeof value !== "object" || Array.isArray(value)) policyFail(`${field} must be an object`);
  return value;
}

function requireKnownKeys(value, allowed, field) {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) policyFail(`${field}.${key} is not a known field`);
  }
}

function requirePositiveInteger(value, field) {
  if (!Number.isInteger(value) || value < 1) policyFail(`${field} must be a positive integer`);
  return value;
}

/**
 * Production policy as data: the maximum canary scope (partition count and
 * row count), a separate bounded scope for reconcile, and the abort
 * threshold both tools use to stop accumulating findings and report a
 * truncated result instead of scanning without limit.
 */
export function validateReleasePolicy(policy) {
  requirePlainObject(policy, "policy");
  if (policy.schema !== D1_RELEASE_POLICY_SCHEMA) policyFail(`policy.schema must be ${D1_RELEASE_POLICY_SCHEMA}`);
  requireKnownKeys(policy, ["schema", "canary", "reconcile", "abort_threshold"], "policy");

  requirePlainObject(policy.canary, "policy.canary");
  requireKnownKeys(policy.canary, ["max_partitions", "max_rows"], "policy.canary");
  requirePositiveInteger(policy.canary.max_partitions, "policy.canary.max_partitions");
  requirePositiveInteger(policy.canary.max_rows, "policy.canary.max_rows");

  requirePlainObject(policy.reconcile, "policy.reconcile");
  requireKnownKeys(policy.reconcile, ["max_partitions", "max_rows"], "policy.reconcile");
  requirePositiveInteger(policy.reconcile.max_partitions, "policy.reconcile.max_partitions");
  requirePositiveInteger(policy.reconcile.max_rows, "policy.reconcile.max_rows");

  requirePlainObject(policy.abort_threshold, "policy.abort_threshold");
  requireKnownKeys(policy.abort_threshold, ["max_findings"], "policy.abort_threshold");
  requirePositiveInteger(policy.abort_threshold.max_findings, "policy.abort_threshold.max_findings");

  return policy;
}

export function loadReleasePolicy(path = DEFAULT_RELEASE_POLICY_PATH) {
  if (!existsSync(path)) policyFail(`no release policy at ${path}`);
  return validateReleasePolicy(JSON.parse(readFileSync(path, "utf8")));
}

/** `column = 'value' AND column2 = 'value2'`, reusing the manifest's own key columns and SQL literal escaping. */
export function keyPredicate(entry, table, keyValues) {
  const columns = keyColumns(entry, table);
  if (columns.length !== keyValues.length) {
    canaryFail(`${table} key has ${keyValues.length} values for ${columns.length} key columns`);
  }
  return columns.map((column, index) => `${column} = ${sqlLiteral(keyValues[index])}`).join(" AND ");
}

function partitionScopeClause(entry, table) {
  if (entry.partition.kind === "family" && (TABLE_COLUMNS[table] || []).includes(entry.partition.column)) {
    return { clause: `${entry.partition.column} = ?`, bound: true };
  }
  return { clause: "1 = 1", bound: false };
}

/** Every row of one table currently in the target, scoped to a partition, keyed the same way tableRows keys them. */
async function scanTableForPartition({ entry, table, partition, adapter }) {
  const columns = TABLE_COLUMNS[table];
  const scope = partitionScopeClause(entry, table);
  const sql = `SELECT ${columns.join(", ")} FROM ${table} WHERE ${scope.clause}`;
  const rows = await adapter.select(sql, scope.bound ? [partition] : []);
  const keyCols = keyColumns(entry, table);
  const byKey = new Map();
  for (const row of rows) {
    const keyValues = keyCols.map((column) => row[column]);
    const key = keyValues.join("|");
    const bucket = byKey.get(key) || [];
    bucket.push(row);
    byKey.set(key, bucket);
  }
  return byKey;
}

/** Tolerant of storage-affinity coercion (e.g. a TEXT-affinity column round-tripping a number as a string). */
function normalizedColumnsJson(columns) {
  const normalized = {};
  for (const key of Object.keys(columns).sort()) {
    const value = columns[key];
    normalized[key] = value === null || value === undefined ? null : String(value);
  }
  return JSON.stringify(normalized);
}

/** Diff a table's expected (source-derived) rows against what the target actually holds, for one partition. */
export function classifyPartitionFindings({ entry, table, partition, expectedRows, observedByKey }) {
  const findings = [];
  const expectedKeys = new Set(expectedRows.map((row) => row.key));
  for (const row of expectedRows) {
    const observed = observedByKey.get(row.key) || [];
    if (observed.length === 0) {
      findings.push({ classification: "missing", model_id: entry.model_id, table, partition, key: row.key });
    } else if (observed.length > 1) {
      findings.push({ classification: "duplicate", model_id: entry.model_id, table, partition, key: row.key, observed_count: observed.length });
    } else if (normalizedColumnsJson(row.columns) !== normalizedColumnsJson(observed[0])) {
      findings.push({ classification: "stale", model_id: entry.model_id, table, partition, key: row.key });
    }
  }
  for (const key of observedByKey.keys()) {
    if (!expectedKeys.has(key)) {
      findings.push({ classification: "unexpected", model_id: entry.model_id, table, partition, key, observed_count: observedByKey.get(key).length });
    }
  }
  return findings;
}

export function sortFindings(findings) {
  return [...findings].sort((left, right) => (
    compareText(left.model_id, right.model_id)
    || compareText(left.table, right.table)
    || compareText(left.partition, right.partition)
    || compareText(left.classification, right.classification)
    || compareText(left.key, right.key)
  ));
}

/** Model ids that store a queryable per-partition (or per-model) watermark column; ocp_awards stores none. */
const WATERMARK_TARGETS = Object.freeze({
  keyword_search: { table: "keyword_search_families", column: "as_of", keyColumn: "family_id" },
  entity_intelligence: { table: "entity_intelligence_meta", column: "generated_at", keyColumn: "id", keyValue: "current" },
});

function expectedWatermark(entry, sourceDocument, partition) {
  if (entry.watermark.scope === "partition") {
    return sourceDocument?.families?.[partition]?.[entry.watermark.field] ?? null;
  }
  return sourceDocument?.[entry.watermark.field] ?? null;
}

async function verifyWatermark({ entry, sourceDocument, partition, adapter }) {
  const target = WATERMARK_TARGETS[entry.model_id];
  if (!target) return { model_id: entry.model_id, partition, status: "not_applicable", expected: null, observed: null };
  const expected = expectedWatermark(entry, sourceDocument, partition);
  const keyValue = target.keyValue ?? partition;
  const rows = await adapter.select(`SELECT ${target.column} FROM ${target.table} WHERE ${target.keyColumn} = ?`, [keyValue]);
  const observed = rows[0]?.[target.column] ?? null;
  return { model_id: entry.model_id, partition, status: observed === expected ? "match" : "mismatch", expected, observed };
}

function firstWord(text) {
  const word = String(text || "").trim().split(/\s+/)[0] || "";
  return word.replace(/[^\p{L}\p{N}_-]/gu, "");
}

/** One representative query per model: an FTS lookup for keyword search, a key lookup for the others. */
const REPRESENTATIVE_QUERY = Object.freeze({
  async keyword_search({ entry, partition, rowsByTable, adapter }) {
    const sample = (rowsByTable.get("keyword_search_documents") || [])[0];
    if (!sample) return { model_id: entry.model_id, partition, status: "skipped_no_rows", detail: null };
    const word = firstWord(sample.columns.search_text);
    if (!word) return { model_id: entry.model_id, partition, status: "skipped_no_rows", detail: null };
    const rows = await adapter.select(
      "SELECT document_id FROM keyword_search_fts WHERE family_id = ? AND keyword_search_fts MATCH ?",
      [partition, `"${word.replaceAll('"', '""')}"`],
    );
    const found = rows.some((row) => row.document_id === sample.columns.document_id);
    return {
      model_id: entry.model_id, partition, status: found ? "passed" : "failed",
      detail: found ? null : `fts lookup for "${word}" did not return ${sample.columns.document_id}`,
    };
  },
  async ocp_awards({ entry, partition, rowsByTable, adapter }) {
    const sample = (rowsByTable.get("ocp_awards_warehouse") || [])[0];
    if (!sample) return { model_id: entry.model_id, partition, status: "skipped_no_rows", detail: null };
    const rows = await adapter.select(
      `SELECT vendor_name FROM ocp_awards_warehouse WHERE ${keyPredicate(entry, "ocp_awards_warehouse", sample.key_values)}`,
      [],
    );
    const ok = rows[0]?.vendor_name === sample.columns.vendor_name;
    return { model_id: entry.model_id, partition, status: ok ? "passed" : "failed", detail: ok ? null : "key lookup returned an unexpected vendor_name" };
  },
  async entity_intelligence({ entry, partition, rowsByTable, adapter }) {
    const sample = (rowsByTable.get("entity_intelligence_entities") || [])[0];
    if (!sample) return { model_id: entry.model_id, partition, status: "skipped_no_rows", detail: null };
    const rows = await adapter.select(
      `SELECT display_name FROM entity_intelligence_entities WHERE ${keyPredicate(entry, "entity_intelligence_entities", sample.key_values)}`,
      [],
    );
    const ok = rows[0]?.display_name === sample.columns.display_name;
    return { model_id: entry.model_id, partition, status: ok ? "passed" : "failed", detail: ok ? null : "key lookup returned an unexpected display_name" };
  },
});

/**
 * Compare source-derived expectations against a target adapter for exactly
 * the given (model_id, partition) selection: key presence, per-table counts,
 * duplicates, staleness, unexpected rows, the stored watermark, and one
 * representative query per model. Shared by canary (after a bounded publish)
 * and reconcile (against an already-accepted generation, no publish at all).
 */
export async function verifyPartitionScope({ manifest, sourceDocuments, adapter, selection }) {
  const findings = [];
  const watermarks = [];
  const representativeQueries = [];
  let rowsScanned = 0;

  for (const { model_id, partition } of selection) {
    const entry = modelEntry(manifest, model_id);
    const sourceDocument = sourceDocuments[model_id];
    const { rows } = tableRows(entry, sourceDocument);
    const partitionRows = rows.filter((row) => row.partition === partition);
    rowsScanned += partitionRows.length;

    const rowsByTable = new Map();
    for (const row of partitionRows) {
      if (!rowsByTable.has(row.table)) rowsByTable.set(row.table, []);
      rowsByTable.get(row.table).push(row);
    }

    for (const table of entry.tables.map((candidate) => candidate.name)) {
      const expectedRows = rowsByTable.get(table) || [];
      const observedByKey = await scanTableForPartition({ entry, table, partition, adapter });
      findings.push(...classifyPartitionFindings({ entry, table, partition, expectedRows, observedByKey }));
    }

    watermarks.push(await verifyWatermark({ entry, sourceDocument, partition, adapter }));

    const representativeQuery = REPRESENTATIVE_QUERY[model_id];
    if (representativeQuery) {
      representativeQueries.push(await representativeQuery({ entry, partition, rowsByTable, adapter }));
    }
  }

  return { findings: sortFindings(findings), watermarks, representativeQueries, rowsScanned };
}

/**
 * Select a bounded partition set from a delta plan: every changed partition
 * is a candidate, greedily accepted in (model_id, partition) order while
 * staying within the policy's canary scope. A candidate whose own row count
 * already exceeds the row bound is skipped rather than admitted oversize.
 * Refuses (rather than silently running with nothing selected) when the plan
 * has real changes but none fit the policy at all.
 */
export function selectCanaryScope({ plan, policy, maxPartitions = null, maxRows = null }) {
  if (!plan || plan.schema !== PLAN_SCHEMA) canaryFail("canary requires a delta plan (cityscroll.d1-delta-plan.v2)");
  if (plan.operation !== "delta") canaryFail(`canary runs against a delta plan only, got operation "${plan.operation}"`);

  const boundPartitions = maxPartitions ?? policy.canary.max_partitions;
  const boundRows = maxRows ?? policy.canary.max_rows;
  if (boundPartitions > policy.canary.max_partitions) {
    canaryFail(`requested canary scope of ${boundPartitions} partitions exceeds the policy maximum of ${policy.canary.max_partitions}`);
  }
  if (boundRows > policy.canary.max_rows) {
    canaryFail(`requested canary scope of ${boundRows} rows exceeds the policy maximum of ${policy.canary.max_rows}`);
  }

  const candidates = [];
  for (const model of [...plan.models].sort((left, right) => compareText(left.model_id, right.model_id))) {
    for (const partition of [...model.partitions].sort((left, right) => compareText(left.partition, right.partition))) {
      if (!partition.counts || partition.counts.total_ops === 0) continue;
      candidates.push({ model_id: model.model_id, partition: partition.partition, rows: partition.counts.total_ops });
    }
  }

  const selected = [];
  let rows = 0;
  for (const candidate of candidates) {
    if (selected.length >= boundPartitions) break;
    if (candidate.rows > boundRows) continue;
    if (selected.length > 0 && rows + candidate.rows > boundRows) continue;
    selected.push({ model_id: candidate.model_id, partition: candidate.partition });
    rows += candidate.rows;
  }

  if (candidates.length > 0 && selected.length === 0) {
    canaryFail(
      `no changed partition fits the canary policy (max_partitions=${policy.canary.max_partitions}, max_rows=${policy.canary.max_rows}); `
      + "shrink the release or widen the policy before publishing production-wide",
    );
  }

  return { selected, rows, candidate_count: candidates.length, truncated: candidates.length > selected.length };
}

function totalsForPartitions(partitions) {
  const totals = {
    insert: 0, update: 0, delete: 0, unchanged: 0, total_ops: 0,
    unchanged_partitions: 0, changed_partitions: 0, added_partitions: 0, removed_partitions: 0,
  };
  for (const partition of partitions) {
    for (const field of ["insert", "update", "delete", "unchanged", "total_ops"]) totals[field] += partition.counts[field];
    totals[`${partition.status}_partitions`] += 1;
  }
  return totals;
}

/** A delta plan reduced to exactly the selected (model_id, partition) pairs, same schema, ready for planBatches. */
export function scopedDeltaPlan(plan, selected) {
  const wanted = new Map();
  for (const { model_id, partition } of selected) {
    if (!wanted.has(model_id)) wanted.set(model_id, new Set());
    wanted.get(model_id).add(partition);
  }
  const models = plan.models
    .filter((model) => wanted.has(model.model_id))
    .map((model) => {
      const partitions = model.partitions.filter((partition) => wanted.get(model.model_id).has(partition.partition));
      return { ...model, partitions, totals: totalsForPartitions(partitions) };
    });
  return { ...plan, models };
}

/**
 * Compose the closed-shape canary evidence object. Status is always derived
 * here, never trusted from a caller, so a failing publish or a failing
 * verification can never be reported as "passed".
 */
export function buildCanaryEvidence({ generation, policy, scope, publishReceipt = null, verification = null, recordedAt = new Date().toISOString() }) {
  const findings = sortFindings(verification?.findings || []);
  const watermarks = verification?.watermarks || [];
  const representativeQueries = verification?.representativeQueries || [];

  const publishFailed = publishReceipt !== null && publishReceipt.status !== "complete";
  const invariantFailed = findings.length > 0
    || watermarks.some((watermark) => watermark.status === "mismatch")
    || representativeQueries.some((query) => query.status === "failed");
  const status = publishFailed || invariantFailed ? "failed" : "passed";
  const reason = publishFailed
    ? `canary publish did not complete: ${publishReceipt.status}`
    : invariantFailed
      ? "canary verification found an invariant mismatch"
      : "canary verification found no invariant mismatch";

  const base = {
    schema: D1_CANARY_EVIDENCE_SCHEMA,
    recorded_at: recordedAt,
    generation: generation ?? null,
    status,
    reason,
    policy: { max_partitions: policy.canary.max_partitions, max_rows: policy.canary.max_rows },
    scope: { candidate_count: scope.candidate_count, selected: scope.selected, rows: scope.rows, truncated: scope.truncated },
    publish_status: publishReceipt?.status ?? null,
    findings,
    findings_count: findings.length,
    watermarks,
    representative_queries: representativeQueries,
  };
  return { ...base, content_hash: sha256Hex(stableStringify(base)) };
}

/**
 * Run a canary: select a bounded partition set, apply it through the
 * existing bounded publisher against `adapter`, then verify. When nothing in
 * the plan changed, the canary trivially passes with an empty scope. Never
 * returns a receipt claiming the generation was accepted; that stays the
 * caller's decision, gated on evidence.status === "passed".
 */
export async function runCanary({
  plan, manifest, sourceDocuments, generation, policy,
  fenceStore, holder, fingerprint, executor, adapter,
  maxOpsPerBatch = DEFAULT_MAX_OPS_PER_BATCH, maxPartitions = null, maxRows = null,
  recordedAt = new Date().toISOString(),
}) {
  validateReleasePolicy(policy);
  const scope = selectCanaryScope({ plan, policy, maxPartitions, maxRows });

  if (scope.selected.length === 0) {
    return buildCanaryEvidence({ generation, policy, scope, publishReceipt: null, verification: null, recordedAt });
  }

  const canaryPlan = scopedDeltaPlan(plan, scope.selected);
  const batchPlan = planBatches({ plan: canaryPlan, manifest, sourceDocuments, generation, maxOpsPerBatch });
  const publishReceipt = await publishBounded({ batchPlan, manifest, fenceStore, holder, fingerprint, executor });

  if (publishReceipt.status !== "complete") {
    return buildCanaryEvidence({ generation, policy, scope, publishReceipt, verification: null, recordedAt });
  }

  const verification = await verifyPartitionScope({ manifest, sourceDocuments, adapter, selection: scope.selected });
  return buildCanaryEvidence({ generation, policy, scope, publishReceipt, verification, recordedAt });
}

/**
 * A flag with no following token, or one immediately followed by another
 * flag (e.g. `--remote --config path`, the shape a bare wrangler-style
 * boolean flag takes in .github/workflows/deploy-worker.yml), is a boolean
 * flag: it is recorded as `true` rather than swallowing the next flag's name
 * as its own value. Swallowing it is exactly the bug class that broke this
 * ladder's other CLIs on a bare `--remote` ahead of `--config`; parsing here
 * must not repeat it.
 */
export function parseArgs(argv) {
  const args = { command: argv[2] };
  for (let index = 3; index < argv.length; index += 1) {
    const flag = argv[index];
    if (!flag.startsWith("--")) canaryFail(`unknown argument ${flag}`);
    const name = flag.slice(2);
    const next = argv[index + 1];
    if (next === undefined || next.startsWith("--")) {
      args[name] = true;
    } else {
      args[name] = next;
      index += 1;
    }
  }
  return args;
}

function required(args, name) {
  if (args[name] === undefined || args[name] === "") canaryFail(`missing --${name}`);
  return args[name];
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
  if (args.command === "select") {
    const plan = JSON.parse(readFileSync(required(args, "plan"), "utf8"));
    const policy = loadReleasePolicy(args.policy || DEFAULT_RELEASE_POLICY_PATH);
    const scope = selectCanaryScope({
      plan, policy,
      maxPartitions: args["max-partitions"] ? Number(args["max-partitions"]) : null,
      maxRows: args["max-rows"] ? Number(args["max-rows"]) : null,
    });
    writeOutput(args.out, scope);
    return 0;
  }
  if (args.command === "check") {
    const evidence = JSON.parse(readFileSync(required(args, "evidence"), "utf8"));
    if (evidence.schema !== D1_CANARY_EVIDENCE_SCHEMA) canaryFail(`evidence has the wrong schema, expected ${D1_CANARY_EVIDENCE_SCHEMA}`);
    console.log(evidence.status === "passed" ? "d1_canary: passed" : `d1_canary: failed: ${evidence.reason}`);
    return evidence.status === "passed" ? 0 : 1;
  }
  console.error("d1_canary: usage: select --plan <deltaplan.json> [--policy <path>] [--max-partitions <n>] [--max-rows <n>] [--out <path>]"
    + " | check --evidence <path>");
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
