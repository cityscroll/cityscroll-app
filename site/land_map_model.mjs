/**
 * Pure Land Map projection over already filtered result rows.
 *
 * Joins canonical `project_id` values to the precomputed project-point
 * lookup. It does not filter, search, fetch, or invent projects from
 * point keys that are absent from the filtered rows.
 */

import {
  KNOWN_LAND_POINT_METHODS,
  KNOWN_LAND_POINT_PRECISIONS,
  KNOWN_LAND_UNMAPPED_REASONS,
  REJECTED_KNOWN_LAND_POINT_METHODS,
  toFiniteKnownLandPoint,
} from "./land_project_geography.mjs";

export const LAND_MAP_MODEL_SCHEMA = "cityscroll.land_map_model.v1";
export const LAND_MAP_MODEL_JOIN = "exact_project_id";

export const LAND_MAP_ACCEPTED_POINT_METHODS = Object.freeze([
  KNOWN_LAND_POINT_METHODS.PUBLISHER_POINT,
  KNOWN_LAND_POINT_METHODS.SINGLE_BBL_CENTROID,
  KNOWN_LAND_POINT_METHODS.MULTI_BBL_ANCHOR,
  KNOWN_LAND_POINT_METHODS.PROPERTY_COORDINATE,
  KNOWN_LAND_POINT_METHODS.GEOMETRY_REPRESENTATIVE_POINT,
]);

export const LAND_MAP_UNMAPPED_REASONS = Object.freeze({
  POINT_ABSENT: "point_absent",
  ...KNOWN_LAND_UNMAPPED_REASONS,
});

const ACCEPTED_METHOD_SET = new Set(LAND_MAP_ACCEPTED_POINT_METHODS);
const ACCEPTED_PRECISION_SET = new Set(Object.values(KNOWN_LAND_POINT_PRECISIONS));
const REJECTED_METHOD_SET = new Set(REJECTED_KNOWN_LAND_POINT_METHODS);

const METHOD_PRECISION = Object.freeze({
  [KNOWN_LAND_POINT_METHODS.PUBLISHER_POINT]: KNOWN_LAND_POINT_PRECISIONS.EXACT,
  [KNOWN_LAND_POINT_METHODS.SINGLE_BBL_CENTROID]: KNOWN_LAND_POINT_PRECISIONS.EXACT,
  [KNOWN_LAND_POINT_METHODS.MULTI_BBL_ANCHOR]: KNOWN_LAND_POINT_PRECISIONS.ANCHOR,
  [KNOWN_LAND_POINT_METHODS.PROPERTY_COORDINATE]: KNOWN_LAND_POINT_PRECISIONS.REPRESENTATIVE,
  [KNOWN_LAND_POINT_METHODS.GEOMETRY_REPRESENTATIVE_POINT]: KNOWN_LAND_POINT_PRECISIONS.REPRESENTATIVE,
});

function trimId(value) {
  return String(value ?? "").trim();
}

function asObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}

function pointBag(pointLookup) {
  if (!pointLookup) return null;
  if (pointLookup instanceof Map) return pointLookup;
  const object = asObject(pointLookup);
  if (!object) return Array.isArray(pointLookup) ? pointLookup : null;
  if (Object.prototype.hasOwnProperty.call(object, "points")) return object.points;
  return object;
}

/**
 * Index point entries by canonical project id. First occurrence wins so a
 * duplicate lookup key cannot mint a second join.
 *
 * @param {unknown} pointLookup
 * @returns {Map<string, object>}
 */
export function indexLandMapPoints(pointLookup) {
  const bag = pointBag(pointLookup);
  const indexed = new Map();
  if (!bag) return indexed;
  if (bag instanceof Map) {
    for (const [key, entry] of bag) {
      const projectId = trimId(asObject(entry)?.project_id) || trimId(key);
      if (!projectId || indexed.has(projectId)) continue;
      indexed.set(projectId, entry);
    }
    return indexed;
  }
  if (Array.isArray(bag)) {
    for (const entry of bag) {
      const projectId = trimId(asObject(entry)?.project_id || asObject(entry)?.id);
      if (!projectId || indexed.has(projectId)) continue;
      indexed.set(projectId, entry);
    }
    return indexed;
  }
  const object = asObject(bag);
  if (!object) return indexed;
  for (const [key, entry] of Object.entries(object)) {
    const projectId = trimId(asObject(entry)?.project_id) || trimId(key);
    if (!projectId || indexed.has(projectId)) continue;
    indexed.set(projectId, entry);
  }
  return indexed;
}

function rejectedReason(method) {
  return method === "address_geocode"
    ? LAND_MAP_UNMAPPED_REASONS.ADDRESS_GEOCODE_REJECTED
    : LAND_MAP_UNMAPPED_REASONS.UNSUPPORTED_METHOD;
}

function integerCount(value) {
  const count = Number(value);
  return Number.isInteger(count) && count >= 0 ? count : null;
}

