/**
 * Exact-address board choice for the community-boards directory.
 *
 * Reuses the local address→parcel geography adapter, then the unique published
 * covers resolver. Never derives an exact board from an NTA overlap. Address
 * text and coordinates stay ephemeral: share URLs carry only a selected board
 * hash (or an accepted area key from the neighborhood path).
 */

import { geocodeAddressText } from "./address_geocoder.mjs";
import { communityBoardPageHref } from "./community_board_links.mjs";
import { communityBoardIdFromCommunityDistrict } from "./community_board_geography.mjs";
import {
  createGeographyAddressEntryResolver,
} from "./geography_address_entry.mjs";
import {
  GEOGRAPHY_ENTRY_RECOVERY,
  GEOGRAPHY_ENTRY_SOURCES,
  geographyEntryPayloadLeaksEphemeral,
  geographyEntryPublicProjection,
  resolveGeographyEntryFromGeolocation,
  resolveGeographyEntryFromGeolocationError,
  resolveGeographyEntryFromPoint,
} from "./geography_navigation_entry.mjs";
import {
  GEOGRAPHY_NAVIGATION_EPHEMERAL_KEYS,
  omitGeographyNavigationEphemeral,
} from "./geography_navigation_state.mjs";
import { PARCEL_GEOGRAPHY_POINT_METHOD } from "./parcel_geography.mjs";

export const BOARD_EXACT_ADDRESS_SCHEMA = "cityscroll.board_exact_address.v1";

const clean = (value) => String(value ?? "").replace(/\s+/g, " ").trim();

const BOARD_ID_RE = /^([a-z]+(?:-[a-z]+)*)-cb-(\d{2})$/;
const BOROUGH_FROM_SLUG = Object.freeze({
  bronx: "Bronx",
  brooklyn: "Brooklyn",
  manhattan: "Manhattan",
  queens: "Queens",
  "staten-island": "Staten Island",
});

function boardDisplayNameFromId(boardId, boardNames = null) {
  const id = clean(boardId).toLowerCase();
  if (boardNames && typeof boardNames === "object" && boardNames[id]) {
    return clean(boardNames[id]);
  }
  const match = id.match(BOARD_ID_RE);
  if (!match) return null;
  const borough = BOROUGH_FROM_SLUG[match[1]] || null;
  const number = Number(match[2]);
  if (!borough || !Number.isInteger(number)) return null;
  return `${borough} Community Board ${number}`;
}

export const BOARD_EXACT_ADDRESS_RECOVERY = Object.freeze({
  EMPTY_QUERY: "empty_query",
  AMBIGUOUS_ADDRESS: "ambiguous_address",
  NO_RESULT: "no_result",
  LOOKUP_FAILURE: "lookup_failure",
  PARCEL_GEOGRAPHY_UNAVAILABLE: "parcel_geography_unavailable",
  CONFLICTING_DISTRICT: "conflicting_district",
  NO_PUBLISHED_BOARD: "no_published_board",
  GEOLOCATION_DENIED: "geolocation_denied",
  GEOLOCATION_UNAVAILABLE: "geolocation_unavailable",
  GEOLOCATION_TIMEOUT: "geolocation_timeout",
});

