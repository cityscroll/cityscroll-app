// Experimental Council-disposition / terminal-outcome targets and
// review-regime features for Land-Use Prediction v2 (LUP2-C11).
//
// This module is strictly additive and shadow/research-only. It never edits
// land_prediction_predictor.mjs or land_prediction_features.mjs: the
// approved predictor and its feature vector remain the unchanged
// compatibility baseline. Every export here produces a separately reasoned
// experimental artifact layered on top of that baseline, an existing C2/C5
// vector, and the reviewed LDP-18/LDP-19 review-regime and eligibility-fact
// contracts.
//
// December 2025 broke the assumption the baseline predictor was built on:
// an adverse City Council disposition (a disapproval, or an approval with
// modifications) is no longer necessarily the end of an application, because
// an eligible application can still reach an independent Affordable Housing
// Appeals Board review under NYC Charter section 197-g, or may never have
// passed through the Council at all under the section 197-f expedited
// Commission path or the standalone section 666-a targeted-project path.
// Council disposition and terminal land-use outcome are therefore kept as
// two separately reasoned experimental targets rather than one.

import {
  buildLandPredictionFeatureVector,
} from "./land_prediction_features.mjs";
import {
  LAND_REVIEW_REGIME_SCHEMA,
  resolveLandReviewRegimeEligibility,
} from "../../../site/land_review_regimes.mjs";
import {
  materializeAffordableEligibilityFacts,
  resolveAffordableAppealsReviewEligibility,
} from "../../../site/affordable_eligibility_facts.mjs";

export const LAND_PREDICTION_REGIME_TARGETS_SCHEMA =
  "cityscroll.land_prediction_regime_targets.v1";
export const LAND_PREDICTION_REGIME_TARGETS_VERSION = 1;
export const LAND_PREDICTION_REGIME_FEATURE_VECTOR_SCHEMA =
  "cityscroll.land_prediction_regime_feature_vector.v1";
export const LAND_PREDICTION_REGIME_FEATURE_VECTOR_VERSION = 1;

// Both targets stay experimental and shadow-only until LUP2-C12's backtest
// gate; neither is wired into the authoritative baseline predictor.
export const COUNCIL_DISPOSITION_TARGET = "council_disposition";
export const TERMINAL_OUTCOME_TARGET = "terminal_land_use_outcome";
export const REGIME_TARGET_PROMOTION_STATUS =
  "shadow_only_until_regime_target_backtest_gate";

export const COUNCIL_DISPOSITION_VALUES = Object.freeze([
  "approved_unchanged",
  "approved_modified",
  "disapproved",
  "withdrawn_or_no_vote",
  "unresolved",
]);

export const TERMINAL_OUTCOME_VALUES = Object.freeze([
  "authorized",
  "unauthorized",
  "withdrawn",
  "unresolved",
]);

// Provenance for a terminal `authorized`/`unauthorized` outcome. This is the
// distinction the incumbent single-target predictor cannot represent: an
// authorization may come from the City Council itself, from the section
// 197-g appeals board reviewing a qualifying Council disposition, from the
// City Planning Commission acting alone under the section 197-f expedited
// path, or from the Board of Standards and Appeals acting alone under the
// standalone section 666-a path.
export const TERMINAL_AUTHORIZATION_PATHS = Object.freeze([
  "council",
  "appeals_review_197g",
  "commission_expedited_197f",
  "board_666a",
]);

const REGIME_IDS = Object.freeze({
  section_197f: "affordable_housing_fast_track_197f",
  section_666a: "targeted_affordable_housing_project_666a",
  section_197g: "affordable_housing_appeals_197g",
});

// A Council disposition label never becomes the §197-g `council_disposition`
// registry fact merely by string similarity: only a qualifying disposition
// (an approval with modifications, or a disapproval) maps to a registry
// value at all. An unchanged approval and a withdrawal/no-vote map to no
// fact, so `resolveAppealsRegimeSuccessor` resolves them the same way the
// registry itself would: not a qualifying stage.
export const COUNCIL_DISPOSITION_TO_REGIME_FACT_VALUE = Object.freeze({
  approved_unchanged: null,
  approved_modified: "approve_with_modifications",
  disapproved: "disapprove",
  withdrawn_or_no_vote: null,
  unresolved: null,
});

