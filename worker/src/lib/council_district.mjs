// Worker-side council-district resolution from the committed boundary layer.
// Precompute-first: the simplified polygons ship with the worker bundle twin;
// no live GIS at request time.

import layerDoc from "../data/council_district_boundaries.json" with { type: "json" };
import {
  attachCouncilDistrict,
  loadCouncilDistrictLayer,
  resolveCouncilDistrict,
} from "../../../site/council_district_lookup.mjs";

const LAYER = loadCouncilDistrictLayer(layerDoc);

export function councilDistrictLayer() {
  return LAYER;
}

export function resolveCouncilDistrictAt(lat, lon) {
  return resolveCouncilDistrict(lat, lon, LAYER);
}

/** Enrich a GeoSearch-shaped object with council_district when coords exist. */
export function withCouncilDistrict(geo) {
  if (!geo) return geo;
  return attachCouncilDistrict(geo, LAYER);
}
