import registry from "./data/land_procedure_profiles.json" with { type: "json" };

export const LAND_PROCEDURE_PROFILE_SCHEMA = "cityscroll.land_procedure_profiles.v1";
export const LAND_PROCEDURE_PROFILE_VIEW_SCHEMA = "cityscroll.land_procedure_profile_view.v1";

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

function pathValue(object, path) {
  return String(path || "")
    .split(".")
    .filter(Boolean)
    .reduce((value, key) => value == null ? undefined : value[key], object);
}

/**
 * Closed condition vocabulary for normative successor selection. Conditions
 * inspect supplied source facts only; they never inspect or create events.
 */
export function matchesLandProcedureCondition(condition, facts = {}) {
  if (condition == null) return true;
  if (Array.isArray(condition.all)) return condition.all.every((item) => matchesLandProcedureCondition(item, facts));
  if (Array.isArray(condition.any)) return condition.any.some((item) => matchesLandProcedureCondition(item, facts));
  if (condition.not) return !matchesLandProcedureCondition(condition.not, facts);
  const value = pathValue(facts, condition.fact);
  if (Object.hasOwn(condition, "equals")) return value === condition.equals;
  if (Array.isArray(condition.in)) return condition.in.includes(value);
  if (condition.exists === true) return value !== undefined && value !== null;
  if (condition.exists === false) return value === undefined || value === null;
  return false;
}

function normalizeActionCodes(value) {
  if (Array.isArray(value)) return [...new Set(value.map(clean).filter(Boolean))];
  return [...new Set(String(value || "").split(/[;,]/).map(clean).filter(Boolean))];
}

function publisherProcedure(value) {
  const normalized = clean(value)?.toUpperCase().replace(/[\s_]+/g, "-");
  if (normalized === "ULURP") return "ulurp_197c";
  if (normalized === "ELURP") return "elurp_197e";
  return null;
}

function sourceFacts(input = {}) {
  const source = input.source && typeof input.source === "object" ? input.source : input;
  return {
    ...source,
    ...(input.facts && typeof input.facts === "object" ? input.facts : {}),
  };
}

const frozenRegistry = deepFreeze(clone(registry));
const profiles = Array.isArray(frozenRegistry.profiles) ? frozenRegistry.profiles : [];
const profileById = new Map(profiles.map((profile) => [profile.procedure_id, profile]));

export const LAND_PROCEDURE_PROFILE_REGISTRY = frozenRegistry;
export const LAND_PROCEDURE_PROFILE_REGISTRY_VERSION = frozenRegistry.registry_version;

/**
 * Validate the small hand-reviewed registry without interpreting its legal
 * content. This is intentionally structural: legal review belongs in the
 * registry, not hidden in renderer conditionals.
 */
export function validateLandProcedureProfileRegistry(value = frozenRegistry) {
  const errors = [];
  if (value?.schema !== LAND_PROCEDURE_PROFILE_SCHEMA) errors.push("schema");
  if (!clean(value?.registry_version)) errors.push("registry_version");
  if (value?.registry_status !== "reviewed_static") errors.push("registry_status");
  if (!Array.isArray(value?.profiles) || !value.profiles.length) errors.push("profiles");

  const seenProfiles = new Set();
  for (const profile of value?.profiles || []) {
    if (!clean(profile?.procedure_id) || seenProfiles.has(profile.procedure_id)) errors.push("profile.procedure_id");
    seenProfiles.add(profile?.procedure_id);
    if (!clean(profile?.label) || !clean(profile?.effective_from)) errors.push(`${profile?.procedure_id || "profile"}.metadata`);
    if (!Array.isArray(profile?.legal_basis) || !profile.legal_basis.length) errors.push(`${profile?.procedure_id || "profile"}.legal_basis`);
    if (!Array.isArray(profile?.stages) || !profile.stages.length) errors.push(`${profile?.procedure_id || "profile"}.stages`);
    const seenStages = new Set();
    for (const stage of profile?.stages || []) {
      if (!clean(stage?.stage_id) || seenStages.has(stage.stage_id)) errors.push(`${profile?.procedure_id || "profile"}.stage_id`);
      seenStages.add(stage?.stage_id);
      if (!clean(stage?.actor_selector?.kind) || !clean(stage?.actor_selector?.source_field)) errors.push(`${stage?.stage_id || "stage"}.actor_selector`);
      if (!clean(stage?.role) || !clean(stage?.effect)) errors.push(`${stage?.stage_id || "stage"}.meaning`);
      if (!Array.isArray(stage?.permitted_actions) || !stage.permitted_actions.length) errors.push(`${stage?.stage_id || "stage"}.permitted_actions`);
      if (!stage?.time_window || !Array.isArray(stage?.legal_basis) || !stage.legal_basis.length) errors.push(`${stage?.stage_id || "stage"}.evidence`);
      if (!Array.isArray(stage?.conditional_successors)) errors.push(`${stage?.stage_id || "stage"}.conditional_successors`);
    }
    const stageIds = new Set((profile?.stages || []).map((stage) => stage?.stage_id));
    for (const stage of profile?.stages || []) {
      for (const successor of stage?.conditional_successors || []) {
        if (!stageIds.has(successor?.to_stage_id)) errors.push(`${stage?.stage_id || "stage"}.successor`);
      }
    }
  }
  return { ok: errors.length === 0, errors };
}

const registryValidation = validateLandProcedureProfileRegistry();
if (!registryValidation.ok) {
  throw new Error(`Invalid land procedure profile registry: ${registryValidation.errors.join(", ")}`);
}