export const REVIEW_REGIME_FEATURE_KEYS = Object.freeze([
  "review_regime.section_197f_eligibility",
  "review_regime.section_666a_eligibility",
  "review_regime.section_197g_potential_review_eligibility",
  "review_regime.section_197g_actual_trigger",
]);

// The learnable stance-by-regime interaction candidates (G5, A10). These are
// declared metadata only, exactly like C5's `stage_interactions`: no numeric
// weight, discount, or veto rule is attached to any of them here or anywhere
// else in this module. A future fitting pass may or may not find any of
// these predictive; that is an empirical question this module does not
// prejudge.
export const REGIME_INTERACTION_FEATURE_KEYS = Object.freeze([
  "local_council_member_stance",
]);
export const REGIME_INTERACTION_REGIME_KEYS = Object.freeze([
  REGIME_IDS.section_197f,
  REGIME_IDS.section_666a,
  REGIME_IDS.section_197g,
]);

// Historical years in which no §197-f/§666-a/§197-g regime existed. A
// counterfactual resolution computed for one of these years may be generated
// for analysis (LUP2-C12 owns that analysis), but `assertNoCounterfactualLeakage`
// and the factual builders in this module refuse to let such a resolution
// become a training label.
export const COUNTERFACTUAL_QUARANTINE_YEARS = Object.freeze([
  "2016", "2018", "2022", "2023", "2024",
]);

export const REGIME_TARGET_PROMOTION_GATE = Object.freeze([
  Object.freeze({ key: "factual_post_reform_cases", label: "factual post-reform cases" }),
  Object.freeze({ key: "actual_review_regime_observations", label: "actual review-regime observations" }),
  Object.freeze({ key: "time_valid_features", label: "time-valid features" }),
  Object.freeze({ key: "held_out_improvement", label: "held-out improvement" }),
  Object.freeze({ key: "stable_calibration", label: "stable calibration" }),
  Object.freeze({ key: "nontrivial_coverage", label: "nontrivial coverage" }),
]);

function assertObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
}

/**
 * Resolve the experimental Council-disposition label from explicit,
 * caller-supplied evidence about the Council action itself. This never
 * infers a disposition from a title, applicant, or milestone text.
 *
 * `vote` carries the registry vocabulary ("approve" | "disapprove" | null).
 * A modified approval is `approved_modified`, never collapsed into
 * `disapproved` (A3): modification and disapproval remain distinguishable
 * dispositions with distinct downstream review consequences.
 */
export function resolveCouncilDisposition({
  vote = null,
  modified = false,
  withdrawn = false,
  no_vote = false,
} = {}) {
  if (withdrawn || no_vote) return "withdrawn_or_no_vote";
  if (vote === "approve") return modified ? "approved_modified" : "approved_unchanged";
  if (vote === "disapprove") return "disapproved";
  return "unresolved";
}

/**
 * Resolve the experimental terminal-outcome label and its authorization
 * provenance from explicit evidence. Council disposition is one input among
 * several independent authorization paths (G1, A2, A3, A4, A5, A6):
 *
 * - `commission_expedited_disposition`: the City Planning Commission's own
 *   decision under the section 197-f expedited (`elurp_197e`) path, which
 *   never passes through the Council at all.
 * - `board_666a_disposition`: the Board of Standards and Appeals' own
 *   decision under the standalone section 666-a targeted-project path.
 * - `appeals_board_disposition`: the section 197-g Appeals Board's
 *   disposition of a qualifying Council action, only consulted once the
 *   appeal is `confirmed` as actually triggered.
 * - `council_disposition`: the Council's own disposition, from
 *   `resolveCouncilDisposition`.
 *
 * A Council modification never resolves terminal outcome by itself when an
 * eligible, actually-triggered appeal is pending (A3): the terminal outcome
 * stays `unresolved` until the appeals board (or an explicit withdrawal)
 * settles it.
 */
