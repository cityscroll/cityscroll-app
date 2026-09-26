/**
 * Homepage place entry: Use my location, typed address, and neighborhood label
 * resolution into the existing Near You geography state.
 *
 * Reuses the shared geography entry helpers and AG-11 address adapter. Geolocation
 * runs only after an explicit button press. Entered addresses and coordinates stay
 * ephemeral and never enter shared URLs, history, or analytics payloads.
 */

import { loadCivicGeographyLayer } from "./civic_geography.mjs";
import {
  GEOGRAPHY_ENTRY_RECOVERY,
  GEOGRAPHY_ENTRY_SOURCES,
  geographyEntryPayloadLeaksEphemeral,
  geographyEntryPublicProjection,
  geographyEntryRecoveryCopy,
  resolveGeographyEntryFromGeolocation,
  resolveGeographyEntryFromGeolocationError,
  resolveGeographyEntryFromPlaceLabel,
} from "./geography_navigation_entry.mjs";
import { GEOGRAPHY_NAVIGATION_LAYER_TYPES } from "./geography_navigation_capability.mjs";
import { simplifiedLayerSiteUrl } from "./geography_navigation_map.mjs";
import {
  GEOGRAPHY_NAVIGATION_DEFAULT_SURFACE,
  GEOGRAPHY_NAVIGATION_EPHEMERAL_KEYS,
  GEOGRAPHY_NAVIGATION_SURFACE_MAP,
  geographyNavigationUrlFromState,
  omitGeographyNavigationEphemeral,
  serializeGeographyNavigationState,
} from "./geography_navigation_state.mjs";
import {
  GEOGRAPHY_SHELL_SEARCH_LABEL,
  GEOGRAPHY_SHELL_SEARCH_PLACEHOLDER,
  GEOGRAPHY_SHELL_USE_LOCATION_LABEL,
} from "./geography_navigation_shell.mjs";

export const HOME_LOCAL_ENTRY_SCHEMA = "cityscroll.home_local_entry.v1";
export const HOME_LOCAL_ENTRY_HEADING = "What's near you?";
export const HOME_LOCAL_ENTRY_INTRO =
  "Choose your neighborhood, type an address, or use your location to open nearby meetings.";
export const HOME_LOCAL_ENTRY_SUBMIT_LABEL = "Find nearby";
export const HOME_LOCAL_ENTRY_BROWSE_AREAS_LABEL = "Browse neighborhoods";
export const HOME_LOCAL_ENTRY_BROWSE_AREAS_HREF = "/near-you/";
export const HOME_LOCAL_ENTRY_DEFAULT_LENS = "meetings";
export const HOME_LOCAL_ENTRY_LOCATION_HINT = "Asked only when you press the button.";

const EPHEMERAL_SET = new Set([
  ...GEOGRAPHY_NAVIGATION_EPHEMERAL_KEYS,
  "bbl",
  "candidate_identities",
  "candidates",
  "ephemeralPoint",
  "ephemeral_point",
  "raw_address",
  "query",
  "query_text",
  "address_text",
]);

