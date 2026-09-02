/**
 * Pure adapter from procurement SearchDocuments to Contracts Browse rows.
 *
 * Contracts Browse is a scoped form factor of one federated capability, not a
 * second search engine. This module owns both halves of that seam and nothing
 * else owns either half:
 *
 *   1. the request — `contractScopedRetrievalRequest()` names the one question
 *      Browse asks (`search.federated@1` restricted to the registered Contracts
 *      scope, or the exact object-reference lookup), so a Browse mode cannot
 *      silently ask something the search front door would not ask; and
 *   2. the reading — `contractScopedRetrievalOutcome()` turns the bounded
 *      response into candidates plus an explicit outcome, and
 *      `contractSearchDocumentToMoneyRow()` projects each admitted
 *      SearchDocument into exactly one Browse row.
 *
 * The outcome keeps `unavailable` distinct from `empty` on purpose. A provider
 * failure that arrives looking like "no contracts matched" is a false civic
 * statement, so the surface is handed a state it has to disclose instead of an
 * empty array it can quietly render.
 */

import {
  FEDERATED_SEARCH_CAPABILITY_REFERENCE,
  FEDERATED_SEARCH_LIMITS,
  FEDERATED_SEARCH_PRESENTATION_SCOPES,
} from "../capabilities/federated_search.mjs";
import { scopedFederatedSearchPath } from "./federated_search_client.mjs";
import { admitSearchDocument } from "./search_document_contract.mjs";

/** The registered scope both the Contracts lane and Contracts Browse request. */
export const CONTRACTS_BROWSE_SCOPE = FEDERATED_SEARCH_PRESENTATION_SCOPES.contracts;

export const CONTRACTS_BROWSE_RETRIEVAL_SCHEMA = "cityscroll.contracts_browse_scoped_retrieval.v1";

/** Coverage states the capability may report for a requested lens. */
const DEGRADED_LENS_STATES = Object.freeze(["partial", "stale", "not_indexed"]);
const AVAILABLE_LENS_STATES = Object.freeze(["matched", "empty"]);

const contractSearchBridgeClean = (value, max = 500) => String(value ?? "")
  .replace(/[\u0000-\u001f\u007f]/g, " ")
  .replace(/\s+/g, " ")
  .trim()
  .slice(0, max);

function requestIdFromRefs(refs) {
  for (const ref of Array.isArray(refs) ? refs : []) {
    const match = contractSearchBridgeClean(ref, 240).match(/^(?:notice|ocp_award|city_record):([A-Za-z0-9_-]{1,80})$/);
    if (match) return match[1];
  }
  return null;
}

function procurementId(document) {
  const id = contractSearchBridgeClean(document?.object_ref, 320);
  return id.startsWith("procurement:") ? id : null;
}

function stagesFor(document, carried) {
  const stages = Array.isArray(carried?.procurement_stages)
    ? carried.procurement_stages.map((stage) => contractSearchBridgeClean(stage, 80)).filter(Boolean)
    : [contractSearchBridgeClean(carried?.primary_stage || document?.process_role, 80)].filter(Boolean);
  return [...new Set(stages)];
}

