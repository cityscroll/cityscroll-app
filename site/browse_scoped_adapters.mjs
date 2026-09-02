/**
 * Shared source-adapter boundary for keyword Browse paths.
 *
 * The capability answers one bounded lexical question. Each Browse surface
 * then projects those candidates into its retained typed read model. This
 * module deliberately does not apply geography, time, status, facet, or
 * analytical-join rules: those constraints remain local and are named in the
 * registered scope metadata instead of being silently dropped.
 */

import {
  FEDERATED_SEARCH_CAPABILITY_REFERENCE,
  FEDERATED_SEARCH_LIMITS,
  FEDERATED_SEARCH_PRESENTATION_SCOPES,
  validateFederatedSearchOutput,
} from "../capabilities/federated_search.mjs";
import { scopedFederatedSearchPath } from "./federated_search_client.mjs";

export const BROWSE_SCOPED_ADAPTER_SCHEMA = "cityscroll.browse_scoped_adapter.v1";
export const BROWSE_SCOPED_OUTCOMES = Object.freeze([
  "idle", "matched", "empty", "partial", "unavailable",
]);

const DEGRADED_STATES = new Set(["partial", "stale", "not_indexed"]);
const SCOPED_STATES = new Set([
  "matched", "empty", "partial", "stale", "not_indexed", "provider_unavailable",
]);

const SOURCE_FILTER_CONTRACTS = Object.freeze({
  people: Object.freeze({
    keyword: "federated",
    local: Object.freeze(["type", "institution", "role"]),
    unsupported: Object.freeze(["geography", "time", "status"]),
  }),
  property: Object.freeze({
    keyword: "federated",
    local: Object.freeze(["asset", "sale_method", "price", "process", "stage", "geography", "neighborhood"]),
    unsupported: Object.freeze(["parcel_join"]),
  }),
  land: Object.freeze({
    keyword: "federated",
    local: Object.freeze(["status", "stage", "future_action", "procedure", "family", "regulatory_effect", "borough", "district", "address"]),
    unsupported: Object.freeze(["geocode", "map_bounds"]),
  }),
  rules: Object.freeze({
    keyword: "federated",
    local: Object.freeze(["agency", "process", "geography", "lifecycle"]),
    unsupported: Object.freeze(["notice_body_projection"]),
  }),
  meetings: Object.freeze({
    keyword: "federated",
    local: Object.freeze(["time", "geography", "agency", "community_board", "process", "place_group", "analytical_join"]),
    unsupported: Object.freeze(["affected_area_semantics"]),
  }),
  exams: Object.freeze({
    keyword: "federated",
    local: Object.freeze(["interest", "eligibility", "window", "format", "salary_band", "fee_level", "no_experience", "agency_certification"]),
    unsupported: Object.freeze(["application_window_derivation"]),
  }),
});

