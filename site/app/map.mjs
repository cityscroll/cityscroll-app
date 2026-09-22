/* Near-you map island: adopts server-rendered SVG, area links, counts, and lists.
   It never creates or clears the page root. Every interaction retains a link/form fallback. */

import {
  MAP_LENSES,
  defaultViewBox,
  panViewBox,
  zoomViewBox,
} from "../map_exploration.mjs";
import { resolveDistricts } from "../council_district_lookup.mjs";
import { nearYouUrlFromMapHash } from "../near_you_scope_runtime.mjs";
import {
  adoptNearYouDocumentScope,
  applyNearYouDeferredPayload,
  beginNearYouDeferredGeneration,
  isNearYouDeferredGenerationCurrent,
} from "../near_you_scope_adoption.mjs";
import { bindNearYouRecordInspection } from "../near_you_record_inspection.mjs";
import { runtimeRumSemanticMilestones } from "../rum_static_record_instrumentation.mjs";
import {
  nearYouFrameReady,
  nearYouMapReady,
} from "../rum_maps_entities_async_instrumentation.mjs";
import {
  GEOGRAPHY_NAVIGATION_DRAWER_CLOSED,
  GEOGRAPHY_NAVIGATION_DRAWER_OPEN,
  GEOGRAPHY_NAVIGATION_SURFACE_MAP,
  GEOGRAPHY_NAVIGATION_SURFACE_RECORDS,
  bindGeographyNavigationPopState,
  parseGeographyNavigationState,
  geographyNavigationUrlWithFilters,
  writeGeographyNavigationHistory,
} from "../geography_navigation_state.mjs";
import {
  createGeographyNavigationMap,
  loadSimplifiedNavigationLayer,
  simplifiedLayerSiteUrl,
} from "../geography_navigation_map.mjs";
import { geographyShellAreasListHtml } from "../geography_navigation_shell.mjs";
import { GEOGRAPHY_NAVIGATION_LAYER_TYPES } from "../geography_navigation_capability.mjs";
import {
  geographyEntryUnavailableApiResult,
  resolveGeographyEntryFromAddressAsync,
  resolveGeographyEntryFromGeolocation,
  resolveGeographyEntryFromGeolocationError,
  resolveGeographyEntryFromMapClick,
  resolveGeographyEntryFromPlaceLabel,
} from "../geography_navigation_entry.mjs";
import {
  buildSelectedGeographyOverlapViewModel,
  loadCrosswalkRowsForSelection,
  overlapEscapePolicy,
  rememberOverlapInvoker,
  renderSelectedGeographyOverlapDrawerHtml,
  restoreOverlapInvokerFocus,
} from "../geography_navigation_overlap_ui.mjs";
import { loadCivicGeographyLayer } from "../civic_geography.mjs";
import { geocodeAddressText } from "../address_geocoder.mjs";

const root = document.querySelector("[data-near-you-root]");
let geographyMapController = null;
let geographyMapInitialization = null;
let geographyMapGeneration = 0;
let documentAdoptionGeneration = 0;
let geographyLayerCache = new Map();
let geographyEntryLayerPromise = null;
let geographyRegistry = null;
let overlapPointBundle = null;
let overlapHighlightKey = null;
const NEAR_YOU_STRING_DATASETS = Object.freeze({
  all_boroughs: "translationAllBoroughs",
  borough_label: "translationBoroughLabel",
  context_strip_lbl: "translationContextStripLabel",
});

function installNearYouLocalization() {
  if (typeof globalThis.t !== "function") {
    globalThis.t = (key, values = {}) => {
      let value = root?.dataset[NEAR_YOU_STRING_DATASETS[key]] || key;
      for (const [name, replacement] of Object.entries(values)) {
        value = value.replaceAll(`{${name}}`, replacement);
      }
      return value;
    };
  }
  if (typeof globalThis.applyStrings !== "function") {
    globalThis.applyStrings = () => {
      document.querySelectorAll("[data-i18n]").forEach((node) => {
        if (node.children.length === 0) node.textContent = globalThis.t(node.dataset.i18n);
      });
      document.querySelectorAll("[data-i18n-aria]").forEach((node) => {
        node.setAttribute("aria-label", globalThis.t(node.dataset.i18nAria));
      });
    };
  }
}

installNearYouLocalization();

const wired = new WeakSet();
let currentViewBox = null;

function status(message) {
  const node = root?.querySelector("[data-map-status]");
  if (node) node.textContent = message;
}

function copy(name, values = {}) {
  let value = root?.dataset[name] || "";
  for (const [key, replacement] of Object.entries(values)) {
    value = value.replaceAll(`{${key}}`, replacement);
  }
  return value;
}

function linkedPair(id) {
  if (!root || !id) return [];
  return [
    ...root.querySelectorAll(`[data-map-id="${CSS.escape(id)}"], [data-map-label="${CSS.escape(id)}"], [data-map-area="${CSS.escape(id)}"]`),
  ];
}

function setLinked(id, on) {
  for (const node of linkedPair(id)) node.classList.toggle("is-linked", on);
}

async function fetchNearYouDocument(href) {
  const response = await fetch(href, { headers: { Accept: "text/html" } });
  if (!response.ok && response.status !== 503) throw new Error(`near-you-response-${response.status}`);
  const next = new DOMParser().parseFromString(await response.text(), "text/html");
  const incoming = next.querySelector("[data-near-you-root]");
  if (!incoming) throw new Error("near-you-document-root-missing");
  return { href: response.url || href, incoming, next };
}

function parseDeferredHtml(html) {
  const template = document.createElement("template");
  template.innerHTML = String(html || "").trim();
  return template.content.firstElementChild;
}

