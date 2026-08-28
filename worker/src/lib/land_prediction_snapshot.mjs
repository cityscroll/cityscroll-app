// Temporal input contract for Land-Use Prediction v2.
//
// This module deliberately stops at a reproducible, source-preserving
// snapshot. It does not calculate a prediction, infer a stance, or construct
// a feature vector. Later cards consume this narrow waist.

export const LAND_PREDICTION_SNAPSHOT_SCHEMA = "cityscroll.land_prediction_snapshot.v1";
export const LAND_PREDICTION_SNAPSHOT_VERSION = 1;

export const FEATURE_STATES = Object.freeze([
  "known",
  "unknown",
  "no_known_position",
  "neutral_mixed",
]);

export const ACTOR_RESOLUTION_STATES = Object.freeze([
  "resolved",
  "unknown",
  "vacant",
]);

const SNAPSHOT_FIELDS = new Set([
  "schema_version",
  "application_id",
  "prediction_as_of",
  "procedural_stage",
  "features",
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
]);

const ACTOR_FIELDS = new Set([
  "role",
  "actor_id",
  "resolution",
  "as_of",
  "observed_at",
  "effective_at",
  "source",
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

function assertRequiredFields(value, fields, label) {
  const missing = [...fields].filter((key) => !Object.hasOwn(value, key));
  if (missing.length) throw new TypeError(`${label} missing: ${missing.join(", ")}`);
}

function requiredText(value, label) {
  const text = String(value ?? "").trim();
  if (!text) throw new TypeError(`${label} is required`);
  return text;
}

function isJsonValue(value, seen = new WeakSet()) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value !== "object") return false;
  if (seen.has(value)) return false;
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

function canonicalInstant(value, label, { allowNull = true } = {}) {
  if (value === null || value === undefined || value === "") {
    if (allowNull) return null;
    throw new TypeError(`${label} is required`);
  }
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) {
    throw new TypeError(`${label} must be an ISO timestamp`);
  }
  return new Date(value).toISOString();
}

function canonicalSource(value, label) {
  if (value === null || value === undefined) return null;
  if ((typeof value !== "string" && (typeof value !== "object" || Array.isArray(value)))
      || (typeof value === "string" && !value.trim())
      || !isJsonValue(value)) {
    throw new TypeError(`${label} must be a non-empty string, JSON object, or null`);
  }
  return canonicalJson(value);
}

function normalizedState(feature) {
  const explicit = feature.state === undefined || feature.state === null
    ? null
    : String(feature.state).trim().toLowerCase().replaceAll("-", "_");
  if (explicit && !FEATURE_STATES.includes(explicit)) {
    throw new TypeError(`unsupported feature state: ${feature.state}`);
  }
  if (explicit) return explicit;
  if (feature.value === "unknown") return "unknown";
  if (feature.value === "no_known_position") return "no_known_position";
  if (feature.value === "no-known-position") return "no_known_position";
  if (feature.value === "neutral_mixed" || feature.value === "mixed_or_unclear") {
    return "neutral_mixed";
  }
  if (feature.value === null || feature.value === undefined) return "unknown";
  return "known";
}

function featureValue(feature, state) {
  if (state === "unknown" || state === "no_known_position") {
    const missingValues = new Set([null, undefined, "unknown", "no_known_position", "no-known-position"]);
    if (!missingValues.has(feature.value)) {
      throw new TypeError(`${state} must not carry a substantive value`);
    }
    return null;
  }
  if (feature.value === undefined) throw new TypeError(`feature ${feature.key} value is required`);
  if (!isJsonValue(feature.value)) throw new TypeError(`feature ${feature.key} value must be JSON data`);
  if (state === "neutral_mixed"
      && (feature.value === null || feature.value === "unknown" || feature.value === "no_known_position")) {
    throw new TypeError("neutral_mixed must carry a substantive value, not unknown or no_known_position");
  }
  if (state === "known"
      && (feature.value === "unknown" || feature.value === "no_known_position" || feature.value === "no-known-position")) {
    throw new TypeError("unknown and no_known_position must not be encoded as known values");
  }
  return canonicalJson(feature.value);
}

function featureStateDefaults(state) {
  if (state === "unknown") return { evidence_type: "unknown" };
  if (state === "no_known_position") return { evidence_type: "no_known_position" };
  if (state === "neutral_mixed") return { evidence_type: "substantive_neutral_mixed" };
  return { evidence_type: "observed" };
}

