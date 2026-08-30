/**
 * Pure known-point Land geography contract.
 *
 * Resolves already materialized points only. It does not fetch, geocode,
 * inspect a district or borough, compare addresses, or call a map SDK.
 */

import { normalizeBbl } from "./bbl_mappluto_centroids.mjs";

export const KNOWN_LAND_PROJECT_GEOGRAPHY_SCHEMA = "cityscroll.land_project_geography.v1";

export const KNOWN_LAND_POINT_METHODS = Object.freeze({
  PUBLISHER_POINT: "publisher_point",
  SINGLE_BBL_CENTROID: "single_bbl_centroid",
  MULTI_BBL_ANCHOR: "multi_bbl_anchor",
  PROPERTY_COORDINATE: "property_coordinate",
  GEOMETRY_REPRESENTATIVE_POINT: "geometry_representative_point",
  UNMAPPED: "unmapped",
});

export const KNOWN_LAND_POINT_PRECISIONS = Object.freeze({
  EXACT: "exact",
  ANCHOR: "anchor",
  REPRESENTATIVE: "representative",
});

export const REJECTED_KNOWN_LAND_POINT_METHODS = Object.freeze([
  "address_geocode",
  "borough_centroid",
  "district_guess",
  "neighboring_parcel",
  "outcome_point",
]);

/** Same NYC envelope as MapPLUTO `centroidEntry`. */
export const KNOWN_LAND_POINT_BOUNDS = Object.freeze({
  minLat: 40.4,
  maxLat: 41.0,
  minLon: -74.4,
  maxLon: -73.6,
});

export const KNOWN_LAND_UNMAPPED_REASONS = Object.freeze({
  NO_ACCEPTED_POINT: "no_accepted_point",
  INVALID_RANGE: "invalid_range",
  ADDRESS_GEOCODE_REJECTED: "address_geocode_rejected",
  UNSUPPORTED_METHOD: "unsupported_method",
});

const REJECTED_METHOD_SET = new Set(REJECTED_KNOWN_LAND_POINT_METHODS);

function trimMethod(value) {
  return String(value ?? "").trim();
}

function inKnownLandRange(lat, lon) {
  return (
    lat >= KNOWN_LAND_POINT_BOUNDS.minLat
    && lat <= KNOWN_LAND_POINT_BOUNDS.maxLat
    && lon >= KNOWN_LAND_POINT_BOUNDS.minLon
    && lon <= KNOWN_LAND_POINT_BOUNDS.maxLon
  );
}

function rawLatLon(value) {
  if (value == null) return null;
  if (Array.isArray(value) && value.length >= 2) {
    return { lat: Number(value[0]), lon: Number(value[1]) };
  }
  if (typeof value !== "object") return null;
  if (value.type === "Point" && Array.isArray(value.coordinates) && value.coordinates.length >= 2) {
    return { lat: Number(value.coordinates[1]), lon: Number(value.coordinates[0]) };
  }
  if (
    value.geometry?.type === "Point"
    && Array.isArray(value.geometry.coordinates)
    && value.geometry.coordinates.length >= 2
  ) {
    return { lat: Number(value.geometry.coordinates[1]), lon: Number(value.geometry.coordinates[0]) };
  }
  const pairs = [
    [value.lat, value.lon],
    [value.latitude, value.longitude],
    [value.y, value.x],
    [value.latlng?.lat, value.latlng?.lng],
  ];
  for (const [lat, lon] of pairs) {
    if (lat == null || lon == null || lat === "" || lon === "") continue;
    return { lat: Number(lat), lon: Number(lon) };
  }
  return null;
}

/**
 * Normalize a materialized point. Rejected methods, non-finite values, and
 * out-of-range coordinates stay null.
 *
 * @param {unknown} value
 * @returns {{ lat: number, lon: number }|null}
 */
export function toFiniteKnownLandPoint(value) {
  const classified = classifyKnownLandPoint(value);
  return classified.kind === "accepted" ? { lat: classified.lat, lon: classified.lon } : null;
}