async function hydrateCurrentNearYouDeferred() {
  if (!root) return;
  const state = root.dataset.nearDeferredState;
  if (state === "loading" || state === "ready") return;
  const href = root.dataset.nearDeferredHref;
  const hosts = [...root.querySelectorAll("[data-near-deferred]")];
  if (!href || !hosts.length) {
    root.dataset.nearDeferredState = "error";
    reportNearYouReadiness();
    return;
  }
  const generation = beginNearYouDeferredGeneration(root);
  root.dataset.nearDeferredState = "loading";
  const focusedDeferredPart = hosts.find((host) => host.contains(document.activeElement))?.dataset.nearDeferred;
  try {
    const response = await fetch(new URL(href, document.baseURI), {
      headers: { Accept: "application/json" },
    });
    if (!isNearYouDeferredGenerationCurrent(root, generation)) return;
    if (!response.ok) throw new Error(`near-you-deferred-response-${response.status}`);
    const payload = await response.json();
    if (!isNearYouDeferredGenerationCurrent(root, generation)) return;
    const applied = applyNearYouDeferredPayload(root, payload, {
      generation,
      parseHtml: parseDeferredHtml,
    });
    if (!applied.applied) return;
    wireMapAndList();
    wireSurfaceSwitch();
    if (focusedDeferredPart) {
      const focusTarget = focusedDeferredPart === "bags" ? "#near-bags-heading" : "#near-results-heading";
      root.querySelector(focusTarget)?.focus?.({ preventScroll: true });
    }
    reportNearYouReadiness();
  } catch {
    if (!isNearYouDeferredGenerationCurrent(root, generation)) return;
    const liveHosts = [...root.querySelectorAll("[data-near-deferred]")];
    for (const host of liveHosts) {
      const message = host.dataset.nearDeferred === "bags"
        ? copy("messageBagsUnavailable")
        : copy("messageDeferredUnavailable");
      const statusNode = document.createElement("p");
      statusNode.className = "near-deferred-status";
      statusNode.setAttribute("role", "status");
      statusNode.textContent = message;
      const recovery = document.createElement("a");
      recovery.className = "near-deferred-recovery";
      // Retry the URL that failed, not the static document's default recovery href.
      recovery.href = location.href || root.dataset.nearRecoveryHref || "/near-you/";
      recovery.dataset.nearRecovery = "retry";
      // Prefer Near You owned copy. Never leak a raw translation key when i18n is absent.
      let retryLabel = copy("messageRetry");
      if (!retryLabel && typeof globalThis.t === "function") {
        const translated = globalThis.t("buyer_history_retry");
        if (translated && translated !== "buyer_history_retry") retryLabel = translated;
      }
      recovery.textContent = retryLabel;
      host.replaceChildren(statusNode, recovery);
      host.setAttribute("aria-busy", "false");
      if (host.dataset.nearDeferred === "results") host.removeAttribute("data-results-count");
      host.dataset.nearDeferredState = "error";
    }
    root.dataset.nearDeferredState = "error";
    reportNearYouReadiness();
  }
}

async function adoptDocument(href, { replaceHistory = false, restoreHistory = false } = {}) {
  const generation = ++documentAdoptionGeneration;
  const prepared = await fetchNearYouDocument(href);
  const { incoming, next } = prepared;
  // Resolve optional synchronization dependencies before committing any page state.
  // Keep the last coherent view until the incoming document is ready to adopt.
  const placeContext = await import("./place-context.mjs");
  await geographyMapInitialization;
  if (generation !== documentAdoptionGeneration) return false;
  // The incoming document replaces the map host. Release its renderer before
  // replacing DOM, then initialize the new host instead of retaining an orphan.
  geographyMapGeneration += 1;
  geographyMapController?.destroy();
  geographyMapController = null;
  if (parseGeographyNavigationState(location.search).key !== parseGeographyNavigationState(new URL(href, location.href).search).key) {
    overlapPointBundle = null;
  }
  const currentMast = document.querySelector(".document-mast");
  const incomingMast = next.querySelector(".document-mast");
  if (currentMast && incomingMast) currentMast.replaceWith(document.importNode(incomingMast, true));
  adoptNearYouDocumentScope(root, incoming, {
    importNode: (node) => document.importNode(node, true),
  });
  const title = next.querySelector("title")?.textContent;
  if (title) document.title = title;
  const updateHistory = replaceHistory ? history.replaceState : history.pushState;
  if (!restoreHistory) updateHistory.call(history, { nearYou: true }, "", href);
  placeContext.sync();
  wireIsland();
  if (!restoreHistory) {
    const mapSurface = parseGeographyNavigationState(location.search).surface === GEOGRAPHY_NAVIGATION_SURFACE_MAP;
    const target = root.querySelector(mapSurface ? '.near-geo-workspace' : '#near-results-heading');
    target?.focus?.({ preventScroll: true });
    target?.scrollIntoView?.({ block: 'start' });
  }
  return true;
}
async function adoptMapHashRoute() {
  const hash = location.hash;
  const href = nearYouUrlFromMapHash(hash, { base: `${location.origin}/near-you/` });
  if (!href) return;
  const target = new URL(href, location.href);
  const targetRoute = `${target.pathname}${target.search}`;
  if (`${location.pathname}${location.search}` === targetRoute) {
    history.replaceState(history.state, "", targetRoute);
    return;
  }
  try {
    await adoptDocument(target.toString(), { replaceHistory: true });
  } catch {
    location.assign(target.toString());
  }
}