function clean(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function esc(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Durable Near You destination for a successful geography entry.
 * Lens defaults to meetings so the named local journey is immediate.
 */
export function homeLocalEntryNearYouHref(entry, {
  base = "/near-you/",
  lens = HOME_LOCAL_ENTRY_DEFAULT_LENS,
  surface = GEOGRAPHY_NAVIGATION_SURFACE_MAP,
} = {}) {
  if (!entry?.ok || !entry.selection?.geo) return null;
  const href = geographyNavigationUrlFromState({
    ok: true,
    geo: entry.selection.geo,
    key: entry.selection.key,
    type: entry.selection.type,
    id: entry.selection.id,
    surface: surface || GEOGRAPHY_NAVIGATION_DEFAULT_SURFACE,
    lens,
  }, { base });
  const params = new URL(href, "https://cityscroll.invalid").searchParams;
  for (const key of EPHEMERAL_SET) {
    if (params.has(key)) return null;
  }
  return href;
}

export function homeLocalEntryPayloadLeaksEphemeral(bag) {
  if (geographyEntryPayloadLeaksEphemeral(bag)) return true;
  if (!bag || typeof bag !== "object") return false;
  const serialized = JSON.stringify(omitGeographyNavigationEphemeral(bag));
  for (const key of EPHEMERAL_SET) {
    if (Object.hasOwn(bag, key)) return true;
    if (new RegExp(`"${key}"\\s*:`).test(serialized)) return true;
  }
  return false;
}

export function homeLocalEntryPublicProjection(entry) {
  const projection = geographyEntryPublicProjection(entry);
  if (!projection) return null;
  return omitGeographyNavigationEphemeral({
    ...projection,
    near_you_href: homeLocalEntryNearYouHref(entry),
  });
}

/**
 * Resolve a typed homepage query: place label first, then the parcel-geography
 * address adapter. Inject resolveAddress in tests; production lazy-loads it.
 */
export async function resolveHomeLocalEntryQuery(query, {
  layerData = [],
  resolveAddress = null,
  aliasIndex = null,
} = {}) {
  const text = clean(query);
  if (!text) {
    return {
      entry: {
        schema: "cityscroll.resident_geography_entry.v1",
        ok: false,
        source: GEOGRAPHY_ENTRY_SOURCES.PLACE_LABEL,
        selected: null,
        selection: null,
        bundle: null,
        recovery: {
          reason: GEOGRAPHY_ENTRY_RECOVERY.EMPTY_QUERY,
          message: geographyEntryRecoveryCopy(GEOGRAPHY_ENTRY_RECOVERY.EMPTY_QUERY),
        },
      },
      ephemeralPoint: null,
    };
  }

  const place = resolveGeographyEntryFromPlaceLabel(text, { layerData, aliasIndex });
  if (place?.ok) {
    return { entry: place, ephemeralPoint: null };
  }
  if (
    place
    && !place.ok
    && place.recovery?.reason === GEOGRAPHY_ENTRY_RECOVERY.AMBIGUOUS_PLACE_LABEL
  ) {
    return { entry: place, ephemeralPoint: null };
  }

  if (typeof resolveAddress !== "function") {
    return {
      entry: place && !place.ok
        ? place
        : {
          schema: "cityscroll.resident_geography_entry.v1",
          ok: false,
          source: GEOGRAPHY_ENTRY_SOURCES.ADDRESS,
          selected: null,
          selection: null,
          bundle: null,
          recovery: {
            reason: GEOGRAPHY_ENTRY_RECOVERY.LOOKUP_FAILURE,
            message: geographyEntryRecoveryCopy(GEOGRAPHY_ENTRY_RECOVERY.LOOKUP_FAILURE),
          },
        },
      ephemeralPoint: null,
    };
  }

  const resolved = await resolveAddress(text, { layerData });
  if (resolved?.entry) {
    return {
      entry: resolved.entry,
      ephemeralPoint: resolved.ephemeralPoint || null,
    };
  }
  return {
    entry: place && !place.ok
      ? place
      : {
        schema: "cityscroll.resident_geography_entry.v1",
        ok: false,
        source: GEOGRAPHY_ENTRY_SOURCES.ADDRESS,
        selected: null,
        selection: null,
        bundle: null,
        recovery: {
          reason: GEOGRAPHY_ENTRY_RECOVERY.NO_RESULT,
          message: geographyEntryRecoveryCopy(GEOGRAPHY_ENTRY_RECOVERY.NO_RESULT),
        },
      },
    ephemeralPoint: null,
  };
}

export function renderHomeLocalEntryHtml({
  action = "/near-you/",
  browseHref = HOME_LOCAL_ENTRY_BROWSE_AREAS_HREF,
} = {}) {
  return `<section class="home-local-entry" data-home-local-entry aria-labelledby="home-local-heading">
      <p class="home-local-kicker">Local meetings</p>
      <h2 id="home-local-heading">${esc(HOME_LOCAL_ENTRY_HEADING)}</h2>
      <p class="home-local-intro">${esc(HOME_LOCAL_ENTRY_INTRO)}</p>
      <form class="home-local-form" method="get" action="${esc(action)}" data-home-local-form>
        <input type="hidden" name="lens" value="${esc(HOME_LOCAL_ENTRY_DEFAULT_LENS)}">
        <input type="hidden" name="surface" value="${esc(GEOGRAPHY_NAVIGATION_SURFACE_MAP)}">
        <label for="home-local-query">${esc(GEOGRAPHY_SHELL_SEARCH_LABEL)}</label>
        <div class="home-local-form-row">
          <input id="home-local-query" name="neighborhood" type="search" maxlength="240" autocomplete="street-address" enterkeyhint="search" spellcheck="false" placeholder="${esc(GEOGRAPHY_SHELL_SEARCH_PLACEHOLDER)}" data-home-local-input>
          <button type="submit" data-home-local-submit>${esc(HOME_LOCAL_ENTRY_SUBMIT_LABEL)}</button>
        </div>
      </form>
      <div class="home-local-actions">
        <button type="button" class="home-local-location" data-home-local-location>${esc(GEOGRAPHY_SHELL_USE_LOCATION_LABEL)}</button>
        <span class="home-local-location-hint">${esc(HOME_LOCAL_ENTRY_LOCATION_HINT)}</span>
        <a class="home-local-browse" href="${esc(browseHref)}" data-home-local-browse>${esc(HOME_LOCAL_ENTRY_BROWSE_AREAS_LABEL)}</a>
      </div>
      <p class="home-local-status" data-home-local-status role="status" aria-live="polite"></p>
    </section>`;
}

async function loadDefaultAddressResolver() {
  const { resolveGeographyAddressEntry } = await import("./geography_address_entry.mjs");
  return resolveGeographyAddressEntry;
}

async function loadDefaultLayers({ fetchImpl = globalThis.fetch } = {}) {
  const response = await fetchImpl("/data/geography/layer_registry.json", {
    headers: { Accept: "application/json" },
  });
  if (!response?.ok) throw new Error("geography-registry-unavailable");
  const registry = await response.json();
  const layers = [];
  for (const type of GEOGRAPHY_NAVIGATION_LAYER_TYPES) {
    const url = simplifiedLayerSiteUrl(type, registry, { siteRoot: "/" });
    if (!url) continue;
    const layerResponse = await fetchImpl(url, { headers: { Accept: "application/json" } });
    if (!layerResponse?.ok) continue;
    const doc = loadCivicGeographyLayer(await layerResponse.json());
    if (doc) layers.push(doc);
  }
  if (!layers.length) throw new Error("geography-entry-layers-unavailable");
  return layers;
}

/**
 * Progressive-enhancement binder for the homepage place-entry panel.
 * Geolocation is requested only after the resident presses Use my location.
 */
export function mountHomeLocalEntry(root, {
  resolveQuery = null,
  resolveAddress = null,
  loadLayerData = null,
  layerData = null,
  geolocation = globalThis.navigator?.geolocation || null,
  location = globalThis.location,
  assign = null,
  fetchImpl = globalThis.fetch?.bind?.(globalThis) || globalThis.fetch,
  onResolved = null,
} = {}) {
  if (!root) return null;
  const panel = root.matches?.("[data-home-local-entry]")
    ? root
    : root.querySelector?.("[data-home-local-entry]");
  if (!panel) return null;

  const form = panel.querySelector("[data-home-local-form]");
  const input = panel.querySelector("[data-home-local-input]");
  const statusEl = panel.querySelector("[data-home-local-status]");
  const locationBtn = panel.querySelector("[data-home-local-location]");
  const locationHint = panel.querySelector(".home-local-location-hint");

  let busy = false;
  let current = null;
  let cachedLayers = Array.isArray(layerData) ? layerData : null;
  let addressResolverPromise = null;

  if (locationBtn) locationBtn.hidden = false;
  if (locationHint) locationHint.hidden = false;

  function setStatus(message, { refine = false } = {}) {
    if (!statusEl) return;
    statusEl.textContent = message || "";
    statusEl.hidden = !message;
    statusEl.dataset.refine = refine ? "true" : "false";
  }

  function navigate(href) {
    if (!href) return;
    if (typeof assign === "function") {
      assign(href);
      return;
    }
    if (typeof location?.assign === "function") {
      location.assign(href);
      return;
    }
    try {
      location.href = href;
    } catch {
      /* read-only location fakes in tests */
    }
  }

  async function layers() {
    if (cachedLayers?.length) return cachedLayers;
    if (typeof loadLayerData === "function") {
      cachedLayers = await loadLayerData();
      return cachedLayers;
    }
    cachedLayers = await loadDefaultLayers({ fetchImpl });
    return cachedLayers;
  }

  async function addressLookup() {
    if (typeof resolveAddress === "function") return resolveAddress;
    if (!addressResolverPromise) {
      addressResolverPromise = loadDefaultAddressResolver();
    }
    return addressResolverPromise;
  }

  async function resolveTyped(query) {
    if (typeof resolveQuery === "function") {
      return resolveQuery(query, { layerData: await layers() });
    }
    return resolveHomeLocalEntryQuery(query, {
      layerData: await layers(),
      resolveAddress: await addressLookup(),
    });
  }

  function applyResult(entry, { ephemeralPoint = null } = {}) {
    current = entry;
    if (!entry) {
      setStatus("");
      return entry;
    }
    if (!entry.ok) {
      const refine = entry.recovery?.reason === GEOGRAPHY_ENTRY_RECOVERY.AMBIGUOUS_ADDRESS
        || entry.recovery?.reason === GEOGRAPHY_ENTRY_RECOVERY.AMBIGUOUS_PLACE_LABEL
        || entry.recovery?.reason === GEOGRAPHY_ENTRY_RECOVERY.PARCEL_GEOGRAPHY_UNAVAILABLE;
      setStatus(entry.recovery?.message || geographyEntryRecoveryCopy(entry.recovery?.reason), { refine });
      if (refine && input) {
        input.focus({ preventScroll: true });
        if (typeof input.select === "function") input.select();
      }
      if (typeof onResolved === "function") onResolved({ entry, ephemeralPoint, href: null });
      return entry;
    }

    const href = homeLocalEntryNearYouHref(entry);
    if (!href || homeLocalEntryPayloadLeaksEphemeral(entry)) {
      setStatus(geographyEntryRecoveryCopy(GEOGRAPHY_ENTRY_RECOVERY.LOOKUP_FAILURE));
      return entry;
    }
    // Drop ephemeral coordinates before navigation; destination carries geography only.
    void ephemeralPoint;
    setStatus(`Opening ${entry.selected?.label || "your area"}…`);
    if (typeof onResolved === "function") onResolved({ entry, ephemeralPoint: null, href });
    navigate(href);
    return entry;
  }

  async function submitQuery(query) {
    if (busy) return current;
    busy = true;
    setStatus("Looking up that place…");
    try {
      const resolved = await resolveTyped(query);
      return applyResult(resolved.entry, { ephemeralPoint: resolved.ephemeralPoint });
    } catch {
      return applyResult({
        schema: "cityscroll.resident_geography_entry.v1",
        ok: false,
        source: GEOGRAPHY_ENTRY_SOURCES.ADDRESS,
        selected: null,
        selection: null,
        bundle: null,
        recovery: {
          reason: GEOGRAPHY_ENTRY_RECOVERY.LOOKUP_FAILURE,
          message: geographyEntryRecoveryCopy(GEOGRAPHY_ENTRY_RECOVERY.LOOKUP_FAILURE),
        },
      });
    } finally {
      busy = false;
    }
  }

  if (form) {
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      void submitQuery(input?.value || "");
    });
  }

  if (locationBtn) {
    locationBtn.addEventListener("click", () => {
      if (!geolocation || typeof geolocation.getCurrentPosition !== "function") {
        applyResult(resolveGeographyEntryFromGeolocationError({ code: 2 }));
        return;
      }
      locationBtn.disabled = true;
      setStatus("Finding your area…");
      geolocation.getCurrentPosition(async ({ coords }) => {
        try {
          const entry = resolveGeographyEntryFromGeolocation(
            coords.longitude,
            coords.latitude,
            { layerData: await layers() },
          );
          applyResult(entry);
        } catch {
          applyResult({
            schema: "cityscroll.resident_geography_entry.v1",
            ok: false,
            source: GEOGRAPHY_ENTRY_SOURCES.GEOLOCATION,
            selected: null,
            selection: null,
            bundle: null,
            recovery: {
              reason: GEOGRAPHY_ENTRY_RECOVERY.LOOKUP_FAILURE,
              message: geographyEntryRecoveryCopy(GEOGRAPHY_ENTRY_RECOVERY.LOOKUP_FAILURE),
            },
          });
        } finally {
          locationBtn.disabled = false;
        }
      }, (error) => {
        locationBtn.disabled = false;
        applyResult(resolveGeographyEntryFromGeolocationError(error));
      }, { enableHighAccuracy: false, timeout: 10000, maximumAge: 300000 });
    });
  }

  return Object.freeze({
    submitQuery,
    getResult: () => current,
    panel,
    serializeSelectionForHistory(entry) {
      if (!entry?.ok) return new URLSearchParams();
      return serializeGeographyNavigationState({
        ok: true,
        geo: entry.selection?.geo,
        key: entry.selection?.key,
        type: entry.selection?.type,
        id: entry.selection?.id,
        surface: GEOGRAPHY_NAVIGATION_SURFACE_MAP,
        lens: HOME_LOCAL_ENTRY_DEFAULT_LENS,
      });
    },
  });
}

export {
  GEOGRAPHY_SHELL_SEARCH_LABEL,
  GEOGRAPHY_SHELL_SEARCH_PLACEHOLDER,
  GEOGRAPHY_SHELL_USE_LOCATION_LABEL,
  esc,
};