export const BOARD_EXACT_ADDRESS_RECOVERY_COPY = Object.freeze({
  [BOARD_EXACT_ADDRESS_RECOVERY.EMPTY_QUERY]:
    "Enter a street address to find the board for that place.",
  [BOARD_EXACT_ADDRESS_RECOVERY.AMBIGUOUS_ADDRESS]:
    "That address appears in more than one area. Add a borough or ZIP, or choose a neighborhood from the list.",
  [BOARD_EXACT_ADDRESS_RECOVERY.NO_RESULT]:
    "No matching address was found. Try another address or choose a neighborhood from the list.",
  [BOARD_EXACT_ADDRESS_RECOVERY.LOOKUP_FAILURE]:
    "The address lookup failed. Try again or choose a neighborhood from the list.",
  [BOARD_EXACT_ADDRESS_RECOVERY.PARCEL_GEOGRAPHY_UNAVAILABLE]:
    "That address was found, but its district map is not available yet. Refine the address or choose a neighborhood from the list.",
  [BOARD_EXACT_ADDRESS_RECOVERY.CONFLICTING_DISTRICT]:
    "That address sits on more than one district boundary in the stored map. Refine the address or choose a neighborhood from the list.",
  [BOARD_EXACT_ADDRESS_RECOVERY.NO_PUBLISHED_BOARD]:
    "No published community board covers that district. Choose a neighborhood from the list.",
  [BOARD_EXACT_ADDRESS_RECOVERY.GEOLOCATION_DENIED]:
    "Location permission was not granted. Typed address search and neighborhood choices stay available.",
  [BOARD_EXACT_ADDRESS_RECOVERY.GEOLOCATION_UNAVAILABLE]:
    "Location is not available in this browser. Typed address search and neighborhood choices stay available.",
  [BOARD_EXACT_ADDRESS_RECOVERY.GEOLOCATION_TIMEOUT]:
    "Location timed out. Try again, type an address, or choose a neighborhood from the list.",
});

const EPHEMERAL_SET = new Set([
  ...GEOGRAPHY_NAVIGATION_EPHEMERAL_KEYS,
  "bbl",
  "candidate_identities",
  "candidates",
  "ephemeralPoint",
  "ephemeral_point",
  "raw_address",
  "typed_address",
]);

function freezeDeep(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  if (Array.isArray(value)) {
    for (const entry of value) freezeDeep(entry);
    return Object.freeze(value);
  }
  for (const entry of Object.values(value)) freezeDeep(entry);
  return Object.freeze(value);
}

function esc(value) {
  return String(value ?? "").replace(/[<>&"']/g, (char) => ({
    "<": "&lt;",
    ">": "&gt;",
    "&": "&amp;",
    '"': "&quot;",
    "'": "&#39;",
  }[char]));
}

function recoveryFromEntryReason(reason) {
  switch (String(reason || "")) {
    case GEOGRAPHY_ENTRY_RECOVERY.EMPTY_QUERY:
      return BOARD_EXACT_ADDRESS_RECOVERY.EMPTY_QUERY;
    case GEOGRAPHY_ENTRY_RECOVERY.AMBIGUOUS_ADDRESS:
      return BOARD_EXACT_ADDRESS_RECOVERY.AMBIGUOUS_ADDRESS;
    case GEOGRAPHY_ENTRY_RECOVERY.NO_RESULT:
    case GEOGRAPHY_ENTRY_RECOVERY.OUTSIDE_COVERED_LAND:
      return BOARD_EXACT_ADDRESS_RECOVERY.NO_RESULT;
    case GEOGRAPHY_ENTRY_RECOVERY.PARCEL_GEOGRAPHY_UNAVAILABLE:
      return BOARD_EXACT_ADDRESS_RECOVERY.PARCEL_GEOGRAPHY_UNAVAILABLE;
    case GEOGRAPHY_ENTRY_RECOVERY.GEOLOCATION_DENIED:
      return BOARD_EXACT_ADDRESS_RECOVERY.GEOLOCATION_DENIED;
    case GEOGRAPHY_ENTRY_RECOVERY.GEOLOCATION_UNAVAILABLE:
      return BOARD_EXACT_ADDRESS_RECOVERY.GEOLOCATION_UNAVAILABLE;
    case GEOGRAPHY_ENTRY_RECOVERY.GEOLOCATION_TIMEOUT:
      return BOARD_EXACT_ADDRESS_RECOVERY.GEOLOCATION_TIMEOUT;
    default:
      return BOARD_EXACT_ADDRESS_RECOVERY.LOOKUP_FAILURE;
  }
}

export function boardExactAddressRecoveryCopy(reason) {
  const key = String(reason || "");
  return BOARD_EXACT_ADDRESS_RECOVERY_COPY[key]
    || BOARD_EXACT_ADDRESS_RECOVERY_COPY[BOARD_EXACT_ADDRESS_RECOVERY.LOOKUP_FAILURE];
}

