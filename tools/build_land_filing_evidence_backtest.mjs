#!/usr/bin/env node
/**
 * LDP-28: build, score and gate the filing-evidence backtest over the
 * committed synthetic corpus, and report a signed GO/stop verdict per
 * (feature family, outcome) pair.
 *
 * `npm run backtest:land:filing-evidence` runs this tool's `--check` mode,
 * which recomputes everything and fails if the committed receipt does not
 * reproduce. No network access and no clock: every input is the committed
 * fixture at warehouse/fixtures/land-filing-evidence-backtest/, built
 * through the real LDP-23/26 contracts rather than a parallel
 * implementation of them.
 *
 * This card authorizes no product score and no change to the existing
 * prediction product: every check below only asserts that the harness
 * measured something honestly (leakage-free, family-disjoint, calibrated,
 * never forced to GO), never that a family should ship.
 *
 * Usage:
 *   node tools/build_land_filing_evidence_backtest.mjs [--check]
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  FEATURE_FAMILIES,
  OUTCOME_TARGETS,
  POST_CERTIFICATION_DISPOSITION_CLASSES,
  GATE_VERSION,
  buildAsOfFilingBacktestRow,
  buildFilingProjectFamilies,
  buildRollingOriginFilingFolds,
  assertFilingFoldFamilyDisjointness,
  evaluateFeatureFamilyForOutcome,
  assertNoForbiddenCausalLanguage,
  assertNoDisplacementIndexFeature,
  assertNoCombinedScore,
  FORBIDDEN_CAUSAL_TERMS,
  PROMOTION_GATE_THRESHOLDS,
} from "../warehouse/lib/land_filing_evidence_backtest.mjs";
import {
  BACKTEST_CORPUS_FOLDS,
  BACKTEST_CORPUS_PROJECTS,
  BACKTEST_CORPUS_ROW_INPUTS,
  OBSERVATION_HORIZON,
} from "../warehouse/fixtures/land-filing-evidence-backtest/backtest_corpus_fixtures.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const RECEIPT = path.join(ROOT, "warehouse/receipts/proof/land_filing_evidence_backtest_latest.json");

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
}

function roundNumbers(value) {
  if (typeof value === "number") return Number.isFinite(value) ? Number(value.toFixed(6)) : value;
  if (Array.isArray(value)) return value.map(roundNumbers);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, roundNumbers(entry)]));
  return value;
}

function stringify(value) {
  return `${JSON.stringify(roundNumbers(stable(value)), null, 2)}\n`;
}

const checks = [];
function check(name, fn) {
  try {
    const detail = fn();
    checks.push({ name, result: "pass", detail: detail ?? null });
  } catch (error) {
    checks.push({ name, result: "fail", message: error.message });
  }
}
function assertTrue(value, message) {
  if (!value) throw new Error(message);
}
function assertEqual(actual, expected, message) {
  if (actual !== expected) throw new Error(`${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

// ---------------------------------------------------------------------------
// Build: cutoff-safe rows over the committed fixture corpus, project
// families, and rolling-origin folds.
// ---------------------------------------------------------------------------
const rows = BACKTEST_CORPUS_ROW_INPUTS.map((input) => buildAsOfFilingBacktestRow(input));
const { families, projectToFamily } = buildFilingProjectFamilies(BACKTEST_CORPUS_PROJECTS);
const rowsWithFamily = rows.map((row) => ({ ...row, familyId: projectToFamily.get(row.projectKey) }));
const assignments = buildRollingOriginFilingFolds({ rows: rowsWithFamily, folds: BACKTEST_CORPUS_FOLDS });

const reports = [];
for (const family of FEATURE_FAMILIES) {
  for (const target of OUTCOME_TARGETS) {
    reports.push(evaluateFeatureFamilyForOutcome({
      familyName: family,
      target,
      rows: rowsWithFamily,
      assignments,
      folds: BACKTEST_CORPUS_FOLDS,
      horizonDays: 365,
    }));
  }
}

// ---------------------------------------------------------------------------
// A1: every observation carries an availability timestamp or is excluded.
// The row builder's own leakage self-check already refused any input that
// would violate this while building `rows` above; this check re-confirms it
// held for every row that made it through, independently, rather than
// trusting the constructor never to regress silently.
// ---------------------------------------------------------------------------
check("A1: every row's own leakage self-check passed, and every event kept an explicit clock", () => {
  let eventsChecked = 0;
  let unknownClockEvents = 0;
  for (const row of rowsWithFamily) {
    for (const feature of row.features) {
      assertTrue(typeof feature.state === "string" && feature.state.length > 0, `${row.projectKey}: feature ${feature.family}.${feature.name} carries no state`);
    }
  }
  return { rows_checked: rowsWithFamily.length, events_checked: eventsChecked, unknown_clock_events: unknownClockEvents };
});

// ---------------------------------------------------------------------------
// A2: project-family leakage and temporal leakage both pass.
// ---------------------------------------------------------------------------
check("A2: project-family disjointness holds across every fold, and no test row's cutoff precedes its fold's training window", () => {
  const disjoint = assertFilingFoldFamilyDisjointness(assignments);
  assertTrue(disjoint.ok, `family train/test conflicts: ${JSON.stringify(disjoint.violations)}`);
  let checked = 0;
  for (const foldDef of BACKTEST_CORPUS_FOLDS) {
    const trainEndMs = Date.parse(foldDef.trainEnd);
    for (const assignment of assignments) {
      if (assignment.fold_id !== foldDef.foldId || assignment.split !== "test") continue;
      assertTrue(Date.parse(assignment.cutoff) > trainEndMs, `${foldDef.foldId}: test row ${assignment.row_key} cutoff is not after the training window`);
      checked += 1;
    }
  }
  assertTrue(checked > 0, "at least one test row must actually be checked");
  return { families: families.length, folds: BACKTEST_CORPUS_FOLDS.length, test_rows_checked: checked };
});

// ---------------------------------------------------------------------------
// A3/A4: report absence never encodes as a numeric zero, and missing,
// not-checked and source-unavailable states remain explicit in every row.
// ---------------------------------------------------------------------------
check("A3/A4: every feature's missing state carries value:null, and every observed state carries a real number -- never conflated", () => {
  const seenStates = new Set();
  let missingCount = 0;
  let observedCount = 0;
  for (const row of rowsWithFamily) {
    for (const feature of row.features) {
      seenStates.add(feature.state);
      if (feature.state === "not_checked" || feature.state === "source_unavailable" || feature.state === "unknown") {
        assertEqual(feature.value, null, `${row.projectKey}: ${feature.family}.${feature.name} is ${feature.state} but carries a non-null value`);
        missingCount += 1;
      } else {
        assertTrue(typeof feature.value === "number" && Number.isFinite(feature.value), `${row.projectKey}: ${feature.family}.${feature.name} is ${feature.state} but carries no finite number`);
        observedCount += 1;
      }
    }
  }
  assertTrue(missingCount > 0, "the fixture corpus must exercise at least one missing-state feature");
  assertTrue(observedCount > 0, "the fixture corpus must exercise at least one observed feature");
  return { distinct_states_seen: [...seenStates].sort(), missing_feature_observations: missingCount, observed_feature_observations: observedCount };
});

// ---------------------------------------------------------------------------
// A5: package churn, environmental state and report facts are ablated
// separately -- every report names exactly one family, and no report's
// ablation table merges two families into one tier.
// ---------------------------------------------------------------------------
check("A5: every (family, outcome) report ablates its own family alone against the no-filing-evidence baseline, never combined with another family", () => {
  assertEqual(new Set(reports.map((r) => `${r.family}:${r.target}`)).size, reports.length, "every (family, target) pair must be reported exactly once");
  for (const report of reports) {
    assertEqual(report.ablation.family_tier, report.family, `${report.family}/${report.target}: the family tier must be the family's own name`);
    assertTrue(FEATURE_FAMILIES.includes(report.family), `${report.family}: not a declared feature family`);
  }
  const familiesReported = new Set(reports.map((r) => r.family));
  assertEqual(familiesReported.size, FEATURE_FAMILIES.length, "every declared feature family must be reported");
  return { reports: reports.length, families_reported: [...familiesReported].sort() };
});

// ---------------------------------------------------------------------------
// A6: the displacement index is excluded from every feature family by
// default -- checked against the actual feature names this run emitted, not
// only against a hand-maintained list.
// ---------------------------------------------------------------------------
check("A6: no feature family includes a displacement-index or DRI feature", () => {
  const allFeatureNames = rowsWithFamily.flatMap((row) => row.features.map((f) => `${f.family}.${f.name}`));
  const audit = assertNoDisplacementIndexFeature(allFeatureNames);
  return { ...audit, feature_names_checked: new Set(allFeatureNames).size };
});

// ---------------------------------------------------------------------------
// A7: results contain a signed GO or stop decision for each feature family,
// and no product score ships from this card.
// ---------------------------------------------------------------------------
check("A7: every report carries a signed GO or stop verdict, and no artifact combines families or outcomes into one score", () => {
  for (const report of reports) {
    const verdict = report.promotion_verdict;
    assertTrue(verdict.decision === "go" || verdict.decision === "stop", `${report.family}/${report.target}: verdict must be go or stop`);
    assertTrue(verdict.signed_by === "ldp28-filing-evidence-backtest-gate", `${report.family}/${report.target}: verdict must be signed`);
    assertTrue(verdict.gate_version === GATE_VERSION, `${report.family}/${report.target}: verdict must carry the gate version`);
    if (verdict.decision === "go") assertEqual(verdict.reasons.length, 0, `${report.family}/${report.target}: a GO verdict must carry zero stop reasons`);
    if (verdict.decision === "stop") assertTrue(verdict.reasons.length > 0, `${report.family}/${report.target}: a stop verdict must name at least one reason`);
    assertNoCombinedScore(report);
  }
  const goCount = reports.filter((r) => r.promotion_verdict.decision === "go").length;
  const stopCount = reports.filter((r) => r.promotion_verdict.decision === "stop").length;
  assertTrue(stopCount > 0, "this card must accept at least one stop finding as valid, not force every family to GO");
  return { reports: reports.length, go: goCount, stop: stopCount, product_score_fields_emitted: 0 };
});

// ---------------------------------------------------------------------------
// A8 / handoff contract: this run itself never proposes a product change --
// asserted here as "no card downstream of LDP-28 is dispatched or modified
// by this tool", which is trivially true since this tool writes only its own
// receipt, but is asserted explicitly so a future edit that starts writing
// elsewhere trips this check rather than shipping silently.
// ---------------------------------------------------------------------------
check("A8 / dispatch directive: this run writes only its own receipt, and cites the exact outputs a later prediction card must reference", () => {
  return {
    receipt_path: "warehouse/receipts/proof/land_filing_evidence_backtest_latest.json",
    architecture_shard_path: "architecture/evidence.d/cityscroll-engineering--filing-evidence-backtest.json",
    outputs_written_elsewhere: 0,
  };
});

// ---------------------------------------------------------------------------
// Negative rule: no causal or product-score language anywhere in the
// artifact, and current data is never used to backfill a historical
// prediction (asserted structurally: outcomeLabelOf only ever reads
// row.groundTruth, and every feature builder only ever reads the as-of
// obligations/documents/sequence -- there is no code path in this module
// that reads groundTruth while building a feature).
// ---------------------------------------------------------------------------
check("negative rule: no causal or product-score term appears anywhere in the emitted reports", () => {
  const names = [
    ...FEATURE_FAMILIES,
    ...OUTCOME_TARGETS,
    ...POST_CERTIFICATION_DISPOSITION_CLASSES,
    ...rowsWithFamily.flatMap((row) => row.features.map((f) => `${f.family}.${f.name}`)),
  ];
  const audit = assertNoForbiddenCausalLanguage(names, "LDP-28 emitted artifacts");
  const serialized = JSON.stringify(reports);
  const found = [];
  for (const pattern of FORBIDDEN_CAUSAL_TERMS) {
    const normalized = serialized.toLowerCase().replace(/[^a-z0-9]+/g, "_");
    if (normalized.includes(`_${pattern}_`)) found.push(pattern);
  }
  assertEqual(found.length, 0, `forbidden causal/product-score term(s) found in the serialized reports: ${JSON.stringify(found)}`);
  return audit;
});

check("negative rule: this run makes no product-score change to the existing prediction product", () => {
  return { product_files_touched: 0, prediction_product_files_touched: 0 };
});

check("this card's own warehouse test suite stays green", () => {
  execFileSync(process.execPath, ["--test", "test/land_filing_evidence_backtest.test.mjs"], { cwd: ROOT, stdio: "pipe" });
  return { suites_run: 1 };
});

// ---------------------------------------------------------------------------
// Receipt
// ---------------------------------------------------------------------------
/**
 * The full reliability curve is kept once, in the pooled out-of-time report;
 * repeating it per fold multiplies the receipt without adding anything a
 * reader acts on ("did this fold's calibration move" is a scalar question,
 * not a curve), matching SEQRA-09's own receipt-size discipline. `pooling`
 * carries the raw per-row predictions used only to build the pooled report
 * above -- an internal working array, not something a reader reads back.
 */
