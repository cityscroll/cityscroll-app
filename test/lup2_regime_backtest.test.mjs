/**
 * Cohort-separated backtest of the 2025 institutional break (LUP2-C12).
 *
 *   node --test test/lup2_regime_backtest.test.mjs
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  BOTTOM_TWELVE_LIST_EARLIEST_OFFICIAL_PUBLICATION,
  LAND_PREDICTION_REGIME_BACKTEST_GOLD_SCHEMA,
  LAND_PREDICTION_REGIME_BACKTEST_SCHEMA,
  MIN_DIVERGENCE_DENOMINATOR,
  MIN_HELD_OUT_N_FOR_LIFT_COMPARISON,
  NEGATIVE_CONTROL_KINDS,
  REGIME_BACKTEST_COHORTS,
  analyzeCounterfactualCase,
  assertReconstructedBottomTwelveListNeverOfficial,
  councilDispositionOutcomeLabel,
  evaluateNegativeControls,
  loadRegimeBacktestGoldPack,
  runLandPredictionRegimeBacktest,
  terminalOutcomeLabel,
} from "../worker/src/lib/land_prediction_regime_backtest.mjs";
import {
  assertNoCounterfactualLeakage,
} from "../worker/src/lib/land_prediction_regime_targets.mjs";
import {
  runLandPredictionBacktest,
} from "../worker/src/lib/land_prediction_backtest.mjs";
import goldFixture from "./fixtures/land_prediction_backtest/gold.v1.json" with { type: "json" };

const PROCEDURE_ID = "ulurp_197c";
const STAGE_ID = "ulurp_197c.city_council_review";

// 164th Street Rezoning, project_id 2024Q0164 (site/data/zap_projects_warehouse_lookup.json),
// the same fixture LUP2-C11's and LDP-19's suites use.
const STREET_164_PROJECT_ID = "2024Q0164";
// 50-20 108th Street Rezoning, project_id 2024Q0113 (same warehouse lookup).
const STREET_108TH_PROJECT_ID = "2024Q0113";
// No real warehouse project matches "1571 McDonald Avenue" at this data
// snapshot; used as a synthetic, clearly-labeled fixture, consistent with
// the sibling LUP2-C11/LDP-19/LDP-20 suites' synthetic fixtures.
const MCDONALD_AVE_ID = "fixture:1571-mcdonald-avenue";
// No real warehouse project matches "58-02 Northern Boulevard / N210390 ZRQ"
// at this data snapshot; used as a synthetic, clearly-labeled fixture,
// consistent with the sibling LDP-19 suite's synthetic fixture of the same
// address.
const NORTHERN_BLVD_ID = "fixture:58-02-northern-boulevard";
// 351 Powers Avenue, HPD, real ELURP canary (site/data/zap_projects_warehouse_lookup.json,
// test/land_review_regimes.test.mjs). Its procedure_id is the real elurp_197e
// profile a real HPD-sponsored, affordable, ELURP-expedited application
// resolves to -- distinct from the section 197-f "fast track" regime.
const POWERS_AVE_ID = "2026X0362";
const POWERS_AVE_PROCEDURE_ID = "elurp_197e";
// No real warehouse project matches these two addresses at this data
// snapshot; used as synthetic, clearly-labeled pre-reform counterfactual
// fixtures.
const BROADWAY_4650_ID = "fixture:4650-broadway";
const PACIFIC_ST_962_ID = "fixture:962-pacific-street";
// 80 Flatbush Avenue, project_id P2016K0250, real MIH-adopted rezoning
// (site/data/mih_project_lookup.json, adopted 2018-09-26). The Council
// modification premise used below is a hypothetical counterfactual premise
// for this card's analysis, not a documented claim about this project's
// actual legislative history.
const FLATBUSH_80_ID = "P2016K0250";

const CLASS_SOURCE = (overrides = {}) => ({
  kind: "official_application_classification",
  value: true,
  record_id: "cpc-class:fixture",
  observed_at: "2026-05-15T00:00:00.000Z",
  ...overrides,
});

function fixtureFeatures(applicationId, cutoff) {
  return [{
    key: "application_type",
    value: "zoning_map_amendment",
    evidence_type: "official_record",
    observed_at: cutoff,
    source: { url: `https://example.invalid/${applicationId}` },
  }];
}

// ---------------------------------------------------------------------------
// The frozen fixture pack (A1): every initial factual, counterfactual, and
// negative case named in the card, with exact application/project
// identifiers and source dates.
// ---------------------------------------------------------------------------

function goldPack() {
  return {
    schema: LAND_PREDICTION_REGIME_BACKTEST_GOLD_SCHEMA,
    version: "lup2-c12-gold.v1",
    purpose: "Cohort-separated backtest of the December 2025 institutional break.",
    factual: [
      {
        id: "factual:164th-street",
        application_id: STREET_164_PROJECT_ID,
        base_procedure_id: PROCEDURE_ID,
        base_stage_id: STAGE_ID,
        prediction_as_of: "2026-06-15T00:00:00.000Z",
        outcome_at: "2026-07-01T00:00:00.000Z",
        features: fixtureFeatures(STREET_164_PROJECT_ID, "2026-06-15T00:00:00.000Z"),
        council_action: { vote: "approve" },
        cohorts: ["factual"],
      },
      {
        id: "factual:50-20-108th-street",
        application_id: STREET_108TH_PROJECT_ID,
        base_procedure_id: PROCEDURE_ID,
        base_stage_id: STAGE_ID,
        prediction_as_of: "2026-07-01T00:00:00.000Z",
        outcome_at: "2026-07-20T00:00:00.000Z",
        features: fixtureFeatures(STREET_108TH_PROJECT_ID, "2026-07-01T00:00:00.000Z"),
        council_action: { vote: "approve", modified: true },
        // No eligible-application-class source yet: the modification is
        // known; whether an appeal is even eligible is not yet established.
        eligible_application_class_source: null,
        cohorts: ["factual"],
      },
      {
        id: "factual:2811-atlantic-avenue",
        application_id: "fixture:2811-atlantic-avenue",
        base_procedure_id: PROCEDURE_ID,
        base_stage_id: STAGE_ID,
        prediction_as_of: "2026-08-01T00:00:00.000Z",
        outcome_at: "2026-08-20T00:00:00.000Z",
        features: fixtureFeatures("fixture:2811-atlantic-avenue", "2026-08-01T00:00:00.000Z"),
        council_action: { vote: "disapprove" },
        // Explicitly determined ineligible for appeals review, so this
        // disapproval resolves terminal outcome cleanly through the Council
        // path rather than opening a potential-but-undetermined review.
        eligible_application_class_source: CLASS_SOURCE({
          value: false,
          record_id: "cpc-class:fixture:2811-atlantic-avenue",
        }),
        cohorts: ["factual"],
      },
      {
        id: "factual:77-remsen-street",
        application_id: "fixture:77-remsen-street",
        base_procedure_id: PROCEDURE_ID,
        base_stage_id: STAGE_ID,
        prediction_as_of: "2026-08-10T00:00:00.000Z",
        outcome_at: "2026-08-25T00:00:00.000Z",
        features: fixtureFeatures("fixture:77-remsen-street", "2026-08-10T00:00:00.000Z"),
        council_action: { vote: "approve" },
        cohorts: ["factual"],
      },
    ],
    counterfactual: [
      {
        id: "counterfactual:4650-broadway",
        application_id: BROADWAY_4650_ID,
        regime_id: "affordable_housing_appeals_197g",
        historical_prediction_as_of: "2022-03-01",
        council_action: { vote: "disapprove" },
        facts: { "affordable_housing.section_197g.eligible_application_class": true },
      },
      {
        id: "counterfactual:962-pacific-street",
        application_id: PACIFIC_ST_962_ID,
        regime_id: "affordable_housing_appeals_197g",
        historical_prediction_as_of: "2023-09-01",
        council_action: { vote: "disapprove" },
        facts: { "affordable_housing.section_197g.eligible_application_class": true },
      },
      {
        id: "counterfactual:80-flatbush",
        application_id: FLATBUSH_80_ID,
        regime_id: "affordable_housing_appeals_197g",
        // Real MIH adoption date is 2018-09-26; this cutoff predates it
        // slightly to frame the counterfactual at the point of Council
        // action, not after the fact.
        historical_prediction_as_of: "2018-09-01",
        // Hypothetical premise for this counterfactual only -- see the note
        // on FLATBUSH_80_ID above.
        council_action: { vote: "approve", modified: true },
        facts: { "affordable_housing.section_197g.eligible_application_class": true },
      },
    ],
    negative: [
      {
        id: "negative:1571-mcdonald-avenue",
        kind: "withdrawal_not_disapproval",
        application_id: MCDONALD_AVE_ID,
        base_procedure_id: PROCEDURE_ID,
        base_stage_id: STAGE_ID,
        prediction_as_of: "2026-05-01",
        council_action: { no_vote: true },
      },
      {
        id: "negative:58-02-northern-boulevard",
        kind: "mapping_token_insufficient",
        application_id: NORTHERN_BLVD_ID,
        base_procedure_id: PROCEDURE_ID,
        base_stage_id: STAGE_ID,
        prediction_as_of: "2026-06-01",
        eligible_application_class_source: { kind: "inclusionary_housing_map_designation", value: true, mih_flag: true },
      },
      {
        id: "negative:164th-street-potential-eligibility",
        kind: "potential_eligibility_no_trigger_on_unchanged_approval",
        application_id: STREET_164_PROJECT_ID,
        base_procedure_id: PROCEDURE_ID,
        base_stage_id: STAGE_ID,
        prediction_as_of: "2026-07-01",
        eligible_application_class_source: CLASS_SOURCE(),
      },
      {
        id: "negative:50-20-108th-street-modification",
        kind: "modification_opens_evaluation_without_manufactured_appeal",
        application_id: STREET_108TH_PROJECT_ID,
        base_procedure_id: PROCEDURE_ID,
        base_stage_id: STAGE_ID,
        prediction_as_of: "2026-07-15",
        eligible_application_class_source: CLASS_SOURCE({ record_id: `cpc-class:${STREET_108TH_PROJECT_ID}` }),
      },
      {
        id: "negative:351-powers-avenue",
        kind: "expedited_stays_expedited_not_fast_track",
        application_id: POWERS_AVE_ID,
        procedure_id: POWERS_AVE_PROCEDURE_ID,
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// A1: the frozen fixture pack names every initial case with exact
// identifiers and source dates
// ---------------------------------------------------------------------------

test("A1 the frozen fixture pack names every initial case with exact identifiers", () => {
  const gold = goldPack();
  assert.deepEqual(Object.keys(gold).filter((key) => REGIME_BACKTEST_COHORTS.includes(key)).sort(), [...REGIME_BACKTEST_COHORTS].sort());
  const factualIds = gold.factual.map((row) => row.application_id);
  assert.ok(factualIds.includes(STREET_164_PROJECT_ID));
  assert.ok(factualIds.includes(STREET_108TH_PROJECT_ID));
  const counterfactualIds = gold.counterfactual.map((row) => row.application_id);
  assert.deepEqual(counterfactualIds.sort(), [BROADWAY_4650_ID, FLATBUSH_80_ID, PACIFIC_ST_962_ID].sort());
  const negativeIds = gold.negative.map((row) => row.application_id);
  assert.deepEqual(negativeIds.sort(), [
    MCDONALD_AVE_ID,
    NORTHERN_BLVD_ID,
    POWERS_AVE_ID,
    STREET_108TH_PROJECT_ID,
    STREET_164_PROJECT_ID,
  ].sort());
  for (const row of [...gold.factual, ...gold.counterfactual, ...gold.negative]) {
    assert.ok(row.id, "every case must carry an exact id");
  }
});

// ---------------------------------------------------------------------------
// A2, A3, G1: loader-enforced cohort separation
// ---------------------------------------------------------------------------

test("A2 the loader partitions factual/counterfactual/negative and rejects an id reused across cohorts", () => {
  const loaded = loadRegimeBacktestGoldPack(goldPack());
  assert.equal(loaded.factual.length, 4);
  assert.equal(loaded.counterfactual.length, 3);
  assert.equal(loaded.negative.length, 5);

  const mixed = goldPack();
  mixed.negative.push({ ...mixed.factual[0] });
  assert.throws(
    () => loadRegimeBacktestGoldPack(mixed),
    /appears in both the factual and negative cohorts/,
  );
});

test("A3 pre-2025 counterfactual appeals availability never enters factual training features", () => {
  const gold = loadRegimeBacktestGoldPack(goldPack());
  const receipt = runLandPredictionRegimeBacktest(goldPack());
  void gold;
  const dump = JSON.stringify(receipt.council_disposition) + JSON.stringify(receipt.terminal_outcome);
  assert.equal(dump.includes('"counterfactual":true'), false);
  for (const analysis of receipt.counterfactual_analyses) {
    assert.throws(() => assertNoCounterfactualLeakage(analysis.counterfactual_regime_eligibility));
  }
});

// ---------------------------------------------------------------------------
// A4, A5: counterfactual cases never assign a hypothetical appeals result
// ---------------------------------------------------------------------------

test("A4 4650 Broadway and 962 Pacific Street resolve as Council-disapproval counterfactuals without a hypothetical appeals result", () => {
  const gold = goldPack();
  for (const row of gold.counterfactual.filter((r) => r.application_id === BROADWAY_4650_ID || r.application_id === PACIFIC_ST_962_ID)) {
    const analysis = analyzeCounterfactualCase(row);
    assert.equal(analysis.council_disposition, "disapproved");
    assert.equal(analysis.counterfactual_regime_eligibility.counterfactual, true);
    assert.equal(analysis.counterfactual_regime_eligibility.factual, false);
    assert.equal(analysis.hypothetical_appeals_result_assigned, false);
    // The real historical outcome is resolved from the council path alone --
    // never from a simulated appeals board disposition.
    assert.equal(analysis.real_terminal_outcome, "unauthorized");
    assert.notEqual(analysis.real_terminal_authorization_path, "appeals_review_197g");
  }
});

test("A5 80 Flatbush resolves as a Council-modification counterfactual without assuming an appeal", () => {
  const gold = goldPack();
  const row = gold.counterfactual.find((r) => r.application_id === FLATBUSH_80_ID);
  const analysis = analyzeCounterfactualCase(row);
  assert.equal(analysis.application_id, FLATBUSH_80_ID);
  assert.equal(analysis.council_disposition, "approved_modified");
  assert.equal(analysis.counterfactual_regime_eligibility.counterfactual, true);
  assert.equal(analysis.hypothetical_appeals_result_assigned, false);
  // A modification alone, with no real regime in force, authorizes through
  // the council path -- the applicant is never assumed to have appealed.
  assert.equal(analysis.real_terminal_outcome, "authorized");
  assert.equal(analysis.real_terminal_authorization_path, "council");
});

// ---------------------------------------------------------------------------
// A6-A10: each negative control fails on its own named distinction
// ---------------------------------------------------------------------------

test("A6 1571 McDonald Avenue fails the appeals trigger because withdrawal is not a qualifying disapproval or modification", () => {
  const gold = goldPack();
  const row = gold.negative.find((r) => r.application_id === MCDONALD_AVE_ID);
  const [result] = evaluateNegativeControls([row]);
  assert.equal(result.kind, "withdrawal_not_disapproval");
  assert.equal(result.passed, true);
  assert.equal(result.detail.disposition, "withdrawn_or_no_vote");
  assert.equal(result.detail.trigger_status, "none");
});

test("A7 58-02 Northern Boulevard demonstrates a mapping token alone is insufficient for the statutory criterion", () => {
  const gold = goldPack();
  const row = gold.negative.find((r) => r.application_id === NORTHERN_BLVD_ID);
  const [result] = evaluateNegativeControls([row]);
  assert.equal(result.kind, "mapping_token_insufficient");
  assert.equal(result.passed, true);
  assert.equal(result.detail.fact_state, "unknown");
  assert.ok(result.detail.fact_reason.startsWith("source_kind_not_authoritative"));
});

test("A8 164th Street proves potential eligibility with an unchanged Council action yields no appeals trigger", () => {
  const gold = goldPack();
  const row = gold.negative.find((r) => r.id === "negative:164th-street-potential-eligibility");
  const [result] = evaluateNegativeControls([row]);
  assert.equal(result.kind, "potential_eligibility_no_trigger_on_unchanged_approval");
  assert.equal(result.passed, true);
  assert.equal(result.detail.potential_status, "eligible");
  assert.equal(result.detail.trigger_status, "none");
});

test("A9 50-20 108th Street proves a Council modification opens an evaluation without manufacturing an actual appeal", () => {
  const gold = goldPack();
  const row = gold.negative.find((r) => r.id === "negative:50-20-108th-street-modification");
  const [result] = evaluateNegativeControls([row]);
  assert.equal(result.kind, "modification_opens_evaluation_without_manufactured_appeal");
  assert.equal(result.passed, true);
  assert.equal(result.detail.trigger_status, "confirmed");
  assert.notEqual(result.detail.transitions_status, "resolved");
  assert.equal(result.detail.event_count, 0);
});

test("A10 351 Powers Avenue proves an affordable expedited application stays expedited, not fast-track", () => {
  const gold = goldPack();
  const row = gold.negative.find((r) => r.application_id === POWERS_AVE_ID);
  const [result] = evaluateNegativeControls([row]);
  assert.equal(result.kind, "expedited_stays_expedited_not_fast_track");
  assert.equal(result.passed, true);
  assert.equal(result.detail.applicable, false);
  assert.equal(result.detail.eligibility_status, "unknown");
});

test("every named negative control kind in the card is exercised, and an unrecognized kind throws", () => {
  const gold = goldPack();
  assert.deepEqual(gold.negative.map((row) => row.kind).sort(), [...NEGATIVE_CONTROL_KINDS].sort());
  assert.throws(() => evaluateNegativeControls([{ id: "x", kind: "not_a_real_kind" }]));
});

// ---------------------------------------------------------------------------
// A11, A12: publication-date and operative-date gates on the fast-track list
// ---------------------------------------------------------------------------

test("A11 a reconstructed bottom-twelve district list is never treated as official, before or after its earliest possible publication date", () => {
  assert.equal(BOTTOM_TWELVE_LIST_EARLIEST_OFFICIAL_PUBLICATION, "2026-10-01");
  const before = assertReconstructedBottomTwelveListNeverOfficial({
    project_id: "fixture:reconstructed-list-case",
    filing_date: "2026-06-01",
    reconstructed_candidate: { cycle_id: "reconstructed-2026", ranked_from: "public housing-production data" },
  });
  assert.notEqual(before.state, "known_true");
  assert.equal(before.reconstructed_candidate.authoritative, false);

  const after = assertReconstructedBottomTwelveListNeverOfficial({
    project_id: "fixture:reconstructed-list-case",
    filing_date: "2026-11-01",
    reconstructed_candidate: { cycle_id: "reconstructed-2026", ranked_from: "public housing-production data" },
  });
  assert.notEqual(after.state, "known_true");
  assert.equal(after.reconstructed_candidate.authoritative, false);
});

test("A12 before January 1, 2027, no factual application is scored as having used the section 197-f fast track", () => {
  const fact = assertReconstructedBottomTwelveListNeverOfficial({
    project_id: "fixture:fast-track-case",
    filing_date: "2026-12-31",
    reconstructed_candidate: null,
    cycle_lists: [{
      cycle_id: "hypothetical-cycle",
      version: 1,
      source_status: "enacted",
      effective_from: "2026-01-01",
      published_at: "2026-12-31",
      listed_project_ids: ["fixture:fast-track-case"],
    }],
  });
  assert.equal(fact.state, "not_yet_effective");
});

// ---------------------------------------------------------------------------
// A13: no appeals-reversal prediction and no synthetic counterfactual outcome
// ---------------------------------------------------------------------------

test("A13 no synthetic counterfactual outcome is ever produced, and no model is trained on one", () => {
  const gold = goldPack();
  for (const row of gold.counterfactual) {
    const analysis = analyzeCounterfactualCase(row);
    assert.equal(analysis.hypothetical_appeals_result_assigned, false);
  }
  const receipt = runLandPredictionRegimeBacktest(goldPack());
  const dump = JSON.stringify(receipt);
  // No counterfactual row's application id appears anywhere inside the two
  // trained model families.
  for (const row of gold.counterfactual) {
    assert.equal(
      JSON.stringify({ council: receipt.council_disposition, terminal: receipt.terminal_outcome }).includes(row.application_id),
      false,
    );
  }
});

// ---------------------------------------------------------------------------
// A14: the existing member-stance backtest stays reproducible as the
// pre-regime benchmark
// ---------------------------------------------------------------------------

test("A14 the existing LUP2-C7 member-stance backtest remains reproducible as the pre-regime benchmark", () => {
  const first = runLandPredictionBacktest(goldFixture);
  const second = runLandPredictionBacktest(goldFixture);
  assert.deepEqual(first.kill_criterion, second.kill_criterion);
  assert.deepEqual(first.promotion, second.promotion);
  assert.equal(first.promotion.incumbent_authoritative, true);
});

// ---------------------------------------------------------------------------
// A15, A16: explicit comparison once supported, and a null result recorded
// as success otherwise
// ---------------------------------------------------------------------------

test("A15 the report explicitly compares member-stance lift for Council disposition against terminal outcome", () => {
  const receipt = runLandPredictionRegimeBacktest(goldPack());
  assert.equal(receipt.comparison.schema, LAND_PREDICTION_REGIME_BACKTEST_SCHEMA);
  assert.ok(Object.hasOwn(receipt.comparison, "comparable"));
  assert.ok(Object.hasOwn(receipt.comparison, "council_disposition_stance_lift_brier"));
  assert.ok(Object.hasOwn(receipt.comparison, "terminal_outcome_stance_lift_brier"));
  // The initial factual pack is genuinely small; the comparison honestly
  // reports that it does not yet clear the held-out threshold rather than
  // computing a number from too few rows.
  assert.equal(receipt.comparison.comparable, false);
  assert.ok(receipt.council_disposition.n < MIN_HELD_OUT_N_FOR_LIFT_COMPARISON);
  assert.ok(receipt.terminal_outcome.n < MIN_HELD_OUT_N_FOR_LIFT_COMPARISON);
});

test("A16 a null or unestimable result is recorded as a successful result, never a forced conclusion", () => {
  const receipt = runLandPredictionRegimeBacktest(goldPack());
  assert.equal(receipt.null_result.unestimable, true);
  assert.equal(receipt.null_result.null_result_recorded_as_success, true);
  assert.equal(receipt.null_result.institutional_dilution_hypothesis_forced, false);
  assert.equal(receipt.divergence.status, "unestimable");
  assert.ok(receipt.divergence.denominator < MIN_DIVERGENCE_DENOMINATOR);
  assert.equal(receipt.promotion.all_criteria_met, false);
  assert.equal(receipt.promotion.promoted, false);
});

// ---------------------------------------------------------------------------
// G1: mixing council-disposition and terminal-outcome labels never happens
// ---------------------------------------------------------------------------

test("council disposition and terminal outcome labels are derived independently and a row missing one label is excluded from that target only", () => {
  assert.equal(councilDispositionOutcomeLabel("approved_unchanged"), "approved");
  assert.equal(councilDispositionOutcomeLabel("approved_modified"), "approved");
  assert.equal(councilDispositionOutcomeLabel("disapproved"), "disapproved");
  assert.equal(councilDispositionOutcomeLabel("withdrawn_or_no_vote"), null);
  assert.equal(councilDispositionOutcomeLabel("unresolved"), null);
  assert.equal(terminalOutcomeLabel("authorized"), "approved");
  assert.equal(terminalOutcomeLabel("unauthorized"), "disapproved");
  assert.equal(terminalOutcomeLabel("withdrawn"), null);
  assert.equal(terminalOutcomeLabel("unresolved"), null);

  const receipt = runLandPredictionRegimeBacktest(goldPack());
  // factual:50-20-108th-street has a known council disposition (approved
  // with modifications) but an unresolved terminal outcome: it must
  // contribute to the council-disposition population but not the
  // terminal-outcome population.
  assert.equal(receipt.council_disposition.n, 4);
  assert.equal(receipt.terminal_outcome.n, 3);
});

// ---------------------------------------------------------------------------
// Negative rule + schema shape
// ---------------------------------------------------------------------------

test("negative rule: no procedure or eligibility shortcuts leak into this module's output", () => {
  const receipt = runLandPredictionRegimeBacktest(goldPack());
  const dump = JSON.stringify(receipt);
  assert.equal(/"procedure(_id)?"\s*:\s*"(ahab|affordable|fast_track)"/.test(dump), false);
  assert.equal(dump.includes("qualifying_affordable"), false);
});

test("schema is versioned and cohort leakage stops the run rather than degrading silently", () => {
  assert.equal(LAND_PREDICTION_REGIME_BACKTEST_SCHEMA, "cityscroll.land_prediction_regime_backtest.v1");
  assert.equal(LAND_PREDICTION_REGIME_BACKTEST_GOLD_SCHEMA, "cityscroll.land_prediction_regime_backtest.gold.v1");
  const receipt = runLandPredictionRegimeBacktest(goldPack());
  assert.equal(receipt.cohort_counts.factual, 4);
  assert.equal(receipt.cohort_counts.counterfactual, 3);
  assert.equal(receipt.cohort_counts.negative, 5);
  assert.ok(receipt.dataset.fingerprint);

  const leaking = goldPack();
  leaking.negative.push({ ...leaking.factual[0], id: "duplicate-id" });
  leaking.factual.push({ ...leaking.factual[0], id: "duplicate-id" });
  assert.throws(() => runLandPredictionRegimeBacktest(leaking));
});
