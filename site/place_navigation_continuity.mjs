/**
 * Cross-surface place navigation continuity.
 *
 * Adapts board, Land, and Near You entry points onto existing geography-state,
 * Land-filter, and return-scope helpers. Public links allowlist geography keys,
 * supported Land facets, view, selected project, boundary layer controls, and
 * existing return-scope fields. Browser Back restores scroll/focus through the
 * history sidecar; copied URLs restore public semantic state only.
 */

import { communityBoardPageHref } from "./community_board_links.mjs";
import {
  GEOGRAPHY_NAVIGATION_EPHEMERAL_KEYS,
  GEOGRAPHY_NAVIGATION_FOCUS_PARAM,
  GEOGRAPHY_NAVIGATION_GEO_PARAM,
  parseGeographyNavigationState,
} from "./geography_navigation_state.mjs";
import {
  landBrowseHrefFromState,
  landFilterStateFromRouteParams,
} from "./land_filter_parity.mjs";
import { landProjectPath } from "./land_project_route.mjs";
import {
  LAND_BOUNDARIES_PARAM,
  LAND_VIEW_PARAM,
  normalizeLandDetailBoundaries,
  normalizeLandView,
  routeHashWithLandDetailBoundaries,
} from "./land_view_state.mjs";
import { migrateLegacyUrl } from "./route_migration.mjs";
import {
  nearYouUrlFromScope,
  normalizeGeographyKey,
  scopeWithGeographies,
} from "./scope_v0.mjs";

export const PLACE_NAVIGATION_CONTINUITY_SCHEMA = "cityscroll.place_navigation_continuity.v1";
export const PLACE_NAVIGATION_HISTORY_KEY = "placeNavigation";
export const PLACE_NAVIGATION_LAND_BASE = "/browse/zoning/";
export const PLACE_NAVIGATION_NEAR_YOU_BASE = "/near-you/";
export const PLACE_NAVIGATION_BOARD_DIRECTORY_BASE = "/community-boards/";

const PROJECT_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{2,24}$/;
const BOARD_ID_RE = /^[a-z]+(?:-[a-z]+)*-cb-\d{2}$/;
const NTA_GEOGRAPHY_RE = /^geography:nta2020:((?:BK|BX|MN|QN|SI)\d{4})$/;

/** Public semantic keys that may cross board / Land / Near You surfaces. */
export const PLACE_NAVIGATION_PUBLIC_KEYS = Object.freeze([
  GEOGRAPHY_NAVIGATION_GEO_PARAM,
  "status",
  "stage",
  "future",
  "procedure",
  "family",
  "facet",
  "q",
  "boro",
  "cd",
  "council",
  LAND_VIEW_PARAM,
  LAND_BOUNDARIES_PARAM,
  "lens",
  "surface",
  "drawer",
  "compare",
  GEOGRAPHY_NAVIGATION_FOCUS_PARAM,
  "v",
]);

/** Keys that must never enter a shareable continuity URL. */
export const PLACE_NAVIGATION_FORBIDDEN_KEYS = Object.freeze([
  ...GEOGRAPHY_NAVIGATION_EPHEMERAL_KEYS,
  "return",
  "returnUrl",
  "return_to",
  "return_url",
  "next",
  "redirect",
  "session",
  "session_id",
]);

export const PLACE_NAVIGATION_RECOVERY_REASONS = Object.freeze({
  INVALID_PLACE: "invalid_place",
  UNKNOWN_PROJECT: "unknown_project",
  REMOVED_PROJECT: "removed_project",
  EXTERNAL_RETURN: "external_return",
  LEGACY_HASH: "legacy_hash",
  MISMATCHED_HISTORY: "mismatched_history",
  UNKNOWN_BOARD: "unknown_board",
});

const FORBIDDEN_SET = new Set(PLACE_NAVIGATION_FORBIDDEN_KEYS.map((key) => key.toLowerCase()));
const PUBLIC_SET = new Set(PLACE_NAVIGATION_PUBLIC_KEYS);

