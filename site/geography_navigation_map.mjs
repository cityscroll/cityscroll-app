/**
 * Progressive MapLibre adapter for Near You geography navigation.
 *
 * Renderer-only: state, record membership, and overlap percentages stay outside
 * this module. Civic polygons come from committed simplified layer artifacts.
 * Basemap tiles are contextual decoration; their failure must not remove local
 * boundaries, controls, or selection. Land continues to use map_runtime.mjs.
 */

import {
  GEOGRAPHY_NAVIGATION_LAYER_TYPES,
  isResidentialNeighborhoodSubtype,
  ntaResidentLabelPolicy,
} from "./geography_navigation_capability.mjs";
import { NYC_BOUNDS } from "./map_exploration.mjs";
import { civicFeaturePolygons } from "./civic_geography.mjs";

/** Schema id avoids the private-terms geography+navigation fold. */
export const RESIDENT_GEOGRAPHY_MAP_SCHEMA = "cityscroll.resident_geography_map.v1";

export const MAPLIBRE_PIN = Object.freeze({
  version: "4.7.1",
  license: "BSD-3-Clause",
  js: "vendor/maplibre-gl-4.7.1.js",
  css: "vendor/maplibre-gl-4.7.1.css",
  worker: "vendor/maplibre-gl-4.7.1-csp-worker.js",
  licenseNotice: "vendor/maplibre-gl-LICENSE.txt",
});

/** Carto light basemap already approved for CityScroll Land maps. */
export const GEOGRAPHY_MAP_BASEMAP = Object.freeze({
  id: "carto-light",
  tiles: Object.freeze([
    "https://a.basemaps.cartocdn.com/light_all/{z}/{x}/{y}.png",
    "https://b.basemaps.cartocdn.com/light_all/{z}/{x}/{y}.png",
    "https://c.basemaps.cartocdn.com/light_all/{z}/{x}/{y}.png",
    "https://d.basemaps.cartocdn.com/light_all/{z}/{x}/{y}.png",
  ]),
  attribution: "© OpenStreetMap © CARTO",
  tileSize: 256,
  maxzoom: 19,
  // Decorative only — never civic evidence.
  role: "contextual_decoration",
});

/**
 * Binding visual contract as named style constants (commission hierarchy).
 * Quiet categorical browsing — not a choropleth unless a later records view
 * explicitly opts into density paint.
 */
export const GEOGRAPHY_MAP_STYLE = Object.freeze({
  BACKGROUND_COLOR: "#f4f1ea",
  ACTIVE_FILL_COLOR: "#1b3a8f",
  ACTIVE_FILL_OPACITY: 0.11,
  ACTIVE_LINE_COLOR: "#5a6570",
  ACTIVE_LINE_WIDTH: 1,
  HOVER_FILL_COLOR: "#166b70",
  HOVER_FILL_OPACITY: 0.16,
  HOVER_LINE_COLOR: "#0f4f54",
  HOVER_LINE_WIDTH: 2,
  SELECTED_FILL_COLOR: "#0b3d42",
  SELECTED_FILL_OPACITY: 0.2,
  SELECTED_LINE_COLOR: "#062428",
  SELECTED_LINE_WIDTH: 3,
  /** Non-color distinction for selection (width + solid vs comparison dash). */
  SELECTED_LINE_DASHARRAY: Object.freeze([1, 0]),
  COMPARISON_FILL_COLOR: "#7a4e16",
  COMPARISON_FILL_OPACITY: 0.06,
  COMPARISON_LINE_COLOR: "#7a4e16",
  COMPARISON_LINE_WIDTH: 1.5,
  COMPARISON_LINE_DASHARRAY: Object.freeze([2, 2]),
  LABEL_TEXT_COLOR: "#202c32",
  LABEL_HALO_COLOR: "#f7f4ed",
  LABEL_HALO_WIDTH: 1.5,
  LABEL_SIZE: 12,
  SELECTED_LABEL_SIZE: 13,
  SPECIAL_USE_MIN_ZOOM: 12,
  POINT_MARKER_COLOR: "#166b70",
  POINT_MARKER_RADIUS: 6,
  FORCED_COLORS_SELECTED_LINE_WIDTH: 4,
});

export const GEOGRAPHY_MAP_SOURCE_IDS = Object.freeze({
  basemap: "geography-basemap",
  active: "geography-active",
  comparison: "geography-comparison",
  selected: "geography-selected",
  point: "geography-point",
});

export const GEOGRAPHY_MAP_LAYER_IDS = Object.freeze({
  basemap: "geography-basemap-raster",
  activeFill: "geography-active-fill",
  activeLine: "geography-active-line",
  comparisonFill: "geography-comparison-fill",
  comparisonLine: "geography-comparison-line",
  hoverFill: "geography-hover-fill",
  hoverLine: "geography-hover-line",
  selectedFill: "geography-selected-fill",
  selectedLine: "geography-selected-line",
  labels: "geography-labels",
  selectedLabel: "geography-selected-label",
  point: "geography-point-circle",
});

export const GEOGRAPHY_MAP_FALLBACK_REASONS = Object.freeze({
  dynamic_import: "dynamic_import_failure",
  webgl_unsupported: "webgl_unsupported",
  context_lost: "webgl_context_lost",
  style_failure: "style_failure",
  layer_load: "local_layer_failure",
  tile_failure: "basemap_tile_failure",
  destroy: "destroyed",
});

const FEATURE_STATE_HOVER = "hover";
const FEATURE_STATE_FOCUS = "focus";
const FEATURE_STATE_SELECTED = "selected";

const EMPTY_FEATURE_COLLECTION = Object.freeze({
  type: "FeatureCollection",
  features: Object.freeze([]),
});

function asFiniteNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function prefersReducedMotion(matchMedia = globalThis.matchMedia) {
  try {
    return Boolean(matchMedia?.("(prefers-reduced-motion: reduce)")?.matches);
  } catch {
    return false;
  }
}

function prefersForcedColors(matchMedia = globalThis.matchMedia) {
  try {
    return Boolean(matchMedia?.("(forced-colors: active)")?.matches);
  } catch {
    return false;
  }
}

function vendorUrl(relativePath, baseUrl = import.meta.url) {
  return new URL(`./${relativePath}`, baseUrl).href;
}

/** Resolve the committed simplified site artifact URL for a navigation layer. */
export function simplifiedLayerSiteUrl(type, registry, { siteRoot = "/" } = {}) {
  const layerType = String(type || "");
  if (!GEOGRAPHY_NAVIGATION_LAYER_TYPES.includes(layerType)) return null;
  const layers = Array.isArray(registry?.layers) ? registry.layers : [];
  const layer = layers.find((entry) => entry?.type === layerType);
  const sitePath = layer?.artifacts?.simplified?.site_path;
  if (!sitePath || typeof sitePath !== "string") return null;
  if (isPublisherGisUrl(sitePath)) {
    throw new Error("publisher_gis_url_forbidden");
  }
  if (!sitePath.startsWith("site/data/")) return null;
  const publicPath = sitePath.slice("site/".length);
  const root = String(siteRoot || "/").endsWith("/")
    ? String(siteRoot || "/")
    : `${siteRoot}/`;
  return new URL(publicPath, `https://cityscroll.invalid${root}`).pathname;
}

/** Reject live publisher GIS hosts in resident layer fetches. */
export function isPublisherGisUrl(url) {
  const text = String(url || "").toLowerCase();
  return /s-media\.nyc\.gov|data\.cityofnewyork\.us|nyc\.gov\/.*planning|arcgis|services\.arcgis/.test(text);
}

/**
 * Project a civic layer document into MapLibre GeoJSON with promoteId=key.
 * Preserves canonical labels; never substitutes codes for visible names.
 */
export function projectLayerCollectionForMap(layerDoc, { layerType = null } = {}) {
  const type = String(layerType || layerDoc?.type || "");
  const features = Array.isArray(layerDoc?.features) ? layerDoc.features : [];
  const projected = [];
  for (const feature of features) {
    if (!feature || typeof feature !== "object") continue;
    const id = String(feature.id ?? "").trim();
    const key = String(feature.key || (type && id ? `geography:${type}:${id}` : "")).trim();
    const label = String(feature.label || "").trim();
    if (!key || !label || !feature.geometry) continue;
    const subtype = feature.subtype == null ? null : String(feature.subtype);
    const labelPolicy = type === "nta2020"
      ? ntaResidentLabelPolicy(subtype)
      : Object.freeze({ may_label_as_neighborhood: true, subtype });
    const anchor = interiorLabelLonLat(feature);
    projected.push({
      type: "Feature",
      id: key,
      geometry: feature.geometry,
      properties: {
        key,
        id,
        type: type || String(feature.type || ""),
        label,
        subtype,
        may_label_as_neighborhood: Boolean(labelPolicy.may_label_as_neighborhood),
        is_special_use: type === "nta2020" && !isResidentialNeighborhoodSubtype(subtype),
        label_lon: anchor?.[0] ?? null,
        label_lat: anchor?.[1] ?? null,
      },
    });
  }
  return {
    type: "FeatureCollection",
    features: projected,
    geometry_fidelity: layerDoc?.geometry_fidelity || "simplified",
    layer_type: type || null,
    vintage: layerDoc?.vintage || null,
  };
}

/** Deterministic interior label anchor in lon/lat (not SVG space). */
export function interiorLabelLonLat(feature) {
  const polygons = civicFeaturePolygons(feature);
  let best = null;
  let bestDistance = -1;
  for (const polygon of polygons) {
    const outer = polygon?.rings?.[0];
    if (!Array.isArray(outer) || outer.length < 3) continue;
    const xs = outer.map((point) => Number(point[0]));
    const ys = outer.map((point) => Number(point[1]));
    const box = [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
    const candidates = [
      [(box[0] + box[2]) / 2, (box[1] + box[3]) / 2],
    ];
    for (let gx = 1; gx < 10; gx++) {
      for (let gy = 1; gy < 10; gy++) {
        candidates.push([
          box[0] + ((box[2] - box[0]) * gx) / 10,
          box[1] + ((box[3] - box[1]) * gy) / 10,
        ]);
      }
    }
    for (const point of candidates) {
      if (!pointInPolygonLonLat(point, polygon)) continue;
      const distance = edgeDistanceLonLat(point, polygon);
      if (distance > bestDistance) {
        best = point;
        bestDistance = distance;
      }
    }
  }
  if (best) {
    return [
      Number(best[0].toFixed(6)),
      Number(best[1].toFixed(6)),
    ];
  }
  const bbox = Array.isArray(feature?.bbox) && feature.bbox.length === 4
    ? feature.bbox
    : null;
  if (!bbox) return null;
  return [
    Number(((Number(bbox[0]) + Number(bbox[2])) / 2).toFixed(6)),
    Number(((Number(bbox[1]) + Number(bbox[3])) / 2).toFixed(6)),
  ];
}

function pointInPolygonLonLat(point, polygon) {
  const rings = polygon?.rings;
  if (!Array.isArray(rings) || !rings[0]) return false;
  if (!pointInRingLonLat(point, rings[0])) return false;
  for (let i = 1; i < rings.length; i++) {
    if (pointInRingLonLat(point, rings[i])) return false;
  }
  return true;
}

function pointInRingLonLat(point, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = Number(ring[i][0]);
    const yi = Number(ring[i][1]);
    const xj = Number(ring[j][0]);
    const yj = Number(ring[j][1]);
    const crosses = ((yi > point[1]) !== (yj > point[1]))
      && point[0] < ((xj - xi) * (point[1] - yi)) / ((yj - yi) || Number.EPSILON) + xi;
    if (crosses) inside = !inside;
  }
  return inside;
}

