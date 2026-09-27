#!/usr/bin/env node
/**
 * Materialize fixed-dossier connected-history temporal states.
 *
 *   node tools/build_connected_history_time.mjs
 *   node tools/build_connected_history_time.mjs --check
 */

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  materializeConnectedHistoryTime,
  verifyConnectedHistoryTimeArtifact,
} from "./lib/connected_history_time.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "site/data/connected_history_time.json");
const RECEIPT = join(
  ROOT,
  "site/data/connected_history_sources/verification_receipts/connected_history_time_latest.json",
);
const checkOnly = process.argv.includes("--check");

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

const { artifact, receipt } = materializeConnectedHistoryTime();

if (checkOnly) {
  const existing = readJson(OUT);
  const existingReceipt = readJson(RECEIPT);
  const verification = verifyConnectedHistoryTimeArtifact(existing);
  if (!verification.valid) {
    throw new Error(`connected history time artifact failed verification: ${verification.errors.join(", ")}`);
  }
  if (JSON.stringify(existing) !== JSON.stringify(artifact)) {
    throw new Error("connected history time artifact is stale; rebuild required");
  }
  if (JSON.stringify(existingReceipt) !== JSON.stringify(receipt)) {
    throw new Error("connected history time receipt is stale; rebuild required");
  }
  console.log("ok connected history time artifact is current");
  process.exit(0);
}

writeFileSync(OUT, `${JSON.stringify(artifact, null, 2)}\n`);
writeFileSync(RECEIPT, `${JSON.stringify(receipt, null, 2)}\n`);
console.log(JSON.stringify({
  counts: artifact.counts,
  selection_hash: artifact.selection_hash,
  out: [OUT, RECEIPT],
}, null, 2));