/** Project a source-independent Browse row. request_id is optional evidence. */
export function contractSearchDocumentToMoneyRow(candidate = {}) {
  if (
    candidate?.outcome !== "indexed"
    || candidate?.object_type !== "procurement"
    || candidate?.domain !== "contracts"
  ) return null;
  const admitted = admitSearchDocument(candidate, { outcome: "indexed" });
  if (!admitted.document) return null;
  const document = admitted.document;
  const id = procurementId(document);
  if (!id) return null;
  const legacyPin = /^procurement:[^:]+$/.test(id) ? id.slice("procurement:".length) : null;
  const carried = document.provenance?.browse_record;
  if (carried != null && (!carried || typeof carried !== "object" || Array.isArray(carried))) return null;
  if (carried?.procurement_id && contractSearchBridgeClean(carried.procurement_id, 320) !== id) return null;
  if (carried?.canonical_href && contractSearchBridgeClean(carried.canonical_href, 600) !== document.canonical_href) return null;
  if (legacyPin && carried?.pin && contractSearchBridgeClean(carried.pin, 160).toUpperCase() !== legacyPin.toUpperCase()) return null;
  const stages = stagesFor(document, carried);
  if (!stages.length) return null;
  const requestId = contractSearchBridgeClean(carried?.request_id, 100) || requestIdFromRefs(document.source_observation_refs);
  const noticeEvidence = Array.isArray(document.provenance?.notice_evidence)
    ? document.provenance.notice_evidence
    : Array.isArray(carried?.notice_evidence) ? carried.notice_evidence : [];
  return Object.freeze({
    procurement_id: id,
    canonical_href: document.canonical_href,
    procurement_stages: Object.freeze(stages),
    primary_stage: contractSearchBridgeClean(carried?.primary_stage || document.process_role, 80) || stages.at(-1),
    source_observation_refs: document.source_observation_refs,
    ...(requestId ? { request_id: requestId } : {}),
    start_date: contractSearchBridgeClean(carried?.start_date, 40) || null,
    end_date: contractSearchBridgeClean(carried?.end_date, 40) || null,
    agency_id: contractSearchBridgeClean(carried?.agency_id, 200) || null,
    agency_name: contractSearchBridgeClean(carried?.agency_name, 240) || null,
    short_title: contractSearchBridgeClean(carried?.short_title, 500) || document.title,
    pin: contractSearchBridgeClean(carried?.pin, 160) || legacyPin,
    contract_id: contractSearchBridgeClean(carried?.contract_id, 160) || null,
    ...(contractSearchBridgeClean(carried?.contract_reporter_number, 160)
      ? { contract_reporter_number: contractSearchBridgeClean(carried.contract_reporter_number, 160) } : {}),
    ...(contractSearchBridgeClean(carried?.solicitation_id, 160)
      ? { solicitation_id: contractSearchBridgeClean(carried.solicitation_id, 160) } : {}),
    ...(contractSearchBridgeClean(carried?.event_id, 160)
      ? { event_id: contractSearchBridgeClean(carried.event_id, 160) } : {}),
    contract_amount: carried?.contract_amount ?? null,
    vendor_name: contractSearchBridgeClean(carried?.vendor_name, 240) || null,
    official_url: contractSearchBridgeClean(carried?.official_url, 600) || null,
    selection_method_description: contractSearchBridgeClean(carried?.selection_method_description, 240) || null,
    ...(Array.isArray(carried?.process_states) && carried.process_states.length
      ? {
        process_states: Object.freeze(carried.process_states
          .map((state) => contractSearchBridgeClean(state, 80))
          .filter(Boolean)),
      }
      : {}),
    ...(Array.isArray(carried?.entity_refs_all)
      ? { entity_refs_all: Object.freeze(carried.entity_refs_all.map((ref) => contractSearchBridgeClean(ref, 240)).filter(Boolean)) }
      : {}),
    additional_description_1: document.summary,
    notice_evidence: Object.freeze(noticeEvidence),
    source_system: contractSearchBridgeClean(carried?.source_system, 120) || document.source_family,
    source_systems: Object.freeze(Array.isArray(carried?.source_systems) ? carried.source_systems : []),
    ...(contractSearchBridgeClean(carried?.method_family, 80)
      ? { method_family: contractSearchBridgeClean(carried.method_family, 80) }
      : {}),
    ...(contractSearchBridgeClean(carried?.procurement_category, 80)
      ? { procurement_category: contractSearchBridgeClean(carried.procurement_category, 80) }
      : {}),
    ...(contractSearchBridgeClean(carried?.coverage_state, 80)
      ? { coverage_state: contractSearchBridgeClean(carried.coverage_state, 80) }
      : {}),
    search_document: document,
  });
}

/** Add canonical query hits without replacing richer resident rows. */
export function mergeContractSearchRows(baseRows = [], documents = []) {
  const rows = Array.isArray(baseRows) ? [...baseRows] : [];
  const seenCanonicalIds = new Set(rows.map((row) => contractSearchBridgeClean(row?.procurement_id, 320)).filter(Boolean));
  const seenRequestIds = new Set(rows.map((row) => contractSearchBridgeClean(row?.request_id, 100)).filter(Boolean));
  for (const document of Array.isArray(documents) ? documents : []) {
    const row = contractSearchDocumentToMoneyRow(document);
    if (!row || seenCanonicalIds.has(row.procurement_id)) continue;
    if (!row.procurement_id && row.request_id && seenRequestIds.has(row.request_id)) continue;
    seenCanonicalIds.add(row.procurement_id);
    if (row.request_id) seenRequestIds.add(row.request_id);
    rows.push(row);
  }
  return Object.freeze(rows);
}

