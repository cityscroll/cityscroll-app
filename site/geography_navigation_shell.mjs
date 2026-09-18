/**
 * Resident Near You map-first shell helpers.
 *
 * Markup and area-list projection for the calm geography navigator. The shell
 * adopts geography URL state and mounts the progressive map runtime; it does
 * not recompute membership, overlap percentages, or record scope.
 */

import {
  geographyNavigationMoreBoundaryLayers,
  geographyNavigationPrimaryLayers,
  isResidentialNeighborhoodSubtype,
  ntaResidentLabelPolicy,
} from "./geography_navigation_capability.mjs";
import {
  GEOGRAPHY_NAVIGATION_DEFAULT_SURFACE,
  GEOGRAPHY_NAVIGATION_SURFACE_MAP,
  GEOGRAPHY_NAVIGATION_SURFACE_RECORDS,
  geographyNavigationUrlFromState,
} from "./geography_navigation_state.mjs";

export const RESIDENT_GEOGRAPHY_SHELL_SCHEMA = "cityscroll.resident_geography_shell.v1";

export const GEOGRAPHY_SHELL_HEADING = "What's near you?";
export const GEOGRAPHY_SHELL_BROWSE_RECORDS_LABEL = "Browse records";
export const GEOGRAPHY_SHELL_MORE_BOUNDARIES_LABEL = "More boundaries";
export const GEOGRAPHY_SHELL_USE_LOCATION_LABEL = "Use my location";
export const GEOGRAPHY_SHELL_SEARCH_LABEL = "Address or place";
export const GEOGRAPHY_SHELL_SEARCH_PLACEHOLDER = "Neighborhood, district, or address";
export const GEOGRAPHY_SHELL_AREAS_HEADING = "Areas";

