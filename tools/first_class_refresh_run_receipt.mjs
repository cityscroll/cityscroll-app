#!/usr/bin/env node
// Combine the acquisition/builder receipt, the read-model rebuild receipt, and
// the working tree's pending changes into one per-dataset accounting, then
// retain that run in the repository so a scheduled refresh stays countable
// after its pull request merges.
//
// Neither receipt alone answers the question a person or a reliability
// watchdog actually asks after a scheduled run: for this one dataset, was it
// due, did its acquisition and owning builder succeed, did the rebuild steps
// that feed it succeed, and is it about to be published? A dataset can refresh
// cleanly and still not publish because nothing about it changed; a different
// dataset can refresh cleanly and still not publish because an unrelated
// rebuild step failed. Those two outcomes look identical from either receipt
// alone and are the whole point of this file: an idempotent run that
// refreshed nothing must be distinguishable from a run that refreshed
// something it could not publish.
//
// The combined receipt used to live only under .artifacts/ and as an expiring
// workflow artifact. A merged refresh pull request then carried fresher data
// with no retained record of the run id or whether the cron or a manual
// dispatch produced it. This tool now also writes an append-only history at
// site/data/first_class_refresh_run_history.json (inside the refresh PR),
// naming the run, its trigger, and its start and finish times, and keeping
// prior runs instead of replacing them. A later same-day force-update of the
// dated refresh branch must still see any unmerged tip receipt (--pending-
// receipt); otherwise prior_runs would record only whichever run finished
// last.
//
// Run after the rebuild step and before the commit that opens the pull
// request, so "published" reflects the working tree the commit is about to
// stage rather than a later, less certain read of git history.
//
// Usage:
//   node tools/first_class_refresh_run_receipt.mjs [--pending-receipt <path>]...

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { readRegistry as readRebuildRegistry } from "../ops/first-class-refresh/rebuild-committed-read-models.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Per-run combined accounting (also mirrored under .artifacts/ for the workflow summary). */
export const RUN_RECEIPT_SCHEMA = "cityscroll.first_class_refresh_run_receipt.v1";
/** Append-only retained history committed inside the refresh pull request. */
export const RUN_HISTORY_SCHEMA = "cityscroll.first_class_refresh_run_history.v1";

export const FIRST_CLASS_REFRESH_RUN_HISTORY = Object.freeze({
  workflow: ".github/workflows/first-class-refresh.yml",
  history_path: "site/data/first_class_refresh_run_history.json",
  artifact_receipt_path: ".artifacts/first-class-refresh-run-receipt.json",
  branch_prefix: "data/first-class-refresh-",
  ledger_limit: 60,
});

const RUN_RECEIPT_PATH = FIRST_CLASS_REFRESH_RUN_HISTORY.artifact_receipt_path;
const RUN_HISTORY_PATH = FIRST_CLASS_REFRESH_RUN_HISTORY.history_path;
const REFRESH_RECEIPT_PATH = ".artifacts/first-class-refresh-receipt.json";
const REBUILD_RECEIPT_PATH = ".artifacts/first-class-rebuild-receipt.json";
const CONTRACTS_PATH = "site/data/source_contracts.json";

function readJson(path) {
  return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : null;
}

