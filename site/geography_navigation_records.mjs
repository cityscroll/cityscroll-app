/**
 * Project a selected public geography onto the resident record continuation.
 *
 * The activity builder owns membership and order. This module only projects
 * that materialized index into a scope and never evaluates coordinates,
 * polygons, names, or record fields in the browser.
 */

import { civicGeographyKey } from "./civic_geography_registry.mjs";
import { nearYouUrlFromScope, scopeWithGeographies } from "./scope_v0.mjs";

export const GEOGRAPHY_RECORDS_SCHEMA = "cityscroll.geography_navigation_records.v1";
export const GEOGRAPHY_RECORD_LENSES = Object.freeze([
  "land",
  "property",
  "rules",
  "meetings",
  "money",
]);

export const GEOGRAPHY_RECORD_LENS_LABELS = Object.freeze({
  land: "Zoning",
  property: "Property",
  rules: "Rules",
  meetings: "Meetings",
  money: "Contracts",
});

export const GEOGRAPHY_RECORD_STATES = Object.freeze([
  "ready",
  "zero",
  "unavailable",
  "incomplete",
  "unfilterable",
  "error",
]);

const LEGACY_PLACE_KEYS = Object.freeze([
  ["community_districts", "community_district"],
  ["council_districts", "council_district"],
  ["boroughs", "borough"],
]);

function uniqueIds(values) {
  return [...new Set((Array.isArray(values) ? values : []).map((value) => String(value)).filter(Boolean))];
}

function hasOwn(value, key) {
  return !!value && Object.prototype.hasOwnProperty.call(value, key);
}

function geographyTypeFromKey(key) {
  const parts = String(key || "").split(":");
  return parts.length >= 3 && parts[0] === "geography" ? parts[1] : null;
}

function coverageStatusRank(status) {
  const normalized = String(status || "").toLowerCase();
  if (["unavailable", "missing"].includes(normalized)) return "unavailable";
  if (["error", "failed", "load_failure"].includes(normalized)) return "error";
  if (["incomplete", "partial", "building"].includes(normalized)) return "incomplete";
  return null;
}

function coverageState(activity, key, lens) {
  const coverage = activity?.geography_items?.coverage;
  const lensCoverage = coverage?.by_lens?.[lens] || coverage?.lenses?.[lens] || null;
  const geographyType = geographyTypeFromKey(key);
  const typeCoverage = geographyType
    ? (lensCoverage?.types?.[geographyType] || null)
    : null;
  const typeRank = coverageStatusRank(typeCoverage?.status || typeCoverage?.state);
  if (typeRank) return typeRank;
  const lensRank = coverageStatusRank(lensCoverage?.status || lensCoverage?.state);
  if (lensRank) return lensRank;

  const statusRank = coverageStatusRank(coverage?.status || coverage?.state);
  if (statusRank) return statusRank;

  const entry = activity?.geography_items?.by_key?.[key];
  if (!entry || typeof entry !== "object") return "unavailable";
  if (!hasOwn(entry, lens)) return "unfilterable";
  if (!Array.isArray(entry[lens])) return "incomplete";
  return entry[lens].length ? "ready" : "zero";
}

/** Convert legacy place axes to the same canonical key used by geography_items. */
export function geographyKeyForScope(scope = {}) {
  const geographies = Array.isArray(scope?.place?.geographies)
    ? scope.place.geographies.filter(Boolean)
    : [];
  if (geographies.length) return String(geographies[0]);
  for (const [field, type] of LEGACY_PLACE_KEYS) {
    const id = Array.isArray(scope?.place?.[field]) ? scope.place[field][0] : null;
    const key = civicGeographyKey(type, id);
    if (key) return key;
  }
  return null;
}

/** Add the canonical key to a selected legacy scope without dropping its compatibility axes. */
export function scopeWithCanonicalGeography(input = {}) {
  const key = geographyKeyForScope(input);
  return key ? scopeWithGeographies(input, [key]) : scopeWithGeographies(input);
}

