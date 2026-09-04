/**
 * SEQRA-04: CEQR Access's own binding of the publisher-neutral document-type
 * and supersession classifier (warehouse/lib/document_processing.mjs,
 * LDP-33) to this pipeline's vocabulary (card acceptance A5 -- draft and
 * final documents must order correctly and coexist). This module supplies
 * the CEQR/SEQRA document-type patterns and draft/final pairing; the
 * classification engine itself -- pattern matching, supersession-basis
 * precedence, the never-guess default -- lives once, in the shared
 * interface.
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
 * text explicitly names the draft it supersedes, or (b) it is the paired
 * type of an existing, not-yet-superseded draft in the same review -- the
 * ontology's own conservative default -- and even then the basis is carried
 * on the result so a caller can distinguish the two confidence levels.
 */
import {
  classifyDocumentType as classifyDocumentTypeGeneric,
  classifySupersession as classifySupersessionGeneric,
  DOCUMENT_TYPE_CONFIDENCE_LEVELS,
  SUPERSESSION_BASES,
} from "./document_processing.mjs";
import { SEQRA_DOCUMENT_STAGES, SEQRA_REVIEW_DOCUMENT_TYPES } from "./seqra_ontology_spec.mjs";

export { DOCUMENT_TYPE_CONFIDENCE_LEVELS, SUPERSESSION_BASES };

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

/**
 * Classify a candidate document's type and stage from its title and (when
 * available) a text sample, against this pipeline's own CEQR/SEQRA pattern
 * vocabulary. Never guesses: an unmatched document returns
 * `document_type: null`, `confidence: "unknown"`, and no matched terms, so
 * nothing downstream can mistake silence for a positive claim.
 */
export function classifyDocumentType({ title = null, textSample = null } = {}) {
  return classifyDocumentTypeGeneric({ title, textSample, patterns: DOCUMENT_TYPE_PATTERNS });
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
  return classifySupersessionGeneric({
    candidate,
    textSample,
    existingDocumentsForReview,
    pairedDraftTypeOf: (documentType) => FINAL_TO_DRAFT_TYPE_PAIRING[documentType] ?? documentType,
  });
}

export { SEQRA_DOCUMENT_STAGES, SEQRA_REVIEW_DOCUMENT_TYPES };
