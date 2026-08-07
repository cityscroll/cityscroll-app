#!/usr/bin/env node
// Build versioned labeling-function accounting from bake-off candidate rows.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { FEATURES_VERSION } from "../features/index.mjs";
import { accountLabelingFunctions, renderLabelingFunctionSummary } from "../evaluation/labeling_functions.mjs";

function usage(message) {
  if (message) console.error(`error: ${message}`);
  console.error("Usage: node entity_resolution/eval/run_labeling_function_accounting.mjs --features <candidate_pairs.jsonl> --gold <gold.jsonl> --out-dir <dir>");
  process.exit(1);
}

function args(argv) {
  const out = { features: null, gold: null, outDir: null };
  for (let i = 2; i < argv.length; i += 1) {
    if (argv[i] === "--features") out.features = argv[++i];
    else if (argv[i] === "--gold") out.gold = argv[++i];
    else if (argv[i] === "--out-dir") out.outDir = argv[++i];
    else usage(`unknown argument ${argv[i]}`);
  }
  if (!out.features || !out.gold || !out.outDir) usage("--features, --gold, and --out-dir are required");
  return out;
}

function jsonl(path) {
  return readFileSync(resolve(path), "utf8").split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
}

function main() {
  const options = args(process.argv);
  for (const path of [options.features, options.gold]) {
    if (!existsSync(resolve(path))) usage(`file not found: ${path}`);
  }
  const featureRows = jsonl(options.features).filter((row) => !row._meta);
  const goldLines = jsonl(options.gold);
  const meta = goldLines.find((row) => row._meta);
  const gold = goldLines.filter((row) => !row._meta);
  if (!meta?.gold_version) throw new Error("gold JSONL requires a _meta line with gold_version");
  const report = accountLabelingFunctions({ rows: featureRows, gold });
  report.gold = {
    version: meta.gold_version,
    schema_version: meta.schema_version,
    case_count: gold.length,
  };
  const outDir = resolve(options.outDir);
  mkdirSync(outDir, { recursive: true });
  writeFileSync(resolve(outDir, "labeling_function_accounting.json"), `${JSON.stringify(report, null, 2)}\n`);
  writeFileSync(resolve(outDir, "labeling_function_accounting.md"), renderLabelingFunctionSummary(report));
  console.log(JSON.stringify({ out_dir: options.outDir, features_version: FEATURES_VERSION }, null, 2));
}

const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname);
if (isMain) main();
