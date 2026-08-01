#!/usr/bin/env node
// Offline silver-authority metrics over exported source_records JSONL.

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  buildAuthorityReport,
  loadSourceRecords,
} from "../evaluation/authority.mjs";

function usage(message = null) {
  if (message) console.error(`error: ${message}`);
  console.error(
    "Usage: node entity_resolution/eval/run_authority.mjs --source-records <path.jsonl> [--json]",
  );
  process.exit(1);
}

function parseArgs(argv) {
  const args = { sourceRecords: null, json: false };
  for (let index = 2; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === "--source-records") args.sourceRecords = argv[++index];
    else if (arg === "--json") args.json = true;
    else if (arg === "--help" || arg === "-h") usage();
    else usage(`unknown argument: ${arg}`);
  }
  if (!args.sourceRecords) usage("--source-records is required");
  return args;
}

function main() {
  const args = parseArgs(process.argv);
  const inputPath = resolve(args.sourceRecords);
  if (!existsSync(inputPath)) usage(`source-record file not found: ${args.sourceRecords}`);

  let rows;
  try {
    rows = loadSourceRecords(readFileSync(inputPath, "utf8"));
  } catch (error) {
    console.error(`invalid source-record input: ${error.message}`);
    process.exit(1);
  }
  const report = buildAuthorityReport(rows, args.sourceRecords);
  for (const [key, value] of Object.entries(report.metrics)) {
    console.log(`${key}=${value == null ? "null" : value}`);
  }
  if (args.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log("---");
    console.log(`authority_version=${report.authority_version}`);
    console.log(`matcher_version=${report.matcher_version}`);
    console.log(`source_records=${report.source_records}`);
    console.log(`latest_source_records=${report.latest_source_records}`);
    console.log(`composition=${JSON.stringify(report.composition)}`);
  }
}

const isMain = process.argv[1] &&
  resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname);
if (isMain) main();
