/**
 * Source-preserving civic-institution identity contracts.
 *
 * A civic institution is a stable product identity, not a replacement for a
 * publisher row. The source observation remains addressable and the additive
 * entity_link is only emitted when an exact publisher identifier, normalized
 * publisher value, or reviewed publisher alias supplies the join.
 */

import {
  BOROUGH_BOARD_IDENTITY_BASIS,
  BOROUGH_BOARD_IDENTITY_SOURCE_URL,
  BOROUGH_BOARD_ID,
  REVIEWED_BOROUGH_BOARDS as BOROUGH_BOARD_ROWS,
  boroughBoardIdentity as lookupBoroughBoard,
  parseBoroughBoardIdentity as parseBoroughBoardRef,
} from "../site/borough_board_identity.mjs";

export {
  BOROUGH_BOARD_IDENTITY_BASIS,
  BOROUGH_BOARD_IDENTITY_SOURCE_URL,
  BOROUGH_BOARD_ID,
};

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

/** Civic-institution envelopes for the reviewed five Borough Board identities. */
export const REVIEWED_BOROUGH_BOARDS = Object.freeze(BOROUGH_BOARD_ROWS.map((row) => Object.freeze({
  ...row,
  institution: civicInstitutionIdentity({
    canonicalId: `${row.borough_slug}-borough-board`,
    canonicalName: row.canonical_name,
    institutionKind: "board",
    institutionKindBasis: BOROUGH_BOARD_IDENTITY_BASIS,
  }),
})));

export function boroughBoardIdentity(value) {
  const row = lookupBoroughBoard(value);
  if (!row) return null;
  return REVIEWED_BOROUGH_BOARDS.find((item) => item.id === row.id) || null;
}