/** Add canonical rows while retaining every field from a matching City Record row. */
export function mergeCanonicalProcurementBrowseRows(baseRows = [], canonicalRows = []) {
  const rows = Array.isArray(baseRows) ? [...baseRows] : [];
  const indexByRequestId = new Map(rows.map((row, index) => [contractSearchBridgeClean(row?.request_id, 100), index])
    .filter(([id]) => id));
  const seenCanonicalIds = new Set(rows.map((row) => contractSearchBridgeClean(row?.procurement_id, 320)).filter(Boolean));
  for (const canonical of Array.isArray(canonicalRows) ? canonicalRows : []) {
    const id = contractSearchBridgeClean(canonical?.procurement_id, 320);
    if (!id || seenCanonicalIds.has(id)) continue;
    const requestId = contractSearchBridgeClean(canonical?.request_id, 100);
    const existingIndex = requestId ? indexByRequestId.get(requestId) : null;
    if (Number.isInteger(existingIndex)) {
      rows[existingIndex] = Object.freeze({ ...rows[existingIndex], ...canonical });
    } else {
      rows.push(Object.freeze({ ...canonical }));
    }
    seenCanonicalIds.add(id);
  }
  return Object.freeze(rows);
}

/**
 * The one question Contracts Browse asks. Every Browse mode, facet and sort is a
 * local presentation of this request's answer, so a mode cannot quietly change
 * the query the capability receives.
 *
 * A keyword query is `search.federated@1` narrowed to the registered Contracts
 * scope. An exact object reference is the same route's exact-lookup mode: it
 * resolves one canonical object rather than federating lenses, so it requests no
 * lens scope and reports no lens coverage.
 */
export function contractScopedRetrievalRequest({ query = "", identity = null } = {}) {
  const objectRef = contractSearchBridgeClean(identity?.object_ref, 320);
  const sourceRef = contractSearchBridgeClean(identity?.source_observation_ref, 320);
  if (objectRef && sourceRef) {
    const params = new URLSearchParams();
    params.set("object_ref", objectRef);
    params.set("source_ref", sourceRef);
    return Object.freeze({
      schema: CONTRACTS_BROWSE_RETRIEVAL_SCHEMA,
      capability_reference: FEDERATED_SEARCH_CAPABILITY_REFERENCE,
      match_mode: "exact_object_ref",
      query: "",
      object_ref: objectRef,
      source_ref: sourceRef,
      lenses: Object.freeze([]),
      path: `/search?${params.toString()}`,
      result_bound: FEDERATED_SEARCH_LIMITS.maximumResults,
    });
  }
  const lexical = contractSearchBridgeClean(query, FEDERATED_SEARCH_LIMITS.queryMaximumLength);
  if (!lexical) return null;
  return Object.freeze({
    schema: CONTRACTS_BROWSE_RETRIEVAL_SCHEMA,
    capability_reference: FEDERATED_SEARCH_CAPABILITY_REFERENCE,
    match_mode: "scoped_keyword",
    query: lexical,
    object_ref: null,
    source_ref: null,
    lenses: CONTRACTS_BROWSE_SCOPE.lenses,
    path: scopedFederatedSearchPath(lexical, CONTRACTS_BROWSE_SCOPE.lenses),
    result_bound: FEDERATED_SEARCH_LIMITS.defaultResults,
  });
}

/** Browse issues no retrieval at all. Distinct from a request that found nothing. */
export const CONTRACT_SCOPED_RETRIEVAL_IDLE = Object.freeze({
  schema: CONTRACTS_BROWSE_RETRIEVAL_SCHEMA,
  outcome: "idle",
  capability_reference: FEDERATED_SEARCH_CAPABILITY_REFERENCE,
  match_mode: null,
  query: "",
  requested_lenses: Object.freeze([]),
  documents: Object.freeze([]),
  lens_coverage: Object.freeze([]),
  coverage_reported: false,
  coverage_state: null,
  source: CONTRACTS_BROWSE_SCOPE.source,
  as_of: null,
  reason: null,
  result_bound: null,
  candidate_count: 0,
});

/**
 * A provider or transport failure. The surface must disclose this and say that
 * the rows it is showing came from the retained local snapshot; rendering it as
 * an empty contract set would state, falsely, that the city awarded nothing.
 */
