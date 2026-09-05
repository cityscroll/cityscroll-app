#!/usr/bin/env node
/**
 * SEQRA-09: fit, score and report the workstream's multi-target baselines, and
 * render the internal review card they feed.
 *
 * `npm run warehouse:seqra:backtest` runs this tool's `--check` mode, which
 * recomputes everything and fails if the committed receipt or any committed
 * card does not reproduce byte for byte. That is the point of the check: the
 * numbers in the receipt are the numbers a reader is being asked to trust, and
 * a receipt that could drift from the code that produced it is decoration.
 *
 * No network access and no clock: every input is the committed synthetic
 * fixture at warehouse/fixtures/seqra-baselines/, which is generated through
 * SEQRA-02's event-log builders and consumed through SEQRA-08's own corpus
 * primitives rather than through a parallel implementation.
 *
 * Usage:
 *   node tools/build_seqra_baselines.mjs [--check]
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  assertNoForbiddenEstimate,
  auditOrdinalLadderCoverage,
  buildBaselineCorpus,
  buildReviewEstimates,
  buildSourceFreshness,
  buildTargetDefinitions,
  DEFAULT_FIT_OPTIONS,
  evaluateTarget,
  FEATURE_TIERS,
  findForbiddenEstimateTerms,
  FORBIDDEN_ESTIMATE_PATTERNS,
  IRLS_ITERATIONS,
  PRIMARY_METRIC,
  SEQRA_BASELINES_SCHEMA,
  SOURCE_TIERS,
  splitRowsByFold,
  SURVIVAL_BIN_COUNT,
  SURVIVAL_BIN_DAYS,
  TECHNICAL_ISSUE_ORDINAL_LEVELS,
} from "../warehouse/lib/seqra_baselines.mjs";
import { auditFactClasses, renderReviewCard } from "../warehouse/lib/seqra_review_card.mjs";
import { assertFoldFamilyDisjointness, summarizeTargetFoldPopulation } from "../warehouse/lib/seqra_label_builder.mjs";
import {
  BASELINE_CORPUS_FOLDS,
  BASELINE_CORPUS_PROJECTS,
  BASELINE_CORPUS_REVIEWS,
  OBSERVATION_HORIZON,
} from "../warehouse/fixtures/seqra-baselines/baseline_corpus_fixtures.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const RECEIPT = path.join(ROOT, "warehouse/receipts/proof/seqra_baselines_latest.json");
const CARD_DIR = path.join(ROOT, "warehouse/reports/seqra-review-cards");
const RECEIPT_RELATIVE = "warehouse/receipts/proof/seqra_baselines_latest.json";

/** The tier the review cards are rendered at: the full source stack. */
const CARD_SOURCE_TIER = SOURCE_TIERS[SOURCE_TIERS.length - 1];
/** Cards are rendered from the last rolling-origin fold, whose test split is the most recent held-out window. */
const CARD_FOLD_ID = BASELINE_CORPUS_FOLDS[BASELINE_CORPUS_FOLDS.length - 1].foldId;
const CARD_COUNT = 3;

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
}

/**
 * Metric values are rounded to nine decimals in the receipt. The models
 * themselves are bit-reproducible (see the transcendentals in
 * warehouse/lib/seqra_baselines.mjs), so this is for readability, not to hide
 * a platform difference: nine places is far below any difference a reader
 * would act on and far above any difference the arithmetic can produce.
 */
function roundNumbers(value) {
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return value;
    return Number(value.toFixed(9));
  }
  if (Array.isArray(value)) return value.map(roundNumbers);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, roundNumbers(entry)]));
  }
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
// Build: the corpus, then every target across every fold and every tier.
// ---------------------------------------------------------------------------
const corpus = buildBaselineCorpus({
  reviews: BASELINE_CORPUS_REVIEWS,
  projects: BASELINE_CORPUS_PROJECTS,
  folds: BASELINE_CORPUS_FOLDS,
  observationHorizon: OBSERVATION_HORIZON,
});

const targets = buildTargetDefinitions();
const targetReports = targets.map((target) => evaluateTarget({ corpus, folds: BASELINE_CORPUS_FOLDS, target }));
const reportByTarget = new Map(targetReports.map((report) => [report.target, report]));

/**
 * The receipt keeps the full reliability curve for the pooled out-of-time
 * report of every target and tier, and the scalar calibration errors for each
 * individual fold. Carrying every fold's curve as well multiplied the file by
 * an order of magnitude and added nothing a reader could act on: the per-fold
 * question is "did this fold's calibration error move", which is a number, not
 * a curve.
 */
