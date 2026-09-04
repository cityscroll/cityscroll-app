import {
  FEDERATED_SEARCH_CAPABILITY_REFERENCE,
  FEDERATED_SEARCH_LIMITS,
  normalizeFederatedSearchScope,
} from "../capabilities/federated_search.mjs";

const SEARCH_TIMEOUT_MS = 12000;

function normalizeQuery(value) {
  return String(value ?? "")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Fetch the public HTTP adapter for search.federated@1. */
export async function fetchFederatedSearch(query, {
  fetcher = globalThis.workerFetch,
  timeoutMs = SEARCH_TIMEOUT_MS,
} = {}) {
  const normalizedQuery = normalizeQuery(query);
  if (!normalizedQuery) throw new TypeError("federated search requires a query");
  if (normalizedQuery.length > FEDERATED_SEARCH_LIMITS.queryMaximumLength) {
    throw new TypeError("federated search query is too long");
  }
  if (typeof fetcher !== "function") throw new Error("federated search client unavailable");

  const response = await fetcher(
    `/search?q=${encodeURIComponent(normalizedQuery)}`,
    null,
    timeoutMs,
  );
  if (!response?.ok) throw new Error(`federated search HTTP ${response?.status || 0}`);
  const payload = await response.json();
  if (!payload || !Array.isArray(payload.results)) {
    throw new Error(`invalid ${FEDERATED_SEARCH_CAPABILITY_REFERENCE} response`);
  }
  return payload.results;
}

/**
 * Build the one request Contracts Browse and the search front door both issue. */
export function scopedFederatedSearchPath(query, lenses = []) {
  const normalizedQuery = normalizeQuery(query);
  if (!normalizedQuery) throw new TypeError("federated search requires a query");
  if (normalizedQuery.length > FEDERATED_SEARCH_LIMITS.queryMaximumLength) {
    throw new TypeError("federated search query is too long");
  }
  const scope = normalizeFederatedSearchScope({ lenses });
  const params = new URLSearchParams();
  params.set("q", normalizedQuery);
  for (const lens of scope.lenses) params.append("scope", lens);
  return `/search?${params.toString()}`;
}

/**
 * The all-sources federation path: the capability's omitted scope, which
 * federates every registered lens plus auxiliary legal-code recall. Scope
 * parameters are deliberately absent — an explicit lens allowlist here would
 * be a different, narrower candidate population.
 */
export function allSourcesFederatedSearchPath(query) {
  const normalizedQuery = normalizeQuery(query);
  if (!normalizedQuery) throw new TypeError("federated search requires a query");
  if (normalizedQuery.length > FEDERATED_SEARCH_LIMITS.queryMaximumLength) {
    throw new TypeError("federated search query is too long");
  }
  return `/search?q=${encodeURIComponent(normalizedQuery)}`;
}

/**
 * Fetch a scoped capability response and return the whole envelope, not just the
 * result array: a form factor that renders coverage needs the coverage receipt,
 * and a caller that must tell a provider failure apart from an empty result
 * needs this to throw rather than resolve empty.
 */
export async function fetchScopedFederatedSearch(query, {
  lenses = [],
  fetcher = globalThis.workerFetch,
  timeoutMs = SEARCH_TIMEOUT_MS,
} = {}) {
  const path = scopedFederatedSearchPath(query, lenses);
  if (typeof fetcher !== "function") throw new Error("federated search client unavailable");
  const response = await fetcher(path, null, timeoutMs);
  if (!response?.ok) throw new Error(`federated search HTTP ${response?.status || 0}`);
  const payload = await response.json();
  if (!payload || !Array.isArray(payload.results)) {
    throw new Error(`invalid ${FEDERATED_SEARCH_CAPABILITY_REFERENCE} response`);
  }
  return payload;
}
