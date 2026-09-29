#!/usr/bin/env node
// Combine the acquisition/builder receipt, the read-model rebuild receipt, and
// the working tree's pending changes into one per-dataset accounting.
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
// Run after the rebuild step and before the commit that opens the pull
// request, so "published" reflects the working tree the commit is about to
// stage rather than a later, less certain read of git history.
//
// Usage:
//   node tools/first_class_refresh_run_receipt.mjs --write

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { readRegistry as readRebuildRegistry } from "../ops/first-class-refresh/rebuild-committed-read-models.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const RUN_RECEIPT_SCHEMA = "cityscroll.first_class_refresh_run_receipt.v1";
const RUN_RECEIPT_PATH = ".artifacts/first-class-refresh-run-receipt.json";
const REFRESH_RECEIPT_PATH = ".artifacts/first-class-refresh-receipt.json";
const REBUILD_RECEIPT_PATH = ".artifacts/first-class-rebuild-receipt.json";
const CONTRACTS_PATH = "site/data/source_contracts.json";

function readJson(path) {
  return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : null;
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

export function buildRunReceipt({ registry, refreshReceipt, rebuildRegistry, rebuildReceipt, changed, now }) {
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
  return {
    schema: RUN_RECEIPT_SCHEMA,
    generated_at: now,
    total: datasets.length,
    due_count: datasets.filter((row) => row.due).length,
    published_count: datasets.filter((row) => row.published).length,
    datasets,
  };
}

function main() {
  const registry = readJson(join(ROOT, CONTRACTS_PATH));
  if (!registry) throw new Error(`missing ${CONTRACTS_PATH}`);
  const receipt = buildRunReceipt({
    registry,
    refreshReceipt: readJson(join(ROOT, REFRESH_RECEIPT_PATH)),
    rebuildRegistry: readRebuildRegistry(ROOT),
    rebuildReceipt: readJson(join(ROOT, REBUILD_RECEIPT_PATH)),
    changed: changedPaths(ROOT),
    now: new Date().toISOString(),
  });
  const output = join(ROOT, RUN_RECEIPT_PATH);
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, `${JSON.stringify(receipt, null, 2)}\n`);
  console.log(`wrote ${RUN_RECEIPT_PATH}: ${receipt.due_count} due, ${receipt.published_count} publishing, ${receipt.total} declared`);
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main();
}
