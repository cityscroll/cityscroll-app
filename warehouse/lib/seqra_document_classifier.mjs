/**
 * SEQRA-04: document-type and supersession classification (card acceptance
 * A5 -- draft and final documents must order correctly and coexist).
 *
 * Reuses `SEQRA_REVIEW_DOCUMENT_TYPES` and `SEQRA_DOCUMENT_STAGES` from the
 * SEQRA-02 ontology spec rather than declaring a second vocabulary; a
 * classification this module cannot confidently make never invents a type,
 * it reports `document_type: null` with the unmatched evidence so a human
 * (or a later, better classifier) can adjudicate it -- silence, not a guess.
 *
 * Supersession is deliberately conservative, matching the negative rule
 * `ontology/land_use_filing.mjs` already states for its own supersession
 * relation: never inferred from filename or date proximity alone. A
 * candidate final document is linked to a draft only when either (a) its own
 * text explicitly names the draft it supersedes, or (b) it is the same
 * document_type as an existing, not-yet-superseded draft in the same review
 * -- the ontology's own conservative default -- and even then the basis is
 * carried on the result so a caller can distinguish the two confidence
 * levels.
 */
import { SEQRA_DOCUMENT_STAGES, SEQRA_REVIEW_DOCUMENT_TYPES } from "./seqra_ontology_spec.mjs";

export const DOCUMENT_TYPE_CONFIDENCE_LEVELS = Object.freeze(["high", "medium", "low", "unknown"]);
export const SUPERSESSION_BASES = Object.freeze(["explicit_text_reference", "stage_type_pairing", "none"]);

// Ordered so a more specific pattern (e.g. "conditioned negative declaration")
// is tested before a more general one it would otherwise be swallowed by
// (e.g. "negative declaration").
const DOCUMENT_TYPE_PATTERNS = Object.freeze([
  { documentType: "conditioned_negative_declaration", stage: "final", pattern: /conditioned\s+negative\s+declaration|\bcnd\b/i },
  { documentType: "negative_declaration", stage: "final", pattern: /\bnegative\s+declaration\b/i },
  { documentType: "positive_declaration", stage: "final", pattern: /\bpositive\s+declaration\b/i },
  { documentType: "eaf", stage: "draft", pattern: /environmental\s+assessment\s+form|\beaf\b/i },
  { documentType: "eas", stage: "draft", pattern: /environmental\s+assessment\s+statement|\beas\b/i },
  { documentType: "draft_scope", stage: "draft", pattern: /draft\s+scope/i },
  { documentType: "final_scope", stage: "final", pattern: /final\s+scope/i },
  { documentType: "deis", stage: "draft", pattern: /draft\s+environmental\s+impact\s+statement|\bdeis\b/i },
  { documentType: "feis", stage: "final", pattern: /final\s+environmental\s+impact\s+statement|\bfeis\b/i },
  { documentType: "findings", stage: "final", pattern: /\bfindings\s+statement\b|\bstatement\s+of\s+findings\b/i },
  { documentType: "technical_memorandum", stage: "final", pattern: /technical\s+memorandum/i },
  { documentType: "supplemental_eis", stage: "draft", pattern: /supplemental\s+(?:draft\s+)?environmental\s+impact\s+statement|\bseis\b/i },
  { documentType: "comment_letter", stage: "final", pattern: /comment\s+letter/i },
  { documentType: "agency_response", stage: "final", pattern: /agency\s+response|response\s+to\s+comments/i },
  { documentType: "final_determination", stage: "final", pattern: /final\s+determination/i },
]);

function normalizedSample(title, textSample) {
  return `${title ?? ""} ${textSample ?? ""}`.slice(0, 4000);
}

/**
 * Classify a candidate document's type and stage from its title and (when
 * available) a text sample. Never guesses: an unmatched document returns
 * `document_type: null`, `confidence: "unknown"`, and the sample that was
 * searched, so nothing downstream can mistake silence for a positive claim.
 */
