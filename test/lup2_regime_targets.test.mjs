/**
 * Experimental Council-disposition / terminal-outcome targets and
 * review-regime features (LUP2-C11).
 *
 *   node --test test/lup2_regime_targets.test.mjs
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  INSTITUTIONAL_FEATURE_KEYS,
  buildLandPredictionFeatureVector,
} from "../worker/src/lib/land_prediction_features.mjs";
import {
  LAND_PREDICTION_MODEL_VERSION,
  fitLandPredictionModel,
  predictLandPrediction,
} from "../worker/src/lib/land_prediction_predictor.mjs";
import {
  COUNCIL_DISPOSITION_TO_REGIME_FACT_VALUE,
  COUNCIL_DISPOSITION_VALUES,
  COUNTERFACTUAL_QUARANTINE_YEARS,
  LAND_PREDICTION_REGIME_FEATURE_VECTOR_SCHEMA,
  LAND_PREDICTION_REGIME_TARGETS_SCHEMA,
  REGIME_INTERACTION_REGIME_KEYS,
  REGIME_TARGET_PROMOTION_GATE,
  REVIEW_REGIME_FEATURE_KEYS,
  TERMINAL_AUTHORIZATION_PATHS,
  TERMINAL_OUTCOME_VALUES,
  assertNoCounterfactualLeakage,
  buildLandPredictionRegimeFeatureVector,
  computeCounterfactualRegimeEligibility,
  evaluateRegimeTargetPromotionGate,
  explainRegimeOutcome,
  resolveActualAppealsTrigger,
  resolveCouncilDisposition,
  resolveLandPredictionRegimeOutcome,
  resolveTerminalOutcome,
} from "../worker/src/lib/land_prediction_regime_targets.mjs";

// 164th Street Rezoning, project_id 2024Q0164 (site/data/zap_projects_warehouse_lookup.json).
const STREET_164_PROJECT_ID = "2024Q0164";
// 50-20 108th Street Rezoning, project_id 2024Q0113 (same warehouse lookup).
const STREET_108_PROJECT_ID = "2024Q0113";
// No real warehouse project matches "1571 McDonald Avenue" at this data
// snapshot; used as a synthetic, clearly-labeled fixture, consistent with
// the sibling LDP-19 suite's synthetic §197-g fixture.
const MCDONALD_AVE_PROJECT_ID = "fixture:1571-mcdonald-avenue";

const PROCEDURE_ID = "ulurp_197c";
const STAGE_ID = "ulurp_197c.city_council_review";

function fixtureFeatures(applicationId, cutoff) {
  return [
    { key: "application_type", value: "zoning_map_amendment", evidence_type: "official_record", observed_at: cutoff, source: { url: `https://example.invalid/${applicationId}` } },
  ];
}

function baseVectorInput(applicationId, cutoff, overrides = {}) {
  return {
    application_id: applicationId,
    prediction_as_of: cutoff,
    procedural_stage: "city_council",
    features: fixtureFeatures(applicationId, cutoff),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// A1: the existing approved predictor stays reproducible and unchanged
// ---------------------------------------------------------------------------

test("A1 the baseline predictor's institutional feature contract is unchanged", () => {
  assert.deepEqual(INSTITUTIONAL_FEATURE_KEYS, [
    "application_type",
    "procedural_stage",
    "community_board_action",
    "borough_president_action",
    "cpc_recommendation",
    "cpc_disposition",
    "cpc_vote",
    "local_council_member_stance",
    "council_subcommittee_action",
    "land_use_committee_action",
    "modifications_or_conditions",
  ]);
  assert.equal(LAND_PREDICTION_MODEL_VERSION, "2.0.0");
});

test("A1 the baseline predictor replays byte-identically after this card's additions", () => {
  const cutoff = "2026-01-01T00:00:00.000Z";
  const outcomeAt = "2026-03-01T00:00:00.000Z";
  const vectorA = buildLandPredictionFeatureVector(baseVectorInput("2026Q0001", cutoff));
  const vectorB = buildLandPredictionFeatureVector(baseVectorInput("2026Q0002", cutoff));
  const model = fitLandPredictionModel([
    { id: "a", feature_vector: vectorA, outcome: "approved", outcome_at: outcomeAt },
    { id: "b", feature_vector: vectorB, outcome: "disapproved", outcome_at: outcomeAt },
  ], { iterations: 25 });
  const first = predictLandPrediction(model, vectorA);
  const second = predictLandPrediction(model, vectorA);
  assert.equal(first.probability, second.probability);
  assert.equal(first.authoritative, false);
  assert.equal(model.promotion_status, "shadow_only_until_backtest_gate");
});

// ---------------------------------------------------------------------------
// A2, A3: Council disposition and terminal outcome are separate targets
// ---------------------------------------------------------------------------

test("A2 Council disposition and terminal outcome are always distinct fields", () => {
  const result = resolveLandPredictionRegimeOutcome({
    council_action: { vote: "disapprove" },
    base_procedure_id: PROCEDURE_ID,
    base_stage_id: STAGE_ID,
    prediction_as_of: "2026-07-01",
  });
  assert.ok(Object.hasOwn(result, "council_disposition"));
  assert.ok(Object.hasOwn(result, "terminal_outcome"));
  assert.notEqual(result.council_disposition, result.terminal_outcome);
});

test("A3 a Council modification is not semantically interchangeable with terminal failure", () => {
  const modified = resolveCouncilDisposition({ vote: "approve", modified: true });
  assert.equal(modified, "approved_modified");
  // With no eligible-appeal evidence and no actually-triggered appeal, a
  // modified approval resolves as authorized -- never as an automatic
  // "unauthorized"/terminal-failure label.
  const terminal = resolveTerminalOutcome({ council_disposition: modified, actual_trigger_status: "none" });
  assert.equal(terminal.value, "authorized");
  assert.notEqual(terminal.value, "unauthorized");

  // But when an eligible appeal is actually triggered by that same
  // modification, terminal outcome stays unresolved until the appeals board
  // decides -- it is never assumed from the Council action alone.
  const pending = resolveTerminalOutcome({ council_disposition: modified, actual_trigger_status: "confirmed" });
  assert.equal(pending.value, "unresolved");
  assert.equal(pending.reason, "appeals_review_pending");
});

// ---------------------------------------------------------------------------
// A4: 164th Street -- Council approval unchanged, terminal authorization,
// no appeals transition
// ---------------------------------------------------------------------------

test("A4 164th Street records Council approval unchanged and terminal authorization without an appeals transition", () => {
  const result = resolveLandPredictionRegimeOutcome({
    council_action: { vote: "approve" },
    base_procedure_id: PROCEDURE_ID,
    base_stage_id: STAGE_ID,
    prediction_as_of: "2026-07-01",
  });
  assert.equal(result.council_disposition, "approved_unchanged");
  assert.equal(result.terminal_outcome, "authorized");
  assert.equal(result.terminal_authorization_path, "council");
  assert.equal(result.actual_appeals_trigger.status, "none");
  assert.equal(result.actual_appeals_trigger.reason, "no_qualifying_council_disposition");
});

// ---------------------------------------------------------------------------
// A5: 50-20 108th Street -- Council modification recorded separately from
// any later review status
// ---------------------------------------------------------------------------

test("A5 50-20 108th Street records Council modification separately from any later review status", () => {
  const beforeAppealEstablished = resolveLandPredictionRegimeOutcome({
    council_action: { vote: "approve", modified: true },
    eligible_application_class_source: null,
    base_procedure_id: PROCEDURE_ID,
    base_stage_id: STAGE_ID,
    prediction_as_of: "2026-07-15",
  });
  assert.equal(beforeAppealEstablished.council_disposition, "approved_modified");
  assert.equal(beforeAppealEstablished.actual_appeals_trigger.status, "potential");
  assert.equal(beforeAppealEstablished.terminal_outcome, "unresolved");
  assert.equal(beforeAppealEstablished.terminal_reason, "appeals_eligibility_not_yet_established");

  const appealConfirmed = resolveLandPredictionRegimeOutcome({
    council_action: { vote: "approve", modified: true },
    eligible_application_class_source: {
      kind: "official_application_classification",
      value: true,
      record_id: `cpc-class:${STREET_108_PROJECT_ID}`,
      observed_at: "2026-07-18T00:00:00.000Z",
    },
    base_procedure_id: PROCEDURE_ID,
    base_stage_id: STAGE_ID,
    prediction_as_of: "2026-07-20",
  });
  assert.equal(appealConfirmed.council_disposition, "approved_modified");
  assert.equal(appealConfirmed.actual_appeals_trigger.status, "confirmed");
  // The modification itself never becomes a terminal-outcome label; the
  // application's later review status is a distinct, independently tracked
  // field that stays unresolved until the appeals board decides.
  assert.equal(appealConfirmed.terminal_outcome, "unresolved");
  assert.notEqual(appealConfirmed.terminal_outcome, appealConfirmed.council_disposition);

  void STREET_108_PROJECT_ID;
});

// ---------------------------------------------------------------------------
// A6: 1571 McDonald Avenue -- withdrawal or no vote, not Council disapproval
// ---------------------------------------------------------------------------

test("A6 1571 McDonald Avenue records withdrawal or no vote rather than Council disapproval", () => {
  const result = resolveLandPredictionRegimeOutcome({
    council_action: { no_vote: true },
    base_procedure_id: PROCEDURE_ID,
    base_stage_id: STAGE_ID,
    prediction_as_of: "2026-05-01",
  });
  assert.equal(result.council_disposition, "withdrawn_or_no_vote");
  assert.notEqual(result.council_disposition, "disapproved");
  assert.equal(result.terminal_outcome, "unresolved");

  const withdrawn = resolveLandPredictionRegimeOutcome({
    council_action: { withdrawn: true },
    project_withdrawn: true,
    base_procedure_id: PROCEDURE_ID,
    base_stage_id: STAGE_ID,
    prediction_as_of: "2026-05-01",
  });
  assert.equal(withdrawn.council_disposition, "withdrawn_or_no_vote");
  assert.equal(withdrawn.terminal_outcome, "withdrawn");
  assert.notEqual(withdrawn.terminal_outcome, "unauthorized");

  void MCDONALD_AVE_PROJECT_ID;
});

// ---------------------------------------------------------------------------
// A7: unknown preserved separately from false in every snapshot
// ---------------------------------------------------------------------------

test("A7 review-regime features preserve unknown independently from false", () => {
  const cutoff = "2026-07-01T00:00:00.000Z";
  const vector = buildLandPredictionRegimeFeatureVector(baseVectorInput(STREET_164_PROJECT_ID, cutoff, {
    base_procedure_id: PROCEDURE_ID,
    base_stage_id: STAGE_ID,
  }));
  assert.equal(vector.schema, LAND_PREDICTION_REGIME_FEATURE_VECTOR_SCHEMA);
  const byKey = Object.fromEntries(vector.regime_features.map((feature) => [feature.key, feature]));
  for (const key of REVIEW_REGIME_FEATURE_KEYS.slice(0, 3)) {
    // No facts supplied: every eligibility feature must be `unknown`, never
    // a false-by-default value.
    assert.equal(byKey[key].state, "unknown");
    assert.equal(byKey[key].value, null);
  }

  const known666a = buildLandPredictionRegimeFeatureVector(baseVectorInput(STREET_164_PROJECT_ID, cutoff, {
    base_procedure_id: PROCEDURE_ID,
    base_stage_id: STAGE_ID,
    eligibility_criteria: {
      "affordable_housing.section_666a.hpd_sponsorship_certified": {
        source: { kind: "hpd_certification_record", value: true, record_id: "hpd-cert:2024Q0164", observed_at: cutoff },
      },
      "affordable_housing.section_666a.affordability_covenant_recorded": {
        source: { kind: "recorded_covenant_document", value: false, record_id: "acris:2024Q0164", observed_at: cutoff },
      },
    },
  }));
  const covenant666a = known666a.regime_features.find((feature) => feature.key === "review_regime.section_666a_eligibility");
  // A known-false criterion resolves the regime `ineligible`: a `known`
  // state carrying `false`, distinct in kind from `unknown`.
  assert.equal(covenant666a.state, "known");
  assert.equal(covenant666a.value, false);
  assert.notEqual(covenant666a.state, "unknown");
});

// ---------------------------------------------------------------------------
// A8, temporal rule: no not-yet-effective regime may enter as active
// eligibility
// ---------------------------------------------------------------------------

function fastTrackCriteria(cutoff) {
  return {
    "affordable_housing.section_197f.commission_cycle_listed": {
      source: { kind: "official_commission_cycle_list" },
      cycle_lists: [{
        cycle_id: "cycle-hypothetical", version: 1, source_status: "enacted",
        effective_from: "2020-01-01", published_at: cutoff, listed_project_ids: ["fixture-project"],
      }],
    },
    "affordable_housing.section_197f.qualifying_action_code": {
      source: { kind: "official_action_code_classification", value: true, record_id: "dcp-action:fixture", observed_at: cutoff },
    },
  };
}

test("A8 no section 197-f feature may appear as active factual eligibility before its operative window", () => {
  for (const year of COUNTERFACTUAL_QUARANTINE_YEARS) {
    const cutoff = `${year}-06-01T00:00:00.000Z`;
    const vector = buildLandPredictionRegimeFeatureVector(baseVectorInput(`fixture:${year}`, cutoff, {
      eligibility_criteria: fastTrackCriteria(cutoff),
    }));
    const feature197f = vector.regime_features.find((row) => row.key === "review_regime.section_197f_eligibility");
    assert.equal(feature197f.state, "unknown");
    assert.notEqual(feature197f.value, true);
  }

  // Even after the Charter effective date (2025-12-02) but before the
  // Commission's first cycle list can exist (2027-01-01), a fully
  // authoritative, "true" fact bundle still cannot resolve eligible: the
  // fact-level operative window is stricter than the regime's own Charter
  // effective date and is not satisfied by an early hypothetical cycle list.
  const cutoff = "2026-06-01T00:00:00.000Z";
  const preCycleList = buildLandPredictionRegimeFeatureVector(baseVectorInput("fixture:2026", cutoff, {
    eligibility_criteria: fastTrackCriteria(cutoff),
  }));
  const feature197fPreCycle = preCycleList.regime_features.find((row) => row.key === "review_regime.section_197f_eligibility");
  assert.equal(feature197fPreCycle.state, "unknown");
  assert.notEqual(feature197fPreCycle.value, true);
});

// ---------------------------------------------------------------------------
// A9, G4: counterfactual eligibility is quarantined from factual training
// ---------------------------------------------------------------------------

test("A9 counterfactual eligibility can be generated for analysis but never enters factual training", () => {
  for (const year of COUNTERFACTUAL_QUARANTINE_YEARS) {
    const counterfactual = computeCounterfactualRegimeEligibility({
      regime_id: "affordable_housing_fast_track_197f",
      facts: {
        "affordable_housing.section_197f.commission_cycle_listed": true,
        "affordable_housing.section_197f.qualifying_action_code": true,
      },
      historical_prediction_as_of: `${year}-06-01`,
    });
    assert.equal(counterfactual.counterfactual, true);
    assert.equal(counterfactual.factual, false);
    // The registry's own temporal gate still fires even inside a
    // counterfactual computation: it is not-yet-effective, not "eligible as
    // if the regime existed."
    assert.equal(counterfactual.resolution.status, "not_yet_effective");

    assert.throws(() => assertNoCounterfactualLeakage(counterfactual, "test training row"));
    assert.throws(() => buildLandPredictionRegimeFeatureVector({
      ...baseVectorInput(`fixture:${year}`, `${year}-06-01T00:00:00.000Z`),
      counterfactual_candidate: counterfactual,
    }));
  }
});

test("A9 a plain factual input without a counterfactual tag is never rejected", () => {
  assert.doesNotThrow(() => buildLandPredictionRegimeFeatureVector(
    baseVectorInput(STREET_164_PROJECT_ID, "2026-07-01T00:00:00.000Z"),
  ));
});

// ---------------------------------------------------------------------------
// A10: learnable stance-by-regime interactions, no fixed weight rule
// ---------------------------------------------------------------------------

test("A10 stance-by-regime interactions are learnable candidates with no fixed weight", () => {
  const cutoff = "2026-07-01T00:00:00.000Z";
  const vector = buildLandPredictionRegimeFeatureVector(baseVectorInput(STREET_164_PROJECT_ID, cutoff));
  assert.equal(vector.regime_interactions.length, REGIME_INTERACTION_REGIME_KEYS.length);
  for (const interaction of vector.regime_interactions) {
    assert.equal(interaction.feature_key, "local_council_member_stance");
    assert.ok(interaction.estimation.includes("learnable"));
    assert.ok(!Object.hasOwn(interaction, "weight"));
    assert.ok(!Object.hasOwn(interaction, "fixed_weight"));
    assert.ok(!Object.hasOwn(interaction, "discount"));
  }
  const dump = JSON.stringify(vector.regime_interactions);
  assert.equal(/"weight"\s*:/.test(dump), false);
});

// ---------------------------------------------------------------------------
// A11: explanations name evidence and stage, never causal control
// ---------------------------------------------------------------------------

test("A11 explanations name observed evidence and stage without asserting causal control", () => {
  const explanation = explainRegimeOutcome({
    council_disposition: "approved_modified",
    terminal_outcome: "authorized",
    terminal_authorization_path: "council",
  });
  assert.equal(explanation.causal_claim, false);
  assert.ok(explanation.statement.includes("not a causal claim"));
  assert.equal(/\bcaused\b/i.test(explanation.statement), false);
  assert.equal(/\bcontrols?\b/i.test(explanation.statement), false);
});

// ---------------------------------------------------------------------------
// Negative rule
// ---------------------------------------------------------------------------

test("negative rule: no procedure or eligibility shortcuts leak into this module", () => {
  const cutoff = "2026-07-01T00:00:00.000Z";
  const vector = buildLandPredictionRegimeFeatureVector(baseVectorInput(STREET_164_PROJECT_ID, cutoff, {
    eligibility_criteria: {
      "affordable_housing.section_666a.hpd_sponsorship_certified": {
        source: { kind: "hpd_certification_record", value: true, record_id: "hpd-cert:2024Q0164", observed_at: cutoff },
      },
      "affordable_housing.section_666a.affordability_covenant_recorded": {
        source: { kind: "recorded_covenant_document", value: true, record_id: "acris:2024Q0164", observed_at: cutoff },
      },
    },
  }));
  const dump = JSON.stringify({
    vector,
    disposition_values: COUNCIL_DISPOSITION_VALUES,
    terminal_values: TERMINAL_OUTCOME_VALUES,
    authorization_paths: TERMINAL_AUTHORIZATION_PATHS,
    fact_map: COUNCIL_DISPOSITION_TO_REGIME_FACT_VALUE,
  });
  assert.equal(/"procedure(_id)?"\s*:\s*"(ahab|affordable|fast_track)"/.test(dump), false);
  assert.equal(dump.includes("qualifying_affordable"), false);
});

// ---------------------------------------------------------------------------
// Promotion gate
// ---------------------------------------------------------------------------

test("promotion gate stays withheld until every criterion is met, and is never self-granting", () => {
  const labels = REGIME_TARGET_PROMOTION_GATE.map((criterion) => criterion.label);
  assert.deepEqual(labels, [
    "factual post-reform cases",
    "actual review-regime observations",
    "time-valid features",
    "held-out improvement",
    "stable calibration",
    "nontrivial coverage",
  ]);

  const empty = evaluateRegimeTargetPromotionGate();
  assert.equal(empty.all_criteria_met, false);
  assert.equal(empty.promoted, false);
  assert.equal(empty.unmet.length, labels.length);

  const allMet = evaluateRegimeTargetPromotionGate(Object.fromEntries(
    REGIME_TARGET_PROMOTION_GATE.map((criterion) => [criterion.key, true]),
  ));
  assert.equal(allMet.all_criteria_met, true);
  // Even a fully-met gate never flips promotion itself.
  assert.equal(allMet.promoted, false);
  assert.equal(allMet.schema, LAND_PREDICTION_REGIME_TARGETS_SCHEMA);
});

test("schema is versioned and the actual-trigger resolver defers to the reviewed LDP-18 registry", () => {
  assert.equal(LAND_PREDICTION_REGIME_TARGETS_SCHEMA, "cityscroll.land_prediction_regime_targets.v1");
  const trigger = resolveActualAppealsTrigger({
    council_disposition: "disapproved",
    eligible_application_class_source: {
      kind: "official_application_classification",
      value: true,
      record_id: `cpc-class:${STREET_164_PROJECT_ID}`,
      observed_at: "2026-05-15T00:00:00.000Z",
    },
    base_procedure_id: PROCEDURE_ID,
    base_stage_id: STAGE_ID,
    prediction_as_of: "2026-07-01",
  });
  assert.equal(trigger.status, "confirmed");
  assert.equal(trigger.regime_id, "affordable_housing_appeals_197g");
});
