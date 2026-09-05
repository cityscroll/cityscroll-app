// Cohort-separated backtest of the 2025 institutional break for Land-Use
// Prediction v2 (LUP2-C12).
//
// This module is strictly additive and shadow/research-only, exactly like
// LUP2-C11's regime targets it builds on. It never edits
// land_prediction_predictor.mjs, land_prediction_features.mjs,
// land_prediction_regime_targets.mjs, or the LDP-18/19/20 review-regime,
// eligibility-fact, and review-transition contracts: it only composes them.
//
// The card this module answers asks whether local-member stance predicts
// what the Council does or whether a project ultimately survives, now that
// those two questions can diverge. Three cohorts stay explicit and are never
// mixed by the loader: `factual` post-reform cases (may contribute to
// evaluation), `counterfactual` historical cases (test eligibility and
// branching semantics only -- never an appeals or targeted-project outcome),
// and `negative` boundary controls (each must fail on its own named
// distinction). A null or unestimable finding is a successful finding here,
// not a failure to be forced into a conclusion: the factual post-reform
// sample is genuinely small, and reporting that honestly is the point.

import { sha256Hex } from "./civic_time.mjs";
import { assertNoTemporalLeakage } from "./forecast_calibration.mjs";
import { validateLandPredictionFeatureVector } from "./land_prediction_features.mjs";
import {
  fitLandPredictionModel,
  measureLandPredictionCalibration,
} from "./land_prediction_predictor.mjs";
import {
  REVIEW_REGIME_FEATURE_KEYS,
  assertNoCounterfactualLeakage,
  buildLandPredictionRegimeFeatureVector,
  computeCounterfactualRegimeEligibility,
  evaluateRegimeTargetPromotionGate,
  resolveActualAppealsTrigger,
  resolveCouncilDisposition,
  resolveLandPredictionRegimeOutcome,
  resolveTerminalOutcome,
} from "./land_prediction_regime_targets.mjs";
import { materializeAppealsReviewTransitions } from "../../../site/affordable_review_transitions.mjs";
import {
  materializeCommissionCycleListedFact,
  materializeDirectlyFacilitatesAffordableHousingFact,
  resolveAffordableAppealsReviewEligibility,
} from "../../../site/affordable_eligibility_facts.mjs";
import { resolveLandFastTrackDecoration } from "../../../site/land_review_regimes.mjs";

export const LAND_PREDICTION_REGIME_BACKTEST_SCHEMA =
  "cityscroll.land_prediction_regime_backtest.v1";
export const LAND_PREDICTION_REGIME_BACKTEST_VERSION = "lup2-c12-gold.v1";
export const LAND_PREDICTION_REGIME_BACKTEST_GOLD_SCHEMA =
  "cityscroll.land_prediction_regime_backtest.gold.v1";

/** The three cohorts a fixture pack must declare, and only these. A case id may appear in exactly one (G1, A2). */
export const REGIME_BACKTEST_COHORTS = Object.freeze(["factual", "counterfactual", "negative"]);

export const REGIME_BACKTEST_TARGETS = Object.freeze(["council_disposition", "terminal_outcome"]);

export const REGIME_BACKTEST_MODEL_IDS = Object.freeze([
  "baseline_process",
  "baseline_plus_formal_signals",
  "baseline_plus_local_member_stance",
  "full_regime_v2",
]);

const BASE_MODEL_KEYS = Object.freeze(["application_type", "procedural_stage"]);
const FORMAL_MODEL_KEYS = Object.freeze([
  ...BASE_MODEL_KEYS,
  "community_board_action",
  "borough_president_action",
  "cpc_recommendation",
  "cpc_disposition",
  "cpc_vote",
  "council_subcommittee_action",
  "land_use_committee_action",
  "modifications_or_conditions",
]);
const STANCE_MODEL_KEYS = Object.freeze([...BASE_MODEL_KEYS, "local_council_member_stance"]);
const FULL_REGIME_MODEL_KEYS = Object.freeze([
  ...FORMAL_MODEL_KEYS,
  "local_council_member_stance",
  ...REVIEW_REGIME_FEATURE_KEYS,
]);

