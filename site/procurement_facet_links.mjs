/**
 * Canonical hypertext facets for the Contracts surface.
 *
 * These helpers keep the visible links tied to the same scope-v0 contract as
 * the route parser. A link is only emitted for a known exact key; response
 * location bases remain separate from performance geography.
 */

import { nearYouUrlFromScope } from "./scope_v0.mjs";
import { normalizeScope, routeHashFromScope, scopeFromLensState } from "./scope_v0.mjs";

export const PROCUREMENT_MODE_KEYS = Object.freeze(["open", "allrfp", "award"]);
export const PROCUREMENT_ACTION_LOCATION_KEYS = Object.freeze([
  "contract_action_address",
  "submission_address",
  "pre_bid_venue",
  "document_pickup",
]);

const MODE_LABEL_KEYS = Object.freeze({
  open: "mode_open",
  allrfp: "mode_allrfp",
  award: "mode_award",
});

const LOCATION_LABEL_KEYS = Object.freeze({
  contract_action_address: "money_location_basis_response",
  submission_address: "money_location_basis_submission",
  pre_bid_venue: "money_location_basis_prebid",
  document_pickup: "money_location_basis_pickup",
});

function known(value, values) {
  const key = String(value || "");
  return values.includes(key) ? key : null;
}

function moneyScope({ mode = "open", actionBasis = null } = {}) {
  const safeMode = known(mode, PROCUREMENT_MODE_KEYS) || "open";
  const safeBasis = known(actionBasis, PROCUREMENT_ACTION_LOCATION_KEYS);
  const scope = scopeFromLensState("money", {
    mode: safeMode,
  });
  if (safeBasis) {
    scope.facets.values.basis = "contract_action_address";
    if (safeBasis !== "contract_action_address") scope.facets.values.actionBasis = safeBasis;
  }
  return normalizeScope(scope);
}

function browseContractsHref(scope) {
  const hash = routeHashFromScope(scope, { surface: "money" });
  const query = hash.includes("?") ? hash.slice(hash.indexOf("?") + 1) : "";
  return `/browse/contracts/${query ? `?${query}` : ""}`;
}

/** Return the canonical browse URL for one exact procurement mode. */
export function procurementModeHref(mode) {
  const safeMode = known(mode, PROCUREMENT_MODE_KEYS);
  if (!safeMode) return "";
  const href = browseContractsHref(moneyScope({ mode: safeMode }));
  // Keep the default's explicit mode in the visible link. The route parser
  // still canonicalizes it to the clean default document after navigation.
  return href.includes("?") ? href : "/browse/contracts/?mode=open";
}

/** Return the typed Near-you URL for one exact response-location basis. */
export function procurementLocationHref(actionBasis) {
  const safeBasis = known(actionBasis, PROCUREMENT_ACTION_LOCATION_KEYS);
  if (!safeBasis) return "";
  return nearYouUrlFromScope(moneyScope({ mode: "allrfp", actionBasis: safeBasis }), {
    base: "/near-you/",
  });
}

export function procurementModeLabelKey(mode) {
  return MODE_LABEL_KEYS[known(mode, PROCUREMENT_MODE_KEYS)] || "";
}

export function procurementLocationLabelKey(actionBasis) {
  return LOCATION_LABEL_KEYS[known(actionBasis, PROCUREMENT_ACTION_LOCATION_KEYS)] || "";
}