function classifyKnownLandPoint(value) {
  if (value == null) return { kind: "absent" };
  if (typeof value === "object" && !Array.isArray(value) && Object.keys(value).length === 0) {
    return { kind: "absent" };
  }
  const method = trimMethod(value?.method);
  if (method && REJECTED_METHOD_SET.has(method)) {
    return { kind: "rejected_method", method };
  }
  const raw = rawLatLon(value);
  if (!raw) return { kind: "absent" };
  if (!Number.isFinite(raw.lat) || !Number.isFinite(raw.lon)) {
    return { kind: "invalid_range" };
  }
  if (!inKnownLandRange(raw.lat, raw.lon)) {
    return { kind: "invalid_range" };
  }
  return { kind: "accepted", lat: raw.lat, lon: raw.lon };
}

function pointLessThan(a, b) {
  if (a.lat !== b.lat) return a.lat < b.lat;
  return a.lon < b.lon;
}

/**
 * Deduplicate BBL centroids by normalized BBL and sort by BBL id.
 * Conflicting coordinates for one BBL keep the lexicographically smaller pair
 * so arrival order cannot change the set.
 *
 * @param {unknown} values
 * @returns {{ bbl: string, lat: number, lon: number }[]}
 */
export function uniqueKnownBblCentroids(values) {
  const byBbl = new Map();
  const list = Array.isArray(values) ? values : [];
  for (const item of list) {
    const bbl = normalizeBbl(item?.bbl ?? item?.id ?? item?.bbl_id);
    const point = toFiniteKnownLandPoint(item);
    if (!bbl || !point) continue;
    const current = byBbl.get(bbl);
    if (!current || pointLessThan(point, current)) {
      byBbl.set(bbl, { bbl, lat: point.lat, lon: point.lon });
    }
  }
  return [...byBbl.values()].sort((a, b) => (a.bbl < b.bbl ? -1 : a.bbl > b.bbl ? 1 : 0));
}

function squaredDistance(a, b) {
  const dLat = a.lat - b.lat;
  const dLon = a.lon - b.lon;
  return dLat * dLat + dLon * dLon;
}

/**
 * Pick the retained centroid nearest the arithmetic mean. Ties break by BBL id,
 * never by input order. The returned coordinate is one real centroid, not the mean.
 *
 * @param {{ bbl: string, lat: number, lon: number }[]} points
 * @returns {{ bbl: string, lat: number, lon: number, mean: { lat: number, lon: number } }|null}
 */
export function nearestRetainedCentroid(points) {
  const list = Array.isArray(points) ? points : [];
  if (!list.length) return null;
  const mean = {
    lat: list.reduce((sum, point) => sum + point.lat, 0) / list.length,
    lon: list.reduce((sum, point) => sum + point.lon, 0) / list.length,
  };
  let best = null;
  let bestDistance = Infinity;
  for (const point of list) {
    const distance = squaredDistance(point, mean);
    if (
      !best
      || distance < bestDistance
      || (distance === bestDistance && point.bbl < best.bbl)
    ) {
      best = point;
      bestDistance = distance;
    }
  }
  return best ? { bbl: best.bbl, lat: best.lat, lon: best.lon, mean } : null;
}

function mappedResult({ lat, lon, method, precision, bblCount, bbl = null }) {
  return {
    status: "mapped",
    lat,
    lon,
    method,
    precision,
    bblCount,
    bbl,
  };
}

function unmappedResult(reason, bblCount = 0) {
  return {
    status: "unmapped",
    lat: null,
    lon: null,
    method: KNOWN_LAND_POINT_METHODS.UNMAPPED,
    precision: null,
    bblCount,
    bbl: null,
    reason,
  };
}

function collectRejected(classes, classified) {
  if (classified.kind === "rejected_method") {
    classes.rejectedMethods.add(classified.method);
  } else if (classified.kind === "invalid_range") {
    classes.invalid += 1;
  } else if (classified.kind === "absent") {
    classes.absent += 1;
  }
}