async function followWithinIsland(event, href) {
  if (!href || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
  event.preventDefault();
  if (event.currentTarget?.dataset.geographyKey) {
    href = geographySelectionHref(parseGeographyNavigationState(new URL(href).search));
  }
  status(copy("messageUpdating"));
  try {
    await adoptDocument(href);
    status(copy("messageUpdated"));
  } catch {
    location.assign(href);
  }
}

function wireMapAndList() {
  const svg = root.querySelector("#nearMapSvg");
  if (!svg) return;
  svg.setAttribute("role", "group");
  currentViewBox = svg.getAttribute("viewBox") || defaultViewBox();
  for (const path of root.querySelectorAll("[data-map-id]")) {
    if (wired.has(path)) continue;
    wired.add(path);
    const id = path.dataset.mapId;
    const href = path.dataset.mapHref;
    path.setAttribute("role", "link");
    path.tabIndex = 0;
    path.addEventListener("mouseenter", () => setLinked(id, true));
    path.addEventListener("mouseleave", () => setLinked(id, false));
    path.addEventListener("focus", () => setLinked(id, true));
    path.addEventListener("blur", () => setLinked(id, false));
    path.addEventListener("click", (event) => followWithinIsland(event, href));
    path.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      followWithinIsland(event, href);
    });
  }
  for (const link of root.querySelectorAll("[data-map-area]")) {
    if (wired.has(link)) continue;
    wired.add(link);
    const id = link.dataset.mapArea;
    link.addEventListener("mouseenter", () => setLinked(id, true));
    link.addEventListener("mouseleave", () => setLinked(id, false));
    link.addEventListener("focus", () => setLinked(id, true));
    link.addEventListener("blur", () => setLinked(id, false));
    link.addEventListener("click", (event) => followWithinIsland(event, link.href));
  }
}

function wirePanZoom() {
  const svg = root.querySelector("#nearMapSvg");
  if (!svg) return;
  for (const button of root.querySelectorAll("[data-map-zoom],[data-map-pan]")) {
    if (wired.has(button)) continue;
    wired.add(button);
    button.addEventListener("click", () => {
      if (button.dataset.mapZoom === "in") currentViewBox = zoomViewBox(currentViewBox, 0.7);
      else if (button.dataset.mapZoom === "out") currentViewBox = zoomViewBox(currentViewBox, 1.35);
      else if (button.dataset.mapZoom === "reset") currentViewBox = defaultViewBox();
      else if (button.dataset.mapPan === "west") currentViewBox = panViewBox(currentViewBox, -0.18, 0);
      else if (button.dataset.mapPan === "east") currentViewBox = panViewBox(currentViewBox, 0.18, 0);
      else if (button.dataset.mapPan === "north") currentViewBox = panViewBox(currentViewBox, 0, -0.18);
      else if (button.dataset.mapPan === "south") currentViewBox = panViewBox(currentViewBox, 0, 0.18);
      svg.setAttribute("viewBox", currentViewBox);
    });
  }
}

function boroughFromCommunity(id) {
  return ({ M: "Manhattan", X: "Bronx", K: "Brooklyn", Q: "Queens", R: "Staten Island" })[String(id || "")[0]] || null;
}

function areaHref(container, id, baseHref) {
  if (!container || !id) return null;
  const link = container.querySelector(`[data-map-area="${CSS.escape(id)}"]`);
  const href = link?.getAttribute("href");
  return href ? new URL(href, baseHref).toString() : null;
}

async function locationTargetHref(preferred, fallback) {
  const direct = areaHref(root, preferred, location.href);
  if (direct) return direct;
  const boroughHref = areaHref(root, fallback, location.href);
  if (!boroughHref || !preferred) return boroughHref;
  const boroughDocument = await fetchNearYouDocument(boroughHref);
  return areaHref(boroughDocument.incoming, preferred, boroughDocument.href);
}

async function loadGeographyEntryLayers() {
  if (geographyEntryLayerPromise) return geographyEntryLayerPromise;
  geographyEntryLayerPromise = (async () => {
    const registry = await loadGeographyRegistry();
    const layers = [];
    for (const type of GEOGRAPHY_NAVIGATION_LAYER_TYPES) {
      const url = simplifiedLayerSiteUrl(type, registry, { siteRoot: "/" });
      if (!url) continue;
      const response = await fetch(url, { headers: { Accept: "application/json" } });
      if (!response.ok) continue;
      const doc = loadCivicGeographyLayer(await response.json());
      if (doc) layers.push(doc);
    }
    if (!layers.length) throw new Error("geography-entry-layers-unavailable");
    return layers;
  })().catch((error) => {
    geographyEntryLayerPromise = null;
    throw error;
  });
  return geographyEntryLayerPromise;
}

function geographyEntryStatusMessage(entry) {
  if (!entry) return copy("messageLocationUnmatched");
  if (entry.ok) {
    const label = entry.selected?.label || entry.selection?.id || "area";
    return copy("messageLocationMatched", { district: label });
  }
  const reason = entry.recovery?.reason;
  if (reason === "geolocation_unavailable") return copy("messageLocationUnavailable") || entry.recovery.message;
  if (reason === "geolocation_denied") return copy("messageLocationDenied") || entry.recovery.message;
  if (reason === "geolocation_timeout") return copy("messageLocationTimeout") || entry.recovery.message;
  if (reason === "outside_covered_land") return copy("messageLocationOutside") || entry.recovery.message;
  if (reason === "lookup_failure") return copy("messageLocationLookupFailed") || entry.recovery.message;
  if (reason === "no_result" || reason === "empty_query" || reason === "ambiguous_place_label") {
    return entry.recovery?.message || copy("messageLocationUnmatched");
  }
  return entry.recovery?.message || copy("messageLocationUnmatched");
}

function geographySelectionHref(state) {
  return geographyNavigationUrlWithFilters(state, {base:location.href});
}

