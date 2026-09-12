#!/usr/bin/env node

/**
 * The ordinary production D1 delta-publication transaction.
 *
 * This composes the existing partition planner, generation fence, bounded
 * publisher, canary, reconciliation, and receipt inputs without introducing a
 * rebuild fallback. A missing or incompatible prior snapshot is a refusal from
 * d1_delta_plan; only the separate explicit-rebuild workflow may establish a
 * new baseline.
 */

import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import { readSourceDocument, sqlLiteral } from "./build_worker_d1_read_models.mjs";
import {
  DEFAULT_MAX_OPS_PER_BATCH,
  D1_BOUNDED_PUBLISH_RECEIPT_SCHEMA,
  planBatches,
  publishBounded,
} from "./d1_bounded_publisher.mjs";
import {
  buildCanaryEvidence,
  loadReleasePolicy,
  scopedDeltaPlan,
  selectCanaryScope,
  verifyPartitionScope,
} from "./d1_canary.mjs";
import { PLAN_SCHEMA, SNAPSHOT_SCHEMA, planDelta } from "./d1_delta_plan.mjs";
import { D1_GENERATION_FENCE_SCHEMA, createFileLedger, createWranglerKvStore } from "./d1_generation_fence.mjs";
import { loadManifest } from "./d1_manifest.mjs";
import { buildReconcileReport } from "./d1_reconcile.mjs";

const execFileAsync = promisify(execFile);
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export const D1_PRODUCTION_DELTA_RESULT_SCHEMA = "cityscroll.d1-production-delta-result.v1";
export const D1_PUBLICATION_SNAPSHOT_KEY_PREFIX = "d1-publication:snapshot:v2:";

export function applicationCheckpointId(fingerprint, batch) {
  return `${fingerprint}:${batch.model_id}:${batch.partition}:${batch.ordinal}`;
}

function fail(message) {
  throw new Error(`d1 production delta: ${message}`);
}

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function terminalResult({ outcome, reason, plan, batchPlan, publishReceipt, canaryEvidence, reconcileReport }) {
  return {
    schema: D1_PRODUCTION_DELTA_RESULT_SCHEMA,
    outcome,
    reason,
    plan,
    batchPlan,
    publishReceipt,
    canaryEvidence,
    reconcileReport,
  };
}

function publicationOutcome(receipt) {
  if (receipt.status === "stopped_fenced") {
    return { outcome: "abandoned", reason: receipt.stopped_reason };
  }
  if (receipt.status === "stopped_permanent_error") {
    const transient = /^transient error/.test(receipt.stopped_reason || "");
    return {
      outcome: transient ? "failed_transient_exhausted" : "failed_permanent",
      reason: receipt.stopped_reason || "bounded D1 publication stopped",
    };
  }
  return { outcome: "failed_permanent", reason: `bounded D1 publication stopped with ${receipt.status}` };
}

/**
 * Compose one full ordinary run. Canary batches retain their full-plan batch
 * ids; the wide publisher therefore recovers them through appliedBatchStore
 * instead of replaying the canary slice.
 */