function resolveJoin(entry) {
  if (entry == null) {
    return { status: "unmapped", reason: LAND_MAP_UNMAPPED_REASONS.POINT_ABSENT };
  }
  const record = asObject(entry);
  if (!record) {
    return { status: "unmapped", reason: LAND_MAP_UNMAPPED_REASONS.NO_ACCEPTED_POINT };
  }
  const method = trimId(record.method);
  if (REJECTED_METHOD_SET.has(method)) {
    return { status: "unmapped", reason: rejectedReason(method) };
  }
  if (method && !ACCEPTED_METHOD_SET.has(method)) {
    return { status: "unmapped", reason: LAND_MAP_UNMAPPED_REASONS.UNSUPPORTED_METHOD };
  }
  const finite = toFiniteKnownLandPoint(record);
  if (!finite) {
    if (!method && !rawHasCoordinates(record)) {
      return { status: "unmapped", reason: LAND_MAP_UNMAPPED_REASONS.NO_ACCEPTED_POINT };
    }
    return { status: "unmapped", reason: LAND_MAP_UNMAPPED_REASONS.INVALID_RANGE };
  }
  if (!ACCEPTED_METHOD_SET.has(method)) {
    return { status: "unmapped", reason: LAND_MAP_UNMAPPED_REASONS.NO_ACCEPTED_POINT };
  }
  const precisionRaw = trimId(record.precision);
  const precision = ACCEPTED_PRECISION_SET.has(precisionRaw)
    ? precisionRaw
    : METHOD_PRECISION[method];
  return {
    status: "mapped",
    lat: finite.lat,
    lon: finite.lon,
    method,
    precision,
    bblCount: integerCount(record.bbl_count ?? record.bblCount),
  };
}

function rawHasCoordinates(record) {
  return record.lat != null
    || record.lon != null
    || record.latitude != null
    || record.longitude != null
    || Array.isArray(record.coordinates)
    || record.geometry != null;
}

function freezeFilters(filters) {
  const record = asObject(filters);
  return record ? Object.freeze({ ...record }) : null;
}

function markerFrom({ projectId, row, point, selected }) {
  return Object.freeze({
    projectId,
    lat: point.lat,
    lon: point.lon,
    method: point.method,
    precision: point.precision,
    bblCount: point.bblCount,
    title: row?.project_name ?? null,
    selected,
  });
}

function boundsFromMarkers(markers) {
  if (!markers.length) return null;
  let minLat = Infinity;
  let maxLat = -Infinity;
  let minLon = Infinity;
  let maxLon = -Infinity;
  for (const marker of markers) {
    if (marker.lat < minLat) minLat = marker.lat;
    if (marker.lat > maxLat) maxLat = marker.lat;
    if (marker.lon < minLon) minLon = marker.lon;
    if (marker.lon > maxLon) maxLon = marker.lon;
  }
  return Object.freeze({ minLat, maxLat, minLon, maxLon });
}

/**
 * Project already filtered Land rows into mapped markers and explicit
 * unmapped identities. Point keys that are not in `rows` are ignored.
 *
 * @param {{
 *   rows?: unknown,
 *   pointLookup?: unknown,
 *   selectedProjectId?: unknown,
 *   filters?: unknown,
 * }} [input]
 */
export function buildLandMapModel({
  rows,
  pointLookup,
  selectedProjectId,
  filters,
} = {}) {
  const points = indexLandMapPoints(pointLookup);
  const mapped = [];
  const unmapped = [];
  const markers = [];
  const seen = new Set();
  const list = Array.isArray(rows) ? rows : [];

  for (const row of list) {
    const projectId = trimId(asObject(row)?.project_id ?? row?.project_id);
    if (!projectId || seen.has(projectId)) continue;
    seen.add(projectId);
    const join = resolveJoin(points.get(projectId));
    if (join.status === "mapped") {
      mapped.push(Object.freeze({
        projectId,
        row,
        point: Object.freeze({
          lat: join.lat,
          lon: join.lon,
          method: join.method,
          precision: join.precision,
          bblCount: join.bblCount,
        }),
      }));
    } else {
      unmapped.push(Object.freeze({
        projectId,
        row,
        reason: join.reason,
      }));
    }
  }

  const requestedId = trimId(selectedProjectId) || null;
  const selectedId = requestedId && seen.has(requestedId) ? requestedId : null;
  for (const item of mapped) {
    markers.push(markerFrom({
      projectId: item.projectId,
      row: item.row,
      point: item.point,
      selected: item.projectId === selectedId,
    }));
  }

  const selectedMapped = mapped.find((item) => item.projectId === selectedId) || null;
  const selectedUnmapped = unmapped.find((item) => item.projectId === selectedId) || null;
  const selectedMarker = selectedMapped
    ? markers.find((item) => item.projectId === selectedId) || null
    : null;

  return Object.freeze({
    schema: LAND_MAP_MODEL_SCHEMA,
    join: LAND_MAP_MODEL_JOIN,
    filters: freezeFilters(filters),
    mapped: Object.freeze(mapped),
    unmapped: Object.freeze(unmapped),
    markers: Object.freeze(markers),
    selectedProjectId: selectedMarker ? selectedId : null,
    selectedRow: selectedMapped?.row || selectedUnmapped?.row || null,
    selectedMarker,
    bounds: boundsFromMarkers(markers),
    counts: Object.freeze({
      total: mapped.length + unmapped.length,
      mapped: mapped.length,
      unmapped: unmapped.length,
    }),
  });
}
