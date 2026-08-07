import {
  commonNearYouPath,
  nearYouUrlFromScope,
  NEAR_YOU_COMMON_BOROUGHS,
  NEAR_YOU_COMMON_LENSES,
  normalizeScope,
  scopeFromRouteHash,
} from "./scope_v0.mjs";
import { ACTION_LOCATION_FACET_KEYS } from "./action_location_keys.mjs";

export {
  commonNearYouPath,
  nearYouUrlFromScope,
  NEAR_YOU_COMMON_BOROUGHS,
  NEAR_YOU_COMMON_LENSES,
};

/** Add or replace only the place axis; every non-place scope axis survives. */
export function scopeWithPlace(input, place = {}) {
  const scope = normalizeScope(input);
  const next = { ...scope, place: { ...scope.place } };
  const has = (name) => Object.prototype.hasOwnProperty.call(place || {}, name);
  const borough = place.borough ?? place.boro;
  const community = place.community_district ?? place.communityDistrict ?? place.cd;
  const council = place.council_district ?? place.councilDistrict ?? place.council;
  const locationScope = place.location_scope ?? place.locationScope ?? place.scope;

  if (has("borough") || has("boro")) {
    next.place.boroughs = borough ? [borough] : [];
    next.place.community_districts = [];
    next.place.council_districts = [];
    next.place.location_scope = null;
  }
  if (has("community_district") || has("communityDistrict") || has("cd")) {
    next.place.community_districts = community ? [community] : [];
    next.place.council_districts = [];
    next.place.location_scope = null;
    if (borough) next.place.boroughs = [borough];
  }
  if (has("council_district") || has("councilDistrict") || has("council")) {
    next.place.council_districts = council ? [council] : [];
    next.place.community_districts = [];
    next.place.location_scope = null;
  }
  if (has("location_scope") || has("locationScope") || has("scope")) {
    next.place.location_scope = locationScope || null;
    next.place.boroughs = [];
    next.place.community_districts = [];
    next.place.council_districts = [];
  }
  if (has("neighborhood")) next.place.neighborhood = place.neighborhood || null;
  next.place.viewport = has("viewport") ? place.viewport || null : null;
  return normalizeScope(next);
}

/** Parse the inspectable GET representation used by build and edge Near-you documents. */
export function scopeFromNearYouUrl(input, { language = "en" } = {}) {
  const url = input instanceof URL
    ? input
    : new URL(String(input || "/near-you/"), "https://cityscroll.invalid");
  const params = new URLSearchParams(url.search);
  const scope = scopeFromRouteHash(`#map?${params.toString()}`, { language });
  if (params.get("type")) scope.facets.values.type = String(params.get("type")).trim().slice(0, 120);
  if (params.get("basis") === "contract_action_address" && scope.facets.domains[0] === "money") {
    scope.facets.values.basis = "contract_action_address";
    const actionBasis = scope.facets.values.actionBasis;
    if (actionBasis && !ACTION_LOCATION_FACET_KEYS.includes(actionBasis)) {
      scope.facets.values.actionBasis = "unknown";
    }
  }
  return normalizeScope(scope, { language });
}
