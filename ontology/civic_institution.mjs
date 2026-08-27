/**
 * Source-preserving civic-institution identity contracts.
 *
 * A civic institution is a stable product identity, not a replacement for a
 * publisher row. The source observation remains addressable and the additive
 * entity_link is only emitted when an exact publisher identifier, normalized
 * publisher value, or reviewed publisher alias supplies the join.
 */

export const CIVIC_INSTITUTION_PROJECTION_SCHEMA = "cityscroll.civic_institution.v1";
export const CIVIC_INSTITUTION_SCHEMA = CIVIC_INSTITUTION_PROJECTION_SCHEMA;
export const ENTITY_LINK_SCHEMA = "cityscroll.entity_link.v1";
export const ENTITY_LINK_RELATION = "entity_link";
export const ENTITY_LINK_INVERSE = "has_source_observation";
export const ENTITY_LINK_VERSION = "1.0.0";
export const ENTITY_LINK_METHODS = Object.freeze([
  "exact_source_identifier",
  "exact_normalized_publisher_value",
  "reviewed_publisher_alias",
]);
export const ENTITY_LINK_CONFIDENCES = Object.freeze(["strong", "unknown"]);
export const CIVIC_INSTITUTION_KINDS = Object.freeze([
  "department",
  "board",
  "commission",
  "elected_office",
  "public_benefit_corporation",
  "authority",
  "public_system",
  "retirement_system",
  "nonprofit",
  "community_board",
]);

const INSTITUTION_ID = /^civic-institution:([a-z0-9]+(?:-[a-z0-9]+)*)$/;

function clean(value, max = 500) {
  return String(value ?? "")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

function token(value, field, max = 240) {
  const result = clean(value, max).toLowerCase();
  if (!result || /[\s/:]/.test(result)) {
    throw new TypeError(`${field} must be a non-empty identity token`);
  }
  return result;
}

function timestamp(value, field, { required = false } = {}) {
  const result = clean(value, 80);
  if (!result) {
    if (required) throw new TypeError(`${field} is required`);
    return null;
  }
  if (Number.isNaN(Date.parse(result))) throw new TypeError(`${field} must be an ISO timestamp`);
  return result;
}

function safeSourceUrl(value) {
  const result = clean(value, 2_000);
  if (!result) return null;
  if (/^javascript:/i.test(result)) throw new TypeError("source_url must be a safe URL");
  return result;
}

function institutionId(value) {
  const id = clean(value, 320);
  if (INSTITUTION_ID.test(id)) return id;
  const canonicalId = token(id, "canonical_id");
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(canonicalId)) {
    throw new TypeError("canonical_id must be a slug");
  }
  return `civic-institution:${canonicalId}`;
}

function canonicalIdFromIdentity(value) {
  const id = institutionId(value);
  return id.slice("civic-institution:".length);
}

/** Build the enduring identity while retaining the legacy agency subject. */
export function civicInstitutionIdentity({
  canonicalId,
  canonicalName,
  institutionKind = null,
  institutionKindBasis = null,
  legalForm = null,
} = {}) {
  const id = institutionId(canonicalId);
  const kind = clean(institutionKind, 120) || null;
  const basis = clean(institutionKindBasis, 500) || null;
  if (kind && !basis) throw new TypeError("institution_kind requires an independent basis");
  return Object.freeze({
    schema: CIVIC_INSTITUTION_PROJECTION_SCHEMA,
    object_type: "civic-institution",
    id,
    canonical_id: id.slice("civic-institution:".length),
    canonical_name: clean(canonicalName, 500) || null,
    legacy_subject_ref: `agency:id:${id.slice("civic-institution:".length)}`,
    institution_kind: kind,
    institution_kind_basis: basis,
    legal_form: clean(legalForm, 160) || null,
    classification_status: kind ? "classified" : "unclassified",
  });
}

export const buildCivicInstitutionIdentity = civicInstitutionIdentity;

export function parseCivicInstitutionIdentity(value) {
  const id = clean(value, 320);
  if (!INSTITUTION_ID.test(id)) return null;
  return Object.freeze({
    id,
    canonical_id: id.slice("civic-institution:".length),
  });
}

export function isCivicInstitutionIdentity(value) {
  return Boolean(parseCivicInstitutionIdentity(value));
}

/** Additive envelope for a civic institution and its source observations. */
export function projectCivicInstitution({
  identity,
  canonicalId,
  canonicalName,
  institutionKind = null,
  institutionKindBasis = null,
  legalForm = null,
  observations = [],
  generatedAt = null,
} = {}) {
  const projected = identity?.id
    ? civicInstitutionIdentity({
      canonicalId: identity.id,
      canonicalName: identity.canonical_name || identity.canonicalName,
      institutionKind: identity.institution_kind || identity.institutionKind,
      institutionKindBasis: identity.institution_kind_basis || identity.institutionKindBasis,
      legalForm: identity.legal_form || identity.legalForm,
    })
    : civicInstitutionIdentity({ canonicalId, canonicalName, institutionKind, institutionKindBasis, legalForm });
  const rows = Array.isArray(observations) ? observations.filter(Boolean) : [];
  return Object.freeze({
    ...projected,
    observations: Object.freeze(rows),
    provenance: Object.freeze({
      observed_at: timestamp(generatedAt, "generated_at"),
      observation_count: rows.length,
      identity_basis: "exact_source_preserving_entity_link",
    }),
  });
}