function clean(value, max = 500) {
  return String(value ?? "")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

function scopeFor(source) {
  const id = clean(source, 80);
  const scope = FEDERATED_SEARCH_PRESENTATION_SCOPES[id];
  if (!scope) throw new TypeError(`unknown registered Browse source scope: ${id}`);
  return scope;
}

export function browseScopedAdapterScope(source) {
  const scope = scopeFor(source);
  const filterContract = SOURCE_FILTER_CONTRACTS[scope.id] || Object.freeze({
    keyword: "federated", local: Object.freeze([]), unsupported: Object.freeze([]),
  });
  return Object.freeze({
    ...scope,
    filter_contract: filterContract,
  });
}

export const BROWSE_SCOPED_ADAPTERS = Object.freeze(Object.fromEntries(
  Object.keys(SOURCE_FILTER_CONTRACTS).map((source) => [source, browseScopedAdapterScope(source)]),
));

export function browseScopedRequest(source, query) {
  const scope = browseScopedAdapterScope(source);
  const normalized = clean(query, FEDERATED_SEARCH_LIMITS.queryMaximumLength);
  if (!normalized) return null;
  return Object.freeze({
    schema: BROWSE_SCOPED_ADAPTER_SCHEMA,
    source: scope.id,
    capability_reference: FEDERATED_SEARCH_CAPABILITY_REFERENCE,
    match_mode: "scoped_keyword",
    query: normalized,
    lenses: Object.freeze([...scope.lenses]),
    path: scopedFederatedSearchPath(normalized, scope.lenses),
    result_bound: FEDERATED_SEARCH_LIMITS.defaultResults,
    filter_contract: scope.filter_contract,
  });
}

export const BROWSE_SCOPED_IDLE = Object.freeze({
  schema: BROWSE_SCOPED_ADAPTER_SCHEMA,
  outcome: "idle",
  source: null,
  capability_reference: FEDERATED_SEARCH_CAPABILITY_REFERENCE,
  query: "",
  requested_lenses: Object.freeze([]),
  documents: Object.freeze([]),
  lens_coverage: Object.freeze([]),
  coverage_reported: false,
  coverage_state: null,
  source_metadata: null,
  as_of: null,
  as_of_by_lens: Object.freeze({}),
  result_bound: null,
  candidate_count: 0,
  fallback: Object.freeze({ used: false, reason: "no_keyword" }),
});

function lensCoverage(payload, lenses) {
  const byLens = payload?.federated?.coverage?.by_lens || payload?.coverage?.by_lens;
  if (!byLens || typeof byLens !== "object") return Object.freeze([]);
  return Object.freeze(lenses.map((lens) => {
    const row = byLens[lens] || {};
    const state = SCOPED_STATES.has(row.state) ? row.state : "not_indexed";
    return Object.freeze({
      lens,
      state,
      participated: row.participated === true,
      reason: clean(row.reason, 240) || null,
      matched_count: Number.isInteger(row.matched_count) ? row.matched_count : null,
      candidate_count: Number.isInteger(row.candidate_count) ? row.candidate_count : null,
      indexed_count: Number.isInteger(row.indexed_count) ? row.indexed_count : null,
      as_of: clean(row.as_of, 80) || null,
      source: clean(row.source, 240) || null,
      method: clean(row.method, 120) || null,
    });
  }));
}

function outcomeFrom(documents, coverage) {
  if (coverage.some((row) => row.state === "provider_unavailable")) return "unavailable";
  if (coverage.some((row) => DEGRADED_STATES.has(row.state))) return "partial";
  return documents.length ? "matched" : "empty";
}

/**
 * Read the outer Worker response or a direct federator envelope. No fields are
 * reconstructed: returned result objects remain the capability's canonical
 * references, evidence, provenance, ranking, and handoff records.
 */
export function browseScopedOutcome(source, payload, request = browseScopedRequest(source, payload?.query)) {
  const scope = browseScopedAdapterScope(source);
  const lenses = Array.isArray(request?.lenses) ? [...request.lenses] : [...scope.lenses];
  const envelope = payload?.federated || payload;
  const valid = envelope?.schema ? validateFederatedSearchOutput(envelope) : null;
  const documents = Object.freeze((Array.isArray(valid?.results) ? valid.results : Array.isArray(payload?.results) ? payload.results : [])
    .filter((document) => scope.domains.some((domain) => document?.domain === domain)));
  const coverage = lensCoverage(payload, lenses);
  const asOfByLens = Object.fromEntries(coverage.map((row) => [row.lens, row.as_of]));
  const outcome = outcomeFrom(documents, coverage);
  const firstDegraded = coverage.find((row) => DEGRADED_STATES.has(row.state) || row.state === "provider_unavailable");
  return Object.freeze({
    schema: BROWSE_SCOPED_ADAPTER_SCHEMA,
    outcome,
    source: scope.id,
    capability_reference: clean(payload?.capability_reference, 120) || FEDERATED_SEARCH_CAPABILITY_REFERENCE,
    query: clean(request?.query || payload?.query?.normalized || payload?.query, 240),
    requested_lenses: Object.freeze(lenses),
    documents,
    lens_coverage: coverage,
    coverage_reported: coverage.length > 0,
    coverage_state: firstDegraded?.state || (documents.length ? "matched" : "empty"),
    source_metadata: scope,
    as_of: coverage.map((row) => row.as_of).filter(Boolean).sort().at(-1) || null,
    as_of_by_lens: Object.freeze(asOfByLens),
    result_bound: request?.result_bound ?? null,
    candidate_count: documents.length,
    fallback: Object.freeze({ used: false, reason: null }),
    bounds: Object.freeze({
      requested: request?.result_bound ?? null,
      returned: documents.length,
      maximum: FEDERATED_SEARCH_LIMITS.maximumResults,
    }),
  });
}

export function browseScopedUnavailable(source, request = null, reason = "provider_unavailable") {
  const scope = browseScopedAdapterScope(source);
  const lenses = request?.lenses || scope.lenses;
  return Object.freeze({
    schema: BROWSE_SCOPED_ADAPTER_SCHEMA,
    outcome: "unavailable",
    source: scope.id,
    capability_reference: FEDERATED_SEARCH_CAPABILITY_REFERENCE,
    query: request?.query || "",
    requested_lenses: Object.freeze([...lenses]),
    documents: Object.freeze([]),
    lens_coverage: Object.freeze(lenses.map((lens) => Object.freeze({
      lens, state: "provider_unavailable", participated: false, as_of: null,
    }))),
    coverage_reported: lenses.length > 0,
    coverage_state: "provider_unavailable",
    source_metadata: scope,
    as_of: null,
    as_of_by_lens: Object.freeze(Object.fromEntries(lenses.map((lens) => [lens, null]))),
    result_bound: request?.result_bound ?? null,
    candidate_count: 0,
    reason: clean(reason, 240) || "provider_unavailable",
    fallback: Object.freeze({ used: false, reason: "transport_or_provider_failure" }),
  });
}

export async function fetchBrowseScoped(source, query, {
  fetcher = globalThis.workerFetch,
  timeoutMs = 12000,
} = {}) {
  const request = browseScopedRequest(source, query);
  if (!request) return BROWSE_SCOPED_IDLE;
  try {
    if (typeof fetcher !== "function") throw new Error("federated search client unavailable");
    const response = await fetcher(request.path, null, timeoutMs);
    if (!response?.ok) throw new Error(`federated search HTTP ${response?.status || 0}`);
    return browseScopedOutcome(source, await response.json(), request);
  } catch (error) {
    return browseScopedUnavailable(source, request, error?.message);
  }
}

/**
 * Select the retained rows represented by scoped documents, preserving the
 * capability rank. On provider failure the caller gets its local snapshot and
 * an explicit `used_fallback` marker; empty remains an empty projection.
 */
export function projectBrowseScopedRows(outcome, localRows, rowReference) {
  const rows = Array.isArray(localRows) ? localRows : [];
  if (!outcome || outcome.outcome === "idle") {
    return Object.freeze({ rows, used_fallback: false, unresolved_refs: Object.freeze([]) });
  }
  if (outcome.outcome === "unavailable") {
    return Object.freeze({ rows, used_fallback: true, unresolved_refs: Object.freeze([]) });
  }
  const index = new Map();
  rows.forEach((row, position) => {
    const refs = Array.isArray(rowReference?.(row)) ? rowReference(row) : [rowReference?.(row)];
    refs.map((ref) => clean(ref, 320)).filter(Boolean).forEach((ref) => {
      if (!index.has(ref)) index.set(ref, { row, position });
    });
  });
  const unresolved = [];
  const projected = [];
  for (const document of outcome.documents) {
    const ref = clean(document?.object_ref, 320);
    const hit = index.get(ref);
    if (!hit) {
      unresolved.push(ref);
      continue;
    }
    projected.push(Object.freeze({
      ...hit.row,
      _scoped_search: Object.freeze({
        object_ref: ref,
        rank: document.rank ?? projected.length + 1,
        match_fields: document.match_fields || [],
        evidence: document.edge_provenance || null,
        provenance: document.provenance || null,
        as_of: outcome.as_of,
      }),
    }));
  }
  return Object.freeze({ rows: Object.freeze(projected), used_fallback: false, unresolved_refs: Object.freeze(unresolved) });
}
