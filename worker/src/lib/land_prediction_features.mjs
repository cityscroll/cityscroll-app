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
import {
  LAND_PREDICTION_ACTOR_RESOLUTION_SCHEMA,
  resolveLandUseApplicationActors,
} from "./land_prediction_actor_resolution.mjs";
import {
  LAND_ULURP_PHASES,
  mapMilestoneToPhase,
} from "./land_phase_spine.mjs";
import {
  LAND_USE_ACTION_CODE_FAMILY,
  normalizeLandUseActionType,
} from "../../../site/land_use_action_type.mjs";
import {
  LAND_FAMILY_OPTIONS,
  LAND_STAGE_OPTIONS,
  landStageForRow,
} from "../../../site/land_status_facets.mjs";

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
  "cutoff",
  "identity",
  "relation",
  "observation",
]);

const LAND_PHASE_IDS = new Set(LAND_ULURP_PHASES);
const LAND_STAGE_IDS = new Set(LAND_STAGE_OPTIONS.map((option) => option.id));
const LAND_FAMILY_IDS = new Set(
  LAND_FAMILY_OPTIONS.map((option) => option.id).filter((id) => id !== "any"),
);
const STAGE_ALIASES = Object.freeze({
  council: "city_council",
  city_council: "city_council",
  citycouncil: "city_council",
  "city council": "city_council",
  cb: "community_board",
  communityboard: "community_board",
  "community board": "community_board",
  bp: "borough_president",
  boroughpresident: "borough_president",
  "borough president": "borough_president",
  mayor: "mayoral_appeals",
  mayoral_appeals: "mayoral_appeals",
  "mayoral appeals": "mayoral_appeals",
  "city planning": "cpc",
});

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

function compactToken(value) {
  return String(value ?? "").trim().toLowerCase().replaceAll("-", "_").replaceAll(/\s+/g, " ");
}

export function canonicalProceduralStage(value, landRow = null) {
  const raw = compactToken(value);
  if (raw && LAND_PHASE_IDS.has(raw)) return raw;
  if (raw && STAGE_ALIASES[raw] && LAND_PHASE_IDS.has(STAGE_ALIASES[raw])) return STAGE_ALIASES[raw];
  const underscored = raw.replaceAll(" ", "_");
  if (underscored && LAND_PHASE_IDS.has(underscored)) return underscored;
  if (underscored && STAGE_ALIASES[underscored] && LAND_PHASE_IDS.has(STAGE_ALIASES[underscored])) {
    return STAGE_ALIASES[underscored];
  }
  if (landRow && typeof landRow === "object" && !Array.isArray(landRow)) {
    const fromRow = landStageForRow(landRow);
    if (LAND_PHASE_IDS.has(fromRow) || LAND_STAGE_IDS.has(fromRow)) return fromRow;
  }
  if (raw && LAND_STAGE_IDS.has(raw)) return raw;
  if (raw) {
    const fromMilestone = mapMilestoneToPhase(value);
    const looksLikeMilestone = /referral|certified|disposition|hearing|review session|filed|withdrawn|terminated/i.test(String(value ?? ""));
    if (looksLikeMilestone && LAND_PHASE_IDS.has(fromMilestone)) return fromMilestone;
  }
  return requiredText(value, "procedural_stage");
}

export function canonicalApplicationType(value) {
  if (value === null || value === undefined || value === "") return value;
  if (typeof value === "string") {
    const code = value.trim().toUpperCase();
    if (Object.hasOwn(LAND_USE_ACTION_CODE_FAMILY, code)) return LAND_USE_ACTION_CODE_FAMILY[code];
    const family = compactToken(value).replaceAll(" ", "_");
    if (LAND_FAMILY_IDS.has(family)) return family;
    return value;
  }
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const type = normalizeLandUseActionType(value);
    if (type.families.length === 1) return type.families[0];
    if (type.families.length > 1) {
      return { codes: type.codes, families: type.families, primary: type.primary };
    }
  }
  return canonicalJson(value);
}