function serialize(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

export function receiptSha256(text) {
  return `sha256:${createHash("sha256").update(String(text), "utf8").digest("hex")}`;
}

/**
 * Every path the working tree currently reports as changed, tracked or new.
 * A checkout that is not a git working tree (or that this fails to read)
 * returns null so a caller can tell "nothing changed" apart from "could not
 * be measured", rather than treating them the same.
 */
export function changedPaths(root) {
  const result = spawnSync("git", ["status", "--porcelain=v1", "-z", "--untracked-files=all"], { cwd: root, encoding: "utf8" });
  if (result.error || result.status !== 0) return null;
  const fields = result.stdout.split("\0");
  const files = [];
  for (let index = 0; index < fields.length; index += 1) {
    const record = fields[index];
    if (!record) continue;
    files.push(record.slice(3));
    if (record[0] === "R" || record[0] === "C") index += 1;
  }
  return files;
}

function commandsFor(refreshReceipt, artifact) {
  return (refreshReceipt?.commands || []).filter((row) => row.artifact_paths?.includes(artifact.public_artifact_path));
}

function statusOfKind(commands, kind) {
  return commands.find((command) => command.kind === kind)?.status || null;
}

/** Rebuild-step status, keyed by every builder path a step declares it covers. */
export function builderStatusMap(rebuildRegistry, rebuildReceipt) {
  const statusById = new Map((rebuildReceipt?.steps || []).map((row) => [row.id, row.status]));
  const map = new Map();
  for (const step of rebuildRegistry?.rebuild_sequence || []) {
    const status = statusById.get(step.id) || "not_run";
    for (const builder of step.covers || []) map.set(builder, status);
  }
  return map;
}

export function rebuildStatusFor(artifact, builderStatus) {
  const relevant = [artifact.owning_builder, ...(artifact.dependent_materializers || [])]
    .map((builder) => builderStatus.get(builder))
    .filter(Boolean);
  // Warehouse-backed and other builders the hosted rebuild registry does not
  // cover at all: this dataset's correctness does not depend on that sequence.
  if (!relevant.length) return "not_applicable";
  if (relevant.some((status) => status === "failed")) return "failed";
  if (relevant.some((status) => status === "skipped")) return "skipped";
  if (relevant.every((status) => status === "succeeded")) return "succeeded";
  return "not_run";
}

/**
 * Identify this refresh from the Actions environment (or as a local run).
 * `trigger` is the event name that started the job: `schedule` for the cron,
 * `workflow_dispatch` for a manual run, or `local` outside Actions.
 */
export function runIdentityFromEnv(env = process.env, { finishedAt, startedAt, codeRevision = null } = {}) {
  const githubRunId = /^\d+$/.test(env.GITHUB_RUN_ID || "") ? Number(env.GITHUB_RUN_ID) : null;
  const finished = finishedAt || new Date().toISOString();
  const started = startedAt || env.FIRST_CLASS_REFRESH_STARTED_AT || finished;
  return {
    run_id: githubRunId
      ? `github-actions:${githubRunId}:${env.GITHUB_RUN_ATTEMPT || "1"}`
      : `local:${finished}`,
    github_run_id: githubRunId,
    run_url: githubRunId && env.GITHUB_SERVER_URL && env.GITHUB_REPOSITORY
      ? `${env.GITHUB_SERVER_URL}/${env.GITHUB_REPOSITORY}/actions/runs/${githubRunId}`
      : null,
    trigger: env.GITHUB_EVENT_NAME || "local",
    started_at: started,
    finished_at: finished,
    code_revision: codeRevision || env.GITHUB_SHA || null,
  };
}

/** Slim ledger row kept for each prior run. */
export function ledgerEntry(receipt, digest) {
  const run = receipt?.run || {};
  return {
    run_id: run.run_id ?? null,
    trigger: run.trigger ?? null,
    started_at: run.started_at ?? null,
    finished_at: run.finished_at ?? receipt?.generated_at ?? null,
    due_count: receipt?.due_count ?? null,
    published_count: receipt?.published_count ?? null,
    receipt_sha256: digest,
  };
}

/** Newest-first ledger of a receipt's own run plus every prior entry it kept. */
export function ledgerHistoryOf(receipt, digest) {
  if (!receipt?.run?.run_id) return [];
  return [ledgerEntry(receipt, digest), ...(Array.isArray(receipt.prior_runs) ? receipt.prior_runs : [])];
}

/**
 * Merge newest-first histories by run_id. The first occurrence of each id wins
 * so callers can put an unmerged dated-branch tip ahead of main.
 */
export function mergePriorRunHistories(...histories) {
  const byId = new Map();
  for (const history of histories) {
    for (const entry of history || []) {
      if (!entry?.run_id || byId.has(entry.run_id)) continue;
      byId.set(entry.run_id, entry);
    }
  }
  return [...byId.values()].sort((left, right) => (
    String(right.started_at || "").localeCompare(String(left.started_at || ""))
  ));
}

/** Entries present in `retained` whose run_id is absent from `proposed`. */
export function priorRunsDropped(retained, proposed) {
  const proposedIds = new Set((proposed || []).map((entry) => entry?.run_id).filter(Boolean));
  return (retained || []).filter((entry) => entry?.run_id && !proposedIds.has(entry.run_id));
}

/**
 * Positive control for append-only history: within the ledger window, every
 * retained run_id must appear in the proposed ledger. A drop fails the run
 * instead of publishing a quieter history.
 */
export function assertPriorRunsAppendOnly(retained, proposed, {
  limit = FIRST_CLASS_REFRESH_RUN_HISTORY.ledger_limit,
} = {}) {
  const mustKeep = mergePriorRunHistories(retained).slice(0, limit);
  const dropped = priorRunsDropped(mustKeep, proposed);
  if (!dropped.length) return;
  const names = dropped
    .map((entry) => `${entry.run_id} (${entry.trigger || "unknown"}, ${entry.started_at || "no-time"})`)
    .join("; ");
  throw new Error(`first-class refresh run history would drop retained run(s): ${names}`);
}

/**
 * Build prior_runs from the committed history and any still-unmerged dated
 * refresh-branch tips. Append-only within the ledger window.
 */
export function buildPriorRunsLedger({
  committedPrevious = null,
  committedDigest = null,
  pendingReceipts = [],
  limit = FIRST_CLASS_REFRESH_RUN_HISTORY.ledger_limit,
} = {}) {
  const retained = mergePriorRunHistories(
    ...pendingReceipts.map((entry) => ledgerHistoryOf(entry.receipt, entry.digest)),
    committedPrevious ? ledgerHistoryOf(committedPrevious, committedDigest) : [],
  );
  const priorRuns = retained.slice(0, limit);
  assertPriorRunsAppendOnly(retained, priorRuns, { limit });
  return priorRuns;
}

/** Parse a pending/unmerged history file into `{ receipt, digest }`. */
export function loadPendingRunHistory(text) {
  const receipt = JSON.parse(text);
  const schema = receipt?.schema;
  if (schema !== RUN_HISTORY_SCHEMA && schema !== RUN_RECEIPT_SCHEMA) {
    throw new Error("pending refresh receipt is not a first-class refresh run history");
  }
  if (!receipt.run?.run_id) throw new Error("pending refresh receipt names no run_id");
  if (!receipt.run?.trigger) throw new Error("pending refresh receipt names no trigger");
  return { receipt, digest: receiptSha256(text) };
}

/**
 * The workflow must retain the history inside the refresh pull request and
 * carry any unmerged dated-branch tip into the next run.
 */
export function checkFirstClassRefreshRunHistoryDeclaration(text, declaration = FIRST_CLASS_REFRESH_RUN_HISTORY) {
  const errors = [];
  if (!text.includes(declaration.history_path)) {
    errors.push(`the workflow does not name the retained history path ${declaration.history_path}`);
  }
  if (!text.includes("--pending-receipt") || !text.includes(declaration.branch_prefix)) {
    errors.push("the workflow does not carry an unmerged dated-branch receipt into the next run");
  }
  if (!/workflow_dispatch:/.test(text)) {
    errors.push("the workflow cannot be started by hand (needed as a positive control for trigger retention)");
  }
  if (!/schedule:/.test(text) || !/cron:/.test(text)) {
    errors.push("the workflow declares no schedule");
  }
  return { valid: errors.length === 0, errors };
}

export function buildRunReceipt({
  registry,
  refreshReceipt,
  rebuildRegistry,
  rebuildReceipt,
  changed,
  now,
  run = null,
  priorRuns = [],
  schema = RUN_HISTORY_SCHEMA,
}) {
  const builderStatus = builderStatusMap(rebuildRegistry, rebuildReceipt);
  const datasets = (registry?.first_class_artifacts || []).map((artifact) => {
    const commands = commandsFor(refreshReceipt, artifact);
    const due = commands.length > 0;
    return {
      id: artifact.id,
      public_artifact_path: artifact.public_artifact_path,
      due,
      acquisition_status: due ? (statusOfKind(commands, "acquisition") || "not_applicable") : "not_due",
      builder_status: due ? (statusOfKind(commands, "owning-builder") || "not_applicable") : "not_due",
      rebuild_status: rebuildStatusFor(artifact, builderStatus),
      published: changed == null ? null : changed.includes(artifact.public_artifact_path),
    };
  }).sort((left, right) => left.public_artifact_path.localeCompare(right.public_artifact_path));
  const finishedAt = run?.finished_at || now;
  const identity = run || {
    run_id: `local:${finishedAt}`,
    github_run_id: null,
    run_url: null,
    trigger: "local",
    started_at: now,
    finished_at: finishedAt,
    code_revision: null,
  };
  return {
    schema,
    generated_at: finishedAt,
    run: identity,
    total: datasets.length,
    due_count: datasets.filter((row) => row.due).length,
    published_count: datasets.filter((row) => row.published).length,
    datasets,
    prior_runs: priorRuns,
  };
}

function pendingReceiptPaths(argv) {
  const paths = [];
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] !== "--pending-receipt") continue;
    const path = argv[index + 1];
    if (!path || path.startsWith("--")) {
      throw new Error("--pending-receipt needs a receipt path");
    }
    paths.push(path);
    index += 1;
  }
  return paths;
}