function receiptProjection(report) {
  const foldScore = (score) => {
    if (!score) return score;
    const { top_label_reliability_bins: bins, per_class: perClass, ...rest } = score;
    return bins === undefined && perClass === undefined
      ? rest
      : { ...rest, reliability_curve_and_per_class_error_reported_in: "pooled" };
  };
  return {
    ...report,
    tiers: Object.fromEntries(Object.entries(report.tiers).map(([tier, entry]) => [tier, {
      feature_names: entry.per_fold[0]?.feature_names ?? [],
      per_fold: entry.per_fold.map(({ baseline, comparator, feature_names: featureNames, ...fold }) => ({
        ...fold,
        baseline: foldScore(baseline),
        comparator: foldScore(comparator),
      })),
      pooled: entry.pooled,
      comparison_to_naive_comparator: entry.comparison_to_naive_comparator,
    }])),
  };
}

/**
 * Fold denominators, carried from SEQRA-08's own population summarizer rather
 * than recounted here: the numbers under a metric must be the corpus's
 * numbers, or the metric is describing a different population than the one the
 * corpus receipt documents.
 */
const foldPopulations = [];
for (const fold of BASELINE_CORPUS_FOLDS) {
  const { train, test, excluded } = splitRowsByFold(corpus, fold.foldId);
  for (const [split, rows] of [["train", train], ["test", test]]) {
    for (const target of targets) {
      if (target.kind === "duration") {
        foldPopulations.push(summarizeTargetFoldPopulation({
          targetName: target.name,
          foldId: fold.foldId,
          split,
          labelRows: [
            ...rows.map((row) => ({ reviewKey: row.review_key, label: row.next_milestone_event_type, censored: row.next_milestone_observed !== 1, excludedReason: null })),
            ...excluded.map((row) => ({ reviewKey: row.review_key, label: null, censored: false, excludedReason: row.excluded_reason })),
          ],
        }));
        continue;
      }
      if (target.kind === "ordinal") continue;
      foldPopulations.push(summarizeTargetFoldPopulation({
        targetName: target.name,
        foldId: fold.foldId,
        split,
        labelRows: [
          ...rows.map((row) => {
            const outcome = target.labelOf(row);
            return {
              reviewKey: row.review_key,
              label: outcome === null ? null : target.class_names[outcome],
              censored: outcome === null,
              excludedReason: null,
            };
          }),
          ...excluded.map((row) => ({ reviewKey: row.review_key, label: null, censored: false, excludedReason: row.excluded_reason })),
        ],
      }));
    }
  }
}

// ---------------------------------------------------------------------------
// The calibration each estimate carries on the card: the pooled out-of-time
// report for that target at the card's tier.
// ---------------------------------------------------------------------------
function calibrationFor(targetName) {
  const report = reportByTarget.get(targetName);
  if (!report) return null;
  const tier = report.tiers[CARD_SOURCE_TIER];
  const pooled = tier.pooled.baseline;
  return {
    target: targetName,
    source_tier: CARD_SOURCE_TIER,
    primary_metric: report.primary_metric,
    comparator_name: report.comparator,
    comparison: tier.comparison_to_naive_comparator,
    expected_calibration_error: pooled.top_label_expected_calibration_error ?? null,
    brier_score: pooled.brier_score ?? null,
    interquartile_interval_coverage: pooled.interquartile_interval_coverage ?? null,
    scored_rows: pooled.scored_rows ?? 0,
    censored_rows: tier.per_fold.reduce((total, fold) => total + (fold.test_censored_rows ?? 0), 0),
    fold_count: BASELINE_CORPUS_FOLDS.length,
  };
}

const { test: cardCandidates } = splitRowsByFold(corpus, CARD_FOLD_ID);
const cardRows = cardCandidates.slice(0, CARD_COUNT);
const cards = cardRows.map((row) => {
  const { estimates } = buildReviewEstimates({
    corpus,
    foldId: CARD_FOLD_ID,
    tier: CARD_SOURCE_TIER,
    reviewKey: row.review_key,
    targets,
  });
  const rendered = renderReviewCard({
    row,
    estimates,
    calibrationFor,
    sourceFreshness: buildSourceFreshness(row, OBSERVATION_HORIZON),
    sourceTier: CARD_SOURCE_TIER,
    foldId: CARD_FOLD_ID,
    observationHorizon: OBSERVATION_HORIZON,
    corpusReceiptPath: RECEIPT_RELATIVE,
  });
  return { row, rendered, audit: auditFactClasses(rendered.facts) };
});

