#!/usr/bin/env node
// MAPE intelligence flywheel (fixture mode):
//   Monitor  — committed inventories + pure validators
//   Analyze  — buildIntelligenceReceipt metrics
//   Plan     — planEnrichmentCards (P3+ only)
//   Execute  — write cards + receipt under --emit-cards (no agent dispatch here)
//
// Re-run after enrichment merges to re-measure. Does not mutate production state.

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import {
  attachCards,
  buildIntelligenceReceipt,
  planEnrichmentCards,
  renderCardMarkdown,
} from "../ontology/flywheel.mjs";
import { checkOntologyRegistrySync } from "../ontology/sync.mjs";
import { validateCrossSpineFixtures } from "../ontology/cross_spine.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);

function usage(message) {
  if (message) console.error(`error: ${message}`);
  console.error(`Usage:
  node tools/intelligence_flywheel.mjs --fixture --emit-cards <dir> [options]

Options:
  --with-er-metrics     run gold ER metrics (slower)
  --generated-at ISO    pin receipt timestamp (default fixed epoch for determinism)
  --json                print full receipt
  --check               require receipt.json in emit dir to match (deterministic gate)

Emits:
  <dir>/receipt.json
  <dir>/cards/*.md
  <dir>/cards.jsonl`);
  process.exitCode = message ? 1 : 0;
}

function parseArgs(argv) {
  const args = {
    fixture: false,
    emitCards: null,
    withErMetrics: false,
    generatedAt: "1970-01-01T00:00:00.000Z",
    json: false,
    check: false,
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--fixture") args.fixture = true;
    else if (a === "--emit-cards") args.emitCards = resolve(argv[++i]);
    else if (a === "--with-er-metrics") args.withErMetrics = true;
    else if (a === "--generated-at") args.generatedAt = argv[++i];
    else if (a === "--json") args.json = true;
    else if (a === "--check") args.check = true;
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
    const m = line.match(
      /^(precision|recall|candidate_recall|unresolved_rate|false_merge|false_split)=(.+)$/,
    );
    if (m) metrics[m[1]] = Number(m[2]);
  }
  return metrics;
}

export function runFlywheelFixture(opts = {}) {
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

  let receipt = buildIntelligenceReceipt({
    mode: "fixture",
    generated_at: opts.generatedAt || "1970-01-01T00:00:00.000Z",
    source_coverage,
    gap_taxonomy,
    er_metrics,
    cross_spine,
    actionability,
    registry_sync,
  });

  const cards = planEnrichmentCards({
    receipt,
    source_coverage,
    gap_taxonomy,
    registry_sync,
    cross_spine,
  });
  receipt = attachCards(receipt, cards);
  return { receipt, cards, registry_sync };
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
    usage("require --fixture");
    return;
  }
  if (!args.emitCards) {
    usage("require --emit-cards <dir>");
    return;
  }

  const { receipt, cards, registry_sync } = runFlywheelFixture({
    withErMetrics: args.withErMetrics,
    generatedAt: args.generatedAt,
  });

  if (!registry_sync.ok) {
    console.error(`registry sync failed: ${registry_sync.summary}`);
    process.exitCode = 1;
  }

  mkdirSync(args.emitCards, { recursive: true });
  const cardsDir = join(args.emitCards, "cards");
  mkdirSync(cardsDir, { recursive: true });
  for (const name of readdirSync(cardsDir)) {
    if (name.endsWith(".md")) unlinkSync(join(cardsDir, name));
  }

  const receiptPath = join(args.emitCards, "receipt.json");
  const cardsJsonlPath = join(args.emitCards, "cards.jsonl");
  const receiptText = `${JSON.stringify(receipt, null, 2)}\n`;
  const cardsJsonl = `${cards.map((c) => JSON.stringify(c)).join("\n")}${cards.length ? "\n" : ""}`;

  if (args.check) {
    if (!existsSync(receiptPath)) {
      console.error("flywheel --check requires existing receipt.json");
      process.exitCode = 1;
      return;
    }
    if (readFileSync(receiptPath, "utf8") !== receiptText) {
      console.error("flywheel receipt drift vs existing receipt.json");
      process.exitCode = 1;
      if (args.json) process.stdout.write(receiptText);
      return;
    }
  } else {
    writeFileSync(receiptPath, receiptText);
    writeFileSync(cardsJsonlPath, cardsJsonl);
    for (const card of cards) {
      const safe = card.id.replace(/[^a-zA-Z0-9._-]+/g, "_");
      writeFileSync(
        join(cardsDir, `${String(card.rank).padStart(2, "0")}-${safe}.md`),
        renderCardMarkdown(card),
      );
    }
  }

  if (args.json) process.stdout.write(receiptText);
  else {
    console.log(
      `flywheel cards=${cards.length} coverage=${receipt.metrics.source_coverage_rate} class_a=${receipt.metrics.gap_class_a_open} hash=${receipt.provenance.content_hash} out=${args.emitCards}`,
    );
    for (const card of cards.slice(0, 5)) {
      console.log(`  #${card.rank} [${card.class}] ${card.id}`);
    }
    if (cards.length > 5) console.log(`  … ${cards.length - 5} more`);
  }
}

main();