function clean(value, max = 240) {
  return String(value ?? "")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

function freezeDeep(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  if (Array.isArray(value)) {
    for (const entry of value) freezeDeep(entry);
    return Object.freeze(value);
  }
  for (const child of Object.values(value)) freezeDeep(child);
  return Object.freeze(value);
}

function safeUrl(input, origin = "https://cityscroll.org") {
  const raw = String(input ?? "").trim();
  if (!raw) return new URL(PLACE_NAVIGATION_NEAR_YOU_BASE, origin);
  if (/^https?:\/\//i.test(raw)) return new URL(raw);
  if (raw.startsWith("#")) return new URL(`/${raw}`, origin);
  return new URL(raw.startsWith("/") ? raw : `/${raw}`, origin);
}

function splitHash(hash) {
  const raw = String(hash ?? "").replace(/^#/, "");
  const queryAt = raw.indexOf("?");
  return {
    route: queryAt < 0 ? raw : raw.slice(0, queryAt),
    query: queryAt < 0 ? "" : raw.slice(queryAt + 1),
  };
}

function projectIdFromHash(hash) {
  const { route } = splitHash(hash);
  const match = route.match(/^land\/([^/]+)$/i);
  if (!match) return null;
  try {
    const id = decodeURIComponent(match[1]);
    return PROJECT_ID_RE.test(id) ? id : null;
  } catch {
    return null;
  }
}

function boardIdFromPath(pathname) {
  const match = String(pathname || "").match(/^\/community-boards\/([^/]+)\/?$/i);
  if (!match) return null;
  try {
    const id = decodeURIComponent(match[1]).toLowerCase();
    return BOARD_ID_RE.test(id) ? id : null;
  } catch {
    return null;
  }
}

function normalizeNtaKeys(rawKeys) {
  const out = [];
  for (const value of Array.isArray(rawKeys) ? rawKeys : []) {
    const key = normalizeGeographyKey(value);
    if (key && NTA_GEOGRAPHY_RE.test(key) && !out.includes(key)) out.push(key);
  }
  return Object.freeze(out);
}

function emptyState(overrides = {}) {
  return freezeDeep({
    schema: PLACE_NAVIGATION_CONTINUITY_SCHEMA,
    ok: overrides.ok !== false && !overrides.recovery,
    surface: overrides.surface ?? null,
    geographies: Object.freeze(overrides.geographies || []),
    land_filter: overrides.land_filter ?? null,
    view: overrides.view ?? null,
    boundaries: Object.freeze(overrides.boundaries || []),
    project_id: overrides.project_id ?? null,
    board_id: overrides.board_id ?? null,
    focus: overrides.focus ?? null,
    lens: overrides.lens ?? null,
    recovery: overrides.recovery ?? null,
    stripped_keys: Object.freeze(overrides.stripped_keys || []),
    href: overrides.href ?? null,
  });
}

/**
 * Strip forbidden and unknown keys from a parameter bag.
 * Returns kept public params plus the list of removed keys.
 */
export function stripPlaceNavigationUnknown(input) {
  const params = input instanceof URLSearchParams
    ? new URLSearchParams(input)
    : new URLSearchParams(String(input ?? "").replace(/^[?#]/, ""));
  const kept = new URLSearchParams();
  const stripped = [];
  for (const [key, value] of params) {
    const lower = String(key).toLowerCase();
    if (FORBIDDEN_SET.has(lower) || !PUBLIC_SET.has(key)) {
      stripped.push(key);
      continue;
    }
    kept.append(key, value);
  }
  return freezeDeep({ params: kept, stripped_keys: [...new Set(stripped)].sort() });
}

function recovery(reason, explanation, extras = {}) {
  return emptyState({
    ok: false,
    recovery: Object.freeze({ reason, explanation }),
    ...extras,
  });
}

function surfaceForUrl(url) {
  const path = String(url.pathname || "");
  if (path.startsWith("/browse/zoning")) return "land";
  if (path.startsWith("/near-you")) return "near_you";
  if (path.startsWith("/community-boards")) {
    return boardIdFromPath(path) ? "board_profile" : "board_directory";
  }
  return null;
}

/**
 * Parse a cross-surface place URL into allowlisted continuity state.
 *
 * Invalid geography keys become an invalid-place recovery instead of widening
 * the query to citywide. External return destinations are rejected.
 */
export function parsePlaceNavigationState(input = {}) {
  if (input && typeof input === "object" && !Array.isArray(input)
    && input.schema === PLACE_NAVIGATION_CONTINUITY_SCHEMA
    && (input.geographies || input.land_filter || input.project_id || input.board_id
      || input.recovery || input.href || input.surface)) {
    return freezeDeep(input);
  }

  const raw = typeof input === "string" || input instanceof URL
    ? String(input)
    : (input?.href || input?.url || "");

  if (/[?&#](?:return|returnUrl|return_to|return_url|next|redirect)=https?:\/\//i.test(raw)
    || /[?&#](?:return|returnUrl|return_to|return_url|next|redirect)=\/\//i.test(raw)) {
    return recovery(
      PLACE_NAVIGATION_RECOVERY_REASONS.EXTERNAL_RETURN,
      "External return destinations are not accepted on place navigation links.",
      { href: clean(raw, 2000), stripped_keys: ["return"] },
    );
  }

  let url;
  try {
    url = safeUrl(raw || PLACE_NAVIGATION_NEAR_YOU_BASE);
  } catch {
    return recovery(
      PLACE_NAVIGATION_RECOVERY_REASONS.INVALID_PLACE,
      "That place link could not be read.",
    );
  }

  if ((url.protocol === "http:" || url.protocol === "https:")
    && url.hostname
    && url.hostname !== "cityscroll.org"
    && url.hostname !== "cityscroll.invalid") {
    return recovery(
      PLACE_NAVIGATION_RECOVERY_REASONS.EXTERNAL_RETURN,
      "Place navigation stays on CityScroll destinations.",
      { href: clean(url.toString(), 2000) },
    );
  }

  // Legacy hash routes migrate onto document search before continuity reads them.
  if (url.hash && /^#(?:land|map|now)\b/i.test(url.hash) && (url.pathname === "/" || url.pathname === "")) {
    const migrated = migrateLegacyUrl(`${url.pathname}${url.search}${url.hash}`);
    if (migrated?.migrated && migrated.target) {
      const next = parsePlaceNavigationState(migrated.target);
      return emptyState({
        ...next,
        recovery: next.ok
          ? Object.freeze({
            reason: PLACE_NAVIGATION_RECOVERY_REASONS.LEGACY_HASH,
            explanation: "A legacy hash route was forwarded onto the current document URL.",
          })
          : next.recovery,
        ok: next.ok,
        href: migrated.target,
      });
    }
  }

  const stripped = stripPlaceNavigationUnknown(url.searchParams);
  const landFilter = landFilterStateFromRouteParams(stripped.params);
  const geography = parseGeographyNavigationState(stripped.params);
  const hashParts = splitHash(url.hash);
  const hashParams = new URLSearchParams(hashParts.query);
  const boundaries = normalizeLandDetailBoundaries(
    hashParams.get(LAND_BOUNDARIES_PARAM) || stripped.params.get(LAND_BOUNDARIES_PARAM),
  );
  const view = normalizeLandView(
    stripped.params.get(LAND_VIEW_PARAM) || hashParams.get(LAND_VIEW_PARAM),
  );
  const projectId = projectIdFromHash(url.hash);
  const boardId = boardIdFromPath(url.pathname);

  const geographies = normalizeNtaKeys(
    Array.isArray(landFilter.geographies) && landFilter.geographies.length
      ? landFilter.geographies
      : (geography.ok && geography.key ? [geography.key] : []),
  );

  const suppliedGeo = stripped.params.getAll(GEOGRAPHY_NAVIGATION_GEO_PARAM)
    .map((value) => clean(value, 120))
    .filter(Boolean);

  // Board-directory NTA selections use short tokens; keep them when Land NTA
  // normalization does not apply (directory / Near You surfaces).
  let resolvedGeographies = geographies;
  if (!resolvedGeographies.length && geography.ok && geography.key) {
    resolvedGeographies = Object.freeze([geography.key]);
  }

  if (suppliedGeo.length && !geography.ok) {
    return recovery(
      PLACE_NAVIGATION_RECOVERY_REASONS.INVALID_PLACE,
      geography.recovery?.explanation
        || "That geography key is not recognized, so the place filter stays unset instead of widening.",
      {
        surface: surfaceForUrl(url),
        land_filter: Object.freeze({ ...landFilter, geographies: Object.freeze([]) }),
        view,
        boundaries,
        project_id: projectId,
        board_id: boardId,
        focus: geography.focus || null,
        lens: geography.lens || null,
        stripped_keys: stripped.stripped_keys,
        href: `${url.pathname}${url.search}${url.hash}`,
      },
    );
  }

  // Explicit all-invalid Land geo list must stay a bounded empty query.
  if (Array.isArray(landFilter.geographies) && landFilter.geographies.length === 0 && suppliedGeo.length) {
    return recovery(
      PLACE_NAVIGATION_RECOVERY_REASONS.INVALID_PLACE,
      "Those geography keys are not valid neighborhood filters, so results stay empty instead of widening citywide.",
      {
        surface: surfaceForUrl(url),
        geographies: Object.freeze([]),
        land_filter: landFilter,
        view,
        boundaries,
        project_id: projectId,
        board_id: boardId,
        focus: geography.focus || null,
        stripped_keys: stripped.stripped_keys,
        href: `${url.pathname}${url.search}${url.hash}`,
      },
    );
  }

  return emptyState({
    surface: surfaceForUrl(url),
    geographies: resolvedGeographies,
    land_filter: landFilter,
    view,
    boundaries,
    project_id: projectId,
    board_id: boardId,
    focus: geography.focus || null,
    lens: geography.lens || null,
    stripped_keys: stripped.stripped_keys,
    href: `${url.pathname}${url.search}${url.hash}`,
  });
}

/** Build continuity state from Land filter inputs plus selection. */
export function placeNavigationStateFromParts({
  landFilter = null,
  geographies = null,
  projectId = null,
  boardId = null,
  view = null,
  boundaries = null,
  focus = null,
  lens = null,
  surface = null,
  href = null,
} = {}) {
  const filter = landFilter || landFilterStateFromRouteParams(new URLSearchParams());
  const keys = normalizeNtaKeys(geographies || filter.geographies || []);
  const nextFilter = Object.freeze({
    ...filter,
    geographies: keys.length ? keys : (Array.isArray(filter.geographies) ? Object.freeze([]) : null),
    view: normalizeLandView(view ?? filter.view),
  });
  const id = clean(projectId, 32);
  const board = clean(boardId, 64).toLowerCase().replace(/^community-board:/, "");
  return emptyState({
    surface: surface || (board ? "board_profile" : (id ? "land" : "near_you")),
    geographies: keys,
    land_filter: nextFilter,
    view: normalizeLandView(view ?? filter.view),
    boundaries: normalizeLandDetailBoundaries(boundaries),
    project_id: PROJECT_ID_RE.test(id) ? id : null,
    board_id: BOARD_ID_RE.test(board) ? board : null,
    focus: focus ? clean(focus, 120) : null,
    lens: lens ? clean(lens, 40) : null,
    href,
  });
}

/** Land results document href carrying allowlisted filter + view state. */
export function placeNavigationLandResultsHref(stateInput = {}, { base = PLACE_NAVIGATION_LAND_BASE } = {}) {
  const state = parsePlaceNavigationState(stateInput);
  const filter = state.land_filter || landFilterStateFromRouteParams(new URLSearchParams());
  const withView = Object.freeze({
    ...filter,
    geographies: state.geographies.length ? [...state.geographies] : filter.geographies,
    view: state.view || filter.view,
  });
  return landBrowseHrefFromState(withView, { base });
}

/**
 * Land detail href: document search carries filters/view; hash carries project
 * selection and optional boundary layer controls.
 */
export function placeNavigationLandDetailHref(stateInput = {}, { base = PLACE_NAVIGATION_LAND_BASE } = {}) {
  const state = parsePlaceNavigationState(stateInput);
  const projectId = state.project_id;
  if (!projectId || !landProjectPath(projectId)) return null;
  const results = placeNavigationLandResultsHref(state, { base });
  let hash = `#land/${encodeURIComponent(projectId)}`;
  if (state.boundaries?.length) {
    hash = routeHashWithLandDetailBoundaries(hash, state.boundaries);
  }
  return `${results}${hash}`;
}

/** Near You href restoring canonical geography (+ optional lens/focus). */
export function placeNavigationNearYouHref(stateInput = {}, { base = PLACE_NAVIGATION_NEAR_YOU_BASE } = {}) {
  const state = parsePlaceNavigationState(stateInput);
  if (state.recovery?.reason === PLACE_NAVIGATION_RECOVERY_REASONS.INVALID_PLACE) {
    const url = new URL(base, "https://cityscroll.org");
    if (state.lens) url.searchParams.set("lens", state.lens);
    return `${url.pathname}${url.search}`;
  }
  const keys = state.geographies.length ? state.geographies : [];
  const scope = scopeWithGeographies({
    facets: {
      domains: [state.lens || "land"],
      values: {},
    },
  }, keys);
  const href = nearYouUrlFromScope(scope, { base });
  if (!state.focus) return href;
  const url = new URL(href, "https://cityscroll.org");
  url.searchParams.set(GEOGRAPHY_NAVIGATION_FOCUS_PARAM, state.focus);
  return `${url.pathname}${url.search}`;
}

/** Canonical board profile href — never carries arbitrary return destinations. */
export function placeNavigationBoardHref(boardId) {
  const id = clean(boardId, 64).toLowerCase().replace(/^community-board:/, "");
  return communityBoardPageHref(id);
}

/** Board directory href with a public geography selection. */
export function placeNavigationBoardDirectoryHref(geo, {
  base = PLACE_NAVIGATION_BOARD_DIRECTORY_BASE,
} = {}) {
  const parsed = parseGeographyNavigationState(
    geo && !String(geo).includes("=")
      ? `?${GEOGRAPHY_NAVIGATION_GEO_PARAM}=${encodeURIComponent(geo)}`
      : geo,
  );
  if (!parsed.ok || !parsed.geo) return base;
  return `${base}?${GEOGRAPHY_NAVIGATION_GEO_PARAM}=${encodeURIComponent(parsed.geo)}`;
}

/**
 * History sidecar for Back restoration.
 * Scroll/focus live only here — copied URLs never receive them.
 */
export function placeNavigationHistoryEntry(stateInput = {}, {
  scrollX = 0,
  scrollY = 0,
  focus = null,
  href = null,
} = {}) {
  const state = parsePlaceNavigationState(stateInput);
  const publicHref = href
    || (state.project_id
      ? placeNavigationLandDetailHref(state)
      : (state.board_id
        ? placeNavigationBoardHref(state.board_id)
        : (state.surface === "board_directory"
          ? placeNavigationBoardDirectoryHref(state.geographies[0] || state.href)
          : placeNavigationNearYouHref(state))));
  return freezeDeep({
    schema: PLACE_NAVIGATION_CONTINUITY_SCHEMA,
    [PLACE_NAVIGATION_HISTORY_KEY]: {
      href: publicHref,
      geographies: state.geographies,
      project_id: state.project_id,
      board_id: state.board_id,
      view: state.view,
      boundaries: state.boundaries,
      focus: focus || state.focus || null,
      scrollX: Number.isFinite(Number(scrollX)) ? Math.max(0, Math.round(Number(scrollX))) : 0,
      scrollY: Number.isFinite(Number(scrollY)) ? Math.max(0, Math.round(Number(scrollY))) : 0,
    },
  });
}

/**
 * Restore continuity after Back/Forward.
 * Public semantic state comes from the location URL; scroll/focus come from the sidecar.
 */
export function restorePlaceNavigationFromHistory(locationHref, historyState = null) {
  const fromUrl = parsePlaceNavigationState(locationHref);
  const bag = historyState?.[PLACE_NAVIGATION_HISTORY_KEY];
  if (!bag || typeof bag !== "object") {
    return freezeDeep({
      state: fromUrl,
      scrollX: 0,
      scrollY: 0,
      focus: fromUrl.focus,
      source: "url",
    });
  }

  const urlProject = fromUrl.project_id;
  const bagProject = bag.project_id || null;
  const mismatched = Boolean(
    (urlProject && bagProject && urlProject !== bagProject)
    || (fromUrl.geographies[0] && Array.isArray(bag.geographies) && bag.geographies[0]
      && fromUrl.geographies[0] !== bag.geographies[0]
      && !fromUrl.geographies.includes(bag.geographies[0])),
  );

  if (mismatched) {
    return freezeDeep({
      state: emptyState({
        ...fromUrl,
        ok: fromUrl.ok,
        recovery: Object.freeze({
          reason: PLACE_NAVIGATION_RECOVERY_REASONS.MISMATCHED_HISTORY,
          explanation: "The history entry did not match this page's public place link, so only the URL state was kept.",
        }),
      }),
      scrollX: 0,
      scrollY: 0,
      focus: fromUrl.focus,
      source: "url_mismatch",
    });
  }

  return freezeDeep({
    state: fromUrl,
    scrollX: Number(bag.scrollX) || 0,
    scrollY: Number(bag.scrollY) || 0,
    focus: bag.focus || fromUrl.focus || null,
    source: "history",
  });
}

/**
 * Resolve selected project against a pre-limit population.
 * Removed/unknown ids clear selection and keep the place filter.
 */
export function resolvePlaceNavigationSelection({
  projectId = null,
  preLimitIds = [],
  state = null,
} = {}) {
  const id = clean(projectId, 32);
  const base = parsePlaceNavigationState(state || {});
  const ids = Array.isArray(preLimitIds) ? preLimitIds.map(String) : [];
  if (!id) {
    return freezeDeep({
      status: "cleared",
      reason: "no_project",
      state: emptyState({ ...base, project_id: null }),
      detail_href: null,
      results_href: placeNavigationLandResultsHref(base),
    });
  }
  if (!PROJECT_ID_RE.test(id)) {
    return freezeDeep({
      status: "cleared",
      reason: PLACE_NAVIGATION_RECOVERY_REASONS.UNKNOWN_PROJECT,
      state: emptyState({
        ...base,
        project_id: null,
        ok: false,
        recovery: Object.freeze({
          reason: PLACE_NAVIGATION_RECOVERY_REASONS.UNKNOWN_PROJECT,
          explanation: "That project id is not a valid Land selection.",
        }),
      }),
      detail_href: null,
      results_href: placeNavigationLandResultsHref(base),
    });
  }
  if (!ids.includes(id)) {
    return freezeDeep({
      status: "cleared",
      reason: PLACE_NAVIGATION_RECOVERY_REASONS.REMOVED_PROJECT,
      state: emptyState({
        ...base,
        project_id: null,
        ok: false,
        recovery: Object.freeze({
          reason: PLACE_NAVIGATION_RECOVERY_REASONS.REMOVED_PROJECT,
          explanation: "That project is no longer in this place filter, so selection cleared.",
        }),
      }),
      detail_href: null,
      results_href: placeNavigationLandResultsHref(base),
    });
  }
  const selected = emptyState({ ...base, project_id: id, ok: true, recovery: null });
  return freezeDeep({
    status: "selected",
    reason: null,
    state: selected,
    detail_href: placeNavigationLandDetailHref(selected),
    results_href: placeNavigationLandResultsHref(selected),
  });
}

/**
 * Simulate the SI0105 → FDNY detail → board 1 → Back journey.
 * Back restores the Land continuity URL and history sidecar scroll/focus.
 */
export function placeNavigationSi0105BoardJourney({
  landFilter = null,
  view = "map",
  boundaries = ["nta"],
  scrollY = 480,
  focus = "land-detail-place-links",
} = {}) {
  const geo = "geography:nta2020:SI0105";
  const projectId = "2026R0127";
  const boardId = "staten-island-cb-01";
  const filter = landFilter || landFilterStateFromRouteParams(new URLSearchParams([
    ["status", "all"],
    ["stage", "any"],
    ["geo", geo],
    ["view", view],
  ]));
  const landState = emptyState({
    surface: "land",
    geographies: Object.freeze([geo]),
    land_filter: Object.freeze({ ...filter, geographies: Object.freeze([geo]), view }),
    view,
    boundaries: normalizeLandDetailBoundaries(boundaries),
    project_id: projectId,
    focus,
  });
  const nearYouHref = placeNavigationNearYouHref(emptyState({
    ...landState,
    project_id: null,
    boundaries: [],
    surface: "near_you",
    lens: "land",
    focus: null,
  }));
  const landDetailHref = placeNavigationLandDetailHref(landState);
  const boardHref = placeNavigationBoardHref(boardId);
  const historyEntry = placeNavigationHistoryEntry(landState, {
    scrollX: 0,
    scrollY,
    focus,
    href: landDetailHref,
  });
  const afterBack = restorePlaceNavigationFromHistory(landDetailHref, historyEntry);
  return freezeDeep({
    near_you_href: nearYouHref,
    land_detail_href: landDetailHref,
    board_href: boardHref,
    history_entry: historyEntry,
    after_back: afterBack,
  });
}

/**
 * Positive-control checker for continuity destinations.
 * Empty findings mean the href stays on allowlisted public keys.
 */
export function placeNavigationFindings(input = {}) {
  const href = String(input.href ?? input ?? "");
  const findings = [];
  if (!href) return ["missing_href"];
  if (/^(?:https?:)?\/\/(?!cityscroll\.org(?:\/|$))/i.test(href) && !href.startsWith("/")) {
    findings.push("external_destination");
  }
  if (/[?&#](?:return|returnUrl|return_to|return_url|next|redirect)=/i.test(href)) {
    findings.push("arbitrary_return_url");
  }
  if (/(?:address|street|victory|boulevard)=/i.test(href)) {
    findings.push("raw_address_param");
  }
  for (const key of GEOGRAPHY_NAVIGATION_EPHEMERAL_KEYS) {
    if (new RegExp(`[?&#]${key}=`, "i").test(href)) findings.push(`ephemeral:${key}`);
  }
  try {
    const url = safeUrl(href);
    const stripped = stripPlaceNavigationUnknown(url.searchParams);
    for (const key of stripped.stripped_keys) findings.push(`stripped:${key}`);
    const hashParams = new URLSearchParams(splitHash(url.hash).query);
    for (const key of hashParams.keys()) {
      if (key === LAND_BOUNDARIES_PARAM || key === LAND_VIEW_PARAM) continue;
      if (!PUBLIC_SET.has(key)) findings.push(`hash_unknown:${key}`);
      if (FORBIDDEN_SET.has(key.toLowerCase())) findings.push(`hash_forbidden:${key}`);
    }
  } catch {
    findings.push("unparseable_href");
  }
  return findings;
}

export {
  normalizeNtaKeys,
  projectIdFromHash,
  boardIdFromPath,
};