export function parseBoroughBoardIdentity(value) {
  return boroughBoardIdentity(parseBoroughBoardRef(value)?.borough_slug);
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

/**
 * Institution-to-institution role edges.
 *
 * Existing agency-targeted relations stay compatibility projections. This
 * envelope only mints civic-institution endpoints, never a generic related_to
 * fallback, and never infers a role from a display name.
 */
export const CIVIC_INSTITUTION_ROLE_EDGE_SCHEMA = "cityscroll.civic_institution_role_edge.v1";
export const CIVIC_INSTITUTION_ROLE_EDGE_VERSION = "1.0.0";
export const CIVIC_INSTITUTION_ROLE_EDGE_STATUSES = Object.freeze([
  "accepted",
  "unknown",
  "held",
  "unresolved",
]);
export const CIVIC_INSTITUTION_ROLE_CONFIDENCES = Object.freeze(["strong", "tentative", "unknown"]);
export const AGENCY_ROLE_COMPATIBILITY_SCHEMA = "cityscroll.agency_role_compatibility.v1";

const MUST_REPORT_NEGATIVE_RULE = "Never infer a report-recipient or oversight edge from duty-text names, OTI reports_to, a shared publisher label, or related_to.";
const DUTY_BEARER_NEGATIVE_RULE = "Never infer a duty bearer or oversight edge from a generic DOC obligation, generic board language, a Board of Correction meeting, or a shared agency label.";
const DEVELOPMENT_ROLE_NEGATIVE_RULE = "Never infer an applicant from a project mention, a contractor from a publisher notice, or a selected developer from a company name; require exact party or actor evidence.";
const ROLE_EVIDENCE = Object.freeze([
  "exact_source_observation",
  "exact_ids",
  "source_fields",
  "source_receipt",
  "observed_time",
  "confidence_basis",
]);

export const CIVIC_INSTITUTION_ROLE_RELATIONS = Object.freeze({
  must_report_to: Object.freeze({
    relation: "must_report_to",
    inverse: "receives_report_from",
    role: "report_submitter",
    inverse_role: "report_recipient",
    source_contract: "cityscroll.agency_obligations.v1",
    from_kind: "civic-institution",
    object_kind: "civic-institution",
    legacy_relation_id: "statute_duty",
    required_evidence: Object.freeze([
      "exact_source_observation",
      "exact_subject_institution",
      "exact_object_institution",
      "source_fields",
      "observed_time",
      "confidence_basis",
    ]),
    methods: ENTITY_LINK_METHODS,
    negative_rule: MUST_REPORT_NEGATIVE_RULE,
  }),
  duty_bearer: Object.freeze({
    relation: "duty_bearer",
    inverse: "holds_duty",
    role: "assigned_duty",
    inverse_role: "duty_bearer",
    source_contract: "cityscroll.agency_obligations.v1",
    from_kind: "obligation",
    object_kind: "civic-institution",
    legacy_relation_id: null,
    required_evidence: Object.freeze([
      "exact_source_observation",
      "exact_obligation_id",
      "exact_subject_institution",
      "quote_verification",
      "source_fields",
      "observed_time",
      "confidence_basis",
    ]),
    methods: ENTITY_LINK_METHODS,
    negative_rule: DUTY_BEARER_NEGATIVE_RULE,
  }),
  applicant_on: Object.freeze({
    relation: "applicant_on",
    inverse: "has_applicant",
    role: "applicant",
    inverse_role: "has_applicant",
    source_contract: "zap-projects",
    from_kind: "civic-institution",
    object_kind: "project",
    legacy_relation_id: "applicant_agency",
    required_evidence: ROLE_EVIDENCE,
    methods: ENTITY_LINK_METHODS,
    negative_rule: DEVELOPMENT_ROLE_NEGATIVE_RULE,
  }),
  contractor_on: Object.freeze({
    relation: "contractor_on",
    inverse: "has_contractor",
    role: "contractor",
    inverse_role: "has_contractor",
    source_contract: "passport_public_contracts",
    from_kind: "civic-institution",
    object_kind: "procurement",
    legacy_relation_id: null,
    required_evidence: ROLE_EVIDENCE,
    methods: ENTITY_LINK_METHODS,
    negative_rule: DEVELOPMENT_ROLE_NEGATIVE_RULE,
  }),
  contracted_by: Object.freeze({
    relation: "contracted_by",
    inverse: "contracts_with",
    role: "contracting_institution",
    inverse_role: "contractor",
    source_contract: "passport_public_contracts",
    from_kind: "civic-institution",
    object_kind: "civic-institution",
    legacy_relation_id: null,
    required_evidence: ROLE_EVIDENCE,
    methods: ENTITY_LINK_METHODS,
    negative_rule: DEVELOPMENT_ROLE_NEGATIVE_RULE,
  }),
  presents_transaction_at: Object.freeze({
    relation: "presents_transaction_at",
    inverse: "presents_transaction",
    role: "transaction_presenter",
    inverse_role: "presents_transaction",
    source_contract: "city_record_meetings",
    from_kind: "civic-institution",
    object_kind: "meeting",
    legacy_relation_id: null,
    required_evidence: Object.freeze([
      ...ROLE_EVIDENCE,
      "exact_notice",
      "exact_date",
      "exact_quote",
      "retained_source_passage",
    ]),
    methods: ENTITY_LINK_METHODS,
    negative_rule: DEVELOPMENT_ROLE_NEGATIVE_RULE,
  }),
});

/** Agency-to-record families remain dual-readable; they are not i2i role edges. */
export const LEGACY_AGENCY_ROLE_PROJECTIONS = Object.freeze({
  published_by_agency: Object.freeze({
    relation: "published_by_agency",
    role: "publisher",
    inverse: "publisher_of",
    object_kind: "record",
  }),
  applicant_agency: Object.freeze({
    relation: "applicant_agency",
    role: "applicant",
    inverse: "has_applicant",
    object_kind: "record",
  }),
  hosts_meeting: Object.freeze({
    relation: "hosts_meeting",
    role: "meeting_host",
    inverse: "hosted_by",
    object_kind: "record",
  }),
  issued_rule: Object.freeze({
    relation: "issued_rule",
    role: "rule_issuer",
    inverse: "issued_by",
    object_kind: "record",
  }),
  certified_to_agency: Object.freeze({
    relation: "certified_to_agency",
    role: "staffing_certification",
    inverse: "certifies_exam",
    object_kind: "record",
  }),
  statute_duty: Object.freeze({
    relation: "statute_duty",
    role: "mandate_holder",
    inverse: "imposes_duty",
    object_kind: "record",
  }),
  votes_as_official: Object.freeze({
    relation: "votes_as_official",
    role: "voting_official",
    inverse: "has_official_vote",
    object_kind: "record",
  }),
});

const GENERIC_RELATIONS = Object.freeze(new Set(["related_to", "related", "connection", "associated_with"]));

function roleSpecFor(relation) {
  const token = clean(relation, 80).toLowerCase();
  if (!token) return null;
  if (CIVIC_INSTITUTION_ROLE_RELATIONS[token]) {
    return Object.freeze({ spec: CIVIC_INSTITUTION_ROLE_RELATIONS[token], reversed: false });
  }
  for (const spec of Object.values(CIVIC_INSTITUTION_ROLE_RELATIONS)) {
    if (spec.inverse === token) return Object.freeze({ spec, reversed: true });
  }
  return null;
}

function evidenceRefsFrom(value) {
  const rows = Array.isArray(value) ? value : value ? [value] : [];
  return Object.freeze([...new Set(rows.map((item) => {
    if (typeof item === "string") return clean(item, 500);
    return clean(item?.source_ref || item?.source_record_id || item?.source_url, 500);
  }).filter(Boolean))]);
}

function tryInstitution(value) {
  const raw = value?.id || value?.institution_ref || value?.canonical_id || value;
  if (raw == null || raw === "") return null;
  const parsed = parseCivicInstitutionIdentity(raw);
  if (parsed) {
    return Object.freeze({
      ...parsed,
      kind: "civic-institution",
      href: compatibilityHref(parsed.canonical_id),
    });
  }
  try {
    const identity = parseCivicInstitutionIdentity(institutionId(raw));
    return Object.freeze({
      ...identity,
      kind: "civic-institution",
      href: compatibilityHref(identity.canonical_id),
    });
  } catch {
    return null;
  }
}

function compatibilityHref(canonicalId) {
  return canonicalId ? `/agencies/${canonicalId}/` : null;
}

function tryTypedObject(value, kind) {
  if (kind === "civic-institution") return tryInstitution(value);
  const raw = clean(value?.id || value?.object_ref || value?.ref || value, 320);
  if (!raw) return null;
  if (kind === "project") {
    const match = raw.match(/^(?:project:)?([A-Za-z0-9][A-Za-z0-9_-]{2,24})$/);
    if (!match) return null;
    const projectId = match[1];
    return Object.freeze({
      id: `project:${projectId}`,
      canonical_id: projectId,
      kind: "project",
      href: `/browse/zoning/#land/${encodeURIComponent(projectId)}`,
    });
  }
  if (kind === "procurement") {
    const id = raw.startsWith("procurement:") ? raw : null;
    if (!id) return null;
    return Object.freeze({
      id,
      canonical_id: id,
      kind: "procurement",
      href: `/procurements/${encodeURIComponent(id)}`,
    });
  }
  if (kind === "meeting") {
    const match = raw.match(/^(?:meetings:notice:|meeting:city_record:|notice:)?(\d{8,12})$/);
    if (!match) return null;
    const noticeId = match[1];
    return Object.freeze({
      id: `meetings:notice:${noticeId}`,
      canonical_id: noticeId,
      kind: "meeting",
      href: `/notices/${encodeURIComponent(noticeId)}`,
    });
  }
  if (kind === "obligation") {
    const match = raw.match(/^(?:obligation:|mandate:)?(\d{3,8}-\d{3})$/);
    if (!match) return null;
    const obligationId = match[1];
    return Object.freeze({
      id: `obligation:${obligationId}`,
      canonical_id: obligationId,
      kind: "obligation",
      href: `/mandates/${encodeURIComponent(obligationId)}`,
    });
  }
  return null;
}

function endpointHref(endpoint, fallbackHref = null) {
  return clean(fallbackHref, 500) || endpoint?.href || null;
}

function roleEdgeId({ relation, from, to, sourceObservation }) {
  return [
    "role_edge",
    relation,
    from,
    to,
    sourceObservation?.source_record_ref || "source_missing",
    sourceObservation?.source_field || "field_missing",
  ].map((part) => encodeURIComponent(part)).join(":");
}

function roleEdgeProvenance(sourceObservation, observed, basis, vintage) {
  return Object.freeze({
    source_system: sourceObservation?.source_system || null,
    source_record_id: sourceObservation?.source_record_id || null,
    source_record_ref: sourceObservation?.source_record_ref || null,
    source_field: sourceObservation?.source_field || null,
    source_value: sourceObservation?.source_value || null,
    source_url: sourceObservation?.source_url || null,
    source_dataset: sourceObservation?.source_dataset || null,
    source_receipt: sourceObservation?.source_record_ref || sourceObservation?.source_record_id || null,
    observed_at: observed,
    basis: clean(basis, 240) || null,
    vintage: clean(vintage, 80) || observed,
  });
}

function roleEdgeEnvelope({
  spec,
  from,
  to,
  sourceObservation,
  evidenceRefs,
  confidence,
  basis,
  asOf,
  vintage,
  method,
  status,
  reason = null,
  linking,
  objectHref = null,
  subjectHref = null,
  objectDisplayName = null,
  reversed = false,
}) {
  const observed = sourceObservation?.observed_at
    ? timestamp(sourceObservation.observed_at, "observed_at")
    : timestamp(asOf, "as_of");
  const asOfStamp = timestamp(asOf || observed, "as_of");
  const vintageStamp = clean(vintage, 80) || asOfStamp;
  const refs = evidenceRefsFrom(evidenceRefs);
  const relationId = reversed ? spec.inverse : spec.relation;
  const inverseId = reversed ? spec.relation : spec.inverse;
  const role = reversed ? spec.inverse_role : spec.role;
  const inverseRole = reversed ? spec.role : spec.inverse_role;
  const fromKind = from.kind || spec.from_kind || "civic-institution";
  const objectKind = to.kind || spec.object_kind || "civic-institution";
  return Object.freeze({
    schema: CIVIC_INSTITUTION_ROLE_EDGE_SCHEMA,
    version: CIVIC_INSTITUTION_ROLE_EDGE_VERSION,
    id: roleEdgeId({ relation: relationId, from: from.id, to: to.id, sourceObservation }),
    relation_id: relationId,
    relation: relationId,
    inverse: inverseId,
    role,
    inverse_role: inverseRole,
    from: from.id,
    to: to.id,
    subject_ref: from.id,
    object_ref: to.id,
    subject_canonical_id: from.canonical_id,
    object_canonical_id: to.canonical_id,
    from_kind: fromKind,
    object_kind: objectKind,
    object_display_name: clean(objectDisplayName, 240) || null,
    source_contract: spec.source_contract,
    required_evidence: spec.required_evidence,
    materialization: "civic_institution_role_edge",
    source_observation: sourceObservation || null,
    evidence_refs: refs,
    method: method || null,
    confidence: confidence || "unknown",
    basis: clean(basis, 240) || null,
    as_of: asOfStamp,
    vintage: vintageStamp,
    status,
    reason,
    linking,
    href: linking ? endpointHref(to, objectHref) : null,
    inverse_href: linking ? endpointHref(from, subjectHref) : null,
    negative_rule: spec.negative_rule,
    provenance: roleEdgeProvenance(sourceObservation, observed, basis, vintageStamp),
  });
}

function unresolvedRoleResult({
  spec,
  from = null,
  to = null,
  sourceObservation = null,
  evidenceRefs = [],
  reason,
  status = "unresolved",
  confidence = "unknown",
  basis = null,
  asOf = null,
  vintage = null,
  method = null,
}) {
  const subject = from || { id: null, canonical_id: null };
  const object = to || { id: null, canonical_id: null };
  const envelope = roleEdgeEnvelope({
    spec,
    from: subject.id ? subject : { id: "civic-institution:unresolved", canonical_id: "unresolved" },
    to: object.id ? object : { id: "civic-institution:unresolved", canonical_id: "unresolved" },
    sourceObservation,
    evidenceRefs,
    confidence,
    basis,
    asOf: asOf || sourceObservation?.observed_at,
    vintage,
    method,
    status,
    reason,
    linking: false,
  });
  return Object.freeze({
    ...envelope,
    from: subject.id,
    to: object.id,
    subject_ref: subject.id,
    object_ref: object.id,
    subject_canonical_id: subject.canonical_id,
    object_canonical_id: object.canonical_id,
    href: null,
    inverse_href: null,
    id: roleEdgeId({
      relation: spec.relation,
      from: subject.id || "civic-institution:unresolved",
      to: object.id || "civic-institution:unresolved",
      sourceObservation,
    }),
  });
}

/**
 * Mint one institution-to-institution role edge. Missing, held, conflicting,
 * and generic candidates stay explicit and non-linking.
 */
export function buildCivicInstitutionRoleEdge({
  subject,
  object,
  relation = "must_report_to",
  sourceObservation = null,
  evidenceRefs = [],
  confidence = "strong",
  basis = null,
  asOf = null,
  vintage = null,
  method = null,
  resolutionStatus = "accepted",
  objectDisplayName = null,
  objectHref = null,
  subjectHref = null,
  reason = null,
} = {}) {
  const relationToken = clean(relation, 80).toLowerCase();
  if (GENERIC_RELATIONS.has(relationToken)) {
    const spec = CIVIC_INSTITUTION_ROLE_RELATIONS.must_report_to;
    return unresolvedRoleResult({
      spec,
      reason: "generic_relation_forbidden",
      sourceObservation,
      evidenceRefs,
      asOf,
      vintage,
      method,
    });
  }
  const oriented = roleSpecFor(relationToken);
  if (!oriented) {
    return Object.freeze({
      schema: CIVIC_INSTITUTION_ROLE_EDGE_SCHEMA,
      version: CIVIC_INSTITUTION_ROLE_EDGE_VERSION,
      status: "held",
      reason: "unsupported_i2i_relation",
      relation_id: relationToken || null,
      relation: relationToken || null,
      from: null,
      to: null,
      linking: false,
      href: null,
      source_observation: sourceObservation || null,
      evidence_refs: evidenceRefsFrom(evidenceRefs),
      negative_rule: "Do not mint an institution-to-institution edge for an unsupported or record-targeted relation.",
    });
  }
  const spec = oriented.spec;
  const fromKind = oriented.reversed ? spec.object_kind : (spec.from_kind || "civic-institution");
  const toKind = oriented.reversed ? (spec.from_kind || "civic-institution") : spec.object_kind;
  const from = tryTypedObject(oriented.reversed ? object : subject, fromKind);
  const to = tryTypedObject(oriented.reversed ? subject : object, toKind);
  if (!from || !to) {
    return unresolvedRoleResult({
      spec,
      from,
      to,
      reason: objectDisplayName || /\s/.test(clean(object || subject, 200))
        ? "name_only_endpoint"
        : "institution_identity_missing",
      sourceObservation,
      evidenceRefs,
      asOf,
      vintage,
      method,
    });
  }
  if (from.id === to.id) {
    return unresolvedRoleResult({
      spec, from, to, sourceObservation, evidenceRefs, asOf, vintage, method,
      reason: "reflexive_role_forbidden",
    });
  }
  if (resolutionStatus === "held") {
    return unresolvedRoleResult({
      spec, from, to, sourceObservation, evidenceRefs, asOf, vintage, method,
      status: "held",
      reason: clean(reason, 240) || clean(basis, 240) || "held_by_graph_policy",
    });
  }
  if (resolutionStatus === "collision" || resolutionStatus === "conflict" || resolutionStatus === "unresolved") {
    return unresolvedRoleResult({
      spec, from, to, sourceObservation, evidenceRefs, asOf, vintage, method,
      reason: clean(reason, 240)
        || (resolutionStatus === "collision" ? "conflicting_endpoints" : "unresolved_role"),
    });
  }
  if (!sourceObservation?.source_record_ref) {
    return unresolvedRoleResult({
      spec, from, to, evidenceRefs, asOf, vintage, method,
      status: "unknown",
      reason: clean(reason, 240) || "source_observation_missing",
    });
  }
  const refs = evidenceRefsFrom(evidenceRefs);
  if (!refs.length) {
    return unresolvedRoleResult({
      spec, from, to, sourceObservation, asOf, vintage, method,
      status: "unknown",
      reason: clean(reason, 240) || "evidence_missing",
    });
  }
  const exactMethod = normalizedMethod(method || "exact_source_identifier");
  const exactConfidence = CIVIC_INSTITUTION_ROLE_CONFIDENCES.includes(clean(confidence, 80).toLowerCase())
    ? clean(confidence, 80).toLowerCase()
    : null;
  if (resolutionStatus !== "accepted" || !exactMethod || exactConfidence !== "strong") {
    return unresolvedRoleResult({
      spec, from, to, sourceObservation, evidenceRefs: refs, asOf, vintage, method: exactMethod,
      status: exactConfidence === "tentative" ? "held" : "unresolved",
      reason: clean(reason, 240)
        || (exactConfidence === "tentative" ? "tentative_non_linking" : "unresolved_role"),
      confidence: exactConfidence || "unknown",
    });
  }
  return roleEdgeEnvelope({
    spec,
    from,
    to,
    sourceObservation,
    evidenceRefs: refs,
    confidence: exactConfidence,
    basis: basis || "exact_source_observation",
    asOf: asOf || sourceObservation.observed_at,
    vintage,
    method: exactMethod,
    status: "accepted",
    linking: true,
    objectHref,
    subjectHref,
    objectDisplayName,
    reversed: oriented.reversed,
  });
}

export const projectCivicInstitutionRoleEdge = buildCivicInstitutionRoleEdge;

/** Deterministic inverse: accepted edges swap endpoints; others stay non-linking. */
export function invertCivicInstitutionRoleEdge(edge) {
  if (!edge || edge.schema !== CIVIC_INSTITUTION_ROLE_EDGE_SCHEMA) return null;
  const spec = CIVIC_INSTITUTION_ROLE_RELATIONS[edge.relation_id]
    || Object.values(CIVIC_INSTITUTION_ROLE_RELATIONS).find((entry) => entry.inverse === edge.relation_id);
  if (!spec || !edge.from || !edge.to) {
    return Object.freeze({ ...edge, linking: false, href: null, inverse_href: null });
  }
  const forward = edge.relation_id === spec.relation;
  const invertedRelation = forward ? spec.inverse : spec.relation;
  const linking = edge.status === "accepted";
  return Object.freeze({
    ...edge,
    id: roleEdgeId({
      relation: invertedRelation,
      from: edge.to,
      to: edge.from,
      sourceObservation: edge.source_observation,
    }),
    relation_id: invertedRelation,
    relation: invertedRelation,
    inverse: forward ? spec.relation : spec.inverse,
    role: forward ? spec.inverse_role : spec.role,
    inverse_role: forward ? spec.role : spec.inverse_role,
    from: edge.to,
    to: edge.from,
    subject_ref: edge.to,
    object_ref: edge.from,
    subject_canonical_id: edge.object_canonical_id,
    object_canonical_id: edge.subject_canonical_id,
    from_kind: edge.object_kind || spec.object_kind,
    object_kind: edge.from_kind || spec.from_kind || "civic-institution",
    linking,
    href: linking ? edge.inverse_href : null,
    inverse_href: linking ? edge.href : null,
  });
}

export function resolveCivicInstitutionRoleEdge(input = {}) {
  const edge = buildCivicInstitutionRoleEdge(input);
  const accepted = edge?.status === "accepted";
  return Object.freeze({
    status: edge?.status || "unknown",
    reason: accepted ? null : (edge?.reason || "role_edge_unknown"),
    edge: accepted ? edge : edge,
    linking: Boolean(edge?.linking),
  });
}

/**
 * Collapse a candidate bag. Conflicting exact endpoints for one source stay
 * unresolved; unsupported families stay held; generic related_to stays absent.
 */
export function resolveCivicInstitutionRoleEdges(candidates = []) {
  const accepted = [];
  const held = [];
  const unknown = [];
  const unresolved = [];
  const seen = new Set();
  for (const candidate of Array.isArray(candidates) ? candidates : []) {
    const objects = Array.isArray(candidate?.objectCandidates) ? candidate.objectCandidates.filter(Boolean) : [];
    if (objects.length > 1 && !candidate.object) {
      unresolved.push(buildCivicInstitutionRoleEdge({
        ...candidate,
        object: objects[0],
        resolutionStatus: "collision",
      }));
      continue;
    }
    const edge = buildCivicInstitutionRoleEdge(candidate);
    if (edge.status === "accepted") {
      if (seen.has(edge.id)) continue;
      seen.add(edge.id);
      accepted.push(edge);
      continue;
    }
    if (edge.status === "held") held.push(edge);
    else if (edge.status === "unknown") unknown.push(edge);
    else unresolved.push(edge);
  }
  return Object.freeze({
    accepted: Object.freeze(accepted),
    held: Object.freeze(held),
    unknown: Object.freeze(unknown),
    unresolved: Object.freeze(unresolved),
  });
}

/** Dual-readable agency subject projection; never rewrites agency identities. */
export function legacyAgencyRoleProjection(edge) {
  if (!edge || edge.schema !== CIVIC_INSTITUTION_ROLE_EDGE_SCHEMA) return null;
  const spec = CIVIC_INSTITUTION_ROLE_RELATIONS[edge.relation_id || edge.relation]
    || Object.values(CIVIC_INSTITUTION_ROLE_RELATIONS).find((entry) => entry.inverse === (edge.relation_id || edge.relation));
  if (!spec || !edge.subject_canonical_id) return null;
  const institutionSubject = (edge.from_kind || spec.from_kind || "civic-institution") === "civic-institution";
  const institutionObject = (edge.object_kind || spec.object_kind) === "civic-institution";
  return Object.freeze({
    schema: AGENCY_ROLE_COMPATIBILITY_SCHEMA,
    subject_ref: institutionSubject ? `agency:id:${edge.subject_canonical_id}` : edge.subject_ref,
    object_ref: institutionObject && edge.object_canonical_id
      ? `agency:id:${edge.object_canonical_id}`
      : (edge.object_ref || null),
    relation: spec.legacy_relation_id || spec.relation,
    role_relation: spec.relation,
    inverse: spec.inverse,
    status: edge.status,
    linking: Boolean(edge.linking),
    href: edge.linking ? edge.href : null,
    canonical_id: institutionSubject ? edge.subject_canonical_id : null,
  });
}

/**
 * Preserve existing agency-to-record consumers. Record-targeted families never
 * become civic-institution role edges.
 */
export function projectLegacyAgencyRole({
  relationId,
  agencyCanonicalId,
  recordRef = null,
  recordHref = null,
  sourceObservation = null,
  status = "matched",
} = {}) {
  const spec = LEGACY_AGENCY_ROLE_PROJECTIONS[clean(relationId, 80)];
  const canonical = clean(agencyCanonicalId, 160);
  if (!spec || !canonical) return null;
  return Object.freeze({
    schema: AGENCY_ROLE_COMPATIBILITY_SCHEMA,
    subject_ref: `agency:id:${canonical}`,
    object_ref: clean(recordRef, 320) || null,
    relation: spec.relation,
    role: spec.role,
    inverse: spec.inverse,
    object_kind: spec.object_kind,
    status,
    linking: Boolean(recordHref),
    href: clean(recordHref, 500) || null,
    source_observation: sourceObservation || null,
    civic_institution_role_edge: null,
  });
}

export function civicInstitutionRoleHref(edge) {
  return edge?.schema === CIVIC_INSTITUTION_ROLE_EDGE_SCHEMA && edge.linking ? edge.href : null;
}
