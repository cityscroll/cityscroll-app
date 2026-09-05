/**
 * Land Map viewport feasibility gate (LM-18).
 *
 * The Land browse Map is a spatial renderer for the canonical `landSearch()`
 * result, not a map database: List and Map paint the same filtered
 * population, and pan/zoom is reversible presentation state that never
 * changes which projects are in that population (see land_view_state.mjs and
 * scope_v0.mjs, which already keep `view` out of Land watch scope).
 *
 * This module is the boundary for a *future* viewport-driven affordance —
 * "which of these projects are represented in what I'm looking at" — that no
 * card has built yet. It never fetches, searches, or geocodes; it only
 * decides whether a candidate request is even allowed to exist. A request
 * ships only when it either reuses rows the resident's existing Land search
 * already loaded, or compiles exactly to `filterLandSnapshot`'s existing,
 * reviewed filter keys — and even that second path stays stopped until a
 * caller supplies an explicit review flag. Every other shape (a new bounds
 * query, a live GIS call, a geocoder call, a publisher request, or an
 * unreviewed compilation) resolves to a stop.
 */

export const LAND_VIEWPORT_FEASIBILITY_SCHEMA = "cityscroll.land_viewport_feasibility.v1";
export const LAND_VIEWPORT_FEASIBILITY_VERSION = 1;

/**
 * The only Land filter parameter names a viewport action may ever compile
 * to. This is a closed allowlist of `filterLandSnapshot`'s existing option
 * names (site/resident_snapshot_queries.mjs) — not a second copy of Land
 * filter semantics. test/land_viewport_feasibility_gate.test.mjs asserts
 * every name here still appears as a filterLandSnapshot parameter, so this
 * list cannot silently drift from the real filter surface.
 */
export const LAND_CANONICAL_FILTER_KEYS = Object.freeze([
  "status",
  "stage",
  "futureAction",
  "procedure",
  "family",
  "regulatoryEffect",
  "borough",
  "communityDistrict",
  "councilDistrict",
  "keyword",
  "limit",
]);

/** The two request shapes a viewport action can ever take that are even eligible to ship. */
export const LAND_VIEWPORT_REQUEST_KINDS = Object.freeze({
  LOADED_ROWS: "loaded_rows",
  CANONICAL_FILTER_COMPILATION: "canonical_filter_compilation",
  NEW_BOUNDS_QUERY: "new_bounds_query",
  LIVE_GIS_REQUEST: "live_gis_request",
  GEOCODE_REQUEST: "geocode_request",
  PUBLISHER_REQUEST: "publisher_request",
});

const SHIPPABLE_KINDS = new Set([
  LAND_VIEWPORT_REQUEST_KINDS.LOADED_ROWS,
  LAND_VIEWPORT_REQUEST_KINDS.CANONICAL_FILTER_COMPILATION,
]);

const DIRECT_STOP_REASON_BY_KIND = Object.freeze({
  [LAND_VIEWPORT_REQUEST_KINDS.NEW_BOUNDS_QUERY]: "new_search_request",
  [LAND_VIEWPORT_REQUEST_KINDS.LIVE_GIS_REQUEST]: "live_gis_request",
  [LAND_VIEWPORT_REQUEST_KINDS.GEOCODE_REQUEST]: "geocode_request",
  [LAND_VIEWPORT_REQUEST_KINDS.PUBLISHER_REQUEST]: "publisher_request",
});

export const LAND_VIEWPORT_STOP_REASONS = Object.freeze({
  UNKNOWN_REQUEST_KIND: "unknown_request_kind",
  NEW_SEARCH_REQUEST: "new_search_request",
  LIVE_GIS_REQUEST: "live_gis_request",
  GEOCODE_REQUEST: "geocode_request",
  PUBLISHER_REQUEST: "publisher_request",
  UNREVIEWED_COMPILATION: "unreviewed_filter_compilation",
  NONCANONICAL_FILTER_KEY: "noncanonical_filter_key",
  SECOND_SEARCH_DETECTED: "second_search_detected",
  LOADED_ROW_ACCOUNTING_MISMATCH: "loaded_row_accounting_mismatch",
});

/** The only request-sequence entry a shipped action may ever contain: the one canonical search. */
const CANONICAL_SEARCH_ALLOWLIST = Object.freeze(["landSearch"]);

/**
 * Verbatim negative-rule ledger from the LM-18 card, kept as data (not as a
 * scattered set of inline checks) so a test can assert none of them were
 * quietly dropped from what this gate actually enforces.
 */
