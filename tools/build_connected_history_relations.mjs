#!/usr/bin/env node
/**
 * Materialize fixed-dossier connected-history relations.
 *
 *   node tools/build_connected_history_relations.mjs
 *   node tools/build_connected_history_relations.mjs --check
 */

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  CONNECTED_HISTORY_RELATIONS_ARTIFACT_SCHEMA,
  CONNECTED_HISTORY_RELATIONS_VERSION,
} from "../site/connected_history_relations.mjs";
import {
  materializeConnectedHistoryRelations,
} from "./lib/connected_history_relations.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "site/data/connected_history_relations.json");
const RECEIPT = join(
  ROOT,
  "site/data/connected_history_sources/verification_receipts/connected_history_relations_latest.json",
);

const checkOnly = process.argv.includes("--check");

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

const { artifact, receipt } = materializeConnectedHistoryRelations();

if (artifact.schema !== CONNECTED_HISTORY_RELATIONS_ARTIFACT_SCHEMA) {
  throw new Error("unexpected artifact schema");
}
if (artifact.version !== CONNECTED_HISTORY_RELATIONS_VERSION) {
  throw new Error("unexpected artifact version");
}

if (checkOnly) {
  const existing = readJson(OUT);
  const existingReceipt = readJson(RECEIPT);
  if (existing.selection_hash !== artifact.selection_hash) {
    throw new Error("connected history relations artifact is stale; rebuild required");
  }
  if (existingReceipt.selection_hash !== receipt.selection_hash) {
    throw new Error("connected history relations receipt is stale; rebuild required");
  }
  if (existingReceipt.artifact !== "site/data/connected_history_relations.json") {
    throw new Error("receipt does not name the committed artifact");
  }
  console.log("ok connected history relations artifact is current");
  process.exit(0);
}

writeFileSync(OUT, `${JSON.stringify(artifact, null, 2)}\n`);
writeFileSync(RECEIPT, `${JSON.stringify(receipt, null, 2)}\n`);
console.log(
  JSON.stringify(
    {
      counts: artifact.counts,
      selection_hash: artifact.selection_hash,
      out: [OUT, RECEIPT],
    },
    null,
    2,
  ),
);