function cardFileName(reviewKey) {
  return `${reviewKey.replace(/[^A-Za-z0-9]+/g, "-").replace(/^-+|-+$/g, "").toLowerCase()}.html`;
}
const cardArtifacts = cards.map((card) => ({
  review_key: card.rendered.review_key,
  path: `warehouse/reports/seqra-review-cards/${cardFileName(card.rendered.review_key)}`,
  html: card.rendered.html,
  fact_class_audit: card.audit,
}));

// ---------------------------------------------------------------------------
// A1: every target reports its fitted baseline against its documented naive
// comparator on the out-of-time holdout. Reported, never forced.
// ---------------------------------------------------------------------------
check("A1: every target reports a fitted baseline against its documented naive comparator, measured out of time", () => {
  const summary = [];
  for (const report of targetReports) {
    for (const tier of SOURCE_TIERS) {
      const comparison = report.tiers[tier].comparison_to_naive_comparator;
      assertTrue(comparison.metric === report.primary_metric, `${report.target}/${tier}: comparison must be on the target's own primary metric`);
      assertTrue(comparison.baseline !== undefined && comparison.comparator !== undefined, `${report.target}/${tier}: both sides of the comparison must be present`);
      assertTrue(comparison.beats_comparator === true || comparison.beats_comparator === false || comparison.beats_comparator === null,
        `${report.target}/${tier}: the comparison must state a verdict`);
    }
    const best = report.tiers[SOURCE_TIERS[SOURCE_TIERS.length - 1]].comparison_to_naive_comparator;
    summary.push({ target: report.target, metric: report.primary_metric, best_tier_beats_comparator: best.beats_comparator });
  }
  return {
    targets_reported: summary.length,
    full_source_stack_beats_comparator: summary.filter((entry) => entry.best_tier_beats_comparator === true).length,
    full_source_stack_loses_to_comparator: summary.filter((entry) => entry.best_tier_beats_comparator === false).length,
    per_target: summary,
  };
});

check("A1: no fold's model was fitted on rows it was then scored on", () => {
  let checked = 0;
  for (const fold of BASELINE_CORPUS_FOLDS) {
    const { train, test } = splitRowsByFold(corpus, fold.foldId);
    const trainKeys = new Set(train.map((row) => row.review_key));
    for (const row of test) {
      assertTrue(!trainKeys.has(row.review_key), `${fold.foldId}: ${row.review_key} is on both sides of the split`);
      assertTrue(Date.parse(row.cutoff) > Date.parse(fold.trainEnd), `${fold.foldId}: test row ${row.review_key} is not strictly after the training window`);
      checked += 1;
    }
    const disjoint = assertFoldFamilyDisjointness(
      corpus.fold_assignments.filter((assignment) => assignment.fold_id === fold.foldId),
    );
    assertTrue(disjoint.ok, `${fold.foldId}: project-family train/test disjointness violated`);
  }
  return { test_rows_checked: checked, folds: BASELINE_CORPUS_FOLDS.length };
});

check("A1: every feature in every snapshot was public by its own cutoff", () => {
  assertEqual(corpus.feature_leakage_audit.violation_count, 0, "temporal leakage violations");
  assertTrue(corpus.feature_leakage_audit.checked_count > 0, "the leakage audit must actually check something");
  return corpus.feature_leakage_audit;
});

// -- A2: the three fact classes are visibly distinct on every rendered card. --
check("A2: observed facts, estimates and missing data are three distinct classes on every card, and no estimate wears the observed class", () => {
  assertTrue(cards.length > 0, "at least one card must be rendered");
  for (const card of cards) {
    assertTrue(card.audit.ok, `${card.rendered.review_key}: ${JSON.stringify(card.audit)}`);
    assertEqual(card.audit.fact_classes_present.length, 3, `${card.rendered.review_key}: all three fact classes must appear`);
    assertEqual(card.audit.misclassified_estimate_count, 0, `${card.rendered.review_key}: an estimate rendered in a non-estimate class`);
    assertEqual(card.audit.uncalibrated_estimate_count, 0, `${card.rendered.review_key}: an estimate rendered without its calibration`);
    for (const factClass of ["observed-fact", "estimate", "missing-data"]) {
      assertTrue(card.rendered.html.includes(`.fact.${factClass} {`), `${card.rendered.review_key}: ${factClass} must carry its own style rule`);
      assertTrue(card.rendered.html.includes(`data-fact-class="${factClass}"`), `${card.rendered.review_key}: ${factClass} must be marked in the markup`);
    }
  }
  return { cards_rendered: cards.length, fact_class_counts: cards.map((card) => card.audit.fact_class_counts) };
});