export const LAND_VIEWPORT_NEGATIVE_RULES = Object.freeze([
  "query_projects_by_viewport",
  "fetch_live_gis",
  "geocode_visible_areas",
  "change_land_search_semantics_from_map_code",
  "add_viewport_to_watches",
  "hide_unloaded_or_unmapped_rows",
  "label_pan_zoom_as_canonical_land_scope_without_review",
]);

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function uniqueSorted(values) {
  return [...new Set(asArray(values).map(String))].sort();
}

/**
 * Reconcile a loaded model's mapped/unmapped accounting against its total.
 * Mirrors LM-08's set-equality invariant: mapped ids plus unmapped ids must
 * union back to exactly the total, with no overlap and nothing left over —
 * the mechanism that makes "hide unloaded or unmapped rows" a detectable
 * mismatch instead of an unverified promise.
 */
function loadedRowAccounting(loadedModel) {
  const total = uniqueSorted(loadedModel?.totalIds);
  const mapped = uniqueSorted(loadedModel?.mappedIds);
  const unmapped = uniqueSorted(loadedModel?.unmappedIds);
  const totalSet = new Set(total);
  const overlap = mapped.filter((id) => unmapped.includes(id));
  const union = uniqueSorted([...mapped, ...unmapped]);
  const reconciled = total.length > 0
    && overlap.length === 0
    && union.length === total.length
    && union.every((id) => totalSet.has(id));
  return { total, mapped, unmapped, reconciled };
}

/**
 * A request sequence is the ordered list of outbound calls a candidate
 * action would make. Anything other than the single existing canonical
 * search — a second search function, a GIS call, a geocode call, a
 * publisher call, or an unnamed request — is a stop.
 */
function requestSequenceStopReason(requestSequence) {
  for (const request of asArray(requestSequence)) {
    const kind = request?.kind;
    if (kind === "canonical_search") {
      if (CANONICAL_SEARCH_ALLOWLIST.includes(request?.name)) continue;
      return LAND_VIEWPORT_STOP_REASONS.SECOND_SEARCH_DETECTED;
    }
    if (kind === "live_gis") return LAND_VIEWPORT_STOP_REASONS.LIVE_GIS_REQUEST;
    if (kind === "geocode") return LAND_VIEWPORT_STOP_REASONS.GEOCODE_REQUEST;
    if (kind === "publisher") return LAND_VIEWPORT_STOP_REASONS.PUBLISHER_REQUEST;
    return LAND_VIEWPORT_STOP_REASONS.SECOND_SEARCH_DETECTED;
  }
  return null;
}

/**
 * Decide whether a candidate viewport action may ship, or must resolve to a
 * stop. Pure: it reads only its arguments, issues no request, and mutates
 * nothing.
 *
 * @param {{
 *   requestedKind?: string,
 *   compiledFilterKeys?: string[],
 *   reviewed?: boolean,
 *   loadedModel?: {totalIds?: unknown[], mappedIds?: unknown[], unmappedIds?: unknown[]},
 *   requestSequence?: Array<{kind: string, name?: string}>,
 * }} input
 * @returns {{outcome: "ship"|"stop", requested_kind: string|null, reason?: string, [key: string]: unknown}}
 */
export function evaluateLandViewportFeasibility({
  requestedKind,
  compiledFilterKeys = [],
  reviewed = false,
  loadedModel = null,
  requestSequence = [],
} = {}) {
  if (!SHIPPABLE_KINDS.has(requestedKind)) {
    return {
      outcome: "stop",
      requested_kind: requestedKind ?? null,
      reason: DIRECT_STOP_REASON_BY_KIND[requestedKind] || LAND_VIEWPORT_STOP_REASONS.UNKNOWN_REQUEST_KIND,
    };
  }

  const sequenceStopReason = requestSequenceStopReason(requestSequence);
  if (sequenceStopReason) {
    return { outcome: "stop", requested_kind: requestedKind, reason: sequenceStopReason };
  }

  const accounting = loadedRowAccounting(loadedModel);
  if (!accounting.reconciled) {
    return {
      outcome: "stop",
      requested_kind: requestedKind,
      reason: LAND_VIEWPORT_STOP_REASONS.LOADED_ROW_ACCOUNTING_MISMATCH,
      accounting,
    };
  }

  if (requestedKind === LAND_VIEWPORT_REQUEST_KINDS.CANONICAL_FILTER_COMPILATION) {
    const keys = uniqueSorted(compiledFilterKeys);
    const noncanonical = keys.filter((key) => !LAND_CANONICAL_FILTER_KEYS.includes(key));
    if (!keys.length || noncanonical.length) {
      return {
        outcome: "stop",
        requested_kind: requestedKind,
        reason: LAND_VIEWPORT_STOP_REASONS.NONCANONICAL_FILTER_KEY,
        noncanonical_keys: noncanonical,
        accounting,
      };
    }
    if (reviewed !== true) {
      return {
        outcome: "stop",
        requested_kind: requestedKind,
        reason: LAND_VIEWPORT_STOP_REASONS.UNREVIEWED_COMPILATION,
        compiled_filter_keys: keys,
        accounting,
      };
    }
    return {
      outcome: "ship",
      requested_kind: requestedKind,
      compiled_filter_keys: keys,
      accounting,
    };
  }

  // LOADED_ROWS: presentation over rows the resident's existing Land search already fetched.
  // No new request, no new filter, no re-query — reuse only.
  return { outcome: "ship", requested_kind: requestedKind, compiled_filter_keys: [], accounting };
}