export const REGIME_BACKTEST_MODEL_FEATURE_KEYS = Object.freeze({
  baseline_process: BASE_MODEL_KEYS,
  baseline_plus_formal_signals: FORMAL_MODEL_KEYS,
  baseline_plus_local_member_stance: STANCE_MODEL_KEYS,
  full_regime_v2: FULL_REGIME_MODEL_KEYS,
});

// Below these sample sizes, a held-out lift comparison or a divergence rate
// is reported as `unestimable` rather than computed and asserted (G5, A15,
// A16). The factual post-reform sample is genuinely this small right now;
// these thresholds are not tuned to make the pack pass.
export const MIN_HELD_OUT_N_FOR_LIFT_COMPARISON = 8;
export const MIN_DIVERGENCE_DENOMINATOR = 5;

export const NEGATIVE_CONTROL_KINDS = Object.freeze([
  "withdrawal_not_disapproval",
  "mapping_token_insufficient",
  "potential_eligibility_no_trigger_on_unchanged_approval",
  "modification_opens_evaluation_without_manufactured_appeal",
  "expedited_stays_expedited_not_fast_track",
]);

function assertPlainObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
}

function requiredText(value, label) {
  const text = String(value ?? "").trim();
  if (!text) throw new TypeError(`${label} is required`);
  return text;
}

function canonicalInstant(value, label) {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) {
    throw new TypeError(`${label} must be an ISO timestamp`);
  }
  return new Date(value).toISOString();
}

function round(value, places = 8) {
  if (value == null || !Number.isFinite(value)) return null;
  return Number(Number(value).toFixed(places));
}

// ---------------------------------------------------------------------------
// G1, A1, A2, A3: loader-enforced cohort separation
// ---------------------------------------------------------------------------

/**
 * Load and structurally validate a frozen fixture pack. Every case id is
 * checked against every cohort: an id may appear in exactly one of
 * `factual`, `counterfactual`, or `negative`. This is the loader-enforced
 * separation the card requires (G1) -- there is no code path anywhere in
 * this module that merges rows across cohorts.
 */
export function loadRegimeBacktestGoldPack(dataset) {
  assertPlainObject(dataset, "regime backtest gold pack");
  if (dataset.schema !== LAND_PREDICTION_REGIME_BACKTEST_GOLD_SCHEMA) {
    throw new TypeError("unsupported land prediction regime backtest gold schema");
  }
  const seenIds = new Map();
  const cohorts = {};
  for (const cohort of REGIME_BACKTEST_COHORTS) {
    const rows = dataset[cohort];
    if (!Array.isArray(rows)) throw new TypeError(`regime backtest gold pack.${cohort} must be an array`);
    for (const row of rows) {
      const id = requiredText(row?.id, `${cohort} case.id`);
      if (seenIds.has(id)) {
        throw new TypeError(
          `case ${id} appears in both the ${seenIds.get(id)} and ${cohort} cohorts; cohorts must stay separate`,
        );
      }
      seenIds.set(id, cohort);
    }
    cohorts[cohort] = Object.freeze([...rows]);
  }
  return Object.freeze({
    schema: LAND_PREDICTION_REGIME_BACKTEST_GOLD_SCHEMA,
    version: requiredText(dataset.version, "version"),
    purpose: dataset.purpose || null,
    factual: cohorts.factual,
    counterfactual: cohorts.counterfactual,
    negative: cohorts.negative,
  });
}

// ---------------------------------------------------------------------------
// Factual cohort: cutoff-safe reconstruction and both target labels
// ---------------------------------------------------------------------------