export function classifyDocumentType({ title = null, textSample = null } = {}) {
  const haystack = normalizedSample(title, textSample);
  for (const { documentType, stage, pattern } of DOCUMENT_TYPE_PATTERNS) {
    const match = pattern.exec(haystack);
    if (match) {
      return {
        document_type: documentType,
        document_stage: stage,
        confidence: title && pattern.test(title) ? "high" : "medium",
        matched_terms: [match[0]],
      };
    }
  }
  return { document_type: null, document_stage: null, confidence: "unknown", matched_terms: [] };
}

function extractExplicitSupersessionReference(textSample) {
  // e.g. "This Final Environmental Impact Statement supersedes the Draft
  // Environmental Impact Statement issued on March 3, 2024."
  const match = /supersed(?:es|ing)\s+the\s+(draft[^.]{0,120}?)(?:\s+(?:issued|dated|published)\s+on\s+([A-Za-z]+\s+\d{1,2},?\s+\d{4}))?[.,]/i.exec(String(textSample ?? ""));
  if (!match) return null;
  return { referenced_draft_description: match[1].trim(), referenced_draft_date_text: match[2] ?? null };
}

/**
 * Determine whether `candidate` (already run through classifyDocumentType,
 * with document_type/document_stage attached) supersedes one of
 * `existingDocumentsForReview` -- objects carrying at least
 * `document_key`, `document_type`, `document_stage`, `issued_date`, and
 * `superseded_by_document_key` (matching the review_document entity shape).
 *
 * SEQRA_REVIEW_DOCUMENT_TYPES encodes draft/final into the type name itself
 * for some pairs (`deis`/`feis`, `draft_scope`/`final_scope`) rather than
 * carrying one type with a stage flag, so "the same document_type" is the
 * wrong pairing test for those -- a feis never shares a document_type string
 * with the deis it supersedes. This map is the one place that pairing is
 * spelled out explicitly; it is deliberately small (only the pairs the
 * commissioned vocabulary actually names) rather than a heuristic like
 * stripping a "draft"/"final" prefix, so a type this pipeline does not
 * recognize as paired never gets an invented counterpart.
 */
const FINAL_TO_DRAFT_TYPE_PAIRING = Object.freeze({
  feis: "deis",
  final_scope: "draft_scope",
});

export function classifySupersession({ candidate, textSample = null, existingDocumentsForReview = [] } = {}) {
  if (candidate.document_stage !== "final") {
    return { supersedes_document_key: null, basis: "none", confidence: "unknown", reason: "only a final-stage document can supersede a draft" };
  }
  const pairedDraftType = FINAL_TO_DRAFT_TYPE_PAIRING[candidate.document_type] ?? candidate.document_type;

  const explicitRef = extractExplicitSupersessionReference(textSample);
  if (explicitRef) {
    const matchByType = existingDocumentsForReview.find(
      (doc) => doc.document_stage === "draft" && doc.document_type === pairedDraftType && !doc.superseded_by_document_key,
    );
    if (matchByType) {
      return {
        supersedes_document_key: matchByType.document_key,
        basis: "explicit_text_reference",
        confidence: "high",
        reason: `document text explicitly names the draft it supersedes ("${explicitRef.referenced_draft_description}")`,
      };
    }
  }

  const pairedDraft = existingDocumentsForReview
    .filter((doc) => doc.document_stage === "draft" && doc.document_type === pairedDraftType && !doc.superseded_by_document_key)
    .sort((a, b) => (a.issued_date < b.issued_date ? 1 : -1))[0]; // most recent unsuperseded draft of the paired type
  if (pairedDraft) {
    return {
      supersedes_document_key: pairedDraft.document_key,
      basis: "stage_type_pairing",
      confidence: "medium",
      reason: `most recent unsuperseded draft-stage ${pairedDraftType} in the same review`,
    };
  }

  return { supersedes_document_key: null, basis: "none", confidence: "unknown", reason: `no unsuperseded ${pairedDraftType} draft exists in this review` };
}

export { SEQRA_DOCUMENT_STAGES, SEQRA_REVIEW_DOCUMENT_TYPES };
