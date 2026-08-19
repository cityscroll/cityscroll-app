// Generic point resolver over registered, versioned civic-geography layers.
// Domain adapters decide what a coordinate means; this module only answers
// which published polygons contain that point.

import {
  GEOGRAPHY_LAYER_SCHEMA,
  GEOGRAPHY_MATCHES_SCHEMA,
  civicGeographyKey,
  civicGeographyLayer,
} from "./civic_geography_registry.mjs";

const EPSILON = 1e-10;
const VALIDATED_LAYER_CACHE = new WeakMap();

function finitePoint(point) {
  return Array.isArray(point)
    && point.length >= 2
    && Number.isFinite(Number(point[0]))
    && Number.isFinite(Number(point[1]));
}

function orientation(a, b, p) {
  return (Number(b[0]) - Number(a[0])) * (Number(p[1]) - Number(a[1]))
    - (Number(b[1]) - Number(a[1])) * (Number(p[0]) - Number(a[0]));
}

function pointOnSegment(point, a, b) {
  if (!finitePoint(point) || !finitePoint(a) || !finitePoint(b)) return false;
  if (Math.abs(orientation(a, b, point)) > EPSILON) return false;
  return Number(point[0]) >= Math.min(Number(a[0]), Number(b[0])) - EPSILON
    && Number(point[0]) <= Math.max(Number(a[0]), Number(b[0])) + EPSILON
    && Number(point[1]) >= Math.min(Number(a[1]), Number(b[1])) - EPSILON
    && Number(point[1]) <= Math.max(Number(a[1]), Number(b[1])) + EPSILON;
}

/** Classify a point against one ring as interior, boundary, or exterior. */
export function pointRelationToRing(lon, lat, ring) {
  if (!Array.isArray(ring) || ring.length < 3) return "exterior";
  const point = [Number(lon), Number(lat)];
  if (!finitePoint(point)) return "exterior";
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[j];
    const b = ring[i];
    if (!finitePoint(a) || !finitePoint(b)) continue;
    if (pointOnSegment(point, a, b)) return "boundary";
    const xi = Number(b[0]);
    const yi = Number(b[1]);
    const xj = Number(a[0]);
    const yj = Number(a[1]);
    const crosses = ((yi > point[1]) !== (yj > point[1]))
      && point[0] < ((xj - xi) * (point[1] - yi)) / (yj - yi) + xi;
    if (crosses) inside = !inside;
  }
  return inside ? "interior" : "exterior";
}

export function geoJsonGeometryToPolygons(geometry = null) {
  if (!geometry || typeof geometry !== "object") return [];
  if (geometry.type === "Polygon" && Array.isArray(geometry.coordinates)) {
    return [{ rings: geometry.coordinates }];
  }
  if (geometry.type === "MultiPolygon" && Array.isArray(geometry.coordinates)) {
    return geometry.coordinates.map((rings) => ({ rings }));
  }
  return [];
}

export function civicFeaturePolygons(feature = {}) {
  if (Array.isArray(feature.polygons)) return feature.polygons;
  return geoJsonGeometryToPolygons(feature.geometry);
}

function inBbox(lon, lat, bbox) {
  if (!Array.isArray(bbox) || bbox.length !== 4) return true;
  return lon >= Number(bbox[0]) && lat >= Number(bbox[1])
    && lon <= Number(bbox[2]) && lat <= Number(bbox[3]);
}

/** Classify a point against Polygon/MultiPolygon geometry, including holes. */
export function pointRelationToCivicFeature(lon, lat, feature = {}) {
  if (!inBbox(lon, lat, feature.bbox)) return "exterior";
  for (const polygon of civicFeaturePolygons(feature)) {
    const rings = Array.isArray(polygon?.rings) ? polygon.rings : [];
    if (!rings.length) continue;
    const outer = pointRelationToRing(lon, lat, rings[0]);
    if (outer === "exterior") continue;
    if (outer === "boundary") return "boundary";
    let inHole = false;
    for (const hole of rings.slice(1)) {
      const relation = pointRelationToRing(lon, lat, hole);
      if (relation === "boundary") return "boundary";
      if (relation === "interior") {
        inHole = true;
        break;
      }
    }
    if (!inHole) return "interior";
  }
  return "exterior";
}

