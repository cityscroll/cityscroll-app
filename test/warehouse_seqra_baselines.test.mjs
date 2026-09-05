import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

import {
  assertNoForbiddenEstimate,
  auditOrdinalLadderCoverage,
  buildBaselineCorpus,
  buildReviewEstimates,
  buildSourceFreshness,
  buildTargetDefinitions,
  concordanceIndex,
  evaluateTarget,
  expDeterministic,
  expectedCalibrationError,
  FEATURE_TIERS,
  featureNamesForTier,
  findForbiddenEstimateTerms,
  kaplanMeierMedianDays,
  logDeterministic,
  mapTopicStateToOrdinalLevel,
  PRIMARY_METRIC,
  prevalenceComparator,
  reliabilityBins,
  SeqraBaselineError,
  SOURCE_TIERS,
  splitRowsByFold,
  TECHNICAL_ISSUE_ORDINAL_LEVELS,
} from "../warehouse/lib/seqra_baselines.mjs";
import { auditFactClasses, renderReviewCard, REVIEW_CARD_FACT_CLASSES } from "../warehouse/lib/seqra_review_card.mjs";
import {
  BASELINE_CORPUS_FOLDS,
  BASELINE_CORPUS_PROJECTS,
  BASELINE_CORPUS_REVIEWS,
  OBSERVATION_HORIZON,
} from "../warehouse/fixtures/seqra-baselines/baseline_corpus_fixtures.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const RECEIPT_PATH = path.join(ROOT, "warehouse/receipts/proof/seqra_baselines_latest.json");
const FULL_TIER = SOURCE_TIERS[SOURCE_TIERS.length - 1];
const CARD_FOLD_ID = BASELINE_CORPUS_FOLDS[BASELINE_CORPUS_FOLDS.length - 1].foldId;

const CORPUS = buildBaselineCorpus({
  reviews: BASELINE_CORPUS_REVIEWS,
  projects: BASELINE_CORPUS_PROJECTS,
  folds: BASELINE_CORPUS_FOLDS,
  observationHorizon: OBSERVATION_HORIZON,
});
const TARGETS = buildTargetDefinitions();

let cachedReports = null;
function targetReports() {
  if (cachedReports === null) {
    cachedReports = TARGETS.map((target) => evaluateTarget({ corpus: CORPUS, folds: BASELINE_CORPUS_FOLDS, target }));
  }
  return cachedReports;
}

function committedReceipt() {
  return JSON.parse(readFileSync(RECEIPT_PATH, "utf8"));
}

function renderFirstCard() {
  const { test } = splitRowsByFold(CORPUS, CARD_FOLD_ID);
  const row = test[0];
  const { estimates } = buildReviewEstimates({
    corpus: CORPUS,
    foldId: CARD_FOLD_ID,
    tier: FULL_TIER,
    reviewKey: row.review_key,
    targets: TARGETS,
  });
  const receipt = committedReceipt();
  const byTarget = new Map(receipt.target_reports.map((report) => [report.target, report]));
  const calibrationFor = (targetName) => {
    const report = byTarget.get(targetName);
    if (!report) return null;
    const pooled = report.tiers[FULL_TIER].pooled.baseline;
    return {
      target: targetName,
      primary_metric: report.primary_metric,
      comparator_name: report.comparator,
      comparison: report.tiers[FULL_TIER].comparison_to_naive_comparator,
      expected_calibration_error: pooled.top_label_expected_calibration_error ?? null,
      brier_score: pooled.brier_score ?? null,
      interquartile_interval_coverage: pooled.interquartile_interval_coverage ?? null,
      scored_rows: pooled.scored_rows ?? 0,
      fold_count: BASELINE_CORPUS_FOLDS.length,
    };
  };
  return renderReviewCard({
    row,
    estimates,
    calibrationFor,
    sourceFreshness: buildSourceFreshness(row, OBSERVATION_HORIZON),
    sourceTier: FULL_TIER,
    foldId: CARD_FOLD_ID,
    observationHorizon: OBSERVATION_HORIZON,
    corpusReceiptPath: "warehouse/receipts/proof/seqra_baselines_latest.json",
  });
}

