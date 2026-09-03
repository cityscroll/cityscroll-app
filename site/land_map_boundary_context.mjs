/* Sourced, contextual geography for the Land browse map.
 *
 * This module is deliberately not a Land-result module. A boundary record has no project id,
 * point, count, or watch state. It can be rendered beside the project-point layer and can offer
 * an explicit canonical Land scope link, but it can never participate in the result model.
 */

import {
  NYC_BOUNDS,
  boroughFromCommunityId,
  polygonLabelPoint,
  polygonsToSvgPath,
} from "./map_exploration.mjs";

export const LAND_MAP_BOUNDARY_CONTEXT_SCHEMA = "cityscroll.land_map_boundary_context.v1";

const BOUNDARY_DEFINITIONS = Object.freeze([
  Object.freeze({
    level: "borough",
    artifactUrl: "data/geography/layers/borough/2026-05-26.json",
    idPattern: /^[1-5]$/,
    shortLabel: (record) => record.label,
  }),
  Object.freeze({
    level: "community_district",
    artifactUrl: "data/geography/layers/community_district/2026-05-26.json",
    idPattern: /^(?:M|X|K|Q|R)\d{2}$/,
    shortLabel: (record) => `CD ${Number(String(record.boundary_id).slice(1))}`,
  }),
  Object.freeze({
    level: "council_district",
    artifactUrl: "data/geography/layers/council_district/2026-05-26.json",
    idPattern: /^(?:[1-9]|[1-4]\d|5[01])$/,
    shortLabel: (record) => `Council ${record.boundary_id}`,
  }),
]);

export const LAND_MAP_BOUNDARY_LEVELS = Object.freeze(BOUNDARY_DEFINITIONS.map((definition) => definition.level));
export const LAND_MAP_BOUNDARY_ARTIFACTS = Object.freeze(BOUNDARY_DEFINITIONS.map((definition) => ({
  level: definition.level,
  artifact_url: definition.artifactUrl,
})));

const BOROUGH_BY_CODE = Object.freeze({
  "1": "Manhattan",
  "2": "Bronx",
  "3": "Brooklyn",
  "4": "Queens",
  "5": "Staten Island",
});

const landBoundaryText = (value) => String(value ?? "").replace(/\s+/g, " ").trim();