async function adoptGeographyEntrySelection(entry, { ephemeralPoint = null } = {}) {
  if (!entry?.ok || !entry.selection) {
    status(geographyEntryStatusMessage(entry));
    return false;
  }
  const nextState = {
    ...parseGeographyNavigationState(location.search),
    ok: true,
    geo: entry.selection.geo,
    key: entry.selection.key,
    type: entry.selection.type,
    id: entry.selection.id,
    surface: GEOGRAPHY_NAVIGATION_SURFACE_MAP,
    drawer: GEOGRAPHY_NAVIGATION_DRAWER_OPEN,
    focus: entry.selection.key,
  };
  if (!await adoptDocument(geographySelectionHref(nextState))) return false;
  overlapPointBundle = entry.bundle
    ? {
      id: entry.source || "entry",
      label: entry.selected?.label || null,
      membership: Object.fromEntries(
        Object.entries(entry.bundle.by_type || {}).map(([type, matches]) => [
          type,
          Array.isArray(matches) && matches[0]
            ? {
              id: matches[0].id,
              label: matches[0].label,
              boundary_vintage: matches[0].boundary_vintage,
            }
            : null,
        ]),
      ),
    }
    : overlapPointBundle;
  if (geographyMapController) {
    geographyMapController.setSelectedKey(entry.selection.key);
    if (ephemeralPoint && typeof geographyMapController.setPointMarker === "function") {
      const lon = Number(ephemeralPoint.lon ?? ephemeralPoint[0]);
      const lat = Number(ephemeralPoint.lat ?? ephemeralPoint[1]);
      if (Number.isFinite(lon) && Number.isFinite(lat)) {
        geographyMapController.setPointMarker([lon, lat]);
      }
    }
    geographyMapController.fitSelection?.({ padding: 48, maxZoom: 13 });
  }
  status(geographyEntryStatusMessage(entry));
  await refreshOverlapDrawer({ pointBundle: overlapPointBundle });
  return true;
}

async function adoptCompatibilityDistrictSelection(coords) {
  const response = await fetch(new URL("../data/district_boundaries.json", import.meta.url));
  const layer = response.ok ? await response.json() : null;
  const found = resolveDistricts(coords.latitude, coords.longitude, layer);
  const preferred = root.dataset.level === "council_district"
    ? found.council_district
    : found.community_district;
  const fallback = boroughFromCommunity(found.community_district);
  const href = await locationTargetHref(preferred, fallback);
  if (!href) {
    status(copy("messageLocationOutside") || copy("messageLocationUnmatched"));
    return false;
  }
  const district = preferred || fallback;
  try {
    await adoptDocument(href);
    status(copy("messageLocationMatched", { district }));
    return true;
  } catch {
    status(copy("messageLocationUpdateFailed", { district }));
    return false;
  }
}

function wireGeolocation() {
  const button = root.querySelector("[data-use-location]");
  if (!button || wired.has(button)) return;
  wired.add(button);
  button.addEventListener("click", () => {
    if (!navigator.geolocation) {
      status(geographyEntryStatusMessage(geographyEntryUnavailableApiResult()));
      return;
    }
    button.disabled = true;
    status(copy("messageLocationFinding"));
    navigator.geolocation.getCurrentPosition(async ({ coords }) => {
      try {
        if (root.dataset.geographyShell) {
          const layerData = await loadGeographyEntryLayers();
          const entry = resolveGeographyEntryFromGeolocation(
            coords.longitude,
            coords.latitude,
            { layerData },
          );
          // Coordinates are used for containment and optional marker only.
          await adoptGeographyEntrySelection(entry, {
            ephemeralPoint: entry.ok
              ? { lon: coords.longitude, lat: coords.latitude }
              : null,
          });
        } else {
          await adoptCompatibilityDistrictSelection(coords);
        }
      } catch {
        status(copy("messageLocationLookupFailed") || copy("messageLocationUnmatched"));
      } finally {
        button.disabled = false;
      }
    }, (error) => {
      button.disabled = false;
      status(geographyEntryStatusMessage(resolveGeographyEntryFromGeolocationError(error)));
    }, { enableHighAccuracy: false, timeout: 10000, maximumAge: 300000 });
  });
}

function wireForms() {
  for (const form of root.querySelectorAll("form[method='get']")) {
    if (wired.has(form)) continue;
    wired.add(form);
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      if (root.dataset.geographyShell && form.matches("[data-geography-search]")) {
        const query = String(new FormData(form).get("neighborhood") || "").trim();
        try {
          const layerData = await loadGeographyEntryLayers();
          let entry = resolveGeographyEntryFromPlaceLabel(query, { layerData });
          if (!entry.ok) {
            entry = await resolveGeographyEntryFromAddressAsync(query, {
              layerData,
              geocode: geocodeAddressText,
            });
          }
          if (entry.ok) {
            await adoptGeographyEntrySelection(entry);
            return;
          }
          status(geographyEntryStatusMessage(entry));
          return;
        } catch {
          status(copy("messageLocationLookupFailed") || copy("messageLocationUnmatched"));
          return;
        }
      }
      const url = new URL(form.action, location.href);
      url.search = new URLSearchParams(new FormData(form)).toString();
      try {
        await adoptDocument(url.toString());
        status(copy("messageUpdated"));
      } catch {
        location.assign(url.toString());
      }
    });
  }
}

function normalizeSurfaceToken(raw) {
  if (raw === "list" || raw === GEOGRAPHY_NAVIGATION_SURFACE_RECORDS) {
    return GEOGRAPHY_NAVIGATION_SURFACE_RECORDS;
  }
  if (raw === GEOGRAPHY_NAVIGATION_SURFACE_MAP) return GEOGRAPHY_NAVIGATION_SURFACE_MAP;
  return root?.dataset?.nearSurface === GEOGRAPHY_NAVIGATION_SURFACE_RECORDS
    ? GEOGRAPHY_NAVIGATION_SURFACE_RECORDS
    : GEOGRAPHY_NAVIGATION_SURFACE_MAP;
}

function applySurfaceChrome(surface) {
  const next = normalizeSurfaceToken(surface);
  root.dataset.nearSurface = next;
  root.dataset.nearMobileSurface = next === GEOGRAPHY_NAVIGATION_SURFACE_RECORDS
    ? GEOGRAPHY_NAVIGATION_SURFACE_RECORDS
    : GEOGRAPHY_NAVIGATION_SURFACE_MAP;
  for (const nav of root.querySelectorAll("[data-near-surface-switch]")) {
    nav.querySelectorAll("[data-near-surface]").forEach((node) => {
      const token = normalizeSurfaceToken(node.dataset.nearSurface);
      const active = token === next;
      node.classList.toggle("is-active", active);
      if (active) node.setAttribute("aria-current", "true");
      else node.removeAttribute("aria-current");
    });
  }
}