export function resolveTerminalOutcome({
  council_disposition = "unresolved",
  actual_trigger_status = "none",
  appeals_board_disposition = null,
  commission_expedited_disposition = null,
  board_666a_disposition = null,
  project_withdrawn = false,
} = {}) {
  if (!COUNCIL_DISPOSITION_VALUES.includes(council_disposition)) {
    throw new TypeError(`unsupported council_disposition: ${council_disposition}`);
  }
  if (project_withdrawn) {
    return { value: "withdrawn", authorization_path: null, reason: "project_withdrawn" };
  }
  if (commission_expedited_disposition === "approve") {
    return { value: "authorized", authorization_path: "commission_expedited_197f", reason: null };
  }
  if (commission_expedited_disposition === "disapprove") {
    return { value: "unauthorized", authorization_path: "commission_expedited_197f", reason: null };
  }
  if (board_666a_disposition === "approve" || board_666a_disposition === "approve_with_conditions") {
    return { value: "authorized", authorization_path: "board_666a", reason: null };
  }
  if (board_666a_disposition === "deny") {
    return { value: "unauthorized", authorization_path: "board_666a", reason: null };
  }

  const appealActuallyTriggered = actual_trigger_status === "confirmed";
  if (appealActuallyTriggered) {
    if (!appeals_board_disposition) {
      return { value: "unresolved", authorization_path: null, reason: "appeals_review_pending" };
    }
    const councilApproved = council_disposition === "approved_modified";
    if (appeals_board_disposition === "affirm") {
      return {
        value: councilApproved ? "authorized" : "unauthorized",
        authorization_path: "appeals_review_197g",
        reason: null,
      };
    }
    if (appeals_board_disposition === "reverse") {
      return {
        value: councilApproved ? "unauthorized" : "authorized",
        authorization_path: "appeals_review_197g",
        reason: null,
      };
    }
    if (appeals_board_disposition === "modify") {
      return { value: "authorized", authorization_path: "appeals_review_197g", reason: null };
    }
    return { value: "unresolved", authorization_path: null, reason: "unsupported_appeals_board_disposition" };
  }

  if (actual_trigger_status === "potential") {
    return { value: "unresolved", authorization_path: null, reason: "appeals_eligibility_not_yet_established" };
  }

  if (council_disposition === "approved_unchanged" || council_disposition === "approved_modified") {
    return { value: "authorized", authorization_path: "council", reason: null };
  }
  if (council_disposition === "disapproved") {
    return { value: "unauthorized", authorization_path: "council", reason: null };
  }
  if (council_disposition === "withdrawn_or_no_vote") {
    return { value: "unresolved", authorization_path: null, reason: "withdrawn_or_no_council_vote_pending_terminal_evidence" };
  }
  return { value: "unresolved", authorization_path: null, reason: "no_terminal_evidence" };
}

/**
 * Resolve the §197-g actual-trigger status for a Council disposition using
 * the reviewed LDP-19 (`resolveAffordableAppealsReviewEligibility`) and
 * LDP-18 (`resolveAppealsRegimeSuccessor`) resolvers directly, rather than
 * re-implementing their qualifying-disposition, eligibility, or
 * authoritative-source discipline here. `eligible_application_class_source`
 * is an evidence source, not a boolean: an unsupported or missing source
 * stays `unknown`, never a silent `false` (A7, A11).
 */
export function resolveActualAppealsTrigger({
  council_disposition,
  eligible_application_class_source = null,
  base_procedure_id,
  base_stage_id,
  prediction_as_of = null,
  project_id = null,
} = {}) {
  const regimeFactValue = council_disposition
    ? COUNCIL_DISPOSITION_TO_REGIME_FACT_VALUE[council_disposition]
    : null;
  const result = resolveAffordableAppealsReviewEligibility({
    project_id,
    prediction_as_of,
    eligible_application_class_source,
    council_disposition: regimeFactValue,
    base_procedure_id,
    base_stage_id,
  });
  return result.actual_trigger;
}

