#!/usr/bin/env node
// Offline scorer bake-off runner. It always measures the baseline and can
// ingest optional contender envelopes produced by the Python adapters.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadGold, runBlocker } from "./run_metrics.mjs";
import {
  buildBakeoffReport,
  candidatePairsForGold,
  evaluateScorer,
  renderBakeoffSummary,
  unavailableContender,
  scoreGoldWithScorer,
} from "../evaluation/bakeoff.mjs";
import { conventionalV2Scorer } from "../scorers/index.mjs";

function usage(message) {
  if (message) console.error(`error: ${message}`);
  console.error("Usage: node entity_resolution/eval/run_bakeoff.mjs --gold <path> --out-dir <dir> [--blocker token_v0|none] [--splink-output <path.json>] [--dedupe-output <path.json>] [--threshold 0.9]");
  process.exit(1);
}

function args(argv) {
  const out = { gold: null, outDir: null, blocker: "token_v0", threshold: 0.9, splink: null, dedupe: null };
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--gold") out.gold = argv[++i];
    else if (arg === "--out-dir") out.outDir = argv[++i];
    else if (arg === "--blocker") out.blocker = argv[++i];
    else if (arg === "--threshold") out.threshold = Number(argv[++i]);
    else if (arg === "--splink-output") out.splink = argv[++i];
    else if (arg === "--dedupe-output") out.dedupe = argv[++i];
    else usage(`unknown argument ${arg}`);
  }
  if (!out.gold || !out.outDir) usage("--gold and --out-dir are required");
  if (!Number.isFinite(out.threshold) || out.threshold < 0 || out.threshold > 1) usage("--threshold must be between 0 and 1");
  return out;
}

function loadContender(path, name, gold, candidateIds, threshold) {
  if (!path) return unavailableContender(name, "No adapter output supplied");
  const envelope = JSON.parse(readFileSync(resolve(path), "utf8"));
  if (!envelope.scorer || !Array.isArray(envelope.scores)) {
    throw new Error(`${name} output requires scorer and scores[]`);
  }
  return evaluateScorer({
    cases: gold.cases,
    candidateIds,
    scores: envelope.scores,
    scorer: envelope.scorer,
    threshold,
    incrementalConsistency: envelope.incremental_consistency,
    trainingOverlap: envelope.training_overlap,
  });
}

function main() {
  const options = args(process.argv);
  const goldPath = resolve(options.gold);
  if (!existsSync(goldPath)) usage(`gold file not found: ${options.gold}`);
  const goldText = readFileSync(goldPath, "utf8");
  const gold = loadGold(goldText);
  const blocker = runBlocker(options.blocker, gold.cases);
  const candidateIds = blocker?.candidateIds || null;
  const candidatePairs = candidatePairsForGold(gold.cases, candidateIds);
  const baselineScores = scoreGoldWithScorer(gold.cases, candidateIds, conventionalV2Scorer);
  const contenders = [
    evaluateScorer({
      cases: gold.cases,
      candidateIds,
      scores: baselineScores,
      scorer: conventionalV2Scorer,
      threshold: options.threshold,
    }),
    loadContender(options.splink, "splink_duckdb", gold, candidateIds, options.threshold),
    loadContender(options.dedupe, "dedupe_gazetteer", gold, candidateIds, options.threshold),
  ];
  const report = buildBakeoffReport({
    gold,
    contentHash: gold.contentHash,
    candidateIds,
    blocker: options.blocker,
    threshold: options.threshold,
    contenders,
  });
  const outDir = resolve(options.outDir);
  mkdirSync(outDir, { recursive: true });
  writeFileSync(resolve(outDir, "candidate_pairs.jsonl"), `${candidatePairs.map((row) => JSON.stringify(row)).join("\n")}\n`);
  writeFileSync(resolve(outDir, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  writeFileSync(resolve(outDir, "summary.md"), renderBakeoffSummary(report));
  console.log(JSON.stringify({ out_dir: options.outDir, report: resolve(outDir, "report.json"), summary: resolve(outDir, "summary.md") }, null, 2));
}

const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname);
if (isMain) main();