function unresolved(reason, source, sourceFields = []) {
  return {
    schema: LAND_PROCEDURE_PROFILE_VIEW_SCHEMA,
    layer: "normative",
    status: "unresolved",
    registry_schema: LAND_PROCEDURE_PROFILE_SCHEMA,
    registry_version: LAND_PROCEDURE_PROFILE_REGISTRY_VERSION,
    profile_id: null,
    reason,
    provenance: {
      source_type: "reviewed_static_registry",
      registry_schema: LAND_PROCEDURE_PROFILE_SCHEMA,
      registry_version: LAND_PROCEDURE_PROFILE_REGISTRY_VERSION,
      source_fields: sourceFields,
      source_snapshot: clone(source),
    },
  };
}

/**
 * Resolve a reviewed profile from explicit procedure facts. Milestone text is
 * deliberately ignored. Mixed action sets are not collapsed into one scalar
 * procedure unless an explicit reviewed profile id is supplied.
 */
export function resolveLandProcedureProfile(input = {}) {
  const source = sourceFacts(input);
  const explicitId = clean(source.procedure_profile_id || source.procedure_id);
  if (explicitId) {
    const profile = profileById.get(explicitId);
    return profile
      ? { status: "resolved", profile_id: explicitId, profile, method: "explicit_profile_id", source_fields: ["procedure_profile_id"] }
      : { status: "unresolved", profile_id: null, profile: null, reason: "unknown_profile_id", method: "explicit_profile_id", source_fields: ["procedure_profile_id"] };
  }

  const actions = normalizeActionCodes(source.actions || source.action_codes);
  if (actions.length > 1) {
    return { status: "unresolved", profile_id: null, profile: null, reason: "mixed_action_set", method: "publisher_procedure_exact", source_fields: ["actions", "ulurp_non"] };
  }

  const profileId = publisherProcedure(source.ulurp_non);
  if (!profileId) {
    const hasProcedureSignal = source.ulurp_non != null || source.current_milestone != null || source.actions != null;
    return {
      status: "unresolved",
      profile_id: null,
      profile: null,
      reason: hasProcedureSignal ? "unsupported_or_missing_procedure" : "no_procedure_facts",
      method: "publisher_procedure_exact",
      source_fields: hasProcedureSignal ? ["ulurp_non", "actions"] : [],
    };
  }

  return {
    status: "resolved",
    profile_id: profileId,
    profile: profileById.get(profileId),
    method: "publisher_ulurp_non_exact",
    source_fields: ["ulurp_non"],
  };
}

function decorateStage(profile, stage) {
  return {
    ...clone(stage),
    profile_id: profile.procedure_id,
    registry_version: LAND_PROCEDURE_PROFILE_REGISTRY_VERSION,
    effective_from: profile.effective_from,
    effective_to: profile.effective_to || null,
    legal_basis: clone(stage.legal_basis),
  };
}

function expectedSuccessor(profile, stage, facts) {
  const successors = Array.isArray(stage?.conditional_successors) ? stage.conditional_successors : [];
  const selected = successors.find((successor) => matchesLandProcedureCondition(successor.when, facts));
  if (!selected) return null;
  const next = profile.stages.find((candidate) => candidate.stage_id === selected.to_stage_id);
  return next ? decorateStage(profile, next) : null;
}

/**
 * Renderer consumption contract. The returned object is a normative sibling
 * view: it has no event collection and never receives an observed_event_id.
 */
export function buildLandProcedureProfileView({
  source = {},
  facts = {},
  profile = null,
  current_stage_id = null,
  current_phase_id = null,
} = {}) {
  const reviewedProfile = profile ? profileById.get(clean(profile.procedure_id)) : null;
  const resolution = profile
    ? reviewedProfile
      ? { status: "resolved", profile_id: reviewedProfile.procedure_id, profile: reviewedProfile, method: "provided_reviewed_profile", source_fields: ["procedure_profile_id"] }
      : { status: "unresolved", profile_id: null, profile: null, reason: "unknown_profile_id", method: "provided_reviewed_profile", source_fields: ["procedure_profile_id"] }
    : resolveLandProcedureProfile({ source, facts });
  const sourceSnapshot = sourceFacts({ source, facts });

  if (resolution.status !== "resolved" || !resolution.profile) {
    if (!resolution.source_fields?.length && !Object.keys(sourceSnapshot).length) return null;
    return unresolved(resolution.reason, sourceSnapshot, resolution.source_fields || []);
  }

  const selected = resolution.profile;
  const decoratedStages = selected.stages.map((stage) => decorateStage(selected, stage));
  const currentCandidates = decoratedStages.filter((stage) =>
    current_stage_id ? stage.stage_id === current_stage_id : stage.spine_phase_id === current_phase_id,
  );
  const current = currentCandidates.find((stage) =>
    !stage.when || matchesLandProcedureCondition(stage.when, sourceSnapshot),
  ) || null;
  const next = current ? expectedSuccessor(selected, current, sourceSnapshot) : null;

  return {
    schema: LAND_PROCEDURE_PROFILE_VIEW_SCHEMA,
    layer: "normative",
    status: "resolved",
    registry_schema: LAND_PROCEDURE_PROFILE_SCHEMA,
    registry_version: LAND_PROCEDURE_PROFILE_REGISTRY_VERSION,
    profile_id: selected.procedure_id,
    label: selected.label,
    effective_from: selected.effective_from,
    effective_to: selected.effective_to || null,
    legal_basis: clone(selected.legal_basis),
    stages: decoratedStages,
    current_stage: current,
    expected_next_stage: next,
    provenance: {
      source_type: "reviewed_static_registry",
      registry_schema: LAND_PROCEDURE_PROFILE_SCHEMA,
      registry_version: LAND_PROCEDURE_PROFILE_REGISTRY_VERSION,
      selection_method: resolution.method,
      source_fields: resolution.source_fields || [],
      legal_basis: clone(selected.legal_basis),
    },
  };
}
