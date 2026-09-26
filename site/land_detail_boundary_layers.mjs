/**
 * Optional NTA and community-district outlines on the Land detail Leaflet map.
 *
 * Outlines are presentation context only. Membership IDs come from the shared
 * project-lot index; simplified rendered shapes never invent membership.
 * Boundary assets load only after a resident enables a layer. A failed layer
 * disables that control alone and leaves the base map, lot marks, and detail
 * links usable.
 */

import { landDetailPlaceMembershipForProject } from "./land_detail_place_links.mjs";
import {
  LAND_BOUNDARIES_PARAM,
  LAND_BOUNDARY_LAYER_CD,
  LAND_BOUNDARY_LAYER_NTA,
  LAND_BOUNDARY_LAYERS,
  landDetailBoundariesFromRouteHash,
  routeHashWithLandDetailBoundaries,
} from "./land_view_state.mjs";

export const LAND_DETAIL_BOUNDARY_LAYERS_SCHEMA = "cityscroll.land_detail_boundary_layers.v1";

export const LAND_DETAIL_BOUNDARY_NTA_LABEL = "Neighborhood boundaries";
export const LAND_DETAIL_BOUNDARY_CD_LABEL = "Community district boundaries";
export const LAND_DETAIL_BOUNDARY_CONTROLS_ARIA = "Optional map boundary outlines";
export const LAND_DETAIL_BOUNDARY_LEGEND_HEADING = "Boundary context";
export const LAND_DETAIL_BOUNDARY_CONTEXT_NOTE =
  "Outlines show place context around this project. They do not change which projects appear in results.";
export const LAND_DETAIL_BOUNDARY_RETRY_LABEL = "Try again";
export const LAND_DETAIL_BOUNDARY_FAILURE_COPY =
  "Could not load this boundary layer. The project map is unchanged.";

/** Stable token → civic layer type used by committed geography artifacts. */
export const LAND_DETAIL_BOUNDARY_LAYER_TYPES = Object.freeze({
  [LAND_BOUNDARY_LAYER_NTA]: "nta2020",
  [LAND_BOUNDARY_LAYER_CD]: "community_district",
});

export const LAND_DETAIL_BOUNDARY_CONTROL_LABELS = Object.freeze({
  [LAND_BOUNDARY_LAYER_NTA]: LAND_DETAIL_BOUNDARY_NTA_LABEL,
  [LAND_BOUNDARY_LAYER_CD]: LAND_DETAIL_BOUNDARY_CD_LABEL,
});

/** Same-origin simplified artifacts shared with Near You / browse Map. */
export const LAND_DETAIL_BOUNDARY_ARTIFACTS = Object.freeze({
  [LAND_BOUNDARY_LAYER_NTA]: Object.freeze({
    token: LAND_BOUNDARY_LAYER_NTA,
    layer_type: "nta2020",
    artifact_url: "data/geography/layers/nta2020/26B.json",
    label: LAND_DETAIL_BOUNDARY_NTA_LABEL,
  }),
  [LAND_BOUNDARY_LAYER_CD]: Object.freeze({
    token: LAND_BOUNDARY_LAYER_CD,
    layer_type: "community_district",
    artifact_url: "data/geography/layers/community_district/2026-05-26.json",
    label: LAND_DETAIL_BOUNDARY_CD_LABEL,
  }),
});

const MEMBERSHIP_URL = "data/land_place_membership.json";

const OUTLINE_STYLE = Object.freeze({
  [LAND_BOUNDARY_LAYER_NTA]: Object.freeze({
    color: "#0f4f54",
    weight: 1.5,
    opacity: 0.9,
    fillColor: "#166b70",
    fillOpacity: 0.05,
    interactive: false,
  }),
  [LAND_BOUNDARY_LAYER_CD]: Object.freeze({
    color: "#5a3d16",
    weight: 1.5,
    opacity: 0.9,
    fillColor: "#7a4e16",
    fillOpacity: 0.04,
    interactive: false,
    dashArray: "4 3",
  }),
});

