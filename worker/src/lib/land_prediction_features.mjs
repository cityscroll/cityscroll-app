// Stage-aware institutional feature vector for Land-Use Prediction v2.
//
// This is a deterministic adapter over the C2 temporal snapshot and the C4
// project-specific member-stance contract. It normalizes evidence; it does
// not assign model weights, infer political positions, or encode a veto rule.

import {
  FEATURE_STATES,
  LAND_PREDICTION_SNAPSHOT_SCHEMA,
  buildLandPredictionSnapshot,
  validateLandPredictionSnapshot,
} from "./land_prediction_snapshot.mjs";
import {
  LAND_PREDICTION_MEMBER_STANCE_SCHEMA,
  validateLandMemberStance,
} from "./land_prediction_member_stance.mjs";

export const LAND_PREDICTION_FEATURE_VECTOR_SCHEMA =
  "cityscroll.land_prediction_feature_vector.v1";
export const LAND_PREDICTION_FEATURE_VECTOR_VERSION = 1;

export const INSTITUTIONAL_FEATURE_KEYS = Object.freeze([
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
export const LAND_PREDICTION_FEATURE_KEYS = INSTITUTIONAL_FEATURE_KEYS;

export const STAGE_INTERACTION_FEATURES = Object.freeze([
  "local_council_member_stance",
]);

const KEY_ALIASES = new Map([
  ["application", "application_type"],
  ["application_type", "application_type"],
  ["stage", "procedural_stage"],
  ["procedural_stage", "procedural_stage"],
  ["community_board", "community_board_action"],
  ["community_board_recommendation", "community_board_action"],
  ["community_board_action", "community_board_action"],
  ["borough_president", "borough_president_action"],
  ["borough_president_recommendation", "borough_president_action"],
  ["borough_president_action", "borough_president_action"],
  ["cpc", "cpc_disposition"],
  ["cpc_action", "cpc_disposition"],
  ["cpc_recommendation", "cpc_recommendation"],
  ["cpc_disposition", "cpc_disposition"],
  ["cpc_vote", "cpc_vote"],
  ["member_stance", "local_council_member_stance"],
  ["council_member_stance", "local_council_member_stance"],
  ["local_council_member_stance", "local_council_member_stance"],
  ["council_subcommittee", "council_subcommittee_action"],
  ["council_subcommittee_action", "council_subcommittee_action"],
  ["land_use_committee", "land_use_committee_action"],
  ["land_use_committee_action", "land_use_committee_action"],
  ["modifications", "modifications_or_conditions"],
  ["conditions", "modifications_or_conditions"],
  ["negotiated_modifications", "modifications_or_conditions"],
  ["modifications_or_conditions", "modifications_or_conditions"],
]);

const VECTOR_FIELDS = new Set([
  "schema_version",
  "schema",
  "application_id",
  "prediction_as_of",
  "procedural_stage",
  "features",
  "stage_interactions",
  "historical_actors",
]);

const FEATURE_FIELDS = new Set([
  "key",
  "value",
  "state",
  "evidence_type",
  "observed_at",
  "effective_at",
  "source",
  "confidence",
  "evidence",
  "evidence_ids",
]);

const EVIDENCE_FIELDS = new Set([
  "evidence_id",
  "evidence_type",
  "observed_at",
  "effective_at",
  "source",
]);

const INTERACTION_FIELDS = new Set([
  "feature_key",
  "stage",
  "interaction_key",
  "estimation",
]);

function assertPlainObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
}

function assertExactFields(value, fields, label) {
  for (const key of Object.keys(value)) {
    if (!fields.has(key)) throw new TypeError(`${label} has unknown field ${key}`);
  }
}

function requiredText(value, label) {
  const text = String(value ?? "").trim();
  if (!text) throw new TypeError(`${label} is required`);
  return text;
}

function canonicalInstant(value, label, { required = false } = {}) {
  if (value === null || value === undefined || value === "") {
    if (required) throw new TypeError(`${label} is required`);
    return null;
  }
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) {
    throw new TypeError(`${label} must be an ISO timestamp`);
  }
  return new Date(value).toISOString();
}

function isJsonValue(value, seen = new WeakSet()) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (!value || typeof value !== "object" || seen.has(value)) return false;
  seen.add(value);
  if (Array.isArray(value)) return value.every((item) => isJsonValue(item, seen));
  return Object.entries(value).every(([key, child]) => typeof key === "string" && isJsonValue(child, seen));
}

function canonicalJson(value) {
  if (Array.isArray(value)) return value.map(canonicalJson);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value).sort().map((key) => [key, canonicalJson(value[key])]),
    );
  }
  return value;
}