/**
 * Resolve both experimental targets together from one evidence bundle. The
 * two records are always distinct fields (A2): a caller can never conflate
 * `council_disposition` with `terminal_outcome`.
 */
export function resolveLandPredictionRegimeOutcome({
  council_action = {},
  eligible_application_class_source = null,
  appeals_board_disposition = null,
  commission_expedited_disposition = null,
  board_666a_disposition = null,
  project_withdrawn = false,
  base_procedure_id,
  base_stage_id,
  prediction_as_of = null,
  project_id = null,
} = {}) {
  const councilDisposition = resolveCouncilDisposition(council_action);
  const actualTrigger = resolveActualAppealsTrigger({
    council_disposition: councilDisposition,
    eligible_application_class_source,
    base_procedure_id,
    base_stage_id,
    prediction_as_of,
    project_id,
  });
  const terminal = resolveTerminalOutcome({
    council_disposition: councilDisposition,
    actual_trigger_status: actualTrigger.status,
    appeals_board_disposition,
    commission_expedited_disposition,
    board_666a_disposition,
    project_withdrawn,
  });
  return {
    schema: LAND_PREDICTION_REGIME_TARGETS_SCHEMA,
    council_disposition: councilDisposition,
    terminal_outcome: terminal.value,
    terminal_authorization_path: terminal.authorization_path,
    terminal_reason: terminal.reason,
    actual_appeals_trigger: actualTrigger,
  };
}

function unknownRegimeFeature(key, evidenceType) {
  return {
    key,
    value: null,
    state: "unknown",
    evidence_type: evidenceType,
    observed_at: null,
    effective_at: null,
    source: null,
    confidence: null,
    evidence: [],
    evidence_ids: [],
  };
}

// A regime feature's `state` is `unknown` for every non-eligible resolution
// (`unknown`, `not_yet_effective`, `no_longer_effective`) and `known` only
// for `eligible`/`ineligible` (A7): `false` is a known, evidenced state, and
// it is never used to stand in for a missing or not-yet-effective fact (G3,
// A8). A `not_yet_effective` resolution can never be encoded as active
// eligibility, satisfying the temporal rule structurally rather than by
// convention.
function regimeEligibilityFeature(key, resolution, context) {
  if (resolution.status !== "eligible" && resolution.status !== "ineligible") {
    return unknownRegimeFeature(key, resolution.status);
  }
  const value = resolution.status === "eligible";
  const evidenceId = `${context.application_id}:${key}:${context.prediction_as_of}`;
  const source = Object.freeze({
    contract: LAND_REVIEW_REGIME_SCHEMA,
    regime_id: resolution.regime_id,
    registry_version: resolution.registry_version,
  });
  return {
    key,
    value,
    state: "known",
    evidence_type: "review_regime_eligibility_resolution",
    observed_at: null,
    effective_at: context.prediction_as_of,
    source,
    confidence: null,
    evidence: [{
      evidence_id: evidenceId,
      evidence_type: "review_regime_eligibility_resolution",
      observed_at: null,
      effective_at: context.prediction_as_of,
      source,
      cutoff: context.prediction_as_of,
      identity: null,
      relation: key,
      observation: evidenceId,
    }],
    evidence_ids: [evidenceId],
  };
}

// The actual-trigger status (`none` | `potential` | `confirmed`) is always a
// definite, computed fact given the current disposition and eligibility
// evidence, so it is always `known` -- it is never used as a proxy for
// eligibility itself, which stays governed by `regimeEligibilityFeature`.
function regimeTriggerFeature(key, trigger, context) {
  if (!["none", "potential", "confirmed"].includes(trigger.status)) {
    return unknownRegimeFeature(key, trigger.reason || "unresolved");
  }
  const evidenceId = `${context.application_id}:${key}:${context.prediction_as_of}`;
  const source = Object.freeze({
    contract: LAND_REVIEW_REGIME_SCHEMA,
    regime_id: trigger.regime_id,
  });
  return {
    key,
    value: trigger.status,
    state: "known",
    evidence_type: "review_regime_trigger_resolution",
    observed_at: null,
    effective_at: context.prediction_as_of,
    source,
    confidence: null,
    evidence: [{
      evidence_id: evidenceId,
      evidence_type: "review_regime_trigger_resolution",
      observed_at: null,
      effective_at: context.prediction_as_of,
      source,
      cutoff: context.prediction_as_of,
      identity: null,
      relation: key,
      observation: evidenceId,
    }],
    evidence_ids: [evidenceId],
  };
}