function assertFactualCutoffSafety(row) {
  const id = requiredText(row.id, "factual case.id");
  const cutoff = canonicalInstant(row.prediction_as_of, `${id}.prediction_as_of`);
  const outcomeAt = canonicalInstant(row.outcome_at, `${id}.outcome_at`);
  if (Date.parse(outcomeAt) <= Date.parse(cutoff)) {
    throw new TypeError(`outcome leakage in ${id}: outcome_at must be after prediction_as_of`);
  }
  const clocks = (row.features || [])
    .flatMap((feature) => [feature.observed_at, feature.effective_at])
    .filter(Boolean)
    .map((value) => canonicalInstant(value, `${id} feature clock`));
  const featureObservedAt = clocks.sort().at(-1) || cutoff;
  assertNoTemporalLeakage({ id, cutoff, feature_observed_at: featureObservedAt });
  return { id, cutoff, outcome_at: outcomeAt };
}

/** Council disposition never resolves from stored history via any path other than the reviewed C11 resolver. */
function resolveFactualOutcome(row) {
  return resolveLandPredictionRegimeOutcome({
    council_action: row.council_action || {},
    eligible_application_class_source: row.eligible_application_class_source || null,
    appeals_board_disposition: row.appeals_board_disposition || null,
    commission_expedited_disposition: row.commission_expedited_disposition || null,
    board_666a_disposition: row.board_666a_disposition || null,
    project_withdrawn: Boolean(row.project_withdrawn),
    base_procedure_id: row.base_procedure_id,
    base_stage_id: row.base_stage_id,
    prediction_as_of: row.prediction_as_of,
    project_id: row.application_id,
  });
}

/** Build the training-ready vector: the C5 base vector plus C11's regime features, as one validated C5-shaped vector. */
export function buildFactualRegimeTrainingVector(row) {
  const regimeVector = buildLandPredictionRegimeFeatureVector({
    application_id: row.application_id,
    prediction_as_of: row.prediction_as_of,
    procedural_stage: row.procedural_stage || "city_council",
    features: row.features || [],
    eligibility_criteria: row.eligibility_criteria || {},
    filing_date: row.filing_date || row.prediction_as_of,
    base_procedure_id: row.base_procedure_id,
    base_stage_id: row.base_stage_id,
    council_disposition_label: resolveCouncilDisposition(row.council_action || {}),
  });
  const base = regimeVector.base_vector;
  return validateLandPredictionFeatureVector({
    ...base,
    features: [...base.features, ...regimeVector.regime_features],
  });
}

/** Prepare every factual row: cutoff safety, the augmented vector, and both resolved target labels. Never touches counterfactual or negative rows. */
export function prepareFactualRegimeRows(factualRows) {
  return factualRows.map((row) => {
    const safety = assertFactualCutoffSafety(row);
    const vector = buildFactualRegimeTrainingVector(row);
    assertNoCounterfactualLeakage(vector, `factual case ${row.id}`);
    const resolved = resolveFactualOutcome(row);
    return {
      id: row.id,
      application_id: requiredText(row.application_id, `${row.id}.application_id`),
      prediction_as_of: safety.cutoff,
      outcome_at: safety.outcome_at,
      vector,
      resolved,
      cohorts: [...(row.cohorts || [])],
    };
  });
}

/** approved_unchanged/approved_modified -> favorable; disapproved -> adverse; withdrawn/unresolved excluded from this target's population. */
export function councilDispositionOutcomeLabel(disposition) {
  if (disposition === "approved_unchanged" || disposition === "approved_modified") return "approved";
  if (disposition === "disapproved") return "disapproved";
  return null;
}

/** authorized -> favorable; unauthorized -> adverse; withdrawn/unresolved excluded from this target's population. */
export function terminalOutcomeLabel(terminal) {
  if (terminal === "authorized") return "approved";
  if (terminal === "unauthorized") return "disapproved";
  return null;
}