function codeRevision(root) {
  const result = spawnSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" });
  return result.status === 0 ? result.stdout.trim() : null;
}

function main(argv = process.argv.slice(2)) {
  const registry = readJson(join(ROOT, CONTRACTS_PATH));
  if (!registry) throw new Error(`missing ${CONTRACTS_PATH}`);

  const pendingReceipts = pendingReceiptPaths(argv).map((path) => {
    const absolute = resolve(path);
    if (!existsSync(absolute)) throw new Error(`pending refresh receipt is missing: ${path}`);
    return loadPendingRunHistory(readFileSync(absolute, "utf8"));
  });

  const historyPath = join(ROOT, RUN_HISTORY_PATH);
  const committedText = existsSync(historyPath) ? readFileSync(historyPath, "utf8") : null;
  const committedPrevious = committedText ? JSON.parse(committedText) : null;
  const committedDigest = committedText ? receiptSha256(committedText) : null;
  if (committedPrevious && committedPrevious.schema !== RUN_HISTORY_SCHEMA && committedPrevious.schema !== RUN_RECEIPT_SCHEMA) {
    throw new Error(`committed refresh history at ${RUN_HISTORY_PATH} has an unexpected schema`);
  }

  const finishedAt = new Date().toISOString();
  const run = runIdentityFromEnv(process.env, {
    finishedAt,
    startedAt: process.env.FIRST_CLASS_REFRESH_STARTED_AT || null,
    codeRevision: codeRevision(ROOT),
  });
  const priorRuns = buildPriorRunsLedger({
    committedPrevious,
    committedDigest,
    pendingReceipts,
  });

  const receipt = buildRunReceipt({
    registry,
    refreshReceipt: readJson(join(ROOT, REFRESH_RECEIPT_PATH)),
    rebuildRegistry: readRebuildRegistry(ROOT),
    rebuildReceipt: readJson(join(ROOT, REBUILD_RECEIPT_PATH)),
    changed: changedPaths(ROOT),
    now: finishedAt,
    run,
    priorRuns,
    schema: RUN_HISTORY_SCHEMA,
  });

  const text = serialize(receipt);
  const historyOut = join(ROOT, RUN_HISTORY_PATH);
  mkdirSync(dirname(historyOut), { recursive: true });
  writeFileSync(historyOut, text);

  // Keep the workflow summary and the upload-artifact step on their existing
  // path while the pull request carries the retained history.
  const artifactOut = join(ROOT, RUN_RECEIPT_PATH);
  mkdirSync(dirname(artifactOut), { recursive: true });
  writeFileSync(artifactOut, text);

  console.log(
    `wrote ${RUN_HISTORY_PATH} and ${RUN_RECEIPT_PATH}: ` +
      `run ${receipt.run.run_id} (${receipt.run.trigger}), ` +
      `${receipt.due_count} due, ${receipt.published_count} publishing, ` +
      `${receipt.total} declared, ${receipt.prior_runs.length} prior`,
  );
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main();
}