function stableStringify(value) {
  return JSON.stringify(canonicalJson(value));
}

function canonicalKey(value, label = "feature key") {
  const key = requiredText(value, label).toLowerCase().replaceAll("-", "_").replaceAll(" ", "_");
  return KEY_ALIASES.get(key) || key;
}

function confidence(value, label) {
  if (value === null || value === undefined || value === "") return null;
  const result = Number(value);
  if (!Number.isFinite(result) || result < 0 || result > 1) {
    throw new TypeError(`${label} must be between 0 and 1`);
  }
  return result;
}

function featureState(value, state) {
  const explicit = state === null || state === undefined || state === ""
    ? null
    : String(state).trim().toLowerCase().replaceAll("-", "_");
  if (explicit && !FEATURE_STATES.includes(explicit)) {
    throw new TypeError(`unsupported feature state: ${state}`);
  }
  if (explicit) return explicit;
  if (value === null || value === undefined || value === "unknown") return "unknown";
  if (value === "no_known_position" || value === "no-known-position") return "no_known_position";
  if (value === "mixed_or_unclear") return "neutral_mixed";
  return "known";
}

function sourceFor(value, label) {
  if (value === null || value === undefined) return null;
  if ((typeof value !== "string" && (typeof value !== "object" || Array.isArray(value)))
      || (typeof value === "string" && !value.trim())
      || !isJsonValue(value)) {
    throw new TypeError(`${label} must be a non-empty string or JSON object`);
  }
  return canonicalJson(value);
}

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

function featureEvidence(feature) {
  if (feature.state === "unknown" || !feature.source) return [];
  return [{
    evidence_id: sourceEvidenceId(feature.source),
    evidence_type: feature.evidence_type,
    observed_at: feature.observed_at,
    effective_at: feature.effective_at,
    source: feature.source,
  }];
}

function sourceEvidenceId(source) {
  if (!source || typeof source !== "object" || Array.isArray(source)) return null;
  const value = source.evidence_id ?? source.evidenceId ?? source.source_record_id ?? source.record_id;
  return value === null || value === undefined || value === "" ? null : String(value);
}

function normalizeSnapshotFeature(feature, cutoff) {
  const key = canonicalKey(feature.key, "snapshot feature.key");
  const state = featureState(feature.value, feature.state);
  const observedAt = canonicalInstant(feature.observed_at, `feature ${key}.observed_at`);
  const effectiveAt = canonicalInstant(feature.effective_at, `feature ${key}.effective_at`);
  const availableAt = observedAt || effectiveAt;
  if (availableAt && Date.parse(availableAt) > Date.parse(cutoff)) {
    throw new TypeError(`feature ${key} is after prediction_as_of`);
  }
  if (state !== "unknown" && !feature.source) {
    throw new TypeError(`feature ${key}.source is required when state is ${state}`);
  }
  const normalized = {
    key,
    value: state === "unknown" || state === "no_known_position" ? null : canonicalJson(feature.value),
    state,
    evidence_type: requiredText(feature.evidence_type, `feature ${key}.evidence_type`),
    observed_at: observedAt,
    effective_at: effectiveAt,
    source: sourceFor(feature.source, `feature ${key}.source`),
    confidence: confidence(feature.confidence, `feature ${key}.confidence`),
  };
  const evidence = Array.isArray(feature.evidence) ? feature.evidence.map((row) => canonicalJson(row)) : featureEvidence(normalized);
  return {
    ...normalized,
    evidence,
    evidence_ids: [...new Set([
      ...(Array.isArray(feature.evidence_ids) ? feature.evidence_ids.map(String) : []),
      ...evidence.map((row) => row?.evidence_id).filter(Boolean),
    ])].sort(),
  };
}