export async function runProductionDelta({
  priorSnapshot,
  currentSnapshot,
  manifest,
  sourceDocuments,
  generation,
  fingerprint,
  holder,
  fenceStore,
  fenceLedger = null,
  adapter,
  appliedBatchStore = adapter,
  policy,
  maxOpsPerBatch = DEFAULT_MAX_OPS_PER_BATCH,
  recordedAt = new Date().toISOString(),
  now = () => Date.now(),
}) {
  const plan = planDelta({ prior: priorSnapshot, current: currentSnapshot });
  if (plan.operation !== "delta") fail("ordinary publication accepted a non-delta plan");
  const batchPlan = planBatches({ plan, manifest, sourceDocuments, generation, maxOpsPerBatch });

  const scope = selectCanaryScope({ plan, policy });
  let canaryPublishReceipt = null;
  let verification = null;
  if (scope.selected.length > 0) {
    const canaryPlan = scopedDeltaPlan(plan, scope.selected);
    const canaryBatchPlan = planBatches({ plan: canaryPlan, manifest, sourceDocuments, generation, maxOpsPerBatch });
    canaryPublishReceipt = await publishBounded({
      batchPlan: canaryBatchPlan, manifest, fenceStore, fenceLedger, holder, fingerprint,
      executor: adapter, appliedBatchStore, now,
    });
    if (canaryPublishReceipt.status === "complete") {
      verification = await verifyPartitionScope({ manifest, sourceDocuments, adapter, selection: scope.selected });
    }
  }
  const canaryEvidence = buildCanaryEvidence({
    generation, policy, scope, publishReceipt: canaryPublishReceipt, verification, recordedAt,
  });
  if (canaryEvidence.status !== "passed") {
    const stopped = canaryPublishReceipt?.status === "complete"
      ? { outcome: "failed_permanent", reason: canaryEvidence.reason }
      : publicationOutcome(canaryPublishReceipt);
    return terminalResult({ ...stopped, plan, batchPlan, publishReceipt: canaryPublishReceipt, canaryEvidence, reconcileReport: null });
  }

  const publishReceipt = await publishBounded({
    batchPlan, manifest, fenceStore, fenceLedger, holder, fingerprint,
    executor: adapter, appliedBatchStore, now,
  });
  if (publishReceipt.status !== "complete") {
    return terminalResult({
      ...publicationOutcome(publishReceipt), plan, batchPlan, publishReceipt, canaryEvidence, reconcileReport: null,
    });
  }

  // Reconcile the affected partitions. The scope is the publication delta,
  // keeping the proof bounded to this generation rather than rescanning every
  // unrelated resident row.
  const selected = plan.models
    .flatMap((model) => model.partitions
      .filter((partition) => partition.counts.total_ops > 0)
      .map((partition) => ({ model_id: model.model_id, partition: partition.partition, rows: partition.counts.total_ops })))
    .sort((left, right) => compareText(left.model_id, right.model_id) || compareText(left.partition, right.partition));
  const reconcileScope = {
    candidate_count: selected.length,
    selected: selected.map(({ model_id, partition }) => ({ model_id, partition })),
    rows: selected.reduce((sum, item) => sum + item.rows, 0),
  };
  const reconcileOverBound = selected.length > policy.reconcile.max_partitions
    || reconcileScope.rows > policy.reconcile.max_rows;
  const reconcileVerification = reconcileOverBound
    ? { findings: [], watermarks: [], representativeQueries: [] }
    : await verifyPartitionScope({ manifest, sourceDocuments, adapter, selection: reconcileScope.selected });
  const reconcileReport = buildReconcileReport({
    generation, policy, scope: reconcileScope, verification: reconcileVerification,
    truncated: reconcileOverBound, recordedAt,
  });
  if (!reconcileReport.consistent) {
    return terminalResult({
      outcome: "failed_permanent", reason: "post-publication reconciliation was not consistent",
      plan, batchPlan, publishReceipt, canaryEvidence, reconcileReport,
    });
  }

  const unchanged = batchPlan.summary.total_ops === 0;
  return terminalResult({
    outcome: unchanged ? "skipped" : "published",
    reason: unchanged ? "partition snapshot unchanged" : "bounded D1 delta published and reconciled",
    plan, batchPlan, publishReceipt, canaryEvidence, reconcileReport,
  });
}

function bindSql(sql, params) {
  let index = 0;
  const bound = sql.replace(/\?/g, () => {
    if (index >= params.length) fail("D1 select has fewer parameters than placeholders");
    return sqlLiteral(params[index++]);
  });
  if (index !== params.length) fail("D1 select has more parameters than placeholders");
  return bound;
}

function parseWranglerRows(stdout) {
  const parsed = JSON.parse(stdout);
  const results = Array.isArray(parsed) ? parsed : [parsed];
  if (results.some((result) => result?.success === false)) fail("Wrangler D1 query reported failure");
  return results.flatMap((result) => Array.isArray(result?.results) ? result.results : []);
}

