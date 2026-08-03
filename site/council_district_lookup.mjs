// Pure council-district resolution from a committed boundary layer.
// Point-in-polygon only — no live GIS. Consumed by location awareness,
// worker geocode enrichment, and (later) map aggregation surfaces.

export const COUNCIL_DISTRICT_LAYER_SCHEMA = "cityscroll.district_boundaries.v0";
export const COUNCIL_DISTRICT_ID_RE = /^(?:[1-9]|[1-4]\d|5[01])$/;

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

/**
 * Resolve a WGS84 point against a committed council-district layer.
 * Returns the district id string ("1"…"51") or null when unresolved.
 */
export function resolveCouncilDistrict(lat, lon, layer) {
  const latitude = Number(lat);
  const longitude = Number(lon);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;
  if (!layer || !Array.isArray(layer.districts)) return null;

  for (const district of layer.districts) {
    const id = normalizeCouncilDistrictId(district && district.id);
    if (!id) continue;
    if (!inBbox(longitude, latitude, district.bbox)) continue;
    if (pointInDistrictPolygons(longitude, latitude, district.polygons)) return id;
  }
  return null;
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

/** Load and lightly validate a committed boundary layer document. */
export function loadCouncilDistrictLayer(doc) {
  if (!doc || typeof doc !== "object") return null;
  if (doc.schema && doc.schema !== COUNCIL_DISTRICT_LAYER_SCHEMA) return null;
  if (doc.layer && doc.layer !== "council_district") return null;
  if (!Array.isArray(doc.districts) || doc.districts.length === 0) return null;
  return doc;
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
