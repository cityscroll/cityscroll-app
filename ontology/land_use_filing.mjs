/**
 * LDP-23: land-use filing obligation, filing document, and RER envelope
 * contracts, plus the five commissioned relations and an as-of projector.
 *
 * Census-bounded (LDP-22, `warehouse/receipts/proof/land_filing_evidence_census_latest.json`):
 * no ZAP API field encodes RER applicability -- `dcp-applicability` reads
 * "Yes" on both a project carrying an observed RER artifact group and one
 * with none. This module therefore makes it structurally impossible to set
 * `applicability.state` to `required`/`not_required` without an explicit
 * `publisher_assertion` (source_field + source_value + observed_at); absent
 * that, callers get `unknown`. A title-token artifact-group match can only
 * ever become `applicability.reconstructed_candidate` (`public: false`,
 * hard-coded, never overwrites the public state).
 *
 * This card registers and validates the contracts. It does not collect,
 * fetch, parse, or extract anything -- every builder here is a pure function
 * over already-assembled plain objects (fixtures in tests, or future callers
 * in LDP-24/25/26).
 */

import { ADMIN_CODE_25_118_SOURCE, DCP_RER_CRITERIA_SOURCE } from "../warehouse/lib/land_filing_evidence_census.mjs";

export const LAND_USE_FILING_OBLIGATION_SCHEMA = "cityscroll.land_use_filing_obligation.v1";
export const LAND_USE_FILING_OBLIGATION_VERSION = "1.0.0";
export const LAND_USE_FILING_DOCUMENT_SCHEMA = "cityscroll.land_use_filing_document.v1";
export const LAND_USE_FILING_DOCUMENT_VERSION = "1.0.0";
export const RACIAL_EQUITY_REPORT_SCHEMA = "cityscroll.racial_equity_report.v1";
export const RACIAL_EQUITY_REPORT_VERSION = "1.0.0";
export const LAND_USE_FILING_RELATION_SCHEMA = "cityscroll.land_use_filing_relation.v1";
export const LAND_USE_FILING_RELATION_VERSION = "1.0.0";

export const FILING_OBLIGATION_TYPES = Object.freeze(["racial_equity_report"]);

export const FILING_APPLICABILITY_STATES = Object.freeze([
  "required",
  "not_required",
  "unknown",
  "not_yet_effective",
  "source_conflict",
]);

export const FILING_FULFILLMENT_STATES = Object.freeze([
  "document_observed",
  "publisher_identifies_not_timely_filed",
  "not_observed",
  "not_checked",
  "source_unavailable",
]);

export const FILING_DOCUMENT_TYPES = Object.freeze([
  "racial_equity_report",
  "filed_land_use_package",
  "notice_of_receipt",
  "notice_of_certification_or_referral",
  "ceqr_document_link",
  "other",
  "unknown",
]);

/** STOP until SEQRA-04 owns shared CEQR document acquisition (LDP-22 census). */
export const FILING_DOCUMENT_TYPES_BLOCKED_UNTIL_SEQRA04 = Object.freeze(["ceqr_document_link"]);

export const FILING_DOCUMENT_CLASSIFICATION_METHODS = Object.freeze([
  "explicit_publisher_type_or_group",
  "title_token_plus_markers",
  "reviewed_mapping",
  "unknown",
]);

export const FILING_CONFIDENCE_LEVELS = Object.freeze(["high", "medium", "low", "unknown"]);
export const FILING_QUALITY_STATES = Object.freeze(["not_applicable", "high", "medium", "low", "unknown"]);
export const FILING_RETRIEVAL_STATUSES = Object.freeze(["fetched", "not_attempted", "fetch_failed", "unavailable"]);
export const LAND_USE_FILING_RELATION_STATUSES = Object.freeze(["accepted", "unknown", "held", "unresolved"]);

/**
 * Never a synonym for a filing observation. Kept as an exported constant so a
 * test can scan every enum this module exports and fail if one is ever added.
 */
export const FORBIDDEN_FILING_OBSERVATION_SYNONYMS = Object.freeze([
  "review",
  "decision",
  "approved",
  "cleared",
  "compliant",
  "complete",
]);

export const DRI_INTERPRETATION = "contextual_not_project_prediction";