export function loadCivicGeographyLayer(doc) {
  if (!doc || typeof doc !== "object" || doc.schema !== GEOGRAPHY_LAYER_SCHEMA) return null;
  if (VALIDATED_LAYER_CACHE.has(doc)) return VALIDATED_LAYER_CACHE.get(doc);
  const definition = civicGeographyLayer(doc.type);
  if (!definition || doc.class !== definition.class) return null;
  if (!doc.vintage?.id || !Array.isArray(doc.features)) return null;
  if (doc.features.some((feature) => !civicGeographyKey(doc.type, feature?.id))) return null;
  VALIDATED_LAYER_CACHE.set(doc, doc);
  return doc;
}

function layerInputs(options = {}) {
  const candidates = Array.isArray(options.layerData)
    ? options.layerData
    : Array.isArray(options.layers)
      ? options.layers.filter((value) => value && typeof value === "object")
      : options.layers && typeof options.layers === "object"
        ? Object.values(options.layers)
        : [];
  return candidates.map(loadCivicGeographyLayer).filter(Boolean);
}

function requestedTypes(options, layers) {
  const explicit = Array.isArray(options.types)
    ? options.types
    : Array.isArray(options.layers) && options.layers.every((value) => typeof value === "string")
      ? options.layers
      : null;
  return [...new Set((explicit || layers.map((layer) => layer.type)).map(String))];
}

function matchForFeature(layer, feature, relation) {
  const definition = civicGeographyLayer(layer.type);
  return {
    key: civicGeographyKey(layer.type, feature.id),
    type: layer.type,
    id: String(feature.id),
    label: String(feature.label || feature.id),
    class: definition.class,
    relation: "contains_point",
    method: relation === "boundary" ? "point_on_polygon_boundary" : "point_in_polygon",
    source_id: layer.source?.contract_id || null,
    boundary_vintage: String(layer.vintage.id),
  };
}

/** Resolve one already loaded layer; the multi-layer resolver composes this. */
export function resolveCivicGeographyLayer(lat, lon, layerDoc) {
  const layer = loadCivicGeographyLayer(layerDoc);
  const latitude = Number(lat);
  const longitude = Number(lon);
  if (!layer) return { matches: [], status: "source_unavailable", vintage: null };
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
    return { matches: [], status: "invalid_point", vintage: layer.vintage.id };
  }
  const matches = [];
  for (const feature of layer.features) {
    const relation = pointRelationToCivicFeature(longitude, latitude, feature);
    if (relation !== "exterior") matches.push(matchForFeature(layer, feature, relation));
  }
  const allowsOverlap = civicGeographyLayer(layer.type)?.cardinality === "zero_or_more_overlaps_allowed";
  return {
    matches,
    status: matches.length > 1 && !allowsOverlap
      ? "ambiguous_boundary"
      : matches.length
        ? "matched"
        : "not_covered",
    vintage: layer.vintage.id,
  };
}

/**
 * Resolve a WGS84 point into typed matches from independently versioned layers.
 * Callers pass layer documents through `layerData`; `types` selects a subset.
 * A missing selected layer is reported without erasing healthy-layer matches.
 */
export function resolveCivicGeographies(lat, lon, options = {}) {
  const latitude = Number(lat);
  const longitude = Number(lon);
  const layers = layerInputs(options);
  const types = requestedTypes(options, layers);
  const byType = new Map(layers.map((layer) => [layer.type, layer]));
  const validPoint = Number.isFinite(latitude) && Number.isFinite(longitude);
  const matches = [];
  const statuses = [];

  for (const type of types) {
    const definition = civicGeographyLayer(type);
    const layer = byType.get(type);
    if (!definition) {
      statuses.push({ type, status: "unknown_layer", vintage: null, match_count: 0 });
      continue;
    }
    if (!layer) {
      statuses.push({ type, status: "source_unavailable", vintage: null, match_count: 0 });
      continue;
    }
    const resolution = validPoint
      ? resolveCivicGeographyLayer(latitude, longitude, layer)
      : { matches: [], status: "invalid_point", vintage: layer.vintage.id };
    matches.push(...resolution.matches);
    statuses.push({
      type,
      status: resolution.status,
      vintage: resolution.vintage,
      match_count: resolution.matches.length,
    });
  }

  return {
    schema: GEOGRAPHY_MATCHES_SCHEMA,
    matches,
    layers: statuses,
  };
}
