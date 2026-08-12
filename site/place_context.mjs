import {
  normalizeScope,
  scopeFromRouteHash,
} from "./scope_v0.mjs";

const DEEPLINK_BOROUGHS = Object.freeze([
  "Manhattan",
  "Brooklyn",
  "Queens",
  "Bronx",
  "Staten Island",
]);

export { DEEPLINK_BOROUGHS };

const PLACE_FIELDS = Object.freeze([
  "borough",
  "boro",
  "communityDistrict",
  "community_district",
  "cd",
  "councilDistrict",
  "council_district",
  "council",
  "neighborhood",
  "locationScope",
  "location_scope",
  "scope",
]);

function first(values) {
  return Array.isArray(values) && values.length ? values[0] : null;
}

function nonEmpty(value) {
  const text = String(value ?? "").trim();
  return text || null;
}

function hasValue(value) {
  return nonEmpty(value) !== null;
}

/** Project the shared scope place axis into a small, reader-facing context object. */
export function placeContextFromScope(input, { source = null } = {}) {
  const scope = normalizeScope(input);
  const borough = first(scope.place.boroughs);
  const communityDistrict = first(scope.place.community_districts);
  const councilDistrict = first(scope.place.council_districts);
  const neighborhood = nonEmpty(scope.place.neighborhood);
  const locationScope = nonEmpty(scope.place.location_scope);
  if (!borough && !communityDistrict && !councilDistrict && !neighborhood && !locationScope) return null;
  return {
    borough,
    communityDistrict,
    councilDistrict,
    neighborhood,
    locationScope,
    source: source ?? null,
  };
}

/** The structured place context used by the runtime and all downstream lens adapters. */
export function normalizePlaceContext(input, { source = null } = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const borough = DEEPLINK_BOROUGHS.find((name) =>
    name.toLowerCase() === nonEmpty(input.borough ?? input.boro)?.toLowerCase()) || null;
  const communityDistrict = nonEmpty(
    input.communityDistrict ?? input.community_district ?? input.cd,
  )?.toUpperCase() || null;
  const councilDistrict = nonEmpty(
    input.councilDistrict ?? input.council_district ?? input.council,
  ) || null;
  const neighborhood = nonEmpty(input.neighborhood);
  const locationScope = nonEmpty(input.locationScope ?? input.location_scope ?? input.scope);
  if (!borough && !communityDistrict && !councilDistrict && !neighborhood && !locationScope) return null;
  return {
    borough,
    communityDistrict,
    councilDistrict,
    neighborhood,
    locationScope,
    source: input.source ?? source ?? null,
  };
}

export function placeContextLabel(input) {
  const context = normalizePlaceContext(input);
  if (!context) return null;
  if (context.locationScope) {
    return context.locationScope === "citywide-unlocated" ? "Citywide or unlocated" : context.locationScope;
  }
  const district = context.communityDistrict
    ? `CB${Number.parseInt(context.communityDistrict.slice(1), 10)}`
    : context.councilDistrict
      ? `Council district ${context.councilDistrict}`
      : null;
  const boroughAndDistrict = [context.borough, district].filter(Boolean).join(" ");
  return [boroughAndDistrict, context.neighborhood].filter(Boolean).join(" · ") || null;
}

export function scopeWithPlaceContext(input, inputContext) {
  const scope = normalizeScope(input);
  const context = normalizePlaceContext(inputContext);
  const next = {
    ...scope,
    place: {
      ...scope.place,
      boroughs: context?.borough ? [context.borough] : [],
      community_districts: context?.communityDistrict ? [context.communityDistrict] : [],
      council_districts: context?.councilDistrict ? [context.councilDistrict] : [],
      neighborhood: context?.neighborhood || null,
      location_scope: context?.locationScope || null,
      viewport: null,
    },
  };
  return normalizeScope(next);
}

export function clearPlaceContext(input) {
  const scope = normalizeScope(input);
  return normalizeScope({
    ...scope,
    place: {
      ...scope.place,
      boroughs: [],
      community_districts: [],
      council_districts: [],
      neighborhood: null,
      location_scope: null,
      viewport: null,
    },
  });
}

/**
 * Add place state to a destination only when that destination has not declared its own place.
 * Explicit destination state wins, so a chosen override cannot be overwritten by old context.
 */
export function appendPlaceContextToHref(href, inputContext) {
  const context = normalizePlaceContext(inputContext);
  if (!context || !href) return href;
  const url = new URL(String(href), "https://cityscroll.invalid");
  const params = url.searchParams;
  const hasPlace = PLACE_FIELDS.some((field) => hasValue(params.get(field)));
  if (!hasPlace) {
    if (context.borough) params.set("boro", context.borough);
    if (context.communityDistrict) params.set("cd", context.communityDistrict);
    if (context.councilDistrict) params.set("council", context.councilDistrict);
    if (context.neighborhood) params.set("neighborhood", context.neighborhood);
    if (context.locationScope) params.set("scope", context.locationScope);
  }
  return /^[a-z][a-z\d+.-]*:\/\//i.test(String(href))
    ? url.toString()
    : `${url.pathname}${url.search}${url.hash}`;
}

export function appendPlaceContextToHash(hash, inputContext) {
  const context = normalizePlaceContext(inputContext);
  if (!context || !hash) return hash;
  const match = /^#([^?]+)(?:\?(.*))?$/.exec(String(hash));
  if (!match) return hash;
  const params = new URLSearchParams(match[2] || "");
  const hasPlace = PLACE_FIELDS.some((field) => hasValue(params.get(field)));
  if (!hasPlace) {
    if (context.borough) params.set("boro", context.borough);
    if (context.communityDistrict) params.set("cd", context.communityDistrict);
    if (context.councilDistrict) params.set("council", context.councilDistrict);
    if (context.neighborhood) params.set("neighborhood", context.neighborhood);
    if (context.locationScope) params.set("scope", context.locationScope);
  }
  const query = params.toString();
  return query ? `#${match[1]}?${query}` : `#${match[1]}`;
}

export function placeContextFromRouteHash(hash, { source = null } = {}) {
  return placeContextFromScope(scopeFromRouteHash(hash), { source });
}

/** Carry an established place into a natural-language lens filter unless the query names a place. */
export function mergePlaceContextIntoLensFilter(inputFilter, inputContext) {
  const filter = { ...(inputFilter || {}) };
  const context = normalizePlaceContext(inputContext);
  if (!context) return filter;
  const explicitFields = [
    "borough", "boro", "communityDistrict", "community_district", "cd",
    "councilDistrict", "council_district", "council", "neighborhood", "locationScope", "scope",
  ];
  if (explicitFields.some((field) => hasValue(filter[field]))) return filter;
  if (context.borough) filter.borough = context.borough;
  if (context.communityDistrict) filter.communityDistrict = context.communityDistrict;
  if (context.councilDistrict) filter.councilDistrict = context.councilDistrict;
  if (context.neighborhood) filter.neighborhood = context.neighborhood;
  if (context.locationScope) filter.locationScope = context.locationScope;
  return filter;
}
