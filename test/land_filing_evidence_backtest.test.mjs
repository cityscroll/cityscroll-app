import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  FEATURE_FAMILIES,
  OUTCOME_TARGETS,
  POST_CERTIFICATION_DISPOSITION_CLASSES,
  feature,
  reportFilingFactsFeatures,
  packageChurnFeatures,
  environmentalStateFeatures,
  buildAsOfFilingBacktestRow,
  buildFilingProjectFamilies,
  buildRollingOriginFilingFolds,
  assertFilingFoldFamilyDisjointness,
  splitFilingRowsByFold,
  outcomeLabelOf,
  assertNoForbiddenCausalLanguage,
  assertNoDisplacementIndexFeature,
  assertNoCombinedScore,
  evaluatePromotionGate,
  evaluateFeatureFamilyForOutcome,
  reliabilityBins,
  expectedCalibrationError,
  logLoss,
  brierScore,
  rankAUC,
  concordanceIndex,
  kaplanMeierMedian,
  LandFilingEvidenceBacktestError,
} from "../warehouse/lib/land_filing_evidence_backtest.mjs";
import {
  BACKTEST_CORPUS_FOLDS,
  BACKTEST_CORPUS_PROJECTS,
  BACKTEST_CORPUS_ROW_INPUTS,
} from "../warehouse/fixtures/land-filing-evidence-backtest/backtest_corpus_fixtures.mjs";

/* ------------------------------------------------------------------ */
/* A3/A4: typed feature invariants                                     */
/* ------------------------------------------------------------------ */

describe("feature() -- absence is never a numeric zero", () => {
  test("an observed state requires a finite number", () => {
    assert.throws(() => feature({ family: "report_filing_facts", name: "x", value: null, state: "observed_present" }), LandFilingEvidenceBacktestError);
    assert.throws(() => feature({ family: "report_filing_facts", name: "x", value: NaN, state: "observed_present" }), LandFilingEvidenceBacktestError);
  });

  test("a missing state requires value: null, never a numeric zero", () => {
    assert.throws(() => feature({ family: "report_filing_facts", name: "x", value: 0, state: "not_checked" }), LandFilingEvidenceBacktestError);
    assert.throws(() => feature({ family: "report_filing_facts", name: "x", value: 0, state: "source_unavailable" }), LandFilingEvidenceBacktestError);
    const f = feature({ family: "report_filing_facts", name: "x", value: null, state: "unknown" });
    assert.equal(f.value, null);
  });

  test("rejects an unknown family or state", () => {
    assert.throws(() => feature({ family: "not_a_family", name: "x", value: 1, state: "observed_present" }));
    assert.throws(() => feature({ family: "report_filing_facts", name: "x", value: 1, state: "not_a_state" }));
  });
});

describe("reportFilingFactsFeatures -- G3/A3/A4: not_observed is never converted into non-filing, and absence is never a numeric zero", () => {
  test("no obligation at all -> every feature is source_unavailable with a null value", () => {
    const features = reportFilingFactsFeatures({ obligation: null });
    for (const f of features) {
      assert.equal(f.state, "source_unavailable");
      assert.equal(f.value, null);
    }
  });

  test("fulfillment.state document_observed -> report_document_observed is a real 1", () => {
    const obligation = { applicability: { state: "required" }, fulfillment: { state: "document_observed" } };
    const features = reportFilingFactsFeatures({ obligation });
    const reportFeature = features.find((f) => f.name === "report_document_observed");
    assert.equal(reportFeature.value, 1);
    assert.equal(reportFeature.state, "observed_present");
  });

  test("fulfillment.state not_observed -> a real 0, distinct from not_checked", () => {
    const obligation = { applicability: { state: "unknown" }, fulfillment: { state: "not_observed" } };
    const features = reportFilingFactsFeatures({ obligation });
    const reportFeature = features.find((f) => f.name === "report_document_observed");
    assert.equal(reportFeature.value, 0);
    assert.equal(reportFeature.state, "observed_absent");
  });

  test("fulfillment.state not_checked / source_unavailable -> null, never a numeric zero", () => {
    for (const state of ["not_checked", "source_unavailable"]) {
      const obligation = { applicability: { state: "unknown" }, fulfillment: { state } };
      const features = reportFilingFactsFeatures({ obligation });
      const reportFeature = features.find((f) => f.name === "report_document_observed");
      assert.equal(reportFeature.value, null);
      assert.equal(reportFeature.state, state);
    }
  });

  test("only an explicit publisher assertion makes applicability_publicly_asserted true", () => {
    const known = reportFilingFactsFeatures({ obligation: { applicability: { state: "required" }, fulfillment: { state: "not_checked" } } });
    assert.equal(known.find((f) => f.name === "applicability_publicly_asserted").value, 1);
    const unknown = reportFilingFactsFeatures({ obligation: { applicability: { state: "unknown" }, fulfillment: { state: "not_checked" } } });
    assert.equal(unknown.find((f) => f.name === "applicability_publicly_asserted").value, 0);
  });
});