export function contractScopedRetrievalUnavailable(request = null, reason = null) {
  return Object.freeze({
    schema: CONTRACTS_BROWSE_RETRIEVAL_SCHEMA,
    outcome: "unavailable",
    capability_reference: FEDERATED_SEARCH_CAPABILITY_REFERENCE,
    match_mode: request?.match_mode || null,
    query: request?.query || "",
    requested_lenses: request?.lenses || Object.freeze([]),
    documents: Object.freeze([]),
    lens_coverage: Object.freeze((request?.lenses || []).map((lens) => Object.freeze({
      lens,
      state: "provider_unavailable",
      as_of: null,
    }))),
    coverage_reported: Boolean(request?.lenses?.length),
    coverage_state: "provider_unavailable",
    source: CONTRACTS_BROWSE_SCOPE.source,
    as_of: null,
    reason: contractSearchBridgeClean(reason, 240) || "provider_unavailable",
    result_bound: request?.result_bound ?? null,
    candidate_count: 0,
  });
}

/**
 * Per-lens coverage, only when the response actually carried a receipt. A
 * response without one (the exact-object route, or a legacy unscoped adapter)
 * reports no lens coverage rather than inventing a "not indexed" claim the
 * capability never made.
 */
function scopedLensCoverage(payload, lenses) {
  const byLens = payload?.federated?.coverage?.by_lens;
  if (!byLens || typeof byLens !== "object" || !lenses.length) return Object.freeze([]);
  return Object.freeze(lenses.map((lens) => {
    const row = byLens?.[lens];
    const state = contractSearchBridgeClean(row?.state, 80) || "not_indexed";
    return Object.freeze({
      lens,
      state,
      as_of: contractSearchBridgeClean(row?.as_of, 40) || null,
    });
  }));
}

/**
 * Read a bounded scoped response into candidates plus one honest outcome.
 *
 * Browse consumes the scoped result set rather than the front door's truncated
 * Contracts lane cards, so the two surfaces share candidate identity, ranking
 * and provenance while each keeps its own display bound. Document order is the
 * capability's rank order and is never re-sorted here.
 */
export function contractScopedRetrievalOutcome(payload, request = null) {
  const documents = Object.freeze((Array.isArray(payload?.results) ? payload.results : [])
    .filter((document) => document?.domain === CONTRACTS_BROWSE_SCOPE.domains[0]));
  const lenses = Array.isArray(request?.lenses) ? [...request.lenses] : [];
  const lensCoverage = scopedLensCoverage(payload, lenses);
  const degraded = lensCoverage.filter((row) => DEGRADED_LENS_STATES.includes(row.state));
  const failed = lensCoverage.filter((row) => row.state === "provider_unavailable");
  const asOf = lensCoverage.map((row) => row.as_of).filter(Boolean).sort().at(-1) || null;
  const outcome = failed.length
    ? "unavailable"
    : degraded.length
      ? "partial"
      : documents.length ? "matched" : "empty";
  const coverageState = failed.length
    ? "provider_unavailable"
    : degraded.length
      ? degraded[0].state
      : documents.length ? "matched" : "empty";
  return Object.freeze({
    schema: CONTRACTS_BROWSE_RETRIEVAL_SCHEMA,
    outcome,
    capability_reference: contractSearchBridgeClean(payload?.capability_reference, 120)
      || FEDERATED_SEARCH_CAPABILITY_REFERENCE,
    match_mode: request?.match_mode || contractSearchBridgeClean(payload?.match_mode, 80) || null,
    query: request?.query || "",
    requested_lenses: Object.freeze(lenses),
    documents,
    lens_coverage: lensCoverage,
    coverage_reported: lensCoverage.length > 0,
    coverage_state: coverageState,
    source: CONTRACTS_BROWSE_SCOPE.source,
    as_of: asOf,
    reason: failed.length || degraded.length
      ? contractSearchBridgeClean(payload?.federated?.coverage?.by_lens?.[(failed[0] || degraded[0]).lens]?.reason, 240) || null
      : null,
    result_bound: request?.result_bound ?? null,
    candidate_count: documents.length,
  });
}

/** Every state a Browse surface has to be able to tell apart. */
export const CONTRACT_SCOPED_RETRIEVAL_OUTCOMES = Object.freeze([
  "idle",
  "matched",
  "empty",
  "partial",
  "unavailable",
]);

/** Coverage states in which the capability answered and the answer is complete. */
export const CONTRACT_SCOPED_AVAILABLE_STATES = AVAILABLE_LENS_STATES;