// -- A3: the source-tier ablation states whether each tier added anything. --
check("A3: the source-tier ablation reports, per target, whether document and institutional enrichment adds value over structured sources alone", () => {
  const rows = [];
  for (const report of targetReports) {
    assertEqual(report.source_tier_ablation.length, SOURCE_TIERS.length, `${report.target}: one ablation row per tier`);
    assertEqual(report.source_tier_ablation[0].improvement_over_previous_tier, null, `${report.target}: the first tier has no previous tier`);
    for (const row of report.source_tier_ablation.slice(1)) {
      assertTrue(row.adds_value_over_previous_tier === true || row.adds_value_over_previous_tier === false,
        `${report.target}/${row.source_tier}: the ablation must state whether the tier added value`);
    }
    rows.push({
      target: report.target,
      documents_add_value: report.source_tier_ablation[1].adds_value_over_previous_tier,
      institutional_signals_add_value: report.source_tier_ablation[2].adds_value_over_previous_tier,
    });
  }
  return {
    targets: rows.length,
    documents_add_value_count: rows.filter((row) => row.documents_add_value).length,
    institutional_signals_add_value_count: rows.filter((row) => row.institutional_signals_add_value).length,
    per_target: rows,
  };
});

// -- A4: calibration and error accompany every estimate. --
check("A4: every target and tier carries a calibration and error report measured out of time, with its denominators", () => {
  for (const report of targetReports) {
    for (const tier of SOURCE_TIERS) {
      const pooled = report.tiers[tier].pooled.baseline;
      if (report.kind === "duration") {
        assertTrue(pooled.concordance !== undefined, `${report.target}/${tier}: concordance is required`);
        assertTrue(pooled.mean_absolute_error_days !== undefined, `${report.target}/${tier}: absolute error is required`);
        assertTrue(pooled.censored_rows !== undefined, `${report.target}/${tier}: the censored count is required`);
      } else {
        assertTrue(pooled.top_label_reliability_bins.length === 10, `${report.target}/${tier}: reliability bins are required`);
        assertTrue(pooled.top_label_expected_calibration_error !== undefined, `${report.target}/${tier}: expected calibration error is required`);
        assertTrue(pooled.log_loss !== undefined && pooled.brier_score !== undefined, `${report.target}/${tier}: log loss and Brier are required`);
        assertTrue(pooled.per_class.length > 0, `${report.target}/${tier}: per-class error is required`);
      }
      assertTrue(pooled.scored_rows > 0, `${report.target}/${tier}: a metric with no denominator is not a metric`);
      for (const fold of report.tiers[tier].per_fold) {
        assertTrue(fold.baseline !== undefined && fold.comparator !== undefined, `${report.target}/${tier}/${fold.fold_id}: per-fold reports are required`);
      }
    }
  }
  for (const card of cards) {
    for (const entry of card.rendered.facts) {
      if (entry.fact_class !== "estimate") continue;
      assertTrue(entry.calibration && entry.calibration.scored_rows > 0, `${card.rendered.review_key}: estimate ${entry.id} carries no measured calibration`);
    }
  }
  return { target_tier_reports: targetReports.length * SOURCE_TIERS.length, fold_population_receipts: foldPopulations.length };
});

// -- A5 / negative rule. --
check("A5 / negative rule: no resident-facing legal conclusion is emitted anywhere, and the card stays internal", () => {
  const names = [
    ...targetReports.map((report) => report.target),
    ...Object.keys(FEATURE_TIERS),
    ...TECHNICAL_ISSUE_ORDINAL_LEVELS,
    ...cards.flatMap((card) => card.rendered.facts.map((entry) => entry.id)),
  ];
  assertNoForbiddenEstimate(names, "SEQRA-09 emitted artifacts");

  const serialized = JSON.stringify({ targetReports, foldPopulations }) + cardArtifacts.map((card) => card.html).join("");
  const found = findForbiddenEstimateTerms(serialized);
  assertTrue(found.length === 0, `the emitted artifacts contain the forbidden term(s) ${JSON.stringify(found)}`);
  for (const card of cardArtifacts) {
    assertTrue(card.path.startsWith("warehouse/reports/"), `${card.path}: a review card must be written under warehouse/, never under site/`);
    assertTrue(!card.path.includes("site/"), `${card.path}: a review card must not be written under site/`);
    assertTrue(card.html.includes('data-audience="internal"'), `${card.path}: the card must declare itself internal`);
    assertTrue(card.html.includes("not a resident-facing page"), `${card.path}: the card must say so in the page`);
  }
  return {
    names_checked: names.length,
    forbidden_patterns: FORBIDDEN_ESTIMATE_PATTERNS.length,
    cards_written_under: "warehouse/reports/seqra-review-cards",
    site_paths_written: 0,
    routes_added: 0,
  };
});