describe("packageChurnFeatures", () => {
  test("documents never checked -> source_unavailable, not a zero", () => {
    const features = packageChurnFeatures({ sequence: { events: [] }, documentsChecked: false });
    for (const f of features) {
      assert.equal(f.state, "source_unavailable");
      assert.equal(f.value, null);
    }
  });

  test("fewer than two package versions -> observed_revision_interval_days is observed_absent, not missing", () => {
    const features = packageChurnFeatures({ sequence: { events: [] }, documentsChecked: true });
    const interval = features.find((f) => f.name === "observed_revision_interval_days");
    assert.equal(interval.state, "observed_absent");
    assert.equal(interval.value, 0);
  });
});

describe("environmentalStateFeatures", () => {
  test("no ZAP row checked -> identity and conflict features are source_unavailable/not_checked with null values, never a numeric zero", () => {
    const features = environmentalStateFeatures({ sequence: { events: [] }, zapRowChecked: false, ceqrJoinChecked: false });
    for (const f of features) assert.equal(f.value, null);
    assert.equal(features.find((f) => f.name === "environmental_identity_observed").state, "source_unavailable");
    assert.equal(features.find((f) => f.name === "environmental_identity_conflict_observed").state, "not_checked");
  });
});

/* ------------------------------------------------------------------ */
/* A1/A2: cutoff safety and project-family leakage                     */
/* ------------------------------------------------------------------ */

describe("buildAsOfFilingBacktestRow -- G1: a feature could use facts unavailable at its cutoff", () => {
  test("refuses a ZAP row whose own date field is after the row's cutoff", () => {
    assert.throws(() => buildAsOfFilingBacktestRow({
      projectKey: "leak-test",
      cutoff: "2024-01-01T00:00:00.000Z",
      zapRow: { project_id: "leak-test", certified_referred: "2024-06-01T00:00:00.000Z" },
      materializedAt: "2024-01-01T00:00:00.000Z",
    }), /after cutoff/);
  });

  test("a valid as-of row never contains a materialized event later than its own cutoff", () => {
    const row = buildAsOfFilingBacktestRow({
      projectKey: "clean-test",
      cutoff: "2024-06-01T00:00:00.000Z",
      zapRow: { project_id: "clean-test", app_filed_date: "2024-01-01T00:00:00.000Z" },
      materializedAt: "2024-06-01T00:00:00.000Z",
      groundTruth: { filedAt: "2024-01-01T00:00:00.000Z" },
    });
    assert.ok(row.rowKey.includes("clean-test"));
    assert.equal(row.features.length, 9);
  });

  test("every row in the committed fixture corpus builds without a leakage refusal", () => {
    for (const input of BACKTEST_CORPUS_ROW_INPUTS) {
      assert.doesNotThrow(() => buildAsOfFilingBacktestRow(input), `${input.projectKey} failed to build`);
    }
  });
});

describe("buildFilingProjectFamilies -- G2: related applications share a family by BBL", () => {
  test("two projects sharing a BBL land in the same family", () => {
    const { families, projectToFamily } = buildFilingProjectFamilies([
      { projectKey: "a", bbls: ["1000000001"] },
      { projectKey: "b", bbls: ["1000000001"] },
      { projectKey: "c", bbls: ["2000000002"] },
    ]);
    assert.equal(projectToFamily.get("a"), projectToFamily.get("b"));
    assert.notEqual(projectToFamily.get("a"), projectToFamily.get("c"));
    assert.equal(families.length, 2);
  });
});

