#!/usr/bin/env node
/**
 * Retain fixed-dossier CEQR, DOT, and EDC documents as dated observations.
 *
 * Offline by default against committed fixtures (no live publisher fetch).
 *
 *   node tools/build_connected_history_documents.mjs
 *   node tools/build_connected_history_documents.mjs --check
 */

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  CONNECTED_HISTORY_DOCUMENTS_SCHEMA,
  acquireConnectedHistoryDocuments,
} from "./lib/connected_history_documents.mjs";
import { createFixtureHttpGet } from "../test/fixtures/connected_history_documents/http_fixture_map.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "site/data/connected_history_documents.json");
const RECEIPT = join(
  ROOT,
  "site/data/connected_history_sources/verification_receipts/connected_history_documents_latest.json",
);

const checkOnly = process.argv.includes("--check");
const OBSERVED_AT = "2026-09-18T00:00:00.000Z";

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

const httpGet = createFixtureHttpGet();
const { artifact, receipt } = await acquireConnectedHistoryDocuments({
  httpGet,
  observedAt: OBSERVED_AT,
});

if (artifact.schema !== CONNECTED_HISTORY_DOCUMENTS_SCHEMA) {
  console.error("unexpected artifact schema");
  process.exit(1);
}

if (checkOnly) {
  const existing = readJson(OUT);
  const existingReceipt = readJson(RECEIPT);
  if (JSON.stringify(existing) !== JSON.stringify(artifact)) {
    console.error("connected_history_documents.json is stale — re-run without --check");
    process.exit(1);
  }
  if (JSON.stringify(existingReceipt) !== JSON.stringify(receipt)) {
    console.error("connected_history_documents_latest.json is stale — re-run without --check");
    process.exit(1);
  }
  console.log("ok connected history documents artifact is current");
  process.exit(0);
}

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
