#!/usr/bin/env node

/**
 * Bounded reconcile of an accepted D1 publication generation, without
 * rebuilding (release-control card d1-08).
 *
 * Canary (tools/d1_canary.mjs) proves a small applied slice matches
 * expectations before a production-wide publication. This module is the
 * complement: after a generation has been accepted, it re-checks a bounded
 * partition set of the CURRENT source-derived expectations against the
 * target, reusing the same comparison engine canary uses
 * (verifyPartitionScope), and classifies every finding as missing,
 * duplicate, stale (content differs from what the source currently
 * derives), or unexpected (a target row with no matching source identity).
 *
 * The report is deterministic and schema-versioned, carries a content hash,
 * and an overall `consistent` flag that is false on any finding, any
 * watermark mismatch, any failed representative query, or a truncated scan.
 * A mismatch can never be reported as success, and a bounded/partial run is
 * reported as truncated rather than silently passed off as complete.
 *
 * Usage:
 *   node tools/d1_reconcile.mjs select [--policy <path>] [--max-partitions <n>] [--max-rows <n>] [--out <path>]
 */

import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  DEFAULT_RELEASE_POLICY_PATH,
  D1_RELEASE_POLICY_SCHEMA,
  loadReleasePolicy,
  sha256Hex,
  sortFindings,
  stableStringify,
  validateReleasePolicy,
  verifyPartitionScope,
} from "./d1_canary.mjs";
import { loadManifest } from "./d1_manifest.mjs";
import { tableRows } from "./d1_stable_keys.mjs";
import { readSourceDocument } from "./build_worker_d1_read_models.mjs";

export { D1_RELEASE_POLICY_SCHEMA, DEFAULT_RELEASE_POLICY_PATH, loadReleasePolicy, validateReleasePolicy };

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export const D1_RECONCILE_REPORT_SCHEMA = "cityscroll.d1-reconcile-report.v1";

export class D1ReconcileError extends Error {
  constructor(detail) {
    super(`d1 reconcile: ${detail}`);
    this.name = "D1ReconcileError";
  }
}

function fail(detail) {
  throw new D1ReconcileError(detail);
}

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

/**
 * Select a bounded (model_id, partition) scope across every currently
 * published model — reconcile audits the live source-derived expectations,
 * not just what a delta plan recently changed. Greedy accept in
 * (model_id, partition) order while staying within the reconcile policy;
 * a partition too large to fit alone is skipped, and the scope reports
 * `truncated: true` whenever a candidate had to be left out.
 */
