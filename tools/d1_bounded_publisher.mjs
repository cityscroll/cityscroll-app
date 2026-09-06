#!/usr/bin/env node

/**
 * Bounded, idempotent, resumable publication of a D1 delta plan (release-control
 * card d1-06).
 *
 * Today's publication path renders one opaque SQL file per model and applies it
 * in a single remote command; a transient failure partway through forces a full
 * rerun. This module splits a delta plan (tools/d1_delta_plan.mjs) into small,
 * deterministic batches and applies them one at a time, so a failure resumes
 * from a checkpoint instead of starting over.
 *
 * Three stages stay separate:
 *   plan     resolvePartitionOps/planBatches — pure. A delta plan plus the
 *            current keyed rows (tools/d1_stable_keys.mjs) becomes an ordered
 *            list of bounded batches. No I/O, no SQL text.
 *   render   renderBatch — SQL text for one batch, built from the same
 *            statement generators tools/build_worker_d1_read_models.mjs uses
 *            for the existing rebuild/upsert paths. Statement text is never
 *            duplicated here.
 *   execute  publishBounded — applies rendered batches through an injected
 *            executor, one batch per D1 transaction, settling the publication
 *            generation fence (tools/d1_generation_fence.mjs) before any write
 *            and re-checking it before every subsequent batch, and writing a
 *            checkpoint receipt after every committed one.
 *
 * Every operation is keyed (natural or companion identity, per the manifest),
 * so replaying an already-applied batch through the same upsert/delete
 * statements is a no-op. That is what makes a retried or resumed batch safe.
 *
 * A batch never splits a table's own delete-then-insert convergence pair (the
 * FTS5 companion's upsert rendering): that pair is generated from one op entry
 * and batches are chunked by op, never by rendered statement.
 *
 * This module accepts keyed delta plans and the staged "rebuild" plan produced
 * by tools/d1_explicit_rebuild.mjs. Rebuild batches retain the same fence,
 * checkpoint, retry, and receipt machinery; this module still never decides
 * that a rebuild is necessary.
 *
 * This publisher is off by default (see boundedPublisherEnabled). The ordinary
 * deploy workflow uses the upsert SQL path; the workflow_dispatch rebuild job
 * stages a plan for this publisher and does not directly execute SQL.
 *
 * Usage:
 *   node tools/d1_bounded_publisher.mjs plan --plan <deltaplan.json> --generation <n>
 *                                             [--max-ops <n>] [--out <path>]
 *   node tools/d1_bounded_publisher.mjs dry-run --plan <deltaplan.json> --generation <n>
 *                                                [--max-ops <n>] [--out <path>]
 *   node tools/d1_bounded_publisher.mjs execute --plan <deltaplan.json> --generation <n>
 *                                                --holder <h> --fingerprint <fp>
 *                                                --checkpoint <path> --database <name>
 *                                                [--config <path>] [--max-ops <n>]
 *                                                [--max-attempts <n>] [--backoff-ms <n>]
 *                                                [--state-file <path>] [--receipt <path>]
 *   node tools/d1_bounded_publisher.mjs rollback --checkpoint <path> --reason "<text>"
 */

import { execFile } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import { deleteOrder, deleteStatement, insertStatement, readSourceDocument, upsertStatements } from "./build_worker_d1_read_models.mjs";
import { PLAN_SCHEMA } from "./d1_delta_plan.mjs";
import { checkGenerationCommit, createWranglerKvStore, fileStore } from "./d1_generation_fence.mjs";
import { loadManifest, modelEntry } from "./d1_manifest.mjs";
import { VIRTUAL_TABLES, tableRows } from "./d1_stable_keys.mjs";

const execFileAsync = promisify(execFile);

export const D1_BOUNDED_PUBLISH_PLAN_SCHEMA = "cityscroll.d1-bounded-publish-plan.v1";
export const D1_BOUNDED_PUBLISH_DRYRUN_SCHEMA = "cityscroll.d1-bounded-publish-dry-run.v1";
export const D1_BOUNDED_PUBLISH_RECEIPT_SCHEMA = "cityscroll.d1-bounded-publish-receipt.v1";