function recoveryResult(reason, {
  source = GEOGRAPHY_ENTRY_SOURCES.ADDRESS,
  ambiguityCount = null,
  entryProjection = null,
} = {}) {
  const count = Number.isInteger(ambiguityCount) && ambiguityCount > 1
    ? ambiguityCount
    : null;
  return freezeDeep({
    schema: BOARD_EXACT_ADDRESS_SCHEMA,
    ok: false,
    source,
    board_id: null,
    board_name: null,
    district_id: null,
    nta_id: null,
    profile_href: null,
    share: null,
    place_details: null,
    ambiguity_count: count,
    recovery: Object.freeze({
      reason,
      message: boardExactAddressRecoveryCopy(reason),
      // Count only — never candidate identities or BBLs.
      ambiguity_count: count,
    }),
    entry_projection: entryProjection,
  });
}

/**
 * True when a URL/history/watch/analytics bag still carries ephemeral address
 * or coordinate material. Positive control: a bag that includes `address` or
 * `lat` must return true.
 */
export function boardExactAddressPayloadLeaksEphemeral(bag) {
  if (geographyEntryPayloadLeaksEphemeral(bag)) return true;
  if (!bag || typeof bag !== "object") return false;
  if (bag instanceof URLSearchParams) {
    for (const key of EPHEMERAL_SET) {
      if (bag.has(key)) return true;
    }
    return false;
  }
  for (const key of EPHEMERAL_SET) {
    if (Object.prototype.hasOwnProperty.call(bag, key)) return true;
  }
  const text = JSON.stringify(bag);
  if (/"(-?\d+\.\d+),\s*(-?\d+\.\d+)"/.test(text)) return true;
  if (/"bbl"\s*:/.test(text)) return true;
  return false;
}

/** Public projection safe for analytics/error reporting. */
export function boardExactAddressPublicProjection(result) {
  if (!result || typeof result !== "object") return Object.freeze({});
  return freezeDeep(omitGeographyNavigationEphemeral({
    schema: result.schema || BOARD_EXACT_ADDRESS_SCHEMA,
    ok: Boolean(result.ok),
    source: result.source || null,
    board_id: result.board_id || null,
    district_id: result.district_id || null,
    nta_id: result.nta_id || null,
    recovery_reason: result.recovery?.reason || null,
    ambiguity_count: Number.isInteger(result.ambiguity_count) ? result.ambiguity_count : null,
  }));
}

function communityDistrictRowsFromEntry(entry) {
  const rows = entry?.bundle?.by_type?.community_district;
  return Array.isArray(rows) ? rows.filter((row) => row?.id) : [];
}

/**
 * Turn a geography entry result (address or point) into a unique published
 * board choice via the covers ontology. Never falls back to an NTA overlap
 * board list.
 */