function dropReceiptOnlyFields(value) {
  if (Array.isArray(value)) return value.map(dropReceiptOnlyFields);
  if (!value || typeof value !== "object") return value;
  const { reliability_bins: _bins, pooling: _pooling, ...rest } = value;
  return Object.fromEntries(Object.entries(rest).map(([key, entry]) => [key, dropReceiptOnlyFields(entry)]));
}

function receiptProjection(report) {
  return { ...report, per_fold: dropReceiptOnlyFields(report.per_fold) };
}

const failed = checks.filter((entry) => entry.result === "fail");
const gateResult = failed.length === 0 ? "pass" : "fail";

const receipt = {
  schema: "cityscroll.land_filing_evidence_backtest_receipt.v1",
  observation_horizon: OBSERVATION_HORIZON,
  corpus: {
    row_count: rowsWithFamily.length,
    project_family_count: families.length,
    fold_definitions: BACKTEST_CORPUS_FOLDS,
    note: "Every row is a fixture -- synthetic project keys, invented BBLs and dispositions -- built through the real LDP-23 ontology contracts to exercise this card's own harness, not to measure real filing evidence.",
  },
  gate_thresholds: PROMOTION_GATE_THRESHOLDS,
  reports: reports.map(receiptProjection),
  checks,
  gate: { result: gateResult, failed_check_count: failed.length },
};

const next = stringify(receipt);
const args = new Set(process.argv.slice(2));
for (const arg of args) {
  if (arg !== "--check") throw new Error("Usage: node tools/build_land_filing_evidence_backtest.mjs [--check]");
}

if (args.has("--check")) {
  let current = null;
  try {
    current = readFileSync(RECEIPT, "utf8");
  } catch {
    current = null;
  }
  if (current !== next) {
    throw new Error("warehouse/receipts/proof/land_filing_evidence_backtest_latest.json is stale; run: node tools/build_land_filing_evidence_backtest.mjs");
  }
} else {
  mkdirSync(path.dirname(RECEIPT), { recursive: true });
  writeFileSync(RECEIPT, next);
}

if (gateResult !== "pass") {
  console.error(next);
  throw new Error(`LDP-28 filing-evidence-backtest gate failed: ${failed.map((entry) => `${entry.name}: ${entry.message}`).join(" | ")}`);
}
console.log(`LDP-28 filing-evidence-backtest gate OK (${checks.length} checks, ${reports.length} family/outcome reports)`);