const clean = (value, max = 240) => String(value ?? "")
  .replace(/[\u0000-\u001f\u007f]/g, " ")
  .replace(/\s+/g, " ")
  .trim()
  .slice(0, max);

const escapeHtml = (value) => clean(value)
  .replaceAll("&", "&amp;")
  .replaceAll("<", "&lt;")
  .replaceAll(">", "&gt;")
  .replaceAll('"', "&quot;")
  .replaceAll("'", "&#39;");

function freezeDeep(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  if (Array.isArray(value)) {
    for (const entry of value) freezeDeep(entry);
    return Object.freeze(value);
  }
  for (const child of Object.values(value)) freezeDeep(child);
  return Object.freeze(value);
}

function featureGeometry(feature) {
  const geometry = feature?.geometry;
  if (!geometry || !["Polygon", "MultiPolygon"].includes(geometry.type)) return null;
  if (!Array.isArray(geometry.coordinates) || geometry.coordinates.length === 0) return null;
  return geometry;
}

/**
 * Membership place IDs for one outline token. Never reads rendered geometry.
 */
export function landDetailBoundaryPlaceIds(membership, token) {
  const layerType = LAND_DETAIL_BOUNDARY_LAYER_TYPES[token];
  if (!layerType || !membership || typeof membership !== "object") return Object.freeze([]);
  const places = membership.layers?.[layerType]?.places;
  if (!Array.isArray(places)) return Object.freeze([]);
  const out = [];
  const seen = new Set();
  for (const value of places) {
    const id = clean(value, 16).toUpperCase();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return Object.freeze(out);
}

/**
 * Build the outline model for one project from compact membership + optional
 * already-loaded layer documents. Missing docs leave that layer unloaded.
 */
export function buildLandDetailBoundaryLayersView({
  projectId = null,
  membership = null,
  enabled = null,
  layerDocs = null,
} = {}) {
  const id = clean(projectId, 32);
  if (!id) return null;
  const enabledTokens = normalizeEnabledTokens(enabled);
  const layers = LAND_BOUNDARY_LAYERS.map((token) => {
    const artifact = LAND_DETAIL_BOUNDARY_ARTIFACTS[token];
    const placeIds = landDetailBoundaryPlaceIds(membership, token);
    const doc = layerDocs?.[token] || null;
    const features = doc ? selectBoundaryFeatures(doc, placeIds, artifact.layer_type) : Object.freeze([]);
    return Object.freeze({
      token,
      layer_type: artifact.layer_type,
      label: artifact.label,
      artifact_url: artifact.artifact_url,
      enabled: enabledTokens.includes(token),
      place_ids: placeIds,
      available: placeIds.length > 0,
      features,
      vintage: doc?.vintage?.id ? clean(doc.vintage.id, 40) : null,
      source: doc?.source
        ? Object.freeze({
          contract_id: clean(doc.source.contract_id, 80),
          publisher: clean(doc.source.publisher, 120),
          dataset_id: clean(doc.source.dataset_id, 80),
          url: clean(doc.source.url, 240),
        })
        : null,
      geometry_fidelity: doc?.geometry_fidelity ? clean(doc.geometry_fidelity, 40) : null,
    });
  });
  return freezeDeep({
    schema: LAND_DETAIL_BOUNDARY_LAYERS_SCHEMA,
    project_id: id,
    enabled: enabledTokens,
    layers,
  });
}

function normalizeEnabledTokens(value) {
  if (Array.isArray(value)) {
    return LAND_BOUNDARY_LAYERS.filter((token) => value.includes(token));
  }
  if (value && typeof value === "object") {
    return LAND_BOUNDARY_LAYERS.filter((token) => value[token] === true);
  }
  return landDetailBoundariesFromRouteHash(`#land?${LAND_BOUNDARIES_PARAM}=${String(value ?? "")}`);
}

/**
 * Keep only requested place IDs from a committed layer document.
 */
export function selectBoundaryFeatures(layerDoc, placeIds, expectedType = null) {
  if (!layerDoc || typeof layerDoc !== "object") return Object.freeze([]);
  if (layerDoc.schema && layerDoc.schema !== "cityscroll.geography_layer.v1") {
    return Object.freeze([]);
  }
  if (expectedType && layerDoc.type && layerDoc.type !== expectedType) {
    return Object.freeze([]);
  }
  if (layerDoc.geometry_fidelity && layerDoc.geometry_fidelity !== "simplified") {
    return Object.freeze([]);
  }
  const wanted = new Set((placeIds || []).map((id) => clean(id, 16).toUpperCase()).filter(Boolean));
  if (!wanted.size) return Object.freeze([]);
  const out = [];
  for (const feature of Array.isArray(layerDoc.features) ? layerDoc.features : []) {
    const id = clean(feature?.id, 16).toUpperCase();
    if (!wanted.has(id)) continue;
    const geometry = featureGeometry(feature);
    const label = clean(feature?.label, 120);
    if (!geometry || !label) continue;
    out.push(Object.freeze({
      type: "Feature",
      id,
      properties: Object.freeze({
        id,
        label,
        type: clean(feature?.type || layerDoc.type, 40),
        subtype: feature?.subtype == null ? null : clean(feature.subtype, 40),
      }),
      geometry,
    }));
  }
  out.sort((left, right) => String(left.id).localeCompare(String(right.id), "en"));
  return Object.freeze(out);
}

export function landDetailBoundaryFeatureCollection(features) {
  return Object.freeze({
    type: "FeatureCollection",
    features: Object.freeze([...(features || [])]),
  });
}

/** Controls + legend markup. Pure; no network. */
export function renderLandDetailBoundaryControlsHTML(view, {
  escape = escapeHtml,
  failureTokens = null,
  loadingTokens = null,
} = {}) {
  if (!view || view.schema !== LAND_DETAIL_BOUNDARY_LAYERS_SCHEMA) return "";
  const failed = new Set(failureTokens || []);
  const loading = new Set(loadingTokens || []);
  const buttons = view.layers.map((layer) => {
    if (!layer.available && !layer.enabled) {
      return "";
    }
    const pressed = layer.enabled && !failed.has(layer.token);
    const disabled = failed.has(layer.token);
    const busy = loading.has(layer.token);
    return `<button type="button" class="land-detail-boundary-toggle"`
      + ` data-land-boundary-layer="${escape(layer.token)}"`
      + ` data-land-boundary-layer-type="${escape(layer.layer_type)}"`
      + ` aria-pressed="${pressed ? "true" : "false"}"`
      + (disabled ? " disabled" : "")
      + (busy ? ' aria-busy="true"' : "")
      + `>${escape(layer.label)}</button>`;
  }).filter(Boolean).join("");
  if (!buttons) return "";

  const enabledLayers = view.layers.filter((layer) => layer.enabled && layer.features.length);
  const legendItems = enabledLayers.map((layer) => {
    const vintage = layer.vintage ? ` · vintage ${escape(layer.vintage)}` : "";
    const source = layer.source?.publisher ? ` · ${escape(layer.source.publisher)}` : "";
    return `<li class="land-detail-boundary-legend-item"`
      + ` data-land-boundary-legend="${escape(layer.token)}"`
      + ` data-land-boundary-vintage="${escape(layer.vintage || "")}">`
      + `<span class="land-detail-boundary-swatch" data-land-boundary-swatch="${escape(layer.token)}" aria-hidden="true"></span>`
      + `<span class="land-detail-boundary-legend-label">${escape(layer.label)}</span>`
      + `<span class="land-detail-boundary-legend-meta">${source}${vintage}</span>`
      + `</li>`;
  }).join("");

  const legend = legendItems
    ? `<div class="land-detail-boundary-legend" data-land-detail-boundary-legend="1">`
      + `<p class="land-detail-boundary-legend-heading">${escape(LAND_DETAIL_BOUNDARY_LEGEND_HEADING)}</p>`
      + `<p class="land-detail-boundary-note">${escape(LAND_DETAIL_BOUNDARY_CONTEXT_NOTE)}</p>`
      + `<ul class="land-detail-boundary-legend-list">${legendItems}</ul>`
      + `</div>`
    : "";

  const failures = view.layers.filter((layer) => failed.has(layer.token)).map((layer) => (
    `<div class="land-detail-boundary-failure" data-land-boundary-failure="${escape(layer.token)}" role="status">`
    + `<span>${escape(LAND_DETAIL_BOUNDARY_FAILURE_COPY)}</span>`
    + ` <button type="button" class="land-detail-boundary-retry" data-land-boundary-retry="${escape(layer.token)}">`
    + `${escape(LAND_DETAIL_BOUNDARY_RETRY_LABEL)}</button>`
    + `</div>`
  )).join("");

  return `<div class="land-detail-boundary-controls" id="land-detail-boundary-controls"`
    + ` data-land-detail-boundary-controls="1"`
    + ` data-project-id="${escape(view.project_id)}"`
    + ` role="group" aria-label="${escape(LAND_DETAIL_BOUNDARY_CONTROLS_ARIA)}">`
    + buttons
    + failures
    + legend
    + `</div>`;
}

/**
 * Relative luminance helpers for legend contrast checks in tests and capture.
 */
export function relativeLuminance(hex) {
  const raw = String(hex || "").replace("#", "").trim();
  if (!/^[0-9a-fA-F]{6}$/.test(raw)) return null;
  const channels = [0, 2, 4].map((offset) => {
    const value = Number.parseInt(raw.slice(offset, offset + 2), 16) / 255;
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
}

export function contrastRatio(foregroundHex, backgroundHex) {
  const left = relativeLuminance(foregroundHex);
  const right = relativeLuminance(backgroundHex);
  if (left == null || right == null) return null;
  const lighter = Math.max(left, right);
  const darker = Math.min(left, right);
  return (lighter + 0.05) / (darker + 0.05);
}

/** Documented legend ink/paper colors used by CSS. */
export const LAND_DETAIL_BOUNDARY_LEGEND_COLORS = Object.freeze({
  ink: "#202c32",
  paper: "#f7f4ed",
  meta: "#4a5560",
});

let membershipPromise = null;
const layerDocPromises = new Map();

async function fetchJson(url, fetchImpl) {
  if (typeof fetchImpl !== "function") return null;
  const response = await fetchImpl(url, {
    cache: "force-cache",
    credentials: "omit",
    headers: { Accept: "application/json" },
  });
  if (!response?.ok) {
    const error = new Error(`boundary_layer_fetch_failed:${url}`);
    error.status = response?.status ?? 0;
    throw error;
  }
  return response.json();
}

export function loadLandDetailBoundaryMembership(fetchImpl = globalThis.fetch) {
  if (!membershipPromise) {
    membershipPromise = fetchJson(MEMBERSHIP_URL, fetchImpl).catch((error) => {
      membershipPromise = null;
      throw error;
    });
  }
  return membershipPromise;
}

/**
 * Lazy layer-document loader. A token is fetched only when requested.
 */
export function loadLandDetailBoundaryLayerDoc(token, fetchImpl = globalThis.fetch) {
  const artifact = LAND_DETAIL_BOUNDARY_ARTIFACTS[token];
  if (!artifact) {
    return Promise.reject(new Error(`unknown_boundary_token:${token}`));
  }
  if (!layerDocPromises.has(token)) {
    layerDocPromises.set(
      token,
      fetchJson(artifact.artifact_url, fetchImpl)
        .then((doc) => {
          if (!doc || doc.schema !== "cityscroll.geography_layer.v1" || doc.type !== artifact.layer_type) {
            throw new Error(`boundary_layer_malformed:${token}`);
          }
          if (doc.geometry_fidelity && doc.geometry_fidelity !== "simplified") {
            throw new Error(`boundary_layer_not_simplified:${token}`);
          }
          return doc;
        })
        .catch((error) => {
          layerDocPromises.delete(token);
          throw error;
        }),
    );
  }
  return layerDocPromises.get(token);
}

/** Test-only cache clear so hermetic suites can re-exercise lazy fetches. */
export function __resetLandDetailBoundaryCachesForTests() {
  membershipPromise = null;
  layerDocPromises.clear();
}

function ensureHost(detailRoot) {
  if (!detailRoot || typeof detailRoot.querySelector !== "function") return null;
  let host = detailRoot.querySelector("#land-detail-boundary-controls-host");
  if (host) return host;
  const anchor = detailRoot.querySelector("#landpan")
    || detailRoot.querySelector("#landmap")
    || detailRoot.querySelector("#landmapnote");
  if (!anchor || typeof anchor.insertAdjacentHTML !== "function") return null;
  anchor.insertAdjacentHTML(
    anchor.id === "landmapnote" ? "beforebegin" : "afterend",
    `<div id="land-detail-boundary-controls-host"></div>`,
  );
  host = detailRoot.querySelector("#land-detail-boundary-controls-host");
  return host;
}

function readEnabledFromLocation(locationLike) {
  const hash = locationLike?.hash ?? "#land";
  return landDetailBoundariesFromRouteHash(hash);
}

function writeEnabledToLocation(enabled, locationLike, historyLike) {
  if (!locationLike) return;
  const next = routeHashWithLandDetailBoundaries(locationLike.hash || "#land", enabled);
  if (next === locationLike.hash) return;
  if (historyLike && typeof historyLike.replaceState === "function") {
    historyLike.replaceState(historyLike.state, "", next);
  } else {
    locationLike.hash = next.replace(/^#/, "");
  }
}

function leafletOutlineStyle(token) {
  return { ...(OUTLINE_STYLE[token] || OUTLINE_STYLE[LAND_BOUNDARY_LAYER_NTA]) };
}

/**
 * Attach optional outline controls to an already-painted Land detail map.
 *
 * Opening detail with this helper does not fetch boundary assets. Assets load
 * only when a control is pressed (or when the route already requests them).
 */
export async function mountLandDetailBoundaryLayers({
  map = null,
  detailRoot = null,
  projectId = null,
  selection = undefined,
  selectionSeq = null,
  fetchImpl = globalThis.fetch,
  leaflet = globalThis.L,
  locationLike = globalThis.location,
  historyLike = globalThis.history,
  documentLike = globalThis.document,
} = {}) {
  const id = clean(projectId, 32);
  if (!id || !detailRoot) return null;
  const host = ensureHost(detailRoot);
  if (!host) return null;

  const state = {
    schema: LAND_DETAIL_BOUNDARY_LAYERS_SCHEMA,
    project_id: id,
    enabled: readEnabledFromLocation(locationLike),
    layerDocs: Object.create(null),
    leafletLayers: Object.create(null),
    failures: new Set(),
    loading: new Set(),
    membership: null,
    disposed: false,
  };

  const stillCurrent = () => {
    if (state.disposed) return false;
    if (selection === undefined || selectionSeq == null) return true;
    return selection === selectionSeq();
  };

  const paintControls = () => {
    if (!stillCurrent()) return;
    const view = buildLandDetailBoundaryLayersView({
      projectId: id,
      membership: state.membership,
      enabled: state.enabled,
      layerDocs: state.layerDocs,
    });
    host.innerHTML = renderLandDetailBoundaryControlsHTML(view, {
      failureTokens: [...state.failures],
      loadingTokens: [...state.loading],
    });
    wireControls();
  };

  const clearLeafletLayer = (token) => {
    const layer = state.leafletLayers[token];
    if (layer && map && typeof map.removeLayer === "function") {
      try { map.removeLayer(layer); } catch (_error) { /* map may already be gone */ }
    }
    delete state.leafletLayers[token];
  };

  const paintLeafletLayer = (token) => {
    clearLeafletLayer(token);
    if (!map || !leaflet?.geoJSON) return;
    if (!state.enabled.includes(token)) return;
    const placeIds = landDetailBoundaryPlaceIds(state.membership, token);
    const features = selectBoundaryFeatures(
      state.layerDocs[token],
      placeIds,
      LAND_DETAIL_BOUNDARY_LAYER_TYPES[token],
    );
    if (!features.length) return;
    const layer = leaflet.geoJSON(landDetailBoundaryFeatureCollection(features), {
      style: () => leafletOutlineStyle(token),
      interactive: false,
    });
    layer.addTo(map);
    if (typeof layer.bringToBack === "function") layer.bringToBack();
    // Keep project marks visually above outlines without changing the camera.
    if (globalThis.landMarker && typeof globalThis.landMarker.bringToFront === "function") {
      try { globalThis.landMarker.bringToFront(); } catch (_error) { /* ignore */ }
    }
    state.leafletLayers[token] = layer;
  };

  const ensureMembership = async () => {
    if (state.membership) return state.membership;
    const index = await loadLandDetailBoundaryMembership(fetchImpl);
    if (!stillCurrent()) return null;
    state.membership = landDetailPlaceMembershipForProject(index, id);
    return state.membership;
  };

  const enableToken = async (token, { fromRoute = false } = {}) => {
    if (!LAND_BOUNDARY_LAYERS.includes(token)) return;
    state.failures.delete(token);
    if (!state.enabled.includes(token)) {
      state.enabled = LAND_BOUNDARY_LAYERS.filter((item) => item === token || state.enabled.includes(item));
    }
    if (!fromRoute) writeEnabledToLocation(state.enabled, locationLike, historyLike);
    state.loading.add(token);
    paintControls();
    try {
      await ensureMembership();
      if (!stillCurrent()) return;
      if (!state.layerDocs[token]) {
        state.layerDocs[token] = await loadLandDetailBoundaryLayerDoc(token, fetchImpl);
      }
      if (!stillCurrent()) return;
      state.loading.delete(token);
      state.failures.delete(token);
      paintLeafletLayer(token);
      paintControls();
    } catch (_error) {
      if (!stillCurrent()) return;
      state.loading.delete(token);
      state.failures.add(token);
      clearLeafletLayer(token);
      // Keep the token requested so retry can re-attempt the same layer.
      paintControls();
    }
  };

  const disableToken = (token) => {
    state.enabled = state.enabled.filter((item) => item !== token);
    state.failures.delete(token);
    state.loading.delete(token);
    clearLeafletLayer(token);
    writeEnabledToLocation(state.enabled, locationLike, historyLike);
    paintControls();
  };

  function wireControls() {
    const root = host.querySelector("[data-land-detail-boundary-controls='1']");
    if (!root || root.dataset.wired === "1") return;
    root.dataset.wired = "1";
    root.addEventListener("click", (event) => {
      const retry = event.target?.closest?.("[data-land-boundary-retry]");
      if (retry && root.contains(retry)) {
        const token = retry.getAttribute("data-land-boundary-retry");
        void enableToken(token);
        return;
      }
      const toggle = event.target?.closest?.("[data-land-boundary-layer]");
      if (!toggle || !root.contains(toggle) || toggle.disabled) return;
      const token = toggle.getAttribute("data-land-boundary-layer");
      const pressed = toggle.getAttribute("aria-pressed") === "true";
      if (pressed) disableToken(token);
      else void enableToken(token);
    });
  }

  // Membership is needed to know which controls are available, but boundary
  // geometry assets stay unloaded until a layer is requested.
  try {
    await ensureMembership();
  } catch (_error) {
    state.membership = null;
  }
  if (!stillCurrent()) return null;
  paintControls();

  const requested = [...state.enabled];
  for (const token of requested) {
    await enableToken(token, { fromRoute: true });
    if (!stillCurrent()) return null;
  }

  const controller = Object.freeze({
    schema: LAND_DETAIL_BOUNDARY_LAYERS_SCHEMA,
    project_id: id,
    getEnabled: () => Object.freeze([...state.enabled]),
    getFailures: () => Object.freeze([...state.failures]),
    enable: (token) => enableToken(token),
    disable: (token) => disableToken(token),
    dispose: () => {
      state.disposed = true;
      for (const token of LAND_BOUNDARY_LAYERS) clearLeafletLayer(token);
      if (host) host.innerHTML = "";
    },
  });

  if (documentLike) {
    documentLike.defaultView
      && (documentLike.defaultView.__landDetailBoundaryController = controller);
  }
  return controller;
}