/** Map / Browse records switch; URL surface is durable geography state. */
function wireSurfaceSwitch() {
  const navs = [...root.querySelectorAll("[data-near-surface-switch]")];
  if (!navs.length) return;
  const initial = normalizeSurfaceToken(
    parseGeographyNavigationState(location.search).surface || root.dataset.nearSurface,
  );
  applySurfaceChrome(initial);
  for (const nav of navs) {
    if (wired.has(nav)) continue;
    wired.add(nav);
    nav.querySelectorAll("[data-near-surface]").forEach((link) => {
      link.addEventListener("click", (event) => {
        const surface = normalizeSurfaceToken(link.dataset.nearSurface);
        if (surface !== GEOGRAPHY_NAVIGATION_SURFACE_MAP
          && surface !== GEOGRAPHY_NAVIGATION_SURFACE_RECORDS) return;
        event.preventDefault();
        applySurfaceChrome(surface);
        const state = {
          ...parseGeographyNavigationState(location.search),
          surface,
          ok: true,
        };
        writeGeographyNavigationHistory(history, location, state, { mode: "push" });
        const target = root.querySelector(
          surface === GEOGRAPHY_NAVIGATION_SURFACE_MAP
            ? "#near-map-heading"
            : "#near-results-heading",
        );
        target?.focus?.({ preventScroll: true });
      });
    });
  }
}

function wireGeographyDrawer() {
  const workspace = root.querySelector("[data-geography-workspace]");
  const toggle = root.querySelector("[data-geography-drawer-toggle]");
  if (!workspace || !toggle || wired.has(toggle)) return;
  wired.add(toggle);
  toggle.hidden = false;
  toggle.addEventListener("click", () => {
    const open = workspace.dataset.geographyDrawerState !== "closed";
    const next = open ? GEOGRAPHY_NAVIGATION_DRAWER_CLOSED : GEOGRAPHY_NAVIGATION_DRAWER_OPEN;
    workspace.dataset.geographyDrawerState = next;
    toggle.setAttribute("aria-expanded", next === GEOGRAPHY_NAVIGATION_DRAWER_OPEN ? "true" : "false");
    const state = {
      ...parseGeographyNavigationState(location.search),
      drawer: next,
      ok: true,
    };
    writeGeographyNavigationHistory(history, location, state, { mode: "replace" });
    if (next === GEOGRAPHY_NAVIGATION_DRAWER_CLOSED) {
      const token = workspace.dataset.geographyFocusRestore
        || root.querySelector("[data-geography-overlap-root]")?.dataset?.geographyFocusRestore;
      restoreOverlapInvokerFocus(token, { root });
    } else {
      rememberOverlapInvoker(
        workspace.dataset.geographyFocusRestore || "geography-drawer-toggle",
        toggle,
      );
      root.querySelector("#near-geo-overlap-heading")?.focus?.({ preventScroll: true });
    }
  });
}

function replaceOverlapRailBody(html) {
  const aside = root.querySelector("[data-geography-drawer]");
  if (!aside) return;
  const toggle = aside.querySelector("[data-geography-drawer-toggle]");
  const existing = aside.querySelector("[data-geography-overlap-root]")
    || aside.querySelector("[data-geography-overlap-empty]")
    || aside.querySelector(".near-geo-rail-body");
  if (existing) existing.outerHTML = html;
  else if (toggle) toggle.insertAdjacentHTML("afterend", html);
  else aside.insertAdjacentHTML("beforeend", html);
  wireOverlapDrawerInteractions();
}

async function refreshOverlapDrawer({
  pointBundle = overlapPointBundle,
} = {}) {
  const generation = documentAdoptionGeneration;
  const state = parseGeographyNavigationState(location.search);
  if (!state?.key) {
    // Empty-rail copy lives in the shared overlap module (outside site/app scan).
    replaceOverlapRailBody(renderSelectedGeographyOverlapDrawerHtml(null));
    return null;
  }
  overlapPointBundle = pointBundle || overlapPointBundle;
  let crosswalkRows = null;
  let crosswalkAvailable = false;
  if (state.compare) {
    const loaded = await loadCrosswalkRowsForSelection(state.key, state.compare, { siteRoot: "/" });
    crosswalkRows = loaded.rows;
    crosswalkAvailable = loaded.available;
  }
  let relatedDistricts = [];
  if (state.type === 'nta2020') {
    const loaded = await loadCrosswalkRowsForSelection(state.key, 'community_district', { siteRoot: '/' });
    if (loaded.available) {
      const districtModel = buildSelectedGeographyOverlapViewModel({
        selected: {key:state.key, type:state.type, id:state.id},
        compareType:'community_district', crosswalkRows:loaded.rows, crosswalkAvailable:true,
        base:location.href, surface:GEOGRAPHY_NAVIGATION_SURFACE_RECORDS,
      });
      relatedDistricts = (districtModel.area_section?.rows || []).map((row) => {
        const href = new URL(row.select_href);
        return {key:row.key, id:row.id, label:row.label, href:href.toString(), scope:"broader"};
      });
    }
  }
  const current = parseGeographyNavigationState(location.search);
  if (generation !== documentAdoptionGeneration || current.key !== state.key || current.compare !== state.compare) return null;
  const model = buildSelectedGeographyOverlapViewModel({
    relatedDistricts,
    recordLenses: JSON.parse(root.querySelector('[data-geography-record-lenses]')?.dataset.geographyRecordLenses || '{}'),
    selected: {
      key: state.key,
      type: state.type,
      id: state.id,
      label: root.querySelector("[data-geography-selected-label]")?.textContent?.trim() || null,
    },
    compareType: state.compare || null,
    crosswalkRows,
    crosswalkAvailable: state.compare ? crosswalkAvailable : true,
    pointBundle: overlapPointBundle,
    base: location.href,
    surface: state.surface || GEOGRAPHY_NAVIGATION_SURFACE_MAP,
    drawer: state.drawer || GEOGRAPHY_NAVIGATION_DRAWER_OPEN,
    focusToken: state.focus || state.key,
  });
  replaceOverlapRailBody(renderSelectedGeographyOverlapDrawerHtml(model));
  const workspace = root.querySelector("[data-geography-workspace]");
  if (workspace && model.focus_token) {
    workspace.dataset.geographyFocusRestore = model.focus_token;
  }
  return model;
}

