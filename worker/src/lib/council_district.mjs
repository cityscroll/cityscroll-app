// Worker-side district resolution from the committed boundary layer.
// Precompute-first: simplified polygons ship with the worker bundle twin;
// no live GIS at request time. Prefers the unified v1 artifact.

import unifiedDoc from "../data/district_boundaries.json" with { type: "json" };
import {
  attachCouncilDistrict,
  attachDistricts,
  loadDistrictBoundariesLayer,
  resolveCommunityDistrict,
  resolveCouncilDistrict,
  resolveDistricts,
} from "../../../site/council_district_lookup.mjs";

const LAYER = loadDistrictBoundariesLayer(unifiedDoc);

export function councilDistrictLayer() {
  return LAYER;
}

export function districtBoundariesLayer() {
  return LAYER;
}

export function resolveCouncilDistrictAt(lat, lon) {
  return resolveCouncilDistrict(lat, lon, LAYER);
}

export function resolveCommunityDistrictAt(lat, lon) {
  return resolveCommunityDistrict(lat, lon, LAYER);
}

export function resolveDistrictsAt(lat, lon) {
  return resolveDistricts(lat, lon, LAYER);
}

/** Enrich a GeoSearch-shaped object with council_district when coords exist. */
export function withCouncilDistrict(geo) {
  if (!geo) return geo;
  return attachCouncilDistrict(geo, LAYER);
}

/** Enrich with community + council districts from the shared layer. */
export function withDistricts(geo) {
  if (!geo) return geo;
  return attachDistricts(geo, LAYER);
}

export { attachCouncilDistrict, attachDistricts };
