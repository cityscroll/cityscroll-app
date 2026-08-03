#!/usr/bin/env node
/**
 * Domain-generic backtest scorecard for cityscroll.prediction.v0 assertions.
 *
 * Usage:
 *   node worker/scripts/prediction-calibration-scorecard.mjs
 *   node worker/scripts/prediction-calibration-scorecard.mjs --fixtures worker/test/fixtures/predictions --check
 *   node worker/scripts/prediction-calibration-scorecard.mjs --fixtures worker/test/fixtures/predictions --write-expected
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  PREDICTION_CALIBRATION_VERSION,
  evaluatePredictionBacktest,
} from "../src/lib/prediction_calibration.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");

function parseArgs(argv) {
  const args = { fixtures: null, check: false, writeExpected: false, help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--check") args.check = true;
    else if (arg === "--write-expected") args.writeExpected = true;
    else if (arg === "--fixtures") {
      if (!argv[index + 1]) throw new Error("--fixtures requires a directory");
      args.fixtures = argv[index + 1];
      index += 1;
    } else if (arg === "--help" || arg === "-h") args.help = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (args.check && args.writeExpected) {
    throw new Error("--check and --write-expected are mutually exclusive");
  }
  return args;
}

function stableStringify(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

async function loadFixtures(fixtureDir) {
  const modulePath = join(fixtureDir, "build_cases.mjs");
  let fixtureModule;
  try {
    fixtureModule = await import(pathToFileURL(modulePath));
  } catch (error) {
    throw new Error(`cannot load ${modulePath}: ${error.message}`);
  }
  if (typeof fixtureModule.buildPredictionCalibrationFixtures !== "function") {
    throw new Error(`${modulePath} must export buildPredictionCalibrationFixtures()`);
  }
  const fixtures = fixtureModule.buildPredictionCalibrationFixtures();
  if (!Array.isArray(fixtures) || !fixtures.length) {
    throw new Error("prediction fixtures must be a non-empty array");
  }
  return fixtures;
}

function buildScorecard(fixtures) {
  const seenIds = new Set();
  const cases = fixtures.map((fixture) => {
    const id = String(fixture?.id || "").trim();
    if (!id) throw new Error("every prediction fixture requires an id");
    if (seenIds.has(id)) throw new Error(`duplicate prediction fixture id: ${id}`);
    seenIds.add(id);
    if (!["pass", "fail"].includes(fixture.expected_ship_bar)) {
      throw new Error(`fixture ${id} expected_ship_bar must be pass or fail`);
    }
    return {
      id,
      expected_ship_bar: fixture.expected_ship_bar,
      scorecard: evaluatePredictionBacktest(fixture.backtest),
    };
  });
  return {
    metric: "prediction_calibration_scorecard",
    version: PREDICTION_CALIBRATION_VERSION,
    cases,
    fixture_gate: {
      calibrated_model_passes: cases.some((row) => row.expected_ship_bar === "pass"
        && row.scorecard.ship_bar.status === "pass"),
      miscalibrated_model_fails: cases.some((row) => row.expected_ship_bar === "fail"
        && row.scorecard.ship_bar.status === "fail"),
      expectations_match: cases.every((row) => row.expected_ship_bar === row.scorecard.ship_bar.status),
    },
  };
}

function fixtureGatePasses(scorecard) {
  return Object.values(scorecard.fixture_gate).every(Boolean);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(
      "Usage: node worker/scripts/prediction-calibration-scorecard.mjs [--fixtures <dir>] [--check] [--write-expected]\n",
    );
    return;
  }

  const fixtureDir = args.fixtures
    ? resolve(ROOT, args.fixtures)
    : join(ROOT, "worker/test/fixtures/predictions");
  const fixtures = await loadFixtures(fixtureDir);
  const scorecard = buildScorecard(fixtures);
  const text = stableStringify(scorecard);
  const expectedPath = join(fixtureDir, "expected_calibration.json");

  if (args.writeExpected) {
    writeFileSync(expectedPath, text);
    process.stdout.write(`wrote ${expectedPath}\n`);
    return;
  }

  if (args.check) {
    let expected;
    try {
      expected = readFileSync(expectedPath, "utf8");
    } catch (error) {
      process.stderr.write(
        `prediction-calibration-scorecard --check FAILED: cannot read ${expectedPath}: ${error.message}\n`,
      );
      process.exitCode = 1;
      return;
    }
    if (expected !== text) {
      process.stderr.write(
        "prediction-calibration-scorecard --check FAILED: output differs from expected_calibration.json\n",
      );
      process.stderr.write(`--- expected length ${expected.length} got ${text.length} ---\n`);
      process.exitCode = 1;
      return;
    }
    if (!fixtureGatePasses(scorecard)) {
      process.stderr.write(
        `prediction-calibration-scorecard --check FAILED: fixture gate ${JSON.stringify(scorecard.fixture_gate)}\n`,
      );
      process.exitCode = 1;
      return;
    }
    process.stdout.write(
      `prediction-calibration-scorecard --check OK ${scorecard.cases
        .map((row) => `${row.id}=${row.scorecard.ship_bar.status}`)
        .join(" ")}\n`,
    );
    return;
  }

  process.stdout.write(text);
}

try {
  await main();
} catch (error) {
  process.stderr.write(`prediction-calibration-scorecard error: ${error.message || error}\n`);
  process.exitCode = 1;
}
