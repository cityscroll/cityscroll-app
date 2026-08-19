// Transport-neutral contract for the bounded recent-notice search operation.
// Delivery adapters own their defaults and presentation; the provider owns SQL,
// ranking, fallback, and record serialization.

export const NOTICE_SEARCH_CAPABILITY_ID = "notice.search";
export const NOTICE_SEARCH_CAPABILITY_VERSION = "1.0.0";
export const NOTICE_SEARCH_CAPABILITY_REFERENCE = "notice.search@1";
export const NOTICE_SEARCH_PROVIDER_ID = "worker-d1.notice-search";
export const NOTICE_SEARCH_LIMITS = Object.freeze({
  minimum: 1,
  maximum: 100,
});
export const NOTICE_SEARCH_INPUT_BOUNDS = Object.freeze({
  maximumTermGroups: 64,
  maximumTermsPerGroup: 64,
  maximumTermLength: 500,
});
export const NOTICE_SEARCH_ORDERINGS = Object.freeze([
  "start_date",
  "contract_amount",
  "score",
]);
export const NOTICE_SEARCH_AVAILABILITY = Object.freeze([
  "complete",
  "empty",
  "unavailable",
]);

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const INPUT_FIELDS = new Set([
  "termGroups",
  "section",
  "agency",
  "category",
  "noticeType",
  "minAmount",
  "maxAmount",
  "excludeSpecialCase",
  "excludeRollingDeadlines",
  "openOnly",
  "dueBefore",
  "sinceDate",
  "today",
  "orderBy",
  "limit",
]);

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

export const NOTICE_SEARCH_CAPABILITY = deepFreeze({
  id: NOTICE_SEARCH_CAPABILITY_ID,
  version: NOTICE_SEARCH_CAPABILITY_VERSION,
  reference: NOTICE_SEARCH_CAPABILITY_REFERENCE,
  owner: "notices",
  operation: "read",
  authority: {
    class: "public-read",
    sideEffect: "none",
    approval: "none",
  },
  cost: {
    class: "bounded-d1-read",
    machineFanOut: "low",
  },
  input: {
    schema: "cityscroll.capability.notice_search.input.v1",
    termGroups: "bounded AND-of-OR term arrays",
    limits: NOTICE_SEARCH_LIMITS,
    termBounds: NOTICE_SEARCH_INPUT_BOUNDS,
    orderings: NOTICE_SEARCH_ORDERINGS,
    adapterDefaults: true,
  },
  output: {
    schema: "cityscroll.capability.notice_search.output.v1",
    fields: ["terms_used", "total_matches", "retrieval", "results"],
    availability: NOTICE_SEARCH_AVAILABILITY,
    privateFieldsForbidden: ["_haystack"],
  },
  provenance: {
    recordIdentity: "request_id",
    matchEvidence: "match_provenance",
    rawQueryLogging: false,
  },
  freshness: {
    owner: "D1 notice-mirror read model",
    projection: "adapter-owned",
  },
  provider: {
    id: NOTICE_SEARCH_PROVIDER_ID,
    module: "worker/src/lib/notices.mjs",
    export: "workerD1NoticeSearch",
    store: "Cloudflare D1",
    readModel: "recent notices mirror",
  },
  adapters: [
    {
      id: "worker-http.search.notice-lane@1",
      module: "worker/src/search.mjs",
      kind: "http-lane",
      route: "GET /search",
      surface: "Universal search",
    },
    {
      id: "mcp.search_notices@1",
      module: "worker/src/mcp.mjs",
      kind: "mcp-tool",
      tool: "search_notices",
      route: "POST /mcp",
      surface: "MCP",
    },
  ],
});

function assertNullableString(value, field) {
  if (value !== undefined && value !== null && typeof value !== "string") {
    throw new TypeError(`${field} must be a string or null`);
  }
}

function assertNullableDate(value, field) {
  assertNullableString(value, field);
  if (value === undefined || value === null) return;
  if (!ISO_DATE.test(value)) throw new TypeError(`${field} must be an ISO date`);
  const parsed = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(parsed.valueOf()) || parsed.toISOString().slice(0, 10) !== value) {
    throw new TypeError(`${field} must be an ISO date`);
  }
}