function buildRegimeInteractions() {
  const interactions = [];
  for (const featureKey of REGIME_INTERACTION_FEATURE_KEYS) {
    for (const regimeKey of REGIME_INTERACTION_REGIME_KEYS) {
      interactions.push({
        feature_key: featureKey,
        regime_key: regimeKey,
        interaction_key: `${featureKey}@${regimeKey}`,
        estimation: "learnable_regime_interaction",
      });
    }
  }
  return interactions;
}

/**
 * Generate a counterfactual review-regime eligibility resolution for
 * research analysis only (G4). The result is explicitly tagged
 * `counterfactual: true, factual: false`; `assertNoCounterfactualLeakage`
 * and every factual builder in this module refuse it.
 */
export function computeCounterfactualRegimeEligibility({
  regime_id,
  facts = {},
  historical_prediction_as_of,
} = {}) {
  const resolution = resolveLandReviewRegimeEligibility({
    regime_id,
    facts,
    prediction_as_of: historical_prediction_as_of,
  });
  return {
    schema: LAND_PREDICTION_REGIME_TARGETS_SCHEMA,
    counterfactual: true,
    factual: false,
    historical_prediction_as_of: historical_prediction_as_of || null,
    regime_id,
    resolution,
    note: "Generated for analysis only (LUP2-C12). This resolution must never enter factual historical training as though the regime existed at this date.",
  };
}

/** Fail closed on any input tagged as a counterfactual resolution (A9). */
export function assertNoCounterfactualLeakage(candidate, label = "regime training input") {
  const stack = [candidate];
  const seen = new Set();
  while (stack.length) {
    const value = stack.pop();
    if (!value || typeof value !== "object" || seen.has(value)) continue;
    seen.add(value);
    if (value.counterfactual === true || value.factual === false) {
      throw new TypeError(`${label} carries a counterfactual eligibility resolution and must be quarantined from factual training`);
    }
    if (Array.isArray(value)) {
      stack.push(...value);
    } else {
      stack.push(...Object.values(value));
    }
  }
  return candidate;
}

/**
 * Build the experimental regime feature vector: the unchanged C5 base vector
 * (A1) plus review-regime features and learnable regime-interaction
 * candidates. Never merges into, mutates, or re-validates the base vector's
 * own schema (`cityscroll.land_prediction_feature_vector.v1` stays exactly
 * what `land_prediction_features.mjs` already produces).
 */
