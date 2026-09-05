/**
 * Homepage Preview form-factor adapter for search.federated@1.
 *
 * Preview is a compact form factor of the one federated capability, never a
 * second search engine: the capability owns normalization, candidates,
 * ranking, dedupe, identity, evidence, freshness, and coverage. This module
 * owns only what a compact form factor adds — an explicit named scope choice
 * (the resolved all-sources default, or the registered Contracts scope), the
 * bounded three-card projection inputs, and the full-result handoff.
 *
 * Scope serialization is the capability's own, not a Preview invention:
 *
 *   - `all` serializes as the capability's omitted scope (`/search?q=`), the
 *     all-registered-lens federation including auxiliary legal-code recall.
 *     An explicit lens allowlist here would silently drop that auxiliary
 *     recall and become a different, narrower candidate population.
 *   - `contracts` serializes exactly as Contracts Browse and the search front
 *     door's Contracts lane do: the registered `contracts` presentation scope.
 */

import {
  FEDERATED_SEARCH_CAPABILITY_REFERENCE,
  FEDERATED_SEARCH_LENS_IDS,
  FEDERATED_SEARCH_LIMITS,
  FEDERATED_SEARCH_PRESENTATION_SCOPES,
  validateFederatedSearchOutput,
} from "../capabilities/federated_search.mjs";
import { scopedFederatedSearchPath, allSourcesFederatedSearchPath } from "./federated_search_client.mjs";

export const PREVIEW_FORM_FACTOR_SCHEMA = "cityscroll.preview_federated_form_factor.v1";
export const PREVIEW_FORM_FACTOR_OUTCOME_STATES = Object.freeze([
  "idle", "matched", "empty", "partial", "unavailable",
]);

const PREVIEW_FORM_FACTOR_TIMEOUT_MS = 12000;
const PREVIEW_DEGRADED_LENS_STATES = new Set(["partial", "stale", "not_indexed", "provider_unavailable"]);

