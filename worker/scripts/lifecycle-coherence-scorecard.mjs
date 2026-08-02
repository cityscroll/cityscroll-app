#!/usr/bin/env node
/**
 * Scorecard CLI for procurement_lifecycle_coherence_rate and
 * award_solicitation_recovery_rate.
 *
 * Usage:
 *   node worker/scripts/lifecycle-coherence-scorecard.mjs
 *   node worker/scripts/lifecycle-coherence-scorecard.mjs --fixtures worker/test/fixtures/lifecycle-coherence --check
 *   node worker/scripts/lifecycle-coherence-scorecard.mjs --fixtures worker/test/fixtures/lifecycle-coherence --write-expected
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  measureAwardSolicitationRecoveryRate,
  measureProcurementLifecycleCoherenceRate,
} from "../src/lib/lifecycle_coherence.mjs";
import { buildProcurementCoherenceCases } from "../test/fixtures/lifecycle-coherence/build_cases.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");

function round4(n) {
  return Math.round(Number(n) * 10000) / 10000;
}

function scorecardFromCases(cases) {
  const measured = measureProcurementLifecycleCoherenceRate(cases);
  const recovery = measureAwardSolicitationRecoveryRate(cases);
  return {
    metric: measured.metric,
    version: measured.version,
    eligible: measured.eligible,
    coherent: measured.coherent,
    procurement_lifecycle_coherence_rate: round4(measured.rate),
    issue_counts: measured.issue_counts,
    award_solicitation_recovery_rate: round4(recovery.rate),
    award_solicitation_recovery: {
      eligible: recovery.eligible,
      recovered: recovery.recovered,
      by_source: recovery.by_source,
    },
    cases: measured.cases.map((c) => ({
      id: c.id,
      eligible: c.eligible,
      coherent: c.coherent,
      issue_kinds: c.issue_kinds || [],
    })),
  };
}

function parseArgs(argv) {
  const args = { fixtures: null, check: false, writeExpected: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--check") args.check = true;
    else if (a === "--write-expected") args.writeExpected = true;
    else if (a === "--fixtures") {
      args.fixtures = argv[i + 1];
      i += 1;
    }
  }
  return args;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const fixtureDir = args.fixtures
    ? resolve(process.cwd(), args.fixtures)
    : join(ROOT, "worker/test/fixtures/lifecycle-coherence");

  const cases = buildProcurementCoherenceCases();
  const scorecard = scorecardFromCases(cases);
  const expectedPath = join(fixtureDir, "expected_coherence.json");

  if (args.writeExpected) {
    writeFileSync(expectedPath, `${JSON.stringify(scorecard, null, 2)}\n`);
    process.stdout.write(`wrote ${expectedPath}\n`);
    return;
  }

  if (args.check) {
    let expected;
    try {
      expected = JSON.parse(readFileSync(expectedPath, "utf8"));
    } catch (err) {
      process.stderr.write(
        `lifecycle-coherence-scorecard --check FAILED: cannot read ${expectedPath}: ${err.message}\n`,
      );
      process.exitCode = 1;
      return;
    }
    const a = JSON.stringify(scorecard);
    const b = JSON.stringify(expected);
    if (a !== b) {
      process.stderr.write(
        "lifecycle-coherence-scorecard --check FAILED: output differs from expected_coherence.json\n",
      );
      process.stderr.write(`got:  ${a}\n`);
      process.stderr.write(`want: ${b}\n`);
      process.exitCode = 1;
      return;
    }
    if (!(scorecard.procurement_lifecycle_coherence_rate >= 0
      && scorecard.procurement_lifecycle_coherence_rate <= 1)) {
      process.stderr.write(
        `lifecycle-coherence-scorecard --check FAILED: rate out of range ${scorecard.procurement_lifecycle_coherence_rate}\n`,
      );
      process.exitCode = 1;
      return;
    }
    if (!(scorecard.eligible > 0) || !(scorecard.procurement_lifecycle_coherence_rate < 1)) {
      process.stderr.write(
        "lifecycle-coherence-scorecard --check FAILED: expected mixed fixture set (eligible>0 and rate<1)\n",
      );
      process.exitCode = 1;
      return;
    }
    if (!(scorecard.award_solicitation_recovery_rate > 0
      && scorecard.award_solicitation_recovery_rate < 1)) {
      process.stderr.write(
        "lifecycle-coherence-scorecard --check FAILED: expected recovery rate in (0,1)\n",
      );
      process.exitCode = 1;
      return;
    }
    process.stdout.write(
      `lifecycle-coherence-scorecard --check OK procurement_lifecycle_coherence_rate=${scorecard.procurement_lifecycle_coherence_rate} award_solicitation_recovery_rate=${scorecard.award_solicitation_recovery_rate} eligible=${scorecard.eligible} coherent=${scorecard.coherent}\n`,
    );
    return;
  }

  process.stdout.write(`${JSON.stringify(scorecard, null, 2)}\n`);
}

main();
