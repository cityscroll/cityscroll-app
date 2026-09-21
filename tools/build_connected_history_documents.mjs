#!/usr/bin/env node
/**
 * Retain fixed-dossier CEQR, DOT, and EDC documents as dated observations.
 *
 *   node tools/build_connected_history_documents.mjs             # live run
 *   node tools/build_connected_history_documents.mjs --check
 */

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  CONNECTED_HISTORY_DOCUMENTS_SCHEMA,
  CONNECTED_HISTORY_DOCUMENTS_TRANSPORT,
  acquireConnectedHistoryDocuments,
  assertRetainedObservationsHaveFetchReceipts,
  createLiveHttpGet,
} from "./lib/connected_history_documents.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "site/data/connected_history_documents.json");
const RECEIPT = join(
  ROOT,
  "site/data/connected_history_sources/verification_receipts/connected_history_documents_latest.json",
);

const checkOnly = process.argv.includes("--check");

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

if (checkOnly) {
  const existing = readJson(OUT);
  const existingReceipt = readJson(RECEIPT);
  if (existing.schema !== CONNECTED_HISTORY_DOCUMENTS_SCHEMA) throw new Error("unexpected artifact schema");
  assertRetainedObservationsHaveFetchReceipts(existing.observations);
  if (existingReceipt.artifact !== "site/data/connected_history_documents.json") throw new Error("receipt does not name the committed artifact");
  if (existingReceipt.acquisition_mode !== "live") throw new Error("committed corpus must be from a live acquisition run");
  console.log("ok connected history documents artifact is current");
  process.exit(0);
}

const httpGet = createLiveHttpGet();
const { artifact, receipt } = await acquireConnectedHistoryDocuments({
  httpGet,
  observedAt: new Date().toISOString(),
  runMode: "live",
  requestTimeoutMs: CONNECTED_HISTORY_DOCUMENTS_TRANSPORT.requestTimeoutMs,
  responseCapBytes: CONNECTED_HISTORY_DOCUMENTS_TRANSPORT.responseCapBytes,
});

if (artifact.schema !== CONNECTED_HISTORY_DOCUMENTS_SCHEMA) throw new Error("unexpected artifact schema");

writeFileSync(OUT, `${JSON.stringify(artifact, null, 2)}\n`);
writeFileSync(RECEIPT, `${JSON.stringify(receipt, null, 2)}\n`);
console.log(
  JSON.stringify(
    {
      counts: artifact.counts,
      selection_hash: receipt.selection_hash,
      out: [OUT, RECEIPT],
    },
    null,
    2,
  ),
);