function esc(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

/** Compact area entries for the native-link Areas list (no geometry). */
export function navigationAreaEntriesFromLayerDoc(layerDoc, { layerType = null } = {}) {
  const type = String(layerType || layerDoc?.type || "").trim();
  const features = Array.isArray(layerDoc?.features) ? layerDoc.features : [];
  const entries = [];
  for (const feature of features) {
    if (!feature || typeof feature !== "object") continue;
    const id = String(feature.id ?? "").trim();
    const key = String(feature.key || (type && id ? `geography:${type}:${id}` : "")).trim();
    const label = String(feature.label || "").trim();
    if (!key || !label || !id) continue;
    const subtype = feature.subtype == null ? null : String(feature.subtype);
    if (type === "nta2020") {
      const policy = ntaResidentLabelPolicy(subtype);
      // Special-use NTAs stay selectable but are not listed as ordinary neighborhoods.
      if (!policy.may_label_as_neighborhood && !isResidentialNeighborhoodSubtype(subtype)) {
        continue;
      }
    }
    // Never promote bare codes into primary copy.
    if (type === "nta2020" && /^[A-Z]{2}\d{4}$/.test(label)) continue;
    entries.push(Object.freeze({
      key,
      id,
      type: type || String(feature.type || ""),
      label,
      subtype,
    }));
  }
  entries.sort((left, right) => left.label.localeCompare(right.label) || left.id.localeCompare(right.id));
  return Object.freeze(entries);
}

export function areaEntryKeys(entries) {
  return Object.freeze((entries || []).map((entry) => entry.key));
}

export function areaEntryLabels(entries) {
  return Object.freeze((entries || []).map((entry) => entry.label));
}

/** Assert list keys equal map feature keys (order-independent). */
export function areaListMatchesMapKeys(areaEntries, mapKeys) {
  const left = new Set(areaEntryKeys(areaEntries));
  const right = new Set((mapKeys || []).map(String));
  if (left.size !== right.size) return false;
  for (const key of left) {
    if (!right.has(key)) return false;
  }
  return true;
}

export function geographyShellLayerSwitcherHtml({
  activeType = "nta2020",
  base = "/near-you/",
  surface = GEOGRAPHY_NAVIGATION_DEFAULT_SURFACE,
  selectedGeo = null,
} = {}) {
  const primary = geographyNavigationPrimaryLayers().map((layer) => {
    const pressed = layer.type === activeType;
    const href = geographyNavigationUrlFromState({
      ok: true,
      geo: selectedGeo,
      compare: layer.type === "nta2020" ? null : (selectedGeo ? layer.type : null),
      surface,
      // Layer choice for the unselected navigator is presentation; keep URL calm.
    }, { base });
    return `<button type="button" class="near-geo-layer" data-geography-layer="${esc(layer.type)}" aria-pressed="${pressed ? "true" : "false"}"${pressed ? ' data-geography-layer-active="true"' : ""}>${esc(layer.primary_label)}</button>`;
  }).join("");

  const more = geographyNavigationMoreBoundaryLayers().map((layer) => {
    const pressed = layer.type === activeType;
    return `<button type="button" class="near-geo-layer near-geo-layer-more" data-geography-layer="${esc(layer.type)}" aria-pressed="${pressed ? "true" : "false"}"${pressed ? ' data-geography-layer-active="true"' : ""}>${esc(layer.primary_label)}</button>`;
  }).join("");

  return `<div class="near-geo-layers" data-geography-layer-switcher role="group" aria-label="Boundary layers">
      <div class="near-geo-layers-primary">${primary}</div>
      <details class="near-geo-more-boundaries"${activeType === "police_precinct" ? " open" : ""}>
        <summary>${esc(GEOGRAPHY_SHELL_MORE_BOUNDARIES_LABEL)}</summary>
        <div class="near-geo-layers-more">${more}</div>
      </details>
    </div>`;
}

export function geographyShellAreasListHtml(entries, {
  activeType = "nta2020",
  base = "/near-you/",
  surface = GEOGRAPHY_NAVIGATION_SURFACE_MAP,
  countsByKey = null,
} = {}) {
  const items = (entries || []).map((entry) => {
    const href = geographyNavigationUrlFromState({
      ok: true,
      geo: `${entry.type}:${entry.id}`,
      key: entry.key,
      type: entry.type,
      id: entry.id,
      surface,
    }, { base });
    const count = countsByKey && Object.prototype.hasOwnProperty.call(countsByKey, entry.key)
      ? countsByKey[entry.key]
      : null;
    const countMarkup = count == null ? "" : `<strong>${esc(count)}</strong>`;
    return `<li><a data-map-area="${esc(entry.id)}" data-geography-key="${esc(entry.key)}" data-geography-layer="${esc(entry.type)}" href="${esc(href)}"><span>${esc(entry.label)}</span>${countMarkup}</a></li>`;
  }).join("");
  return `<div class="near-area-panel" id="near-area-list" data-geography-areas data-geography-layer="${esc(activeType)}">
          <h3>${esc(GEOGRAPHY_SHELL_AREAS_HEADING)}</h3>
          <ol class="near-area-list">${items || "<li>No areas match this layer.</li>"}</ol>
        </div>`;
}

export function geographyShellSearchFormHtml({
  action = "/near-you/",
  value = "",
} = {}) {
  return `<form class="near-geo-search" method="get" action="${esc(action)}" data-geography-search>
      <label for="near-geo-search-input">${esc(GEOGRAPHY_SHELL_SEARCH_LABEL)}</label>
      <div class="near-geo-search-row">
        <input id="near-geo-search-input" name="neighborhood" type="search" value="${esc(value)}" placeholder="${esc(GEOGRAPHY_SHELL_SEARCH_PLACEHOLDER)}" autocomplete="street-address" enterkeyhint="search">
        <button type="submit">Search</button>
      </div>
    </form>`;
}

/**
 * Entry chrome for a fresh, unselected Near You page: heading, search, location,
 * layer switcher, and Browse records.
 */
export function renderGeographyShellEntry({
  canonicalBase = "/near-you/",
  surface = GEOGRAPHY_NAVIGATION_DEFAULT_SURFACE,
  activeType = "nta2020",
  searchValue = "",
  recordsHref = null,
} = {}) {
  const browseHref = recordsHref || geographyNavigationUrlFromState({
    ok: true,
    surface: GEOGRAPHY_NAVIGATION_SURFACE_RECORDS,
  }, { base: canonicalBase });
  const mapHref = geographyNavigationUrlFromState({
    ok: true,
    surface: GEOGRAPHY_NAVIGATION_SURFACE_MAP,
  }, { base: canonicalBase });
  return `<section class="near-geo-entry" aria-labelledby="near-geo-heading" data-geography-entry>
      <p class="near-kicker">Local geography</p>
      <h1 id="near-geo-heading">${esc(GEOGRAPHY_SHELL_HEADING)}</h1>
      <p>Choose a neighborhood or district on the map. Then browse the records for that place.</p>
      ${geographyShellSearchFormHtml({ action: canonicalBase, value: searchValue })}
      <div class="near-place-actions near-geo-actions">
        <button type="button" class="js-only near-location-action" data-use-location hidden>${esc(GEOGRAPHY_SHELL_USE_LOCATION_LABEL)}</button>
        <a href="#near-area-list">Browse the area list</a>
      </div>
      <p class="near-map-status" data-map-status aria-live="polite"></p>
      ${geographyShellLayerSwitcherHtml({ activeType, base: canonicalBase, surface })}
      <nav class="near-surface-switch" aria-label="Near you view" data-near-surface-switch>
        <a class="near-surface-link${surface === GEOGRAPHY_NAVIGATION_SURFACE_MAP ? " is-active" : ""}" href="${esc(mapHref)}" data-near-surface="${GEOGRAPHY_NAVIGATION_SURFACE_MAP}"${surface === GEOGRAPHY_NAVIGATION_SURFACE_MAP ? ' aria-current="true"' : ""}>Map</a>
        <a class="near-surface-link${surface === GEOGRAPHY_NAVIGATION_SURFACE_RECORDS ? " is-active" : ""}" href="${esc(browseHref)}" data-near-surface="${GEOGRAPHY_NAVIGATION_SURFACE_RECORDS}"${surface === GEOGRAPHY_NAVIGATION_SURFACE_RECORDS ? ' aria-current="true"' : ""}>${esc(GEOGRAPHY_SHELL_BROWSE_RECORDS_LABEL)}</a>
      </nav>
    </section>`;
}

/** Surface switch for selected-place routes (Map / Browse records). */
export function renderGeographyShellSurfaceSwitch({
  canonicalBase = "/near-you/",
  surface = GEOGRAPHY_NAVIGATION_DEFAULT_SURFACE,
  geo = null,
  recordsLabel = GEOGRAPHY_SHELL_BROWSE_RECORDS_LABEL,
  recordsCount = null,
} = {}) {
  const mapHref = geographyNavigationUrlFromState({
    ok: true,
    geo,
    surface: GEOGRAPHY_NAVIGATION_SURFACE_MAP,
  }, { base: canonicalBase });
  const recordsHref = geographyNavigationUrlFromState({
    ok: true,
    geo,
    surface: GEOGRAPHY_NAVIGATION_SURFACE_RECORDS,
  }, { base: canonicalBase });
  const recordsText = recordsCount == null
    ? recordsLabel
    : `${recordsLabel} (${recordsCount})`;
  return `<nav class="near-surface-switch" aria-label="Near you view" data-near-surface-switch>
      <a class="near-surface-link${surface === GEOGRAPHY_NAVIGATION_SURFACE_MAP ? " is-active" : ""}" href="${esc(mapHref)}" data-near-surface="${GEOGRAPHY_NAVIGATION_SURFACE_MAP}"${surface === GEOGRAPHY_NAVIGATION_SURFACE_MAP ? ' aria-current="true"' : ""}>Map</a>
      <a class="near-surface-link${surface === GEOGRAPHY_NAVIGATION_SURFACE_RECORDS ? " is-active" : ""}" href="${esc(recordsHref)}" data-near-surface="${GEOGRAPHY_NAVIGATION_SURFACE_RECORDS}"${surface === GEOGRAPHY_NAVIGATION_SURFACE_RECORDS ? ' aria-current="true"' : ""}>${esc(recordsText)}</a>
    </nav>`;
}

export function resolveShellSurface(raw, { hasExplicitSurface = false, hasPlace = false } = {}) {
  if (raw === GEOGRAPHY_NAVIGATION_SURFACE_RECORDS || raw === "list") {
    return GEOGRAPHY_NAVIGATION_SURFACE_RECORDS;
  }
  if (raw === GEOGRAPHY_NAVIGATION_SURFACE_MAP) return GEOGRAPHY_NAVIGATION_SURFACE_MAP;
  // Ordinary enhanced entry opens Map; selected-place routes keep Records leading
  // unless an explicit surface says otherwise.
  if (hasExplicitSurface) return GEOGRAPHY_NAVIGATION_DEFAULT_SURFACE;
  return hasPlace ? GEOGRAPHY_NAVIGATION_SURFACE_RECORDS : GEOGRAPHY_NAVIGATION_SURFACE_MAP;
}
