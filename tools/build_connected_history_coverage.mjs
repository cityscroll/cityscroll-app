#!/usr/bin/env node
/**
 * Materialize the 59-board connected-history coverage census from committed
 * inputs only.
 *
 *   node tools/build_connected_history_coverage.mjs
 *   node tools/build_connected_history_coverage.mjs --check
 *   node tools/build_connected_history_coverage.mjs --verify-file <path>
 */

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  buildConnectedHistoryCoverage,
  buildConnectedHistoryCoverageReceipt,
  verifyConnectedHistoryCoverage,
} from "./connected_history_coverage.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "site/data/connected_history_coverage.json");
const RECEIPT = join(ROOT, "site/data/connected_history_sources/verification_receipts/connected_history_coverage_latest.json");

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

export function loadConnectedHistoryCoverageInputs(root = ROOT) {
  return {
    cohort: readJson(join(root, "site/data/connected_history_evaluation_cohort.json")),
    documents: readJson(join(root, "site/data/connected_history_documents.json")),
    relations: readJson(join(root, "site/data/connected_history_relations.json")),
    time: readJson(join(root, "site/data/connected_history_time.json")),
    roles: readJson(join(root, "site/data/connected_history_roles.json")),
  };
}

export function main(args = process.argv.slice(2)) {
  const inputs = loadConnectedHistoryCoverageInputs();
  const artifact = buildConnectedHistoryCoverage(inputs);
  const receipt = buildConnectedHistoryCoverageReceipt(artifact, inputs);
  if (args[0] === "--verify-file") {
    if (!args[1]) throw new Error("--verify-file requires a JSON path");
    const target = readJson(resolve(args[1]));
    const verification = verifyConnectedHistoryCoverage(target, inputs);
    process.stdout.write(`${JSON.stringify(verification)}\n`);
    if (!verification.valid) process.exitCode = 1;
  } else if (args.includes("--check")) {
    const existing = readJson(OUT);
    const existingReceipt = readJson(RECEIPT);
    const verification = verifyConnectedHistoryCoverage(existing, inputs);
    if (!verification.valid) {
      throw new Error(`connected history coverage is stale: ${verification.findings.join(", ")}`);
    }
    if (JSON.stringify(existing) !== JSON.stringify(artifact)) {
      throw new Error("connected history coverage serialization is stale");
    }
    if (JSON.stringify(existingReceipt) !== JSON.stringify(receipt)) {
      throw new Error("connected history coverage receipt is stale");
    }
    console.log("ok connected history coverage is current");
  } else {
    writeFileSync(OUT, `${JSON.stringify(artifact, null, 2)}\n`);
    writeFileSync(RECEIPT, `${JSON.stringify(receipt, null, 2)}\n`);
    console.log(JSON.stringify({
      board_count: artifact.snapshots.post_change.board_count,
      selection_hash: artifact.selection_hash,
      verification: receipt.verification.state,
      out: [OUT, RECEIPT],
    }, null, 2));
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