export function buildLandPredictionRegimeFeatureVector(input = {}) {
  assertObject(input, "land prediction regime feature vector input");
  assertNoCounterfactualLeakage(input, "land prediction regime feature vector input");

  const base = buildLandPredictionFeatureVector(input);
  const context = { application_id: base.application_id, prediction_as_of: base.prediction_as_of };
  // Every eligibility criterion is materialized through the reviewed LDP-19
  // fact layer, not consumed as raw booleans: this is what carries the
  // per-criterion authoritative-source discipline and the §197-f
  // commission-cycle fact-level operative window (A8) into this vector,
  // rather than re-implementing either one here.
  const criteria = input.eligibility_criteria || {};
  const filingDate = input.filing_date || base.prediction_as_of;

  const section197f = materializeAffordableEligibilityFacts({
    regime_id: REGIME_IDS.section_197f,
    project_id: base.application_id,
    prediction_as_of: base.prediction_as_of,
    filing_date: filingDate,
    criteria,
  });
  const section666a = materializeAffordableEligibilityFacts({
    regime_id: REGIME_IDS.section_666a,
    project_id: base.application_id,
    prediction_as_of: base.prediction_as_of,
    filing_date: filingDate,
    criteria,
  });
  const appealsReview = resolveAffordableAppealsReviewEligibility({
    project_id: base.application_id,
    prediction_as_of: base.prediction_as_of,
    eligible_application_class_source:
      criteria["affordable_housing.section_197g.eligible_application_class"]?.source || null,
    council_disposition: input.council_disposition_label
      ? COUNCIL_DISPOSITION_TO_REGIME_FACT_VALUE[input.council_disposition_label]
      : null,
    base_procedure_id: input.base_procedure_id,
    base_stage_id: input.base_stage_id,
  });

  const regimeFeatures = [
    regimeEligibilityFeature(REVIEW_REGIME_FEATURE_KEYS[0], section197f.regime_eligibility, context),
    regimeEligibilityFeature(REVIEW_REGIME_FEATURE_KEYS[1], section666a.regime_eligibility, context),
    regimeEligibilityFeature(REVIEW_REGIME_FEATURE_KEYS[2], appealsReview.potential_review_eligibility, context),
    regimeTriggerFeature(REVIEW_REGIME_FEATURE_KEYS[3], appealsReview.actual_trigger, context),
  ];

  return {
    schema: LAND_PREDICTION_REGIME_FEATURE_VECTOR_SCHEMA,
    schema_version: LAND_PREDICTION_REGIME_FEATURE_VECTOR_VERSION,
    application_id: base.application_id,
    prediction_as_of: base.prediction_as_of,
    procedural_stage: base.procedural_stage,
    base_vector: base,
    regime_features: regimeFeatures,
    regime_interactions: buildRegimeInteractions(),
    experimental: true,
    authoritative: false,
    promotion_status: REGIME_TARGET_PROMOTION_STATUS,
  };
}

/**
 * Non-causal explanation for a resolved pair of experimental targets (A11).
 * This names observed evidence, stage, and authorization path only; it never
 * asserts that a Council member, appeals board member, or review regime
 * caused the outcome.
 */
export function explainRegimeOutcome({
  council_disposition,
  terminal_outcome,
  terminal_authorization_path = null,
  evidence_notes = [],
} = {}) {
  const pathClause = terminal_authorization_path
    ? ` recorded through the ${terminal_authorization_path} path`
    : "";
  return {
    schema: LAND_PREDICTION_REGIME_TARGETS_SCHEMA,
    council_disposition,
    terminal_outcome,
    terminal_authorization_path,
    statement:
      `Observed Council disposition "${council_disposition}" and terminal outcome "${terminal_outcome}"${pathClause}. `
      + "This is a record of observed evidence and procedural stage, not a causal claim that a Council member, "
      + "appeals board member, or review regime controlled the result.",
    evidence_notes: [...evidence_notes],
    causal_claim: false,
  };
}

/**
 * Report whether the recorded evidence meets every promotion-gate criterion
 * (verbatim from the card). This never flips promotion itself: even an
 * evidence bundle that satisfies every criterion still requires a separate,
 * explicit promotion decision this module does not grant.
 */
export function evaluateRegimeTargetPromotionGate(evidence = {}) {
  assertObject(evidence, "regime target promotion gate evidence");
  const unmet = REGIME_TARGET_PROMOTION_GATE.filter((criterion) => !evidence[criterion.key]);
  return {
    schema: LAND_PREDICTION_REGIME_TARGETS_SCHEMA,
    criteria: REGIME_TARGET_PROMOTION_GATE.map((criterion) => criterion.label),
    unmet: unmet.map((criterion) => criterion.label),
    all_criteria_met: unmet.length === 0,
    promoted: false,
    promotion_status: REGIME_TARGET_PROMOTION_STATUS,
    reason: unmet.length
      ? `promotion withheld: unmet criteria: ${unmet.map((criterion) => criterion.label).join(", ")}`
      : "every recorded gate criterion is met; promotion is still a separate explicit decision this evaluation does not grant",
  };
}
