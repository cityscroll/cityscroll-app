import registry from "./data/land_review_regimes.json" with { type: "json" };
import { LAND_PROCEDURE_PROFILE_REGISTRY } from "./land_procedure_profiles.mjs";

/**
 * Reviewed affordable-housing review-regime registry (LDP-18).
 *
 * A regime decorates or branches the existing land procedure model; it never
 * redefines `ulurp`, `elurp`, or `non_ulurp`. Three concepts stay separate:
 * procedure (how an application travels, unchanged here), eligibility regime
 * (why an alternate path is available), and review mechanism (what body may
 * review an already-completed stage). This module resolves eligibility and
 * conditional-successor state from explicit, caller-supplied facts; it never
 * infers eligibility from a title, applicant, or milestone text, and it
 * never materializes per-project facts itself (see LDP-19).
 */

export const LAND_REVIEW_REGIME_SCHEMA = "cityscroll.land_review_regimes.v1";
export const LAND_REVIEW_REGIME_KINDS = Object.freeze([
  "eligibility_regime",
  "authority_regime",
  "appeals_regime",
]);
export const LAND_REVIEW_REGIME_SOURCE_STATUSES = Object.freeze([
  "enacted",
  "adopted-rule",
  "proposed-rule",
]);
export const LAND_REVIEW_REGIME_ELIGIBILITY_STATUSES = Object.freeze([
  "eligible",
  "ineligible",
  "unknown",
  "not_yet_effective",
  "no_longer_effective",
]);
export const LAND_REVIEW_REGIME_SUCCESSOR_STATUSES = Object.freeze([
  "none",
  "potential",
  "confirmed",
]);

function clean(value) {
  if (value == null) return null;
  const text = String(value).replace(/\s+/g, " ").trim();
  return text || null;
}

