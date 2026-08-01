#!/usr/bin/env node
// Offline entity-centric component evaluation over gold and silver-authority cases.

import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";

import { buildEntityComponentReport } from "../evaluation/entity_components.mjs";
import { deriveAuthorityCases, loadSourceRecords } from "../evaluation/authority.mjs";
import { loadGold } from "./run_metrics.mjs";

function usage(message = null) {
  if (message) console.error(`error: ${message}`);
  console.error("Usage: node entity_resolution/eval/run_entity_components.mjs --gold <gold.jsonl> --source-records <rows.jsonl> [--sample-size N] [--observed-on YYYY-MM-DD] [--out-dir DIR] [--json]");
  process.exit(1);
}

function parseArgs(argv) {
  const args = { gold: null, sourceRecords: null, sampleSize: 8, observedOn: null, outDir: null, json: false };
  for (let index = 2; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === "--gold") args.gold = argv[++index];
    else if (arg === "--source-records") args.sourceRecords = argv[++index];
    else if (arg === "--sample-size") args.sampleSize = Number(argv[++index]);
    else if (arg === "--observed-on") args.observedOn = argv[++index];
    else if (arg === "--out-dir") args.outDir = argv[++index];
    else if (arg === "--json") args.json = true;
    else if (arg === "--help" || arg === "-h") usage();
    else usage(`unknown argument: ${arg}`);
  }
  if (!args.gold || !args.sourceRecords) usage("--gold and --source-records are required");
  if (!Number.isInteger(args.sampleSize) || args.sampleSize < 1) usage("--sample-size requires a positive integer");
  if (args.outDir && !/^\d{4}-\d{2}-\d{2}$/.test(args.observedOn || "")) {
    usage("--out-dir requires --observed-on YYYY-MM-DD for reproducible receipts");
  }
  return args;
}

function sha256(text) {
  return createHash("sha256").update(text).digest("hex");
}

function main() {
  const args = parseArgs(process.argv);
  for (const path of [args.gold, args.sourceRecords]) {
    if (!existsSync(resolve(path))) usage(`input not found: ${path}`);
  }
  const goldText = readFileSync(resolve(args.gold), "utf8");
  const authorityText = readFileSync(resolve(args.sourceRecords), "utf8");
  const gold = loadGold(goldText);
  const authorityRows = loadSourceRecords(authorityText);
  const report = buildEntityComponentReport({
    goldCases: gold.cases,
    authorityCases: deriveAuthorityCases(authorityRows),
  }, { sampleSize: args.sampleSize });
  const receipt = {
    kind: "entity_component_evaluation_receipt",
    schema_version: report.schema_version,
    observed_on: args.observedOn,
    inputs: {
      gold: { path: args.gold, sha256: sha256(goldText), cases: gold.cases.length },
      source_records: { path: args.sourceRecords, sha256: sha256(authorityText), rows: authorityRows.length },
    },
    matcher_version: report.matcher_version,
    parameters: report.parameters,
    metrics: report.metrics,
    sample_sha256: sha256(JSON.stringify(report.sample)),
  };
  if (args.outDir) {
    const outDir = resolve(args.outDir);
    mkdirSync(outDir, { recursive: true });
    writeFileSync(join(outDir, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
    writeFileSync(join(outDir, "receipt.json"), `${JSON.stringify(receipt, null, 2)}\n`);
  }
  for (const corpus of ["gold", "authority"]) {
    for (const [key, value] of Object.entries(report.metrics[corpus])) {
      console.log(`${corpus}_${key}=${value == null ? "null" : value}`);
    }
  }
  console.log(`sampled_components=${report.sample.length}`);
  console.log(`false_split_priority_components=${report.false_split_priority.length}`);
  if (args.json) console.log(JSON.stringify({ report, receipt }, null, 2));
}

const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname);
if (isMain) main();
