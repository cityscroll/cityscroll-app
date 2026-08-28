// Project-specific Council member stance for Land-Use Prediction v2.
//
// This is an evidence contract and deterministic projection, not a political
// score. It accepts only application-specific observations from the bounded
// source families below. Party, ideology, demographics, endorsements, and
// generalized housing views are intentionally not representable.

export const LAND_PREDICTION_MEMBER_STANCE_SCHEMA = "cityscroll.land_prediction_member_stance.v1";
export const LAND_MEMBER_STANCE_SCHEMA = LAND_PREDICTION_MEMBER_STANCE_SCHEMA;
export const LAND_MEMBER_STANCE_VERSION = 1;

export const STANCE_DIRECTIONS = Object.freeze([
  "support",
  "oppose",
  "conditional",
  "mixed_or_unclear",
  "unknown",
]);

export const STANCE_EVIDENCE_TYPES = Object.freeze([
  "direct_public_statement",
  "hearing_or_meeting_remarks",
  "requested_project_modification",
  "official_press_release_or_newsletter",
  "project_specific_legislative_or_committee_action",
  "reputable_reporting",
]);

const OBSERVATION_FIELDS = new Set([
  "evidence_id",
  "application_id",
  "member_id",
  "direction",
  "evidence_type",
  "source",
  "source_language",
  "observed_at",
  "effective_at",
  "confidence",
]);

