/**
 * Durable Near You geography selection URL state.
 *
 * One normalized geography key is the shared identity for server links, browser
 * history, map selection, and record queries. This module is pure: it parses,
 * normalizes, and serializes selection, comparison layer, surface, drawer,
 * focus, and record lens; it forwards supported legacy map hashes; and it
 * never writes coordinates, address text, hover state, or viewport micro-position.
 */

import {
  GEOGRAPHY_NAVIGATION_LAYER_TYPES,
  resolveGeographyNavigationKey,
} from "./geography_navigation_capability.mjs";
import {
  NEAR_YOU_COMMON_LENSES,
  nearYouUrlFromScope,
  scopeFromRouteHash,
  scopeWithGeographies,
} from "./scope_v0.mjs";
import { nearYouUrlFromMapHash } from "./near_you_scope_runtime.mjs";

export const GEOGRAPHY_NAVIGATION_STATE_SCHEMA = "cityscroll.resident_geography_state.v1";

export const GEOGRAPHY_NAVIGATION_GEO_PARAM = "geo";
export const GEOGRAPHY_NAVIGATION_COMPARE_PARAM = "compare";
export const GEOGRAPHY_NAVIGATION_SURFACE_PARAM = "surface";
export const GEOGRAPHY_NAVIGATION_DRAWER_PARAM = "drawer";
export const GEOGRAPHY_NAVIGATION_FOCUS_PARAM = "focus";
export const GEOGRAPHY_NAVIGATION_LENS_PARAM = "lens";

export const GEOGRAPHY_NAVIGATION_SURFACE_MAP = "map";
export const GEOGRAPHY_NAVIGATION_SURFACE_RECORDS = "records";
export const GEOGRAPHY_NAVIGATION_SURFACES = Object.freeze([
  GEOGRAPHY_NAVIGATION_SURFACE_MAP,
  GEOGRAPHY_NAVIGATION_SURFACE_RECORDS,
]);
export const GEOGRAPHY_NAVIGATION_DEFAULT_SURFACE = GEOGRAPHY_NAVIGATION_SURFACE_MAP;

export const GEOGRAPHY_NAVIGATION_DRAWER_OPEN = "open";
export const GEOGRAPHY_NAVIGATION_DRAWER_CLOSED = "closed";
export const GEOGRAPHY_NAVIGATION_DRAWERS = Object.freeze([
  GEOGRAPHY_NAVIGATION_DRAWER_OPEN,
  GEOGRAPHY_NAVIGATION_DRAWER_CLOSED,
]);

/** Presentation/selection keys owned by this grammar. */
export const GEOGRAPHY_NAVIGATION_STATE_KEYS = Object.freeze([
  GEOGRAPHY_NAVIGATION_GEO_PARAM,
  GEOGRAPHY_NAVIGATION_COMPARE_PARAM,
  GEOGRAPHY_NAVIGATION_SURFACE_PARAM,
  GEOGRAPHY_NAVIGATION_DRAWER_PARAM,
  GEOGRAPHY_NAVIGATION_FOCUS_PARAM,
  GEOGRAPHY_NAVIGATION_LENS_PARAM,
]);

/**
 * Keys that may never enter a durable URL, storage bag, or analytics payload.
 * Coordinates and address text stay ephemeral so navigation cannot leak location.
 */
export const GEOGRAPHY_NAVIGATION_EPHEMERAL_KEYS = Object.freeze([
  "lat",
  "lng",
  "lon",
  "latitude",
  "longitude",
  "coords",
  "coordinates",
  "address",
  "address_text",
  "query_address",
  "geocode",
  "geocoder",
  "hover",
  "hover_id",
  "viewport",
  "view_box",
  "viewBox",
  "center",
  "zoom",
  "pitch",
  "bearing",
  "accuracy",
  "altitude",
]);

