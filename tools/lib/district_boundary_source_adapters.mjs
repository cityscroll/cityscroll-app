// NYC Open Data adapters for the three baseline civic-geography layers.
// Upstream field names stay source-native here; generic layer construction
// never needs to know about `boro_cd` or `coundist`.

const BOROUGH_BY_CODE = Object.freeze({
  1: { id: "1", prefix: "M", label: "Manhattan" },
  2: { id: "2", prefix: "X", label: "Bronx" },
  3: { id: "3", prefix: "K", label: "Brooklyn" },
  4: { id: "4", prefix: "Q", label: "Queens" },
  5: { id: "5", prefix: "R", label: "Staten Island" },
});

const BOROUGH_CODE_BY_PREFIX = Object.freeze(Object.fromEntries(
  Object.entries(BOROUGH_BY_CODE).map(([code, value]) => [value.prefix, code]),
));

function coordinatesAsMultiPolygon(geometry) {
  if (geometry?.type === "Polygon" && Array.isArray(geometry.coordinates)) {
    return [geometry.coordinates];
  }
  if (geometry?.type === "MultiPolygon" && Array.isArray(geometry.coordinates)) {
    return geometry.coordinates;
  }
  return [];
}

function mergeGeometry(target, geometry) {
  target.geometry.coordinates.push(...coordinatesAsMultiPolygon(geometry));
}

/** boro_cd "404" → product id "Q04"; special-area suffixes stay intact. */
export function communityIdFromBoroCd(value) {
  const raw = String(value || "").trim();
  if (!/^[1-5]\d{2}$/.test(raw)) return null;
  const borough = BOROUGH_BY_CODE[Number(raw[0])];
  const district = Number(raw.slice(1));
  if (!borough || !Number.isInteger(district) || district < 1) return null;
  return `${borough.prefix}${String(district).padStart(2, "0")}`;
}

function communityLabel(id, boroCd) {
  const borough = BOROUGH_BY_CODE[Number(String(boroCd)[0])]?.label || "NYC";
  const district = Number(String(id).slice(1));
  return district >= 1 && district <= 18
    ? `${borough} Community District ${district}`
    : `${borough} community district area ${boroCd}`;
}

export function normalizeCommunityDistrictSource(geojson = {}) {
  const byId = new Map();
  for (const feature of geojson.features || []) {
    const boroCd = String(feature.properties?.boro_cd ?? feature.properties?.boroCd ?? "").trim();
    const id = communityIdFromBoroCd(boroCd);
    if (!id || !coordinatesAsMultiPolygon(feature.geometry).length) continue;
    const existing = byId.get(id);
    if (existing) {
      mergeGeometry(existing, feature.geometry);
      continue;
    }
    byId.set(id, {
      id,
      label: communityLabel(id, boroCd),
      subtype: Number(id.slice(1)) <= 18 ? "regular" : "joint_interest_area",
      source_properties: { boro_cd: boroCd },
      geometry: { type: "MultiPolygon", coordinates: [...coordinatesAsMultiPolygon(feature.geometry)] },
    });
  }
  return [...byId.values()].sort((left, right) => {
    const leftSpecial = left.subtype === "regular" ? 0 : 1;
    const rightSpecial = right.subtype === "regular" ? 0 : 1;
    return leftSpecial - rightSpecial || left.id.localeCompare(right.id);
  });
}

export function normalizeCouncilDistrictSource(geojson = {}) {
  const byId = new Map();
  for (const feature of geojson.features || []) {
    const raw = feature.properties?.coundist ?? feature.properties?.counDist;
    const id = String(raw ?? "").trim().replace(/^0+/, "") || String(raw ?? "").trim();
    if (!/^(?:[1-9]|[1-4]\d|5[01])$/.test(id) || !coordinatesAsMultiPolygon(feature.geometry).length) continue;
    const existing = byId.get(id);
    if (existing) {
      mergeGeometry(existing, feature.geometry);
      continue;
    }
    byId.set(id, {
      id,
      label: `City Council District ${id}`,
      subtype: null,
      source_properties: { coundist: id },
      geometry: { type: "MultiPolygon", coordinates: [...coordinatesAsMultiPolygon(feature.geometry)] },
    });
  }
  return [...byId.values()].sort((left, right) => Number(left.id) - Number(right.id));
}

/** Borough geometry is the source-native boro_cd partition, not a name guess. */
export function normalizeBoroughSource(communityFeatures = []) {
  const byId = new Map();
  for (const feature of communityFeatures) {
    const code = BOROUGH_CODE_BY_PREFIX[String(feature.id || "")[0]];
    const borough = BOROUGH_BY_CODE[Number(code)];
    if (!borough || !coordinatesAsMultiPolygon(feature.geometry).length) continue;
    const existing = byId.get(borough.id);
    if (existing) {
      mergeGeometry(existing, feature.geometry);
      continue;
    }
    byId.set(borough.id, {
      id: borough.id,
      label: borough.label,
      subtype: null,
      source_properties: { boro_code: borough.id, boro_name: borough.label },
      geometry: { type: "MultiPolygon", coordinates: [...coordinatesAsMultiPolygon(feature.geometry)] },
    });
  }
  return [...byId.values()].sort((left, right) => Number(left.id) - Number(right.id));
}

export { BOROUGH_BY_CODE };
