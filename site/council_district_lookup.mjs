// Pure district resolution from the committed boundary layer (community +
// council). Point-in-polygon only — no live GIS. Consumed by location
// awareness, worker geocode enrichment, and map aggregation surfaces.
//
// Accepts the unified v1 document (district_boundaries.json) and the
// council-only v0 twin (council_district_boundaries.json).

export const COUNCIL_DISTRICT_LAYER_SCHEMA = "cityscroll.district_boundaries.v0";
export const DISTRICT_BOUNDARIES_SCHEMA_V1 = "cityscroll.district_boundaries.v1";
export const COUNCIL_DISTRICT_ID_RE = /^(?:[1-9]|[1-4]\d|5[01])$/;
export const COMMUNITY_DISTRICT_ID_RE = /^(?:M|X|K|Q|R)\d{2}$/;

const BORO_PREFIX = { 1: "M", 2: "X", 3: "K", 4: "Q", 5: "R" };
const PREFIX_BORO = { M: 1, X: 2, K: 3, Q: 4, R: 5 };

/**
 * Normalize a council-district id to a bare "1"…"51" string, or null.
 * Accepts numbers, padded strings ("05"), and label fragments.
 */
export function normalizeCouncilDistrictId(value) {
  if (value == null || value === "") return null;
  if (typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 51) {
    return String(value);
  }
  const raw = String(value).trim();
  if (COUNCIL_DISTRICT_ID_RE.test(raw)) return raw;
  const padded = raw.match(/^0?([1-9]|[1-4]\d|5[01])$/);
  if (padded) return String(Number(padded[1]));
  const labeled = raw.match(/(?:council(?:\s+district)?|district)\s*#?\s*([1-9]|[1-4]\d|5[01])\b/i);
  if (labeled) return labeled[1];
  return null;
}

/**
 * Normalize a community-district id to product form "M01"…"R18" (or JIA ids
 * like "M64"), or null. Accepts boro_cd ("404"), product form, and labels.
 */
export function normalizeCommunityDistrictId(value) {
  if (value == null || value === "") return null;
  if (typeof value === "number" && Number.isInteger(value)) {
    const s = String(value);
    if (/^[1-5]\d{2}$/.test(s)) {
      const prefix = BORO_PREFIX[Number(s[0])];
      const dist = Number(s.slice(1));
      if (prefix && dist >= 1) return prefix + String(dist).padStart(2, "0");
    }
    return null;
  }
  const raw = String(value).trim().toUpperCase();
  if (COMMUNITY_DISTRICT_ID_RE.test(raw)) return raw;
  if (/^[1-5]\d{2}$/.test(raw)) {
    const prefix = BORO_PREFIX[Number(raw[0])];
    const dist = Number(raw.slice(1));
    if (prefix && dist >= 1) return prefix + String(dist).padStart(2, "0");
  }
  const labeled = raw.match(
    /(?:(?:MANHATTAN|BRONX|BROOKLYN|QUEENS|STATEN\s*ISLAND)\s+)?(?:COMMUNITY\s+DISTRICT|CD)\s*#?\s*(\d{1,2})\b/i,
  );
  if (labeled) {
    // Label without borough cannot disambiguate — leave unresolved.
    return null;
  }
  return null;
}

/** Ray-cast point-in-ring. Ring is [[lon, lat], ...] (closed or open). */
export function pointInRing(lon, lat, ring) {
  if (!Array.isArray(ring) || ring.length < 3) return false;
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = Number(ring[i][0]);
    const yi = Number(ring[i][1]);
    const xj = Number(ring[j][0]);
    const yj = Number(ring[j][1]);
    if (!Number.isFinite(xi) || !Number.isFinite(yi) || !Number.isFinite(xj) || !Number.isFinite(yj)) {
      continue;
    }
    const intersects = ((yi > lat) !== (yj > lat))
      && (lon < ((xj - xi) * (lat - yi)) / (yj - yi + 0.0) + xi);
    if (intersects) inside = !inside;
  }
  return inside;
}

function inBbox(lon, lat, bbox) {
  if (!Array.isArray(bbox) || bbox.length !== 4) return true;
  return lon >= bbox[0] && lat >= bbox[1] && lon <= bbox[2] && lat <= bbox[3];
}

