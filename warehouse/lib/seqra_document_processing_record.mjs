/**
 * SEQRA-04: the per-document processing record.
 *
 * Sits alongside SEQRA-02's minimal `review_document` ontology entity
 * (warehouse/lib/seqra_ontology_spec.mjs) rather than extending it: that
 * entity is deliberately identity/shape-only (a later card's adapter
 * populates it), so this module carries everything SEQRA-04 itself adds --
 * the fetch receipt reference, per-page extraction and quality results, and
 * the classification/supersession outcome -- as its own versioned record,
 * addressable by the same `document_key`
 * (warehouse/lib/seqra_stable_keys.mjs#buildReviewDocumentKey).
 *
 * Reuses `FILING_QUALITY_STATES` from ontology/land_use_filing.mjs (LDP-23)
 * for the document-level quality enum rather than declaring a fourth
 * high/medium/low/unknown vocabulary in this codebase, since LDP-23's own
 * `land_use_filing_document` entity already carries `ocr_quality` /
 * `layout_quality` fields typed against it and names SEQRA-04 as the owner
 * of `ceqr_document_link` processing.
 *
 * Every page's binding back to this document's own fetch receipt (A2: a
 * parsed page must resolve to immutable stored source bytes) is validated by
 * the publisher-neutral extraction receipt
 * (warehouse/lib/document_processing.mjs#buildExtractionReceipt, LDP-33)
 * rather than a private copy of that check; this module supplies its own
 * `documentKey` as the receipt's document identity and layers its
 * SEQRA-specific fields (review_key, document_type, supersession) on top.
 *
 * Structural guarantee for the commission's negative rule ("do not let a
 * document model emit a lawsuit score directly from raw pages"): this
 * module's record shape carries an extraction-*quality* score (A3 requires
 * OCR/extraction quality to be measured) but no litigation-outcome field of
 * any kind -- no lawsuit/challenge/legal-risk score, probability, or
 * prediction. `assertNoLawsuitScoreField` checks every key this module ever
 * emits against that litigation-specific vocabulary, not against the word
 * "score" in general, so it can never be satisfied by simply renaming a
 * quality score while still smuggling in a litigation-outcome field under a
 * different name from that vocabulary.
 */
import { buildExtractionReceipt } from "./document_processing.mjs";
import { FILING_QUALITY_STATES } from "../../ontology/land_use_filing.mjs";

export const SEQRA_DOCUMENT_PROCESSING_RECORD_SCHEMA = "cityscroll.seqra_document_processing_record.v1";

// Deliberately specific to litigation-outcome vocabulary, not a bare "score"
// match -- this record legitimately carries an extraction *quality* score
// (A3), which must never be flagged by this guard.
const FORBIDDEN_FIELD_NAME_PATTERN = /lawsuit|litigation|legal_?risk|article_?78_?risk|challenge_?(probability|score|risk)|filing_?probability|case_outcome/i;

function requireNonEmptyString(value, field) {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${field} is required and must be a non-empty string`);
  return value;
}

function requireEnum(value, allowed, field) {
  if (!allowed.includes(value)) throw new Error(`${field} must be one of ${allowed.join("|")}, got ${JSON.stringify(value)}`);
  return value;
}

/** Recursively assert no key in `obj` matches a forbidden scoring/prediction name. */
export function assertNoLawsuitScoreField(obj, pathPrefix = "") {
  if (!obj || typeof obj !== "object") return;
  for (const [key, value] of Object.entries(obj)) {
    if (FORBIDDEN_FIELD_NAME_PATTERN.test(key)) {
      throw new Error(`document processing record must never carry a scoring/prediction field (found "${pathPrefix}${key}")`);
    }
    if (value && typeof value === "object") assertNoLawsuitScoreField(value, `${pathPrefix}${key}.`);
  }
}

export function buildDocumentProcessingRecord({
  documentKey,
  reviewKey,
  fetchId,
  contentHash,
  rawObjectPath,
  documentType,
  documentStage,
  classificationConfidence,
  classificationMatchedTerms = [],
  supersedesDocumentKey = null,
  supersessionBasis = "none",
  supersessionConfidence = "unknown",
  pages = [],
  extractionQualitySummary,
  processedAt,
} = {}) {
  requireNonEmptyString(documentKey, "documentKey");
  requireNonEmptyString(reviewKey, "reviewKey");
  requireNonEmptyString(fetchId, "fetchId");
  requireNonEmptyString(contentHash, "contentHash");
  requireNonEmptyString(rawObjectPath, "rawObjectPath");
  requireNonEmptyString(processedAt, "processedAt");
  requireEnum(extractionQualitySummary.overall_quality_state, FILING_QUALITY_STATES, "extractionQualitySummary.overall_quality_state");

  const extractionReceipt = buildExtractionReceipt({ documentId: documentKey, fetchId, contentHash, pages });

  const record = Object.freeze({
    schema: SEQRA_DOCUMENT_PROCESSING_RECORD_SCHEMA,
    document_key: documentKey,
    review_key: reviewKey,
    fetch_id: fetchId,
    content_hash: contentHash,
    raw_object_path: rawObjectPath,
    document_type: documentType,
    document_stage: documentStage,
    classification_confidence: classificationConfidence,
    classification_matched_terms: Object.freeze([...classificationMatchedTerms]),
    supersedes_document_key: supersedesDocumentKey,
    supersession_basis: supersessionBasis,
    supersession_confidence: supersessionConfidence,
    pages: extractionReceipt.pages,
    extraction_quality: Object.freeze({ ...extractionQualitySummary }),
    processed_at: processedAt,
  });
  assertNoLawsuitScoreField(record);
  return record;
}

export { FILING_QUALITY_STATES };
