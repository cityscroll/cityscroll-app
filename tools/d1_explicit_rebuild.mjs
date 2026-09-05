#!/usr/bin/env node

/**
 * The sole D1 full-rebuild entry point (D1-09).
 *
 * This command only stages a rebuild plan, bounded-publisher plan, SQL, and
 * receipt. It never executes SQL. A later operator-controlled publication
 * uses the staged plan through tools/d1_bounded_publisher.mjs and must run
 * reconcile before the new generation can serve.
 */

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  buildPublicationReceipt,
} from "./d1_publication_receipt.mjs";
import {
  PLAN_SCHEMA,
  SNAPSHOT_SCHEMA,
  liveSnapshot,
  planDelta,
  snapshotFor,
} from "./d1_delta_plan.mjs";
import {
  dryRunReport,
  planBatches,
} from "./d1_bounded_publisher.mjs";
import { loadManifest } from "./d1_manifest.mjs";
import {
  REBUILD_ALLOW_TOKEN,
  generateReadModelOutputs,
  readSourceDocument,
} from "./build_worker_d1_read_models.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_OUTPUT_DIR = resolve(ROOT, ".artifacts/d1-explicit-rebuild");
const EPOCH = "1970-01-01T00:00:00.000Z";

export class ExplicitRebuildError extends Error {
  constructor(field, message) {
    super(`d1 explicit rebuild: ${field} ${message}`);
    this.name = "ExplicitRebuildError";
    this.field = field;
  }
}

function fail(field, message) {
  throw new ExplicitRebuildError(field, message);
}

function requiredValue(args, name) {
  const value = args[name];
  if (value === undefined || value === "") fail(`--${name}`, "is required");
  return value;
}

function positiveInteger(value, field) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) fail(field, "must be a positive integer");
  return parsed;
}

/** Parse the exact argv shape used by the workflow_dispatch job. */
export function parseArgs(argv) {
  const args = { outputDir: DEFAULT_OUTPUT_DIR, currentSnapshot: null, actor: null, runId: null, workflow: null, attempt: null };
  const valueFlags = new Set([
    "reason", "source-snapshot", "confirm", "estimate-writes", "output-dir",
    "current-snapshot", "actor", "run-id", "workflow", "attempt",
  ]);
  for (let index = 2; index < argv.length; index += 1) {
    const flag = argv[index];
    if (!flag.startsWith("--") || !valueFlags.has(flag.slice(2))) fail("argv", `unknown argument ${flag}`);
    const next = argv[index + 1];
    if (next === undefined || next.startsWith("--")) fail(flag, "needs a value");
    args[flag.slice(2).replaceAll("-", "_")] = next;
    index += 1;
  }
  if (args.output_dir) args.outputDir = resolve(ROOT, args.output_dir);
  if (args.current_snapshot) args.currentSnapshot = resolve(ROOT, args.current_snapshot);
  args.reason = args.reason ?? null;
  args.sourceSnapshotPath = args.source_snapshot ? resolve(ROOT, args.source_snapshot) : null;
  args.confirm = args.confirm ?? null;
  args.estimateWrites = args.estimate_writes ?? null;
  args.runId = args.run_id ?? null;
  delete args.output_dir;
  delete args.current_snapshot;
  delete args.source_snapshot;
  delete args.estimate_writes;
  delete args.run_id;
  return args;
}

export function snapshotSha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

/** Confirmation is bound to both the exact reason and exact snapshot bytes. */
export function expectedConfirmation(reason, sourceSnapshotHash) {
  return `d1-rebuild-${snapshotSha256(`${reason}\n${sourceSnapshotHash}`)}`;
}

function readSnapshot(path, field) {
  let bytes;
  try {
    bytes = readFileSync(path);
  } catch (error) {
    fail(field, `cannot read ${path}: ${error.message}`);
  }
  let snapshot;
  try {
    snapshot = JSON.parse(bytes.toString("utf8"));
  } catch (error) {
    fail(field, `is not valid JSON: ${error.message}`);
  }
  if (snapshot?.schema !== SNAPSHOT_SCHEMA) fail(field, `must use ${SNAPSHOT_SCHEMA}`);
  return { bytes, snapshot };
}

function sourceDocumentsFor(manifest, supplied) {
  if (supplied) return supplied;
  return Object.fromEntries(manifest.models.map((entry) => [entry.model_id, readSourceDocument(entry)]));
}

function deterministicRecordedAt(snapshot) {
  const values = [];
  for (const model of Object.values(snapshot.models || {})) {
    for (const partition of Object.values(model.partitions || {})) {
      const raw = partition?.watermark;
      for (const part of typeof raw === "string" ? raw.split("|") : []) {
        const timestamp = Date.parse(part.trim());
        if (!Number.isNaN(timestamp)) values.push(timestamp);
      }
    }
  }
  return values.length ? new Date(Math.max(...values)).toISOString() : EPOCH;
}