function unmappedReasonFrom(classes) {
  const rejected = [...classes.rejectedMethods];
  if (rejected.length && classes.invalid === 0) {
    if (rejected.every((method) => method === "address_geocode")) {
      return KNOWN_LAND_UNMAPPED_REASONS.ADDRESS_GEOCODE_REJECTED;
    }
    return KNOWN_LAND_UNMAPPED_REASONS.UNSUPPORTED_METHOD;
  }
  if (classes.invalid > 0) return KNOWN_LAND_UNMAPPED_REASONS.INVALID_RANGE;
  return KNOWN_LAND_UNMAPPED_REASONS.NO_ACCEPTED_POINT;
}

/**
 * Resolve one known Land project point from already materialized inputs.
 *
 * Priority: publisher point; one exact BBL centroid; a real centroid nearest
 * the mean of multiple known BBL centroids; accepted property coordinate;
 * accepted geometry representative point.
 *
 * @param {{
 *   publisherPoint?: unknown,
 *   bblPoints?: unknown,
 *   propertyPoint?: unknown,
 *   geometryPoint?: unknown,
 * }} [input]
 * @returns {{
 *   status: "mapped"|"unmapped",
 *   lat: number|null,
 *   lon: number|null,
 *   method: string,
 *   precision: string|null,
 *   bblCount: number,
 *   bbl: string|null,
 *   reason?: string,
 * }}
 */
export function resolveKnownLandProjectPoint(input = {}) {
  const classes = {
    rejectedMethods: new Set(),
    invalid: 0,
    absent: 0,
  };

  const publisherClass = classifyKnownLandPoint(input.publisherPoint);
  collectRejected(classes, publisherClass);

  const bblList = Array.isArray(input.bblPoints) ? input.bblPoints : [];
  if (input.bblPoints != null && !Array.isArray(input.bblPoints)) {
    classes.invalid += 1;
  }
  for (const item of bblList) {
    const itemClass = classifyKnownLandPoint(item);
    if (itemClass.kind === "rejected_method" || itemClass.kind === "invalid_range") {
      collectRejected(classes, itemClass);
    }
  }
  const bblPoints = uniqueKnownBblCentroids(bblList);
  const bblCount = bblPoints.length;

  const propertyClass = classifyKnownLandPoint(input.propertyPoint);
  collectRejected(classes, propertyClass);

  const geometryClass = classifyKnownLandPoint(input.geometryPoint);
  collectRejected(classes, geometryClass);

  if (publisherClass.kind === "accepted") {
    return mappedResult({
      lat: publisherClass.lat,
      lon: publisherClass.lon,
      method: KNOWN_LAND_POINT_METHODS.PUBLISHER_POINT,
      precision: KNOWN_LAND_POINT_PRECISIONS.EXACT,
      bblCount,
    });
  }

  if (bblCount === 1) {
    const only = bblPoints[0];
    return mappedResult({
      lat: only.lat,
      lon: only.lon,
      method: KNOWN_LAND_POINT_METHODS.SINGLE_BBL_CENTROID,
      precision: KNOWN_LAND_POINT_PRECISIONS.EXACT,
      bblCount,
      bbl: only.bbl,
    });
  }

  if (bblCount > 1) {
    const anchor = nearestRetainedCentroid(bblPoints);
    return mappedResult({
      lat: anchor.lat,
      lon: anchor.lon,
      method: KNOWN_LAND_POINT_METHODS.MULTI_BBL_ANCHOR,
      precision: KNOWN_LAND_POINT_PRECISIONS.ANCHOR,
      bblCount,
      bbl: anchor.bbl,
    });
  }

  if (propertyClass.kind === "accepted") {
    return mappedResult({
      lat: propertyClass.lat,
      lon: propertyClass.lon,
      method: KNOWN_LAND_POINT_METHODS.PROPERTY_COORDINATE,
      precision: KNOWN_LAND_POINT_PRECISIONS.EXACT,
      bblCount,
    });
  }

  if (geometryClass.kind === "accepted") {
    return mappedResult({
      lat: geometryClass.lat,
      lon: geometryClass.lon,
      method: KNOWN_LAND_POINT_METHODS.GEOMETRY_REPRESENTATIVE_POINT,
      precision: KNOWN_LAND_POINT_PRECISIONS.REPRESENTATIVE,
      bblCount,
    });
  }

  return unmappedResult(unmappedReasonFrom(classes), bblCount);
}
