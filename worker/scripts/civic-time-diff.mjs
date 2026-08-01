#!/usr/bin/env node
/**
 * Deterministic semantic diff over civic-time fixtures.
 *
 * Usage:
 *   node worker/scripts/civic-time-diff.mjs --fixtures worker/test/fixtures/civic-time
 *   node worker/scripts/civic-time-diff.mjs --fixtures worker/test/fixtures/civic-time --check
 *
 * --check compares stdout-normalized JSON to expected_semantic_diff.json
 */
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  mapFixtureDoc,
  publicDiff,
  semanticDiff,
} from "../src/lib/civic_time.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");

function parseArgs(argv) {
  const args = { fixtures: null, check: false, writeExpected: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--fixtures") args.fixtures = argv[++i];
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

function runDiff(fixtureDir) {
  const money = mapFixtureDoc(loadJson(join(fixtureDir, "money_award.json")));
  const rules = mapFixtureDoc(loadJson(join(fixtureDir, "rules_comment_open.json")));
  const rulesRevisedDoc = loadJson(join(fixtureDir, "rules_comment_revised.json"));
  const priorComment = rules.find((e) => e.event_kind === "rules.comment_close");
  const rulesRevised = mapFixtureDoc({
    ...rulesRevisedDoc,
    assertions: rulesRevisedDoc.assertions.map((a) =>
      a.event_kind === "rules.comment_close"
        ? { ...a, supersedes_event_id: priorComment.event_id }
        : a,
    ),
  });
  const land = mapFixtureDoc(loadJson(join(fixtureDir, "land_zap_milestone.json")));
  const meetings = mapFixtureDoc(loadJson(join(fixtureDir, "meetings_council.json")));

  // Baseline projection: all four lenses at first revision.
  const previous = [...money, ...rules, ...land, ...meetings];
  // Current: money/land/meetings unchanged; rules comment deadline revised.
  const current = [...money, ...rulesRevised, ...land, ...meetings];

  return publicDiff(semanticDiff(previous, current));
}

function main() {
  const args = parseArgs(process.argv);
  if (args.help || !args.fixtures) {
    process.stdout.write(
      "Usage: node worker/scripts/civic-time-diff.mjs --fixtures <dir> [--check] [--write-expected]\n",
    );
    process.exit(args.help ? 0 : 2);
  }

  const fixtureDir = resolve(ROOT, args.fixtures);
  const files = readdirSync(fixtureDir).filter((f) => f.endsWith(".json"));
  if (!files.includes("money_award.json")) {
    throw new Error(`fixtures dir missing money_award.json: ${fixtureDir}`);
  }

  const diff = runDiff(fixtureDir);
  const text = stableStringify(diff);
  const expectedPath = join(fixtureDir, "expected_semantic_diff.json");

  if (args.writeExpected) {
    writeFileSync(expectedPath, text);
    process.stderr.write(`wrote ${expectedPath}\n`);
  }

  if (args.check) {
    const expected = readFileSync(expectedPath, "utf8");
    if (expected !== text) {
      process.stderr.write("civic-time-diff --check FAILED: output differs from expected_semantic_diff.json\n");
      process.stderr.write("--- expected length " + expected.length + " got " + text.length + " ---\n");
      process.exit(1);
    }
    process.stdout.write("civic-time-diff --check OK\n");
    process.exit(0);
  }

  process.stdout.write(text);
}

try {
  main();
} catch (err) {
  process.stderr.write(`civic-time-diff error: ${err.message || err}\n`);
  process.exit(1);
}
