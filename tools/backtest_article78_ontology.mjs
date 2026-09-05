#!/usr/bin/env node

/**
 * A78-01 offline backtest.
 *
 * Runs the litigation-ontology derivations over the committed synthetic
 * fixture at `warehouse/fixtures/article78/` and compares the whole result
 * against the expected outputs committed next to it. Any mismatch is a
 * non-zero exit; there is no tolerance, no clock and no network.
 *
 * The six scenarios exist to pin the five ways a challenge-watch value comes
 * out over a determination, and the one way a decision can be undone:
 *
 *   located_challenge               an adequate search located one challenge
 *   adequate_search_zero_challenges an adequate search found nothing -- a real
 *                                   zero, attached to the search that produced it
 *   nonfinal_determination          the challenge window has not opened -> null
 *   inadequate_coverage             the recorded search is too narrow -> null
 *   open_limitations_window         adequate in scope, premature in time -> null
 *   trial_decision_reversed         a trial annulment reversed on appeal, which
 *                                   must not still read as durable relief
 *
 * The receipt carries the fixture's own content hash, so editing the fixture
 * without regenerating the expected outputs fails here rather than quietly
 * changing what the gate asserts.
 *
 * Usage:
 *   node tools/backtest_article78_ontology.mjs           # check (the gate)
 *   node tools/backtest_article78_ontology.mjs --write   # regenerate expected
 */

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  applyDecisionSupersession,
  ARTICLE78_DECISION_FILING_TYPES,
  ARTICLE78_LITIGATION_SCHEMA,
  assertNoCombinedOutcomeScore,
  assertNoForbiddenChallengeWatchWording,
  challengeWatchValue,
  limitationsWindow,
  projectToOntologyEntities,
  renderChallengeWatchValue,
  validateArticle78RecordSet,
  validateDeterminationContext,
} from "../warehouse/lib/article78_litigation.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

export const BACKTEST_SCHEMA = "cityscroll.article78_litigation.backtest_receipt.v1";
export const FIXTURE_PATH = join(ROOT, "warehouse/fixtures/article78/litigation_backtest_fixture.v1.json");
export const EXPECTED_PATH = join(ROOT, "warehouse/fixtures/article78/litigation_backtest_expected.v1.json");

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function sha256Hex(text) {
  return createHash("sha256").update(text).digest("hex");
}

/**
 * Run every derivation over one fixture and return the receipt. Pure: the same
 * fixture always produces the same object, byte for byte once serialized.
 */
export function runArticle78Backtest(fixture) {
  const findings = validateArticle78RecordSet(fixture);
  for (const [index, determination] of fixture.determinations.entries()) {
    findings.push(...validateDeterminationContext(determination, `determination_context[${index}]`));
  }

  // A3, over the fixture's own field names rather than only over the spec: a
  // record set that smuggled in a combined outcome score would fail here even
  // if the validator's closed property set were later widened.
  const outcomeFieldNames = fixture.filings
    .filter((row) => row.decision)
    .flatMap((row) => Object.keys(row.decision));
  assertNoCombinedOutcomeScore([...new Set(outcomeFieldNames)], "backtest case outcomes");

  const challengeWatch = fixture.determinations.map((determination) => {
    const result = challengeWatchValue({
      determination,
      cases: fixture.cases,
      coverage: fixture.coverage,
    });
    return {
      determination_key: result.determination_key,
      value: result.value,
      reason: result.basis.reason,
      as_of: result.basis.as_of,
      coverage_keys: result.basis.coverage_keys,
      located_case_keys: result.basis.located_case_keys,
      limitations_window: limitationsWindow(determination),
      rendered: renderChallengeWatchValue(result),
    };
  });

  // A2: nothing this backtest renders may read as a fact about the world.
  assertNoForbiddenChallengeWatchWording(challengeWatch.map((row) => row.rendered), "backtest renderings");

  const decisions = fixture.filings.filter((row) => ARTICLE78_DECISION_FILING_TYPES.includes(row.filing_type));
  const effectiveDecisions = applyDecisionSupersession(decisions, fixture.supersessions);

  const projected = projectToOntologyEntities(fixture);

  return {
    schema: BACKTEST_SCHEMA,
    module_schema: ARTICLE78_LITIGATION_SCHEMA,
    fixture_schema: fixture.schema,
    record_set_findings: findings,
    counts: {
      determinations: fixture.determinations.length,
      searches: fixture.coverage.length,
      cases: fixture.cases.length,
      filings: fixture.filings.length,
      decisions: decisions.length,
      claims: fixture.claims.length,
      supersessions: fixture.supersessions.length,
    },
    challenge_watch: challengeWatch,
    effective_decisions: effectiveDecisions,
    projected_entity_counts: Object.fromEntries(
      Object.entries(projected).map(([entityType, rows]) => [entityType, rows.length]).sort(),
    ),
  };
}