/**
 * True when the point is inside the outer ring and outside any holes.
 * `polygons` is [{ rings: [outer, ...holes] }, ...].
 */
export function pointInDistrictPolygons(lon, lat, polygons) {
  if (!Array.isArray(polygons)) return false;
  for (const poly of polygons) {
    const rings = poly && Array.isArray(poly.rings) ? poly.rings : null;
    if (!rings || !rings.length) continue;
    if (!pointInRing(lon, lat, rings[0])) continue;
    let inHole = false;
    for (let i = 1; i < rings.length; i++) {
      if (pointInRing(lon, lat, rings[i])) {
        inHole = true;
        break;
      }
    }
    if (!inHole) return true;
  }
  return false;
}

function councilList(layer) {
  if (!layer) return null;
  if (Array.isArray(layer.council_districts)) return layer.council_districts;
  if (Array.isArray(layer.districts) && (layer.layer === "council_district" || !layer.layer)) {
    return layer.districts;
  }
  return null;
}

function communityList(layer) {
  if (!layer) return null;
  if (Array.isArray(layer.community_districts)) return layer.community_districts;
  return null;
}

/**
 * Resolve a WGS84 point against a committed council-district layer.
 * Returns the district id string ("1"…"51") or null when unresolved.
 * Accepts v0 council-only or v1 unified documents.
 */
export function resolveCouncilDistrict(lat, lon, layer) {
  const latitude = Number(lat);
  const longitude = Number(lon);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;
  const districts = councilList(layer);
  if (!districts) return null;

  for (const district of districts) {
    const id = normalizeCouncilDistrictId(district && district.id);
    if (!id) continue;
    if (!inBbox(longitude, latitude, district.bbox)) continue;
    if (pointInDistrictPolygons(longitude, latitude, district.polygons)) return id;
  }
  return null;
}

/**
 * Resolve a WGS84 point against committed community-district polygons.
 * Returns product id ("Q04") or null. Prefers regular CDs (≤18) when the
 * layer lists them before joint-interest areas.
 */
export function resolveCommunityDistrict(lat, lon, layer) {
  const latitude = Number(lat);
  const longitude = Number(lon);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;
  const districts = communityList(layer);
  if (!districts) return null;

  for (const district of districts) {
    const id = normalizeCommunityDistrictId(district && district.id)
      || normalizeCommunityDistrictId(district && district.boro_cd);
    if (!id) continue;
    if (!inBbox(longitude, latitude, district.bbox)) continue;
    if (pointInDistrictPolygons(longitude, latitude, district.polygons)) return id;
  }
  return null;
}

/**
 * Resolve both district kinds from one layer document.
 * Never invents — missing polygons leave the field null.
 */
export function resolveDistricts(lat, lon, layer) {
  return {
    community_district: resolveCommunityDistrict(lat, lon, layer),
    council_district: resolveCouncilDistrict(lat, lon, layer),
    boundary_vintage: layer && layer.boundary_vintage ? String(layer.boundary_vintage) : null,
  };
}

/**
 * Attach council_district onto a geocode-shaped object when coordinates exist.
 * Leaves the field null when the point cannot be resolved — never invents.
 */
export function attachCouncilDistrict(geo, layer) {
  if (!geo || typeof geo !== "object") return geo;
  if (geo.council_district != null && normalizeCouncilDistrictId(geo.council_district)) {
    return { ...geo, council_district: normalizeCouncilDistrictId(geo.council_district) };
  }
  const id = resolveCouncilDistrict(geo.latitude, geo.longitude, layer);
  return { ...geo, council_district: id };
}

/**
 * Attach community_district (+ optional council_district) from the shared layer.
 */
