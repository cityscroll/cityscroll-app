/**
 * Source-independent search projection contract.
 *
 * Producers establish civic meaning before admission. Search may rank an
 * admitted document, but it must not infer an object type from publisher
 * syntax or rewrite the document's classification.
 */

export const SEARCH_DOCUMENT_SCHEMA = "cityscroll.search_document.v1";
export const SEARCH_TEXT_MAX_LENGTH = 8_000;

export const SEARCH_DOCUMENT_OUTCOMES = Object.freeze([
  "indexed",
  "unclassified",
  "unsupported",
  "not_indexed",
  "evidence_only",
]);

export const SEARCH_DOCUMENT_OBJECT_TYPES = Object.freeze([
  "procurement",
  "rulemaking",
  "meeting",
  "mandate",
  "land_use_project",
  "person",
  "official",
  "agency",
  "vendor",
  "committee",
  "community_board",
  "civil_service_exam",
  "parcel",
  "unclassified",
]);

export const SEARCH_DOCUMENT_DOMAINS = Object.freeze([
  "contracts",
  "rules",
  "meetings",
  "mandates",
  "zoning",
  "people",
  "places",
  "staffing",
  "property",
]);

const TYPE_DOMAINS = Object.freeze({
  procurement: Object.freeze(["contracts"]),
  rulemaking: Object.freeze(["rules"]),
  meeting: Object.freeze(["meetings"]),
  mandate: Object.freeze(["mandates"]),
  land_use_project: Object.freeze(["zoning"]),
  person: Object.freeze(["people"]),
  official: Object.freeze(["people"]),
  agency: Object.freeze(["people"]),
  vendor: Object.freeze(["contracts", "people"]),
  committee: Object.freeze(["people", "meetings"]),
  community_board: Object.freeze(["people", "places"]),
  civil_service_exam: Object.freeze(["staffing"]),
  parcel: Object.freeze(["property", "zoning"]),
  unclassified: Object.freeze([]),
});

const SAFE_ROUTE_ROOTS = Object.freeze([
  "/agencies/",
  "/browse/",
  "/committees/",
  "/community-boards/",
  "/contracts/",
  "/exams/",
  "/mandates/",
  "/meetings/",
  "/notices/",
  "/officials/",
  "/parcels/",
  "/people/",
  "/vendors/",
]);

const OUTCOME_SET = new Set(SEARCH_DOCUMENT_OUTCOMES);
const OBJECT_TYPE_SET = new Set(SEARCH_DOCUMENT_OBJECT_TYPES);
const DOMAIN_SET = new Set(SEARCH_DOCUMENT_DOMAINS);

function text(value, max) {
  const normalized = String(value ?? "")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return normalized && normalized.length <= max ? normalized : null;
}

function plainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function immutableCopy(value) {
  if (Array.isArray(value)) return Object.freeze(value.map(immutableCopy));
  if (!plainObject(value)) return value;
  return Object.freeze(Object.fromEntries(
    Object.entries(value).map(([key, nested]) => [key, immutableCopy(nested)]),
  ));
}

function observationRefs(value) {
  if (!Array.isArray(value) || value.length === 0 || value.length > 100) return null;
  const refs = value.map((ref) => text(ref, 240));
  if (refs.some((ref) => !ref) || new Set(refs).size !== refs.length) return null;
  return refs;
}

export function isSafeSearchCanonicalRoute(value, { evidenceOnly = false } = {}) {
  const route = text(value, 600);
  if (!route || !route.startsWith("/") || route.startsWith("//") || route.includes("\\")) return false;
  let parsed;
  try {
    parsed = new URL(route, "https://cityscroll.org");
  } catch {
    return false;
  }
  if (parsed.origin !== "https://cityscroll.org" || parsed.pathname.includes("..")) return false;
  if (!SAFE_ROUTE_ROOTS.some((root) => parsed.pathname.startsWith(root))) return false;
  if (evidenceOnly) return parsed.pathname.startsWith("/notices/");
  return !parsed.pathname.startsWith("/notices/");
}