function retainedRow(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return Object.freeze({ ...value });
}

/** Retain one source field/value without treating its spelling as identity. */
export function sourceRecordObservation({
  sourceSystem,
  sourceRecordId = null,
  sourceField,
  sourceValue,
  sourceUrl = null,
  observedAt,
  retainedSourceRow = null,
  sourceDataset = null,
} = {}) {
  const system = token(sourceSystem, "source_system");
  const recordId = clean(sourceRecordId, 320) || null;
  const row = retainedRow(retainedSourceRow);
  if (!recordId && !row) throw new TypeError("source_record_id or retained_source_row is required");
  const field = token(sourceField, "source_field");
  const value = clean(sourceValue, 1_000);
  if (!value) throw new TypeError("source_value is required");
  const qualifiedRecordId = recordId && recordId.toLowerCase().startsWith(`${system}:`)
    ? recordId
    : (recordId ? `${system}:${recordId}` : "retained-row");
  const recordRef = `source_record:${qualifiedRecordId}`;
  return Object.freeze({
    schema: "cityscroll.source_record_observation.v1",
    object_type: "source_record",
    source_system: system,
    source_record_id: recordId,
    source_record_ref: recordRef,
    source_field: field,
    source_value: value,
    source_url: safeSourceUrl(sourceUrl),
    source_dataset: clean(sourceDataset, 160) || null,
    retained_source_row: row,
    observed_at: timestamp(observedAt, "observed_at", { required: true }),
  });
}

export const buildSourceRecordObservation = sourceRecordObservation;

function normalizedMethod(value) {
  const method = clean(value, 120).toLowerCase();
  return ENTITY_LINK_METHODS.includes(method) ? method : null;
}

function normalizedConfidence(value) {
  const confidence = clean(value, 80).toLowerCase();
  return ENTITY_LINK_CONFIDENCES.includes(confidence) ? confidence : null;
}

/**
 * Build the reversible source_record → civic-institution edge.
 * Unknown, unresolved, and colliding resolutions return null by design.
 */
export function buildEntityLink({
  sourceObservation,
  institution,
  method,
  confidence = "strong",
  observedAt = null,
  resolutionStatus = "accepted",
} = {}) {
  if (!sourceObservation?.source_record_ref) throw new TypeError("source observation is required");
  const target = institutionId(institution?.id || institution?.canonical_id || institution);
  const exactMethod = normalizedMethod(method);
  const exactConfidence = normalizedConfidence(confidence);
  if (resolutionStatus !== "accepted" || !exactMethod || exactConfidence !== "strong") return null;
  const observed = timestamp(observedAt || sourceObservation.observed_at, "observed_at", { required: true });
  const id = [
    ENTITY_LINK_RELATION,
    sourceObservation.source_record_ref,
    sourceObservation.source_field,
    sourceObservation.source_value,
    target,
  ].map((part) => encodeURIComponent(part)).join(":");
  return Object.freeze({
    schema: ENTITY_LINK_SCHEMA,
    version: ENTITY_LINK_VERSION,
    id,
    relation: ENTITY_LINK_RELATION,
    inverse: ENTITY_LINK_INVERSE,
    from: sourceObservation.source_record_ref,
    to: target,
    source_record: sourceObservation,
    canonical_id: canonicalIdFromIdentity(target),
    method: exactMethod,
    confidence: exactConfidence,
    observed_at: observed,
    provenance: Object.freeze({
      source_system: sourceObservation.source_system,
      source_record_id: sourceObservation.source_record_id,
      source_field: sourceObservation.source_field,
      source_value: sourceObservation.source_value,
      source_url: sourceObservation.source_url,
      source_dataset: sourceObservation.source_dataset,
      observed_at: observed,
    }),
  });
}

export const buildCivicInstitutionEntityLink = buildEntityLink;
export const civicInstitutionEntityLink = buildEntityLink;

/** Preserve an explicit unknown outcome for collisions and unresolved routes. */
export function resolveCivicInstitutionLink({
  sourceObservation,
  institution = null,
  method = null,
  confidence = "unknown",
  resolutionStatus = "unknown",
  reason = "identity_link_unknown",
} = {}) {
  const link = institution
    ? buildEntityLink({ sourceObservation, institution, method, confidence, resolutionStatus })
    : null;
  return Object.freeze({
    status: link ? "accepted" : "unknown",
    reason: link ? null : clean(reason, 240) || "identity_link_unknown",
    link,
  });
}

export function sourceIdentityEvidence(link) {
  if (!link?.schema || link.schema !== ENTITY_LINK_SCHEMA) return null;
  return Object.freeze({
    entity_link_id: link.id,
    entity_link_relation: link.relation,
    entity_link_inverse: link.inverse,
    source_record_ref: link.from,
    institution_ref: link.to,
    source_system: link.provenance.source_system,
    source_record_id: link.provenance.source_record_id,
    source_field: link.provenance.source_field,
    source_value: link.provenance.source_value,
    source_url: link.provenance.source_url,
    canonical_id: link.canonical_id,
    method: link.method,
    confidence: link.confidence,
    observed_at: link.observed_at,
  });
}