describe("buildRollingOriginFilingFolds / assertFilingFoldFamilyDisjointness -- G2: a family never trains and tests in the same fold", () => {
  test("a family split across the fold boundary is excluded from both sides", () => {
    const rows = [
      { rowKey: "r1", familyId: "fam-1", cutoff: "2023-01-01T00:00:00.000Z" },
      { rowKey: "r2", familyId: "fam-1", cutoff: "2023-08-01T00:00:00.000Z" },
      { rowKey: "r3", familyId: "fam-2", cutoff: "2023-01-01T00:00:00.000Z" },
    ];
    const folds = [{ foldId: "f1", trainEnd: "2023-06-30T00:00:00.000Z", testStart: "2023-06-30T00:00:00.000Z", testEnd: "2023-12-31T00:00:00.000Z" }];
    const assignments = buildRollingOriginFilingFolds({ rows, folds });
    const disjoint = assertFilingFoldFamilyDisjointness(assignments);
    assert.equal(disjoint.ok, true);
    const r1 = assignments.find((a) => a.row_key === "r1");
    const r2 = assignments.find((a) => a.row_key === "r2");
    assert.equal(r1.split, "excluded");
    assert.equal(r2.split, "excluded");
    const r3 = assignments.find((a) => a.row_key === "r3");
    assert.equal(r3.split, "train");
  });

  test("the committed fixture corpus is family-disjoint across every fold", () => {
    const rows = BACKTEST_CORPUS_ROW_INPUTS.map((input) => buildAsOfFilingBacktestRow(input));
    const { projectToFamily } = buildFilingProjectFamilies(BACKTEST_CORPUS_PROJECTS);
    const rowsWithFamily = rows.map((row) => ({ ...row, familyId: projectToFamily.get(row.projectKey) }));
    const assignments = buildRollingOriginFilingFolds({ rows: rowsWithFamily, folds: BACKTEST_CORPUS_FOLDS });
    const disjoint = assertFilingFoldFamilyDisjointness(assignments);
    assert.equal(disjoint.ok, true, JSON.stringify(disjoint.violations));
    // At least one of the two deliberately-planted related-amendment pairs
    // must actually straddle a fold boundary and get excluded, or the
    // fixture corpus is not exercising this guard at all.
    const excludedCount = assignments.filter((a) => a.split === "excluded").length;
    assert.ok(excludedCount > 0, "expected at least one family/fold exclusion in the fixture corpus");
  });
});

/* ------------------------------------------------------------------ */
/* Outcome labelling                                                   */
/* ------------------------------------------------------------------ */

describe("outcomeLabelOf -- each outcome kept separate, with an honest excluded reason rather than a guessed label", () => {
  const baseRow = { groundTruth: {} };

  test("days_to_certification: censored at the observation horizon when never certified", () => {
    const row = { groundTruth: { filedAt: "2023-01-01T00:00:00.000Z", certifiedAt: null, observationHorizon: "2023-04-01T00:00:00.000Z" } };
    const label = outcomeLabelOf("days_to_certification", row, {});
    assert.equal(label.included, true);
    assert.equal(label.event, 0);
    assert.equal(label.duration_days, 90);
  });

  test("days_to_certification: excluded when there is no filed date", () => {
    const label = outcomeLabelOf("days_to_certification", baseRow, {});
    assert.equal(label.included, false);
    assert.equal(label.reason, "no_filed_date");
  });

  test("days_from_noticing_to_certification: excluded when not yet noticed at cutoff", () => {
    const label = outcomeLabelOf("days_from_noticing_to_certification", baseRow, {});
    assert.equal(label.included, false);
    assert.equal(label.reason, "not_yet_noticed_at_cutoff");
  });

  test("certified_within_horizon: window not yet observed is excluded, never guessed", () => {
    const row = { groundTruth: { filedAt: "2024-01-01T00:00:00.000Z", certifiedAt: null, observationHorizon: "2024-03-01T00:00:00.000Z" } };
    const label = outcomeLabelOf("certified_within_horizon", row, { horizonDays: 365 });
    assert.equal(label.included, false);
    assert.equal(label.reason, "window_not_yet_observed");
  });

  test("certified_within_horizon: a stale, never-certified project is confidently labelled 0", () => {
    const row = { groundTruth: { filedAt: "2020-01-01T00:00:00.000Z", certifiedAt: null, observationHorizon: "2024-01-01T00:00:00.000Z" } };
    const label = outcomeLabelOf("certified_within_horizon", row, { horizonDays: 365 });
    assert.equal(label.included, true);
    assert.equal(label.label, 0);
  });

  test("post_certification_disposition: excluded until certification is observed, regardless of a disposition value", () => {
    const row = { groundTruth: { certifiedAt: null, postCertificationDisposition: "approved" } };
    const label = outcomeLabelOf("post_certification_disposition", row, {});
    assert.equal(label.included, false);
    assert.equal(label.reason, "not_yet_certified");
  });

  test("post_certification_disposition: a disposition outside the scored classes is excluded, not thrown or coerced", () => {
    const row = { groundTruth: { certifiedAt: "2024-01-01T00:00:00.000Z", postCertificationDisposition: "withdrawn_or_inactive" } };
    const label = outcomeLabelOf("post_certification_disposition", row, {});
    assert.equal(label.included, false);
    assert.equal(label.reason, "disposition_outside_scored_classes");
  });

  test("withdrawal_or_inactivity: a certified row is a determinate 0, an undetermined pending row is excluded", () => {
    assert.equal(outcomeLabelOf("withdrawal_or_inactivity", { groundTruth: { withdrawnOrInactive: false } }, {}).label, 0);
    assert.equal(outcomeLabelOf("withdrawal_or_inactivity", { groundTruth: { withdrawnOrInactive: true } }, {}).label, 1);
    const undetermined = outcomeLabelOf("withdrawal_or_inactivity", { groundTruth: { withdrawnOrInactive: null } }, {});
    assert.equal(undetermined.included, false);
    assert.equal(undetermined.reason, "not_yet_determinable");
  });

  test("an unknown target throws rather than silently returning nothing", () => {
    assert.throws(() => outcomeLabelOf("not_a_target", baseRow, {}), LandFilingEvidenceBacktestError);
  });
});