export function resolveExactBoardFromGeographyEntry(entry, {
  geographyLookup = null,
  boardNames = null,
  source = null,
  ambiguityCount = null,
} = {}) {
  const entrySource = source || entry?.source || GEOGRAPHY_ENTRY_SOURCES.ADDRESS;
  const projection = entry ? geographyEntryPublicProjection(entry) : null;

  if (!entry || typeof entry !== "object") {
    return recoveryResult(BOARD_EXACT_ADDRESS_RECOVERY.LOOKUP_FAILURE, {
      source: entrySource,
      entryProjection: projection,
    });
  }

  if (!entry.ok) {
    return recoveryResult(recoveryFromEntryReason(entry.recovery?.reason), {
      source: entrySource,
      ambiguityCount,
      entryProjection: projection,
    });
  }

  const districts = communityDistrictRowsFromEntry(entry);
  if (districts.length === 0) {
    return recoveryResult(BOARD_EXACT_ADDRESS_RECOVERY.PARCEL_GEOGRAPHY_UNAVAILABLE, {
      source: entrySource,
      entryProjection: projection,
    });
  }
  if (districts.length > 1) {
    return recoveryResult(BOARD_EXACT_ADDRESS_RECOVERY.CONFLICTING_DISTRICT, {
      source: entrySource,
      ambiguityCount: districts.length,
      entryProjection: projection,
    });
  }

  const districtId = clean(districts[0].id).toUpperCase();
  const boardId = communityBoardIdFromCommunityDistrict(districtId, geographyLookup);
  if (!boardId) {
    return recoveryResult(BOARD_EXACT_ADDRESS_RECOVERY.NO_PUBLISHED_BOARD, {
      source: entrySource,
      entryProjection: projection,
    });
  }

  const ntaRows = Array.isArray(entry.bundle?.by_type?.nta2020)
    ? entry.bundle.by_type.nta2020
    : [];
  const ntaId = entry.selected?.type === "nta2020"
    ? clean(entry.selected.id).toUpperCase()
    : (ntaRows.length === 1 ? clean(ntaRows[0].id).toUpperCase() : null);
  const boardName = boardDisplayNameFromId(boardId, boardNames) || boardId;
  const profileHref = communityBoardPageHref(boardId);
  const vintage = districts[0].boundary_vintage || null;
  const method = districts[0].method || null;

  return freezeDeep({
    schema: BOARD_EXACT_ADDRESS_SCHEMA,
    ok: true,
    source: entrySource,
    board_id: boardId,
    board_name: boardName,
    district_id: districtId,
    district_label: districts[0].label || districtId,
    nta_id: ntaId,
    nta_label: entry.selected?.type === "nta2020" ? (entry.selected.label || ntaId) : null,
    profile_href: profileHref,
    share: Object.freeze({
      // Board identity only — never address text or coordinates.
      hash: `#board-${boardId}`,
      board_id: boardId,
    }),
    place_details: Object.freeze({
      district_id: districtId,
      district_label: districts[0].label || districtId,
      nta_id: ntaId,
      nta_label: entry.selected?.type === "nta2020" ? (entry.selected.label || ntaId) : null,
      boundary_vintage: vintage,
      membership_method: method,
      point_method: method === "parcel_membership" ? PARCEL_GEOGRAPHY_POINT_METHOD : null,
    }),
    ambiguity_count: null,
    recovery: null,
    entry_projection: projection,
  });
}

/**
 * Build the directory exact-address resolver.
 *
 * @param {object} [options]
 * @param {(query: string, opts?: object) => Promise<{entry: object, ephemeralPoint?: object|null}>} [options.resolveAddressEntry]
 * @param {object} [options.geographyLookup] community_board_geography.v1 lookup
 * @param {Record<string, string>} [options.boardNames]
 * @param {object[]} [options.layerData]
 */
export function createBoardExactAddressResolver({
  resolveAddressEntry = null,
  geographyLookup = null,
  boardNames = null,
  layerData = [],
  geocode = undefined,
  loadParcelShard = undefined,
  fetchImpl = undefined,
  parcelManifestUrl = undefined,
} = {}) {
  const padGeocode = typeof geocode === "function" ? geocode : geocodeAddressText;
  const addressResolver = typeof resolveAddressEntry === "function"
    ? resolveAddressEntry
    : createGeographyAddressEntryResolver({
      geocode: padGeocode,
      ...(loadParcelShard !== undefined ? { loadParcelShard } : {}),
      ...(fetchImpl !== undefined ? { fetchImpl } : {}),
      ...(parcelManifestUrl !== undefined ? { parcelManifestUrl } : {}),
    });

  return async function resolveBoardExactAddress(query, {
    layerData: layers = layerData,
    source = GEOGRAPHY_ENTRY_SOURCES.ADDRESS,
  } = {}) {
    const text = clean(query);
    if (!text) {
      return recoveryResult(BOARD_EXACT_ADDRESS_RECOVERY.EMPTY_QUERY, { source });
    }

    // PAD exposes an ambiguity count without candidate identities.
    if (typeof resolveAddressEntry !== "function") {
      try {
        const pad = await padGeocode(text);
        if (pad?.status === "unknown" && pad?.reason === "ambiguous") {
          const count = Number.isInteger(pad.candidate_count) ? pad.candidate_count : null;
          return recoveryResult(BOARD_EXACT_ADDRESS_RECOVERY.AMBIGUOUS_ADDRESS, {
            source,
            ambiguityCount: count,
          });
        }
      } catch {
        /* fall through to the shared address entry path */
      }
    }

    let resolved = null;
    try {
      resolved = await addressResolver(text, { layerData: layers, source });
    } catch {
      return recoveryResult(BOARD_EXACT_ADDRESS_RECOVERY.LOOKUP_FAILURE, { source });
    }

    const entry = resolved?.entry || resolved;
    const ambiguityCount = Number.isInteger(resolved?.ambiguity_count)
      ? resolved.ambiguity_count
      : (Number.isInteger(entry?.recovery?.ambiguity_count) ? entry.recovery.ambiguity_count : null);

    return resolveExactBoardFromGeographyEntry(entry, {
      geographyLookup,
      boardNames,
      source,
      ambiguityCount,
    });
  };
}