function edgeDistanceLonLat(point, polygon) {
  let min = Infinity;
  for (const ring of polygon?.rings || []) {
    for (let i = 0; i < ring.length; i++) {
      const a = ring[i];
      const b = ring[(i + 1) % ring.length];
      const dx = Number(b[0]) - Number(a[0]);
      const dy = Number(b[1]) - Number(a[1]);
      const length2 = dx * dx + dy * dy;
      let t = 0;
      if (length2 > 0) {
        t = ((point[0] - Number(a[0])) * dx + (point[1] - Number(a[1])) * dy) / length2;
        t = Math.max(0, Math.min(1, t));
      }
      const px = Number(a[0]) + t * dx;
      const py = Number(a[1]) + t * dy;
      const dist = Math.hypot(point[0] - px, point[1] - py);
      if (dist < min) min = dist;
    }
  }
  return min;
}

function featureBbox(feature) {
  if (Array.isArray(feature?.bbox) && feature.bbox.length === 4) {
    return feature.bbox.map(Number);
  }
  const polygons = civicFeaturePolygons(feature);
  let minLon = Infinity;
  let minLat = Infinity;
  let maxLon = -Infinity;
  let maxLat = -Infinity;
  for (const polygon of polygons) {
    for (const ring of polygon?.rings || []) {
      for (const point of ring) {
        const lon = Number(point[0]);
        const lat = Number(point[1]);
        if (!Number.isFinite(lon) || !Number.isFinite(lat)) continue;
        minLon = Math.min(minLon, lon);
        minLat = Math.min(minLat, lat);
        maxLon = Math.max(maxLon, lon);
        maxLat = Math.max(maxLat, lat);
      }
    }
  }
  if (!Number.isFinite(minLon)) return null;
  return [minLon, minLat, maxLon, maxLat];
}

function collectionBbox(collection) {
  let minLon = Infinity;
  let minLat = Infinity;
  let maxLon = -Infinity;
  let maxLat = -Infinity;
  for (const feature of collection?.features || []) {
    const box = featureBbox(feature);
    if (!box) continue;
    minLon = Math.min(minLon, box[0]);
    minLat = Math.min(minLat, box[1]);
    maxLon = Math.max(maxLon, box[2]);
    maxLat = Math.max(maxLat, box[3]);
  }
  if (!Number.isFinite(minLon)) {
    return [
      NYC_BOUNDS.minLon,
      NYC_BOUNDS.minLat,
      NYC_BOUNDS.maxLon,
      NYC_BOUNDS.maxLat,
    ];
  }
  return [minLon, minLat, maxLon, maxLat];
}

function ensureStyleLink(documentRef, href) {
  const existing = documentRef.head?.querySelector(`link[data-geography-map-css="${href}"]`);
  if (existing) return existing;
  const link = documentRef.createElement("link");
  link.rel = "stylesheet";
  link.href = href;
  link.dataset.geographyMapCss = href;
  documentRef.head.appendChild(link);
  return link;
}

function loadScript(documentRef, src) {
  return new Promise((resolve, reject) => {
    const existing = documentRef.querySelector(`script[data-geography-map-js="${src}"]`);
    if (existing && globalThis.maplibregl) {
      resolve(globalThis.maplibregl);
      return;
    }
    const script = documentRef.createElement("script");
    script.src = src;
    script.async = true;
    script.dataset.geographyMapJs = src;
    script.onload = () => {
      if (!globalThis.maplibregl) {
        reject(new Error(GEOGRAPHY_MAP_FALLBACK_REASONS.dynamic_import));
        return;
      }
      resolve(globalThis.maplibregl);
    };
    script.onerror = () => reject(new Error(GEOGRAPHY_MAP_FALLBACK_REASONS.dynamic_import));
    documentRef.head.appendChild(script);
  });
}

/** Default MapLibre loader: same-origin vendored UMD + CSS + CSP worker. */
export async function importPinnedMapLibre({
  documentRef = globalThis.document,
  jsUrl = vendorUrl(MAPLIBRE_PIN.js),
  cssUrl = vendorUrl(MAPLIBRE_PIN.css),
  workerUrl = vendorUrl(MAPLIBRE_PIN.worker),
} = {}) {
  if (!documentRef?.head) {
    throw new Error(GEOGRAPHY_MAP_FALLBACK_REASONS.dynamic_import);
  }
  if (globalThis.maplibregl) {
    if (workerUrl && globalThis.maplibregl.workerUrl !== workerUrl) {
      globalThis.maplibregl.workerUrl = workerUrl;
    }
    return globalThis.maplibregl;
  }
  ensureStyleLink(documentRef, cssUrl);
  const maplibregl = await loadScript(documentRef, jsUrl);
  if (workerUrl) maplibregl.workerUrl = workerUrl;
  return maplibregl;
}

function webglIsSupported(documentRef = globalThis.document) {
  try {
    const canvas = documentRef.createElement("canvas");
    return Boolean(
      canvas.getContext("webgl")
      || canvas.getContext("experimental-webgl")
      || canvas.getContext("webgl2"),
    );
  } catch {
    return false;
  }
}

function emptyGeoJson() {
  return {
    type: "FeatureCollection",
    features: [],
  };
}

function selectedSubset(collection, selectedKey) {
  if (!selectedKey) return emptyGeoJson();
  const features = (collection?.features || []).filter(
    (feature) => feature?.properties?.key === selectedKey || feature?.id === selectedKey,
  );
  return { type: "FeatureCollection", features };
}