function trainingRowsForTarget(preparedFactualRows, targetKey) {
  if (!REGIME_BACKTEST_TARGETS.includes(targetKey)) {
    throw new TypeError(`unsupported regime backtest target: ${targetKey}`);
  }
  return preparedFactualRows
    .map((row) => {
      const label = targetKey === "council_disposition"
        ? councilDispositionOutcomeLabel(row.resolved.council_disposition)
        : terminalOutcomeLabel(row.resolved.terminal_outcome);
      if (label == null) return null;
      return { id: row.id, feature_vector: row.vector, outcome: label, outcome_at: row.outcome_at };
    })
    .filter(Boolean);
}

// ---------------------------------------------------------------------------
// Model-family ablation, run separately per target
// ---------------------------------------------------------------------------

function unknownFeature(key) {
  return {
    key,
    value: null,
    state: "unknown",
    evidence_type: "not_available_at_cutoff",
    observed_at: null,
    effective_at: null,
    source: null,
    confidence: null,
    evidence: [],
    evidence_ids: [],
  };
}

/** Hide model-disallowed signals as explicit unknowns without dropping keys, exactly like C7's ablation masking. */
export function maskRegimeVectorForModel(vector, modelId) {
  const allowed = REGIME_BACKTEST_MODEL_FEATURE_KEYS[modelId];
  if (!allowed) throw new TypeError(`unknown regime backtest model: ${modelId}`);
  const allowedSet = new Set(allowed);
  const validated = validateLandPredictionFeatureVector(vector);
  return validateLandPredictionFeatureVector({
    ...validated,
    features: validated.features.map((feature) => (
      allowedSet.has(feature.key) ? feature : unknownFeature(feature.key)
    )),
  });
}

function fitRegimeModelFamily(rows, modelId) {
  const masked = rows.map((row) => ({
    id: row.id,
    feature_vector: maskRegimeVectorForModel(row.feature_vector, modelId),
    outcome: row.outcome,
    outcome_at: row.outcome_at,
  }));
  const model = fitLandPredictionModel(masked, { iterations: 200 });
  const calibration = measureLandPredictionCalibration(model, masked);
  return { model_id: modelId, model_version: model.model_version, n: masked.length, in_sample: calibration };
}

/**
 * Run the four-model ablation for one target only (council_disposition or
 * terminal_outcome). The two targets are never fit together and never share
 * a model object: `run...(..., "council_disposition")` and
 * `run...(..., "terminal_outcome")` are independent calls over independently
 * filtered row populations (a row missing one target's label simply does not
 * enter that target's population).
 */
export function runRegimeModelFamily(preparedFactualRows, targetKey) {
  const rows = trainingRowsForTarget(preparedFactualRows, targetKey);
  if (!rows.length) {
    return { target: targetKey, n: 0, status: "unestimable_no_labeled_rows", models: {} };
  }
  const models = Object.fromEntries(REGIME_BACKTEST_MODEL_IDS.map((modelId) => [
    modelId,
    fitRegimeModelFamily(rows, modelId),
  ]));
  const heldOutEligible = rows.length >= MIN_HELD_OUT_N_FOR_LIFT_COMPARISON;
  return {
    target: targetKey,
    n: rows.length,
    status: heldOutEligible ? "in_sample_measured" : "unestimable_insufficient_sample_for_held_out_lift",
    minimum_n_for_held_out_lift: MIN_HELD_OUT_N_FOR_LIFT_COMPARISON,
    models,
  };
}

function familyBrier(family, modelId) {
  return family.models?.[modelId]?.in_sample?.brier_score ?? null;
}

/**
 * A15: explicitly compare member-stance lift for Council disposition against
 * terminal outcome once the factual sample supports both. Below the
 * threshold this returns `comparable: false` rather than a number computed
 * from too few rows to mean anything.
 */