export const DEFAULT_MAX_OPS_PER_BATCH = 500;
export const DEFAULT_MAX_ATTEMPTS = 4;
export const DEFAULT_BACKOFF_MS = 500;
export const FEATURE_FLAG_ENV = "D1_BOUNDED_PUBLISHER_ENABLED";

function fail(message) {
  throw new Error(`d1 bounded publisher: ${message}`);
}

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

/** Whether the bounded publisher is allowed to run. Default off; the rebuild/upsert SQL path is the fallback. */
export function boundedPublisherEnabled(env = process.env) {
  return env[FEATURE_FLAG_ENV] === "true";
}

export function batchId({ generation, modelId, partition, ordinal }) {
  return `${generation}:${modelId}:${partition}:${ordinal}`;
}

/**
 * One partition's changed rows as an ordered, keyed operation list: deletes
 * first (children before the parents they reference, matching the builder's
 * delete order), then inserts/updates (parents before children). Unchanged
 * partitions are omitted entirely.
 */
export function resolvePartitionOps(entry, planModel, currentRowsByKey) {
  const order = deleteOrder(entry);
  const rank = new Map(entry.tables.map((table, index) => [table.name, index]));
  const partitions = [];
  for (const partitionPlan of planModel.partitions) {
    if (!partitionPlan.counts || partitionPlan.counts.total_ops === 0) continue;
    const deletes = [...(partitionPlan.ops?.delete || [])]
      .sort((left, right) => order.indexOf(left.table) - order.indexOf(right.table) || compareText(left.key, right.key));
    const upserts = [...(partitionPlan.ops?.insert || []), ...(partitionPlan.ops?.update || [])]
      .sort((left, right) => (rank.get(left.table) ?? 0) - (rank.get(right.table) ?? 0) || compareText(left.key, right.key));

    const ops = [];
    for (const op of deletes) {
      if (!Array.isArray(op.key_values)) fail(`delete for ${entry.model_id} ${op.table} ${op.key} carries no key_values`);
      ops.push({ kind: "delete", table: op.table, key_values: op.key_values });
    }
    for (const op of upserts) {
      const row = currentRowsByKey.get(`${op.table}|${op.key}`);
      if (!row) fail(`no current row for ${entry.model_id} ${op.table} ${op.key}: plan and source document disagree`);
      ops.push({ kind: "upsert", table: op.table, key_values: row.key_values, columns: row.columns });
    }
    partitions.push({ partition: partitionPlan.partition, ops });
  }
  return partitions;
}

function estimatedWritesFor(op) {
  return op.kind === "upsert" && VIRTUAL_TABLES.has(op.table) ? 2 : 1;
}

/**
 * A delta plan plus the current keyed rows becomes a flat, deterministic list
 * of bounded batches (one D1 transaction each), with per-model summaries for
 * reporting. Pure: no I/O beyond reading the already-loaded source documents.
 */
