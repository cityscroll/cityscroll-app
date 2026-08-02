#!/usr/bin/env node
// Build a cityscroll.intelligence_receipt.v0 from committed inventories (fixture mode).

import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { buildIntelligenceReceipt } from "../ontology/flywheel.mjs";
import { checkOntologyRegistrySync } from "../ontology/sync.mjs";
import { validateCrossSpineFixtures } from "../ontology/cross_spine.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);

function usage(message) {
  if (message) console.error(`error: ${message}`);
  console.error(`Usage:
  node tools/intelligence_receipt.mjs --fixture [--out <path>] [--check] [--json] [--with-er-metrics]

Fixture mode reads committed source_coverage + gap_taxonomy and pure registry/cross-spine checks.
Does not write production state.`);
  process.exitCode = message ? 1 : 0;
}

function parseArgs(argv) {
  const args = {
    fixture: false,
    out: null,
    check: false,
    json: false,
    withErMetrics: false,
    help: false,
    generatedAt: "1970-01-01T00:00:00.000Z",
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--fixture") args.fixture = true;
    else if (a === "--out") args.out = resolve(argv[++i]);
    else if (a === "--check") args.check = true;
    else if (a === "--json") args.json = true;
    else if (a === "--with-er-metrics") args.withErMetrics = true;
    else if (a === "--generated-at") args.generatedAt = argv[++i];
    else if (a === "--help" || a === "-h") args.help = true;
    else throw new Error(`unknown argument: ${a}`);
  }
  return args;
}

function readJson(rel) {
  return JSON.parse(readFileSync(join(ROOT, rel), "utf8"));
}

function loadCrossSpineSummary() {
  const dir = join(ROOT, "ontology/fixtures/cross_spine");
  if (!existsSync(dir)) return { checked: 0, contradictions: 0 };
  const bundles = readdirSync(dir)
    .filter((n) => n.endsWith(".json") && !n.startsWith("fail_"))
    .sort()
    .map((n) => JSON.parse(readFileSync(join(dir, n), "utf8")));
  const report = validateCrossSpineFixtures(bundles);
  return { checked: report.checked, contradictions: report.contradictions };
}

function runErMetrics() {
  const result = spawnSync(
    process.execPath,
    [
      join(ROOT, "entity_resolution/eval/run_metrics.mjs"),
      "--gold",
      join(ROOT, "entity_resolution/eval/gold_v0.jsonl"),
      "--blocker",
      "token_v0",
    ],
    { encoding: "utf8", cwd: ROOT },
  );
  if (result.status !== 0) {
    throw new Error(`run_metrics failed: ${result.stderr || result.stdout}`);
  }
  const metrics = {};
  for (const line of String(result.stdout || "").split("\n")) {
    const m = line.match(/^(precision|recall|candidate_recall|unresolved_rate|false_merge|false_split)=(.+)$/);
    if (m) metrics[m[1]] = Number(m[2]);
  }
  return metrics;
}

export function buildFixtureReceipt(opts = {}) {
  const source_coverage = readJson("entity_resolution/source_coverage.json");
  const gap_taxonomy = readJson("site/data/gap_taxonomy.json");
  const registry_sync = checkOntologyRegistrySync();
  const cross_spine = loadCrossSpineSummary();
  const er_metrics = opts.withErMetrics ? runErMetrics() : null;

  const actions = require(join(ROOT, "site/action_registry.js"));
  const readerCount = (actions.ACTION_TYPES || []).length;
  const actionability = {
    sample_size: readerCount,
    actionable: readerCount,
    rate: readerCount > 0 ? 1 : 0,
  };

  return buildIntelligenceReceipt({
    mode: "fixture",
    generated_at: opts.generatedAt || "1970-01-01T00:00:00.000Z",
    source_coverage,
    gap_taxonomy,
    er_metrics,
    cross_spine,
    actionability,
    registry_sync,
  });
}

function main(argv = process.argv.slice(2)) {
  let args;
  try {
    args = parseArgs(argv);
  } catch (error) {
    usage(error.message);
    return;
  }
  if (args.help) {
    usage();
    return;
  }
  if (!args.fixture) {
    usage("require --fixture (live mode not implemented in v0)");
    return;
  }

  const receipt = buildFixtureReceipt({
    withErMetrics: args.withErMetrics,
    generatedAt: args.generatedAt,
  });
  const text = `${JSON.stringify(receipt, null, 2)}\n`;

  if (args.out) {
    if (args.check && existsSync(args.out)) {
      if (readFileSync(args.out, "utf8") !== text) {
        console.error("intelligence receipt drift vs --out");
        process.exitCode = 1;
        if (args.json) process.stdout.write(text);
        return;
      }
    } else {
      writeFileSync(args.out, text);
    }
  }

  if (args.json) process.stdout.write(text);
  else {
    console.log(
      `intelligence_receipt schema=${receipt.schema} coverage=${receipt.metrics.source_coverage_rate} class_a=${receipt.metrics.gap_class_a_open} registry_ok=${receipt.metrics.registry_sync_ok} hash=${receipt.provenance.content_hash}`,
    );
  }
}

main();