function featureBounds(feature) {
  const coords = [];
  const walk = (value) => {
    if (!Array.isArray(value)) return;
    if (typeof value[0] === "number" && typeof value[1] === "number") {
      coords.push(value);
      return;
    }
    for (const entry of value) walk(entry);
  };
  walk(feature?.geometry?.coordinates);
  if (!coords.length) return null;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const [x, y] of coords) {
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  }
  return [[minX, minY], [maxX, maxY]];
}

async function highlightOverlapComparison(key) {
  if (!geographyMapController || !key) return;
  const state = parseGeographyNavigationState(location.search);
  if (!state.compare) return;
  overlapHighlightKey = key;
  const layer = await loadGeographyLayer(state.compare);
  const features = (layer.features || []).filter((feature) => (
    (feature.properties?.key || feature.key) === key
  ));
  const layerDoc = {
    type: state.compare,
    geometry_fidelity: layer.geometry_fidelity || "simplified",
    vintage: layer.vintage || null,
    features: features.length
      ? features.map((feature) => ({
        key: feature.properties?.key || feature.key,
        id: feature.properties?.id || feature.id,
        type: feature.properties?.type || state.compare,
        label: feature.properties?.label || feature.label,
        subtype: feature.properties?.subtype ?? feature.subtype ?? null,
        geometry: feature.geometry,
      }))
      : (layer.features || []).map((feature) => ({
        key: feature.properties?.key || feature.key,
        id: feature.properties?.id || feature.id,
        type: feature.properties?.type || state.compare,
        label: feature.properties?.label || feature.label,
        subtype: feature.properties?.subtype ?? feature.subtype ?? null,
        geometry: feature.geometry,
      })),
  };
  geographyMapController.setComparisonLayer(state.compare, layerDoc);
  if (state.key) geographyMapController.setSelectedKey(state.key);
  const bounds = features[0] ? featureBounds(features[0]) : null;
  if (bounds && typeof geographyMapController.map?.fitBounds === "function") {
    geographyMapController.map.fitBounds(bounds, { padding: 48, maxZoom: 13, duration: 0 });
  }
}

function wireOverlapDrawerInteractions() {
  const rail = root.querySelector("[data-geography-overlap-root]");
  if (!rail || wired.has(rail)) return;
  wired.add(rail);
  rail.querySelectorAll('[data-geography-related-district],[data-geography-record-lens],[data-geography-overlap-records]').forEach((link) => {
    link.addEventListener('click', (event) => followWithinIsland(event, link.href));
  });
  rail.querySelectorAll("[data-geography-overlap-highlight]").forEach((button) => {
    const key = button.dataset.geographyOverlapHighlight;
    button.addEventListener("click", () => {
      void highlightOverlapComparison(key);
    });
    button.addEventListener("focus", () => {
      void highlightOverlapComparison(key);
    });
  });
  rail.querySelectorAll("[data-geography-compare]").forEach((link) => {
    link.addEventListener("click", (event) => {
      const type = link.dataset.geographyCompare;
      if (!type) return;
      event.preventDefault();
      const state = {
        ...parseGeographyNavigationState(location.search),
        compare: type,
        ok: true,
      };
      writeGeographyNavigationHistory(history, location, state, { mode: "push" });
      void applyGeographyComparison(type);
      void refreshOverlapDrawer();
    });
  });
}

async function applyGeographyComparison(compareType) {
  if (!geographyMapController) return;
  const state = parseGeographyNavigationState(location.search);
  if (!compareType) {
    geographyMapController.setComparisonLayer(null);
    overlapHighlightKey = null;
    if (state.key) geographyMapController.setSelectedKey(state.key);
    return;
  }
  const layer = await loadGeographyLayer(compareType);
  const layerDoc = {
    type: compareType,
    geometry_fidelity: layer.geometry_fidelity || "simplified",
    vintage: layer.vintage || null,
    features: (layer.features || []).map((feature) => ({
      key: feature.properties?.key || feature.key,
      id: feature.properties?.id || feature.id,
      type: feature.properties?.type || compareType,
      label: feature.properties?.label || feature.label,
      subtype: feature.properties?.subtype ?? feature.subtype ?? null,
      geometry: feature.geometry,
    })),
  };
  geographyMapController.setComparisonLayer(compareType, layerDoc);
  if (state.key) geographyMapController.setSelectedKey(state.key);
  if (overlapHighlightKey) {
    await highlightOverlapComparison(overlapHighlightKey);
  }
}

async function loadGeographyRegistry() {
  if (geographyRegistry) return geographyRegistry;
  const response = await fetch("/data/geography/layer_registry.json", {
    headers: { Accept: "application/json" },
  });
  if (!response.ok) throw new Error(`geography-registry-${response.status}`);
  geographyRegistry = await response.json();
  return geographyRegistry;
}

async function loadGeographyLayer(type) {
  if (geographyLayerCache.has(type)) return geographyLayerCache.get(type);
  const registry = await loadGeographyRegistry();
  const layer = await loadSimplifiedNavigationLayer(type, { registry, siteRoot: "/" });
  geographyLayerCache.set(type, layer);
  return layer;
}

