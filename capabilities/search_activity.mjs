/**
 * Search-execution receipt contract — the narrow waist between a completed
 * browser Search and private operational storage.
 *
 * One receipt observes the FINAL rendered result state once. It is not a second
 * search implementation, it never scrapes the DOM, and it never becomes a public
 * surface: every field here is private operational evidence, read back only
 * through an authenticated route.
 *
 * The browser supplies the query, visible outcome, rendered rows, and producer
 * response versions. The Worker supplies (and always owns) identity, received
 * time, network observation, traffic class, retention, and size limits — a
 * submitted value for a Worker-owned field is rejected, never trusted.
 */

export const SEARCH_EXECUTION_RECEIPT_SCHEMA = "cityscroll.search_execution.v1";
export const SEARCH_ACTIVITY_INTAKE_PATH = "/search-activity";
export const SEARCH_ACTIVITY_ADMIN_PATH = "/admin/search-activity";

/** The one canonical Search document a receipt may describe. */
export const SEARCH_ACTIVITY_CANONICAL_SEARCH_PATH = "/search/";

/**
 * Row ceiling. Mirrors the existing renderer limits (keyword RESULT_LIMIT 100 plus
 * the bounded semantic candidate set of 20). A longer list is a malformed claim
 * about what a reader saw, not a larger diagnostic sample.
 */
export const SEARCH_ACTIVITY_MAX_RESULT_ROWS = 120;
export const SEARCH_ACTIVITY_MAX_REQUEST_BYTES = 32_768;
export const SEARCH_ACTIVITY_MAX_QUERY_LENGTH = 240;
export const SEARCH_ACTIVITY_RETENTION_DAYS = 30;

export const SEARCH_ACTIVITY_OUTCOME_STATES = Object.freeze([
  "matched",
  "partial",
  "empty",
  "unavailable",
]);

/** Result families the canonical Search document renders into visible lanes. */
export const SEARCH_ACTIVITY_FAMILIES = Object.freeze([
  "contracts",
  "people-organizations",
  "land",
  "rules",
  "meetings",
  "exams",
]);

/** Which producer a rendered row came from. */
export const SEARCH_ACTIVITY_ROW_KINDS = Object.freeze(["keyword", "semantic"]);

/** Place-context keys the canonical Search route already carries. */
export const SEARCH_ACTIVITY_SCOPE_KEYS = Object.freeze([
  "boro",
  "cd",
  "council",
  "neighborhood",
  "scope",
]);

/**
 * Route roots a rendered canonical link may sit under. Kept in lockstep with the
 * Search document contract's own accepted roots; the receipt tests fail on drift
 * so a widened renderer cannot silently widen what a receipt will store.
 */
export const SEARCH_ACTIVITY_SAFE_LINK_ROOTS = Object.freeze([
  "/administrative-code/",
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
  "/procurements/",
  "/vendors/",
]);

const SUBMISSION_KEYS = Object.freeze([
  "schema",
  "occurred_at",
  "query",
  "search_path",
  "scope",
  "outcome",
  "rendered_count",
  "family_counts",
  "incomplete_families",
  "results",
  "producers",
]);

const QUERY_KEYS = Object.freeze(["raw", "normalized"]);
const ROW_KEYS = Object.freeze([
  "reference",
  "entity_type",
  "family",
  "kind",
  "rank",
  "title",
  "canonical_href",
]);
const PRODUCER_KEYS = Object.freeze([
  "search_method",
  "search_schema",
  "candidates_method",
  "candidates_schema",
]);

const FAMILY_SET = new Set(SEARCH_ACTIVITY_FAMILIES);
const OUTCOME_SET = new Set(SEARCH_ACTIVITY_OUTCOME_STATES);
const ROW_KIND_SET = new Set(SEARCH_ACTIVITY_ROW_KINDS);
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/g;

function plainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/** Collapse control characters and whitespace, then bound the length. */
export function cleanReceiptText(value, max = 500) {
  return String(value ?? "")
    .replace(CONTROL_CHARACTERS, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

function unknownKey(candidate, allowed) {
  return Object.keys(candidate).find((key) => !allowed.includes(key)) || null;
}

function boundedCount(value) {
  return Number.isSafeInteger(value) && value >= 0 && value <= SEARCH_ACTIVITY_MAX_RESULT_ROWS;
}

/**
 * A rendered canonical link must be a same-site absolute path under a known
 * result root. Anything else is a malformed reference, not a smaller receipt.
 */
export function isSafeSearchActivityLink(value) {
  const route = cleanReceiptText(value, 600);
  if (!route || !route.startsWith("/") || route.startsWith("//") || route.includes("\\")) return false;
  let parsed;
  try {
    parsed = new URL(route, "https://cityscroll.org");
  } catch {
    return false;
  }
  if (parsed.origin !== "https://cityscroll.org" || parsed.pathname.includes("..")) return false;
  return SEARCH_ACTIVITY_SAFE_LINK_ROOTS.some((root) => parsed.pathname.startsWith(root));
}

/** ISO-8601 instant in UTC, as epoch milliseconds, or null. */
export function receiptInstant(value) {
  const text = cleanReceiptText(value, 40);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/.test(text)) return null;
  const ms = Date.parse(text);
  return Number.isFinite(ms) ? ms : null;
}

function normalizedQueryPair(candidate) {
  if (!plainObject(candidate)) return { reason: "query" };
  if (unknownKey(candidate, QUERY_KEYS)) return { reason: "unknown_field" };
  const raw = cleanReceiptText(candidate.raw, SEARCH_ACTIVITY_MAX_QUERY_LENGTH);
  const normalized = cleanReceiptText(candidate.normalized, SEARCH_ACTIVITY_MAX_QUERY_LENGTH);
  if (!raw || !normalized) return { reason: "query" };
  return { value: { raw, normalized } };
}

function normalizedScope(candidate) {
  if (candidate == null) return { value: {} };
  if (!plainObject(candidate)) return { reason: "scope" };
  if (unknownKey(candidate, SEARCH_ACTIVITY_SCOPE_KEYS)) return { reason: "unknown_field" };
  const scope = {};
  for (const key of SEARCH_ACTIVITY_SCOPE_KEYS) {
    if (!Object.hasOwn(candidate, key)) continue;
    const value = cleanReceiptText(candidate[key], 80);
    if (!value) return { reason: "scope" };
    scope[key] = value;
  }
  return { value: scope };
}

function normalizedFamilyCounts(candidate) {
  if (candidate == null) return { value: {} };
  if (!plainObject(candidate)) return { reason: "family_counts" };
  if (unknownKey(candidate, SEARCH_ACTIVITY_FAMILIES)) return { reason: "unknown_field" };
  const counts = {};
  for (const [family, value] of Object.entries(candidate)) {
    if (!FAMILY_SET.has(family) || !boundedCount(value)) return { reason: "family_counts" };
    counts[family] = value;
  }
  return { value: counts };
}

function normalizedIncompleteFamilies(candidate) {
  if (candidate == null) return { value: [] };
  if (!Array.isArray(candidate) || candidate.length > SEARCH_ACTIVITY_FAMILIES.length) {
    return { reason: "incomplete_families" };
  }
  const families = [];
  for (const raw of candidate) {
    const family = cleanReceiptText(raw, 80);
    if (!FAMILY_SET.has(family) || families.includes(family)) return { reason: "incomplete_families" };
    families.push(family);
  }
  return { value: families };
}

function normalizedRow(candidate, expectedRank) {
  if (!plainObject(candidate)) return { reason: "result_row" };
  if (unknownKey(candidate, ROW_KEYS)) return { reason: "unknown_field" };
  const reference = cleanReceiptText(candidate.reference, 360);
  const entityType = cleanReceiptText(candidate.entity_type, 80);
  const family = cleanReceiptText(candidate.family, 80);
  const kind = cleanReceiptText(candidate.kind, 40);
  const title = cleanReceiptText(candidate.title, 500);
  const canonicalHref = cleanReceiptText(candidate.canonical_href, 600);
  if (!reference || !entityType || !title) return { reason: "result_row" };
  if (!FAMILY_SET.has(family) || !ROW_KIND_SET.has(kind)) return { reason: "result_row" };
  if (candidate.rank !== expectedRank) return { reason: "result_rank" };
  // A keyword row is only ever rendered behind a canonical link, so a missing one
  // means the submission does not describe the visible page. A bounded-source
  // passage can legitimately render without one; anything present must still be safe.
  if (!canonicalHref && kind === "semantic" && candidate.canonical_href == null) {
    return {
      value: {
        reference,
        entity_type: entityType,
        family,
        kind,
        rank: expectedRank,
        title,
        canonical_href: null,
      },
    };
  }
  if (!isSafeSearchActivityLink(canonicalHref)) return { reason: "result_reference" };
  return {
    value: {
      reference,
      entity_type: entityType,
      family,
      kind,
      rank: expectedRank,
      title,
      canonical_href: canonicalHref,
    },
  };
}

function normalizedProducers(candidate) {
  const empty = Object.fromEntries(PRODUCER_KEYS.map((key) => [key, null]));
  if (candidate == null) return { value: empty };
  if (!plainObject(candidate)) return { reason: "producers" };
  if (unknownKey(candidate, PRODUCER_KEYS)) return { reason: "unknown_field" };
  const producers = { ...empty };
  for (const key of PRODUCER_KEYS) {
    producers[key] = candidate[key] == null ? null : (cleanReceiptText(candidate[key], 120) || null);
  }
  return { value: producers };
}

/**
 * Validate one browser submission. Strict by construction: unknown fields,
 * excessive result lists, malformed references, and out-of-order ranks are
 * rejected rather than trimmed, so a stored receipt always means what it says.
 *
 * Returns `{ ok: true, value }` or `{ ok: false, reason }`.
 */
export function normalizeSearchExecutionSubmission(input) {
  if (!plainObject(input)) return { ok: false, reason: "not_an_object" };
  if (unknownKey(input, SUBMISSION_KEYS)) return { ok: false, reason: "unknown_field" };
  if (input.schema !== SEARCH_EXECUTION_RECEIPT_SCHEMA) return { ok: false, reason: "schema" };

  const occurredAtMs = receiptInstant(input.occurred_at);
  if (occurredAtMs === null) return { ok: false, reason: "occurred_at" };

  const query = normalizedQueryPair(input.query);
  if (query.reason) return { ok: false, reason: query.reason };

  if (cleanReceiptText(input.search_path, 120) !== SEARCH_ACTIVITY_CANONICAL_SEARCH_PATH) {
    return { ok: false, reason: "search_path" };
  }

  const scope = normalizedScope(input.scope);
  if (scope.reason) return { ok: false, reason: scope.reason };

  const outcome = cleanReceiptText(input.outcome, 40);
  if (!OUTCOME_SET.has(outcome)) return { ok: false, reason: "outcome" };

  const familyCounts = normalizedFamilyCounts(input.family_counts);
  if (familyCounts.reason) return { ok: false, reason: familyCounts.reason };

  const incompleteFamilies = normalizedIncompleteFamilies(input.incomplete_families);
  if (incompleteFamilies.reason) return { ok: false, reason: incompleteFamilies.reason };

  if (!Array.isArray(input.results)) return { ok: false, reason: "results" };
  if (input.results.length > SEARCH_ACTIVITY_MAX_RESULT_ROWS) {
    return { ok: false, reason: "too_many_results" };
  }

  const results = [];
  for (const [index, raw] of input.results.entries()) {
    const row = normalizedRow(raw, index + 1);
    if (row.reason) return { ok: false, reason: row.reason };
    results.push(row.value);
  }

  if (!boundedCount(input.rendered_count) || input.rendered_count !== results.length) {
    return { ok: false, reason: "rendered_count" };
  }
  if ((outcome === "unavailable" || outcome === "empty") && results.length) {
    return { ok: false, reason: "outcome" };
  }
  if (outcome === "matched" && !results.length) return { ok: false, reason: "outcome" };

  for (const family of SEARCH_ACTIVITY_FAMILIES) {
    const rendered = results.filter((row) => row.family === family).length;
    if (rendered !== (familyCounts.value[family] || 0)) return { ok: false, reason: "family_counts" };
  }

  const producers = normalizedProducers(input.producers);
  if (producers.reason) return { ok: false, reason: producers.reason };

  return {
    ok: true,
    value: {
      schema: SEARCH_EXECUTION_RECEIPT_SCHEMA,
      occurred_at: new Date(occurredAtMs).toISOString(),
      query: query.value,
      search_path: SEARCH_ACTIVITY_CANONICAL_SEARCH_PATH,
      scope: scope.value,
      outcome,
      rendered_count: results.length,
      family_counts: familyCounts.value,
      incomplete_families: incompleteFamilies.value,
      results,
      producers: producers.value,
    },
  };
}