function identityFrom(source, fallback = null) {
  if (!source || typeof source !== "object" || Array.isArray(source)) return fallback;
  const value = source.identity ?? source.actor_id ?? source.member_id ?? source.official_id;
  return value === null || value === undefined || value === "" ? fallback : String(value);
}

function relationFrom(source, fallback = null) {
  if (!source || typeof source !== "object" || Array.isArray(source)) return fallback;
  const value = source.relation ?? source.relation_type ?? source.observation_kind;
  return value === null || value === undefined || value === "" ? fallback : String(value);
}

function observationFrom(source, fallback = null) {
  if (typeof source === "string" && source.trim()) return source.trim();
  if (!source || typeof source !== "object" || Array.isArray(source)) return fallback;
  const value = source.observation
    ?? source.observation_id
    ?? source.source_record_id
    ?? source.record_id
    ?? source.evidence_id;
  return value === null || value === undefined || value === "" ? fallback : String(value);
}

function localCouncilActors(actors = []) {
  return actors.filter((actor) => {
    const role = String(actor?.role ?? "");
    return role === "local_council_member" || role.startsWith("local_council_member:");
  });
}

function resolvedLocalMemberIds(actors = []) {
  return new Set(
    localCouncilActors(actors)
      .filter((actor) => actor.resolution === "resolved" && actor.actor_id)
      .map((actor) => String(actor.actor_id)),
  );
}

