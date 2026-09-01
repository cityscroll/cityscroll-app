/**
 * Land browse presentation state.
 *
 * `view` selects which renderer paints the already filtered Land result set.
 * It is presentation, not search meaning: it never narrows, widens, reorders,
 * or reinterprets a result, and it is never a Land facet or a Land watch
 * filter field. `scope_v0.mjs` drops it from the Land surface for exactly that
 * reason, so a saved Land watch describes the civic filter a resident chose
 * and never a viewport, a tile state, or a renderer selection.
 *
 * This module is pure. It parses, normalizes, and serializes the parameter and
 * decides the List fallback; it owns no map data source, no renderer, and no
 * request.
 */

export const LAND_VIEW_STATE_SCHEMA = "cityscroll.land_view_state.v1";

/** The sibling presentation parameter carried beside the Land filter keys. */
export const LAND_VIEW_PARAM = "view";

export const LAND_VIEW_LIST = "list";
export const LAND_VIEW_MAP = "map";

/** The only two values that may change Land presentation. */
export const LAND_VIEWS = Object.freeze([LAND_VIEW_LIST, LAND_VIEW_MAP]);

/**
 * List is the default for progressive enhancement and zero map cost: an absent
 * or unrecognized `view` paints the same List a legacy link has always painted.
 *
 * Changing this constant also changes what every existing bare Land link means,
 * so it is a site-owner decision, not an implementation choice. The open
 * question is recorded in LAND_VIEW_DEFAULT_QUESTION below and must stay
 * unresolved here until that review lands.
 */
export const LAND_DEFAULT_VIEW = LAND_VIEW_LIST;

/** Route keys that are presentation only and must never reach watch identity. */
export const LAND_PRESENTATION_STATE_KEYS = Object.freeze([LAND_VIEW_PARAM]);

/** Why a requested Map presentation resolved back to List. */
export const LAND_VIEW_FALLBACK_REASONS = Object.freeze({
  UNKNOWN_VIEW: "unknown_view",
  RENDERER_ABSENT: "renderer_absent",
  RENDERER_FAILED: "renderer_failed",
});

/**
 * The site owner's unresolved parity-era default question, kept as data so a
 * review fixture can assert that no implementation quietly decided it.
 */
export const LAND_VIEW_DEFAULT_QUESTION = Object.freeze({
  id: "land-map-view-parity-default",
  status: "open",
  decided_by: "site_owner",
  question:
    "After measured List/Map parity, should Land browse default to Map, and how would a resident return to List?",
  current_default: LAND_DEFAULT_VIEW,
  review_document: "docs/land-map-view-default-question.md",
});

const VIEW_SET = new Set(LAND_VIEWS);

/**
 * Normalize one candidate value to a known view.
 *
 * Surrounding whitespace and letter case are ordinary URL noise, so they
 * normalize. Every other value — absent, empty, repeated garbage, `globe` —
 * resolves to the default rather than failing the route.
 *
 * @param {unknown} value
 * @returns {"list"|"map"}
 */
export function normalizeLandView(value) {
  const candidate = String(value ?? "").trim().toLowerCase();
  return VIEW_SET.has(candidate) ? candidate : LAND_DEFAULT_VIEW;
}

/** True when the value is exactly one of the two known views. */
export function isKnownLandView(value) {
  return VIEW_SET.has(String(value ?? "").trim().toLowerCase());
}

function searchParams(input) {
  if (input instanceof URLSearchParams) return input;
  if (input && typeof input === "object" && !Array.isArray(input)) {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(input)) {
      if (value != null) params.append(key, String(value));
    }
    return params;
  }
  return new URLSearchParams(String(input ?? "").replace(/^[?&]/, ""));
}

/**
 * Read the view from a parameter bag.
 *
 * The first occurrence wins, matching `URLSearchParams.get` and every other
 * route key in this application. A repeated parameter whose first value is
 * unknown falls back to List instead of scanning ahead for a later valid
 * value; the route never shops for a value a resident did not put first.
 *
 * @param {URLSearchParams|Record<string, unknown>|string} input
 * @returns {"list"|"map"}
 */
export function landViewFromSearchParams(input) {
  return normalizeLandView(searchParams(input).get(LAND_VIEW_PARAM));
}