function selectedLineWidthForMode(forcedColors = false) {
  return forcedColors
    ? GEOGRAPHY_MAP_STYLE.FORCED_COLORS_SELECTED_LINE_WIDTH
    : GEOGRAPHY_MAP_STYLE.SELECTED_LINE_WIDTH;
}

function buildBaseStyle({ forcedColors = false } = {}) {
  const selectedLineWidth = selectedLineWidthForMode(forcedColors);
  return {
    version: 8,
    // No remote glyph atlas: MapLibre falls back to localIdeographFontFamily for
    // Latin labels so the resident path does not depend on a third-party font CDN.
    sources: {
      [GEOGRAPHY_MAP_SOURCE_IDS.basemap]: {
        type: "raster",
        tiles: [...GEOGRAPHY_MAP_BASEMAP.tiles],
        tileSize: GEOGRAPHY_MAP_BASEMAP.tileSize,
        attribution: GEOGRAPHY_MAP_BASEMAP.attribution,
        maxzoom: GEOGRAPHY_MAP_BASEMAP.maxzoom,
      },
      [GEOGRAPHY_MAP_SOURCE_IDS.active]: {
        type: "geojson",
        data: emptyGeoJson(),
        promoteId: "key",
      },
      [GEOGRAPHY_MAP_SOURCE_IDS.comparison]: {
        type: "geojson",
        data: emptyGeoJson(),
        promoteId: "key",
      },
      [GEOGRAPHY_MAP_SOURCE_IDS.selected]: {
        type: "geojson",
        data: emptyGeoJson(),
        promoteId: "key",
      },
      [GEOGRAPHY_MAP_SOURCE_IDS.point]: {
        type: "geojson",
        data: emptyGeoJson(),
      },
    },
    layers: [
      {
        id: "geography-background",
        type: "background",
        paint: { "background-color": GEOGRAPHY_MAP_STYLE.BACKGROUND_COLOR },
      },
      {
        id: GEOGRAPHY_MAP_LAYER_IDS.basemap,
        type: "raster",
        source: GEOGRAPHY_MAP_SOURCE_IDS.basemap,
        paint: { "raster-opacity": 1 },
      },
      {
        id: GEOGRAPHY_MAP_LAYER_IDS.activeFill,
        type: "fill",
        source: GEOGRAPHY_MAP_SOURCE_IDS.active,
        paint: {
          "fill-color": GEOGRAPHY_MAP_STYLE.ACTIVE_FILL_COLOR,
          "fill-opacity": GEOGRAPHY_MAP_STYLE.ACTIVE_FILL_OPACITY,
        },
      },
      {
        id: GEOGRAPHY_MAP_LAYER_IDS.activeLine,
        type: "line",
        source: GEOGRAPHY_MAP_SOURCE_IDS.active,
        paint: {
          "line-color": GEOGRAPHY_MAP_STYLE.ACTIVE_LINE_COLOR,
          "line-width": GEOGRAPHY_MAP_STYLE.ACTIVE_LINE_WIDTH,
        },
      },
      {
        id: GEOGRAPHY_MAP_LAYER_IDS.comparisonFill,
        type: "fill",
        source: GEOGRAPHY_MAP_SOURCE_IDS.comparison,
        paint: {
          "fill-color": GEOGRAPHY_MAP_STYLE.COMPARISON_FILL_COLOR,
          "fill-opacity": GEOGRAPHY_MAP_STYLE.COMPARISON_FILL_OPACITY,
        },
      },
      {
        id: GEOGRAPHY_MAP_LAYER_IDS.comparisonLine,
        type: "line",
        source: GEOGRAPHY_MAP_SOURCE_IDS.comparison,
        paint: {
          "line-color": GEOGRAPHY_MAP_STYLE.COMPARISON_LINE_COLOR,
          "line-width": GEOGRAPHY_MAP_STYLE.COMPARISON_LINE_WIDTH,
          "line-dasharray": [...GEOGRAPHY_MAP_STYLE.COMPARISON_LINE_DASHARRAY],
        },
      },
      {
        id: GEOGRAPHY_MAP_LAYER_IDS.hoverFill,
        type: "fill",
        source: GEOGRAPHY_MAP_SOURCE_IDS.active,
        filter: [
          "any",
          ["boolean", ["feature-state", FEATURE_STATE_HOVER], false],
          ["boolean", ["feature-state", FEATURE_STATE_FOCUS], false],
        ],
        paint: {
          "fill-color": GEOGRAPHY_MAP_STYLE.HOVER_FILL_COLOR,
          "fill-opacity": GEOGRAPHY_MAP_STYLE.HOVER_FILL_OPACITY,
        },
      },
      {
        id: GEOGRAPHY_MAP_LAYER_IDS.hoverLine,
        type: "line",
        source: GEOGRAPHY_MAP_SOURCE_IDS.active,
        filter: [
          "any",
          ["boolean", ["feature-state", FEATURE_STATE_HOVER], false],
          ["boolean", ["feature-state", FEATURE_STATE_FOCUS], false],
        ],
        paint: {
          "line-color": GEOGRAPHY_MAP_STYLE.HOVER_LINE_COLOR,
          "line-width": GEOGRAPHY_MAP_STYLE.HOVER_LINE_WIDTH,
        },
      },
      {
        id: GEOGRAPHY_MAP_LAYER_IDS.selectedFill,
        type: "fill",
        source: GEOGRAPHY_MAP_SOURCE_IDS.selected,
        paint: {
          "fill-color": GEOGRAPHY_MAP_STYLE.SELECTED_FILL_COLOR,
          "fill-opacity": GEOGRAPHY_MAP_STYLE.SELECTED_FILL_OPACITY,
        },
      },
      {
        id: GEOGRAPHY_MAP_LAYER_IDS.selectedLine,
        type: "line",
        source: GEOGRAPHY_MAP_SOURCE_IDS.selected,
        paint: {
          "line-color": GEOGRAPHY_MAP_STYLE.SELECTED_LINE_COLOR,
          "line-width": selectedLineWidth,
          "line-dasharray": [...GEOGRAPHY_MAP_STYLE.SELECTED_LINE_DASHARRAY],
        },
      },
      {
        id: GEOGRAPHY_MAP_LAYER_IDS.labels,
        type: "symbol",
        source: GEOGRAPHY_MAP_SOURCE_IDS.active,
        layout: {
          "text-field": ["get", "label"],
          "text-size": GEOGRAPHY_MAP_STYLE.LABEL_SIZE,
          "text-font": ["Open Sans Regular", "Arial Unicode MS Regular"],
          "text-max-width": 10,
          "text-allow-overlap": false,
          "text-ignore-placement": false,
          "symbol-sort-key": ["case", ["get", "is_special_use"], 2, 1],
          "text-optional": true,
        },
        paint: {
          "text-color": GEOGRAPHY_MAP_STYLE.LABEL_TEXT_COLOR,
          "text-halo-color": GEOGRAPHY_MAP_STYLE.LABEL_HALO_COLOR,
          "text-halo-width": GEOGRAPHY_MAP_STYLE.LABEL_HALO_WIDTH,
        },
        filter: [
          "all",
          ["has", "label"],
          [
            "any",
            ["!", ["get", "is_special_use"]],
            [">=", ["zoom"], GEOGRAPHY_MAP_STYLE.SPECIAL_USE_MIN_ZOOM],
            ["==", ["get", "key"], ""],
          ],
        ],
      },
      {
        id: GEOGRAPHY_MAP_LAYER_IDS.selectedLabel,
        type: "symbol",
        source: GEOGRAPHY_MAP_SOURCE_IDS.selected,
        layout: {
          "text-field": ["get", "label"],
          "text-size": GEOGRAPHY_MAP_STYLE.SELECTED_LABEL_SIZE,
          "text-font": ["Open Sans Bold", "Arial Unicode MS Bold"],
          "text-max-width": 12,
          "text-allow-overlap": true,
          "text-ignore-placement": true,
          "text-optional": false,
        },
        paint: {
          "text-color": GEOGRAPHY_MAP_STYLE.LABEL_TEXT_COLOR,
          "text-halo-color": GEOGRAPHY_MAP_STYLE.LABEL_HALO_COLOR,
          "text-halo-width": 2,
        },
      },
      {
        id: GEOGRAPHY_MAP_LAYER_IDS.point,
        type: "circle",
        source: GEOGRAPHY_MAP_SOURCE_IDS.point,
        paint: {
          "circle-radius": GEOGRAPHY_MAP_STYLE.POINT_MARKER_RADIUS,
          "circle-color": GEOGRAPHY_MAP_STYLE.POINT_MARKER_COLOR,
          "circle-stroke-width": 2,
          "circle-stroke-color": "#ffffff",
        },
      },
    ],
  };
}