/** Wrangler-backed read/write adapter used only by the production workflow. */
export function createWranglerD1PublicationAdapter({
  database,
  config = "worker/wrangler.toml",
  remote = true,
  wranglerVersion = "4.126.0",
  fingerprint,
  generation,
  run = null,
} = {}) {
  if (!database) fail("database is required");
  const invoke = run || (async (args) => execFileAsync("npx", [`wrangler@${wranglerVersion}`, ...args], { encoding: "utf8" }));
  const location = remote ? ["--remote"] : ["--local"];
  const base = ["d1", "execute", database, ...location, "--yes", "--config", config];
  const select = async (sql, params = []) => {
    const { stdout } = await invoke([...base, "--command", bindSql(sql, params), "--json"]);
    return parseWranglerRows(stdout);
  };
  return {
    async execute(sql, batch) {
      const marker = `INSERT INTO d1_publication_batches (batch_id, checkpoint_id, generation, fingerprint, model_id, partition_id, ordinal, op_count, estimated_application_writes) VALUES (${[
        batch.batch_id, applicationCheckpointId(fingerprint, batch), generation, fingerprint, batch.model_id, batch.partition, batch.ordinal, batch.op_count, batch.estimated_writes,
      ].map(sqlLiteral).join(", ")});`;
      const dir = mkdtempSync(join(tmpdir(), "d1-production-batch-"));
      const file = join(dir, "batch.sql");
      writeFileSync(file, `${sql.trim()}\n${marker}\n`);
      try {
        await invoke([...base, "--file", file]);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
    select,
    async has(batchId, batch = null) {
      const checkpointId = batch ? applicationCheckpointId(fingerprint, batch) : batchId;
      const rows = await select("SELECT checkpoint_id FROM d1_publication_batches WHERE checkpoint_id = ?", [checkpointId]);
      return rows.some((row) => row.checkpoint_id === checkpointId);
    },
  };
}

function parseArgs(argv) {
  const args = { command: argv[2] };
  for (let index = 3; index < argv.length; index += 1) {
    const flag = argv[index];
    if (!flag.startsWith("--")) fail(`unknown argument ${flag}`);
    const next = argv[index + 1];
    if (next === undefined || next.startsWith("--")) args[flag.slice(2)] = true;
    else { args[flag.slice(2)] = next; index += 1; }
  }
  return args;
}

function required(args, name) {
  if (args[name] === undefined || args[name] === "") fail(`missing --${name}`);
  return args[name];
}

function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function sourceDocumentsFor(manifest) {
  return Object.fromEntries(manifest.models.map((entry) => [entry.model_id, readSourceDocument(entry, ROOT)]));
}

async function main(argv) {
  const args = parseArgs(argv);
  if (args.command === "snapshot-key") {
    const generation = Number(required(args, "generation"));
    if (!Number.isInteger(generation) || generation < 1) fail("generation must be a positive integer");
    process.stdout.write(`${D1_PUBLICATION_SNAPSHOT_KEY_PREFIX}${generation}\n`);
    return 0;
  }
  if (args.command === "prior-snapshot-key") {
    const state = JSON.parse(readFileSync(required(args, "state"), "utf8"));
    if (state.schema !== D1_GENERATION_FENCE_SCHEMA || state.status !== "published" || !Number.isInteger(state.generation)) {
      fail("published generation has no delta snapshot baseline; use the explicit rebuild workflow");
    }
    process.stdout.write(`${D1_PUBLICATION_SNAPSHOT_KEY_PREFIX}${state.generation}\n`);
    return 0;
  }
  if (args.command !== "execute") {
    console.error("d1_production_delta: usage: execute --prior <snapshot> --current <snapshot> --generation <n> --holder <id> --fingerprint <sha256> --database <name> --out-dir <dir>");
    return 2;
  }
  const outDir = resolve(required(args, "out-dir"));
  const priorSnapshot = JSON.parse(readFileSync(required(args, "prior"), "utf8"));
  const currentSnapshot = JSON.parse(readFileSync(required(args, "current"), "utf8"));
  if (priorSnapshot.schema !== SNAPSHOT_SCHEMA || currentSnapshot.schema !== SNAPSHOT_SCHEMA) fail("snapshot has the wrong schema");
  const manifest = loadManifest();
  const generation = Number(required(args, "generation"));
  const fingerprint = required(args, "fingerprint");
  const holder = required(args, "holder");
  const config = args.config || "worker/wrangler.toml";
  const adapter = createWranglerD1PublicationAdapter({ database: required(args, "database"), config, generation, fingerprint });
  const fenceStore = createWranglerKvStore({
    key: args.key || "d1-publication:state:v1", binding: args.binding || "ALERT_STATE",
    config, remote: args.remote !== "false", wranglerVersion: args["wrangler-version"] || "4.126.0",
  });
  const fenceLedger = args.ledger ? createFileLedger(args.ledger) : null;
  const result = await runProductionDelta({
    priorSnapshot, currentSnapshot, manifest, sourceDocuments: sourceDocumentsFor(manifest),
    generation, fingerprint, holder, fenceStore, fenceLedger, adapter, appliedBatchStore: adapter,
    policy: loadReleasePolicy(args.policy),
    maxOpsPerBatch: args["max-ops"] ? Number(args["max-ops"]) : DEFAULT_MAX_OPS_PER_BATCH,
  });
  writeJson(join(outDir, "delta-plan.json"), result.plan);
  writeJson(join(outDir, "batch-plan.json"), result.batchPlan);
  if (result.publishReceipt) writeJson(join(outDir, "publish-receipt.json"), result.publishReceipt);
  if (result.canaryEvidence) writeJson(join(outDir, "canary-evidence.json"), result.canaryEvidence);
  if (result.reconcileReport) writeJson(join(outDir, "reconcile-report.json"), result.reconcileReport);
  writeJson(join(outDir, "result.json"), {
    schema: result.schema, outcome: result.outcome, reason: result.reason,
    generation, fingerprint,
  });
  return ["published", "skipped"].includes(result.outcome) ? 0 : 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv).then((code) => { process.exitCode = code; }).catch((error) => {
    console.error(error?.stack || error);
    process.exitCode = 1;
  });
}
