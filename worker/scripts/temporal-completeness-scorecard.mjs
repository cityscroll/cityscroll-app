#!/usr/bin/env node
/**
 * Temporal completeness scorecard over civic-time fixtures (+ optional source contracts).
 *
 * Named metric: temporal_completeness_rate
 *   mean over events of (filled clock families / 4)
 *   clock families: event (valid_at|range), publication, observed, processed
 *
 * Usage:
 *   node worker/scripts/temporal-completeness-scorecard.mjs --fixtures worker/test/fixtures/civic-time
 *   node worker/scripts/temporal-completeness-scorecard.mjs --fixtures worker/test/fixtures/civic-time --check
 *   node worker/scripts/temporal-completeness-scorecard.mjs --fixtures worker/test/fixtures/civic-time --write-expected
 */
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  mapFixtureDoc,
  sourceHealthFromContracts,
  temporalCompletenessScorecard,
} from "../src/lib/civic_time.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");

const FIXTURE_FILES = [
  "money_award.json",
  "rules_comment_open.json",
  "land_zap_milestone.json",
  "meetings_council.json",
];

function parseArgs(argv) {
  const args = { fixtures: null, check: false, writeExpected: false, contracts: null };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--fixtures") args.fixtures = argv[++i];
    else if (a === "--contracts") args.contracts = argv[++i];
    else if (a === "--check") args.check = true;
    else if (a === "--write-expected") args.writeExpected = true;
    else if (a === "--help" || a === "-h") args.help = true;
    else throw new Error(`unknown argument: ${a}`);
  }
  return args;
}

function loadJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function stableStringify(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

/** Drop volatile action prose from gaps for byte-stable --check (kinds + rates stay). */
function publicScorecard(scorecard) {
  return {
    metric: scorecard.metric,
    schema_version: scorecard.schema_version,
    event_count: scorecard.event_count,
    temporal_completeness_rate: round4(scorecard.temporal_completeness_rate),
    full_clock_rate: round4(scorecard.full_clock_rate),
    clock_fill_rates: roundRates(scorecard.clock_fill_rates),
    clock_fill_counts: scorecard.clock_fill_counts,
    spines: Object.fromEntries(
      Object.entries(scorecard.spines)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([spine, row]) => [
          spine,
          {
            event_count: row.event_count,
            temporal_completeness_rate: round4(row.temporal_completeness_rate),
            clock_fill_rates: roundRates(row.clock_fill_rates),
            clock_fill_counts: row.clock_fill_counts,
            kinds: row.kinds,
            source_contracts: row.source_contracts,
            live_source_count: row.live_source_count,
            disabled_source_count: row.disabled_source_count,
            source_health: row.source_health.map((h) => ({
              id: h.id,
              status: h.status,
              health: h.health,
            })),
          },
        ]),
    ),
    gaps: scorecard.gaps.map((g) => ({
      spine: g.spine,
      clock: g.clock,
      fill_rate: round4(g.fill_rate),
      filled: g.filled,
      event_count: g.event_count,
      kind: g.kind,
    })),
    gap_count: scorecard.gap_count,
  };
}

function round4(n) {
  return Math.round(Number(n) * 1e4) / 1e4;
}

function roundRates(rates) {
  const out = {};
  for (const [k, v] of Object.entries(rates || {})) out[k] = round4(v);
  return out;
}

function runScorecard(fixtureDir, contractsPath) {
  const events = [];
  for (const name of FIXTURE_FILES) {
    const path = join(fixtureDir, name);
    events.push(...mapFixtureDoc(loadJson(path)));
  }
  let source_health = {};
  if (contractsPath) {
    const doc = loadJson(contractsPath);
    source_health = sourceHealthFromContracts(doc.contracts || []);
  }
  return publicScorecard(temporalCompletenessScorecard(events, { source_health }));
}

function main() {
  const args = parseArgs(process.argv);
  if (args.help || !args.fixtures) {
    process.stdout.write(
      "Usage: node worker/scripts/temporal-completeness-scorecard.mjs --fixtures <dir> [--contracts site/data/source_contracts.json] [--check] [--write-expected]\n",
    );
    process.exit(args.help ? 0 : 2);
  }

  const fixtureDir = resolve(ROOT, args.fixtures);
  const files = readdirSync(fixtureDir).filter((f) => f.endsWith(".json"));
  for (const required of FIXTURE_FILES) {
    if (!files.includes(required)) {
      throw new Error(`fixtures dir missing ${required}: ${fixtureDir}`);
    }
  }

  const contractsPath = args.contracts
    ? resolve(ROOT, args.contracts)
    : join(ROOT, "site/data/source_contracts.json");

  const scorecard = runScorecard(fixtureDir, contractsPath);
  const text = stableStringify(scorecard);
  const expectedPath = join(fixtureDir, "expected_temporal_completeness.json");

  if (args.writeExpected) {
    writeFileSync(expectedPath, text);
    process.stderr.write(`wrote ${expectedPath}\n`);
  }

  if (args.check) {
    const expected = readFileSync(expectedPath, "utf8");
    if (expected !== text) {
      process.stderr.write(
        "temporal-completeness-scorecard --check FAILED: output differs from expected_temporal_completeness.json\n",
      );
      process.stderr.write(`--- expected length ${expected.length} got ${text.length} ---\n`);
      process.exit(1);
    }
    // Gate: headline metric must stay measurable and non-zero on fixtures.
    if (!(scorecard.temporal_completeness_rate > 0)) {
      process.stderr.write(
        `temporal-completeness-scorecard --check FAILED: temporal_completeness_rate=${scorecard.temporal_completeness_rate}\n`,
      );
      process.exit(1);
    }
    process.stdout.write(
      `temporal-completeness-scorecard --check OK temporal_completeness_rate=${scorecard.temporal_completeness_rate}\n`,
    );
    process.exit(0);
  }

  process.stdout.write(text);
}

try {
  main();
} catch (err) {
  process.stderr.write(`temporal-completeness-scorecard error: ${err.message || err}\n`);
  process.exit(1);
}