/**
 * Return the exact ordered IDs materialized for a key/lens pair.
 * `unfilterable` is intentionally distinct from `zero`: a missing lens entry
 * cannot support a positive local link or a local count.
 */
export function geographyRecordProjection(activity, { key, lens } = {}) {
  const normalizedKey = String(key || "");
  const normalizedLens = String(lens || "");
  const state = coverageState(activity, normalizedKey, normalizedLens);
  const ids = state === "ready" || state === "zero"
    ? uniqueIds(activity.geography_items.by_key[normalizedKey][normalizedLens])
    : [];
  return Object.freeze({
    schema: GEOGRAPHY_RECORDS_SCHEMA,
    key: normalizedKey || null,
    lens: normalizedLens || null,
    state,
    ids: Object.freeze(ids),
    count: state === "ready" || state === "zero" ? ids.length : null,
    exact: state === "ready" || state === "zero",
  });
}

/** Project every available lens for one selected key, preserving unavailable states. */
export function geographyRecordLenses(activity, key) {
  return Object.freeze(Object.fromEntries(GEOGRAPHY_RECORD_LENSES.map((lens) => [
    lens,
    geographyRecordProjection(activity, { key, lens }),
  ])));
}

/** Project a selected scope onto the canonical membership index, with a legacy fallback only when no generic index exists. */
export function recordIdsForScope(activity, lens, scope = {}) {
  const key = geographyKeyForScope(scope);
  if (!key && scope.place?.neighborhood) {
    return Object.freeze({schema:GEOGRAPHY_RECORDS_SCHEMA, key:null, lens,
      state:"unavailable", ids:Object.freeze([]), count:null, exact:false});
  }
  if (key && activity?.geography_items) {
    const projection = geographyRecordProjection(activity, { key, lens });
    const hasLegacyAxis = scope?.place?.boroughs?.length
      || scope?.place?.community_districts?.length
      || scope?.place?.council_districts?.length;
    // Older materializations may predate the generic key while still carrying
    // the legacy district index. Keep those compatibility scopes working; an
    // explicitly selected generic key remains unavailable rather than widening.
    if (projection.state !== "unavailable" || !hasLegacyAxis) return projection;
  }
  const place = scope?.place || {};
  const index = activity?.district_items;
  const locationScope = place.location_scope;
  const ids = locationScope ? index?.[locationScope]?.[lens] : null;
  if (Array.isArray(ids)) {
    const unique = uniqueIds(ids);
    return Object.freeze({
      schema: GEOGRAPHY_RECORDS_SCHEMA,
      key: null,
      lens,
      state: unique.length ? "ready" : "zero",
      ids: Object.freeze(unique),
      count: unique.length,
      exact: true,
      source: "district_items",
    });
  }
  const level = place.council_districts?.length
    ? "council_district"
    : place.community_districts?.length
      ? "community_district"
      : place.boroughs?.length ? "borough" : null;
  const id = level ? place[`${level}s`]?.[0] : null;
  const levelIds = level
    ? index?.by_level?.[level]?.[id]?.[lens]
    : Object.values(index?.by_level?.borough || {}).flatMap((row) => row?.[lens] || []);
  const unique = uniqueIds(levelIds);
  return Object.freeze({
    schema: GEOGRAPHY_RECORDS_SCHEMA,
    key: null,
    lens,
    state: unique.length ? "ready" : "zero",
    ids: Object.freeze(unique),
    count: unique.length,
    exact: true,
    source: "district_items",
  });
}

export function geographyRecordDestination(scope, lens, base = "/near-you/") {
  const next = scopeWithCanonicalGeography({
    ...scope,
    facets: { ...(scope.facets || {}), domains: [lens] },
  });
  return { href: nearYouUrlFromScope(next, { base }), scope: next };
}