function refreshGeographyAreasList(type, layerDoc) {
  const panel = root.querySelector("#near-area-list")
    || root.querySelector("[data-geography-areas]");
  if (!panel || !layerDoc) return;
  const html = geographyShellAreasListHtml(
    (layerDoc.features || []).map((feature) => ({
      key: feature.properties?.key || feature.key,
      id: feature.properties?.id || feature.id,
      type: feature.properties?.type || type,
      label: feature.properties?.label || feature.label,
      subtype: feature.properties?.subtype || feature.subtype,
    })).filter((entry) => entry.key && entry.label),
    {
      activeType: type,
      base: location.href,
      surface: GEOGRAPHY_NAVIGATION_SURFACE_MAP,
    },
  );
  panel.outerHTML = html;
  wireMapAndList();
}

function setActiveLayerButtons(type) {
  root.querySelectorAll("[data-geography-layer]").forEach((button) => {
    const active = button.dataset.geographyLayer === type;
    button.setAttribute("aria-pressed", active ? "true" : "false");
    if (active) button.setAttribute("data-geography-layer-active", "true");
    else button.removeAttribute("data-geography-layer-active");
  });
  root.dataset.geographyLayer = type;
}

async function activateGeographyLayer(type, { asComparison = null } = {}) {
  if (!geographyMapController) return;
  const state = parseGeographyNavigationState(location.search);
  const selectedType = state.type || null;
  const useComparison = asComparison != null
    ? asComparison
    : Boolean(state.key && type && type !== selectedType && type !== "nta2020");
  if (useComparison) {
    setActiveLayerButtons(type);
    const next = {
      ...state,
      compare: type,
      ok: true,
    };
    writeGeographyNavigationHistory(history, location, next, { mode: "replace" });
    await applyGeographyComparison(type);
    // Keep the selected geography's own layer mounted beneath the comparison.
    if (selectedType && selectedType !== type) {
      const selectedLayer = await loadGeographyLayer(selectedType);
      geographyMapController.setActiveLayer(selectedType, {
        type: selectedType,
        geometry_fidelity: selectedLayer.geometry_fidelity || "simplified",
        vintage: selectedLayer.vintage || null,
        features: (selectedLayer.features || []).map((feature) => ({
          key: feature.properties?.key || feature.key,
          id: feature.properties?.id || feature.id,
          type: feature.properties?.type || selectedType,
          label: feature.properties?.label || feature.label,
          subtype: feature.properties?.subtype ?? feature.subtype ?? null,
          geometry: feature.geometry,
        })),
      });
      if (state.key) geographyMapController.setSelectedKey(state.key);
    }
    await refreshOverlapDrawer();
    return;
  }
  const layer = await loadGeographyLayer(type);
  // loadSimplifiedNavigationLayer already projects features; pass a layer-shaped
  // document so setActiveLayer can re-project from top-level label/id fields.
  const layerDoc = {
    type,
    geometry_fidelity: layer.geometry_fidelity || "simplified",
    vintage: layer.vintage || null,
    features: (layer.features || []).map((feature) => ({
      key: feature.properties?.key || feature.key,
      id: feature.properties?.id || feature.id,
      type: feature.properties?.type || type,
      label: feature.properties?.label || feature.label,
      subtype: feature.properties?.subtype ?? feature.subtype ?? null,
      geometry: feature.geometry,
    })),
  };
  geographyMapController.setActiveLayer(type, layerDoc);
  const selectedFeature = layerDoc.features.find((feature) => feature.key === state.key);
  if (selectedFeature?.label) {
    for (const node of root.querySelectorAll('.near-hero>h1,[data-geography-selected-label]')) {
      node.textContent = selectedFeature.label;
    }
  }
  setActiveLayerButtons(type);
  refreshGeographyAreasList(type, layerDoc);
  if (state.key && state.compare) {
    await applyGeographyComparison(state.compare);
  } else {
    geographyMapController.setComparisonLayer(null);
  }
  if (state.key) geographyMapController.setSelectedKey(state.key);
  await refreshOverlapDrawer();
}

function wireGeographyLayerSwitcher() {
  const switcher = root.querySelector("[data-geography-layer-switcher]");
  if (!switcher || wired.has(switcher)) return;
  wired.add(switcher);
  switcher.querySelectorAll("[data-geography-layer]").forEach((button) => {
    button.addEventListener("click", () => {
      const type = button.dataset.geographyLayer;
      if (!type) return;
      void activateGeographyLayer(type).catch(() => {
        status(copy("messageUpdated"));
      });
    });
  });
}