export function planBatches({ plan, manifest, sourceDocuments, generation, maxOpsPerBatch = DEFAULT_MAX_OPS_PER_BATCH }) {
  if (!plan || plan.schema !== PLAN_SCHEMA) fail("plan is missing or has the wrong schema");
  if (!["delta", "rebuild"].includes(plan.operation)) fail(`bounded publisher accepts delta or rebuild plans only, got operation "${plan.operation}"`);
  if (!Number.isInteger(generation) || generation < 1) fail("generation must be a positive integer");
  if (!Number.isInteger(maxOpsPerBatch) || maxOpsPerBatch < 1) fail("maxOpsPerBatch must be a positive integer");

  const batches = [];
  const models = [];
  let totalOps = 0;
  let totalEstimatedWrites = 0;

  for (const planModel of plan.models) {
    const entry = modelEntry(manifest, planModel.model_id);
    const source = sourceDocuments[planModel.model_id];
    if (source === undefined) fail(`no source document for ${planModel.model_id}`);
    const currentRows = tableRows(entry, source).rows;
    const currentRowsByKey = new Map(currentRows.map((row) => [`${row.table}|${row.key}`, row]));
    const partitions = plan.operation === "rebuild"
      ? [{
          partition: "__model__",
          ops: [
            ...deleteOrder(entry).map((table) => ({ kind: "truncate", table })),
            ...currentRows.map((row) => ({ kind: "insert", table: row.table, key_values: row.key_values, columns: row.columns })),
          ],
        }]
      : resolvePartitionOps(entry, planModel, currentRowsByKey);

    let modelBatchCount = 0;
    let modelEstimatedWrites = 0;
    for (const { partition, ops } of partitions) {
      for (let start = 0, ordinal = 0; start < ops.length; start += maxOpsPerBatch, ordinal += 1) {
        const slice = ops.slice(start, start + maxOpsPerBatch);
        const estimatedWrites = slice.reduce((sum, op) => sum + estimatedWritesFor(op), 0);
        batches.push({
          batch_id: batchId({ generation, modelId: planModel.model_id, partition, ordinal }),
          model_id: planModel.model_id,
          partition,
          ordinal,
          ops: slice,
          op_count: slice.length,
          estimated_writes: estimatedWrites,
        });
        modelBatchCount += 1;
        modelEstimatedWrites += estimatedWrites;
        totalOps += slice.length;
        totalEstimatedWrites += estimatedWrites;
      }
    }
    models.push({
      model_id: planModel.model_id,
      delta_counts: planModel.totals || null,
      batch_count: modelBatchCount,
      estimated_writes: modelEstimatedWrites,
    });
  }

  return {
    schema: D1_BOUNDED_PUBLISH_PLAN_SCHEMA,
    manifest_fingerprint: plan.manifest_fingerprint,
    generation,
    max_ops_per_batch: maxOpsPerBatch,
    batches,
    models,
    summary: { total_batches: batches.length, total_ops: totalOps, total_estimated_writes: totalEstimatedWrites },
  };
}

/** SQL text for one batch, reusing the builder's own statement generators. */
export function renderBatch(entry, ops) {
  const lines = [];
  for (const op of ops) {
    if (op.kind === "truncate") {
      lines.push(`DELETE FROM ${op.table};`);
    } else if (op.kind === "delete") {
      lines.push(deleteStatement(entry, op.table, op.key_values));
    } else if (op.kind === "insert") {
      lines.push(insertStatement(entry, { table: op.table, key_values: op.key_values, columns: op.columns }));
    } else {
      lines.push(...upsertStatements(entry, { table: op.table, key_values: op.key_values, columns: op.columns }));
    }
  }
  lines.push("");
  return lines.join("\n");
}

/** A dry-run summary: model, generation, delta counts, batch count, and estimated writes — no execution. */
export function dryRunReport({ plan, batchPlan }) {
  return {
    schema: D1_BOUNDED_PUBLISH_DRYRUN_SCHEMA,
    generation: batchPlan.generation,
    manifest_fingerprint: plan.manifest_fingerprint,
    max_ops_per_batch: batchPlan.max_ops_per_batch,
    models: batchPlan.models,
    summary: batchPlan.summary,
  };
}

/** transient: retry with bounded backoff; permanent: stop the generation immediately. */
export function classifyFailure(error) {
  if (error && typeof error.transient === "boolean") return error.transient ? "transient" : "permanent";
  const text = `${error?.code || ""} ${error?.message || ""} ${error?.stderr || ""}`.toLowerCase();
  if (/(timeout|timed out|econnreset|econnrefused|etimedout|eai_again|429|too many requests|rate limit|5\d\d\b|service unavailable|internal server error|bad gateway|gateway timeout)/.test(text)) {
    return "transient";
  }
  return "permanent";
}