function evidenceTrace(row, context) {
  const source = sourceFor(row.source, "evidence.source");
  return {
    evidence_id: row.evidence_id === null || row.evidence_id === undefined || row.evidence_id === ""
      ? null
      : String(row.evidence_id),
    evidence_type: requiredText(row.evidence_type, "evidence.evidence_type"),
    observed_at: canonicalInstant(row.observed_at, "evidence.observed_at"),
    effective_at: canonicalInstant(row.effective_at, "evidence.effective_at"),
    source,
    cutoff: context.cutoff,
    identity: identityFrom(row, identityFrom(source, context.identity ?? null)),
    relation: row.relation === null || row.relation === undefined || row.relation === ""
      ? relationFrom(source, context.relation ?? null)
      : String(row.relation),
    observation: row.observation === null || row.observation === undefined || row.observation === ""
      ? observationFrom(source, row.evidence_id == null ? context.observation ?? null : String(row.evidence_id))
      : String(row.observation),
  };
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

function featureEvidence(feature, context) {
  if (feature.state === "unknown" || !feature.source) return [];
  return [evidenceTrace({
    evidence_id: sourceEvidenceId(feature.source),
    evidence_type: feature.evidence_type,
    observed_at: feature.observed_at,
    effective_at: feature.effective_at,
    source: feature.source,
  }, context)];
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
  const rawValue = state === "unknown" || state === "no_known_position" ? null : canonicalJson(feature.value);
  const value = key === "application_type" && rawValue !== null
    ? canonicalApplicationType(rawValue)
    : key === "procedural_stage" && rawValue !== null
      ? canonicalProceduralStage(rawValue)
      : rawValue;
  const source = sourceFor(feature.source, `feature ${key}.source`);
  const normalized = {
    key,
    value,
    state,
    evidence_type: requiredText(feature.evidence_type, `feature ${key}.evidence_type`),
    observed_at: observedAt,
    effective_at: effectiveAt,
    source,
    confidence: confidence(feature.confidence, `feature ${key}.confidence`),
  };
  const context = {
    cutoff,
    identity: identityFrom(source),
    relation: relationFrom(source),
    observation: observationFrom(source),
  };
  const evidence = (Array.isArray(feature.evidence) ? feature.evidence : featureEvidence(normalized, context))
    .map((row) => evidenceTrace(row, context));
  return {
    ...normalized,
    evidence,
    evidence_ids: [...new Set([
      ...(Array.isArray(feature.evidence_ids) ? feature.evidence_ids.map(String) : []),
      ...evidence.map((row) => row?.evidence_id).filter(Boolean),
    ])].sort(),
  };
}

function stanceFeature(record, cutoff, applicationId, actors = []) {
  const locals = localCouncilActors(actors);
  const resolvedIds = resolvedLocalMemberIds(actors);
  const vacant = locals.length > 0 && locals.every((actor) => actor.resolution === "vacant");
  if (vacant) {
    return {
      ...unknownFeature("local_council_member_stance"),
      evidence_type: "historical_actor_vacant",
    };
  }
  if (!record) return unknownFeature("local_council_member_stance");
  if (record.application_id !== applicationId) {
    throw new TypeError("member stance application_id mismatch");
  }
  if (record.as_of !== cutoff) throw new TypeError("member stance as_of must equal prediction_as_of");
  if (resolvedIds.size && !resolvedIds.has(record.member_id)) {
    return {
      ...unknownFeature("local_council_member_stance"),
      evidence_type: "historical_actor_identity_mismatch",
    };
  }
  const selectedIds = new Set(record.resolution.selected_evidence_ids);
  const selected = record.evidence.filter((row) => selectedIds.has(row.evidence_id));
  const direction = record.resolution.direction;
  const state = direction === "unknown"
    ? "unknown"
    : direction === "mixed_or_unclear" ? "neutral_mixed" : "known";
  const context = {
    cutoff,
    identity: record.member_id,
    relation: "local_council_member_stance",
  };
  if (!selected.length || state === "unknown") {
    return {
      ...unknownFeature("local_council_member_stance"),
      evidence: selected.map((row) => stanceEvidence(row, context)),
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
      identity: record.member_id,
      evidence_ids: selected.map((row) => row.evidence_id).sort(),
    },
    confidence: record.resolution.confidence,
    evidence: selected.map((row) => stanceEvidence(row, context)),
    evidence_ids: selected.map((row) => row.evidence_id).sort(),
  };
}

function stanceEvidence(row, context) {
  return evidenceTrace({
    evidence_id: row.evidence_id,
    evidence_type: row.evidence_type,
    observed_at: row.observed_at,
    effective_at: row.effective_at,
    source: row.source,
    identity: row.member_id,
    relation: "local_council_member_stance",
    observation: row.evidence_id,
  }, context);
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
    if (input.procedural_stage
        && canonicalProceduralStage(input.procedural_stage, input.land_row)
          !== canonicalProceduralStage(snapshot.procedural_stage, input.land_row)) {
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

function snapshotStageFeature(snapshot, landRow = null) {
  const existing = snapshot.features.find((feature) => canonicalKey(feature.key) === "procedural_stage");
  if (existing) {
    const normalized = normalizeSnapshotFeature(existing, snapshot.prediction_as_of);
    return {
      ...normalized,
      value: canonicalProceduralStage(normalized.value ?? snapshot.procedural_stage, landRow),
    };
  }
  const stage = canonicalProceduralStage(snapshot.procedural_stage, landRow);
  const source = {
    contract: LAND_PREDICTION_SNAPSHOT_SCHEMA,
    application_id: snapshot.application_id,
    prediction_as_of: snapshot.prediction_as_of,
    field: "procedural_stage",
  };
  const evidenceId = `${snapshot.application_id}:procedural_stage:${snapshot.prediction_as_of}`;
  return {
    key: "procedural_stage",
    value: stage,
    state: "known",
    evidence_type: "snapshot_procedural_stage",
    observed_at: null,
    effective_at: snapshot.prediction_as_of,
    source,
    confidence: null,
    evidence: [evidenceTrace({
      evidence_id: evidenceId,
      evidence_type: "snapshot_procedural_stage",
      observed_at: null,
      effective_at: snapshot.prediction_as_of,
      source,
      relation: "procedural_stage",
      observation: evidenceId,
    }, { cutoff: snapshot.prediction_as_of })],
    evidence_ids: [evidenceId],
  };
}

function actorResolutionForInput(input, snapshot) {
  const supplied = input.actor_resolution || input.historical_actor_resolution || null;
  if (supplied) {
    assertPlainObject(supplied, "actor_resolution");
    if (supplied.schema !== LAND_PREDICTION_ACTOR_RESOLUTION_SCHEMA) {
      throw new TypeError("actor_resolution schema mismatch");
    }
    if (String(supplied.application_id).trim() !== snapshot.application_id) {
      throw new TypeError("actor_resolution application_id does not match snapshot");
    }
    if (canonicalInstant(supplied.prediction_as_of, "actor_resolution.prediction_as_of", { required: true })
        !== snapshot.prediction_as_of) {
      throw new TypeError("actor_resolution prediction_as_of does not match snapshot");
    }
    if (!Array.isArray(supplied.historical_actors)) {
      throw new TypeError("actor_resolution.historical_actors must be an array");
    }
    return supplied;
  }
  const application = input.application || input.actor_resolution_application || null;
  const options = input.actor_resolution_options || null;
  if (!application && !options) return null;
  return resolveLandUseApplicationActors(application || {
    application_id: snapshot.application_id,
    prediction_as_of: snapshot.prediction_as_of,
  }, {
    prediction_as_of: snapshot.prediction_as_of,
    ...(options || {}),
    boundaries: options?.boundaries || input.boundaries,
    personHub: options?.personHub || options?.person_hub || input.personHub || input.person_hub,
  });
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
    for (const field of EVIDENCE_FIELDS) {
      if (!Object.hasOwn(row, field)) throw new TypeError(`feature ${key} evidence missing: ${field}`);
    }
    if (!row.source) throw new TypeError(`feature ${key} evidence source is required`);
    requiredText(row.evidence_type, `feature ${key} evidence.evidence_type`);
    sourceFor(row.source, `feature ${key} evidence.source`);
    if (row.cutoff !== cutoff) {
      throw new TypeError(`feature ${key} evidence cutoff must equal prediction_as_of`);
    }
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
  const stage = canonicalProceduralStage(vector.procedural_stage);
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
  const stage = canonicalProceduralStage(snapshot.procedural_stage, input.land_row);
  const actorResolution = actorResolutionForInput(input, snapshot);
  const historicalActors = actorResolution?.historical_actors ?? snapshot.historical_actors;
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
  const stageFeature = snapshotStageFeature(snapshot, input.land_row);
  const seen = new Set();
  for (const feature of [...supplied, stageFeature]) {
    if (feature.key === "procedural_stage" && seen.has(feature.key)) continue;
    features.push(feature);
    seen.add(feature.key);
  }
  if (validatedStance || vacantOrResolvedActors(historicalActors)) {
    features.push(stanceFeature(
      validatedStance,
      snapshot.prediction_as_of,
      snapshot.application_id,
      historicalActors,
    ));
  }
  for (const key of INSTITUTIONAL_FEATURE_KEYS) {
    if (!seen.has(key) && !features.some((feature) => feature.key === key)) features.push(unknownFeature(key));
  }

  const stageInteractions = STAGE_INTERACTION_FEATURES.map((featureKey) => ({
    feature_key: featureKey,
    stage,
    interaction_key: `${featureKey}@${stage}`,
    estimation: "learnable_stage_interaction",
  }));
  return validateLandPredictionFeatureVector({
    schema_version: LAND_PREDICTION_FEATURE_VECTOR_VERSION,
    schema: LAND_PREDICTION_FEATURE_VECTOR_SCHEMA,
    application_id: snapshot.application_id,
    prediction_as_of: snapshot.prediction_as_of,
    procedural_stage: stage,
    features: sortFeatures(features),
    stage_interactions: stageInteractions,
    historical_actors: historicalActors,
  });
}

function vacantOrResolvedActors(actors) {
  const locals = localCouncilActors(actors);
  return locals.some((actor) => actor.resolution === "vacant" || actor.resolution === "resolved");
}

export const buildStageAwareInstitutionalFeatureVector = buildLandPredictionFeatureVector;
export const validateStageAwareInstitutionalFeatureVector = validateLandPredictionFeatureVector;
