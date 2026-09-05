/**
 * LDP-27: the bounded, resident-facing filing-evidence product for one
 * land-use project -- assembled from already-materialized LDP-23 (obligation),
 * LDP-24 (document manifest), LDP-25 (RER extraction envelope), and LDP-26
 * (filing sequence) records. This module builds no collector, extracts
 * nothing, and fetches nothing: every function here is a pure projection over
 * already-assembled plain objects (fixtures in tests, or a build-time tool's
 * already-loaded warehouse records).
 *
 * Like its Node-only sibling `land_authority_summary.mjs`, this file lives
 * beside the resident-facing view modules by convention but is never part of
 * the browser's own module graph -- only `land_filing_evidence_view.mjs` and
 * `app/land_filing_report_runtime.mjs` are fetched by the site, and neither
 * imports `ontology/` or `warehouse/` directly. This module is the one place
 * allowed to do so, at build time, producing the already-shaped JSON those
 * two view modules read.
 *
 * Every key here stays inside filing evidence. This module never reads or
 * writes an authority_summary, an environmental/CEQR projection, or a
 * Commission-outcome record -- the filing, environmental review,
 * authority/decision, and final Commission outcome are kept semantically
 * separate by construction (A4): nothing this module returns can be mistaken
 * for one of those other three surfaces.
 */
import {
  FILING_APPLICABILITY_STATES,
  FILING_FULFILLMENT_STATES,
  FILING_QUALITY_STATES,
  assertNoForbiddenFilingObservationSynonym,
  resolveCurrentFilingDocumentVersions,
} from "../ontology/land_use_filing.mjs";
import { buildFilingSequenceDigest } from "../warehouse/lib/land_filing_sequence.mjs";
import {
  FILING_EVIDENCE_SEARCH_FILTERS,
  landFilingApplicabilityExplanationKey,
  landFilingFulfillmentExplanationKey,
} from "./land_filing_evidence_facet.mjs";

export const LAND_FILING_EVIDENCE_SUMMARY_SCHEMA = "cityscroll.land_filing_evidence_summary.v1";
export const LAND_FILING_EVIDENCE_REPORT_DETAIL_SCHEMA = "cityscroll.land_filing_evidence_report_detail.v1";

function requireEnum(value, allowed, field) {
  if (!allowed.includes(value)) {
    throw new TypeError(`${field} must be one of ${allowed.join("|")}, got ${JSON.stringify(value)}`);
  }
  return value;
}

export {
  FILING_EVIDENCE_SEARCH_FILTERS,
  landFilingApplicabilityExplanationKey,
  landFilingFulfillmentExplanationKey,
};

function documentOriginalLink(document) {
  if (!document) return null;
  return Object.freeze({
    canonical_public_url: document.canonical_public_url ?? null,
    discovery_endpoint: document.discovery_endpoint ?? null,
    original_name: document.original_name ?? null,
    ocr_quality: document.ocr_quality ?? "not_applicable",
    layout_quality: document.layout_quality ?? "not_applicable",
  });
}

/**
 * The current (non-superseded) racial_equity_report document this
 * obligation's fulfillment names, if any -- never picked by filename or
 * title resemblance, only by the obligation's own `fulfillment.document_refs`.
 */
function currentReportDocument(obligation, documents) {
  const refs = new Set(obligation?.fulfillment?.document_refs || []);
  if (refs.size === 0) return null;
  const candidates = documents.filter((d) => d.document_type === "racial_equity_report" && refs.has(d.document_id));
  const current = resolveCurrentFilingDocumentVersions(candidates);
  return current[0] ?? candidates[0] ?? null;
}

function buildReportSummary({ document, rerEnvelope }) {
  if (!document) return null;
  return Object.freeze({
    document_ref: document.document_id,
    report_preparation_date: rerEnvelope?.report_preparation_date ?? null,
    extraction_quality: requireEnum(
      rerEnvelope?.extraction_quality ?? "unknown",
      FILING_QUALITY_STATES,
      "report.extraction_quality",
    ),
    field_extraction_summary: rerEnvelope?.field_evidence
      ? Object.freeze({
        field_count: rerEnvelope.field_evidence.field_count,
        abstained_count: rerEnvelope.field_evidence.abstained_count,
        abstention_ratio: rerEnvelope.field_evidence.abstention_ratio,
        overall_quality: rerEnvelope.field_evidence.overall_quality,
      })
      : null,
    first_observed_at: document.first_observed_at,
    available_to_public_at: document.available_to_public_at,
    version_ordinal: document.version_ordinal,
    original_document: documentOriginalLink(document),
  });
}