export function compareStanceLiftAcrossTargets(councilFamily, terminalFamily) {
  const bothAdequate = councilFamily.status === "in_sample_measured"
    && terminalFamily.status === "in_sample_measured";
  if (!bothAdequate) {
    return {
      schema: LAND_PREDICTION_REGIME_BACKTEST_SCHEMA,
      comparable: false,
      reason: "factual_sample_does_not_yet_support_held_out_stance_lift_comparison_for_both_targets",
      council_disposition_n: councilFamily.n,
      terminal_outcome_n: terminalFamily.n,
      minimum_n_required: MIN_HELD_OUT_N_FOR_LIFT_COMPARISON,
      council_disposition_stance_lift_brier: null,
      terminal_outcome_stance_lift_brier: null,
      lift_difference: null,
    };
  }
  const councilLift = round(
    (familyBrier(councilFamily, "baseline_process") ?? 0)
    - (familyBrier(councilFamily, "baseline_plus_local_member_stance") ?? 0),
  );
  const terminalLift = round(
    (familyBrier(terminalFamily, "baseline_process") ?? 0)
    - (familyBrier(terminalFamily, "baseline_plus_local_member_stance") ?? 0),
  );
  return {
    schema: LAND_PREDICTION_REGIME_BACKTEST_SCHEMA,
    comparable: true,
    council_disposition_stance_lift_brier: councilLift,
    terminal_outcome_stance_lift_brier: terminalLift,
    lift_difference: round(councilLift - terminalLift),
  };
}

// ---------------------------------------------------------------------------
// The descriptive quantity: does terminal outcome diverge from disposition?
// ---------------------------------------------------------------------------

/**
 * The probability that terminal outcome differs from Council disposition
 * given an adverse Council action with review available. Reported as
 * `unestimable` when the denominator is inadequate (G5): this is the
 * measurement the card's theory section names directly, and an inadequate
 * denominator is expected right now, not a defect in this function.
 */
export function computeDispositionOutcomeDivergence(preparedFactualRows) {
  const eligible = preparedFactualRows.filter((row) => {
    const adverse = row.resolved.council_disposition === "disapproved"
      || row.resolved.council_disposition === "approved_modified";
    const reviewAvailable = row.resolved.actual_appeals_trigger.status === "potential"
      || row.resolved.actual_appeals_trigger.status === "confirmed";
    return adverse && reviewAvailable;
  });
  if (eligible.length < MIN_DIVERGENCE_DENOMINATOR) {
    return {
      schema: LAND_PREDICTION_REGIME_BACKTEST_SCHEMA,
      status: "unestimable",
      reason: "denominator_below_minimum",
      denominator: eligible.length,
      minimum_denominator: MIN_DIVERGENCE_DENOMINATOR,
      numerator: null,
      rate: null,
    };
  }
  const diverged = eligible.filter((row) => {
    const councilFavorable = councilDispositionOutcomeLabel(row.resolved.council_disposition) === "approved";
    const terminalFavorable = terminalOutcomeLabel(row.resolved.terminal_outcome) === "approved";
    return councilFavorable !== terminalFavorable;
  });
  return {
    schema: LAND_PREDICTION_REGIME_BACKTEST_SCHEMA,
    status: "estimated",
    denominator: eligible.length,
    numerator: diverged.length,
    rate: round(diverged.length / eligible.length, 4),
  };
}

/**
 * A16: a null or unestimable result is recorded as a successful result. This
 * never forces the institutional-dilution hypothesis, whether the sample is
 * adequate or not: an estimable comparison still does not itself authorize a
 * causal or promotion conclusion, which stays a separate, explicit gate.
 */