function clean(value, max = 500) {
  return String(value ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

function requireString(value, field, max = 500) {
  const result = clean(value, max);
  if (!result) throw new TypeError(`${field} is required`);
  return result;
}

function requireEnum(value, allowed, field) {
  if (!allowed.includes(value)) {
    throw new TypeError(`${field} must be one of ${allowed.join("|")}, got ${JSON.stringify(value)}`);
  }
  return value;
}

function requireTimestamp(value, field) {
  const result = clean(value, 80);
  if (!result || Number.isNaN(Date.parse(result))) throw new TypeError(`${field} must be an ISO timestamp`);
  return result;
}

function optionalTimestamp(value, field) {
  return value == null ? null : requireTimestamp(value, field);
}

function projectRefToken(value) {
  const result = clean(value, 240);
  if (!/^project:[^\s:]+$/.test(result)) {
    throw new TypeError(`project_ref must look like "project:{project_id}", got ${JSON.stringify(value)}`);
  }
  return result;
}

/** If a caller-supplied record already carries a `schema` tag, it must match. */
function requireMatchingSchemaTag(input, schema) {
  if (input && Object.prototype.hasOwnProperty.call(input, "schema") && input.schema != null && input.schema !== schema) {
    throw new TypeError(`expected schema ${schema}, got ${JSON.stringify(input.schema)}`);
  }
}

function boundedOpaqueSection(value, field, maxJsonLength = 20_000) {
  if (value == null) return null;
  let json;
  try {
    json = JSON.stringify(value);
  } catch {
    throw new TypeError(`${field} must be JSON-serializable`);
  }
  if (json.length > maxJsonLength) throw new TypeError(`${field} exceeds ${maxJsonLength} bytes`);
  return Object.freeze(JSON.parse(json));
}

/**
 * Scan free text for a forbidden filing-observation synonym. Not wired into
 * every free-text field automatically (legitimate legal citations can
 * legitimately contain "review" in an unrelated procedural sense) -- it is a
 * reusable guard plus the primitive the module's own self-check test uses to
 * confirm no enum this module exports ever equals a forbidden word.
 */
export function assertNoForbiddenFilingObservationSynonym(value, field = "value") {
  const text = String(value ?? "").toLowerCase();
  for (const word of FORBIDDEN_FILING_OBSERVATION_SYNONYMS) {
    if (new RegExp(`\\b${word}\\b`).test(text)) {
      throw new TypeError(`${field} must not use "${word}" as a synonym for a filing observation`);
    }
  }
  return value;
}

/* ------------------------------------------------------------------ */
/* Governing authority                                                 */
/* ------------------------------------------------------------------ */

function buildGoverningAuthorityEntry(value = {}) {
  if (!value || typeof value !== "object") throw new TypeError("governing_authority[] entry must be an object");
  return Object.freeze({
    law_uri: requireString(value.law_uri, "governing_authority[].law_uri", 2_000),
    title: requireString(value.title, "governing_authority[].title", 300),
    operative_interval: Object.freeze({
      from: optionalTimestamp(value.operative_interval?.from, "governing_authority[].operative_interval.from"),
      to: optionalTimestamp(value.operative_interval?.to, "governing_authority[].operative_interval.to"),
    }),
    observed_version: value.observed_version == null ? null : clean(value.observed_version, 200),
    retrieval_receipt: value.retrieval_receipt == null ? null : clean(value.retrieval_receipt, 500),
  });
}

/**
 * The RER governing-authority entry as the LDP-22 census actually measured
 * it: Admin Code 25-118's primary text returned HTTP 403 (Cloudflare), so
 * the exact operative-date boundary and text version stay unknown rather
 * than guessed. Reuses LDP-22's constants instead of re-declaring the
 * citation, per the commission's "extend existing contracts" instruction.
 */
export function racialEquityReportGoverningAuthority() {
  return buildGoverningAuthorityEntry({
    law_uri: ADMIN_CODE_25_118_SOURCE.url,
    title: ADMIN_CODE_25_118_SOURCE.title,
    operative_interval: { from: null, to: null },
    observed_version: null,
    retrieval_receipt: null,
  });
}

export const RER_CRITERIA_CHART_CITATION = Object.freeze({
  url: DCP_RER_CRITERIA_SOURCE.url,
  title: DCP_RER_CRITERIA_SOURCE.title,
  names_governing_law: DCP_RER_CRITERIA_SOURCE.names_governing_law,
});

/* ------------------------------------------------------------------ */
/* Applicability + fulfillment + procedural effect                     */
/* ------------------------------------------------------------------ */

function buildApplicabilityCriterion(value = {}) {
  return Object.freeze({
    criterion: requireString(value.criterion, "applicability.criteria[].criterion", 200),
    source_value: value.source_value == null ? null : clean(value.source_value, 500),
    normalized_value: value.normalized_value == null ? null : clean(value.normalized_value, 500),
    state: requireEnum(value.state, FILING_APPLICABILITY_STATES, "applicability.criteria[].state"),
    source_field_or_span: value.source_field_or_span == null ? null : clean(value.source_field_or_span, 500),
    observed_at: requireTimestamp(value.observed_at, "applicability.criteria[].observed_at"),
    confidence: requireEnum(value.confidence, FILING_CONFIDENCE_LEVELS, "applicability.criteria[].confidence"),
  });
}

function buildPublisherAssertion(value) {
  if (value == null) return null;
  return Object.freeze({
    source_field: requireString(value.source_field, "applicability.publisher_assertion.source_field", 200),
    source_value: requireString(value.source_value, "applicability.publisher_assertion.source_value", 500),
    observed_at: requireTimestamp(value.observed_at, "applicability.publisher_assertion.observed_at"),
    source_url: value.source_url == null ? null : clean(value.source_url, 2_000),
  });
}

function buildReconstructedCandidate(value) {
  if (value == null) return null;
  return Object.freeze({
    state: requireEnum(value.state, FILING_APPLICABILITY_STATES, "applicability.reconstructed_candidate.state"),
    method: requireString(value.method, "applicability.reconstructed_candidate.method", 200),
    evidence: Object.freeze((value.evidence || []).map((e) => clean(e, 500))),
    reviewed: value.reviewed === true,
    // Hard invariant, not caller-settable: a reconstructed candidate is never
    // the public applicability state.
    public: false,
  });
}

function buildApplicability(value = {}) {
  const state = requireEnum(value.state, FILING_APPLICABILITY_STATES, "applicability.state");
  const publisherAssertion = buildPublisherAssertion(value.publisher_assertion);
  if ((state === "required" || state === "not_required") && !publisherAssertion) {
    throw new TypeError(
      "applicability.state may be 'required' or 'not_required' only with an explicit " +
      "applicability.publisher_assertion (source_field/source_value/observed_at) -- " +
      "the LDP-22 census found no ZAP field that encodes RER applicability, so absent " +
      "a real publisher assertion the state must stay 'unknown'",
    );
  }
  return Object.freeze({
    state,
    criteria: Object.freeze((value.criteria || []).map(buildApplicabilityCriterion)),
    publisher_assertion: publisherAssertion,
    reconstructed_candidate: buildReconstructedCandidate(value.reconstructed_candidate),
  });
}

function buildFulfillment(value = {}) {
  const state = requireEnum(value.state, FILING_FULFILLMENT_STATES, "fulfillment.state");
  const documentRefs = Object.freeze((value.document_refs || []).map((r) => requireString(r, "fulfillment.document_refs[]", 400)));
  if (state === "document_observed" && documentRefs.length === 0) {
    throw new TypeError("fulfillment.state 'document_observed' requires at least one fulfillment.document_refs[] entry");
  }
  if (state === "publisher_identifies_not_timely_filed" && !value.publisher_assertion) {
    throw new TypeError(
      "fulfillment.state 'publisher_identifies_not_timely_filed' requires fulfillment.publisher_assertion " +
      "-- only an explicit publisher statement may produce this state",
    );
  }
  const publisherAssertion = value.publisher_assertion == null ? null : buildPublisherAssertion(value.publisher_assertion);
  return Object.freeze({ state, document_refs: documentRefs, publisher_assertion: publisherAssertion });
}

function buildProceduralEffect(value = {}, obligationType) {
  const certificationBlocker = value.certification_blocker ?? false;
  if (obligationType === "racial_equity_report" && certificationBlocker !== false) {
    throw new TypeError(
      "procedural_effect.certification_blocker must be false for racial_equity_report obligations " +
      "(DCP: failure to submit an RER does not stop certification or referral)",
    );
  }
  const missingReportNotificationRequired = requireEnum(
    value.missing_report_notification_required ?? "unknown",
    ["required", "not_required", "unknown"],
    "procedural_effect.missing_report_notification_required",
  );
  return Object.freeze({
    certification_blocker: certificationBlocker === true,
    missing_report_notification_required: missingReportNotificationRequired,
    legal_basis: value.legal_basis == null ? null : clean(value.legal_basis, 500),
  });
}

/* ------------------------------------------------------------------ */
/* cityscroll.land_use_filing_obligation.v1                           */
/* ------------------------------------------------------------------ */

export function landUseFilingObligationId({ project_ref, obligation_type }) {
  const p = projectRefToken(project_ref);
  const t = requireEnum(obligation_type, FILING_OBLIGATION_TYPES, "obligation_type");
  return `land_use_filing_obligation:${p.slice("project:".length)}:${t}`;
}

export function buildLandUseFilingObligation(input = {}) {
  requireMatchingSchemaTag(input, LAND_USE_FILING_OBLIGATION_SCHEMA);
  requireEnum(input.obligation_type, FILING_OBLIGATION_TYPES, "obligation_type");
  const projectRef = projectRefToken(input.project_ref);
  if (!Array.isArray(input.governing_authority) || input.governing_authority.length === 0) {
    throw new TypeError("governing_authority[] requires at least one entry");
  }
  const applicability = buildApplicability(input.applicability);
  const fulfillment = buildFulfillment(input.fulfillment);
  const proceduralEffect = buildProceduralEffect(input.procedural_effect || {}, input.obligation_type);
  return Object.freeze({
    schema: LAND_USE_FILING_OBLIGATION_SCHEMA,
    version: LAND_USE_FILING_OBLIGATION_VERSION,
    obligation_id: requireString(input.obligation_id, "obligation_id", 300),
    project_ref: projectRef,
    obligation_type: input.obligation_type,
    governing_authority: Object.freeze(input.governing_authority.map(buildGoverningAuthorityEntry)),
    applicability,
    fulfillment,
    procedural_effect: proceduralEffect,
    observed_at: requireTimestamp(input.observed_at, "observed_at"),
    available_to_public_at: requireTimestamp(input.available_to_public_at, "available_to_public_at"),
    materialized_at: requireTimestamp(input.materialized_at, "materialized_at"),
    source_id: requireString(input.source_id, "source_id", 200),
    source_record_id: requireString(input.source_record_id, "source_record_id", 300),
    source_vintage: requireTimestamp(input.source_vintage, "source_vintage"),
    normalization_version: requireString(input.normalization_version, "normalization_version", 40),
  });
}

export function validateLandUseFilingObligation(record) {
  buildLandUseFilingObligation(record);
  return true;
}

/* ------------------------------------------------------------------ */
/* cityscroll.land_use_filing_document.v1                             */
/* ------------------------------------------------------------------ */

function buildDocumentClassification(value = {}, documentType) {
  const method = requireEnum(value.method, FILING_DOCUMENT_CLASSIFICATION_METHODS, "classification.method");
  const evidence = Object.freeze((value.evidence || []).map((e) => clean(e, 500)));
  if (method !== "unknown" && evidence.length === 0) {
    throw new TypeError("classification.method other than 'unknown' requires at least one classification.evidence[] entry");
  }
  if (documentType !== "unknown" && method === "unknown") {
    throw new TypeError(`document_type ${JSON.stringify(documentType)} requires classification.method other than 'unknown'`);
  }
  if (documentType === "unknown" && method !== "unknown") {
    throw new TypeError("document_type 'unknown' requires classification.method 'unknown'");
  }
  return Object.freeze({
    method,
    evidence,
    confidence: requireEnum(value.confidence ?? "unknown", FILING_CONFIDENCE_LEVELS, "classification.confidence"),
    classifier_version: value.classifier_version == null ? null : clean(value.classifier_version, 40),
  });
}

/**
 * Identity is derived from the project, the publisher's own document id, and
 * the first-observed clock -- never from `original_name`. Two documents that
 * share a name but differ in publisher_document_id (a same-name/different-ID
 * collision) or that are re-observed with new bytes under an unchanged
 * publisher_document_id (a same-name/different-hash re-upload, distinguished
 * by first_observed_at) get distinct ids; a same-name/identical-hash refetch
 * is linked, never erased, via `content_duplicate_of`.
 */
export function landUseFilingDocumentId({ project_ref, publisher_document_id, first_observed_at }) {
  const p = projectRefToken(project_ref);
  const pid = requireString(publisher_document_id, "publisher_document_id", 300);
  const observed = requireTimestamp(first_observed_at, "first_observed_at");
  return `land_use_filing_document:${p.slice("project:".length)}:${encodeURIComponent(pid)}:${encodeURIComponent(observed)}`;
}

export function buildLandUseFilingDocument(input = {}) {
  requireMatchingSchemaTag(input, LAND_USE_FILING_DOCUMENT_SCHEMA);
  requireEnum(input.document_type, FILING_DOCUMENT_TYPES, "document_type");
  if (FILING_DOCUMENT_TYPES_BLOCKED_UNTIL_SEQRA04.includes(input.document_type)) {
    throw new TypeError(
      `document_type ${JSON.stringify(input.document_type)} is blocked until SEQRA-04 lands shared CEQR document-processing ownership`,
    );
  }
  const projectRef = projectRefToken(input.project_ref);
  const publisherDocumentId = requireString(input.publisher_document_id, "publisher_document_id", 300);
  const firstObservedAt = requireTimestamp(input.first_observed_at, "first_observed_at");
  const documentId = landUseFilingDocumentId({
    project_ref: projectRef,
    publisher_document_id: publisherDocumentId,
    first_observed_at: firstObservedAt,
  });
  const classification = buildDocumentClassification(input.classification, input.document_type);

  let versionOrdinal = null;
  if (input.version_ordinal != null) {
    const n = Number(input.version_ordinal);
    if (!Number.isInteger(n) || n < 1) throw new TypeError("version_ordinal must be a positive integer");
    versionOrdinal = n;
  }

  const supersedes = input.supersedes == null ? null : requireString(input.supersedes, "supersedes", 400);
  if (supersedes === documentId) throw new TypeError("a document cannot supersede itself");
  const supersessionBasis = supersedes ? requireString(input.supersession_basis, "supersession_basis", 500) : null;

  const contentDuplicateOf = input.content_duplicate_of == null ? null : requireString(input.content_duplicate_of, "content_duplicate_of", 400);
  if (contentDuplicateOf === documentId) throw new TypeError("a document cannot be a content duplicate of itself");

  let bytesSha256 = null;
  if (input.bytes_sha256 != null) {
    const h = clean(input.bytes_sha256, 64);
    if (!/^[0-9a-f]{64}$/i.test(h)) throw new TypeError("bytes_sha256 must be a 64-character hex digest");
    bytesSha256 = h.toLowerCase();
  }

  let byteLength = null;
  if (input.byte_length != null) {
    const n = Number(input.byte_length);
    if (!Number.isInteger(n) || n < 0) throw new TypeError("byte_length must be a non-negative integer");
    byteLength = n;
  }

  const retrievalStatus = requireEnum(input.retrieval_status, FILING_RETRIEVAL_STATUSES, "retrieval_status");
  if (retrievalStatus === "fetched" && (!bytesSha256 || byteLength == null)) {
    throw new TypeError("retrieval_status 'fetched' requires bytes_sha256 and byte_length");
  }

  return Object.freeze({
    schema: LAND_USE_FILING_DOCUMENT_SCHEMA,
    version: LAND_USE_FILING_DOCUMENT_VERSION,
    document_id: documentId,
    project_ref: projectRef,
    obligation_refs: Object.freeze((input.obligation_refs || []).map((r) => requireString(r, "obligation_refs[]", 400))),
    event_refs: Object.freeze((input.event_refs || []).map((r) => requireString(r, "event_refs[]", 400))),
    document_type: input.document_type,
    publisher_group_id: input.publisher_group_id == null ? null : clean(input.publisher_group_id, 300),
    publisher_group_title: input.publisher_group_title == null ? null : clean(input.publisher_group_title, 500),
    publisher_document_id: publisherDocumentId,
    original_name: requireString(input.original_name, "original_name", 500),
    media_type: input.media_type == null ? null : clean(input.media_type, 120),
    canonical_public_url: input.canonical_public_url == null ? null : clean(input.canonical_public_url, 2_000),
    discovery_endpoint: input.discovery_endpoint == null ? null : clean(input.discovery_endpoint, 2_000),
    publisher_created_at: optionalTimestamp(input.publisher_created_at, "publisher_created_at"),
    first_observed_at: firstObservedAt,
    available_to_public_at: requireTimestamp(input.available_to_public_at, "available_to_public_at"),
    retrieved_at: optionalTimestamp(input.retrieved_at, "retrieved_at"),
    bytes_sha256: bytesSha256,
    byte_length: byteLength,
    retrieval_status: retrievalStatus,
    immutable_receipt: input.immutable_receipt == null ? null : clean(input.immutable_receipt, 500),
    extraction_version: input.extraction_version == null ? null : clean(input.extraction_version, 40),
    ocr_quality: requireEnum(input.ocr_quality ?? "not_applicable", FILING_QUALITY_STATES, "ocr_quality"),
    layout_quality: requireEnum(input.layout_quality ?? "not_applicable", FILING_QUALITY_STATES, "layout_quality"),
    classification,
    version_label: input.version_label == null ? null : clean(input.version_label, 120),
    version_ordinal: versionOrdinal,
    supersedes,
    supersession_basis: supersessionBasis,
    content_duplicate_of: contentDuplicateOf,
  });
}

export function validateLandUseFilingDocument(record) {
  buildLandUseFilingDocument(record);
  return true;
}

/** Documents not superseded by any other document in the given list. */
export function resolveCurrentFilingDocumentVersions(documents = []) {
  const superseded = new Set();
  for (const doc of documents) {
    if (doc?.supersedes) superseded.add(doc.supersedes);
  }
  return Object.freeze(documents.filter((d) => !superseded.has(d.document_id)));
}

/* ------------------------------------------------------------------ */
/* cityscroll.racial_equity_report.v1                                 */
/* ------------------------------------------------------------------ */

const RER_FORBIDDEN_KEYS = Object.freeze([
  "ceqr_ref",
  "is_ceqr",
  "seqra_ref",
  "ceqr_document_link",
  "environmental_review_ref",
]);

function buildPartyRef(value, field) {
  if (value == null) return null;
  if (typeof value === "string") return Object.freeze({ name: requireString(value, `${field}.name`, 300), role: null });
  if (typeof value === "object") {
    return Object.freeze({
      name: requireString(value.name, `${field}.name`, 300),
      role: value.role == null ? null : clean(value.role, 200),
    });
  }
  throw new TypeError(`${field} must be a string or an object with a name`);
}

export function buildRacialEquityReportEnvelope(input = {}) {
  requireMatchingSchemaTag(input, RACIAL_EQUITY_REPORT_SCHEMA);
  for (const key of RER_FORBIDDEN_KEYS) {
    if (Object.prototype.hasOwnProperty.call(input, key)) {
      throw new TypeError(`racial_equity_report envelope must not carry "${key}" -- RER identity is not a CEQR/SEQRA subtype`);
    }
  }
  const documentRef = requireString(input.document_ref, "document_ref", 400);
  if (!documentRef.startsWith("land_use_filing_document:")) {
    throw new TypeError("document_ref must reference a land_use_filing_document id");
  }
  const projectRef = projectRefToken(input.project_ref);

  let reportPreparationDate = null;
  if (input.report_preparation_date != null) {
    const d = clean(input.report_preparation_date, 20);
    if (!/^\d{4}-\d{2}-\d{2}/.test(d)) throw new TypeError("report_preparation_date must be a calendar date");
    reportPreparationDate = d.slice(0, 10);
  }

  const sourceBytesSha256 = requireString(input.source_bytes_sha256, "source_bytes_sha256", 64);
  if (!/^[0-9a-f]{64}$/i.test(sourceBytesSha256)) throw new TypeError("source_bytes_sha256 must be a 64-character hex digest");

  let displacementRisk = null;
  if (input.displacement_risk != null) {
    if (input.displacement_risk.interpretation !== DRI_INTERPRETATION) {
      throw new TypeError(`displacement_risk.interpretation must equal "${DRI_INTERPRETATION}"`);
    }
    displacementRisk = boundedOpaqueSection(input.displacement_risk, "displacement_risk");
  }

  return Object.freeze({
    schema: RACIAL_EQUITY_REPORT_SCHEMA,
    version: RACIAL_EQUITY_REPORT_VERSION,
    document_ref: documentRef,
    project_ref: projectRef,
    applicant: buildPartyRef(input.applicant, "applicant"),
    preparer: buildPartyRef(input.preparer, "preparer"),
    report_preparation_date: reportPreparationDate,
    source_bytes_sha256: sourceBytesSha256.toLowerCase(),
    extraction_version: requireString(input.extraction_version, "extraction_version", 40),
    extraction_quality: requireEnum(input.extraction_quality, FILING_QUALITY_STATES, "extraction_quality"),
    // Reserved sections: typed as bounded opaque JSON only. LDP-25 owns their
    // real per-field schema, extraction, and page/span evidence; this card
    // does not populate or parse report contents.
    application_scope: boundedOpaqueSection(input.application_scope, "application_scope"),
    proposed_development_scope: boundedOpaqueSection(input.proposed_development_scope, "proposed_development_scope"),
    applicability_selections: boundedOpaqueSection(input.applicability_selections, "applicability_selections"),
    executive_summary: boundedOpaqueSection(input.executive_summary, "executive_summary"),
    residential: boundedOpaqueSection(input.residential, "residential"),
    non_residential: boundedOpaqueSection(input.non_residential, "non_residential"),
    construction_employment: boundedOpaqueSection(input.construction_employment, "construction_employment"),
    community_profile: boundedOpaqueSection(input.community_profile, "community_profile"),
    displacement_risk: displacementRisk,
    fair_housing_narrative: boundedOpaqueSection(input.fair_housing_narrative, "fair_housing_narrative"),
    field_evidence: boundedOpaqueSection(input.field_evidence, "field_evidence"),
  });
}

export function validateRacialEquityReportEnvelope(record) {
  buildRacialEquityReportEnvelope(record);
  return true;
}

/* ------------------------------------------------------------------ */
/* Relations                                                           */
/* ------------------------------------------------------------------ */

const REF_PREFIX = Object.freeze({
  project: "project:",
  "land-use-filing-obligation": "land_use_filing_obligation:",
  "land-use-filing-document": "land_use_filing_document:",
});

export const LAND_USE_FILING_RELATIONS = Object.freeze({
  has_filing_obligation: Object.freeze({
    relation: "has_filing_obligation",
    inverse: "obligation_of_project",
    from_kind: "project",
    to_kind: "land-use-filing-obligation",
    negative_rule: "Never mint a filing obligation from a project mention alone; require an obligation envelope with its own source, clock, and applicability contract.",
  }),
  filed_for_project: Object.freeze({
    relation: "filed_for_project",
    inverse: "has_filed_document",
    from_kind: "land-use-filing-document",
    to_kind: "project",
    negative_rule: "Never relate a document to a project by title, address, or applicant resemblance; require the exact ZAP project/document relationship the document was observed under.",
  }),
  satisfies_obligation: Object.freeze({
    relation: "satisfies_obligation",
    inverse: "obligation_evidenced_by_document",
    from_kind: "land-use-filing-document",
    to_kind: "land-use-filing-obligation",
    negative_rule: "Filename similarity alone is insufficient. Records that CityScroll observed this document as the qualifying artifact for the obligation's fulfillment.document_refs; never asserts review, decision, approval, clearance, compliance, or completeness.",
  }),
  published_as_evidence: Object.freeze({
    relation: "published_as_evidence",
    inverse: "obligation_has_published_evidence",
    from_kind: "land-use-filing-document",
    to_kind: "land-use-filing-obligation",
    negative_rule: "A weaker evidentiary link than satisfies_obligation (e.g. a notice or package version relevant to the obligation's procedural context). Never sets fulfillment.state by itself and never implies review, decision, approval, clearance, compliance, or completeness.",
  }),
  supersedes_document: Object.freeze({
    relation: "supersedes_document",
    inverse: "superseded_by_document",
    from_kind: "land-use-filing-document",
    to_kind: "land-use-filing-document",
    negative_rule: "Supersession requires an explicit source-stated basis (a later version number, explicit replacement notice, or publisher relationship); never inferred from name or date proximity alone.",
  }),
});

function relationRefId({ relation, from, to, sourceObservation }) {
  return [
    "land_use_filing_relation",
    relation,
    from,
    to,
    sourceObservation?.source_record_id || "source_missing",
    sourceObservation?.source_field || "field_missing",
  ].map((part) => encodeURIComponent(part)).join(":");
}

function requireRefKind(ref, kind, field) {
  const prefix = REF_PREFIX[kind];
  if (!prefix || !ref.startsWith(prefix)) {
    throw new TypeError(`${field} must be a ${kind} ref (expected prefix "${prefix}"), got ${JSON.stringify(ref)}`);
  }
  return ref;
}

export function buildLandUseFilingRelation(input = {}) {
  requireMatchingSchemaTag(input, LAND_USE_FILING_RELATION_SCHEMA);
  const spec = LAND_USE_FILING_RELATIONS[input.relation];
  if (!spec) throw new TypeError(`unknown land-use filing relation ${JSON.stringify(input.relation)}`);
  const from = requireRefKind(requireString(input.from, "from", 400), spec.from_kind, "from");
  const to = requireRefKind(requireString(input.to, "to", 400), spec.to_kind, "to");
  const status = requireEnum(input.status ?? "accepted", LAND_USE_FILING_RELATION_STATUSES, "status");
  const sourceObservation = input.source_observation == null ? null : Object.freeze({ ...input.source_observation });
  if (status === "accepted") {
    if (!sourceObservation || !clean(sourceObservation.source_field) || !clean(sourceObservation.source_value)) {
      throw new TypeError(
        `${input.relation}: accepted status requires source_observation.source_field and source_observation.source_value -- ` +
        "filename similarity alone is insufficient",
      );
    }
  }
  const observedAt = requireTimestamp(input.observed_at, "observed_at");
  const asOf = optionalTimestamp(input.as_of, "as_of") || observedAt;
  return Object.freeze({
    schema: LAND_USE_FILING_RELATION_SCHEMA,
    version: LAND_USE_FILING_RELATION_VERSION,
    id: relationRefId({ relation: input.relation, from, to, sourceObservation }),
    relation: input.relation,
    inverse: spec.inverse,
    from,
    to,
    from_kind: spec.from_kind,
    to_kind: spec.to_kind,
    status,
    source_observation: sourceObservation,
    evidence_refs: Object.freeze((input.evidence_refs || []).map((e) => clean(e, 500))),
    confidence: requireEnum(input.confidence ?? "unknown", FILING_CONFIDENCE_LEVELS, "confidence"),
    basis: input.basis == null ? null : clean(input.basis, 300),
    observed_at: observedAt,
    as_of: asOf,
    vintage: input.vintage == null ? asOf : clean(input.vintage, 80),
    negative_rule: spec.negative_rule,
  });
}

export function validateLandUseFilingRelation(record) {
  buildLandUseFilingRelation(record);
  return true;
}

/* ------------------------------------------------------------------ */
/* As-of projector                                                     */
/* ------------------------------------------------------------------ */

function isVisibleAt(clockValue, cutoffMs) {
  if (!clockValue) return false;
  const t = Date.parse(clockValue);
  return Number.isFinite(t) && t <= cutoffMs;
}

/**
 * Filter obligations/documents/relations to what was publicly available at
 * `cutoff`. No later clock backfills an earlier one: a document is visible
 * only once its own available_to_public_at has passed; a relation is visible
 * only once its own observed_at has passed AND both endpoints it names are
 * themselves already visible at the same cutoff.
 */
export function projectLandUseFilingAsOf({ obligations = [], documents = [], relations = [], cutoff } = {}) {
  const cutoffStamp = requireTimestamp(cutoff, "cutoff");
  const cutoffMs = Date.parse(cutoffStamp);

  const visibleObligations = obligations.filter((o) => isVisibleAt(o.available_to_public_at, cutoffMs));
  const visibleDocuments = documents.filter((d) => isVisibleAt(d.available_to_public_at, cutoffMs));
  const visibleObligationIds = new Set(visibleObligations.map((o) => o.obligation_id));
  const visibleDocumentIds = new Set(visibleDocuments.map((d) => d.document_id));

  const endpointVisible = (ref) => {
    if (ref.startsWith(REF_PREFIX["land-use-filing-obligation"])) return visibleObligationIds.has(ref);
    if (ref.startsWith(REF_PREFIX["land-use-filing-document"])) return visibleDocumentIds.has(ref);
    return true; // project refs carry no separate as-of clock in this contract
  };

  const visibleRelations = relations.filter((r) => (
    isVisibleAt(r.observed_at, cutoffMs) && endpointVisible(r.from) && endpointVisible(r.to)
  ));

  return Object.freeze({
    cutoff: cutoffStamp,
    obligations: Object.freeze(visibleObligations),
    documents: Object.freeze(visibleDocuments),
    relations: Object.freeze(visibleRelations),
  });
}