export function selectReconcileScope({ manifest, sourceDocuments, policy, maxPartitions = null, maxRows = null }) {
  const boundPartitions = maxPartitions ?? policy.reconcile.max_partitions;
  const boundRows = maxRows ?? policy.reconcile.max_rows;
  if (boundPartitions > policy.reconcile.max_partitions) {
    fail(`requested reconcile scope of ${boundPartitions} partitions exceeds the policy maximum of ${policy.reconcile.max_partitions}`);
  }
  if (boundRows > policy.reconcile.max_rows) {
    fail(`requested reconcile scope of ${boundRows} rows exceeds the policy maximum of ${policy.reconcile.max_rows}`);
  }

  const candidates = [];
  for (const entry of [...manifest.models].sort((left, right) => compareText(left.model_id, right.model_id))) {
    const sourceDocument = sourceDocuments[entry.model_id];
    const { rows } = tableRows(entry, sourceDocument);
    const byPartition = new Map();
    for (const row of rows) byPartition.set(row.partition, (byPartition.get(row.partition) || 0) + 1);
    for (const partition of [...byPartition.keys()].sort(compareText)) {
      candidates.push({ model_id: entry.model_id, partition, rows: byPartition.get(partition) });
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

  return { selected, rows, candidate_count: candidates.length, truncated: candidates.length > selected.length };
}

function countByClassification(findings) {
  const counts = { missing: 0, duplicate: 0, stale: 0, unexpected: 0 };
  for (const finding of findings) counts[finding.classification] = (counts[finding.classification] || 0) + 1;
  return counts;
}

/**
 * Compose the closed-shape reconcile report. `consistent` is derived here,
 * never trusted from a caller: it is false whenever there is a finding, a
 * watermark mismatch, a failed representative query, or the scan was
 * truncated by policy or the abort threshold.
 */
export function buildReconcileReport({ generation, policy, scope, verification, truncated, recordedAt = new Date().toISOString() }) {
  const findings = sortFindings(verification.findings);
  const watermarks = verification.watermarks;
  const representativeQueries = verification.representativeQueries;
  const hasIssue = findings.length > 0
    || watermarks.some((watermark) => watermark.status === "mismatch")
    || representativeQueries.some((query) => query.status === "failed");
  const isTruncated = Boolean(truncated);

  const base = {
    schema: D1_RECONCILE_REPORT_SCHEMA,
    recorded_at: recordedAt,
    generation: generation ?? null,
    policy: {
      max_partitions: policy.reconcile.max_partitions,
      max_rows: policy.reconcile.max_rows,
      max_findings: policy.abort_threshold.max_findings,
    },
    scope: { candidate_count: scope.candidate_count, selected: scope.selected, rows: scope.rows },
    truncated: isTruncated,
    findings,
    findings_count: findings.length,
    findings_by_classification: countByClassification(findings),
    watermarks,
    representative_queries: representativeQueries,
    consistent: !hasIssue && !isTruncated,
  };
  return { ...base, content_hash: sha256Hex(stableStringify(base)) };
}

/**
 * Run a bounded reconcile: select scope, then verify partitions one at a
 * time, stopping (and marking the report truncated) once accumulated
 * findings reach the policy's abort threshold — a badly broken generation
 * never turns reconcile into an unbounded scan.
 */
export async function runReconcile({
  manifest, sourceDocuments, adapter, policy, generation,
  maxPartitions = null, maxRows = null, recordedAt = new Date().toISOString(),
}) {
  validateReleasePolicy(policy);
  const scope = selectReconcileScope({ manifest, sourceDocuments, policy, maxPartitions, maxRows });

  const findings = [];
  const watermarks = [];
  const representativeQueries = [];
  let abortedEarly = false;

  for (const item of scope.selected) {
    if (findings.length >= policy.abort_threshold.max_findings) {
      abortedEarly = true;
      break;
    }
    const partial = await verifyPartitionScope({ manifest, sourceDocuments, adapter, selection: [item] });
    findings.push(...partial.findings);
    watermarks.push(...partial.watermarks);
    representativeQueries.push(...partial.representativeQueries);
  }

  return buildReconcileReport({
    generation, policy, scope,
    verification: { findings, watermarks, representativeQueries },
    truncated: scope.truncated || abortedEarly,
    recordedAt,
  });
}

function parseArgs(argv) {
  const args = { command: argv[2] };
  for (let index = 3; index < argv.length; index += 1) {
    const flag = argv[index];
    if (!flag.startsWith("--")) fail(`unknown argument ${flag}`);
    args[flag.slice(2)] = argv[++index];
  }
  return args;
}

function required(args, name) {
  if (args[name] === undefined || args[name] === "") fail(`missing --${name}`);
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

function loadSourceDocuments(manifest) {
  const sources = {};
  for (const entry of manifest.models) sources[entry.model_id] = readSourceDocument(entry, ROOT);
  return sources;
}

async function main(argv) {
  const args = parseArgs(argv);
  if (args.command === "select") {
    const manifest = loadManifest();
    const policy = loadReleasePolicy(args.policy || DEFAULT_RELEASE_POLICY_PATH);
    const scope = selectReconcileScope({
      manifest, sourceDocuments: loadSourceDocuments(manifest), policy,
      maxPartitions: args["max-partitions"] ? Number(args["max-partitions"]) : null,
      maxRows: args["max-rows"] ? Number(args["max-rows"]) : null,
    });
    writeOutput(args.out, scope);
    return 0;
  }
  if (args.command === "check") {
    const report = JSON.parse(readFileSync(required(args, "report"), "utf8"));
    if (report.schema !== D1_RECONCILE_REPORT_SCHEMA) fail(`report has the wrong schema, expected ${D1_RECONCILE_REPORT_SCHEMA}`);
    console.log(report.consistent
      ? "d1_reconcile: consistent"
      : `d1_reconcile: inconsistent (findings=${report.findings_count}, truncated=${report.truncated})`);
    return report.consistent ? 0 : 1;
  }
  console.error("d1_reconcile: usage: select [--policy <path>] [--max-partitions <n>] [--max-rows <n>] [--out <path>]"
    + " | check --report <path>");
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
