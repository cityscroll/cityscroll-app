#!/usr/bin/env node

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  buildEntityAuditSample,
  summarizeEntityAuditRates,
  formatEntityAuditJsonl,
  formatEntityAuditLabelSheet,
} from "../entity_resolution/eval/entity_audit_sampling.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function usage(message = null) {
  if (message) console.error(`error: ${message}`);
  console.error(`Usage:
  node tools/export_entity_audit_sample.mjs --input <component-report.json> \\
    --out-dir <directory> --observed-on YYYY-MM-DD [options]
  node tools/export_entity_audit_sample.mjs --summarize <label-sheet.csv> \\
    --summary-out <report.json> [--min-reviewed-per-stratum N]

Export options:
  --sample-size N             default 30
  --seed TEXT                 default entity-audit-v1
  --large-cluster-min N       default 4
  --low-confidence-min 0..1   default 0.6
  --replace                   replace differing artifacts

The input is the audit_population from run_entity_components.mjs. Sampling is
deterministic within each exclusive stratum and records first-order inclusion
probabilities for inverse-probability weighting.`);
  process.exitCode = message ? 1 : 0;
}

function parseArgs(argv) {
  const args = {
    input: null,
    outDir: null,
    observedOn: null,
    sampleSize: 30,
    seed: "entity-audit-v1",
    largeClusterMin: 4,
    lowConfidenceMin: 0.6,
    replace: false,
    summarize: null,
    summaryOut: null,
    minReviewedPerStratum: 2,
  };
  const flags = new Map([
    ["--input", "input"],
    ["--out-dir", "outDir"],
    ["--observed-on", "observedOn"],
    ["--sample-size", "sampleSize"],
    ["--seed", "seed"],
    ["--large-cluster-min", "largeClusterMin"],
    ["--low-confidence-min", "lowConfidenceMin"],
    ["--summarize", "summarize"],
    ["--summary-out", "summaryOut"],
    ["--min-reviewed-per-stratum", "minReviewedPerStratum"],
  ]);
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === "--replace") args.replace = true;
    else if (arg === "--help" || arg === "-h") args.help = true;
    else if (flags.has(arg)) {
      const value = argv[++index];
      if (value == null) throw new Error(`${arg} requires a value`);
      args[flags.get(arg)] = value;
    } else throw new Error(`unknown argument ${arg}`);
  }
  for (const key of ["sampleSize", "largeClusterMin", "minReviewedPerStratum"]) {
    args[key] = Number(args[key]);
    if (!Number.isInteger(args[key]) || args[key] < 1) throw new Error(`${key} must be a positive integer`);
  }
  args.lowConfidenceMin = Number(args.lowConfidenceMin);
  if (!(args.lowConfidenceMin >= 0 && args.lowConfidenceMin <= 1)) {
    throw new Error("lowConfidenceMin must be between 0 and 1");
  }
  return args;
}

const digest = (text) => createHash("sha256").update(text).digest("hex");

function repoPath(path) {
  const rel = relative(ROOT, path);
  return rel.startsWith("..") ? basename(path) : rel;
}

function writeArtifact(path, text, replace) {
  if (existsSync(path)) {
    const prior = readFileSync(path, "utf8");
    if (prior === text) return "unchanged";
    if (!replace) throw new Error(`${repoPath(path)} exists with different content; pass --replace explicitly`);
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
  return "written";
}

function exportSample(args) {
  if (!args.input || !args.outDir || !/^\d{4}-\d{2}-\d{2}$/.test(args.observedOn || "")) {
    throw new Error("export requires --input, --out-dir, and --observed-on YYYY-MM-DD");
  }
  const inputPath = resolve(args.input);
  const inputText = readFileSync(inputPath, "utf8");
  const input = JSON.parse(inputText);
  if (!Array.isArray(input.audit_population)) {
    throw new Error("input component report does not contain audit_population");
  }
  const { sample, receipt: baseReceipt } = buildEntityAuditSample(input.audit_population, args);
  const outDir = resolve(args.outDir);
  const samplePath = join(outDir, "audit_sample.jsonl");
  const labelPath = join(outDir, "label_sheet.csv");
  const receiptPath = join(outDir, "receipt.json");
  const receipt = {
    ...baseReceipt,
    observed_on: args.observedOn,
    input: {
      kind: input.kind,
      path: repoPath(inputPath),
      sha256: digest(inputText),
      schema_version: input.schema_version,
      matcher_version: input.matcher_version,
      population_size: input.audit_population.length,
      pairwise_metrics: input.pairwise_metrics || null,
      entity_metrics: input.metrics || null,
    },
  };
  const sampleText = formatEntityAuditJsonl(sample, receipt);
  const labelText = formatEntityAuditLabelSheet(sample);
  receipt.artifacts = {
    sample: { path: repoPath(samplePath), sha256: digest(sampleText) },
    label_sheet: { path: repoPath(labelPath), sha256: digest(labelText) },
    receipt: { path: repoPath(receiptPath) },
  };
  const artifacts = [
    [samplePath, sampleText],
    [labelPath, labelText],
    [receiptPath, `${JSON.stringify(receipt, null, 2)}\n`],
  ];
  for (const [path, text] of artifacts) {
    console.log(`${writeArtifact(path, text, args.replace)} ${repoPath(path)}`);
  }
}

function exportRateSummary(args) {
  if (!args.summarize || !args.summaryOut) {
    throw new Error("summary mode requires --summarize and --summary-out");
  }
  const labels = readFileSync(resolve(args.summarize), "utf8");
  const report = summarizeEntityAuditRates(labels, { minReviewedPerStratum: args.minReviewedPerStratum });
  const out = resolve(args.summaryOut);
  console.log(`${writeArtifact(out, `${JSON.stringify(report, null, 2)}\n`, args.replace)} ${repoPath(out)}`);
}

try {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) usage();
  else if (args.summarize || args.summaryOut) exportRateSummary(args);
  else exportSample(args);
} catch (error) {
  usage(error.message);
}