const RECORD_FIELDS = new Set([
  "schema_version",
  "application_id",
  "member_id",
  "as_of",
  "evidence",
  "resolution",
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

function officialMemberId(value, label) {
  const memberId = requiredText(value, label);
  if (!memberId.startsWith("official:") || memberId.length === "official:".length) {
    throw new TypeError(`${label} must be an official:{PersonId} identity`);
  }
  return memberId;
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
  if (typeof value !== "object" || seen.has(value)) return false;
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

function sourceValue(value, label) {
  if ((typeof value !== "string" && (typeof value !== "object" || Array.isArray(value)))
      || (typeof value === "string" && !value.trim())
      || !isJsonValue(value)) {
    throw new TypeError(`${label} must be a non-empty string or JSON object`);
  }
  if (typeof value === "object") {
    const locator = ["url", "source_url", "record_id", "source_record_id", "citation", "publisher"];
    if (!locator.some((key) => Object.hasOwn(value, key) && String(value[key] ?? "").trim())) {
      throw new TypeError(`${label} must contain an inspectable locator`);
    }
    return canonicalJson(value);
  }
  return value.trim();
}

function confidenceValue(value, label) {
  const confidence = Number(value);
  if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
    throw new TypeError(`${label} must be between 0 and 1`);
  }
  return confidence;
}

function temporalSort(left, right) {
  const leftEffective = left.effective_at || left.observed_at;
  const rightEffective = right.effective_at || right.observed_at;
  return leftEffective.localeCompare(rightEffective)
    || left.observed_at.localeCompare(right.observed_at)
    || left.evidence_id.localeCompare(right.evidence_id);
}

function normalizeObservation(raw, applicationId, memberId, asOf) {
  assertPlainObject(raw, "stance evidence");
  assertExactFields(raw, OBSERVATION_FIELDS, "stance evidence");
  for (const field of OBSERVATION_FIELDS) {
    if (!Object.hasOwn(raw, field)) throw new TypeError(`stance evidence missing: ${field}`);
  }

  const evidence = {
    evidence_id: requiredText(raw.evidence_id, "stance evidence.evidence_id"),
    application_id: requiredText(raw.application_id, "stance evidence.application_id"),
    member_id: officialMemberId(raw.member_id, "stance evidence.member_id"),
    direction: requiredText(raw.direction, "stance evidence.direction").toLowerCase(),
    evidence_type: requiredText(raw.evidence_type, "stance evidence.evidence_type").toLowerCase(),
    source: sourceValue(raw.source, "stance evidence.source"),
    source_language: requiredText(raw.source_language, "stance evidence.source_language"),
    observed_at: canonicalInstant(raw.observed_at, "stance evidence.observed_at", { required: true }),
    effective_at: canonicalInstant(raw.effective_at, "stance evidence.effective_at"),
    confidence: confidenceValue(raw.confidence, "stance evidence.confidence"),
  };

  if (evidence.application_id !== applicationId) {
    throw new TypeError("stance evidence.application_id must exactly match application_id");
  }
  if (evidence.member_id !== memberId) {
    throw new TypeError("stance evidence.member_id must exactly match member_id");
  }
  if (!STANCE_DIRECTIONS.includes(evidence.direction)) {
    throw new TypeError(`unsupported stance direction: ${raw.direction}`);
  }
  if (!STANCE_EVIDENCE_TYPES.includes(evidence.evidence_type)) {
    throw new TypeError(`unsupported stance evidence type: ${raw.evidence_type}`);
  }
  if (!evidence.source_language) throw new TypeError("stance evidence.source_language is required");
  return evidence;
}

function selectedEvidence(evidence) {
  if (!evidence.length) return { direction: "unknown", confidence: null, evidence_ids: [], reason: "no_evidence" };
  const latestTime = evidence.reduce((latest, row) => Math.max(
    latest,
    Date.parse(row.effective_at || row.observed_at),
  ), Number.NEGATIVE_INFINITY);
  const latest = evidence.filter((row) => Date.parse(row.effective_at || row.observed_at) === latestTime);
  const substantive = [...new Set(latest
    .map((row) => row.direction)
    .filter((direction) => direction !== "unknown"))].sort();

  // A latest explicit unknown supersedes prior knowledge. It is not a neutral
  // or mixed signal. If substantive and unknown observations share the latest
  // clock, the direction remains unresolved and every row stays inspectable.
  if (latest.some((row) => row.direction === "unknown")) {
    return {
      direction: "unknown",
      confidence: null,
      evidence_ids: latest.map((row) => row.evidence_id).sort(),
      reason: "latest_unknown",
    };
  }
  if (substantive.length > 1) {
    return {
      direction: "mixed_or_unclear",
      confidence: null,
      evidence_ids: latest.map((row) => row.evidence_id).sort(),
      reason: "latest_conflict",
    };
  }
  const confidence = latest.reduce((lowest, row) => Math.min(lowest, row.confidence), 1);
  return {
    direction: substantive[0] || "unknown",
    confidence: substantive.length ? confidence : null,
    evidence_ids: latest.map((row) => row.evidence_id).sort(),
    reason: "latest_evidence",
  };
}

function resolutionFor(evidence, asOf) {
  const current = selectedEvidence(evidence);
  const selected = new Set(current.evidence_ids);
  return {
    as_of: asOf,
    direction: current.direction,
    confidence: current.confidence,
    selected_evidence_ids: current.evidence_ids,
    reason: current.reason,
    history: evidence.map((row) => ({
      evidence_id: row.evidence_id,
      direction: row.direction,
      observed_at: row.observed_at,
      effective_at: row.effective_at,
      status: selected.has(row.evidence_id) ? "current" : "superseded",
    })),
  };
}

function validateResolution(resolution, evidence, asOf) {
  assertPlainObject(resolution, "stance resolution");
  const expected = resolutionFor(evidence, asOf);
  if (JSON.stringify(resolution) !== JSON.stringify(expected)) {
    throw new TypeError("stance resolution does not match deterministic evidence precedence");
  }
  return resolution;
}

function validateRecord(record) {
  assertPlainObject(record, "land member stance");
  assertExactFields(record, RECORD_FIELDS, "land member stance");
  for (const field of RECORD_FIELDS) {
    if (!Object.hasOwn(record, field)) throw new TypeError(`land member stance missing: ${field}`);
  }
  if (record.schema_version !== LAND_MEMBER_STANCE_VERSION) {
    throw new TypeError(`unsupported stance schema_version: ${record.schema_version}`);
  }
  const applicationId = requiredText(record.application_id, "application_id");
  const memberId = officialMemberId(record.member_id, "member_id");
  const asOf = canonicalInstant(record.as_of, "as_of", { required: true });
  if (!Array.isArray(record.evidence)) throw new TypeError("evidence must be an array");
  const evidence = record.evidence.map((row) => normalizeObservation(row, applicationId, memberId, asOf));
  if (new Set(evidence.map((row) => row.evidence_id)).size !== evidence.length) {
    throw new TypeError("stance evidence.evidence_id values must be unique");
  }
  const sorted = [...evidence].sort(temporalSort);
  if (JSON.stringify(sorted) !== JSON.stringify(evidence)) {
    throw new TypeError("stance evidence must be in deterministic temporal order");
  }
  validateResolution(record.resolution, evidence, asOf);
  return {
    schema_version: LAND_MEMBER_STANCE_VERSION,
    application_id: applicationId,
    member_id: memberId,
    as_of: asOf,
    evidence,
    resolution: record.resolution,
  };
}

/** Build a source-preserving stance record and its deterministic current view. */
export function buildLandMemberStance(input = {}) {
  assertPlainObject(input, "land member stance input");
  const applicationId = requiredText(input.application_id, "application_id");
  const memberId = requiredText(input.member_id, "member_id");
  const asOf = canonicalInstant(input.as_of, "as_of", { required: true });
  if (!Array.isArray(input.evidence ?? [])) throw new TypeError("evidence must be an array");
  const evidence = input.evidence
    .map((row) => normalizeObservation(row, applicationId, memberId, asOf))
    // Match the temporal snapshot rule: observed_at is the availability
    // clock; a source may describe a future-effective stance without causing
    // hindsight leakage.
    .filter((row) => Date.parse(row.observed_at) <= Date.parse(asOf))
    .sort(temporalSort);
  const record = {
    schema_version: LAND_MEMBER_STANCE_VERSION,
    application_id: applicationId,
    member_id: memberId,
    as_of: asOf,
    evidence,
    resolution: resolutionFor(evidence, asOf),
  };
  return validateLandMemberStance(record);
}

/** Validate a record without changing its evidence or derived resolution. */
export function validateLandMemberStance(record) {
  return validateRecord(record);
}

/** Add later source observations while retaining the complete stance history. */
export function appendLandMemberStanceEvidence(existing, additions = [], options = {}) {
  const record = validateLandMemberStance(existing);
  if (!Array.isArray(additions)) throw new TypeError("additions must be an array");
  const asOf = canonicalInstant(options.as_of ?? record.as_of, "as_of", { required: true });
  const evidence = [
    ...record.evidence,
    ...additions.map((row) => normalizeObservation(row, record.application_id, record.member_id, asOf)),
  ];
  if (new Set(evidence.map((row) => row.evidence_id)).size !== evidence.length) {
    throw new TypeError("stance evidence.evidence_id values must be unique");
  }
  return buildLandMemberStance({
    application_id: record.application_id,
    member_id: record.member_id,
    as_of: asOf,
    evidence,
  });
}

export const buildCouncilMemberStance = buildLandMemberStance;
export const validateCouncilMemberStance = validateLandMemberStance;
export const buildLandPredictionMemberStance = buildLandMemberStance;
export const validateLandPredictionMemberStance = validateLandMemberStance;
export const appendLandPredictionMemberStanceEvidence = appendLandMemberStanceEvidence;