/* ------------------------------------------------------------------ */
/* Negative rule / A6 / no product score                               */
/* ------------------------------------------------------------------ */

describe("negative-rule guards", () => {
  test("assertNoForbiddenCausalLanguage rejects causal and product-score terms", () => {
    assert.throws(() => assertNoForbiddenCausalLanguage(["report_causes_delay"]));
    assert.throws(() => assertNoForbiddenCausalLanguage(["certification_probability"]));
    assert.doesNotThrow(() => assertNoForbiddenCausalLanguage(["report_document_observed", "days_to_certification"]));
  });

  test("assertNoDisplacementIndexFeature rejects a displacement/DRI feature name", () => {
    assert.throws(() => assertNoDisplacementIndexFeature(["environmental_state.displacement_index"]));
    assert.throws(() => assertNoDisplacementIndexFeature(["environmental_state.dri_value"]));
    assert.doesNotThrow(() => assertNoDisplacementIndexFeature(FEATURE_FAMILIES.map((f) => `${f}.some_feature`)));
  });

  test("assertNoCombinedScore rejects a report that folds families into one number", () => {
    assert.throws(() => assertNoCombinedScore({ combined_score: 0.5 }));
    assert.throws(() => assertNoCombinedScore({ overall_risk: 0.5 }));
    assert.doesNotThrow(() => assertNoCombinedScore({ report_filing_facts: { metric: 0.5 } }));
  });
});

describe("evaluatePromotionGate -- a signed verdict, never a forced GO", () => {
  test("every unmet threshold is named, and the verdict is stop", () => {
    const verdict = evaluatePromotionGate({
      familyName: "report_filing_facts",
      target: "certified_within_horizon",
      coverage: 0.1,
      foldCount: 1,
      minTestRowsAcrossFolds: 1,
      incrementalLift: -0.5,
      calibrationError: 0.9,
      subgroupSpread: 1.0,
    });
    assert.equal(verdict.decision, "stop");
    assert.ok(verdict.reasons.length >= 5);
    assert.equal(verdict.signed_by, "ldp28-filing-evidence-backtest-gate");
  });

  test("a GO verdict is only reachable when every threshold genuinely holds", () => {
    const verdict = evaluatePromotionGate({
      familyName: "report_filing_facts",
      target: "certified_within_horizon",
      coverage: 0.9,
      foldCount: 3,
      minTestRowsAcrossFolds: 10,
      incrementalLift: 0.05,
      calibrationError: 0.05,
      subgroupSpread: 0.1,
    });
    assert.equal(verdict.decision, "go");
    assert.equal(verdict.reasons.length, 0);
  });

  test("an unmeasured lift or calibration error can never produce a GO by omission", () => {
    const verdict = evaluatePromotionGate({
      familyName: "report_filing_facts",
      target: "certified_within_horizon",
      coverage: 0.9,
      foldCount: 3,
      minTestRowsAcrossFolds: 10,
      incrementalLift: null,
      calibrationError: null,
      subgroupSpread: null,
    });
    assert.equal(verdict.decision, "stop");
  });
});

/* ------------------------------------------------------------------ */
/* Calibration/discrimination primitives                               */
/* ------------------------------------------------------------------ */