function stanceFeature(record, cutoff, applicationId) {
  if (!record) return unknownFeature("local_council_member_stance");
  if (record.application_id !== applicationId) {
    throw new TypeError("member stance application_id mismatch");
  }
  if (record.as_of !== cutoff) throw new TypeError("member stance as_of must equal prediction_as_of");
  const selectedIds = new Set(record.resolution.selected_evidence_ids);
  const selected = record.evidence.filter((row) => selectedIds.has(row.evidence_id));
  const direction = record.resolution.direction;
  const state = direction === "unknown"
    ? "unknown"
    : direction === "mixed_or_unclear" ? "neutral_mixed" : "known";
  if (!selected.length || state === "unknown") {
    return {
      ...unknownFeature("local_council_member_stance"),
      evidence: selected.map(stanceEvidence),
      evidence_ids: selected.map((row) => row.evidence_id).sort(),
      evidence_type: selected.length ? "stance_resolution_unknown" : "no_stance_evidence_at_cutoff",
    };
  }
  const latestObserved = selected.map((row) => row.observed_at).sort().at(-1) || null;
  const latestEffective = selected.map((row) => row.effective_at || row.observed_at).sort().at(-1) || null;
  return {
    key: "local_council_member_stance",
    value: direction,
    state,
    evidence_type: selected.length === 1 ? selected[0].evidence_type : "stance_resolution",
    observed_at: latestObserved,
    effective_at: latestEffective,
    source: {
      contract: LAND_PREDICTION_MEMBER_STANCE_SCHEMA,
      application_id: record.application_id,
      member_id: record.member_id,
      evidence_ids: selected.map((row) => row.evidence_id).sort(),
    },
    confidence: record.resolution.confidence,
    evidence: selected.map(stanceEvidence),
    evidence_ids: selected.map((row) => row.evidence_id).sort(),
  };
}

function stanceEvidence(row) {
  return {
    evidence_id: row.evidence_id,
    evidence_type: row.evidence_type,
    observed_at: row.observed_at,
    effective_at: row.effective_at,
    source: row.source,
  };
}

function scalarSignalRows(signals = {}) {
  assertPlainObject(signals, "signals");
  return Object.entries(signals).flatMap(([rawKey, rawValue]) => {
    const key = canonicalKey(rawKey, "signal key");
    const rows = Array.isArray(rawValue) ? rawValue : [rawValue];
    return rows.map((row) => {
      if (row && typeof row === "object" && !Array.isArray(row)) {
        return { ...row, key: row.key ?? row.name ?? key };
      }
      return { key, value: row };
    });
  });
}

function snapshotForInput(input) {
  const supplied = input.snapshot || input.temporal_snapshot || input.land_prediction_snapshot;
  if (supplied) {
    const snapshot = validateLandPredictionSnapshot(supplied);
    if (input.application_id && String(input.application_id).trim() !== snapshot.application_id) {
      throw new TypeError("snapshot application_id does not match feature-vector input");
    }
    if (input.prediction_as_of && canonicalInstant(input.prediction_as_of, "prediction_as_of", { required: true }) !== snapshot.prediction_as_of) {
      throw new TypeError("snapshot prediction_as_of does not match feature-vector input");
    }
    if (input.procedural_stage && String(input.procedural_stage).trim() !== snapshot.procedural_stage) {
      throw new TypeError("snapshot procedural_stage does not match feature-vector input");
    }
    return snapshot;
  }

  const signals = {
    ...(input.formal_process || {}),
    ...(input.signals || {}),
  };
  if (input.application_type !== undefined) signals.application_type = input.application_type;
  if (input.stage_evidence !== undefined) signals.procedural_stage = input.stage_evidence;
  return buildLandPredictionSnapshot({
    application_id: input.application_id,
    prediction_as_of: input.prediction_as_of,
    procedural_stage: input.procedural_stage,
    features: [
      ...(Array.isArray(input.features) ? input.features : []),
      ...scalarSignalRows(signals),
    ],
    historical_actors: input.historical_actors || [],
  });
}

function snapshotStageFeature(snapshot) {
  const existing = snapshot.features.find((feature) => canonicalKey(feature.key) === "procedural_stage");
  if (existing) return normalizeSnapshotFeature(existing, snapshot.prediction_as_of);
  return {
    key: "procedural_stage",
    value: snapshot.procedural_stage,
    state: "known",
    evidence_type: "snapshot_procedural_stage",
    observed_at: null,
    effective_at: snapshot.prediction_as_of,
    source: {
      contract: LAND_PREDICTION_SNAPSHOT_SCHEMA,
      application_id: snapshot.application_id,
      prediction_as_of: snapshot.prediction_as_of,
      field: "procedural_stage",
    },
    confidence: null,
    evidence: [{
      evidence_id: `${snapshot.application_id}:procedural_stage:${snapshot.prediction_as_of}`,
      evidence_type: "snapshot_procedural_stage",
      observed_at: null,
      effective_at: snapshot.prediction_as_of,
      source: {
        contract: LAND_PREDICTION_SNAPSHOT_SCHEMA,
        application_id: snapshot.application_id,
        prediction_as_of: snapshot.prediction_as_of,
        field: "procedural_stage",
      },
    }],
    evidence_ids: [`${snapshot.application_id}:procedural_stage:${snapshot.prediction_as_of}`],
  };
}