function normalizeFeature(feature, cutoff) {
  assertPlainObject(feature, "feature");
  const key = requiredText(feature.key ?? feature.name, "feature.key");
  const state = normalizedState(feature);
  const defaults = featureStateDefaults(state);
  const observedAt = canonicalInstant(feature.observed_at, `feature ${key}.observed_at`);
  const effectiveAt = canonicalInstant(feature.effective_at, `feature ${key}.effective_at`);
  const source = canonicalSource(feature.source, `feature ${key}.source`);
  const evidenceType = requiredText(feature.evidence_type ?? defaults.evidence_type, `feature ${key}.evidence_type`);
  const confidence = feature.confidence === undefined || feature.confidence === null
    ? null
    : Number(feature.confidence);

  if (confidence !== null && (!Number.isFinite(confidence) || confidence < 0 || confidence > 1)) {
    throw new TypeError(`feature ${key}.confidence must be between 0 and 1`);
  }
  if (state === "known" || state === "no_known_position" || state === "neutral_mixed") {
    if (!observedAt && !effectiveAt) {
      throw new TypeError(`feature ${key} needs observed_at or effective_at when state is ${state}`);
    }
    if (!source) throw new TypeError(`feature ${key}.source is required when state is ${state}`);
  }

  // observed_at is the availability clock. If a source has no observation
  // clock, effective_at is the conservative first-available clock. A future
  // effective date is allowed when the source was observed before the cutoff:
  // a published schedule can describe a future event without being hindsight.
  const availableAt = observedAt || effectiveAt;
  if (availableAt && Date.parse(availableAt) > Date.parse(cutoff)) return null;

  return {
    key,
    value: featureValue(feature, state),
    state,
    evidence_type: evidenceType,
    observed_at: observedAt,
    effective_at: effectiveAt,
    source,
    confidence,
  };
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
  };
}

function normalizeActor(actor, cutoff, resolver) {
  assertPlainObject(actor, "historical actor");
  const role = requiredText(actor.role, "historical actor.role");
  const request = {
    ...canonicalJson(actor),
    role,
    as_of: cutoff,
  };
  let resolved = null;
  if (typeof resolver === "function") {
    resolved = resolver(request);
    if (resolved !== null && resolved !== undefined) assertPlainObject(resolved, "resolved historical actor");
  }
  const candidate = resolved || {};
  const observedAt = canonicalInstant(candidate.observed_at ?? actor.observed_at, `historical actor ${role}.observed_at`);
  const effectiveAt = canonicalInstant(candidate.effective_at ?? actor.effective_at, `historical actor ${role}.effective_at`);
  const source = canonicalSource(candidate.source ?? actor.source, `historical actor ${role}.source`);
  const availableAt = observedAt || effectiveAt;
  const inScope = !availableAt || Date.parse(availableAt) <= Date.parse(cutoff);
  const resolution = inScope
    ? String(candidate.resolution ?? actor.resolution ?? "unknown").trim().toLowerCase()
    : "unknown";
  if (!ACTOR_RESOLUTION_STATES.includes(resolution)) {
    throw new TypeError(`unsupported historical actor resolution: ${resolution}`);
  }
  const actorId = inScope && resolution === "resolved"
    ? requiredText(candidate.actor_id ?? candidate.identity ?? actor.actor_id ?? actor.identity, `historical actor ${role}.actor_id`)
    : null;
  if (resolution === "resolved" && !source) {
    throw new TypeError(`historical actor ${role}.source is required when resolved`);
  }
  return {
    role,
    actor_id: actorId,
    resolution,
    as_of: cutoff,
    observed_at: inScope ? observedAt : null,
    effective_at: inScope ? effectiveAt : null,
    source: inScope ? source : null,
  };
}

function validateFeature(feature, cutoff) {
  assertPlainObject(feature, "snapshot feature");
  assertExactFields(feature, FEATURE_FIELDS, "snapshot feature");
  assertRequiredFields(feature, FEATURE_FIELDS, "snapshot feature");
  const normalized = normalizeFeature(feature, cutoff);
  if (!normalized) throw new TypeError(`snapshot feature ${feature.key} is after prediction_as_of`);
  return normalized;
}