/**
 * Hide the server SVG map while keeping the area list; clear focusable SVG
 * controls so enhancement does not duplicate tab stops.
 */
export function hideServerMapFallback(root, { enhancedHost } = {}) {
  if (!root) return;
  const svg = root.querySelector("#nearMapSvg");
  const wrap = root.querySelector(".near-map-wrap");
  if (svg) {
    svg.hidden = true;
    svg.setAttribute("aria-hidden", "true");
    svg.querySelectorAll("[tabindex]").forEach((node) => {
      node.dataset.geographyMapPrevTabindex = node.getAttribute("tabindex") ?? "";
      node.setAttribute("tabindex", "-1");
    });
  }
  root.querySelectorAll(".map-controls [data-map-zoom], .map-controls [data-map-pan]").forEach((button) => {
    button.dataset.geographyMapPrevHidden = button.hidden ? "1" : "0";
    button.hidden = true;
    button.setAttribute("aria-hidden", "true");
  });
  if (enhancedHost) {
    enhancedHost.hidden = false;
    enhancedHost.removeAttribute("aria-hidden");
  }
  if (wrap) wrap.dataset.geographyMapMode = "enhanced";
  root.dataset.nearMapRuntime = "maplibre";
}

/** Restore the server SVG/list after enhancement failure or destroy. */
export function restoreServerMapFallback(root, { enhancedHost, reason = null } = {}) {
  if (!root) return;
  const svg = root.querySelector("#nearMapSvg");
  const wrap = root.querySelector(".near-map-wrap");
  if (svg) {
    svg.hidden = false;
    svg.removeAttribute("aria-hidden");
    svg.querySelectorAll("[data-geography-map-prev-tabindex]").forEach((node) => {
      const previous = node.dataset.geographyMapPrevTabindex;
      if (previous === "") node.removeAttribute("tabindex");
      else node.setAttribute("tabindex", previous);
      delete node.dataset.geographyMapPrevTabindex;
    });
  }
  root.querySelectorAll(".map-controls [data-map-zoom], .map-controls [data-map-pan]").forEach((button) => {
    const wasHidden = button.dataset.geographyMapPrevHidden === "1";
    button.hidden = wasHidden;
    if (!wasHidden) button.removeAttribute("aria-hidden");
    delete button.dataset.geographyMapPrevHidden;
  });
  if (enhancedHost) {
    enhancedHost.hidden = true;
    enhancedHost.setAttribute("aria-hidden", "true");
    enhancedHost.replaceChildren();
  }
  if (wrap) wrap.dataset.geographyMapMode = "svg";
  root.dataset.nearMapRuntime = reason ? "failed" : "svg";
  if (reason) root.dataset.nearMapRuntimeReason = String(reason);
  else delete root.dataset.nearMapRuntimeReason;
}