function sortFeatures(features) {
  return [...features].sort((left, right) =>
    left.key.localeCompare(right.key) || stableStringify(left).localeCompare(stableStringify(right)));
}

function normalizeInteraction(interaction) {
  assertPlainObject(interaction, "stage interaction");
  assertExactFields(interaction, INTERACTION_FIELDS, "stage interaction");
  for (const field of INTERACTION_FIELDS) {
    if (!Object.hasOwn(interaction, field)) throw new TypeError(`stage interaction missing: ${field}`);
  }
  const featureKey = canonicalKey(interaction.feature_key, "stage interaction.feature_key");
  const stage = requiredText(interaction.stage, "stage interaction.stage");
  if (!STAGE_INTERACTION_FEATURES.includes(featureKey)) {
    throw new TypeError(`unsupported stage interaction feature: ${featureKey}`);
  }
  if (!requiredText(interaction.estimation, "stage interaction.estimation").includes("learnable")) {
    throw new TypeError("stage interaction must be learnable metadata");
  }
  const interactionKey = requiredText(interaction.interaction_key, "stage interaction.interaction_key");
  if (interactionKey !== `${featureKey}@${stage}`) {
    throw new TypeError("stage interaction key is not deterministic");
  }
  return { feature_key: featureKey, stage, interaction_key: interactionKey, estimation: interaction.estimation };
}

function validateFeature(feature, cutoff) {
  assertPlainObject(feature, "feature-vector feature");
  assertExactFields(feature, FEATURE_FIELDS, "feature-vector feature");
  for (const field of FEATURE_FIELDS) {
    if (!Object.hasOwn(feature, field)) throw new TypeError(`feature-vector feature missing: ${field}`);
  }
  const key = canonicalKey(feature.key, "feature-vector feature.key");
  const state = featureState(feature.value, feature.state);
  if (state !== feature.state) throw new TypeError(`feature ${key} state is not canonical`);
  if ((state === "unknown" || state === "no_known_position") && feature.value !== null) {
    throw new TypeError(`${state} must not carry a substantive value`);
  }
  if (state === "neutral_mixed"
      && (feature.value === null || feature.value === "unknown" || feature.value === "no_known_position")) {
    throw new TypeError("neutral_mixed must carry a substantive value");
  }
  if (state === "known"
      && (feature.value === "unknown" || feature.value === "no_known_position" || feature.value === "no-known-position")) {
    throw new TypeError("unknown and no_known_position must not be encoded as known values");
  }
  if (!isJsonValue(feature.value)) throw new TypeError(`feature ${key} value must be JSON data`);
  sourceFor(feature.source, `feature ${key}.source`);
  if (state !== "unknown" && !feature.source) throw new TypeError(`feature ${key} lacks evidence source`);
  if (!Array.isArray(feature.evidence) || !Array.isArray(feature.evidence_ids)) {
    throw new TypeError(`feature ${key} evidence trace must be arrays`);
  }
  if (state !== "unknown" && feature.evidence.length === 0) {
    throw new TypeError(`feature ${key} must have an evidence trace`);
  }
  for (const row of feature.evidence) {
    assertPlainObject(row, `feature ${key} evidence`);
    assertExactFields(row, EVIDENCE_FIELDS, `feature ${key} evidence`);
    if (!row.source) throw new TypeError(`feature ${key} evidence source is required`);
    requiredText(row.evidence_type, `feature ${key} evidence.evidence_type`);
    sourceFor(row.source, `feature ${key} evidence.source`);
    const observedAt = canonicalInstant(row.observed_at, `feature ${key} evidence.observed_at`);
    const effectiveAt = canonicalInstant(row.effective_at, `feature ${key} evidence.effective_at`);
    const availableAt = observedAt || effectiveAt;
    if (availableAt && Date.parse(availableAt) > Date.parse(cutoff)) {
      throw new TypeError(`feature ${key} evidence is after prediction_as_of`);
    }
  }
  const expectedIds = feature.evidence.map((row) => row.evidence_id).filter(Boolean).map(String).sort();
  if (JSON.stringify(expectedIds) !== JSON.stringify([...feature.evidence_ids].map(String).sort())) {
    throw new TypeError(`feature ${key} evidence_ids do not match evidence trace`);
  }
  return feature;
}