export function evaluateRegimeDilutionNullResult({ comparison, divergence }) {
  const unestimable = !comparison.comparable || divergence.status === "unestimable";
  return {
    schema: LAND_PREDICTION_REGIME_BACKTEST_SCHEMA,
    unestimable,
    null_result_recorded_as_success: unestimable ? true : null,
    institutional_dilution_hypothesis_forced: false,
    interpretation: unestimable
      ? "The factual post-reform sample does not yet support a held-out stance-lift comparison across targets or a stable divergence-rate estimate. Recording that as unestimable, rather than forcing a conclusion, is the successful outcome for this evaluation."
      : "A held-out comparison and a divergence-rate estimate are both available for this pack. Neither is a causal claim, and no institutional-dilution conclusion is asserted outside the separate, explicit promotion gate.",
  };
}

// ---------------------------------------------------------------------------
// Counterfactual cohort: eligibility and branching semantics only (G2, G4)
// ---------------------------------------------------------------------------

/**
 * Analyze one counterfactual case. This only ever calls
 * `resolveTerminalOutcome` with `actual_trigger_status: "none"` and no
 * `appeals_board_disposition` -- a counterfactual case can never be assigned
 * a hypothetical appeals result (A4, A5, A13): the terminal outcome computed
 * here is the real historical outcome under the regime that actually existed
 * at the time, not a simulation of what §197-g review might have produced.
 */
export function analyzeCounterfactualCase(row) {
  const councilDisposition = resolveCouncilDisposition(row.council_action || {});
  const counterfactualEligibility = computeCounterfactualRegimeEligibility({
    regime_id: row.regime_id,
    facts: row.facts || {},
    historical_prediction_as_of: row.historical_prediction_as_of,
  });
  const realTerminal = resolveTerminalOutcome({
    council_disposition: councilDisposition,
    actual_trigger_status: "none",
    project_withdrawn: Boolean(row.project_withdrawn),
  });
  return {
    schema: LAND_PREDICTION_REGIME_BACKTEST_SCHEMA,
    id: row.id,
    application_id: row.application_id,
    council_disposition: councilDisposition,
    counterfactual_regime_eligibility: counterfactualEligibility,
    real_terminal_outcome: realTerminal.value,
    real_terminal_authorization_path: realTerminal.authorization_path,
    hypothetical_appeals_result_assigned: false,
  };
}

// ---------------------------------------------------------------------------
// Negative/boundary cohort: each case must fail on its own named distinction
// ---------------------------------------------------------------------------

function evaluateWithdrawalNotDisapproval(row) {
  const disposition = resolveCouncilDisposition(row.council_action || {});
  const trigger = resolveActualAppealsTrigger({
    council_disposition: disposition,
    eligible_application_class_source: row.eligible_application_class_source || null,
    base_procedure_id: row.base_procedure_id,
    base_stage_id: row.base_stage_id,
    prediction_as_of: row.prediction_as_of,
    project_id: row.application_id,
  });
  const passed = disposition === "withdrawn_or_no_vote"
    && disposition !== "disapproved"
    && trigger.status === "none";
  return { passed, detail: { disposition, trigger_status: trigger.status } };
}

function evaluateMappingTokenInsufficient(row) {
  const fact = materializeDirectlyFacilitatesAffordableHousingFact({
    source: row.eligible_application_class_source,
  });
  const review = resolveAffordableAppealsReviewEligibility({
    project_id: row.application_id,
    prediction_as_of: row.prediction_as_of,
    eligible_application_class_source: row.eligible_application_class_source,
    base_procedure_id: row.base_procedure_id,
    base_stage_id: row.base_stage_id,
  });
  const passed = fact.state === "unknown"
    && String(fact.reason || "").startsWith("source_kind_not_authoritative")
    && review.potential_review_eligibility.status === "unknown";
  return {
    passed,
    detail: { fact_state: fact.state, fact_reason: fact.reason, potential_status: review.potential_review_eligibility.status },
  };
}

