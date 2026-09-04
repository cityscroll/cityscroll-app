/**
 * Stable-key functions for the SEQRA/CEQR process ontology (SEQRA-02).
 *
 * Every key builder here is deterministic: the same identity inputs always
 * normalize to the same key, and distinct identity inputs are collision-safe
 * across the CEQR/state-led SEQRA boundary because the regime token is part
 * of the key itself. A builder throws rather than silently generating an
 * unstable key when a required identity input is missing -- an unstable key
 * is worse than a loud failure, because it would let two different reviews
 * collide or one review fragment into two.
 */

import { createHash } from "node:crypto";

export const SEQRA_STABLE_KEY_SCHEMA = "cityscroll.seqra_stable_keys.v1";

// Historical CEQR numbers include both the current `26DCP139X` form and the
// legacy `11-123M` form, matching the normalization already retained by
// warehouse/lib/ceqr_project_milestone_reconciliation.mjs and
// warehouse/lib/zap_environmental_projection.mjs.
const CEQR_NUMBER = /^(?:\d{2}[A-Z]{2,6}\d{2,4}[A-Z]|\d{2}-\d{3}[A-Z])$/;
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

class SeqraStableKeyError extends Error {
  constructor(message) {
    super(message);
    this.name = "SeqraStableKeyError";
  }
}

function requireNonEmptyString(value, fieldName) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new SeqraStableKeyError(`${fieldName} is required and must be a non-empty string`);
  }
  return value.trim();
}

/**
 * Normalize a token for inclusion in a stable key: trim, lowercase, and
 * collapse anything that is not `[a-z0-9]` into a single underscore. This
 * keeps keys collision-resistant against whitespace/case/punctuation
 * variance in source data while remaining a stable, deterministic function
 * of the input (equal inputs after normalization always produce the same
 * token; distinct display strings that normalize the same way are treated
 * as the same identity, which is deliberate for agency/system names).
 */
export function normalizeKeyToken(raw, fieldName) {
  const value = requireNonEmptyString(raw, fieldName);
  const token = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  if (!token) {
    throw new SeqraStableKeyError(`${fieldName} normalized to an empty token`);
  }
  return token;
}

/**
 * Normalize a published CEQR number. Returns null for input that does not
 * match either the current or legacy CEQR number shape -- callers building
 * an `environmental_review:ceqr:*` key must treat a null result as a missing
 * identity input, not silently pass the raw value through.
 */
export function normalizeCeqrNumber(raw) {
  if (raw == null) return null;
  const normalized = String(raw).trim().toUpperCase().replace(/\s+/g, "");
  return CEQR_NUMBER.test(normalized) ? normalized : null;
}

function requireDateOnly(raw, fieldName) {
  const value = requireNonEmptyString(raw, fieldName);
  if (!DATE_ONLY.test(value)) {
    throw new SeqraStableKeyError(`${fieldName} must be an ISO date (YYYY-MM-DD), got ${JSON.stringify(raw)}`);
  }
  return value;
}

function sha256Hex(text) {
  return createHash("sha256").update(text).digest("hex");
}

/**
 * `environmental_review:ceqr:{normalized_ceqr_number}` for a NYC CEQR review,
 * or `environmental_review:seqra:{lead_agency}:{source_review_id_or_hash}`
 * for a state-led SEQRA review. `environmentalRegime` selects the branch and
 * must already be the normalized SEQRA/CEQR value (see
 * warehouse/lib/seqra_scope_classifier.mjs#normalizeEnvironmentalRegimeLabel)
 * -- this function does not itself resolve CEQA or an unlabeled regime, it
 * rejects them.
 *
 * The CEQR and state-led SEQRA branches never collide: they carry distinct
 * literal segments (`ceqr` vs `seqra`) immediately after the entity prefix,
 * so a CEQR number and a SEQRA lead-agency/review-id pair can never resolve
 * to the same key regardless of their normalized text.
 */
export function buildEnvironmentalReviewKey({
  environmentalRegime,
  ceqrNumber = null,
  leadAgency = null,
  sourceReviewId = null,
  sourceReviewIdHashSeed = null,
} = {}) {
  if (environmentalRegime === "CEQR") {
    const normalized = normalizeCeqrNumber(ceqrNumber);
    if (!normalized) {
      throw new SeqraStableKeyError(
        `environmental_review:ceqr key requires a valid ceqrNumber, got ${JSON.stringify(ceqrNumber)}`,
      );
    }
    return `environmental_review:ceqr:${normalized}`;
  }
  if (environmentalRegime === "SEQRA") {
    const agencyToken = normalizeKeyToken(leadAgency, "leadAgency");
    let idToken;
    if (sourceReviewId != null && String(sourceReviewId).trim() !== "") {
      idToken = normalizeKeyToken(sourceReviewId, "sourceReviewId");
    } else if (sourceReviewIdHashSeed != null && String(sourceReviewIdHashSeed).trim() !== "") {
      // A hash-derived id is used only when the source genuinely publishes no
      // stable review identifier; the seed must be a value that is itself
      // stable across re-fetches of the same review (e.g. lead agency +
      // action id + earliest known document date), never a fetch-time value.
      idToken = `h${sha256Hex(String(sourceReviewIdHashSeed)).slice(0, 16)}`;
    } else {
      throw new SeqraStableKeyError(
        "environmental_review:seqra key requires sourceReviewId or sourceReviewIdHashSeed",
      );
    }
    return `environmental_review:seqra:${agencyToken}:${idToken}`;
  }
  throw new SeqraStableKeyError(
    `environmentalRegime must be "SEQRA" or "CEQR" to build an environmental_review key, got ${JSON.stringify(environmentalRegime)}`,
  );
}

