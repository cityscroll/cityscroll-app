// Source-independent construction for versioned civic-geography artifacts.
// Publisher-specific field names and ID rules belong in source adapters.

import { createHash } from "node:crypto";

import {
  GEOGRAPHY_LAYER_SCHEMA,
  civicGeographyKey,
} from "../../site/civic_geography_registry.mjs";

export const DEFAULT_DELIVERY_TOLERANCE_DEG = 0.00045;

function round(value, digits = 5) {
  const scale = 10 ** digits;
  return Math.round(Number(value) * scale) / scale;
}

function distanceToSegment(point, start, end) {
  const dx = end[0] - start[0];
  const dy = end[1] - start[1];
  if (dx === 0 && dy === 0) return Math.hypot(point[0] - start[0], point[1] - start[1]);
  let position = ((point[0] - start[0]) * dx + (point[1] - start[1]) * dy) / (dx * dx + dy * dy);
  position = Math.max(0, Math.min(1, position));
  return Math.hypot(
    point[0] - (start[0] + position * dx),
    point[1] - (start[1] + position * dy),
  );
}

function douglasPeucker(points, tolerance) {
  if (points.length <= 2) return points.slice();
  let maxDistance = -1;
  let index = 0;
  const end = points.length - 1;
  for (let cursor = 1; cursor < end; cursor += 1) {
    const distance = distanceToSegment(points[cursor], points[0], points[end]);
    if (distance > maxDistance) {
      maxDistance = distance;
      index = cursor;
    }
  }
  if (maxDistance > tolerance) {
    const left = douglasPeucker(points.slice(0, index + 1), tolerance);
    const right = douglasPeucker(points.slice(index), tolerance);
    return left.slice(0, -1).concat(right);
  }
  return [points[0], points[end]];
}

function normalizedPoint(point) {
  if (!Array.isArray(point) || point.length < 2) return null;
  const lon = Number(point[0]);
  const lat = Number(point[1]);
  return Number.isFinite(lon) && Number.isFinite(lat) ? [lon, lat] : null;
}

function fullRing(ring) {
  if (!Array.isArray(ring)) return null;
  const points = ring.map(normalizedPoint).filter(Boolean);
  if (points.length < 3) return null;
  const first = points[0];
  const last = points[points.length - 1];
  if (first[0] !== last[0] || first[1] !== last[1]) points.push([...first]);
  return points.length >= 4 ? points : null;
}

function simplifiedRing(ring, tolerance) {
  const normalized = fullRing(ring);
  if (!normalized) return null;
  const core = normalized.slice(0, -1);
  let simplified = douglasPeucker(core, tolerance).map((point) => [round(point[0]), round(point[1])]);
  if (simplified.length < 3) return null;
  const first = simplified[0];
  const last = simplified[simplified.length - 1];
  if (first[0] !== last[0] || first[1] !== last[1]) simplified.push([...first]);
  return simplified;
}

function geometryCoordinates(geometry) {
  if (geometry?.type === "Polygon" && Array.isArray(geometry.coordinates)) {
    return [geometry.coordinates];
  }
  if (geometry?.type === "MultiPolygon" && Array.isArray(geometry.coordinates)) {
    return geometry.coordinates;
  }
  return [];
}

export function normalizeMultiPolygonGeometry(geometry, {
  fidelity = "full",
  tolerance = DEFAULT_DELIVERY_TOLERANCE_DEG,
} = {}) {
  const transform = fidelity === "simplified"
    ? (ring) => simplifiedRing(ring, tolerance)
    : fullRing;
  const coordinates = [];
  for (const polygon of geometryCoordinates(geometry)) {
    const rings = (Array.isArray(polygon) ? polygon : []).map(transform).filter(Boolean);
    if (rings.length) coordinates.push(rings);
  }
  return coordinates.length ? { type: "MultiPolygon", coordinates } : null;
}

export function bboxForGeometry(geometry, { rounded = false } = {}) {
  let minLon = Infinity;
  let minLat = Infinity;
  let maxLon = -Infinity;
  let maxLat = -Infinity;
  for (const polygon of geometryCoordinates(geometry)) {
    for (const ring of polygon || []) {
      for (const point of ring || []) {
        const normalized = normalizedPoint(point);
        if (!normalized) continue;
        minLon = Math.min(minLon, normalized[0]);
        minLat = Math.min(minLat, normalized[1]);
        maxLon = Math.max(maxLon, normalized[0]);
        maxLat = Math.max(maxLat, normalized[1]);
      }
    }
  }
  if (!Number.isFinite(minLon)) return null;
  const bbox = [minLon, minLat, maxLon, maxLat];
  return rounded ? bbox.map((value) => round(value)) : bbox;
}