function assertNavigationLayerType(type) {
  const value = String(type || "");
  if (!GEOGRAPHY_NAVIGATION_LAYER_TYPES.includes(value)) {
    throw new Error(`unsupported_navigation_layer:${value || "missing"}`);
  }
  return value;
}

/**
 * Create the progressive Near You map controller.
 *
 * @param {object} options
 * @param {HTMLElement} options.container enhanced host element
 * @param {ParentNode} [options.root] Near You root for SVG fallback
 * @param {(opts?: object) => Promise<object>} [options.importMapLibre]
 * @param {(maplibregl: object, opts: object) => object} [options.createMap]
 *   Renderer seam for tests — receives MapLibre namespace and map options.
 * @param {(event: object) => void} [options.onSelect]
 * @param {(event: object) => void} [options.onHover]
 * @param {(reason: string, error?: Error) => void} [options.onFallback]
 * @param {(reason: string) => void} [options.onTileFailure]
 * @param {boolean} [options.reducedMotion]
 * @param {boolean} [options.forcedColors] when true, selection outline uses the
 *   forced-colors line width so selection stays identifiable without color.
 */
export async function createGeographyNavigationMap(options = {}) {
  const {
    container,
    root = container?.closest?.("[data-near-you-root]") || null,
    importMapLibre = importPinnedMapLibre,
    createMap = null,
    onSelect = null,
    onHover = null,
    onFallback = null,
    onTileFailure = null,
    reducedMotion = prefersReducedMotion(),
    forcedColors = prefersForcedColors(),
    documentRef = globalThis.document,
    // Renderer-seam tests inject createMap and may omit a real WebGL canvas.
    webglSupported = createMap ? true : null,
  } = options;

  if (!container) {
    throw new Error("geography_map_container_required");
  }

  let map = null;
  let maplibregl = null;
  let destroyed = false;
  let activeType = null;
  let activeCollection = emptyGeoJson();
  let comparisonType = null;
  let comparisonCollection = emptyGeoJson();
  let selectedKey = null;
  let hoveredKey = null;
  let focusedKey = null;
  let pointMarker = null;
  const listeners = [];

  const fail = (reason, error) => {
    if (destroyed) return;
    restoreServerMapFallback(root, { enhancedHost: container, reason });
    onFallback?.(reason, error);
  };

  try {
    const hasWebGl = webglSupported == null
      ? webglIsSupported(documentRef)
      : Boolean(webglSupported);
    if (!hasWebGl) {
      const error = new Error(GEOGRAPHY_MAP_FALLBACK_REASONS.webgl_unsupported);
      fail(GEOGRAPHY_MAP_FALLBACK_REASONS.webgl_unsupported, error);
      throw error;
    }
    maplibregl = await importMapLibre({ documentRef });
    if (!maplibregl?.Map) {
      const error = new Error(GEOGRAPHY_MAP_FALLBACK_REASONS.dynamic_import);
      fail(GEOGRAPHY_MAP_FALLBACK_REASONS.dynamic_import, error);
      throw error;
    }

    // Reveal the enhanced host before constructing the map. MapLibre measures the
    // container during construction; a hidden host yields a zero-size canvas and
    // a style failure that would otherwise look like a permanent enhancement miss.
    hideServerMapFallback(root, { enhancedHost: container });

    const mapOptions = {
      container,
      style: buildBaseStyle({ forcedColors }),
      bounds: [
        [NYC_BOUNDS.minLon, NYC_BOUNDS.minLat],
        [NYC_BOUNDS.maxLon, NYC_BOUNDS.maxLat],
      ],
      fitBoundsOptions: { padding: 24 },
      attributionControl: true,
      cooperativeGestures: false,
      fadeDuration: reducedMotion ? 0 : 300,
      // Basemap glyphs are optional; labels can still render with local fallbacks.
      localIdeographFontFamily: "system-ui, sans-serif",
    };

    map = typeof createMap === "function"
      ? createMap(maplibregl, mapOptions)
      : new maplibregl.Map(mapOptions);

    if (!map) {
      const error = new Error(GEOGRAPHY_MAP_FALLBACK_REASONS.style_failure);
      fail(GEOGRAPHY_MAP_FALLBACK_REASONS.style_failure, error);
      throw error;
    }

    const on = (target, type, handler) => {
      target.on?.(type, handler);
      listeners.push(() => target.off?.(type, handler));
    };

    on(map, "error", (event) => {
      const message = String(event?.error?.message || event?.error || "");
      const sourceId = String(event?.sourceId || event?.error?.sourceId || "");
      // Basemap tiles are decorative. Network/CDN failures must not revert the map.
      if (
        sourceId === GEOGRAPHY_MAP_SOURCE_IDS.basemap
        || /tile|raster|basemap|cartocdn|ajaxerror|failed to load/i.test(message)
      ) {
        onTileFailure?.(GEOGRAPHY_MAP_FALLBACK_REASONS.tile_failure);
        return;
      }
      if (/style/i.test(message)) {
        fail(GEOGRAPHY_MAP_FALLBACK_REASONS.style_failure, event?.error);
      }
    });

    on(map, "webglcontextlost", () => {
      fail(GEOGRAPHY_MAP_FALLBACK_REASONS.context_lost, new Error("webglcontextlost"));
    });

    const interactiveLayers = [
      GEOGRAPHY_MAP_LAYER_IDS.activeFill,
      GEOGRAPHY_MAP_LAYER_IDS.hoverFill,
      GEOGRAPHY_MAP_LAYER_IDS.selectedFill,
    ];

    on(map, "mousemove", (event) => {
      const feature = map.queryRenderedFeatures?.(event.point, { layers: interactiveLayers })?.[0];
      const key = feature?.properties?.key || null;
      setHoveredKey(key);
      onHover?.({ key, feature, originalEvent: event });
    });

    on(map, "mouseleave", () => {
      setHoveredKey(null);
      onHover?.({ key: null, feature: null });
    });

    on(map, "click", (event) => {
      const feature = map.queryRenderedFeatures?.(event.point, { layers: interactiveLayers })?.[0];
      const key = feature?.properties?.key || null;
      if (!key) return;
      setSelectedKey(key);
      onSelect?.({ key, feature, originalEvent: event, method: "click" });
    });

    // Keyboard parity: Enter on a focused feature selects; hover is never required.
    if (container && !container.hasAttribute("tabindex")) {
      container.tabIndex = 0;
    }
    const keydown = (event) => {
      if (event.key === "Escape") {
        setHoveredKey(null);
        setFocusedKey(null);
        return;
      }
      if (event.key !== "Enter" && event.key !== " ") return;
      if (!focusedKey && !hoveredKey && !selectedKey) return;
      const key = focusedKey || hoveredKey || selectedKey;
      event.preventDefault();
      setSelectedKey(key);
      onSelect?.({ key, feature: null, originalEvent: event, method: "keyboard" });
    };
    container.addEventListener("keydown", keydown);
    listeners.push(() => container.removeEventListener("keydown", keydown));
  } catch (error) {
    if (!root?.dataset?.nearMapRuntime || root.dataset.nearMapRuntime === "maplibre") {
      fail(error?.message || GEOGRAPHY_MAP_FALLBACK_REASONS.dynamic_import, error);
    }
    throw error;
  }

  function setSourceData(sourceId, data) {
    const source = map?.getSource?.(sourceId);
    if (source?.setData) source.setData(data);
  }

  function clearFeatureState(sourceId, key, stateKey) {
    if (!map || !key) return;
    try {
      map.setFeatureState?.({ source: sourceId, id: key }, { [stateKey]: false });
    } catch {
      // Source may not be ready yet.
    }
  }

  function applyFeatureState(sourceId, key, stateKey, value) {
    if (!map || !key) return;
    try {
      map.setFeatureState?.({ source: sourceId, id: key }, { [stateKey]: value });
    } catch {
      // Source may not be ready yet.
    }
  }

  function refreshSelectedSource() {
    setSourceData(
      GEOGRAPHY_MAP_SOURCE_IDS.selected,
      selectedSubset(activeCollection, selectedKey),
    );
  }

  function setActiveLayer(type, layerDoc) {
    if (destroyed) return;
    activeType = assertNavigationLayerType(type);
    try {
      activeCollection = projectLayerCollectionForMap(layerDoc, { layerType: activeType });
      if (activeCollection.geometry_fidelity && activeCollection.geometry_fidelity !== "simplified") {
        throw new Error(GEOGRAPHY_MAP_FALLBACK_REASONS.layer_load);
      }
      setSourceData(GEOGRAPHY_MAP_SOURCE_IDS.active, activeCollection);
      refreshSelectedSource();
      refreshLabelFilter();
    } catch (error) {
      fail(GEOGRAPHY_MAP_FALLBACK_REASONS.layer_load, error);
      throw error;
    }
  }

  function setComparisonLayer(type, layerDoc) {
    if (destroyed) return;
    if (type == null || type === "") {
      comparisonType = null;
      comparisonCollection = emptyGeoJson();
      setSourceData(GEOGRAPHY_MAP_SOURCE_IDS.comparison, comparisonCollection);
      // Selected outline stays mounted.
      refreshSelectedSource();
      return;
    }
    comparisonType = assertNavigationLayerType(type);
    comparisonCollection = projectLayerCollectionForMap(layerDoc, { layerType: comparisonType });
    setSourceData(GEOGRAPHY_MAP_SOURCE_IDS.comparison, comparisonCollection);
    refreshSelectedSource();
  }

  function refreshLabelFilter() {
    if (!map?.setFilter) return;
    map.setFilter(GEOGRAPHY_MAP_LAYER_IDS.labels, [
      "all",
      ["has", "label"],
      [
        "any",
        ["!", ["get", "is_special_use"]],
        [">=", ["zoom"], GEOGRAPHY_MAP_STYLE.SPECIAL_USE_MIN_ZOOM],
        selectedKey ? ["==", ["get", "key"], selectedKey] : false,
      ],
    ]);
  }

  function setSelectedKey(key) {
    if (destroyed) return;
    if (selectedKey && selectedKey !== key) {
      clearFeatureState(GEOGRAPHY_MAP_SOURCE_IDS.active, selectedKey, FEATURE_STATE_SELECTED);
    }
    selectedKey = key ? String(key) : null;
    if (selectedKey) {
      applyFeatureState(GEOGRAPHY_MAP_SOURCE_IDS.active, selectedKey, FEATURE_STATE_SELECTED, true);
    }
    refreshSelectedSource();
    refreshLabelFilter();
  }

  function setHoveredKey(key) {
    if (destroyed) return;
    if (hoveredKey && hoveredKey !== key) {
      clearFeatureState(GEOGRAPHY_MAP_SOURCE_IDS.active, hoveredKey, FEATURE_STATE_HOVER);
    }
    hoveredKey = key ? String(key) : null;
    if (hoveredKey) {
      applyFeatureState(GEOGRAPHY_MAP_SOURCE_IDS.active, hoveredKey, FEATURE_STATE_HOVER, true);
    }
  }

  function setFocusedKey(key) {
    if (destroyed) return;
    if (focusedKey && focusedKey !== key) {
      clearFeatureState(GEOGRAPHY_MAP_SOURCE_IDS.active, focusedKey, FEATURE_STATE_FOCUS);
    }
    focusedKey = key ? String(key) : null;
    if (focusedKey) {
      applyFeatureState(GEOGRAPHY_MAP_SOURCE_IDS.active, focusedKey, FEATURE_STATE_FOCUS, true);
      // Focus path must work without hover.
      setHoveredKey(null);
    }
  }

  function setPointMarker(lonLat) {
    if (destroyed) return;
    if (!Array.isArray(lonLat) || lonLat.length < 2) {
      pointMarker = null;
      setSourceData(GEOGRAPHY_MAP_SOURCE_IDS.point, emptyGeoJson());
      return;
    }
    const lon = asFiniteNumber(lonLat[0]);
    const lat = asFiniteNumber(lonLat[1]);
    if (lon == null || lat == null) {
      pointMarker = null;
      setSourceData(GEOGRAPHY_MAP_SOURCE_IDS.point, emptyGeoJson());
      return;
    }
    pointMarker = [lon, lat];
    setSourceData(GEOGRAPHY_MAP_SOURCE_IDS.point, {
      type: "FeatureCollection",
      features: [{
        type: "Feature",
        geometry: { type: "Point", coordinates: pointMarker },
        properties: { role: "locate_marker" },
      }],
    });
  }

  function fitSelection({ padding = 40, maxZoom = 14 } = {}) {
    if (destroyed || !map) return;
    const target = selectedKey
      ? selectedSubset(activeCollection, selectedKey)
      : activeCollection;
    const bbox = collectionBbox(target);
    const camera = {
      padding,
      maxZoom,
      animate: !reducedMotion,
      duration: reducedMotion ? 0 : 600,
    };
    if (typeof map.fitBounds === "function") {
      map.fitBounds(
        [[bbox[0], bbox[1]], [bbox[2], bbox[3]]],
        camera,
      );
      return;
    }
    if (!reducedMotion && typeof map.flyTo === "function") {
      map.flyTo({
        center: [(bbox[0] + bbox[2]) / 2, (bbox[1] + bbox[3]) / 2],
        zoom: Math.min(maxZoom, 12),
        duration: camera.duration,
      });
      return;
    }
    map.jumpTo?.({
      center: [(bbox[0] + bbox[2]) / 2, (bbox[1] + bbox[3]) / 2],
      zoom: Math.min(maxZoom, 12),
    });
  }

  function zoomBy(delta) {
    if (!map) return;
    const zoom = typeof map.getZoom === "function" ? map.getZoom() : 10;
    const next = zoom + delta;
    if (reducedMotion) map.jumpTo?.({ zoom: next });
    else map.easeTo?.({ zoom: next, duration: 200 }) || map.jumpTo?.({ zoom: next });
  }

  function panBy(offset) {
    if (!map) return;
    if (typeof map.panBy === "function") {
      map.panBy(offset, { animate: !reducedMotion });
      return;
    }
    const center = map.getCenter?.();
    if (!center) return;
    map.jumpTo?.({
      center: [
        center.lng - (offset[0] || 0) * 0.001,
        center.lat + (offset[1] || 0) * 0.001,
      ],
    });
  }

  function destroy() {
    if (destroyed) return;
    destroyed = true;
    for (const off of listeners.splice(0)) {
      try { off(); } catch { /* ignore */ }
    }
    try { map?.remove?.(); } catch { /* ignore */ }
    map = null;
    restoreServerMapFallback(root, {
      enhancedHost: container,
      reason: GEOGRAPHY_MAP_FALLBACK_REASONS.destroy,
    });
    root && (root.dataset.nearMapRuntime = "svg");
    delete root?.dataset?.nearMapRuntimeReason;
  }

  return {
    schema: RESIDENT_GEOGRAPHY_MAP_SCHEMA,
    map,
    maplibregl,
    reducedMotion,
    forcedColors,
    getState() {
      return {
        activeType,
        comparisonType,
        selectedKey,
        hoveredKey,
        focusedKey,
        pointMarker,
        forcedColors,
        activeFeatureCount: activeCollection.features?.length || 0,
        comparisonFeatureCount: comparisonCollection.features?.length || 0,
        style: GEOGRAPHY_MAP_STYLE,
        basemap: GEOGRAPHY_MAP_BASEMAP,
      };
    },
    setActiveLayer,
    setComparisonLayer,
    setSelectedKey,
    setHoveredKey,
    setFocusedKey,
    setPointMarker,
    fitSelection,
    zoomBy,
    panBy,
    destroy,
  };
}