/**
 * `organization:{organization_type}:{normalized_name}` for a SEQRA-07
 * institutional actor (organization -> takes_position -> public_position).
 * `organizationType` must already be one of SEQRA_ONTOLOGY's
 * organization_type enum values (this function does not itself classify a
 * raw string into a type; see warehouse/lib/seqra_actor_resolution.mjs).
 * The name token is the caller's already-resolved actor identity (typically
 * entity_resolution/officials/org_resolve.mjs#orgKeyPreferringVendorStem),
 * not the raw source string, so two spellings of one organization normalize
 * to the same key before this builder ever sees them.
 */
export function buildOrganizationKey({ organizationType, resolvedName } = {}) {
  const typeToken = normalizeKeyToken(organizationType, "organizationType");
  const nameToken = normalizeKeyToken(resolvedName, "resolvedName");
  return `organization:${typeToken}:${nameToken}`;
}

/**
 * `public_position:{review_key}:{organization_key}:{observed_date}:{source_hash_prefix}`.
 * The source-hash suffix (derived from sourceRecordId, not fetch-time content)
 * keeps two distinct source records for the same org/review/day from
 * colliding into one position, while remaining a deterministic function of
 * stable identity inputs rather than a fetch-time counter.
 */
export function buildPublicPositionKey({ reviewKey, organizationKey, observedAt, sourceRecordId } = {}) {
  const review = requireNonEmptyString(reviewKey, "reviewKey");
  if (!review.startsWith("environmental_review:")) {
    throw new SeqraStableKeyError(`reviewKey must be an environmental_review stable key, got ${JSON.stringify(reviewKey)}`);
  }
  const org = requireNonEmptyString(organizationKey, "organizationKey");
  if (!org.startsWith("organization:")) {
    throw new SeqraStableKeyError(`organizationKey must be an organization stable key, got ${JSON.stringify(organizationKey)}`);
  }
  const observed = requireNonEmptyString(observedAt, "observedAt");
  const dateToken = observed.slice(0, 10);
  if (!DATE_ONLY.test(dateToken)) {
    throw new SeqraStableKeyError(`observedAt must begin with an ISO date (YYYY-MM-DD), got ${JSON.stringify(observedAt)}`);
  }
  const recordId = requireNonEmptyString(sourceRecordId, "sourceRecordId");
  const hashPrefix = sha256Hex(recordId).slice(0, 12);
  return `public_position:${review}:${org}:${dateToken}:${hashPrefix}`;
}

/** `action:{agency}:{source_system}:{source_action_id}` */
export function buildActionKey({ agency, sourceSystem, sourceActionId } = {}) {
  const agencyToken = normalizeKeyToken(agency, "agency");
  const systemToken = normalizeKeyToken(sourceSystem, "sourceSystem");
  const actionIdToken = normalizeKeyToken(sourceActionId, "sourceActionId");
  return `action:${agencyToken}:${systemToken}:${actionIdToken}`;
}

/** `determination:{agency}:{action_id}:{date}` */
export function buildDeterminationKey({ agency, actionId, date } = {}) {
  const agencyToken = normalizeKeyToken(agency, "agency");
  const actionIdToken = normalizeKeyToken(actionId, "actionId");
  const dateToken = requireDateOnly(date, "date");
  return `determination:${agencyToken}:${actionIdToken}:${dateToken}`;
}

const REVIEW_DOCUMENT_TYPES = new Set([
  "eas",
  "eaf",
  "draft_scope",
  "final_scope",
  "deis",
  "feis",
  "findings",
  "negative_declaration",
  "conditioned_negative_declaration",
  "positive_declaration",
  "technical_memorandum",
  "supplemental_eis",
  "comment_letter",
  "agency_response",
  "final_determination",
]);
export const SEQRA_REVIEW_DOCUMENT_TYPES = Object.freeze([...REVIEW_DOCUMENT_TYPES]);

/** `review_document:{review_key}:{document_type}:{issued_date}:{content_hash_prefix}` */
export function buildReviewDocumentKey({
  reviewKey,
  documentType,
  issuedDate,
  contentHash,
  hashPrefixLength = 12,
} = {}) {
  const key = requireNonEmptyString(reviewKey, "reviewKey");
  if (!key.startsWith("environmental_review:")) {
    throw new SeqraStableKeyError(`reviewKey must be an environmental_review stable key, got ${JSON.stringify(reviewKey)}`);
  }
  const typeToken = requireNonEmptyString(documentType, "documentType").toLowerCase();
  if (!REVIEW_DOCUMENT_TYPES.has(typeToken)) {
    throw new SeqraStableKeyError(
      `documentType ${JSON.stringify(documentType)} is not a recognized SEQRA_REVIEW_DOCUMENT_TYPES value`,
    );
  }
  const dateToken = requireDateOnly(issuedDate, "issuedDate");
  const hashRaw = requireNonEmptyString(contentHash, "contentHash");
  const hex = hashRaw.startsWith("sha256:") ? hashRaw.slice("sha256:".length) : hashRaw;
  if (!/^[a-f0-9]+$/i.test(hex) || hex.length < hashPrefixLength) {
    throw new SeqraStableKeyError(`contentHash must be a hex sha256 digest of at least ${hashPrefixLength} chars, got ${JSON.stringify(contentHash)}`);
  }
  const prefix = hex.slice(0, hashPrefixLength).toLowerCase();
  return `review_document:${key}:${typeToken}:${dateToken}:${prefix}`;
}

export { SeqraStableKeyError };