/** Resolve a device point through geography entry, then the unique board covers edge. */
export function resolveExactBoardFromPoint(lon, lat, {
  layerData = [],
  geographyLookup = null,
  boardNames = null,
  source = GEOGRAPHY_ENTRY_SOURCES.GEOLOCATION,
} = {}) {
  const entry = resolveGeographyEntryFromPoint(lon, lat, { layerData, source });
  return resolveExactBoardFromGeographyEntry(entry, {
    geographyLookup,
    boardNames,
    source,
  });
}

export function resolveExactBoardFromGeolocation(lon, lat, options = {}) {
  const entry = resolveGeographyEntryFromGeolocation(lon, lat, options);
  return resolveExactBoardFromGeographyEntry(entry, {
    geographyLookup: options.geographyLookup,
    boardNames: options.boardNames,
    source: GEOGRAPHY_ENTRY_SOURCES.GEOLOCATION,
  });
}

export function resolveExactBoardFromGeolocationError(error, options = {}) {
  const entry = resolveGeographyEntryFromGeolocationError(error, options);
  return resolveExactBoardFromGeographyEntry(entry, {
    geographyLookup: options.geographyLookup,
    boardNames: options.boardNames,
    source: GEOGRAPHY_ENTRY_SOURCES.GEOLOCATION,
  });
}

/** Server/no-JS markup for the exact-address panel (opened by the address action). */
export function renderBoardExactAddressPanelHtml() {
  return `<section class="scorecard-neighborhood-address" id="board-neighborhood-address" data-board-neighborhood-address hidden>
      <h3>Find the board for a specific address</h3>
      <p class="scorecard-muted">Uses the local address directory and stored district memberships. Neighborhood choices stay available when an address cannot be resolved exactly.</p>
      <form class="scorecard-exact-address-form" data-board-exact-address-form action="/community-boards/" method="get">
        <label for="scorecard-exact-address-input">Street address</label>
        <div class="scorecard-exact-address-form-row">
          <input id="scorecard-exact-address-input" name="address_lookup" type="search" autocomplete="street-address" inputmode="text" spellcheck="false" data-board-exact-address-input placeholder="e.g. house number and street, borough or ZIP">
          <button type="submit" data-board-exact-address-submit>Find board</button>
        </div>
      </form>
      <p class="scorecard-exact-address-location-row">
        <button type="button" class="scorecard-exact-address-location" data-board-exact-address-location>Use my location</button>
        <span class="scorecard-muted">Asked only when you press the button.</span>
      </p>
      <div class="scorecard-exact-address-status" data-board-exact-address-status role="status" aria-live="polite"></div>
      <div class="scorecard-exact-address-result" data-board-exact-address-result hidden></div>
      <p class="scorecard-exact-address-actions">
        <button type="button" class="scorecard-exact-address-clear" data-board-exact-address-clear hidden>Clear address result</button>
        <a class="scorecard-exact-address-back" data-board-exact-address-back href="#scorecard-neighborhood-heading">Back to neighborhood choices</a>
      </p>
    </section>`;
}