function previewFormFactorClean(value, max) {
  return String(value ?? "")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

/**
 * The two registered Preview scope choices. `all` is the resolved default:
 * the homepage Preview searches every source and says so; one action narrows
 * to the registered Contracts scope without changing the query.
 */
export const PREVIEW_FORM_FACTOR_SCOPES = Object.freeze({
  all: Object.freeze({
    id: "all",
    capability_reference: FEDERATED_SEARCH_CAPABILITY_REFERENCE,
    scope_mode: "all_registered_lenses",
    lenses: null,
    label_key: "preview_scope_all_sources",
    narrow_target: "contracts",
    narrow_label_key: "preview_scope_narrow_contracts",
    full_results_route: "/search/",
    full_results_label_key: "preview_full_results_all",
  }),
  contracts: Object.freeze({
    id: "contracts",
    capability_reference: FEDERATED_SEARCH_CAPABILITY_REFERENCE,
    scope_mode: "allowlisted",
    lenses: Object.freeze([...FEDERATED_SEARCH_PRESENTATION_SCOPES.contracts.lenses]),
    domains: Object.freeze([...FEDERATED_SEARCH_PRESENTATION_SCOPES.contracts.domains]),
    presentation_scope_id: FEDERATED_SEARCH_PRESENTATION_SCOPES.contracts.id,
    source: FEDERATED_SEARCH_PRESENTATION_SCOPES.contracts.source,
    label_key: "tab_money",
    narrow_target: "all",
    narrow_label_key: "preview_scope_all_sources",
    full_results_route: "/browse/contracts/",
    full_results_label_key: "preview_full_results_contracts",
  }),
});

export function previewFormFactorScope(scopeId) {
  const scope = PREVIEW_FORM_FACTOR_SCOPES[previewFormFactorClean(scopeId, 40)];
  if (!scope) throw new TypeError(`unknown registered Preview form-factor scope: ${scopeId}`);
  return scope;
}

/**
 * The one request a Preview scope issues. `all` deliberately serializes with
 * no scope parameter — that is the capability's all-sources federation — and
 * `contracts` reuses the registered presentation-scope path Contracts Browse
 * issues, so Preview cannot ask the capability a different question.
 */
export function previewFormFactorRequest(scopeId, query) {
  const scope = previewFormFactorScope(scopeId);
  const normalized = previewFormFactorClean(query, FEDERATED_SEARCH_LIMITS.queryMaximumLength);
  if (!normalized) throw new TypeError("preview form factor requires a query");
  const path = scope.scope_mode === "allowlisted"
    ? scopedFederatedSearchPath(normalized, scope.lenses)
    : allSourcesFederatedSearchPath(normalized);
  return Object.freeze({
    schema: PREVIEW_FORM_FACTOR_SCHEMA,
    capability_reference: scope.capability_reference,
    scope: Object.freeze({
      id: scope.id,
      mode: scope.scope_mode,
      ...(scope.lenses ? { lenses: Object.freeze([...scope.lenses]) } : {}),
    }),
    query: normalized,
    path,
    result_bound: FEDERATED_SEARCH_LIMITS.defaultResults,
  });
}

/** The equivalent full-result surface for a scope, preserving the exact query. */
export function previewFullResultsHref(scopeId, query) {
  const scope = previewFormFactorScope(scopeId);
  const normalized = previewFormFactorClean(query, FEDERATED_SEARCH_LIMITS.queryMaximumLength);
  if (!normalized) throw new TypeError("preview full-results handoff requires a query");
  return `${scope.full_results_route}?q=${encodeURIComponent(normalized)}`;
}

function requestedLensStates(envelope, scope) {
  const byLens = envelope?.coverage?.by_lens;
  if (!byLens || typeof byLens !== "object") return [];
  const requested = scope.scope_mode === "all_registered_lenses"
    ? FEDERATED_SEARCH_LENS_IDS
    : scope.lenses;
  return requested
    .map((lens) => byLens[lens])
    .filter((row) => row && typeof row.state === "string");
}

function coverageProjection(scope, envelope) {
  const rows = requestedLensStates(envelope, scope);
  if (!rows.length) {
    return Object.freeze({
      state: "unreported",
      degraded_lenses: Object.freeze([]),
      unavailable_lenses: Object.freeze([]),
      as_of: null,
    });
  }
  const degraded = rows.filter((row) => PREVIEW_DEGRADED_LENS_STATES.has(row.state));
  const unavailable = rows.filter((row) => row.state === "provider_unavailable");
  const asOf = rows.map((row) => previewFormFactorClean(row.as_of, 80)).filter(Boolean).sort().at(-1) || null;
  return Object.freeze({
    state: unavailable.length === rows.length ? "unavailable" : degraded.length ? "partial" : "complete",
    degraded_lenses: Object.freeze(degraded.map((row) => row.lens)),
    unavailable_lenses: Object.freeze(unavailable.map((row) => row.lens)),
    as_of: asOf,
  });
}

function outcomeFrom(documents, coverage) {
  if (coverage.state === "unavailable") return "unavailable";
  // Incomplete coverage is disclosed even at zero observed matches: a partial
  // federation is never promoted to a complete "no results" civic statement.
  if (coverage.state === "partial") return "partial";
  return documents.length ? "matched" : "empty";
}

/**
 * Read a capability envelope into the bounded Preview projection. Canonical
 * references, ordering, evidence, and bounds are the capability's own result
 * objects — never rebuilt — and coverage is projected from the requested
 * lenses only, so an out-of-scope lens can never look like a failure.
 */
export function previewFormFactorOutcome(scopeId, payload, request = null) {
  const scope = previewFormFactorScope(scopeId);
  const envelope = payload?.federated || null;
  let validEnvelope = null;
  if (envelope) {
    try {
      validEnvelope = validateFederatedSearchOutput(envelope);
    } catch {
      validEnvelope = null;
    }
  }
  // A requested lens can carry candidates from more than one domain (the
  // `notices` lens backs both Contracts and Rules); the registered scope's
  // domain allowlist — not just its lens allowlist — is what keeps a
  // narrowed Preview from leaking an out-of-scope domain's candidate.
  const documents = Object.freeze(
    (validEnvelope?.results ?? (Array.isArray(payload?.results) ? payload.results : []))
      .filter((document) => document && typeof document === "object"
        && (!scope.domains || scope.domains.includes(document.domain))),
  );
  const coverage = coverageProjection(scope, validEnvelope);
  const outcome = outcomeFrom(documents, coverage);
  return Object.freeze({
    schema: PREVIEW_FORM_FACTOR_SCHEMA,
    outcome,
    scope: Object.freeze({
      id: scope.id,
      mode: scope.scope_mode,
      ...(scope.lenses ? { lenses: Object.freeze([...scope.lenses]) } : {}),
    }),
    capability_reference: FEDERATED_SEARCH_CAPABILITY_REFERENCE,
    query: previewFormFactorClean(request?.query ?? payload?.query?.normalized ?? payload?.query, FEDERATED_SEARCH_LIMITS.queryMaximumLength),
    documents,
    coverage,
    bounds: Object.freeze({
      requested: request?.result_bound ?? FEDERATED_SEARCH_LIMITS.defaultResults,
      returned: documents.length,
      preview_limit: 3,
      maximum: FEDERATED_SEARCH_LIMITS.maximumResults,
    }),
    fallback: Object.freeze({ used: false, reason: null }),
    ...(validEnvelope ? { requested_scope: validEnvelope.requested_scope } : {}),
  });
}

/** Transport or provider failure. Never collapses into an empty projection. */
export function previewFormFactorUnavailable(scopeId, request = null, reason = "provider_unavailable") {
  const scope = previewFormFactorScope(scopeId);
  return Object.freeze({
    schema: PREVIEW_FORM_FACTOR_SCHEMA,
    outcome: "unavailable",
    scope: Object.freeze({
      id: scope.id,
      mode: scope.scope_mode,
      ...(scope.lenses ? { lenses: Object.freeze([...scope.lenses]) } : {}),
    }),
    capability_reference: FEDERATED_SEARCH_CAPABILITY_REFERENCE,
    query: previewFormFactorClean(request?.query, FEDERATED_SEARCH_LIMITS.queryMaximumLength),
    documents: Object.freeze([]),
    coverage: Object.freeze({
      state: "unavailable",
      degraded_lenses: Object.freeze([]),
      unavailable_lenses: Object.freeze(scope.lenses ? [...scope.lenses] : [...FEDERATED_SEARCH_LENS_IDS]),
      as_of: null,
    }),
    bounds: Object.freeze({
      requested: request?.result_bound ?? FEDERATED_SEARCH_LIMITS.defaultResults,
      returned: 0,
      preview_limit: 3,
      maximum: FEDERATED_SEARCH_LIMITS.maximumResults,
    }),
    fallback: Object.freeze({ used: false, reason: previewFormFactorClean(reason, 240) || "provider_unavailable" }),
  });
}

export async function fetchPreviewFormFactor(scopeId, query, {
  fetcher = globalThis.workerFetch,
  timeoutMs = PREVIEW_FORM_FACTOR_TIMEOUT_MS,
} = {}) {
  const request = previewFormFactorRequest(scopeId, query);
  try {
    if (typeof fetcher !== "function") throw new Error("federated search client unavailable");
    const response = await fetcher(request.path, null, timeoutMs);
    if (!response?.ok) throw new Error(`federated search HTTP ${response?.status || 0}`);
    const payload = await response.json();
    if (!payload || !Array.isArray(payload.results)) {
      throw new Error(`invalid ${FEDERATED_SEARCH_CAPABILITY_REFERENCE} response`);
    }
    return Object.freeze({ request, outcome: previewFormFactorOutcome(scopeId, payload, request) });
  } catch (error) {
    return Object.freeze({ request, outcome: previewFormFactorUnavailable(scopeId, request, error?.message) });
  }
}