/** Validate the canonical input without normalizing or changing provider semantics. */
export function validateNoticeSearchInput(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new TypeError("notice.search input must be an object");
  }
  for (const field of Object.keys(input)) {
    if (!INPUT_FIELDS.has(field)) throw new TypeError(`unknown notice.search input field: ${field}`);
  }
  const groups = input.termGroups ?? [];
  if (!Array.isArray(groups) || groups.length > NOTICE_SEARCH_INPUT_BOUNDS.maximumTermGroups) {
    throw new TypeError("termGroups exceeds the bounded AND-of-OR contract");
  }
  for (const group of groups) {
    if (!Array.isArray(group) || group.length > NOTICE_SEARCH_INPUT_BOUNDS.maximumTermsPerGroup) {
      throw new TypeError("termGroups exceeds the bounded AND-of-OR contract");
    }
    for (const term of group) {
      if (typeof term !== "string" || term.length > NOTICE_SEARCH_INPUT_BOUNDS.maximumTermLength) {
        throw new TypeError("notice.search terms must be bounded strings");
      }
    }
  }
  for (const field of ["section", "agency", "category", "noticeType"]) {
    assertNullableString(input[field], field);
  }
  for (const field of ["minAmount", "maxAmount"]) {
    const value = input[field];
    if (value !== undefined && value !== null && (typeof value !== "number" || !Number.isFinite(value))) {
      throw new TypeError(`${field} must be a finite number or null`);
    }
  }
  for (const field of ["excludeSpecialCase", "excludeRollingDeadlines", "openOnly"]) {
    if (input[field] !== undefined && typeof input[field] !== "boolean") {
      throw new TypeError(`${field} must be a boolean`);
    }
  }
  for (const field of ["dueBefore", "sinceDate", "today"]) assertNullableDate(input[field], field);
  if (input.orderBy !== undefined && input.orderBy !== null && !NOTICE_SEARCH_ORDERINGS.includes(input.orderBy)) {
    throw new TypeError("orderBy is not a supported notice.search ordering");
  }
  if (
    input.limit !== undefined
    && (!Number.isInteger(input.limit)
      || input.limit < NOTICE_SEARCH_LIMITS.minimum
      || input.limit > NOTICE_SEARCH_LIMITS.maximum)
  ) {
    throw new TypeError(`limit must be an integer from ${NOTICE_SEARCH_LIMITS.minimum} through ${NOTICE_SEARCH_LIMITS.maximum}`);
  }
  return input;
}

/** Validate the existing provider result without cloning or widening it. */
export function validateNoticeSearchOutput(result) {
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    throw new TypeError("notice.search provider must return an object");
  }
  if (!Array.isArray(result.terms_used) || !result.terms_used.every((term) => typeof term === "string")) {
    throw new TypeError("notice.search terms_used must be strings");
  }
  if (!Array.isArray(result.results) || result.results.length > NOTICE_SEARCH_LIMITS.maximum) {
    throw new TypeError("notice.search results exceed the declared bound");
  }
  if (!Number.isInteger(result.total_matches) || result.total_matches !== result.results.length) {
    throw new TypeError("notice.search total_matches must equal the bounded result count");
  }
  const retrieval = result.retrieval;
  if (!retrieval || typeof retrieval !== "object") throw new TypeError("notice.search retrieval is required");
  if (typeof retrieval.method !== "string" || !retrieval.method) {
    throw new TypeError("notice.search retrieval.method is required");
  }
  if (retrieval.fallback_reason !== null && typeof retrieval.fallback_reason !== "string") {
    throw new TypeError("notice.search retrieval.fallback_reason must be a string or null");
  }
  if (typeof retrieval.duration_ms !== "number" || !Number.isFinite(retrieval.duration_ms) || retrieval.duration_ms < 0) {
    throw new TypeError("notice.search retrieval.duration_ms must be a non-negative number");
  }
  if (retrieval.rows_read !== null && (!Number.isFinite(retrieval.rows_read) || retrieval.rows_read < 0)) {
    throw new TypeError("notice.search retrieval.rows_read must be non-negative or null");
  }
  if (!Number.isInteger(retrieval.result_count) || retrieval.result_count !== result.results.length) {
    throw new TypeError("notice.search retrieval.result_count must equal the result count");
  }
  if (result.results.some((record) => record && Object.hasOwn(record, "_haystack"))) {
    throw new TypeError("notice.search results must not expose the private haystack");
  }
  return result;
}

/** Complete and empty are provider results; unavailable remains an adapter-level state. */
export function noticeSearchAvailability(result) {
  validateNoticeSearchOutput(result);
  return result.results.length ? "complete" : "empty";
}

/** Execute one explicit provider. This is deliberately not a service locator. */
export async function executeNoticeSearch(provider, input) {
  validateNoticeSearchInput(input);
  if (
    !provider
    || provider.capabilityReference !== NOTICE_SEARCH_CAPABILITY_REFERENCE
    || provider.providerId !== NOTICE_SEARCH_PROVIDER_ID
    || typeof provider.execute !== "function"
  ) {
    throw new TypeError("notice.search requires the registered explicit provider");
  }
  const result = await provider.execute(input);
  return validateNoticeSearchOutput(result);
}