function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function runIdentity({ actor, runId, workflow, attempt }) {
  const resolvedActor = actor || process.env.GITHUB_ACTOR;
  if (!resolvedActor) fail("actor", "provide --actor or GITHUB_ACTOR");
  const resolvedRunId = runId || process.env.GITHUB_RUN_ID;
  if (!resolvedRunId) fail("run-id", "provide --run-id or GITHUB_RUN_ID");
  return {
    actor: resolvedActor,
    workflow: workflow || process.env.GITHUB_WORKFLOW || "D1 explicit rebuild",
    run_id: String(resolvedRunId),
    attempt: positiveInteger(attempt || process.env.GITHUB_RUN_ATTEMPT || 1, "attempt"),
  };
}

export function buildExplicitRebuild({
  reason,
  sourceSnapshotPath,
  confirm,
  estimateWrites,
  outputDir = DEFAULT_OUTPUT_DIR,
  actor = null,
  runId = null,
  workflow = null,
  attempt = null,
  currentSnapshotPath = null,
  currentSnapshot = null,
  manifest = loadManifest(),
  sourceDocuments = null,
}) {
  if (typeof reason !== "string" || reason.trim() === "") fail("reason", "must be non-empty");
  const sourcePath = resolve(ROOT, sourceSnapshotPath || "");
  if (!sourceSnapshotPath) fail("source-snapshot", "is required");
  const source = readSnapshot(sourcePath, "source-snapshot");
  const sourceHash = snapshotSha256(source.bytes);
  const expected = expectedConfirmation(reason, sourceHash);
  if (confirm !== expected) fail("confirm", `does not match the source snapshot and reason; expected ${expected}`);
  const estimated = positiveInteger(estimateWrites, "estimate-writes");
  const run = runIdentity({ actor, runId, workflow, attempt });
  const output = resolve(ROOT, outputDir);
  const current = currentSnapshotPath
    ? readSnapshot(resolve(ROOT, currentSnapshotPath), "current-snapshot").snapshot
    : currentSnapshot || (sourceDocuments ? snapshotFor(manifest, sourceDocuments) : liveSnapshot());
  const documents = sourceDocumentsFor(manifest, sourceDocuments);
  const plan = planDelta({ prior: source.snapshot, current, rebuild: reason });
  if (plan.schema !== PLAN_SCHEMA || plan.operation !== "rebuild") fail("plan", "did not produce a rebuild plan");

  const generator = generateReadModelOutputs({
    outputDir: output,
    mode: "rebuild",
    allowRebuild: REBUILD_ALLOW_TOKEN,
    manifest,
    sourceDocuments: documents,
  });
  const batchPlan = planBatches({ plan, manifest, sourceDocuments: documents, generation: 1 });
  const dryRun = dryRunReport({ plan, batchPlan });
  const currentHash = snapshotSha256(`${JSON.stringify(current)}\n`);
  const receipt = buildPublicationReceipt({
    actor: run.actor,
    run,
    outcome: "published",
    reason,
    deployFingerprint: currentHash,
    snapshot: current,
    dryRun,
    recordedAt: deterministicRecordedAt(current),
    receiptId: `${run.run_id}:${run.attempt}:rebuild:${sourceHash.slice(0, 16)}`,
    rebuild: { sourceSnapshotSha256: sourceHash, estimatedWrites: estimated },
    verification: { status: "not_run", detail: "staged; bounded publication and reconcile are required before serving" },
  });

  writeJson(resolve(output, "rebuild-plan.json"), plan);
  writeJson(resolve(output, "bounded-publish-plan.json"), batchPlan);
  writeJson(resolve(output, "bounded-publish-dry-run.json"), dryRun);
  writeJson(resolve(output, "publication-receipt.json"), receipt);
  writeJson(resolve(output, "staging-manifest.json"), {
    schema: "cityscroll.d1-explicit-rebuild.v1",
    reason,
    actor: run.actor,
    run: { workflow: run.workflow, run_id: run.run_id, attempt: run.attempt },
    source_snapshot_sha256: sourceHash,
    current_snapshot_sha256: currentHash,
    estimated_writes: estimated,
    artifacts: [
      "rebuild-plan.json",
      "bounded-publish-plan.json",
      "bounded-publish-dry-run.json",
      "publication-receipt.json",
      "keyword_search_read_model.sql",
      "ocp_awards_read_model.sql",
      "entity_intelligence_read_model.sql",
    ],
  });
  return { outputDir: output, generator, plan, batchPlan, dryRun, receipt, sourceSnapshotHash: sourceHash, currentSnapshotHash: currentHash };
}

function main(argv) {
  const args = parseArgs(argv);
  const result = buildExplicitRebuild(args);
  console.log(JSON.stringify({
    output_dir: result.outputDir,
    source_snapshot_sha256: result.sourceSnapshotHash,
    current_snapshot_sha256: result.currentSnapshotHash,
    estimated_writes: result.receipt.rebuild.estimated_writes,
    receipt: "publication-receipt.json",
    plan: "rebuild-plan.json",
  }));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main(process.argv);
  } catch (error) {
    console.error(error?.stack || error);
    process.exitCode = 1;
  }
}
