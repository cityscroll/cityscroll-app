import {
  nearYouUrlFromScope,
  normalizeScope,
  routeHashFromScope,
  scopeFromLensState,
} from "./scope_v0.mjs";
import { ACTION_LOCATION_FACET_KEYS } from "./action_location_keys.mjs";
import {
  normalizeCommunityDistrictId,
  normalizeCouncilDistrictId,
} from "./council_district_lookup.mjs";

const ACTION_LOCATION_BASIS_SET = new Set(ACTION_LOCATION_FACET_KEYS);
const CONCRETE_ACTION_BASIS_SET = new Set(ACTION_LOCATION_FACET_KEYS.slice(1));

function hasOwn(object, key) {
  return Object.prototype.hasOwnProperty.call(object, key);
}

function replacePlaceValue(scope, scopeKey, patchKey, value, normalize) {
  if (!hasOwn(value, patchKey)) return true;
  const normalized = normalize(value[patchKey]);
  if (value[patchKey] && !normalized) return false;
  scope.place[scopeKey] = normalized ? [normalized] : [];
  return true;
}

/** Compose one Contracts action-location edge without dropping the current scope. */
export function moneyActionLocationScope(scopeInput, patch = {}) {
  const source = scopeInput || scopeFromLensState("money", {});
  const scope = normalizeScope(source);
  scope.facets.domains = ["money"];
  scope.facets.values = { ...scope.facets.values, basis: "contract_action_address" };

  if (hasOwn(patch, "actionBasis")) {
    const basis = String(patch.actionBasis || "");
    if (basis && !ACTION_LOCATION_BASIS_SET.has(basis)) return null;
    if (basis && basis !== "contract_action_address") scope.facets.values.actionBasis = basis;
    else delete scope.facets.values.actionBasis;
  }
  if (!replacePlaceValue(scope, "boroughs", "borough", patch, (value) => value || null)
    || !replacePlaceValue(scope, "community_districts", "communityDistrict", patch, normalizeCommunityDistrictId)
    || !replacePlaceValue(scope, "council_districts", "councilDistrict", patch, normalizeCouncilDistrictId)) return null;

  return normalizeScope(scope);
}

/** Return a Contracts hash for an action-location scope. */
export function moneyActionLocationHash(scopeInput, patch = {}) {
  const scope = moneyActionLocationScope(scopeInput, patch);
  return scope ? routeHashFromScope(scope, { surface: "money" }) : null;
}

/** Return the shareable Near-you URL for an action-location basis. */
export function moneyLocationBasisHref(scopeInput, basis) {
  const value = String(basis || "");
  if (!ACTION_LOCATION_BASIS_SET.has(value)) return "";
  const scope = moneyActionLocationScope(scopeInput, {
    actionBasis: value,
  });
  return scope ? nearYouUrlFromScope(scope, { base: "/near-you/" }) : "";
}

/** Return the closing-week scope while retaining every unrelated Money facet. */
export function moneyClosingWeekHash(scopeInput, active = true) {
  const scope = normalizeScope(scopeInput || scopeFromLensState("money", {}));
  scope.facets.domains = ["money"];
  if (active) {
    scope.time_window.preset = "closing:week";
    scope.facets.values = { ...scope.facets.values, mode: "open" };
  } else if (scope.time_window.preset === "closing:week") {
    scope.time_window.preset = null;
  }
  return routeHashFromScope(scope, { surface: "money" });
}

/** A concrete basis is an edge to one source-address class, not a collapsed place. */
export function isConcreteActionBasis(value) {
  return CONCRETE_ACTION_BASIS_SET.has(String(value || ""));
}