export const GEOGRAPHY_NAVIGATION_RECOVERY_REASONS = Object.freeze({
  MISSING: "missing_geography_key",
  MALFORMED: "malformed_geography_key",
  UNKNOWN_LAYER: "layer_not_in_first_slice",
  INVALID_ID: "invalid_geography_id",
  UNKNOWN_COMPARE: "unknown_comparison_layer",
  UNSUPPORTED_LEGACY: "unsupported_legacy_state",
});

const LAYER_SET = new Set(GEOGRAPHY_NAVIGATION_LAYER_TYPES);
const SURFACE_SET = new Set(GEOGRAPHY_NAVIGATION_SURFACES);
const DRAWER_SET = new Set(GEOGRAPHY_NAVIGATION_DRAWERS);
const LENS_SET = new Set(NEAR_YOU_COMMON_LENSES);
const EPHEMERAL_SET = new Set(GEOGRAPHY_NAVIGATION_EPHEMERAL_KEYS);

const STATIC_NEAR_YOU_PATH = /^\/near-you\/(?:(?:lens\/[a-z]+\/)|(?:borough\/[a-z0-9-]+\/(?:[a-z]+\/)?))?$/i;

function emptyState(overrides = {}) {
  return Object.freeze({
    schema: GEOGRAPHY_NAVIGATION_STATE_SCHEMA,
    ok: overrides.ok !== false && !overrides.recovery,
    geo: overrides.geo ?? null,
    key: overrides.key ?? null,
    type: overrides.type ?? null,
    id: overrides.id ?? null,
    compare: overrides.compare ?? null,
    surface: overrides.surface ?? GEOGRAPHY_NAVIGATION_DEFAULT_SURFACE,
    drawer: overrides.drawer ?? null,
    focus: overrides.focus ?? null,
    lens: overrides.lens ?? null,
    recovery: overrides.recovery ?? null,
    source: overrides.source ?? "enhanced",
    static_path: overrides.static_path ?? null,
  });
}

function recoveryState(reason, explanation, extras = {}) {
  return emptyState({
    ok: false,
    recovery: Object.freeze({ reason, explanation }),
    surface: extras.surface ?? GEOGRAPHY_NAVIGATION_DEFAULT_SURFACE,
    drawer: extras.drawer ?? null,
    focus: extras.focus ?? null,
    lens: extras.lens ?? null,
    source: extras.source ?? "enhanced",
    static_path: extras.static_path ?? null,
  });
}