function waitForGeographyMapHost(container) {
  return new Promise((resolve) => {
    const prepare = () => {
      container.hidden = false;
      container.removeAttribute("aria-hidden");
      if (!container.style.minHeight) container.style.minHeight = "320px";
      const wrap = container.closest(".near-map-wrap");
      if (wrap) wrap.dataset.geographyMapMode = "enhanced";
      const rect = container.getBoundingClientRect();
      if (rect.width >= 160 && rect.height >= 160) {
        resolve(rect);
        return true;
      }
      return false;
    };
    if (prepare()) return;
    let frames = 0;
    const tick = () => {
      frames += 1;
      if (prepare() || frames > 30) resolve(container.getBoundingClientRect());
      else requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
}

function wireGeographyNavigationMap() {
  if (geographyMapInitialization) return geographyMapInitialization;
  geographyMapInitialization = initializeGeographyNavigationMap().finally(() => {
    geographyMapInitialization = null;
  });
  return geographyMapInitialization;
}

async function initializeGeographyNavigationMap() {
  const container = root.querySelector("#near-map-enhanced");
  if (!container || geographyMapController) return;
  const generation = ++geographyMapGeneration;
  if (globalThis.__CITYSCROLL_FORCE_GEOGRAPHY_MAP_FAILURE) {
    throw new Error("forced_geography_map_failure");
  }
  try {
    await waitForGeographyMapHost(container);
    if (generation !== geographyMapGeneration || !container.isConnected) return;
    const controller = await createGeographyNavigationMap({
      container,
      root,
      onSelect: ({ key, originalEvent }) => {
        const lngLat = originalEvent?.lngLat;
        if (lngLat && Number.isFinite(lngLat.lng) && Number.isFinite(lngLat.lat)) {
          void loadGeographyEntryLayers()
            .then((layerData) => resolveGeographyEntryFromMapClick(lngLat.lng, lngLat.lat, { layerData }))
            .then((entry) => adoptGeographyEntrySelection(entry, {
              ephemeralPoint: entry?.ok ? { lon: lngLat.lng, lat: lngLat.lat } : null,
            }))
            .catch(() => {
              status(copy("messageLocationLookupFailed"));
            });
          return;
        }
        if (!key) return;
        const state = {
          ...parseGeographyNavigationState(location.search),
          ok: true,
          geo: String(key).replace(/^geography:/, ""),
          key,
          surface: GEOGRAPHY_NAVIGATION_SURFACE_MAP,
        };
        void adoptDocument(geographySelectionHref(state)).catch(() => {
          status(copy("messageLocationLookupFailed"));
        });
      },
      onFallback: () => {
        geographyMapController = null;
      },
      onTileFailure: () => {
        // Basemap is decorative; keep local boundaries and controls.
      },
    });
    if (generation !== geographyMapGeneration || !container.isConnected) {
      controller.destroy();
      return;
    }
    geographyMapController = controller;
    const selected = parseGeographyNavigationState(location.search);
    const initialType = selected?.compare
      || selected?.type
      || root.dataset.geographyLayer
      || "nta2020";
    await activateGeographyLayer(initialType);
    if (selected?.key) {
      geographyMapController.setSelectedKey(selected.key);
      geographyMapController.fitSelection({ padding: 40, maxZoom: 14 });
    }
    if (selected?.compare) await applyGeographyComparison(selected.compare);
    await refreshOverlapDrawer();
    wireOverlapDrawerInteractions();
    geographyMapController.getState?.();
  } catch {
    geographyMapController = null;
  }
}

function nearYouMapStateFromRoot(node) {
  if (["unsupported", "pending", "error", "empty", "populated"].includes(node.dataset.nearMapState)) {
    return node.dataset.nearMapState;
  }
  const mapped = MAP_LENSES.includes(node.dataset.lens) && node.dataset.lens !== "all";
  const count = Number(node.querySelector("[data-results-count]")?.dataset.resultsCount);
  const placeDataMissing = [...node.querySelectorAll(".near-coverage")].some((el) =>
    /place data is not available/i.test(el.textContent || "")
  );
  if (!mapped || placeDataMissing) return "unavailable";
  if (Number.isFinite(count) && count > 0) return "content";
  if (Number.isFinite(count)) return "empty";
  return "error";
}

function reportNearYouReadiness() {
  if (!root) return;
  const rum = runtimeRumSemanticMilestones();
  nearYouFrameReady(rum, {
    hasRoot: true,
    hasMapSvg: Boolean(root.querySelector("#nearMapSvg")),
    hasPlaceControls: Boolean(root.querySelector("#near-place-fields")),
  });
  nearYouMapReady(rum, {
    resultState: nearYouMapStateFromRoot(root),
  });
}

function wireRecordInspection() {
  if (!root) return;
  // Idempotent: delegated binding survives deferred result adoption.
  bindNearYouRecordInspection(root);
}

function wireIsland() {
  if (!root) return;
  root.dataset.enhanced = "true";
  for (const control of root.querySelectorAll(".js-only")) control.hidden = false;
  wireMapAndList();
  wirePanZoom();
  wireGeolocation();
  wireForms();
  wireSurfaceSwitch();
  wireGeographyDrawer();
  wireGeographyLayerSwitcher();
  wireRecordInspection();
  void hydrateCurrentNearYouDeferred();
  void wireGeographyNavigationMap();
}

if (root) {
  wireIsland();
  addEventListener("hashchange", () => {
    if (location.hash.startsWith("#map")) void adoptMapHashRoute();
  });
  void adoptMapHashRoute();
  bindGeographyNavigationPopState(window, (state) => {
    // History changes the data scope too, not just the selected outline.
    void adoptDocument(location.href, { restoreHistory: true }).catch(() => location.reload());
    applySurfaceChrome(state?.surface || GEOGRAPHY_NAVIGATION_SURFACE_MAP);
    if (state?.key && geographyMapController) {
      geographyMapController.setSelectedKey(state.key);
    }
    if (geographyMapController) {
      void (state?.compare
        ? applyGeographyComparison(state.compare)
        : applyGeographyComparison(null));
    }
    const workspace = root.querySelector("[data-geography-workspace]");
    if (workspace && state?.drawer) {
      workspace.dataset.geographyDrawerState = state.drawer;
      const toggle = root.querySelector("[data-geography-drawer-toggle]");
      toggle?.setAttribute(
        "aria-expanded",
        state.drawer === GEOGRAPHY_NAVIGATION_DRAWER_CLOSED ? "false" : "true",
      );
    }
    void refreshOverlapDrawer();
  });
  addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    const policy = overlapEscapePolicy();
    if (policy.clears_hover) geographyMapController?.setHoveredKey?.(null);
    if (policy.clears_focus_ring) geographyMapController?.setFocusedKey?.(null);
    // Durable selection and drawer stay put.
  });
  addEventListener("popstate", () => {
    // Document-scoped filters still require a full adopt; surface-only pops are handled above.
    if (!location.search.includes("geo=") && !root.dataset.geographyShell) location.reload();
  });
}

export { wireIsland as initNearYouMapIsland };