function renderExactBoardChoiceHtml(result) {
  if (!result?.ok) return "";
  const profile = result.profile_href
    ? `<a class="scorecard-neighborhood-choice-profile" href="${esc(result.profile_href)}">Open board profile</a>`
    : "";
  const details = result.place_details
    ? `<details class="scorecard-exact-address-details">
        <summary>Place details</summary>
        <ul>
          <li>District ${esc(result.place_details.district_id)}${result.place_details.district_label ? ` · ${esc(result.place_details.district_label)}` : ""}</li>
          ${result.place_details.nta_id ? `<li>Neighborhood area ${esc(result.place_details.nta_id)}${result.place_details.nta_label ? ` · ${esc(result.place_details.nta_label)}` : ""}</li>` : ""}
          ${result.place_details.boundary_vintage ? `<li>Boundary vintage ${esc(result.place_details.boundary_vintage)}</li>` : ""}
          ${result.place_details.membership_method ? `<li>Membership ${esc(result.place_details.membership_method)}</li>` : ""}
        </ul>
      </details>`
    : "";
  return `<div class="scorecard-exact-address-choice" data-board-exact-address-choice="${esc(result.board_id)}" data-district-id="${esc(result.district_id || "")}">
      <p class="scorecard-exact-address-choice-kicker">Exact board for this address</p>
      <a class="scorecard-neighborhood-choice-name" href="${esc(result.share?.hash || `#board-${result.board_id}`)}" data-board-exact-address-select="${esc(result.board_id)}">${esc(result.board_name)}</a>
      <span class="scorecard-neighborhood-choice-district">District ${esc(result.district_id || "")}</span>
      ${profile}
      ${details}
    </div>`;
}

/**
 * Progressive-enhancement binder for the exact-address panel.
 * Geolocation runs only after an explicit button press.
 */
export function mountBoardExactAddress(root, {
  resolveAddress = null,
  geographyLookup = null,
  boardNames = null,
  layerData = [],
  loadLayerData = null,
  location = globalThis.location,
  history = globalThis.history,
  geolocation = globalThis.navigator?.geolocation || null,
  onExactBoard = null,
  onClear = null,
} = {}) {
  if (!root) return null;
  const panel = root.querySelector("[data-board-neighborhood-address]");
  if (!panel) return null;

  const form = panel.querySelector("[data-board-exact-address-form]");
  const input = panel.querySelector("[data-board-exact-address-input]");
  const statusEl = panel.querySelector("[data-board-exact-address-status]");
  const resultEl = panel.querySelector("[data-board-exact-address-result]");
  const clearBtn = panel.querySelector("[data-board-exact-address-clear]");
  const backLink = panel.querySelector("[data-board-exact-address-back]");
  const locationBtn = panel.querySelector("[data-board-exact-address-location]");

  let current = null;
  let busy = false;

  const resolver = typeof resolveAddress === "function"
    ? resolveAddress
    : createBoardExactAddressResolver({ geographyLookup, boardNames, layerData });

  function setStatus(message, { refine = false } = {}) {
    if (!statusEl) return;
    statusEl.textContent = message || "";
    statusEl.hidden = !message;
    statusEl.dataset.refine = refine ? "true" : "false";
  }

  function writeBoardShare(boardId) {
    const url = new URL(
      location.href || `${location.origin || "https://cityscroll.org"}${location.pathname || "/community-boards/"}${location.search || ""}`,
      "https://cityscroll.org",
    );
    // Exact choice shares board identity only.
    url.searchParams.delete("address");
    url.searchParams.delete("address_lookup");
    url.searchParams.delete("lat");
    url.searchParams.delete("lon");
    url.searchParams.delete("lng");
    const next = `${url.pathname}${url.search}#board-${boardId}`;
    if (history?.replaceState) history.replaceState(null, "", next);
    try {
      if (location.hash !== undefined) location.hash = `#board-${boardId}`;
    } catch {
      /* read-only location fakes */
    }
  }

  function renderResult(result) {
    current = result;
    if (!resultEl) return;
    if (!result) {
      resultEl.hidden = true;
      resultEl.innerHTML = "";
      if (clearBtn) clearBtn.hidden = true;
      return;
    }
    if (!result.ok) {
      resultEl.hidden = true;
      resultEl.innerHTML = "";
      const refine = result.recovery?.reason === BOARD_EXACT_ADDRESS_RECOVERY.AMBIGUOUS_ADDRESS
        || result.recovery?.reason === BOARD_EXACT_ADDRESS_RECOVERY.PARCEL_GEOGRAPHY_UNAVAILABLE
        || result.recovery?.reason === BOARD_EXACT_ADDRESS_RECOVERY.CONFLICTING_DISTRICT;
      setStatus(result.recovery?.message || boardExactAddressRecoveryCopy(result.recovery?.reason), { refine });
      if (clearBtn) clearBtn.hidden = false;
      if (refine && input) {
        input.focus({ preventScroll: true });
        if (typeof input.select === "function") input.select();
      }
      return;
    }
    setStatus("");
    resultEl.hidden = false;
    resultEl.innerHTML = renderExactBoardChoiceHtml(result);
    if (clearBtn) clearBtn.hidden = false;
    writeBoardShare(result.board_id);
    if (typeof onExactBoard === "function") onExactBoard(result);
  }

  function openPanel({ focus = true } = {}) {
    panel.hidden = false;
    if (focus && input) input.focus({ preventScroll: true });
  }

  function closePanel() {
    panel.hidden = true;
  }

  async function layers() {
    if (typeof loadLayerData === "function") {
      try {
        return await loadLayerData();
      } catch {
        return layerData;
      }
    }
    return layerData;
  }

  async function submitAddress(query) {
    if (busy) return current;
    busy = true;
    setStatus("Looking up that address…");
    try {
      const result = await resolver(query, { layerData: await layers() });
      renderResult(result);
      return result;
    } catch {
      const failed = recoveryResult(BOARD_EXACT_ADDRESS_RECOVERY.LOOKUP_FAILURE);
      renderResult(failed);
      return failed;
    } finally {
      busy = false;
    }
  }

  function clearResult({ close = false } = {}) {
    current = null;
    if (input) input.value = "";
    setStatus("");
    renderResult(null);
    if (close) closePanel();
    if (typeof onClear === "function") onClear();
  }

  if (form) {
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      submitAddress(input?.value || "");
    });
  }

  if (locationBtn) {
    locationBtn.addEventListener("click", () => {
      if (!geolocation || typeof geolocation.getCurrentPosition !== "function") {
        renderResult(resolveExactBoardFromGeolocationError(
          { code: 2 },
          { geographyLookup, boardNames },
        ));
        return;
      }
      locationBtn.disabled = true;
      setStatus("Finding your location…");
      geolocation.getCurrentPosition(async ({ coords }) => {
        try {
          const result = resolveExactBoardFromGeolocation(
            coords.longitude,
            coords.latitude,
            {
              layerData: await layers(),
              geographyLookup,
              boardNames,
            },
          );
          renderResult(result);
        } catch {
          renderResult(recoveryResult(BOARD_EXACT_ADDRESS_RECOVERY.LOOKUP_FAILURE, {
            source: GEOGRAPHY_ENTRY_SOURCES.GEOLOCATION,
          }));
        } finally {
          locationBtn.disabled = false;
        }
      }, (error) => {
        locationBtn.disabled = false;
        renderResult(resolveExactBoardFromGeolocationError(error, {
          geographyLookup,
          boardNames,
        }));
      }, { enableHighAccuracy: false, timeout: 10000, maximumAge: 300000 });
    });
  }

  if (clearBtn) {
    clearBtn.addEventListener("click", (event) => {
      event.preventDefault();
      clearResult({ close: false });
    });
  }

  if (backLink) {
    backLink.addEventListener("click", (event) => {
      event.preventDefault();
      clearResult({ close: true });
      const heading = root.querySelector("#scorecard-neighborhood-heading");
      if (heading && typeof heading.focus === "function") {
        heading.setAttribute("tabindex", "-1");
        heading.focus({ preventScroll: true });
      }
    });
  }

  root.addEventListener("click", (event) => {
    const action = event.target.closest?.("[data-board-address-action]");
    if (!action) return;
    event.preventDefault();
    openPanel({ focus: true });
  });

  // Deep-link: open when the hash already names the address panel.
  if (String(location.hash || "") === "#board-neighborhood-address") {
    openPanel({ focus: false });
  }

  return Object.freeze({
    open: openPanel,
    close: closePanel,
    submitAddress,
    clear: clearResult,
    getResult: () => current,
    panel,
  });
}

export {
  esc,
  renderExactBoardChoiceHtml,
};