function escapeLandBoundaryValue(value) {
  return landBoundaryText(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function featureGeometry(feature) {
  const geometry = feature?.geometry;
  if (!geometry || !["Polygon", "MultiPolygon"].includes(geometry.type)) return null;
  if (!Array.isArray(geometry.coordinates) || geometry.coordinates.length === 0) return null;
  return geometry;
}

function geometryPolygons(geometry) {
  if (!geometry) return [];
  if (geometry.type === "Polygon") return [{ rings: geometry.coordinates }];
  return geometry.coordinates.map((rings) => ({ rings }));
}

function landBoundaryValidSource(source) {
  return source && typeof source === "object"
    && landBoundaryText(source.contract_id) && landBoundaryText(source.publisher) && landBoundaryText(source.dataset_id)
    && landBoundaryText(source.url);
}

function normalizeLandBoundaryLayer(payload, definition) {
  if (!payload || typeof payload !== "object") return { state: "unavailable", records: [] };
  if (payload.schema !== "cityscroll.geography_layer.v1") return { state: "malformed", records: [] };
  if (payload.type !== definition.level || payload.crs !== "EPSG:4326") {
    return { state: "malformed", records: [] };
  }
  if (!payload.vintage?.id || !landBoundaryValidSource(payload.source) || !Array.isArray(payload.features)) {
    return { state: "malformed", records: [] };
  }
  const records = [];
  let malformedFeatures = 0;
  for (const feature of payload.features) {
    const boundaryId = landBoundaryText(feature?.id);
    const geometry = featureGeometry(feature);
    if (!definition.idPattern.test(boundaryId) || !landBoundaryText(feature?.label) || !geometry) {
      malformedFeatures += 1;
      continue;
    }
    const polygons = geometryPolygons(geometry);
    if (!polygons.length || !polygons.every((polygon) => polygon.rings?.[0]?.length >= 3)) {
      malformedFeatures += 1;
      continue;
    }
    records.push(Object.freeze({
      boundary_id: boundaryId,
      level: definition.level,
      label: landBoundaryText(feature.label),
      geometry_artifact: Object.freeze({
        url: definition.artifactUrl,
        format: "GeoJSON",
        coordinate_system: "EPSG:4326",
        geometry_fidelity: landBoundaryText(payload.geometry_fidelity) || "simplified",
      }),
      source: Object.freeze({
        contract_id: landBoundaryText(payload.source.contract_id),
        publisher: landBoundaryText(payload.source.publisher),
        dataset_id: landBoundaryText(payload.source.dataset_id),
        dataset_name: landBoundaryText(payload.source.dataset_name),
        url: landBoundaryText(payload.source.url),
      }),
      vintage: Object.freeze({
        id: landBoundaryText(payload.vintage.id),
        published_at: landBoundaryText(payload.vintage.published_at),
      }),
      disclosure_state: "disclosed",
      geometry,
      polygons,
    }));
  }
  records.sort((left, right) => left.boundary_id.localeCompare(right.boundary_id, "en", { numeric: true }));
  return {
    state: malformedFeatures ? (records.length ? "partial" : "malformed") : "ready",
    records,
    malformed_features: malformedFeatures,
    source: payload.source,
    vintage: payload.vintage,
  };
}

export function emptyLandMapBoundaryContext() {
  return Object.freeze({
    schema: LAND_MAP_BOUNDARY_CONTEXT_SCHEMA,
    state: "unavailable",
    layers: Object.freeze([]),
    records: Object.freeze([]),
    missing: Object.freeze(LAND_MAP_BOUNDARY_LEVELS),
  });
}

/** Load only the committed same-origin artifacts. A missing layer never rejects the map. */
export async function loadLandMapBoundaryContext(fetchImpl = globalThis.fetch) {
  if (typeof fetchImpl !== "function") return emptyLandMapBoundaryContext();
  const layers = await Promise.all(BOUNDARY_DEFINITIONS.map(async (definition) => {
    let payload;
    try {
      const response = await fetchImpl(definition.artifactUrl, { cache: "force-cache", credentials: "omit" });
      if (!response?.ok) return { level: definition.level, state: "unavailable", records: [] };
      payload = await response.json();
    } catch (_error) {
      return { level: definition.level, state: "unavailable", records: [] };
    }
    return { level: definition.level, ...normalizeLandBoundaryLayer(payload, definition) };
  }));
  const records = layers.flatMap((layer) => layer.records || []);
  const missing = layers.filter((layer) => layer.state !== "ready" && layer.state !== "partial").map((layer) => layer.level);
  return Object.freeze({
    schema: LAND_MAP_BOUNDARY_CONTEXT_SCHEMA,
    state: missing.length === layers.length ? "unavailable" : missing.length ? "partial" : "ready",
    layers: Object.freeze(layers.map((layer) => Object.freeze({ ...layer, records: Object.freeze(layer.records || []) }))),
    records: Object.freeze(records),
    missing: Object.freeze(missing),
  });
}

function landBoundaryBoroughForRecord(record) {
  if (record.level === "borough") return BOROUGH_BY_CODE[record.boundary_id] || record.label;
  return boroughFromCommunityId(record.boundary_id);
}

/** Explicit handoff only: preserve all canonical Land parameters, changing geography keys. */
export function landBoundaryScopeHref(record, currentHash = "#land") {
  const raw = String(currentHash || "#land");
  const queryIndex = raw.indexOf("?");
  const params = new URLSearchParams(queryIndex < 0 ? "" : raw.slice(queryIndex + 1));
  params.delete("boro");
  params.delete("cd");
  params.delete("council");
  if (record?.level === "borough") {
    params.set("boro", BOROUGH_BY_CODE[record.boundary_id] || record.label);
  } else if (record?.level === "community_district") {
    const borough = landBoundaryBoroughForRecord(record);
    if (borough) params.set("boro", borough);
    params.set("cd", String(record.boundary_id));
  } else if (record?.level === "council_district") {
    params.set("council", String(record.boundary_id));
  }
  const query = params.toString();
  return `#land${query ? `?${query}` : ""}`;
}

function landBoundaryShortLabel(record) {
  const definition = BOUNDARY_DEFINITIONS.find((candidate) => candidate.level === record.level);
  return definition?.shortLabel(record) || record.label;
}

/** Render boundary geometry and label links. Geometry is never interactive. */
export function landMapBoundarySvg(context, {
  escape = escapeLandBoundaryValue,
  currentHash = "#land",
} = {}) {
  const groups = LAND_MAP_BOUNDARY_LEVELS.map((level) => {
    const records = (context?.records || []).filter((record) => record.level === level);
    const geometry = records.map((record) => {
      const path = polygonsToSvgPath(record.polygons, NYC_BOUNDS);
      if (!path) return "";
      return `<path class="land-map-outline land-map-boundary-outline" d="${path}" fill="none"`
        + ` pointer-events="none" data-land-boundary-id="${escape(record.boundary_id)}"`
        + ` data-land-boundary-level="${escape(record.level)}"`
        + ` data-land-boundary-source="${escape(record.source.contract_id)}"`
        + ` data-land-boundary-vintage="${escape(record.vintage.id)}"`
        + ` data-land-boundary-disclosure="${escape(record.disclosure_state)}"><title>${escape(record.label)}</title></path>`;
    }).join("");
    return `<g class="land-map-boundaries-${escape(level)}" aria-hidden="true">${geometry}</g>`;
  }).join("");
  const labels = (context?.records || []).map((record) => {
    const anchor = polygonLabelPoint(record.polygons, NYC_BOUNDS);
    if (!anchor) return "";
    const href = landBoundaryScopeHref(record, currentHash);
    const accessible = `${record.label}; ${record.level}; source ${record.source.publisher}; vintage ${record.vintage.id}`;
    return `<a class="land-map-boundary-label" href="${escape(href)}"`
      + ` data-land-boundary-link="${escape(record.boundary_id)}" data-land-boundary-level="${escape(record.level)}"`
      + ` data-land-boundary-source="${escape(record.source.contract_id)}" data-land-boundary-vintage="${escape(record.vintage.id)}"`
      + ` data-land-boundary-disclosure="${escape(record.disclosure_state)}"`
      + ` aria-label="${escape(accessible)}"><text x="${anchor.x}" y="${anchor.y}" text-anchor="middle">${escape(landBoundaryShortLabel(record))}</text></a>`;
  }).join("");
  return `<g class="land-map-boundary-geometry">${groups}</g><g class="land-map-boundary-labels">${labels}</g>`;
}

export function landMapBoundaryEvidenceHTML(context, {
  t = (key) => key,
  escape = escapeLandBoundaryValue,
} = {}) {
  const layers = Array.isArray(context?.layers) ? context.layers : [];
  const sourceLines = layers.flatMap((layer) => (layer.records?.length ? [{ layer, record: layer.records[0] }] : []));
  const lines = sourceLines.map(({ layer, record }) => `<li data-land-boundary-evidence-level="${escape(record.level)}">`
    + `<span data-land-boundary-evidence-source="${escape(record.source.contract_id)}">${escape(record.label)}</span>`
    + ` — ${escape(t("land_map_boundary_source_line", { source: record.source.publisher, vintage: record.vintage.id }))}</li>`).join("");
  const missing = (context?.missing || []).map((level) => `<li data-land-boundary-missing="${escape(level)}">${escape(t("land_map_boundary_missing_level", { level }))}</li>`).join("");
  const body = lines || missing
    ? `<ul class="land-map-boundary-evidence-list">${lines}${missing}</ul>`
    : `<p>${escape(t("land_map_boundary_unavailable"))}</p>`;
  return `<details class="land-map-boundary-evidence"><summary>${escape(t("land_map_boundary_evidence"))}</summary>`
    + `<p class="land-map-boundary-note">${escape(t("land_map_boundary_context_note"))}</p>${body}</details>`;
}

export { escapeLandBoundaryValue as escapeLandMapBoundaryHTML };
