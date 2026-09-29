import {
  commonNearYouPath,
  nearYouUrlFromScope,
  NEAR_YOU_COMMON_BOROUGHS,
  NEAR_YOU_COMMON_LENSES,
  normalizeScope,
  PLACE_ROLES,
  routeHashFromScope,
  scopeWithGeographies,
  normalizeGeographyKey,
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
  const scope = scopeWithGeographies(input);
  const next = { ...scope, place: { ...scope.place } };
  const has = (name) => Object.prototype.hasOwnProperty.call(place || {}, name);
  const borough = place.borough ?? place.boro;
  const community = place.community_district ?? place.communityDistrict ?? place.cd;
  const council = place.council_district ?? place.councilDistrict ?? place.council;
  const locationScope = place.location_scope ?? place.locationScope ?? place.scope;

  if (has("borough") || has("boro")) {
    next.place.geographies = [];
    next.place.boroughs = borough ? [borough] : [];
    next.place.community_districts = [];
    next.place.council_districts = [];
    next.place.location_scope = null;
  }
  if (has("community_district") || has("communityDistrict") || has("cd")) {
    next.place.geographies = [];
    next.place.community_districts = community ? [community] : [];
    next.place.council_districts = [];
    next.place.location_scope = null;
    if (borough) next.place.boroughs = [borough];
  }
  if (has("council_district") || has("councilDistrict") || has("council")) {
    next.place.geographies = [];
    next.place.council_districts = council ? [council] : [];
    next.place.community_districts = [];
    next.place.location_scope = null;
  }
  if (has("location_scope") || has("locationScope") || has("scope")) {
    // A special bucket (citywide, online, no mapped place) replaces every local
    // place axis, including leftover neighborhood text.
    next.place.geographies = [];
    next.place.location_scope = locationScope || null;
    next.place.boroughs = [];
    next.place.community_districts = [];
    next.place.council_districts = [];
    next.place.neighborhood = null;
  }
  if (has("neighborhood")) next.place.neighborhood = place.neighborhood || null;
  next.place.viewport = has("viewport") ? place.viewport || null : null;
  return scopeWithGeographies(next, next.place.geographies);
}

/**
 * Facet values a Browse surface reads from its route beyond its first-class keys.
 * Community-board refs are place constraints and are cleared with the other place axes.
 */
const ALL_NYC_BROWSE_FACET_JSON_KEYS = Object.freeze({
  meetings: ["entity_refs_all"],
  land: ["regulatoryEffect"],
  rules: ["entity_refs_all"],
  money: ["basis", "actionBasis", "entity_refs_all"],
});

/** Browse lenses with an All NYC collection; other lenses have no broader destination. */
export const ALL_NYC_BROWSE_LENSES = Object.freeze(["meetings", "land", "property", "rules", "money", "people"]);

/**
 * Whether the Browse route grammar serializes this facet as its own query parameter
 * (or drops it as the lens default). A value that only survives as opaque `facet`
 * JSON is one the destination page does not apply.
 */
function browseRouteKeepsFacet(lens, key, value) {
  const hash = routeHashFromScope(
    normalizeScope({ facets: { domains: [lens], values: { [key]: value } } }),
    { surface: lens },
  );
  return !new URLSearchParams(hash.split("?")[1] || "").has("facet");
}

function placeFreeEntityRefs(refs) {
  return (Array.isArray(refs) ? refs : []).filter((ref) => !/^community-board:/i.test(String(ref)));
}

/**
 * Broaden one scope to the All NYC collection of its category: an explicit user action,
 * never a silent expansion of exact local results. Every place axis and map-only view
 * state is cleared; topic, agency, dates and the facets the destination applies survive.
 * A facet the destination cannot apply is removed and reported in `removed`, so the caller
 * can name it beside the link instead of erasing it silently.
 */