function coverageFor(definition, actual) {
  const expected = Number(definition.coverage?.expected_feature_count);
  const comparison = definition.coverage?.comparison || "at_least";
  const complete = comparison === "exact" ? actual === expected : actual >= expected;
  return {
    status: complete ? "complete" : "incomplete",
    expected_feature_count: expected,
    comparison,
    actual_feature_count: actual,
  };
}

export function buildGeographyLayer({
  definition,
  sourceMeta,
  normalizedFeatures,
  fidelity,
  builtAt,
  deliveryTolerance = DEFAULT_DELIVERY_TOLERANCE_DEG,
}) {
  if (!definition?.type || !sourceMeta?.boundary_vintage) {
    throw new Error("geography layer requires a registered type and source boundary vintage");
  }
  if (!["full", "simplified"].includes(fidelity)) throw new Error(`unknown geometry fidelity ${fidelity}`);
  const features = [];
  const seenIds = new Set();
  const allowedSubtypes = definition.subtypes?.allowed
    ? new Set(definition.subtypes.allowed)
    : null;
  for (const row of normalizedFeatures || []) {
    const key = civicGeographyKey(definition.type, row.id);
    if (!key) throw new Error(`${definition.type}: invalid canonical id ${String(row.id)}`);
    if (seenIds.has(String(row.id))) {
      throw new Error(`${definition.type}: duplicate canonical id ${String(row.id)}`);
    }
    seenIds.add(String(row.id));
    if (definition.subtypes?.required && !row.subtype) {
      throw new Error(`${definition.type}:${row.id}: subtype is required`);
    }
    if (row.subtype && allowedSubtypes && !allowedSubtypes.has(row.subtype)) {
      throw new Error(`${definition.type}:${row.id}: unknown subtype ${String(row.subtype)}`);
    }
    const geometry = normalizeMultiPolygonGeometry(row.geometry, {
      fidelity,
      tolerance: deliveryTolerance,
    });
    if (!geometry) throw new Error(`${definition.type}:${row.id}: missing valid geometry`);
    features.push({
      key,
      type: definition.type,
      id: String(row.id),
      label: String(row.label || row.id),
      subtype: row.subtype || null,
      source_properties: row.source_properties || {},
      bbox: bboxForGeometry(geometry, { rounded: fidelity === "simplified" }),
      geometry,
    });
  }
  return {
    schema: GEOGRAPHY_LAYER_SCHEMA,
    type: definition.type,
    class: definition.class,
    namespace: definition.namespace,
    geometry_fidelity: fidelity,
    source: {
      contract_id: definition.source.contract_id,
      publisher: definition.source.publisher,
      dataset_id: sourceMeta.dataset_id || definition.source.dataset_id,
      dataset_name: sourceMeta.dataset_name || null,
      url: sourceMeta.source_url || definition.source.url,
      updated_at: sourceMeta.source_updated_at || null,
      ...(definition.source.derivation ? { derivation: definition.source.derivation } : {}),
    },
    vintage: {
      id: sourceMeta.boundary_vintage,
      published_at: sourceMeta.source_updated_at || null,
      valid_from: null,
      valid_to: null,
    },
    built_at: builtAt,
    crs: "EPSG:4326",
    normalization: {
      adapter: definition.source_adapter,
      adapter_version: 1,
      delivery_tolerance_deg: fidelity === "simplified" ? deliveryTolerance : null,
    },
    feature_count: features.length,
    coverage: coverageFor(definition, features.length),
    features,
  };
}

export function legacyPolygonsForFeature(feature = {}) {
  return geometryCoordinates(feature.geometry).map((rings) => ({ rings }));
}

export function jsonText(value, { pretty = false } = {}) {
  return `${JSON.stringify(value, null, pretty ? 2 : 0)}\n`;
}

export function sha256Text(value) {
  return createHash("sha256").update(value).digest("hex");
}