function splitRouteHash(hash) {
  const raw = String(hash ?? "").replace(/^#/, "");
  const queryAt = raw.indexOf("?");
  return {
    route: queryAt < 0 ? raw : raw.slice(0, queryAt),
    query: queryAt < 0 ? "" : raw.slice(queryAt + 1),
  };
}

/**
 * Read the presentation view carried by a Land route hash.
 *
 * @param {string} hash
 * @returns {"list"|"map"}
 */
export function landViewFromRouteHash(hash) {
  return landViewFromSearchParams(splitRouteHash(hash).query);
}

function rebuildRouteHash(route, params) {
  const query = params.toString();
  return `#${route}${query ? `?${query}` : ""}`;
}

/**
 * Serialize the view additively onto an otherwise canonical Land route hash.
 *
 * The default view is omitted, so a List route is byte-identical to the legacy
 * route a resident already has bookmarked, and every semantic key keeps the
 * position and encoding the canonical serializer gave it. Only the presentation
 * parameter is added or removed.
 *
 * @param {string} hash
 * @param {unknown} view
 * @returns {string}
 */
export function routeHashWithLandView(hash, view) {
  const resolved = normalizeLandView(view);
  const { route, query } = splitRouteHash(hash);
  const params = new URLSearchParams(query);
  const carried = params.has(LAND_VIEW_PARAM);
  if (resolved === LAND_DEFAULT_VIEW) {
    if (!carried) return String(hash ?? "");
    params.delete(LAND_VIEW_PARAM);
    return rebuildRouteHash(route, params);
  }
  params.delete(LAND_VIEW_PARAM);
  params.append(LAND_VIEW_PARAM, resolved);
  return rebuildRouteHash(route, params);
}

/**
 * Drop every presentation key from a Land route hash, leaving the semantic
 * scope a watch or a filter comparison may read.
 *
 * @param {string} hash
 * @returns {string}
 */
export function stripLandPresentationState(hash) {
  const { route, query } = splitRouteHash(hash);
  const params = new URLSearchParams(query);
  if (!LAND_PRESENTATION_STATE_KEYS.some((key) => params.has(key))) return String(hash ?? "");
  for (const key of LAND_PRESENTATION_STATE_KEYS) params.delete(key);
  return rebuildRouteHash(route, params);
}

/**
 * Copy a facet or watch-filter bag without Land presentation keys.
 *
 * @param {unknown} values
 * @returns {Record<string, unknown>}
 */
export function omitLandPresentationState(values) {
  const source = values && typeof values === "object" && !Array.isArray(values) ? values : {};
  const kept = {};
  for (const [key, value] of Object.entries(source)) {
    if (LAND_PRESENTATION_STATE_KEYS.includes(key)) continue;
    kept[key] = value;
  }
  return kept;
}

/**
 * Decide which renderer actually paints, given what the route asked for and
 * whether a Map renderer is present and healthy.
 *
 * A Map that cannot load is a presentation failure, never a scope failure: the
 * caller keeps the same filtered population and paints List.
 *
 * @param {{requested?: unknown, rendererReady?: boolean, failure?: unknown}} input
 * @returns {{view: "list"|"map", requested: "list"|"map", fallback: boolean, reason: string|null}}
 */
export function resolveLandPresentation({ requested, rendererReady = true, failure = null } = {}) {
  const requestedView = normalizeLandView(requested);
  const unknownRequest = requested != null && requested !== "" && !isKnownLandView(requested);
  if (requestedView === LAND_VIEW_LIST) {
    return {
      view: LAND_VIEW_LIST,
      requested: LAND_VIEW_LIST,
      fallback: unknownRequest,
      reason: unknownRequest ? LAND_VIEW_FALLBACK_REASONS.UNKNOWN_VIEW : null,
    };
  }
  if (failure) {
    return {
      view: LAND_VIEW_LIST,
      requested: requestedView,
      fallback: true,
      reason: LAND_VIEW_FALLBACK_REASONS.RENDERER_FAILED,
    };
  }
  if (!rendererReady) {
    return {
      view: LAND_VIEW_LIST,
      requested: requestedView,
      fallback: true,
      reason: LAND_VIEW_FALLBACK_REASONS.RENDERER_ABSENT,
    };
  }
  return { view: requestedView, requested: requestedView, fallback: false, reason: null };
}