function validateActor(actor, cutoff) {
  assertPlainObject(actor, "snapshot historical actor");
  assertExactFields(actor, ACTOR_FIELDS, "snapshot historical actor");
  assertRequiredFields(actor, ACTOR_FIELDS, "snapshot historical actor");
  const normalized = normalizeActor(actor, cutoff, null);
  if (normalized.as_of !== cutoff) throw new TypeError("historical actor as_of must equal prediction_as_of");
  return normalized;
}

/** Validate a snapshot without changing its representation. */
export function validateLandPredictionSnapshot(snapshot) {
  assertPlainObject(snapshot, "land prediction snapshot");
  assertExactFields(snapshot, SNAPSHOT_FIELDS, "land prediction snapshot");
  assertRequiredFields(snapshot, SNAPSHOT_FIELDS, "land prediction snapshot");
  if (snapshot.schema_version !== LAND_PREDICTION_SNAPSHOT_VERSION) {
    throw new TypeError(`unsupported snapshot schema_version: ${snapshot.schema_version}`);
  }
  requiredText(snapshot.application_id, "application_id");
  const cutoff = canonicalInstant(snapshot.prediction_as_of, "prediction_as_of", { allowNull: false });
  requiredText(snapshot.procedural_stage, "procedural_stage");
  if (!Array.isArray(snapshot.features)) throw new TypeError("features must be an array");
  if (!Array.isArray(snapshot.historical_actors)) throw new TypeError("historical_actors must be an array");

  const features = snapshot.features.map((feature) => validateFeature(feature, cutoff));
  const actors = snapshot.historical_actors.map((actor) => validateActor(actor, cutoff));
  return {
    schema_version: LAND_PREDICTION_SNAPSHOT_VERSION,
    application_id: String(snapshot.application_id).trim(),
    prediction_as_of: cutoff,
    procedural_stage: String(snapshot.procedural_stage).trim(),
    features,
    historical_actors: actors,
  };
}

/**
 * Build a deterministic snapshot from source observations.
 *
 * Evidence first available after the cutoff is omitted. If all observations
 * for a feature are omitted, the feature remains as explicit `unknown`; it is
 * never rewritten as `no_known_position` or `neutral_mixed`.
 */
export function buildLandPredictionSnapshot(input = {}, options = {}) {
  assertPlainObject(input, "snapshot input");
  const applicationId = requiredText(input.application_id, "application_id");
  const cutoff = canonicalInstant(input.prediction_as_of, "prediction_as_of", { allowNull: false });
  const proceduralStage = requiredText(input.procedural_stage, "procedural_stage");
  const inputFeatures = input.features ?? [];
  if (!Array.isArray(inputFeatures)) throw new TypeError("features must be an array");
  if (!Array.isArray(input.historical_actors ?? [])) throw new TypeError("historical_actors must be an array");

  const byKey = new Map();
  for (const inputFeature of inputFeatures) {
    assertPlainObject(inputFeature, "feature");
    const key = requiredText(inputFeature.key ?? inputFeature.name, "feature.key");
    const normalized = normalizeFeature({ ...inputFeature, key }, cutoff);
    if (!byKey.has(key)) byKey.set(key, []);
    if (normalized) byKey.get(key).push(normalized);
  }
  const features = [...byKey.entries()]
    .flatMap(([key, rows]) => rows.length ? rows : [unknownFeature(key)])
    .sort((left, right) => left.key.localeCompare(right.key) || stableStringify(left).localeCompare(stableStringify(right)));

  const resolver = options.resolveHistoricalActor || options.actorResolver || null;
  const historicalActors = (input.historical_actors ?? [])
    .map((actor) => normalizeActor(actor, cutoff, resolver))
    .sort((left, right) => left.role.localeCompare(right.role)
      || String(left.actor_id ?? "").localeCompare(String(right.actor_id ?? ""))
      || stableStringify(left).localeCompare(stableStringify(right)));

  return validateLandPredictionSnapshot({
    schema_version: LAND_PREDICTION_SNAPSHOT_VERSION,
    application_id: applicationId,
    prediction_as_of: cutoff,
    procedural_stage: proceduralStage,
    features,
    historical_actors: historicalActors,
  });
}

/** Interface seam for Card 3; no current-officeholder fallback is permitted. */
export function resolveHistoricalActorAt(actor, predictionAsOf, resolver = null) {
  const cutoff = canonicalInstant(predictionAsOf, "prediction_as_of", { allowNull: false });
  return normalizeActor(actor, cutoff, resolver);
}