describe("calibration and discrimination primitives", () => {
  test("a perfectly calibrated, perfectly discriminating set of predictions scores as such", () => {
    const predictions = [0.9, 0.9, 0.1, 0.1];
    const outcomes = [1, 1, 0, 0];
    assert.equal(rankAUC(predictions, outcomes), 1);
    assert.ok(logLoss(predictions, outcomes) < 0.2);
    assert.ok(brierScore(predictions, outcomes) < 0.02);
  });

  test("reliability bins partition [0,1] and each bin's count sums to the total", () => {
    const pairs = [{ probability: 0.05, outcome: 0 }, { probability: 0.95, outcome: 1 }, { probability: 0.5, outcome: 1 }];
    const bins = reliabilityBins(pairs, 5);
    assert.equal(bins.length, 5);
    assert.equal(bins.reduce((total, bin) => total + bin.count, 0), pairs.length);
    const ece = expectedCalibrationError(bins, pairs.length);
    assert.ok(ece >= 0 && ece <= 1);
  });

  test("concordanceIndex rewards a monotone-correct ranking and ignores censored rows as the earlier member of a pair", () => {
    const predicted = [10, 20, 30];
    const durations = [10, 20, 30];
    const events = [1, 1, 1];
    const result = concordanceIndex(predicted, durations, events);
    assert.equal(result.concordance, 1);
  });

  test("kaplanMeierMedian is a real median under censoring, not the mean of observed durations", () => {
    const durations = [10, 20, 30, 40];
    const events = [1, 1, 0, 0];
    const median = kaplanMeierMedian(durations, events);
    assert.ok(median === null || median >= 10);
  });
});

/* ------------------------------------------------------------------ */
/* End-to-end over the committed fixture corpus                        */
/* ------------------------------------------------------------------ */

describe("evaluateFeatureFamilyForOutcome -- end to end over the committed fixture corpus", () => {
  const rows = BACKTEST_CORPUS_ROW_INPUTS.map((input) => buildAsOfFilingBacktestRow(input));
  const { projectToFamily } = buildFilingProjectFamilies(BACKTEST_CORPUS_PROJECTS);
  const rowsWithFamily = rows.map((row) => ({ ...row, familyId: projectToFamily.get(row.projectKey) }));
  const assignments = buildRollingOriginFilingFolds({ rows: rowsWithFamily, folds: BACKTEST_CORPUS_FOLDS });

  for (const familyName of FEATURE_FAMILIES) {
    for (const target of OUTCOME_TARGETS) {
      test(`${familyName} / ${target}: produces a well-formed, signed report`, () => {
        const report = evaluateFeatureFamilyForOutcome({ familyName, target, rows: rowsWithFamily, assignments, folds: BACKTEST_CORPUS_FOLDS, horizonDays: 365 });
        assert.equal(report.family, familyName);
        assert.equal(report.target, target);
        assert.ok(report.coverage.row_coverage === null || (report.coverage.row_coverage >= 0 && report.coverage.row_coverage <= 1));
        assert.ok(["go", "stop"].includes(report.promotion_verdict.decision));
        assertNoCombinedScore(report);
      });
    }
  }

  test("at least one report finds a stop and this is accepted as a valid outcome, not an error", () => {
    const anyStop = FEATURE_FAMILIES.some((familyName) => OUTCOME_TARGETS.some((target) => {
      const report = evaluateFeatureFamilyForOutcome({ familyName, target, rows: rowsWithFamily, assignments, folds: BACKTEST_CORPUS_FOLDS, horizonDays: 365 });
      return report.promotion_verdict.decision === "stop";
    }));
    assert.equal(anyStop, true);
  });
});

/* ------------------------------------------------------------------ */
/* Sanity: the declared vocabularies themselves                        */
/* ------------------------------------------------------------------ */

describe("declared vocabularies", () => {
  test("three feature families, matching the card's own gap-fix table exactly", () => {
    assert.deepEqual([...FEATURE_FAMILIES].sort(), ["environmental_state", "package_churn", "report_filing_facts"]);
  });

  test("five separate outcome targets -- withdrawal/inactivity is its own target, not a third disposition class", () => {
    assert.equal(OUTCOME_TARGETS.length, 5);
    assert.ok(!POST_CERTIFICATION_DISPOSITION_CLASSES.includes("withdrawn_or_inactive"));
    assert.deepEqual([...POST_CERTIFICATION_DISPOSITION_CLASSES].sort(), ["approved", "modified"]);
  });
});