check("negative rule: the targets are never collapsed into one project-risk score", () => {
  const targetNames = targetReports.map((report) => report.target);
  assertEqual(new Set(targetNames).size, targetNames.length, "every target must be reported once, under its own name");
  assertTrue(targetNames.length >= 5, "the workstream's targets must be reported separately");
  for (const card of cards) {
    const combined = card.rendered.facts.filter((entry) => /overall|combined|composite|total.*score|risk.score/i.test(`${entry.id} ${entry.label}`));
    assertEqual(combined.length, 0, `${card.rendered.review_key}: a card must not render a combined score`);
  }
  return { targets_reported_separately: targetNames.length, combined_scores_emitted: 0 };
});

check("the ordinal ladder covers every state the frozen ontology defines", () => {
  const audit = auditOrdinalLadderCoverage();
  assertTrue(audit.ok, `topic assessment states with no ordinal level: ${JSON.stringify(audit.missing_states)}`);
  return audit;
});

check("this card's own warehouse test suite stays green", () => {
  execFileSync(process.execPath, ["--test", "test/warehouse_seqra_baselines.test.mjs"], { cwd: ROOT, stdio: "pipe" });
  return { suites_run: 1 };
});

const failed = checks.filter((entry) => entry.result === "fail");
const gateResult = failed.length === 0 ? "pass" : "fail";

const receipt = {
  schema: "cityscroll.seqra_baselines_receipt.v1",
  baseline_module_schema: SEQRA_BASELINES_SCHEMA,
  observation_horizon: OBSERVATION_HORIZON,
  corpus: {
    review_count: corpus.rows.length,
    project_family_count: corpus.families.length,
    refusals: corpus.refusals,
    feature_leakage_audit: corpus.feature_leakage_audit,
    fold_definitions: BASELINE_CORPUS_FOLDS,
  },
  model_configuration: {
    fit_options: DEFAULT_FIT_OPTIONS,
    irls_iterations: IRLS_ITERATIONS,
    survival_bin_days: SURVIVAL_BIN_DAYS,
    survival_bin_count: SURVIVAL_BIN_COUNT,
    feature_tiers: FEATURE_TIERS,
    source_tiers: SOURCE_TIERS,
    primary_metric_by_kind: PRIMARY_METRIC,
    technical_issue_ordinal_levels: TECHNICAL_ISSUE_ORDINAL_LEVELS,
  },
  target_reports: targetReports.map(receiptProjection),
  source_tier_ablation: targetReports.map((report) => ({
    target: report.target,
    primary_metric: report.primary_metric,
    comparator: report.comparator,
    rows: report.source_tier_ablation,
  })),
  target_fold_populations: foldPopulations,
  review_cards: cardArtifacts.map(({ html, ...rest }) => rest),
  negative_rule_attestations: {
    resident_facing_legal_conclusion_estimates_emitted: 0,
    forbidden_estimate_patterns: FORBIDDEN_ESTIMATE_PATTERNS,
    combined_project_risk_scores_emitted: 0,
    files_written_under_site: 0,
    routes_added: 0,
    card_output_root: "warehouse/reports/seqra-review-cards",
  },
  checks,
  gate: { result: gateResult, failed_check_count: failed.length },
};

const next = stringify(receipt);
const args = new Set(process.argv.slice(2));
for (const arg of args) {
  if (arg !== "--check") throw new Error("Usage: node tools/build_seqra_baselines.mjs [--check]");
}

const outputs = [
  { path: RECEIPT, contents: next },
  ...cardArtifacts.map((card) => ({ path: path.join(ROOT, card.path), contents: card.html })),
];

if (args.has("--check")) {
  for (const output of outputs) {
    let current = null;
    try {
      current = readFileSync(output.path, "utf8");
    } catch {
      current = null;
    }
    if (current !== output.contents) {
      throw new Error(`${path.relative(ROOT, output.path)} is stale; run: node tools/build_seqra_baselines.mjs`);
    }
  }
} else {
  for (const output of outputs) {
    mkdirSync(path.dirname(output.path), { recursive: true });
    writeFileSync(output.path, output.contents);
  }
}

if (gateResult !== "pass") {
  console.error(next);
  throw new Error(`SEQRA-09 multi-target-baseline gate failed: ${failed.map((entry) => `${entry.name}: ${entry.message}`).join(" | ")}`);
}
console.log(`SEQRA multi-target-baseline gate OK (${checks.length} checks, ${targetReports.length} targets, ${cardArtifacts.length} review cards)`);