function serialize(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

/** The first place the two documents differ, as a dotted path. */
function firstDifference(actual, expected, path = "$") {
  if (JSON.stringify(actual) === JSON.stringify(expected)) return null;
  if (Array.isArray(actual) && Array.isArray(expected)) {
    if (actual.length !== expected.length) return `${path}: length ${actual.length} != expected ${expected.length}`;
    for (const [index, item] of actual.entries()) {
      const diff = firstDifference(item, expected[index], `${path}[${index}]`);
      if (diff) return diff;
    }
  }
  if (actual && expected && typeof actual === "object" && typeof expected === "object" && !Array.isArray(actual)) {
    const keys = [...new Set([...Object.keys(actual), ...Object.keys(expected)])].sort();
    for (const key of keys) {
      const diff = firstDifference(actual[key], expected[key], `${path}.${key}`);
      if (diff) return diff;
    }
  }
  return `${path}: ${JSON.stringify(actual)} != expected ${JSON.stringify(expected)}`;
}

function main(argv) {
  const write = argv.includes("--write");
  const fixtureText = readFileSync(FIXTURE_PATH, "utf8");
  const fixture = JSON.parse(fixtureText);
  const receipt = { ...runArticle78Backtest(fixture), fixture_sha256: sha256Hex(fixtureText) };

  if (write) {
    writeFileSync(EXPECTED_PATH, serialize(receipt), "utf8");
    process.stdout.write(`article78 backtest: wrote expected outputs to warehouse/fixtures/article78/${EXPECTED_PATH.split("/").pop()}\n`);
    return 0;
  }

  const expected = readJson(EXPECTED_PATH);
  const mismatch = firstDifference(receipt, expected);
  const rows = receipt.challenge_watch.map((row) => `  ${row.value === null ? "null" : row.value}  ${row.reason.padEnd(46)} ${row.rendered}`);
  process.stdout.write([
    "article78 litigation ontology backtest",
    `  fixture      warehouse/fixtures/article78/litigation_backtest_fixture.v1.json (sha256 ${receipt.fixture_sha256.slice(0, 12)})`,
    `  records      ${Object.entries(receipt.counts).map(([name, count]) => `${name}=${count}`).join(" ")}`,
    `  validation   ${receipt.record_set_findings.length} finding(s)`,
    "  challenge watch:",
    ...rows,
    "  effective decisions:",
    ...receipt.effective_decisions.map((entry) => `  ${entry.case_key}\n    effective ${entry.effective_decision_key ?? "none"} (${entry.effective_decision_court_level ?? "n/a"})\n    procedural_survival=${entry.case_outcome.procedural_survival} durable_petitioner_relief=${entry.case_outcome.durable_petitioner_relief} remedy_exposure=${entry.case_outcome.remedy_exposure}\n    superseded ${entry.superseded_decision_keys.length}, unresolved ${entry.unresolved ?? "none"}`),
    "",
  ].join("\n"));

  if (receipt.record_set_findings.length > 0) {
    process.stderr.write(`article78 backtest FAILED: the fixture record set does not validate:\n  ${receipt.record_set_findings.join("\n  ")}\n`);
    return 1;
  }
  if (mismatch) {
    process.stderr.write(`article78 backtest FAILED: derived output does not match the committed expectation.\n  ${mismatch}\nRegenerate deliberately with: node tools/backtest_article78_ontology.mjs --write\n`);
    return 1;
  }
  process.stdout.write("article78 backtest OK: derived output matches the committed expectation.\n");
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exit(main(process.argv.slice(2)));
}
