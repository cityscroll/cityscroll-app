#!/usr/bin/env node
// Fixture-only export of privacy-safe review actions into gold-ready candidates.
// Never overwrites gold_vN.jsonl. Live D1 reads are intentionally out of scope for this tool.

import {
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  exportReviewActionsToGoldCases,
  formatReviewActionGoldJsonl,
} from "../entity_resolution/eval/review_action_export.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_FIXTURE = join(ROOT, "entity_resolution/eval/fixtures/review_actions_v0.json");

function publicPath(path) {
  const rel = relative(ROOT, resolve(path));
  return rel && !rel.startsWith("..") ? rel.replaceAll("\\", "/") : "fixture";
}

function usage(message) {
  if (message) console.error(`error: ${message}`);
  console.error(`Usage:
  node tools/export_review_actions_to_gold.mjs --fixtures [--check] [--out-dir <dir>] [--gold-version vN]

Options:
  --fixtures                 use the committed characterization fixture
  --check                    validate the export without writing files
  --input <path.json>        alternate fixture with a top-level "rows" array
  --out-dir <directory>      write candidates.jsonl + receipt.json (default: stdout only)
  --gold-version vN          target gold series label in the receipt (default v-next)
  --exported-on YYYY-MM-DD
  --json                     print the full export object to stdout`);
  process.exitCode = message ? 1 : 0;
}

function parseArgs(argv) {
  const args = {
    fixtures: false,
    check: false,
    input: null,
    outDir: null,
    goldVersion: "v-next",
    exportedOn: new Date().toISOString().slice(0, 10),
    json: false,
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") args.help = true;
    else if (arg === "--fixtures") args.fixtures = true;
    else if (arg === "--check") args.check = true;
    else if (arg === "--json") args.json = true;
    else if (arg === "--input") args.input = argv[++i];
    else if (arg === "--out-dir") args.outDir = argv[++i];
    else if (arg === "--gold-version") args.goldVersion = argv[++i];
    else if (arg === "--exported-on") args.exportedOn = argv[++i];
    else {
      usage(`unknown argument ${arg}`);
      return null;
    }
  }
  return args;
}

function loadRows(args) {
  const path = args.input
    ? resolve(args.input)
    : args.fixtures
      ? DEFAULT_FIXTURE
      : null;
  if (!path) {
    usage("provide --fixtures or --input <path.json>");
    return null;
  }
  const payload = JSON.parse(readFileSync(path, "utf8"));
  const rows = Array.isArray(payload) ? payload : payload.rows;
  if (!Array.isArray(rows)) {
    usage("fixture must be an array or an object with a rows array");
    return null;
  }
  return { path, rows };
}

function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (!args) return;
  if (args.help) {
    usage();
    return;
  }
  const loaded = loadRows(args);
  if (!loaded) return;
  if (args.check && args.outDir) {
    usage("--check cannot be combined with --out-dir");
    return;
  }

  const exported = exportReviewActionsToGoldCases(loaded.rows, {
    goldVersion: args.goldVersion,
    exportedOn: args.exportedOn,
  });
  exported.receipt.input_path = publicPath(loaded.path);
  exported.receipt.fixture_mode = true;

  if (args.check) {
    const formatted = formatReviewActionGoldJsonl(exported.cases, exported.receipt);
    const lines = formatted.trimEnd().split("\n");
    const meta = JSON.parse(lines[0]);
    if (
      meta.kind !== "review_action_gold_candidates"
      || meta.case_count !== exported.cases.length
      || lines.length !== exported.cases.length + 1
      || meta.payload_sha256 !== exported.receipt.payload_sha256
    ) {
      console.error("error: gold candidate export invariant failed");
      process.exitCode = 1;
      return;
    }
  }

  if (args.outDir) {
    const outDir = resolve(args.outDir);
    mkdirSync(outDir, { recursive: true });
    const candidatesPath = join(outDir, "candidates.jsonl");
    const receiptPath = join(outDir, "receipt.json");
    writeFileSync(candidatesPath, formatReviewActionGoldJsonl(exported.cases, exported.receipt));
    writeFileSync(receiptPath, `${JSON.stringify(exported.receipt, null, 2)}\n`);
    console.log(`candidates=${candidatesPath}`);
    console.log(`receipt=${receiptPath}`);
  }

  if (args.json || !args.outDir) {
    if (args.json) {
      console.log(JSON.stringify(exported, null, 2));
    } else {
      console.log(`exportable_cases=${exported.receipt.exportable_cases}`);
      console.log(`skipped_rows=${exported.receipt.skipped_rows}`);
      console.log(`payload_sha256=${exported.receipt.payload_sha256}`);
      for (const item of exported.cases) {
        console.log(`case ${item.id} label=${item.label} action=${item.review_action_provenance.action_id}`);
      }
      for (const item of exported.skipped) {
        console.log(`skip reason=${item.reason} action=${item.action_id || "-"}`);
      }
    }
  }
}

main();
