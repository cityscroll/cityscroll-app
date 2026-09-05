/**
 * Front-door scope policy for the canonical `/search/` document.
 *
 * The owner decision is that `/search/` is the explicit all-sources federated
 * front door: an absent `scope` parameter is that default, never a route- or
 * referrer-inferred narrowing. This module names the one registered narrowing
 * `/search/` exposes today — the same Contracts presentation scope Contracts
 * Browse and the homepage Preview (US-21) already narrow to — so a resident
 * moving between those surfaces and `/search/` never meets a second, invented
 * scope vocabulary. The URL is the only source of truth for the active scope:
 * reading it back and building it are the same two functions used everywhere
 * the scope needs to round-trip.
 */

import { FEDERATED_SEARCH_PRESENTATION_SCOPES } from "../capabilities/federated_search.mjs";
import { allSourcesFederatedSearchPath, scopedFederatedSearchPath } from "./federated_search_client.mjs";

export const SEARCH_FRONT_DOOR_SCOPE_SCHEMA = "cityscroll.search_front_door_scope.v1";

/**
 * `all` is the resolved owner default: `/search/` federates every registered
 * lens and says so. `contracts` is the one registered narrowing this release
 * exposes — reusing the registered Contracts presentation scope's lenses and
 * domains rather than inventing a new facet.
 */
export const SEARCH_FRONT_DOOR_SCOPES = Object.freeze({
  all: Object.freeze({
    id: "all",
    mode: "all_registered_lenses",
    lenses: null,
    domains: null,
    label_key: "preview_scope_all_sources",
    narrow_target: "contracts",
    narrow_label_key: "preview_scope_narrow_contracts",
  }),
  contracts: Object.freeze({
    id: "contracts",
    mode: "allowlisted",
    lenses: Object.freeze([...FEDERATED_SEARCH_PRESENTATION_SCOPES.contracts.lenses]),
    domains: Object.freeze([...FEDERATED_SEARCH_PRESENTATION_SCOPES.contracts.domains]),
    label_key: "tab_money",
    narrow_target: "all",
    narrow_label_key: "preview_scope_all_sources",
    source: FEDERATED_SEARCH_PRESENTATION_SCOPES.contracts.source,
  }),
});

/**
 * Read the active scope from `/search/`'s own URL. An absent or unrecognized
 * value resolves to the all-sources default — never thrown, never inferred
 * from a referrer or prior page, so a hand-edited or stale `scope` value degrades
 * to the honest default instead of silently narrowing results.
 */
export function searchFrontDoorScopeFromParams(params) {
  const requested = String(params?.get?.("source_scope") || "").trim();
  return SEARCH_FRONT_DOOR_SCOPES[requested] || SEARCH_FRONT_DOOR_SCOPES.all;
}

/** The `search.federated@1` request path for the active scope and query. */
export function searchFrontDoorRequestPath(scopeId, query) {
  const scope = SEARCH_FRONT_DOOR_SCOPES[scopeId] || SEARCH_FRONT_DOOR_SCOPES.all;
  return scope.mode === "allowlisted"
    ? scopedFederatedSearchPath(query, scope.lenses)
    : allSourcesFederatedSearchPath(query);
}

/**
 * `/search/`'s own address for a scope, preserving every other parameter
 * (query, place context — including its unrelated, pre-existing `scope`
 * "Area" parameter — and language) except the front-door scope switch
 * itself. All-sources is the omitted-parameter address, matching a legacy
 * `/search/?q=` deep link exactly rather than adding a redundant
 * `source_scope=all`.
 */
export function searchFrontDoorHref(scopeId, params) {
  const scope = SEARCH_FRONT_DOOR_SCOPES[scopeId] || SEARCH_FRONT_DOOR_SCOPES.all;
  const next = new URLSearchParams(params);
  if (scope.id === "all") next.delete("source_scope");
  else next.set("source_scope", scope.id);
  const query = next.toString();
  return query ? `/search/?${query}` : "/search/";
}