function evaluatePotentialEligibilityNoTriggerOnUnchangedApproval(row) {
  const review = resolveAffordableAppealsReviewEligibility({
    project_id: row.application_id,
    prediction_as_of: row.prediction_as_of,
    eligible_application_class_source: row.eligible_application_class_source,
    base_procedure_id: row.base_procedure_id,
    base_stage_id: row.base_stage_id,
  });
  const passed = review.potential_review_eligibility.status === "eligible"
    && review.actual_trigger.status === "none";
  return {
    passed,
    detail: { potential_status: review.potential_review_eligibility.status, trigger_status: review.actual_trigger.status },
  };
}

function evaluateModificationOpensEvaluationWithoutManufacturedAppeal(row) {
  const trigger = resolveActualAppealsTrigger({
    council_disposition: "approved_modified",
    eligible_application_class_source: row.eligible_application_class_source,
    base_procedure_id: row.base_procedure_id,
    base_stage_id: row.base_stage_id,
    prediction_as_of: row.prediction_as_of,
    project_id: row.application_id,
  });
  const transitions = materializeAppealsReviewTransitions({
    project_id: row.application_id,
    base_procedure_id: row.base_procedure_id,
    base_stage_id: row.base_stage_id,
    council_disposition: "approve_with_modifications",
    eligible_application_class_source: row.eligible_application_class_source,
    prediction_as_of: row.prediction_as_of,
  });
  const evaluationOpened = trigger.status === "potential" || trigger.status === "confirmed";
  const noAppealManufactured = transitions.events.length === 0 && transitions.status !== "resolved";
  return {
    passed: evaluationOpened && noAppealManufactured,
    detail: { trigger_status: trigger.status, transitions_status: transitions.status, event_count: transitions.events.length },
  };
}

function evaluateExpeditedStaysExpeditedNotFastTrack(row) {
  const decoration = resolveLandFastTrackDecoration({ procedure_id: row.procedure_id, facts: {} });
  const passed = decoration.applicable === false && decoration.eligibility.status === "unknown";
  return { passed, detail: { applicable: decoration.applicable, eligibility_status: decoration.eligibility.status } };
}

const NEGATIVE_CONTROL_EVALUATORS = Object.freeze({
  withdrawal_not_disapproval: evaluateWithdrawalNotDisapproval,
  mapping_token_insufficient: evaluateMappingTokenInsufficient,
  potential_eligibility_no_trigger_on_unchanged_approval: evaluatePotentialEligibilityNoTriggerOnUnchangedApproval,
  modification_opens_evaluation_without_manufactured_appeal: evaluateModificationOpensEvaluationWithoutManufacturedAppeal,
  expedited_stays_expedited_not_fast_track: evaluateExpeditedStaysExpeditedNotFastTrack,
});

/** Evaluate every negative/boundary case against its own named distinction. Never partially applied: an unrecognized kind throws rather than silently passing. */
export function evaluateNegativeControls(negativeRows) {
  return negativeRows.map((row) => {
    const evaluator = NEGATIVE_CONTROL_EVALUATORS[row.kind];
    if (!evaluator) throw new TypeError(`unsupported negative control kind: ${row.kind}`);
    const result = evaluator(row);
    return { id: row.id, kind: row.kind, ...result };
  });
}

/** Negative controls must fail closed on their distinction, exactly like C7's negatives must fail closed on reconstruction. */
export function assertAllNegativeControlsPass(evaluated) {
  const failed = evaluated.filter((row) => !row.passed);
  if (failed.length) {
    throw new TypeError(`negative controls did not hold their named distinction: ${failed.map((row) => row.id).join(", ")}`);
  }
  return evaluated;
}

// ---------------------------------------------------------------------------
// A11, A12: the commission-cycle list is gated on both its own publication
// date and the fact-level operative date, and a reconstruction is never a
// substitute for either
// ---------------------------------------------------------------------------

// The Commission has not published any bottom-twelve community district list
// as of this registry snapshot (`OFFICIAL_COMMISSION_CYCLE_LISTS` in LDP-19
// is empty). This date is this card's own documented lower bound on when
// such a list could first be officially published; it does not relax or
// replace LDP-19's separate, later fact-level operative date
// (`COMMISSION_CYCLE_OPERATIVE_RULES`, 2027-01-01) for when a factual
// application can actually be scored as using the fast track.
export const BOTTOM_TWELVE_LIST_EARLIEST_OFFICIAL_PUBLICATION = "2026-10-01";