/**
 * The bounded "Application filings" product for one project (A1, A2, A3,
 * A4, A9). Returns `null` when there is no obligation record at all -- an
 * older or out-of-scope project renders with no filing-evidence section
 * rather than a synthesized "unknown" one (A9's nullable-record guarantee).
 */
export function buildLandFilingEvidenceSummary({
  obligation = null,
  documents = [],
  sequence = null,
  materializedAt,
} = {}) {
  if (!obligation) return null;
  const document = currentReportDocument(obligation, documents);
  const summary = {
    schema: LAND_FILING_EVIDENCE_SUMMARY_SCHEMA,
    project_ref: obligation.project_ref,
    obligation_id: obligation.obligation_id,
    applicability: Object.freeze({
      state: requireEnum(obligation.applicability.state, FILING_APPLICABILITY_STATES, "applicability.state"),
      criteria_count: obligation.applicability.criteria.length,
      publisher_asserted: obligation.applicability.publisher_assertion != null,
    }),
    fulfillment: Object.freeze({
      state: requireEnum(obligation.fulfillment.state, FILING_FULFILLMENT_STATES, "fulfillment.state"),
      document_refs: obligation.fulfillment.document_refs,
      publisher_asserted: obligation.fulfillment.publisher_assertion != null,
    }),
    procedural_effect: obligation.procedural_effect,
    report: null,
    filing_history_digest: sequence ? buildFilingSequenceDigest(sequence) : null,
    materialized_at: materializedAt ?? null,
  };
  return Object.freeze(summary);
}

/**
 * Attaches `report` once the matching document/RER envelope for this
 * obligation are known -- kept as a second step (rather than folded into
 * `buildLandFilingEvidenceSummary`) so a caller with only the obligation
 * (no document manifest joined yet) still gets a valid, report-less summary
 * instead of an error.
 */
export function withLandFilingEvidenceReport(summary, { obligation, documents = [], rerEnvelope = null } = {}) {
  if (!summary) return summary;
  const document = currentReportDocument(obligation, documents);
  return Object.freeze({ ...summary, report: buildReportSummary({ document, rerEnvelope }) });
}

/**
 * The route-lazy structured detail view (A1, A7): every RER section this
 * card's ontology owns, bounded exactly as LDP-25 built it (no re-parsing,
 * no re-extraction), plus the original document link. Never includes
 * anything from environmental review, authority/decision, or the Commission
 * outcome.
 */
export function buildLandFilingEvidenceReportDetail({ document, rerEnvelope } = {}) {
  if (!document || !rerEnvelope) return null;
  if (rerEnvelope.document_ref !== document.document_id) {
    throw new TypeError("buildLandFilingEvidenceReportDetail: rerEnvelope.document_ref must match document.document_id");
  }
  return Object.freeze({
    schema: LAND_FILING_EVIDENCE_REPORT_DETAIL_SCHEMA,
    document_ref: document.document_id,
    project_ref: rerEnvelope.project_ref,
    applicant: rerEnvelope.applicant,
    preparer: rerEnvelope.preparer,
    report_preparation_date: rerEnvelope.report_preparation_date,
    extraction_version: rerEnvelope.extraction_version,
    extraction_quality: rerEnvelope.extraction_quality,
    application_scope: rerEnvelope.application_scope,
    proposed_development_scope: rerEnvelope.proposed_development_scope,
    executive_summary: rerEnvelope.executive_summary,
    residential: rerEnvelope.residential,
    non_residential: rerEnvelope.non_residential,
    construction_employment: rerEnvelope.construction_employment,
    community_profile: rerEnvelope.community_profile,
    displacement_risk: rerEnvelope.displacement_risk,
    fair_housing_narrative: rerEnvelope.fair_housing_narrative,
    field_evidence: rerEnvelope.field_evidence,
    original_document: documentOriginalLink(document),
  });
}

/** Re-exported so tests and build tooling can scan generated copy without a second implementation. */
export { assertNoForbiddenFilingObservationSynonym };