function loadCheckpoint(path) {
  if (!path || !existsSync(path)) return null;
  return JSON.parse(readFileSync(path, "utf8"));
}

function writeCheckpoint(path, receipt) {
  if (!path) return;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(receipt, null, 2)}\n`);
}

function initialReceipt({ generation, holder, fingerprint, manifestFingerprint, totalBatches }) {
  return {
    schema: D1_BOUNDED_PUBLISH_RECEIPT_SCHEMA,
    generation,
    holder,
    fingerprint,
    manifest_fingerprint: manifestFingerprint,
    total_batches: totalBatches,
    completed_batches: [],
    next_batch_id: null,
    status: "in_progress",
    fence: null,
    stopped_reason: null,
    rollback: null,
  };
}

/**
 * Record one fence decision on the receipt. A rejection is terminal for this
 * run and names the stale generation alongside the generation that now holds
 * the fence, so an overlap can be diagnosed from the receipt alone.
 */
function recordFenceRejection(receipt, boundary, batch) {
  const outcome = boundary.outcome || {};
  receipt.status = "stopped_fenced";
  receipt.fence = {
    ...outcome,
    batch_id: batch ? batch.batch_id : null,
    batches_applied: receipt.completed_batches.length,
  };
  receipt.stopped_reason = `generation ${receipt.generation} is fenced by generation ${outcome.current_generation ?? "unknown"}`
    + `${batch ? ` before batch ${batch.batch_id}` : " before any write"} (${outcome.reason || "fenced"})`;
  receipt.next_batch_id = batch ? batch.batch_id : receipt.next_batch_id;
  return receipt;
}

function resumeIndex(batches, receipt) {
  if (!receipt) return 0;
  const done = new Set(receipt.completed_batches.map((entry) => entry.batch_id));
  const index = batches.findIndex((batch) => !done.has(batch.batch_id));
  return index === -1 ? batches.length : index;
}

function sleep(ms) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

/**
 * Apply every batch of a bounded plan, one D1 transaction at a time, resuming
 * from an existing checkpoint at `checkpointPath` when one names this same
 * generation and manifest fingerprint. The generation fence is settled before
 * the first batch and re-checked before every subsequent one
 * (checkGenerationCommit); a fenced result stops without writing and leaves a
 * receipt naming the stale generation and the generation that fenced it. A
 * transient failure retries with bounded backoff and a bounded
 * attempt count; a permanent failure (or a transient one that exhausts its
 * attempts) stops the generation immediately, leaving the checkpoint naming
 * the first unfinished batch so a later call with the same arguments resumes
 * there.
 */
export async function publishBounded({
  batchPlan,
  manifest,
  fenceStore,
  holder,
  fingerprint,
  executor,
  checkpointPath = null,
  maxAttempts = DEFAULT_MAX_ATTEMPTS,
  backoffMs = DEFAULT_BACKOFF_MS,
  now = () => Date.now(),
  wait = sleep,
}) {
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1) fail("maxAttempts must be a positive integer");
  if (!Number.isInteger(backoffMs) || backoffMs < 0) fail("backoffMs must be a non-negative integer");

  let receipt = loadCheckpoint(checkpointPath);
  if (receipt) {
    if (receipt.generation !== batchPlan.generation || receipt.manifest_fingerprint !== batchPlan.manifest_fingerprint) {
      fail("checkpoint names a different generation or manifest fingerprint; discard it before retrying under a new generation");
    }
  } else {
    receipt = initialReceipt({
      generation: batchPlan.generation, holder, fingerprint,
      manifestFingerprint: batchPlan.manifest_fingerprint, totalBatches: batchPlan.batches.length,
    });
  }
  if (receipt.status === "complete") return receipt;

  // The fence is settled once before any batch is rendered or executed, so a
  // stale generation is rejected without a single visible mutation — including
  // when its plan is empty or its checkpoint would otherwise resume mid-way.
  const gate = await checkGenerationCommit({ store: fenceStore, generation: batchPlan.generation, holder, fingerprint });
  if (gate.fenced) {
    recordFenceRejection(receipt, gate, batchPlan.batches[resumeIndex(batchPlan.batches, receipt)] || null);
    writeCheckpoint(checkpointPath, receipt);
    return receipt;
  }
  receipt.fence = gate.outcome || null;

  const entryCache = new Map();
  const startIndex = resumeIndex(batchPlan.batches, receipt);
  for (let index = startIndex; index < batchPlan.batches.length; index += 1) {
    const batch = batchPlan.batches[index];

    // A long publication re-checks the fence between batches: a generation that
    // is superseded partway through stops here rather than continuing to write.
    const boundary = await checkGenerationCommit({ store: fenceStore, generation: batchPlan.generation, holder, fingerprint });
    if (boundary.fenced) {
      recordFenceRejection(receipt, boundary, batch);
      writeCheckpoint(checkpointPath, receipt);
      return receipt;
    }

    if (!entryCache.has(batch.model_id)) entryCache.set(batch.model_id, modelEntry(manifest, batch.model_id));
    const entry = entryCache.get(batch.model_id);
    const sql = renderBatch(entry, batch.ops);

    const startedAt = new Date(now()).toISOString();
    let attempt = 0;
    let applied = false;
    while (!applied) {
      attempt += 1;
      try {
        await executor.execute(sql, batch);
        applied = true;
      } catch (error) {
        const classification = classifyFailure(error);
        if (classification === "permanent" || attempt >= maxAttempts) {
          receipt.status = "stopped_permanent_error";
          receipt.stopped_reason = `${classification} error on attempt ${attempt} of batch ${batch.batch_id}: ${error?.message || error}`;
          receipt.next_batch_id = batch.batch_id;
          writeCheckpoint(checkpointPath, receipt);
          return receipt;
        }
        await wait(backoffMs * 2 ** (attempt - 1));
      }
    }

    receipt.completed_batches.push({
      batch_id: batch.batch_id, model_id: batch.model_id, partition: batch.partition, ordinal: batch.ordinal,
      ops_applied: batch.op_count, attempt, started_at: startedAt, finished_at: new Date(now()).toISOString(),
    });
    receipt.next_batch_id = index + 1 < batchPlan.batches.length ? batchPlan.batches[index + 1].batch_id : null;
    writeCheckpoint(checkpointPath, receipt);
  }

  receipt.status = "complete";
  receipt.next_batch_id = null;
  writeCheckpoint(checkpointPath, receipt);
  return receipt;
}

/** Record an operator-visible rollback reason on the checkpoint receipt (flag off + rebuild is the actual rollback). */
export function recordRollback({ checkpointPath, reason, now = () => Date.now() }) {
  if (!reason || !String(reason).trim()) fail("rollback needs a non-empty reason");
  const receipt = loadCheckpoint(checkpointPath) || {
    schema: D1_BOUNDED_PUBLISH_RECEIPT_SCHEMA, generation: null, holder: null, fingerprint: null,
    manifest_fingerprint: null, total_batches: 0, completed_batches: [], next_batch_id: null,
    status: "rolled_back", fence: null, stopped_reason: null, rollback: null,
  };
  receipt.rollback = { at: new Date(now()).toISOString(), reason: String(reason).trim() };
  writeCheckpoint(checkpointPath, receipt);
  return receipt;
}

/** Thin adapter: one wrangler d1 execute invocation per batch, each batch its own file and its own remote transaction. */
export function createWranglerD1Executor({
  database,
  config = "worker/wrangler.toml",
  remote = true,
  wranglerVersion = "4.126.0",
  run = null,
} = {}) {
  if (!database) fail("createWranglerD1Executor requires a database name");
  const invoke = run || (async (args) => execFileAsync("npx", [`wrangler@${wranglerVersion}`, ...args], { encoding: "utf8" }));
  return {
    async execute(sql) {
      const dir = mkdtempSync(join(tmpdir(), "d1-bounded-batch-"));
      const file = join(dir, "batch.sql");
      writeFileSync(file, sql);
      try {
        await invoke(["d1", "execute", database, ...(remote ? ["--remote"] : []), "--yes", "--file", file, "--config", config]);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  };
}

function parseArgs(argv) {
  const args = { command: argv[2] };
  for (let index = 3; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!argument.startsWith("--")) fail(`unknown argument ${argument}`);
    args[argument.slice(2)] = argv[++index];
  }
  return args;
}

function required(args, name) {
  if (!args[name]) fail(`missing --${name}`);
  return args[name];
}

function writeOutput(path, value) {
  const text = `${JSON.stringify(value, null, 2)}\n`;
  if (!path) { process.stdout.write(text); return; }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}

function loadSourceDocuments(manifest) {
  const sources = {};
  for (const entry of manifest.models) sources[entry.model_id] = readSourceDocument(entry);
  return sources;
}

function storeFromArgs(args) {
  if (args["state-file"]) return fileStore(args["state-file"]);
  return createWranglerKvStore({
    key: args.key, binding: args.binding || "ALERT_STATE", config: args.config || "worker/wrangler.toml",
    remote: args.remote !== "false", wranglerVersion: args["wrangler-version"] || "4.126.0",
  });
}

async function main(argv) {
  const args = parseArgs(argv);
  if (args.command === "plan" || args.command === "dry-run") {
    const plan = JSON.parse(readFileSync(required(args, "plan"), "utf8"));
    const manifest = loadManifest();
    const batchPlan = planBatches({
      plan, manifest, sourceDocuments: loadSourceDocuments(manifest),
      generation: Number(required(args, "generation")),
      maxOpsPerBatch: args["max-ops"] ? Number(args["max-ops"]) : DEFAULT_MAX_OPS_PER_BATCH,
    });
    writeOutput(args.out, args.command === "dry-run" ? dryRunReport({ plan, batchPlan }) : batchPlan);
    return 0;
  }
  if (args.command === "execute") {
    if (!boundedPublisherEnabled()) {
      console.error(`d1 bounded publisher: refused, ${FEATURE_FLAG_ENV} is not "true"; use the rebuild/upsert SQL path instead`);
      return 1;
    }
    const plan = JSON.parse(readFileSync(required(args, "plan"), "utf8"));
    const manifest = loadManifest();
    const generation = Number(required(args, "generation"));
    const batchPlan = planBatches({
      plan, manifest, sourceDocuments: loadSourceDocuments(manifest), generation,
      maxOpsPerBatch: args["max-ops"] ? Number(args["max-ops"]) : DEFAULT_MAX_OPS_PER_BATCH,
    });
    const receipt = await publishBounded({
      batchPlan, manifest, fenceStore: storeFromArgs(args),
      holder: required(args, "holder"), fingerprint: required(args, "fingerprint"),
      executor: createWranglerD1Executor({ database: required(args, "database"), config: args.config || "worker/wrangler.toml" }),
      checkpointPath: required(args, "checkpoint"),
      maxAttempts: args["max-attempts"] ? Number(args["max-attempts"]) : DEFAULT_MAX_ATTEMPTS,
      backoffMs: args["backoff-ms"] ? Number(args["backoff-ms"]) : DEFAULT_BACKOFF_MS,
    });
    writeOutput(args.receipt, receipt);
    return receipt.status === "complete" ? 0 : 1;
  }
  if (args.command === "rollback") {
    const receipt = recordRollback({ checkpointPath: required(args, "checkpoint"), reason: required(args, "reason") });
    writeOutput(args.receipt, receipt);
    return 0;
  }
  console.error("d1_bounded_publisher: usage: plan | dry-run | execute | rollback (see file header)");
  return 2;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv).then((code) => { process.exitCode = code; }).catch((error) => {
    console.error(error?.stack || error);
    process.exitCode = 1;
  });
}