export function attachDistricts(geo, layer) {
  if (!geo || typeof geo !== "object") return geo;
  const out = { ...geo };
  if (out.community_district != null && normalizeCommunityDistrictId(out.community_district)) {
    out.community_district = normalizeCommunityDistrictId(out.community_district);
  } else {
    out.community_district = resolveCommunityDistrict(out.latitude, out.longitude, layer);
  }
  if (out.council_district != null && normalizeCouncilDistrictId(out.council_district)) {
    out.council_district = normalizeCouncilDistrictId(out.council_district);
  } else {
    out.council_district = resolveCouncilDistrict(out.latitude, out.longitude, layer);
  }
  if (layer && layer.boundary_vintage) {
    out.boundary_vintage = String(layer.boundary_vintage);
  }
  return out;
}

/** Load and lightly validate a council-only v0 document. */
export function loadCouncilDistrictLayer(doc) {
  if (!doc || typeof doc !== "object") return null;
  // v1 unified: project council slice into the v0 shape consumers expect.
  if (doc.schema === DISTRICT_BOUNDARIES_SCHEMA_V1 && Array.isArray(doc.council_districts)) {
    return {
      schema: COUNCIL_DISTRICT_LAYER_SCHEMA,
      layer: "council_district",
      dataset_id: doc.sources?.council_district?.dataset_id || "872g-cjhh",
      boundary_vintage: doc.sources?.council_district?.boundary_vintage || doc.boundary_vintage || null,
      district_count: doc.council_district_count || doc.council_districts.length,
      districts: doc.council_districts,
      // Keep community list for dual resolve when callers pass this projected doc.
      community_districts: doc.community_districts,
      sources: doc.sources,
    };
  }
  if (doc.schema && doc.schema !== COUNCIL_DISTRICT_LAYER_SCHEMA) return null;
  if (doc.layer && doc.layer !== "council_district") return null;
  if (!Array.isArray(doc.districts) || doc.districts.length === 0) return null;
  return doc;
}

/**
 * Load the unified v1 boundary layer (community + council).
 * Also accepts a council-only v0 document (community resolve will be null).
 */
export function loadDistrictBoundariesLayer(doc) {
  if (!doc || typeof doc !== "object") return null;
  if (doc.schema === DISTRICT_BOUNDARIES_SCHEMA_V1) {
    if (!Array.isArray(doc.council_districts) || !doc.council_districts.length) return null;
    if (!Array.isArray(doc.community_districts) || !doc.community_districts.length) return null;
    if (!doc.boundary_vintage) return null;
    return doc;
  }
  // Council-only v0 — still usable for council resolve.
  const council = loadCouncilDistrictLayer(doc);
  if (!council) return null;
  return {
    schema: DISTRICT_BOUNDARIES_SCHEMA_V1,
    boundary_vintage: council.boundary_vintage || null,
    sources: {
      council_district: {
        dataset_id: council.dataset_id,
        boundary_vintage: council.boundary_vintage,
      },
    },
    community_district_count: 0,
    council_district_count: council.district_count || council.districts.length,
    community_districts: [],
    council_districts: council.districts,
  };
}

/** Labeled vintage for UI ("districts as of {vintage}"). */
export function boundaryVintageLabel(layer) {
  if (!layer || !layer.boundary_vintage) return null;
  return String(layer.boundary_vintage);
}

/**
 * SoQL fragment for ZAP `cc_district` filtering.
 * Singles are exact; multi-district cells concatenate zero-padded pairs
 * (e.g. "213025" = 21, 30, 25), so padded substring matches are safe for 1–51.
 */
export function zapCouncilDistrictWhere(councilDistrict) {
  const id = normalizeCouncilDistrictId(councilDistrict);
  if (!id) return "";
  const padded = id.padStart(2, "0");
  const escaped = id.replace(/'/g, "''");
  const paddedEsc = padded.replace(/'/g, "''");
  // LIKE uppercase: SoQL fragment, not user-facing copy (stray-English gate).
  return ` AND (cc_district='${escaped}' OR cc_district LIKE '%${paddedEsc}%')`;
}

/**
 * SoQL fragment for ZAP `community_district` filtering (product form M04 / Q04).
 */
export function zapCommunityDistrictWhere(communityDistrict) {
  const id = normalizeCommunityDistrictId(communityDistrict);
  if (!id) return "";
  const escaped = id.replace(/'/g, "''");
  return ` AND community_district like '%${escaped}%'`;
}

export { PREFIX_BORO, BORO_PREFIX };