/**
 * Build the evidence-contract receipt for one feasibility decision: viewport
 * state, loaded model ids, canonical filter compilation, unmapped ids,
 * request sequence, source/artifact vintages, and the explicit ship/stop
 * result.
 */
export function buildLandViewportFeasibilityReceipt({
  viewport = null,
  loadedModel = null,
  decision,
  requestSequence = [],
  sourceVintages = {},
  cardId = "cityscroll-land-map-view/lm-18-viewport-search",
} = {}) {
  const accounting = decision?.accounting || loadedRowAccounting(loadedModel);
  return {
    schema: LAND_VIEWPORT_FEASIBILITY_SCHEMA,
    version: LAND_VIEWPORT_FEASIBILITY_VERSION,
    workstream_card: cardId,
    viewport,
    loaded_model: {
      total_ids: accounting.total,
      mapped_ids: accounting.mapped,
      unmapped_ids: accounting.unmapped,
      total_count: accounting.total.length,
      mapped_count: accounting.mapped.length,
      unmapped_count: accounting.unmapped.length,
      accounting_reconciled: accounting.reconciled,
    },
    canonical_filter_compilation: {
      requested_kind: decision?.requested_kind ?? null,
      compiled_filter_keys: decision?.compiled_filter_keys || [],
      canonical_filter_keys: LAND_CANONICAL_FILTER_KEYS,
    },
    request_sequence: asArray(requestSequence),
    source_vintages: sourceVintages,
    outcome: decision?.outcome === "ship" ? "ship" : "stop",
    stop_reason: decision?.outcome === "ship" ? null : (decision?.reason || null),
    negative_rules_enforced: LAND_VIEWPORT_NEGATIVE_RULES,
  };
}

/** Structural check that a receipt actually carries every evidence-contract field. */
export function validateLandViewportFeasibilityReceipt(receipt) {
  const errors = [];
  if (receipt?.schema !== LAND_VIEWPORT_FEASIBILITY_SCHEMA) errors.push("schema mismatch");
  if (receipt?.version !== LAND_VIEWPORT_FEASIBILITY_VERSION) errors.push("version mismatch");
  if (!["ship", "stop"].includes(receipt?.outcome)) errors.push("outcome missing or invalid");
  if (receipt?.outcome === "stop" && !receipt?.stop_reason) errors.push("stop receipt missing stop_reason");
  if (receipt?.outcome === "ship" && receipt?.stop_reason) errors.push("ship receipt must not carry a stop_reason");
  const loadedModel = receipt?.loaded_model;
  if (!loadedModel || loadedModel.accounting_reconciled !== true) {
    errors.push("loaded-model accounting is not reconciled");
  } else if (loadedModel.mapped_count + loadedModel.unmapped_count !== loadedModel.total_count) {
    errors.push("loaded-model counts do not sum to the total");
  }
  const canonicalKeys = receipt?.canonical_filter_compilation?.canonical_filter_keys;
  if (!Array.isArray(canonicalKeys) || !canonicalKeys.length) {
    errors.push("canonical filter registry missing");
  }
  if (!Array.isArray(receipt?.request_sequence)) errors.push("request sequence missing");
  if (!Array.isArray(receipt?.negative_rules_enforced) || !receipt.negative_rules_enforced.length) {
    errors.push("negative rules ledger missing");
  }
  return { ok: errors.length === 0, errors };
}