export function scopeForAllNycRecords(input, { lens } = {}) {
  const scope = scopeWithGeographies(input);
  const category = lens || scope.facets.domains[0] || "meetings";
  const readsFromFacetJson = new Set(ALL_NYC_BROWSE_FACET_JSON_KEYS[category] || []);
  const applied = { has: (key) => readsFromFacetJson.has(key) || browseRouteKeepsFacet(category, key, scope.facets.values[key]) };
  const values = {};
  const removed = [];
  for (const [key, value] of Object.entries(scope.facets.values || {})) {
    if (key === "entity_refs_all") {
      const refs = placeFreeEntityRefs(value);
      if (applied.has(key) && refs.length) values[key] = refs;
      continue;
    }
    if (applied.has(key)) values[key] = value;
    else removed.push(Object.freeze({ axis: key, value }));
  }
  const next = normalizeScope({
    ...scope,
    place: {
      boroughs: [],
      community_districts: [],
      council_districts: [],
      neighborhood: null,
      location_scope: null,
      viewport: null,
    },
    facets: { ...scope.facets, domains: [category], values },
  });
  return Object.freeze({
    scope: scopeWithGeographies(next, []),
    lens: category,
    removed: Object.freeze(removed),
  });
}

/**
 * Canonical legacy route hash for the All NYC collection. A Browse Meetings route
 * without `when` opens on this week, so an unbounded Near You date window is
 * serialized as `when=all` rather than silently narrowed.
 */
export function allNycRecordsRouteHash(input, { lens } = {}) {
  const broadened = scopeForAllNycRecords(input, { lens });
  if (!ALL_NYC_BROWSE_LENSES.includes(broadened.lens)) return null;
  const timeWindow = broadened.scope.time_window;
  const unbounded = !timeWindow.preset && !timeWindow.start && !timeWindow.end && !timeWindow.rolling_months;
  const routeScope = broadened.lens === "meetings" && unbounded
    ? normalizeScope({ ...broadened.scope, time_window: { ...timeWindow, preset: "all" } })
    : broadened.scope;
  return routeHashFromScope(routeScope, { surface: broadened.lens });
}

/**
 * Document paths that present the Near You shell.
 * The site root `/` and `/near-you` share selected-place query behavior; deferred
 * JSON stays under `/near-you/deferred.json`.
 */
export function isNearYouDocumentPath(pathname) {
  const path = String(pathname || "").replace(/\/+$/, "") || "/";
  return path === "/" || path === "/near-you";
}

/** Deferred payload path for the Near You shell (always under /near-you/). */
export function isNearYouDeferredPath(pathname) {
  return String(pathname || "") === "/near-you/deferred.json";
}

/** Parse the inspectable GET representation used by build and edge Near-you documents. */
export function scopeFromNearYouUrl(input, { language = "en" } = {}) {
  const url = input instanceof URL
    ? input
    : new URL(String(input || "/near-you/"), "https://cityscroll.invalid");
  const params = new URLSearchParams(url.search);
  const scope = scopeFromRouteHash(`#map?${params.toString()}`, { language });
  if (params.get("type")) scope.facets.values.type = String(params.get("type")).trim().slice(0, 120);
  const placeRole = params.get("placeRole");
  if (PLACE_ROLES.includes(placeRole)) scope.facets.values.place_role = placeRole;
  if (params.get("basis") === "contract_action_address" && scope.facets.domains[0] === "money") {
    scope.facets.values.basis = "contract_action_address";
    const actionBasis = scope.facets.values.actionBasis;
    if (actionBasis && !ACTION_LOCATION_FACET_KEYS.includes(actionBasis)) {
      scope.facets.values.actionBasis = "unknown";
    }
  }
  return scopeWithGeographies(scope, params.getAll("geo").map((value) =>
    normalizeGeographyKey(value) || normalizeGeographyKey(`geography:${value}`)
  ).filter(Boolean));
}

/** Convert the legacy map hash into the canonical Near-you GET URL. */
export function nearYouUrlFromMapHash(input, { base = "/near-you/" } = {}) {
  const hash = String(input || "");
  if (!/^#map(?:\?|$)/.test(hash)) return null;
  if (hash === "#map" || hash === "#map?") {
    const url = new URL(base, "https://cityscroll.invalid");
    return /^[a-z][a-z\d+.-]*:\/\//i.test(base)
      ? url.toString()
      : `${url.pathname}${url.search}`;
  }
  return nearYouUrlFromScope(scopeFromRouteHash(hash), { base });
}