/** Validate a stage-aware vector without adding or dropping evidence. */
export function validateLandPredictionFeatureVector(vector) {
  assertPlainObject(vector, "land prediction feature vector");
  assertExactFields(vector, VECTOR_FIELDS, "land prediction feature vector");
  for (const field of VECTOR_FIELDS) {
    if (!Object.hasOwn(vector, field)) throw new TypeError(`land prediction feature vector missing: ${field}`);
  }
  if (vector.schema_version !== LAND_PREDICTION_FEATURE_VECTOR_VERSION) {
    throw new TypeError(`unsupported feature vector schema_version: ${vector.schema_version}`);
  }
  if (vector.schema !== LAND_PREDICTION_FEATURE_VECTOR_SCHEMA) {
    throw new TypeError(`unsupported feature vector schema: ${vector.schema}`);
  }
  const applicationId = requiredText(vector.application_id, "application_id");
  const cutoff = canonicalInstant(vector.prediction_as_of, "prediction_as_of", { required: true });
  const stage = requiredText(vector.procedural_stage, "procedural_stage");
  if (!Array.isArray(vector.features)) throw new TypeError("features must be an array");
  if (!Array.isArray(vector.stage_interactions)) throw new TypeError("stage_interactions must be an array");
  if (!Array.isArray(vector.historical_actors)) throw new TypeError("historical_actors must be an array");
  const features = vector.features.map((feature) => validateFeature(feature, cutoff));
  const keys = new Set(features.map((feature) => feature.key));
  for (const key of INSTITUTIONAL_FEATURE_KEYS) {
    if (!keys.has(key)) throw new TypeError(`feature vector missing institutional feature: ${key}`);
  }
  const interactions = vector.stage_interactions.map((interaction) => normalizeInteraction(interaction));
  if (!interactions.some((interaction) =>
    interaction.feature_key === "local_council_member_stance" && interaction.stage === stage)) {
    throw new TypeError("feature vector missing local-member stage interaction");
  }
  return {
    schema_version: LAND_PREDICTION_FEATURE_VECTOR_VERSION,
    schema: LAND_PREDICTION_FEATURE_VECTOR_SCHEMA,
    application_id: applicationId,
    prediction_as_of: cutoff,
    procedural_stage: stage,
    features,
    stage_interactions: interactions,
    historical_actors: vector.historical_actors,
  };
}

/**
 * Build the common institutional feature layer from a C2 snapshot and, when
 * present, a validated C4 project-specific stance record.
 *
 * The builder always emits every institutional key. Missing observations are
 * explicit `unknown` rows, so sparse applications remain valid snapshots.
 */
export function buildLandPredictionFeatureVector(input = {}) {
  assertPlainObject(input, "land prediction feature vector input");
  const snapshot = snapshotForInput(input);
  const stance = input.member_stance || input.local_council_member_stance || null;
  const validatedStance = stance ? validateLandMemberStance(stance) : null;
  if (validatedStance) {
    if (validatedStance.application_id !== snapshot.application_id) {
      throw new TypeError("member stance application_id does not match snapshot");
    }
    if (validatedStance.as_of !== snapshot.prediction_as_of) {
      throw new TypeError("member stance as_of does not match snapshot prediction_as_of");
    }
  }

  const features = [];
  const supplied = snapshot.features.map((feature) => normalizeSnapshotFeature(feature, snapshot.prediction_as_of));
  const stageFeature = snapshotStageFeature(snapshot);
  const seen = new Set();
  for (const feature of [...supplied, stageFeature]) {
    if (feature.key === "procedural_stage" && seen.has(feature.key)) continue;
    features.push(feature);
    seen.add(feature.key);
  }
  if (validatedStance) features.push(stanceFeature(
    validatedStance,
    snapshot.prediction_as_of,
    snapshot.application_id,
  ));
  for (const key of INSTITUTIONAL_FEATURE_KEYS) {
    if (!seen.has(key) && !features.some((feature) => feature.key === key)) features.push(unknownFeature(key));
  }

  const stageInteractions = STAGE_INTERACTION_FEATURES.map((featureKey) => ({
    feature_key: featureKey,
    stage: snapshot.procedural_stage,
    interaction_key: `${featureKey}@${snapshot.procedural_stage}`,
    estimation: "learnable_stage_interaction",
  }));
  return validateLandPredictionFeatureVector({
    schema_version: LAND_PREDICTION_FEATURE_VECTOR_VERSION,
    schema: LAND_PREDICTION_FEATURE_VECTOR_SCHEMA,
    application_id: snapshot.application_id,
    prediction_as_of: snapshot.prediction_as_of,
    procedural_stage: snapshot.procedural_stage,
    features: sortFeatures(features),
    stage_interactions: stageInteractions,
    historical_actors: snapshot.historical_actors,
  });
}

export const buildStageAwareInstitutionalFeatureVector = buildLandPredictionFeatureVector;
export const validateStageAwareInstitutionalFeatureVector = validateLandPredictionFeatureVector;
