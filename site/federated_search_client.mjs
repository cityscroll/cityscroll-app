import {
  FEDERATED_SEARCH_CAPABILITY_REFERENCE,
  FEDERATED_SEARCH_LIMITS,
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