describe("SEQRA-09 multi-target baselines (A1, A2, A3, A4, A5, negative rule)", () => {
  it("A1: every target reports its fitted baseline against a documented naive comparator on the out-of-time holdout", () => {
    for (const report of targetReports()) {
      assert.ok(report.comparator, `${report.target}: the naive comparator must be named`);
      assert.ok(["train_fold_class_prevalence", "train_fold_kaplan_meier_median"].includes(report.comparator),
        `${report.target}: the comparator must be one of the documented heuristics, got ${report.comparator}`);
      for (const tier of SOURCE_TIERS) {
        const comparison = report.tiers[tier].comparison_to_naive_comparator;
        assert.equal(comparison.metric, report.primary_metric);
        assert.equal(typeof comparison.baseline, "number", `${report.target}/${tier}: the baseline value must be reported`);
        assert.equal(typeof comparison.comparator, "number", `${report.target}/${tier}: the comparator value must be reported`);
        assert.equal(typeof comparison.improvement, "number");
        assert.equal(typeof comparison.beats_comparator, "boolean",
          `${report.target}/${tier}: the receipt must state plainly whether the baseline beat the comparator`);
        // The direction the verdict claims must be the direction the numbers show.
        const better = PRIMARY_METRIC[report.kind].lower_is_better
          ? comparison.baseline < comparison.comparator
          : comparison.baseline > comparison.comparator;
        assert.equal(comparison.beats_comparator, better, `${report.target}/${tier}: the verdict must follow the measured numbers`);
      }
    }
  });

  it("A1: the committed receipt records the comparison for every target, and does not claim a win it did not measure", () => {
    const receipt = committedReceipt();
    assert.equal(receipt.target_reports.length, TARGETS.length);
    for (const report of receipt.target_reports) {
      for (const tier of SOURCE_TIERS) {
        const comparison = report.tiers[tier].comparison_to_naive_comparator;
        assert.ok(comparison, `${report.target}/${tier}: no comparison recorded`);
        assert.equal(typeof comparison.beats_comparator, "boolean");
      }
    }
    // At least one tier/target pair on this fixture corpus loses to its
    // comparator, and the receipt says so rather than hiding it. This is what
    // makes the receipt evidence: a report that could only ever say "yes" is
    // not a measurement.
    const verdicts = receipt.target_reports.flatMap((report) => SOURCE_TIERS.map((tier) => report.tiers[tier].comparison_to_naive_comparator.beats_comparator));
    assert.ok(verdicts.includes(true), "the receipt must record at least one baseline that beat its comparator");
    assert.ok(verdicts.includes(false), "the receipt must be able to record a baseline that lost, and on this corpus it does");
  });

  it("A1: no fold's model is fitted on a row it is then scored on, and every test cutoff is after its training window", () => {
    for (const fold of BASELINE_CORPUS_FOLDS) {
      const { train, test } = splitRowsByFold(CORPUS, fold.foldId);
      const trainKeys = new Set(train.map((row) => row.review_key));
      const trainFamilies = new Set(train.map((row) => row.family_id));
      for (const row of test) {
        assert.ok(!trainKeys.has(row.review_key), `${fold.foldId}: ${row.review_key} is on both sides`);
        assert.ok(!trainFamilies.has(row.family_id), `${fold.foldId}: family ${row.family_id} is on both sides`);
        assert.ok(Date.parse(row.cutoff) > Date.parse(fold.trainEnd), `${fold.foldId}: ${row.review_key} is not out of time`);
      }
    }
  });

  it("A1: every feature snapshot was public by its own cutoff, audited independently of the builder that produced it", () => {
    assert.equal(CORPUS.feature_leakage_audit.violation_count, 0);
    assert.ok(CORPUS.feature_leakage_audit.checked_count > 0);
    for (const row of CORPUS.rows) {
      assert.equal(row.snapshot.leakage_audit.violation_count, 0, `${row.review_key}: leakage`);
    }
  });

  it("A2: observed facts, estimates and missing data are three distinct classes, and an estimate is never rendered with the observed-fact class", () => {
    const card = renderFirstCard();
    const audit = auditFactClasses(card.facts);
    assert.equal(audit.ok, true, JSON.stringify(audit));
    assert.deepEqual(audit.fact_classes_present, ["estimate", "missing-data", "observed-fact"]);
    for (const factClass of Object.values(REVIEW_CARD_FACT_CLASSES)) {
      assert.ok(audit.fact_class_counts[factClass] > 0, `${factClass} must actually appear on the card`);
      assert.ok(card.html.includes(`data-fact-class="${factClass}"`), `${factClass} must be marked in the markup`);
      assert.ok(card.html.includes(`.fact.${factClass} {`), `${factClass} must have its own style rule`);
    }
    // The three classes must not share a treatment.
    const rules = Object.values(REVIEW_CARD_FACT_CLASSES).map((factClass) => {
      const start = card.html.indexOf(`.fact.${factClass} {`);
      return card.html.slice(start, card.html.indexOf("}", start));
    });
    assert.equal(new Set(rules).size, 3, "each fact class must be styled differently from the other two");

    for (const fact of card.facts) {
      if (fact.calibration) {
        assert.equal(fact.fact_class, REVIEW_CARD_FACT_CLASSES.ESTIMATE, `${fact.id}: a calibrated estimate must carry the estimate class`);
      }
      if (fact.fact_class === REVIEW_CARD_FACT_CLASSES.ESTIMATE) {
        assert.notEqual(fact.fact_class, REVIEW_CARD_FACT_CLASSES.OBSERVED);
      }
    }
    const estimateIds = card.facts.filter((fact) => fact.fact_class === REVIEW_CARD_FACT_CLASSES.ESTIMATE).map((fact) => fact.id);
    assert.ok(estimateIds.includes("next_milestone_type"));
    assert.ok(estimateIds.includes("next_milestone_timing"));
    assert.ok(card.facts.some((fact) => fact.fact_class === REVIEW_CARD_FACT_CLASSES.MISSING));
  });

  it("A2: the card refuses an estimate that arrives without its calibration", () => {
    const { test } = splitRowsByFold(CORPUS, CARD_FOLD_ID);
    const row = test[0];
    const { estimates } = buildReviewEstimates({ corpus: CORPUS, foldId: CARD_FOLD_ID, tier: FULL_TIER, reviewKey: row.review_key, targets: TARGETS });
    assert.throws(
      () => renderReviewCard({
        row,
        estimates,
        calibrationFor: () => null,
        sourceFreshness: buildSourceFreshness(row, OBSERVATION_HORIZON),
        sourceTier: FULL_TIER,
        foldId: CARD_FOLD_ID,
        observationHorizon: OBSERVATION_HORIZON,
        corpusReceiptPath: "warehouse/receipts/proof/seqra_baselines_latest.json",
      }),
      /carries no calibration/,
    );
  });

  it("A3: the source-tier ablation reports whether document and institutional enrichment adds value over structured sources alone", () => {
    for (const report of targetReports()) {
      assert.equal(report.source_tier_ablation.length, 3);
      assert.deepEqual(report.source_tier_ablation.map((row) => row.source_tier), [...SOURCE_TIERS]);
      assert.equal(report.source_tier_ablation[0].improvement_over_previous_tier, null);
      assert.equal(report.source_tier_ablation[0].adds_value_over_previous_tier, null);
      for (const row of report.source_tier_ablation.slice(1)) {
        assert.equal(typeof row.improvement_over_previous_tier, "number", `${report.target}/${row.source_tier}`);
        assert.equal(typeof row.adds_value_over_previous_tier, "boolean", `${report.target}/${row.source_tier}`);
        assert.equal(row.adds_value_over_previous_tier, row.improvement_over_previous_tier > 0);
        assert.ok(row.comparison_to_naive_comparator, `${report.target}/${row.source_tier}: each tier is also compared to the naive comparator`);
      }
    }
    const receipt = committedReceipt();
    assert.equal(receipt.source_tier_ablation.length, TARGETS.length);
    for (const entry of receipt.source_tier_ablation) {
      assert.equal(entry.rows.length, 3, `${entry.target}: the ablation must report all three tiers`);
    }
  });

  it("A3: a tier only sees its own sources, so the ablation measures what it claims to", () => {
    const target = TARGETS.find((entry) => entry.name === "review_path");
    const structured = featureNamesForTier("structured", target.feature_names);
    const documents = featureNamesForTier("structured_plus_documents", target.feature_names);
    const institutional = featureNamesForTier(FULL_TIER, target.feature_names);
    assert.ok(structured.length > 0);
    assert.ok(documents.length > structured.length, "the document tier must add features");
    assert.ok(institutional.length > documents.length, "the institutional tier must add features");
    assert.deepEqual(documents.slice(0, structured.length), structured, "the tiers must be nested");
    for (const name of structured) assert.equal(FEATURE_TIERS[name], "structured");
    // The structured tier must not count document- or institution-derived
    // events; a structured milestone count that included topic assessments and
    // recorded positions would make the ablation vacuous.
    assert.ok(!structured.some((name) => /topic|position|document|organization/.test(name)),
      `structured tier leaks a later tier's sources: ${structured.join(", ")}`);
  });

  it("A4: calibration and error reports accompany every estimate, measured out of time and carrying their denominators", () => {
    for (const report of targetReports()) {
      for (const tier of SOURCE_TIERS) {
        const pooled = report.tiers[tier].pooled.baseline;
        assert.ok(pooled.scored_rows > 0, `${report.target}/${tier}: no denominator`);
        if (report.kind === "duration") {
          assert.equal(typeof pooled.concordance, "number");
          assert.equal(typeof pooled.mean_absolute_error_days, "number");
          assert.equal(typeof pooled.median_absolute_error_days, "number");
          assert.equal(typeof pooled.censored_rows, "number");
          assert.equal(typeof pooled.interquartile_interval_coverage, "number");
        } else {
          assert.equal(pooled.top_label_reliability_bins.length, 10);
          assert.equal(typeof pooled.top_label_expected_calibration_error, "number");
          assert.equal(typeof pooled.log_loss, "number");
          assert.equal(typeof pooled.brier_score, "number");
          assert.equal(typeof pooled.error_rate, "number");
          assert.equal(pooled.per_class.length, report.class_names.length);
          const binned = pooled.top_label_reliability_bins.reduce((total, bin) => total + bin.count, 0);
          assert.equal(binned, pooled.scored_rows, `${report.target}/${tier}: reliability bins must account for every scored row`);
        }
        assert.equal(report.tiers[tier].per_fold.length, BASELINE_CORPUS_FOLDS.length);
        for (const fold of report.tiers[tier].per_fold) {
          assert.ok(fold.baseline, `${report.target}/${tier}/${fold.fold_id}: per-fold report missing`);
          assert.ok(fold.comparator, `${report.target}/${tier}/${fold.fold_id}: per-fold comparator missing`);
          assert.equal(typeof fold.train_rows, "number");
          assert.equal(typeof fold.test_rows, "number");
          assert.equal(typeof fold.test_censored_rows, "number");
        }
      }
    }
    const card = renderFirstCard();
    for (const fact of card.facts) {
      if (fact.fact_class !== REVIEW_CARD_FACT_CLASSES.ESTIMATE) continue;
      assert.ok(fact.calibration, `${fact.id}: an estimate must carry its measured calibration`);
      assert.ok(fact.calibration.scored_rows > 0, `${fact.id}: calibration with no denominator`);
      assert.ok(card.html.includes("Measured calibration:"), "the calibration must be rendered beside the estimate");
    }
  });

  it("A4: the committed receipt carries fold denominators and censoring counts from the corpus", () => {
    const receipt = committedReceipt();
    assert.ok(receipt.target_fold_populations.length > 0);
    for (const population of receipt.target_fold_populations) {
      const excluded = Object.values(population.excluded_by_reason).reduce((total, count) => total + count, 0);
      assert.equal(population.population, population.eligible_population + excluded, `${population.target_name}/${population.fold_id}/${population.split}`);
      assert.equal(population.eligible_population, population.censored_count + population.labeled_population);
    }
  });

  it("A5: nothing is written under site/, no route is added, and no lawsuit-like field appears in any emitted artifact", () => {
    const receipt = committedReceipt();
    for (const card of receipt.review_cards) {
      assert.ok(card.path.startsWith("warehouse/reports/"), `${card.path}: cards belong under warehouse/`);
      assert.ok(!card.path.includes("site/"), `${card.path}: a card must never be written under site/`);
    }
    assert.equal(receipt.negative_rule_attestations.files_written_under_site, 0);
    assert.equal(receipt.negative_rule_attestations.routes_added, 0);
    assert.equal(receipt.negative_rule_attestations.resident_facing_legal_conclusion_estimates_emitted, 0);

    // Scan everything the receipt emits except the attestation's own list of
    // banned terms -- that list is the rule, not a violation of it.
    const scannable = { ...receipt, negative_rule_attestations: { ...receipt.negative_rule_attestations, forbidden_estimate_patterns: [] } };
    const emitted = [
      JSON.stringify(scannable),
      ...receipt.review_cards.map((card) => readFileSync(path.join(ROOT, card.path), "utf8")),
    ].join("\n");
    assert.deepEqual(findForbiddenEstimateTerms(emitted), [], "an emitted artifact names a legal-exposure estimate");

    for (const source of ["warehouse/lib/seqra_baselines.mjs", "warehouse/lib/seqra_review_card.mjs", "tools/build_seqra_baselines.mjs"]) {
      const text = readFileSync(path.join(ROOT, source), "utf8");
      assert.ok(!/writeFileSync\([^)]*["'`]site\//.test(text), `${source}: must not write under site/`);
      assert.ok(!/site\/data\//.test(text), `${source}: must not read or write a resident-facing read model`);
    }

    const card = renderFirstCard();
    assert.ok(card.html.includes('data-audience="internal"'));
    assert.ok(card.html.includes("not a resident-facing page"));
    assert.ok(card.html.includes('name="robots" content="noindex, nofollow"'));
  });

  it("A5: a field named like a legal-exposure estimate is refused, while an ordinary technical-issue field is not", () => {
    assert.throws(() => assertNoForbiddenEstimate(["lawsuit_probability"]), SeqraBaselineError);
    assert.throws(() => assertNoForbiddenEstimate(["lawsuitProbability"]), SeqraBaselineError);
    assert.throws(() => assertNoForbiddenEstimate(["article 78 challenge probability"]), SeqraBaselineError);
    assert.throws(() => assertNoForbiddenEstimate(["litigation_risk"]), SeqraBaselineError);
    assert.deepEqual(assertNoForbiddenEstimate(["technical_issue_state", "supplementation_requested"]).ok, true);
  });

  it("negative rule: the targets are reported separately and never collapsed into one project-risk score", () => {
    const receipt = committedReceipt();
    const names = receipt.target_reports.map((report) => report.target);
    assert.equal(new Set(names).size, names.length);
    assert.ok(names.includes("review_path"));
    assert.ok(names.includes("next_milestone_type"));
    assert.ok(names.includes("next_milestone_duration"));
    assert.ok(names.includes("technical_issue_state"));
    assert.ok(names.some((name) => name.startsWith("supplemental_review:")));
    assert.equal(receipt.negative_rule_attestations.combined_project_risk_scores_emitted, 0);
    const card = renderFirstCard();
    assert.equal(card.facts.filter((fact) => /overall|composite|combined|risk.score/i.test(`${fact.id} ${fact.label}`)).length, 0);
  });

  it("the ordinal ladder is an exhaustive, monotone projection of the frozen topic-assessment states", () => {
    const audit = auditOrdinalLadderCoverage();
    assert.equal(audit.ok, true, `states with no ordinal level: ${audit.missing_states.join(", ")}`);
    assert.equal(mapTopicStateToOrdinalLevel("screened_out"), "resolved_without_analysis");
    assert.equal(mapTopicStateToOrdinalLevel("unmitigated"), "unmitigated");
    assert.ok(
      TECHNICAL_ISSUE_ORDINAL_LEVELS.indexOf(mapTopicStateToOrdinalLevel("disputed_in_comments"))
      > TECHNICAL_ISSUE_ORDINAL_LEVELS.indexOf(mapTopicStateToOrdinalLevel("mitigated")),
      "a contested topic must rank above an addressed one",
    );
    assert.throws(() => mapTopicStateToOrdinalLevel("invented_state"), SeqraBaselineError);
  });

  it("the fit is deterministic: the same corpus produces the same numbers, regardless of input row order", () => {
    const shuffled = buildBaselineCorpus({
      reviews: [...BASELINE_CORPUS_REVIEWS].reverse(),
      projects: [...BASELINE_CORPUS_PROJECTS].reverse(),
      folds: BASELINE_CORPUS_FOLDS,
      observationHorizon: OBSERVATION_HORIZON,
    });
    const target = TARGETS.find((entry) => entry.name === "review_path");
    const first = evaluateTarget({ corpus: CORPUS, folds: BASELINE_CORPUS_FOLDS, target });
    const second = evaluateTarget({ corpus: shuffled, folds: BASELINE_CORPUS_FOLDS, target });
    assert.deepEqual(second.tiers[FULL_TIER].pooled, first.tiers[FULL_TIER].pooled);
    assert.deepEqual(second.source_tier_ablation, first.source_tier_ablation);
  });

  it("the transcendentals the models rely on are computed from IEEE-exact arithmetic and agree with the platform library", () => {
    for (const value of [-30, -7.3, -1, -0.25, 0, 0.25, 1, 3.7, 20]) {
      const relative = Math.abs(expDeterministic(value) - Math.exp(value)) / Math.exp(value);
      assert.ok(relative < 1e-14, `expDeterministic(${value}) relative error ${relative}`);
    }
    for (const value of [1e-9, 0.001, 0.37, 0.5, 1, 2, 7.5, 1000]) {
      const absolute = Math.abs(logDeterministic(value) - Math.log(value));
      assert.ok(absolute < 1e-13, `logDeterministic(${value}) absolute error ${absolute}`);
    }
    assert.throws(() => logDeterministic(0), SeqraBaselineError);
  });

  it("the naive comparators are the documented ones: class prevalence, and a Kaplan-Meier median that censoring cannot bias downward", () => {
    assert.deepEqual(prevalenceComparator([0, 0, 1, 1, 1, 2], 3), [2 / 6, 3 / 6, 1 / 6]);
    assert.deepEqual(prevalenceComparator([], 2), [0.5, 0.5]);
    // Two events at 10 and 100 days with a censoring at 50: the naive mean of
    // the observed durations would be pulled below the true median, and
    // Kaplan-Meier is not.
    assert.equal(kaplanMeierMedianDays([10, 50, 100], [1, 0, 1]), 100);
    assert.equal(kaplanMeierMedianDays([10, 20, 30, 40], [1, 1, 1, 1]), 20);
  });

  it("calibration primitives account for every row and read the reliability gap in the right direction", () => {
    const bins = reliabilityBins([
      { probability: 0.05, outcome: 0 },
      { probability: 0.05, outcome: 0 },
      { probability: 0.95, outcome: 1 },
      { probability: 0.95, outcome: 0 },
    ]);
    assert.equal(bins.reduce((total, bin) => total + bin.count, 0), 4);
    assert.equal(bins[0].count, 2);
    assert.equal(bins[0].observed_rate, 0);
    assert.equal(bins[9].count, 2);
    assert.equal(bins[9].observed_rate, 0.5);
    const error = expectedCalibrationError(bins, 4);
    assert.ok(Math.abs(error - (0.5 * 0.05 + 0.5 * 0.45)) < 1e-12, `expected calibration error ${error}`);
    assert.equal(expectedCalibrationError(reliabilityBins([]), 0), null);
  });

  it("concordance credits ties at one half and only scores comparable pairs", () => {
    const perfect = concordanceIndex([1, 2, 3], [10, 20, 30], [1, 1, 1]);
    assert.equal(perfect.concordance, 1);
    const constant = concordanceIndex([5, 5, 5], [10, 20, 30], [1, 1, 1]);
    assert.equal(constant.concordance, 0.5);
    const censoredOnly = concordanceIndex([1, 2], [10, 20], [0, 0]);
    assert.equal(censoredOnly.concordance, null);
    assert.equal(censoredOnly.comparable_pairs, 0);
  });

  it("a review that a fold trained on cannot have a card built for it", () => {
    const { train } = splitRowsByFold(CORPUS, CARD_FOLD_ID);
    assert.throws(
      () => buildReviewEstimates({ corpus: CORPUS, foldId: CARD_FOLD_ID, tier: FULL_TIER, reviewKey: train[0].review_key, targets: TARGETS }),
      /held-out review/,
    );
  });

  it("source freshness reports absences as absences, never as decisions", () => {
    const row = CORPUS.rows.find((candidate) => candidate.snapshot.review_state.positions.length === 0);
    const freshness = buildSourceFreshness(row, OBSERVATION_HORIZON);
    assert.equal(freshness.observation_horizon, OBSERVATION_HORIZON);
    assert.ok(freshness.warnings.some((warning) => warning.includes("no institutional position")));
    assert.ok(freshness.warnings.every((warning) => !/screened out\b(?! )/.test(warning) || warning.includes("cannot")));
  });
});