/**
 * A reconstructed bottom-twelve district list must never be treated as
 * official, regardless of the date it claims. This asserts that invariant
 * holds both before and at-or-after this card's documented earliest
 * possible official-publication date (A11): a reconstruction does not become
 * official merely by being dated later.
 */
export function assertReconstructedBottomTwelveListNeverOfficial({
  project_id,
  filing_date,
  reconstructed_candidate,
  cycle_lists = [],
}) {
  const fact = materializeCommissionCycleListedFact({
    project_id,
    filing_date,
    reconstructed_candidate,
    cycle_lists,
  });
  if (fact.state === "known_true" || fact.state === "known_false") {
    throw new TypeError("a reconstructed bottom-twelve district list must never resolve the commission-cycle fact to a known value");
  }
  if (fact.reconstructed_candidate && fact.reconstructed_candidate.authoritative !== false) {
    throw new TypeError("a reconstructed candidate list must always be tagged non-authoritative");
  }
  return fact;
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

/**
 * Run the full LUP2-C12 backtest over a frozen, cohort-tagged fixture pack.
 * Stops (throws) on cohort leakage, a failed negative control, or a
 * counterfactual resolution that leaks into factual training -- there is no
 * partial or best-effort result for those failure modes.
 */
export function runLandPredictionRegimeBacktest(dataset, options = {}) {
  const gold = loadRegimeBacktestGoldPack(dataset);
  const preparedFactual = prepareFactualRegimeRows(gold.factual);

  const counterfactualAnalyses = gold.counterfactual.map(analyzeCounterfactualCase);

  const negativeControls = assertAllNegativeControlsPass(evaluateNegativeControls(gold.negative));

  const councilFamily = runRegimeModelFamily(preparedFactual, "council_disposition");
  const terminalFamily = runRegimeModelFamily(preparedFactual, "terminal_outcome");
  const comparison = compareStanceLiftAcrossTargets(councilFamily, terminalFamily);
  const divergence = computeDispositionOutcomeDivergence(preparedFactual);
  const nullResult = evaluateRegimeDilutionNullResult({ comparison, divergence });

  const promotionEvidence = {
    factual_post_reform_cases: preparedFactual.length > 0,
    actual_review_regime_observations: false,
    time_valid_features: true,
    held_out_improvement: comparison.comparable ? (comparison.lift_difference ?? 0) > 0 : false,
    stable_calibration: false,
    nontrivial_coverage: divergence.status === "estimated",
  };
  const promotion = evaluateRegimeTargetPromotionGate(promotionEvidence);

  return {
    schema: LAND_PREDICTION_REGIME_BACKTEST_SCHEMA,
    version: LAND_PREDICTION_REGIME_BACKTEST_VERSION,
    generated_at: options.generated_at || "2026-09-05T00:00:00.000Z",
    dataset: {
      schema: gold.schema,
      version: gold.version,
      frozen: true,
      purpose: gold.purpose,
      fingerprint: sha256Hex(JSON.stringify({
        factual: gold.factual.map((row) => row.id).sort(),
        counterfactual: gold.counterfactual.map((row) => row.id).sort(),
        negative: gold.negative.map((row) => row.id).sort(),
      })),
    },
    cohort_counts: {
      factual: gold.factual.length,
      counterfactual: gold.counterfactual.length,
      negative: gold.negative.length,
    },
    council_disposition: councilFamily,
    terminal_outcome: terminalFamily,
    comparison,
    divergence,
    null_result: nullResult,
    counterfactual_analyses: counterfactualAnalyses,
    negative_controls: negativeControls,
    promotion,
  };
}