function searchParams(input) {
  if (input instanceof URLSearchParams) return new URLSearchParams(input);
  if (input instanceof URL) return new URLSearchParams(input.search);
  if (input && typeof input === "object" && !Array.isArray(input)) {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(input)) {
      if (value == null) continue;
      if (Array.isArray(value)) {
        for (const entry of value) params.append(key, String(entry));
      } else {
        params.append(key, String(value));
      }
    }
    return params;
  }
  const text = String(input ?? "");
  if (/^[a-z][a-z\d+.-]*:\/\//i.test(text) || text.startsWith("/")) {
    try {
      return new URL(text, "https://cityscroll.invalid").searchParams;
    } catch {
      return new URLSearchParams();
    }
  }
  return new URLSearchParams(text.replace(/^[?#]/, ""));
}

function firstParam(params, name) {
  const values = params.getAll(name);
  if (!values.length) return null;
  const raw = String(values[0] ?? "").trim();
  return raw || null;
}

function normalizeSurface(value) {
  const candidate = String(value ?? "").trim().toLowerCase();
  return SURFACE_SET.has(candidate) ? candidate : GEOGRAPHY_NAVIGATION_DEFAULT_SURFACE;
}

function normalizeDrawer(value) {
  const candidate = String(value ?? "").trim().toLowerCase();
  return DRAWER_SET.has(candidate) ? candidate : null;
}

function normalizeLens(value) {
  const candidate = String(value ?? "").trim().toLowerCase();
  return LENS_SET.has(candidate) ? candidate : null;
}

function normalizeFocus(value) {
  const text = String(value ?? "").trim();
  if (!text || text.length > 120) return null;
  if (/[<>"'\s]/.test(text)) return null;
  return text;
}

function normalizeCompare(value, selectedType = null) {
  const candidate = String(value ?? "").trim();
  if (!candidate) return { ok: true, compare: null, recovery: null };
  if (!LAYER_SET.has(candidate)) {
    return {
      ok: false,
      compare: null,
      recovery: {
        reason: GEOGRAPHY_NAVIGATION_RECOVERY_REASONS.UNKNOWN_COMPARE,
        explanation: "That comparison layer is not part of the resident navigation switcher.",
      },
    };
  }
  if (selectedType && candidate === selectedType) {
    return { ok: true, compare: null, recovery: null };
  }
  return { ok: true, compare: candidate, recovery: null };
}

/** Short public selection token (`nta2020:BK1503`) derived from a resolved key. */
export function geographyNavigationSelectionToken(resolved) {
  if (!resolved?.ok || !resolved.type || !resolved.id) return null;
  return `${resolved.type}:${resolved.id}`;
}

/**
 * Resolve one geo parameter value. Accepts short `type:id` and full
 * `geography:type:id` forms; only first-slice types with valid ids succeed.
 */
export function resolveGeographyNavigationSelection(raw) {
  return resolveGeographyNavigationKey(raw);
}

function selectionFromParams(params) {
  const raw = firstParam(params, GEOGRAPHY_NAVIGATION_GEO_PARAM);
  if (!raw) {
    return { ok: true, resolved: null, recovery: null };
  }
  const resolved = resolveGeographyNavigationKey(raw);
  if (!resolved.ok) {
    return {
      ok: false,
      resolved: null,
      recovery: {
        reason: resolved.reason || GEOGRAPHY_NAVIGATION_RECOVERY_REASONS.MALFORMED,
        explanation: resolved.explanation
          || "That geography key is not recognized, so the navigator stays unselected.",
      },
    };
  }
  return { ok: true, resolved, recovery: null };
}

/**
 * Parse Near You geography navigation state from a URL, search string, or
 * parameter bag. Duplicate params keep the first value. Ephemeral keys are
 * ignored and never round-tripped.
 */
export function parseGeographyNavigationState(input) {
  const params = searchParams(input);
  const surface = normalizeSurface(firstParam(params, GEOGRAPHY_NAVIGATION_SURFACE_PARAM));
  const drawer = normalizeDrawer(firstParam(params, GEOGRAPHY_NAVIGATION_DRAWER_PARAM));
  const focus = normalizeFocus(firstParam(params, GEOGRAPHY_NAVIGATION_FOCUS_PARAM));
  const lens = normalizeLens(firstParam(params, GEOGRAPHY_NAVIGATION_LENS_PARAM));
  const selection = selectionFromParams(params);
  if (!selection.ok) {
    return recoveryState(selection.recovery.reason, selection.recovery.explanation, {
      surface,
      drawer,
      focus,
      lens,
    });
  }
  const compare = normalizeCompare(
    firstParam(params, GEOGRAPHY_NAVIGATION_COMPARE_PARAM),
    selection.resolved?.type || null,
  );
  if (!compare.ok) {
    return recoveryState(compare.recovery.reason, compare.recovery.explanation, {
      surface,
      drawer,
      focus,
      lens,
    });
  }
  if (!selection.resolved) {
    return emptyState({ surface, drawer, focus, lens, compare: compare.compare });
  }
  return emptyState({
    geo: geographyNavigationSelectionToken(selection.resolved),
    key: selection.resolved.key,
    type: selection.resolved.type,
    id: selection.resolved.id,
    compare: compare.compare,
    surface,
    drawer,
    focus,
    lens,
  });
}

/**
 * Serialize canonical enhanced state into query params. Defaults are omitted
 * where silence preserves the ordinary enhanced entry. Ephemeral keys never appear.
 */
export function serializeGeographyNavigationState(state = {}, { includeDefaults = false } = {}) {
  const parsed = state && typeof state === "object" && state.schema === GEOGRAPHY_NAVIGATION_STATE_SCHEMA
    ? state
    : parseGeographyNavigationState(state);
  const params = new URLSearchParams();
  if (parsed.ok && parsed.geo) params.set(GEOGRAPHY_NAVIGATION_GEO_PARAM, parsed.geo);
  if (parsed.ok && parsed.compare) params.set(GEOGRAPHY_NAVIGATION_COMPARE_PARAM, parsed.compare);
  const surface = normalizeSurface(parsed.surface);
  if (includeDefaults || surface !== GEOGRAPHY_NAVIGATION_DEFAULT_SURFACE) {
    params.set(GEOGRAPHY_NAVIGATION_SURFACE_PARAM, surface);
  }
  if (parsed.drawer) params.set(GEOGRAPHY_NAVIGATION_DRAWER_PARAM, parsed.drawer);
  if (parsed.focus) params.set(GEOGRAPHY_NAVIGATION_FOCUS_PARAM, parsed.focus);
  if (parsed.lens) params.set(GEOGRAPHY_NAVIGATION_LENS_PARAM, parsed.lens);
  for (const key of GEOGRAPHY_NAVIGATION_EPHEMERAL_KEYS) params.delete(key);
  return params;
}

/** Build a Near You path+query from canonical state. */
export function geographyNavigationUrlFromState(state = {}, { base = "/near-you/" } = {}) {
  const absolute = /^[a-z][a-z\d+.-]*:\/\//i.test(base);
  const url = new URL(base, "https://cityscroll.invalid");
  const params = serializeGeographyNavigationState(state, {
    includeDefaults: Boolean(state?.geo) || Boolean(state?.compare) || Boolean(state?.lens)
      || Boolean(state?.drawer) || Boolean(state?.focus)
      || (state?.surface && state.surface !== GEOGRAPHY_NAVIGATION_DEFAULT_SURFACE),
  });
  // Always emit surface when a selection is present so shared links keep Map/Records.
  if (state?.ok !== false && (state?.geo || state?.key) && !params.has(GEOGRAPHY_NAVIGATION_SURFACE_PARAM)) {
    params.set(GEOGRAPHY_NAVIGATION_SURFACE_PARAM, normalizeSurface(state.surface));
  }
  url.search = "";
  for (const [key, value] of params.entries()) url.searchParams.append(key, value);
  return absolute ? url.toString() : `${url.pathname}${url.search}`;
}

/**
 * Round-trip helper used by share/refresh tests: parse then serialize to the
 * canonical enhanced URL form.
 */
export function canonicalizeGeographyNavigationUrl(input, { base = "/near-you/" } = {}) {
  const state = parseGeographyNavigationState(input);
  return geographyNavigationUrlFromState(state, { base });
}

/** True when a path is a server-rendered Near You static area/lens document. */
export function isStaticNearYouPath(pathname) {
  const path = String(pathname || "").split("?")[0] || "";
  const normalized = path.endsWith("/") || path === "/near-you" ? path : `${path}/`;
  if (normalized === "/near-you/") return true;
  return STATIC_NEAR_YOU_PATH.test(normalized);
}

/**
 * One-way compatibility adapter for legacy `#map?...` hashes.
 * Supported hashes become enhanced state; unsupported or empty hashes recover
 * to the unselected navigator without inventing a selection.
 */
export function geographyNavigationStateFromLegacyMapHash(hash, { lens = null } = {}) {
  const raw = String(hash || "");
  if (!/^#map(?:\?|$)/.test(raw)) {
    return recoveryState(
      GEOGRAPHY_NAVIGATION_RECOVERY_REASONS.UNSUPPORTED_LEGACY,
      "That map link is not a supported geography selection.",
      { lens: normalizeLens(lens), source: "legacy_map_hash" },
    );
  }
  if (raw === "#map" || raw === "#map?") {
    return emptyState({
      lens: normalizeLens(lens),
      source: "legacy_map_hash",
      surface: GEOGRAPHY_NAVIGATION_DEFAULT_SURFACE,
    });
  }

  const href = nearYouUrlFromMapHash(raw, { base: "/near-you/" });
  if (!href) {
    return recoveryState(
      GEOGRAPHY_NAVIGATION_RECOVERY_REASONS.UNSUPPORTED_LEGACY,
      "That map link could not be converted, so the navigator stays unselected.",
      { lens: normalizeLens(lens), source: "legacy_map_hash" },
    );
  }

  const legacyUrl = new URL(href, "https://cityscroll.invalid");
  const legacyParams = legacyUrl.searchParams;
  const level = String(legacyParams.get("level") || "").trim();
  const id = String(legacyParams.get("id") || "").trim();
  const inheritedLens = normalizeLens(legacyParams.get("lens") || lens);

  let geoRaw = null;
  if (level && id && LAYER_SET.has(level)) {
    geoRaw = `${level}:${id}`;
  } else if (legacyParams.get("cd") && LAYER_SET.has("community_district")) {
    geoRaw = `community_district:${legacyParams.get("cd")}`;
  } else if (legacyParams.get("council") && LAYER_SET.has("council_district")) {
    geoRaw = `council_district:${legacyParams.get("council")}`;
  }

  if (!geoRaw) {
    // Borough-only or bag-only legacy hashes stay unselected in the enhanced
    // grammar; the existing static/common Near You documents remain the destination.
    return emptyState({
      lens: inheritedLens,
      source: "legacy_map_hash",
      surface: GEOGRAPHY_NAVIGATION_DEFAULT_SURFACE,
    });
  }

  const resolved = resolveGeographyNavigationKey(geoRaw);
  if (!resolved.ok) {
    return recoveryState(
      resolved.reason || GEOGRAPHY_NAVIGATION_RECOVERY_REASONS.INVALID_ID,
      resolved.explanation
        || "That geography id is not valid for its layer, so the navigator stays unselected.",
      { lens: inheritedLens, source: "legacy_map_hash" },
    );
  }

  return emptyState({
    geo: geographyNavigationSelectionToken(resolved),
    key: resolved.key,
    type: resolved.type,
    id: resolved.id,
    lens: inheritedLens,
    surface: GEOGRAPHY_NAVIGATION_DEFAULT_SURFACE,
    source: "legacy_map_hash",
  });
}

/**
 * Describe a static Near You path without rewriting it into enhanced query
 * state. Server documents stay the no-JavaScript destination.
 */
export function geographyNavigationStateFromStaticPath(input) {
  const url = input instanceof URL
    ? input
    : new URL(String(input || "/near-you/"), "https://cityscroll.invalid");
  if (!isStaticNearYouPath(url.pathname)) {
    return recoveryState(
      GEOGRAPHY_NAVIGATION_RECOVERY_REASONS.UNSUPPORTED_LEGACY,
      "That Near You path is not a recognized static area link.",
      { source: "static_path" },
    );
  }
  const parts = url.pathname.replace(/\/+$/, "").split("/").filter(Boolean);
  let lens = null;
  if (parts[1] === "lens" && parts[2]) lens = normalizeLens(parts[2]);
  if (parts[1] === "borough" && parts[3]) lens = normalizeLens(parts[3]);
  return emptyState({
    source: "static_path",
    static_path: `${url.pathname.endsWith("/") ? url.pathname : `${url.pathname}/`}`,
    lens,
    surface: GEOGRAPHY_NAVIGATION_DEFAULT_SURFACE,
  });
}

/**
 * Apply selection to an existing scope without changing record membership.
 * The URL only names an already materialized geography key.
 */
export function scopeWithGeographyNavigationState(input, state) {
  const parsed = state && state.schema === GEOGRAPHY_NAVIGATION_STATE_SCHEMA
    ? state
    : parseGeographyNavigationState(state || {});
  const scope = scopeWithGeographies(input, parsed.ok && parsed.key ? [parsed.key] : []);
  if (parsed.lens && Array.isArray(scope.facets?.domains)) {
    return {
      ...scope,
      facets: {
        ...scope.facets,
        domains: [parsed.lens],
      },
    };
  }
  return scope;
}

/** Strip ephemeral keys from a candidate URL/storage/analytics bag. */
export function omitGeographyNavigationEphemeral(values) {
  const source = values && typeof values === "object" && !Array.isArray(values) ? values : {};
  const kept = {};
  for (const [key, value] of Object.entries(source)) {
    if (EPHEMERAL_SET.has(key)) continue;
    kept[key] = value;
  }
  return kept;
}

/** True when a bag still carries a forbidden ephemeral key. */
export function geographyNavigationPayloadLeaksEphemeral(values) {
  if (values instanceof URLSearchParams) {
    return GEOGRAPHY_NAVIGATION_EPHEMERAL_KEYS.some((key) => values.has(key));
  }
  if (typeof values === "string") {
    return geographyNavigationPayloadLeaksEphemeral(searchParams(values));
  }
  if (!values || typeof values !== "object") return false;
  return Object.keys(values).some((key) => EPHEMERAL_SET.has(key));
}

function historyUrl(locationLike, pathAndQuery) {
  const base = locationLike?.href || "https://cityscroll.invalid/near-you/";
  const url = new URL(pathAndQuery, base);
  return `${url.pathname}${url.search}${url.hash || ""}`;
}

/**
 * Write canonical state into browser history.
 * Deliberate selection uses pushState; normalization uses replaceState.
 */
export function writeGeographyNavigationHistory(historyLike, locationLike, state, {
  mode = "push",
  base = "/near-you/",
} = {}) {
  if (!historyLike || typeof historyLike[mode === "replace" ? "replaceState" : "pushState"] !== "function") {
    return false;
  }
  const parsed = state && state.schema === GEOGRAPHY_NAVIGATION_STATE_SCHEMA
    ? state
    : parseGeographyNavigationState(state || {});
  const path = geographyNavigationUrlFromState(parsed, { base });
  const url = historyUrl(locationLike, path);
  const snapshot = {
    schema: GEOGRAPHY_NAVIGATION_STATE_SCHEMA,
    geography_navigation: {
      geo: parsed.geo,
      key: parsed.key,
      compare: parsed.compare,
      surface: parsed.surface,
      drawer: parsed.drawer,
      focus: parsed.focus,
      lens: parsed.lens,
      ok: parsed.ok,
      recovery: parsed.recovery,
    },
  };
  const method = mode === "replace" ? "replaceState" : "pushState";
  historyLike[method](snapshot, "", url);
  if (locationLike && typeof locationLike === "object") {
    try {
      const next = new URL(url, locationLike.href || "https://cityscroll.invalid/near-you/");
      if ("pathname" in locationLike) locationLike.pathname = next.pathname;
      if ("search" in locationLike) locationLike.search = next.search;
      if ("href" in locationLike) locationLike.href = next.toString();
    } catch {
      // Location mocks without URL assignment stay history-only.
    }
  }
  return true;
}

/** Read restored state from popstate / history.state or the current location. */
export function readGeographyNavigationHistory(locationLike, historyState = null) {
  const fromHistory = historyState?.geography_navigation;
  if (fromHistory && typeof fromHistory === "object") {
    if (fromHistory.ok === false && fromHistory.recovery) {
      return recoveryState(
        fromHistory.recovery.reason || GEOGRAPHY_NAVIGATION_RECOVERY_REASONS.MALFORMED,
        fromHistory.recovery.explanation || "That geography key is not recognized, so the navigator stays unselected.",
        {
          surface: normalizeSurface(fromHistory.surface),
          drawer: normalizeDrawer(fromHistory.drawer),
          focus: normalizeFocus(fromHistory.focus),
          lens: normalizeLens(fromHistory.lens),
          source: "history",
        },
      );
    }
    return parseGeographyNavigationState({
      geo: fromHistory.geo,
      compare: fromHistory.compare,
      surface: fromHistory.surface,
      drawer: fromHistory.drawer,
      focus: fromHistory.focus,
      lens: fromHistory.lens,
    });
  }
  const href = locationLike?.href
    || `${locationLike?.pathname || "/near-you/"}${locationLike?.search || ""}`;
  return parseGeographyNavigationState(href);
}

/**
 * Bind popstate restoration. Returns an unsubscribe function.
 * The listener restores selection, comparison, surface, drawer, lens, and focus.
 */
export function bindGeographyNavigationPopState(target, onRestore) {
  if (!target || typeof target.addEventListener !== "function") {
    return () => {};
  }
  const handler = (event) => {
    const locationLike = target.location || target;
    const state = readGeographyNavigationHistory(locationLike, event?.state ?? target.history?.state);
    if (typeof onRestore === "function") onRestore(state, event);
  };
  target.addEventListener("popstate", handler);
  return () => target.removeEventListener("popstate", handler);
}

/**
 * Normalize an incoming location in place with replaceState when the URL is a
 * supported but non-canonical encoding (duplicate params, full geography keys,
 * default surface noise). Deliberate selection callers should use push mode.
 */
export function normalizeGeographyNavigationLocation(historyLike, locationLike, {
  base = "/near-you/",
} = {}) {
  const current = `${locationLike?.pathname || "/near-you/"}${locationLike?.search || ""}`;
  const state = parseGeographyNavigationState(current);
  const canonical = geographyNavigationUrlFromState(state, { base });
  if (canonical === current) return { changed: false, state };
  writeGeographyNavigationHistory(historyLike, locationLike, state, { mode: "replace", base });
  return { changed: true, state };
}

/** Test/helper: empty scope projected through near-you URL for membership checks. */
export function nearYouUrlFromGeographyNavigationState(state, { base = "/near-you/" } = {}) {
  const parsed = state && state.schema === GEOGRAPHY_NAVIGATION_STATE_SCHEMA
    ? state
    : parseGeographyNavigationState(state || {});
  if (!parsed.ok || !parsed.key) return geographyNavigationUrlFromState(parsed, { base });
  const scope = scopeWithGeographyNavigationState(scopeFromRouteHash("#map"), parsed);
  // Keep enhanced compare/surface/drawer/focus beside the scope wire.
  const url = new URL(nearYouUrlFromScope(scope, { base }), "https://cityscroll.invalid");
  const enhanced = serializeGeographyNavigationState(parsed, { includeDefaults: true });
  for (const key of [
    GEOGRAPHY_NAVIGATION_COMPARE_PARAM,
    GEOGRAPHY_NAVIGATION_SURFACE_PARAM,
    GEOGRAPHY_NAVIGATION_DRAWER_PARAM,
    GEOGRAPHY_NAVIGATION_FOCUS_PARAM,
  ]) {
    if (enhanced.get(key)) url.searchParams.set(key, enhanced.get(key));
  }
  // Prefer the short geo token from this grammar when present.
  if (parsed.geo) {
    url.searchParams.delete("geo");
    url.searchParams.set(GEOGRAPHY_NAVIGATION_GEO_PARAM, parsed.geo);
  }
  const absolute = /^[a-z][a-z\d+.-]*:\/\//i.test(base);
  return absolute ? url.toString() : `${url.pathname}${url.search}`;
}