function validate(candidate, outcome) {
  const errors = [];
  const objectType = text(candidate?.object_type, 80);
  const domain = candidate?.domain == null ? null : text(candidate.domain, 80);
  const refs = observationRefs(candidate?.source_observation_refs);
  const classification = candidate?.classification;
  const provenance = candidate?.provenance;
  const evidenceOnly = outcome === "evidence_only";

  if (candidate?.schema !== SEARCH_DOCUMENT_SCHEMA) errors.push("schema");
  if (!text(candidate?.object_ref, 320)) errors.push("object_ref");
  if (!objectType || !OBJECT_TYPE_SET.has(objectType)) errors.push("object_type");
  if (evidenceOnly) {
    if (objectType !== "unclassified" || domain !== null) errors.push("domain");
  } else if (
    objectType === "unclassified"
    || !domain
    || !DOMAIN_SET.has(domain)
    || !TYPE_DOMAINS[objectType]?.includes(domain)
  ) {
    errors.push("domain");
  }
  if (!isSafeSearchCanonicalRoute(candidate?.canonical_href, { evidenceOnly })) errors.push("canonical_href");
  if (!text(candidate?.title, 500)) errors.push("title");
  if (candidate?.summary != null && !text(candidate.summary, 1_200)) errors.push("summary");
  if (!text(candidate?.search_text, SEARCH_TEXT_MAX_LENGTH)) errors.push("search_text");
  if (!text(candidate?.source_family, 120)) errors.push("source_family");
  if (!refs) errors.push("source_observation_refs");
  if (candidate?.process_role != null && !text(candidate.process_role, 160)) errors.push("process_role");
  if (
    !plainObject(classification)
    || !text(classification.method, 160)
    || !text(classification.basis, 600)
  ) errors.push("classification");
  if (!plainObject(provenance) || !text(provenance.producer, 240)) errors.push("provenance");
  return [...new Set(errors)];
}

function normalizedDocument(candidate) {
  return immutableCopy({
    schema: SEARCH_DOCUMENT_SCHEMA,
    object_ref: text(candidate.object_ref, 320),
    object_type: text(candidate.object_type, 80),
    domain: candidate.domain == null ? null : text(candidate.domain, 80),
    canonical_href: text(candidate.canonical_href, 600),
    title: text(candidate.title, 500),
    summary: candidate.summary == null ? null : text(candidate.summary, 1_200),
    search_text: text(candidate.search_text, SEARCH_TEXT_MAX_LENGTH),
    source_family: text(candidate.source_family, 120),
    source_observation_refs: observationRefs(candidate.source_observation_refs),
    process_role: candidate.process_role == null ? null : text(candidate.process_role, 160),
    classification: {
      method: text(candidate.classification.method, 160),
      basis: text(candidate.classification.basis, 600),
    },
    provenance: candidate.provenance,
  });
}

/**
 * Validate a producer outcome at the only search-index admission boundary.
 * Non-document outcomes remain explicit; invalid attempts never receive an
 * indexed document as a consolation fallback.
 */
export function admitSearchDocument(candidate, { outcome = "indexed" } = {}) {
  if (!OUTCOME_SET.has(outcome)) throw new TypeError(`unknown SearchDocument producer outcome: ${outcome}`);
  if (["unclassified", "unsupported", "not_indexed"].includes(outcome)) {
    return Object.freeze({ outcome, document: null, errors: Object.freeze([]) });
  }

  const errors = validate(candidate, outcome);
  if (errors.length) {
    const failedOutcome = errors.includes("object_type") ? "unclassified" : "not_indexed";
    return Object.freeze({
      outcome: failedOutcome,
      document: null,
      errors: Object.freeze(errors),
    });
  }
  return Object.freeze({
    outcome,
    document: normalizedDocument(candidate),
    errors: Object.freeze([]),
  });
}

/** Rank validated documents without exposing mutable classification state. */
export function rankSearchDocuments(candidates, scoreFor) {
  if (!Array.isArray(candidates) || typeof scoreFor !== "function") {
    throw new TypeError("rankSearchDocuments requires candidates and a score function");
  }
  const scored = candidates.map((candidate, index) => {
    const admitted = admitSearchDocument(candidate, { outcome: "indexed" });
    if (!admitted.document) {
      throw new TypeError(`search ranking requires a validated SearchDocument at index ${index}`);
    }
    const score = Number(scoreFor(admitted.document));
    return { document: admitted.document, score: Number.isFinite(score) ? score : Number.NEGATIVE_INFINITY, index };
  });
  scored.sort((left, right) => (
    right.score - left.score
    || left.document.object_ref.localeCompare(right.document.object_ref, "en-US")
    || left.index - right.index
  ));
  return Object.freeze(scored.map(({ document }) => document));
}