/**
 * Fetch a simplified layer artifact. Hard-fails on publisher GIS URLs.
 * Injectable `fetchImpl` keeps tests hermetic.
 */
export async function loadSimplifiedNavigationLayer(type, {
  registry,
  fetchImpl = globalThis.fetch,
  siteRoot = "/",
} = {}) {
  const layerType = assertNavigationLayerType(type);
  const url = simplifiedLayerSiteUrl(layerType, registry, { siteRoot });
  if (!url) throw new Error(GEOGRAPHY_MAP_FALLBACK_REASONS.layer_load);
  if (isPublisherGisUrl(url)) {
    throw new Error("publisher_gis_url_forbidden");
  }
  const response = await fetchImpl(url, { headers: { Accept: "application/json" } });
  if (!response?.ok) throw new Error(GEOGRAPHY_MAP_FALLBACK_REASONS.layer_load);
  const doc = await response.json();
  if (doc?.geometry_fidelity && doc.geometry_fidelity !== "simplified") {
    throw new Error(GEOGRAPHY_MAP_FALLBACK_REASONS.layer_load);
  }
  return projectLayerCollectionForMap(doc, { layerType });
}

export const __test__ = Object.freeze({
  buildBaseStyle,
  selectedSubset,
  emptyGeoJson,
  prefersReducedMotion,
  prefersForcedColors,
  selectedLineWidthForMode,
  EMPTY_FEATURE_COLLECTION,
  FEATURE_STATE_HOVER,
  FEATURE_STATE_FOCUS,
  FEATURE_STATE_SELECTED,
});