function clone(value) {
  if (value == null) return value;
  return JSON.parse(JSON.stringify(value));
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

const frozenRegistry = deepFreeze(clone(registry));
const regimes = Array.isArray(frozenRegistry.regimes) ? frozenRegistry.regimes : [];
const regimeById = new Map(regimes.map((regime) => [regime.regime_id, regime]));
const baseProfileById = new Map(
  (LAND_PROCEDURE_PROFILE_REGISTRY.profiles || []).map((profile) => [profile.procedure_id, profile]),
);

export const LAND_REVIEW_REGIME_REGISTRY = frozenRegistry;
export const LAND_REVIEW_REGIME_REGISTRY_VERSION = frozenRegistry.registry_version;

/**
 * Validate the small hand-reviewed registry structurally. This never
 * interprets legal content; it only checks that every regime carries the
 * fields the card requires (kind, effective dates, legal basis, eligibility
 * fact keys, entry stage, terminal actor, conditional successors, and
 * source status), and that any cross-reference into the base procedure
 * registry actually resolves.
 */
export function validateLandReviewRegimeRegistry(value = frozenRegistry) {
  const errors = [];
  if (value?.schema !== LAND_REVIEW_REGIME_SCHEMA) errors.push("schema");
  if (!clean(value?.registry_version)) errors.push("registry_version");
  if (value?.registry_status !== "reviewed_static") errors.push("registry_status");
  if (!Array.isArray(value?.regimes) || !value.regimes.length) errors.push("regimes");

  const seenRegimeIds = new Set();
  for (const regime of value?.regimes || []) {
    const label = regime?.regime_id || "regime";
    if (!clean(regime?.regime_id) || seenRegimeIds.has(regime.regime_id)) errors.push("regime.regime_id");
    seenRegimeIds.add(regime?.regime_id);
    if (!LAND_REVIEW_REGIME_KINDS.includes(regime?.kind)) errors.push(`${label}.kind`);
    if (!clean(regime?.label) || !clean(regime?.effective_from)) errors.push(`${label}.metadata`);
    if (!LAND_REVIEW_REGIME_SOURCE_STATUSES.includes(regime?.source_status)) errors.push(`${label}.source_status`);
    if (!Array.isArray(regime?.legal_basis) || !regime.legal_basis.length) errors.push(`${label}.legal_basis`);
    if (!Array.isArray(regime?.eligibility_fact_keys) || !regime.eligibility_fact_keys.length) {
      errors.push(`${label}.eligibility_fact_keys`);
    }
    if (!regime?.entry_stage || typeof regime.entry_stage !== "object") errors.push(`${label}.entry_stage`);
    if (!clean(regime?.terminal_actor?.kind) || !clean(regime?.terminal_actor?.entity_ref)) {
      errors.push(`${label}.terminal_actor`);
    }
    if (!Array.isArray(regime?.conditional_successors)) errors.push(`${label}.conditional_successors`);

    if (regime?.kind === "eligibility_regime") {
      if (!clean(regime?.selects_procedure_id) || !baseProfileById.has(regime.selects_procedure_id)) {
        errors.push(`${label}.selects_procedure_id`);
      }
    }

    const stages = Array.isArray(regime?.stages) ? regime.stages : [];
    const seenStageIds = new Set();
    for (const stage of stages) {
      const stageLabel = stage?.stage_id || `${label}.stage`;
      if (!clean(stage?.stage_id) || seenStageIds.has(stage.stage_id)) errors.push(`${stageLabel}.stage_id`);
      seenStageIds.add(stage?.stage_id);
      if (!clean(stage?.actor_selector?.kind) || !clean(stage?.actor_selector?.source_field)) {
        errors.push(`${stageLabel}.actor_selector`);
      }
      if (!clean(stage?.role) || !clean(stage?.effect)) errors.push(`${stageLabel}.meaning`);
      if (!Array.isArray(stage?.permitted_actions) || !stage.permitted_actions.length) {
        errors.push(`${stageLabel}.permitted_actions`);
      }
      if (!stage?.time_window || !Array.isArray(stage?.legal_basis) || !stage.legal_basis.length) {
        errors.push(`${stageLabel}.evidence`);
      }
      if (!Array.isArray(stage?.conditional_successors)) errors.push(`${stageLabel}.conditional_successors`);
    }
    for (const stage of stages) {
      for (const successor of stage?.conditional_successors || []) {
        if (!seenStageIds.has(successor?.to_stage_id)) errors.push(`${stage?.stage_id || label}.successor`);
      }
    }

    for (const successor of regime?.conditional_successors || []) {
      const baseProfile = baseProfileById.get(successor?.procedure_id);
      if (!baseProfile) {
        errors.push(`${label}.conditional_successor.procedure_id`);
        continue;
      }
      const fromStageExists = (baseProfile.stages || []).some((stage) => stage.stage_id === successor.from_stage_id);
      if (!fromStageExists) errors.push(`${label}.conditional_successor.from_stage_id`);
      if (!seenStageIds.has(successor?.to_stage_id)) errors.push(`${label}.conditional_successor.to_stage_id`);
      if (!clean(successor?.triggering_fact)) errors.push(`${label}.conditional_successor.triggering_fact`);
      if (!Array.isArray(successor?.qualifying_disposition_values) || !successor.qualifying_disposition_values.length) {
        errors.push(`${label}.conditional_successor.qualifying_disposition_values`);
      }
      if (!clean(successor?.eligibility_fact)) errors.push(`${label}.conditional_successor.eligibility_fact`);
    }
  }
  return { ok: errors.length === 0, errors };
}

const registryValidation = validateLandReviewRegimeRegistry();
if (!registryValidation.ok) {
  throw new Error(`Invalid land review regime registry: ${registryValidation.errors.join(", ")}`);
}

export function landReviewRegimeById(regimeId) {
  return regimeById.get(clean(regimeId)) || null;
}

function effectiveDateStatus(regime, predictionAsOf) {
  const asOf = clean(predictionAsOf);
  if (!asOf) return null;
  if (regime.effective_from && asOf < regime.effective_from) return "not_yet_effective";
  if (regime.effective_to && asOf > regime.effective_to) return "no_longer_effective";
  return null;
}

/**
 * Evaluate a regime's eligibility from explicit facts only. A feature enters
 * a snapshot only when it was legally effective and knowable at
 * `prediction_as_of`: a prediction date before the regime's effective date
 * resolves `not_yet_effective` rather than `ineligible`, so a historical
 * snapshot can never read as though the regime already existed.
 */
export function resolveLandReviewRegimeEligibility({ regime_id, facts = {}, prediction_as_of = null } = {}) {
  const regime = landReviewRegimeById(regime_id);
  if (!regime) {
    return {
      schema: LAND_REVIEW_REGIME_SCHEMA,
      registry_version: LAND_REVIEW_REGIME_REGISTRY_VERSION,
      regime_id: clean(regime_id),
      status: "unknown",
      reason: "unknown_regime_id",
      missing_facts: [],
    };
  }

  const temporalStatus = effectiveDateStatus(regime, prediction_as_of);
  if (temporalStatus) {
    return {
      schema: LAND_REVIEW_REGIME_SCHEMA,
      registry_version: LAND_REVIEW_REGIME_REGISTRY_VERSION,
      regime_id: regime.regime_id,
      kind: regime.kind,
      status: temporalStatus,
      reason: temporalStatus,
      source_status: regime.source_status,
      missing_facts: [],
    };
  }

  const missing = [];
  let anyFalse = false;
  for (const key of regime.eligibility_fact_keys) {
    const value = facts?.[key];
    if (value === false) anyFalse = true;
    else if (value !== true) missing.push(key);
  }

  const status = anyFalse ? "ineligible" : missing.length ? "unknown" : "eligible";

  return {
    schema: LAND_REVIEW_REGIME_SCHEMA,
    registry_version: LAND_REVIEW_REGIME_REGISTRY_VERSION,
    regime_id: regime.regime_id,
    kind: regime.kind,
    status,
    reason: status === "eligible" ? null : status === "ineligible" ? "disqualifying_fact" : "eligibility_fact_unknown",
    source_status: regime.source_status,
    missing_facts: missing,
  };
}

/**
 * Decorate an already-resolved base procedure with a §197-f eligibility
 * regime. The base `procedure_id` must already equal the regime's
 * `selects_procedure_id`; this function never mints a new procedure value
 * and never overrides a procedure resolution it disagrees with.
 */
export function resolveLandFastTrackDecoration({ procedure_id, facts = {}, prediction_as_of = null } = {}) {
  const regime = landReviewRegimeById("affordable_housing_fast_track_197f");
  if (clean(procedure_id) !== regime.selects_procedure_id) {
    return {
      schema: LAND_REVIEW_REGIME_SCHEMA,
      applicable: false,
      reason: "procedure_not_selected_by_regime",
      procedure_id: clean(procedure_id),
      regime_id: regime.regime_id,
    };
  }
  const eligibility = resolveLandReviewRegimeEligibility({
    regime_id: regime.regime_id,
    facts,
    prediction_as_of,
  });
  return {
    schema: LAND_REVIEW_REGIME_SCHEMA,
    applicable: eligibility.status === "eligible",
    procedure_id: clean(procedure_id),
    regime_id: regime.regime_id,
    eligibility,
  };
}

function decorateRegimeStage(regime, stage) {
  return {
    ...clone(stage),
    regime_id: regime.regime_id,
    registry_version: LAND_REVIEW_REGIME_REGISTRY_VERSION,
    effective_from: regime.effective_from,
    effective_to: regime.effective_to || null,
  };
}

/**
 * Resolve the standalone §666-a authority path (or any other regime that
 * carries its own `stages[]`) from explicit eligibility facts. Its stages
 * never reference a Commission or Council stage id from an unrelated
 * procedure.
 */
export function resolveLandAuthorityRegime({ regime_id, facts = {}, prediction_as_of = null } = {}) {
  const regime = landReviewRegimeById(regime_id);
  if (!regime || !Array.isArray(regime.stages) || !regime.stages.length) {
    return {
      schema: LAND_REVIEW_REGIME_SCHEMA,
      regime_id: clean(regime_id),
      status: "unknown",
      reason: "unknown_or_non_standalone_regime_id",
      stages: [],
      terminal_actor: null,
    };
  }
  const eligibility = resolveLandReviewRegimeEligibility({ regime_id, facts, prediction_as_of });
  return {
    schema: LAND_REVIEW_REGIME_SCHEMA,
    registry_version: LAND_REVIEW_REGIME_REGISTRY_VERSION,
    regime_id: regime.regime_id,
    kind: regime.kind,
    eligibility,
    entry_stage_id: regime.entry_stage?.stage_id || null,
    terminal_actor: clone(regime.terminal_actor),
    stages: regime.stages.map((stage) => decorateRegimeStage(regime, stage)),
  };
}

/**
 * Resolve whether an appeals regime (§197-g) is a conditional successor of a
 * base-procedure stage a reader is currently looking at. This never mutates
 * or substitutes for the base procedure: `ulurp_197c`, the conditional
 * §197-d Council path, and the §197-a plan path remain exactly as resolved
 * by `land_procedure_profiles.mjs`. An unchanged Council approval, or a
 * disapproval/modification whose eligibility is not yet established, must
 * never read as a confirmed successor.
 */
export function resolveAppealsRegimeSuccessor({
  procedure_id,
  stage_id,
  facts = {},
  prediction_as_of = null,
} = {}) {
  const regime = landReviewRegimeById("affordable_housing_appeals_197g");
  const entry = (regime.conditional_successors || []).find(
    (candidate) => candidate.procedure_id === clean(procedure_id) && candidate.from_stage_id === clean(stage_id),
  );
  if (!entry) {
    return {
      schema: LAND_REVIEW_REGIME_SCHEMA,
      regime_id: regime.regime_id,
      status: "none",
      reason: "not_a_qualifying_stage",
      to_stage_id: null,
    };
  }

  const temporalStatus = effectiveDateStatus(regime, prediction_as_of);
  if (temporalStatus) {
    return {
      schema: LAND_REVIEW_REGIME_SCHEMA,
      regime_id: regime.regime_id,
      status: "none",
      reason: temporalStatus,
      to_stage_id: null,
    };
  }

  const dispositionValue = facts?.[entry.triggering_fact];
  const dispositionQualifies = entry.qualifying_disposition_values.includes(dispositionValue);
  if (!dispositionQualifies) {
    return {
      schema: LAND_REVIEW_REGIME_SCHEMA,
      regime_id: regime.regime_id,
      status: "none",
      reason: "no_qualifying_council_disposition",
      to_stage_id: null,
    };
  }

  const eligibilityValue = facts?.[entry.eligibility_fact];
  if (eligibilityValue === false) {
    return {
      schema: LAND_REVIEW_REGIME_SCHEMA,
      regime_id: regime.regime_id,
      status: "none",
      reason: "ineligible",
      to_stage_id: null,
    };
  }
  if (eligibilityValue !== true) {
    return {
      schema: LAND_REVIEW_REGIME_SCHEMA,
      regime_id: regime.regime_id,
      status: "potential",
      reason: "eligibility_not_yet_established",
      to_stage_id: entry.to_stage_id,
    };
  }

  const targetStage = (regime.stages || []).find((stage) => stage.stage_id === entry.to_stage_id);
  return {
    schema: LAND_REVIEW_REGIME_SCHEMA,
    regime_id: regime.regime_id,
    status: "confirmed",
    reason: null,
    to_stage_id: entry.to_stage_id,
    stage: targetStage ? decorateRegimeStage(regime, targetStage) : null,
    terminal_actor: clone(regime.terminal_actor),
  };
}
