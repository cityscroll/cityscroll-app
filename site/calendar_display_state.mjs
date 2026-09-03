/**
 * Calendar display presentation state.
 *
 * The bounded display query (see `calendar_display.mjs`) is driven by two
 * things a resident can point at but that carry no civic meaning: which
 * renderer is painting (a month calendar or the existing list) and which date
 * window is on screen. Both are *presentation state*. They are siblings of a
 * surface's semantic filters, never one of them.
 *
 * This module is the single home for those keys plus the pure helpers that keep
 * them out of any serialized scope. It is deliberately tiny and dependency-free
 * so the scope serializer can import the key set without pulling in the whole
 * display adapter — the same shape `land_view_state.mjs` gives the Land
 * renderer switch. Enforcement lives at the scope boundary: `scope_v0.mjs`
 * strips these keys wherever an arbitrary bag could otherwise smuggle them into
 * a Follow, Browse, project, watch, or subscription scope.
 */

export const CALENDAR_DISPLAY_STATE_SCHEMA = "cityscroll.calendar_display_state.v1";

// The renderer selector: the compact month calendar, or the existing list.
export const CALENDAR_VIEW_PARAM = "calview";
export const CALENDAR_VIEW_CALENDAR = "calendar";
export const CALENDAR_VIEW_LIST = "list";
export const CALENDAR_VIEWS = Object.freeze([CALENDAR_VIEW_CALENDAR, CALENDAR_VIEW_LIST]);

// Historical object views default to the existing list; a resident opts into the
// month calendar. No implementation may make this default conditional or clock-based.
export const CALENDAR_DEFAULT_VIEW = CALENDAR_VIEW_LIST;

// The explicit display window bounds. These name a query range, never a
// canonical time_window: a resident scrolling into last spring must not widen
// what their subscription will deliver next week.
export const CALENDAR_DISPLAY_FROM_PARAM = "calfrom";
export const CALENDAR_DISPLAY_TO_PARAM = "calto";

export const CALENDAR_DISPLAY_STATE_KEYS = Object.freeze([
  CALENDAR_VIEW_PARAM,
  CALENDAR_DISPLAY_FROM_PARAM,
  CALENDAR_DISPLAY_TO_PARAM,
]);

/** True only for the two renderer values; everything else falls back to List. */
export function isKnownCalendarView(value) {
  return CALENDAR_VIEWS.includes(typeof value === "string" ? value.trim().toLowerCase() : value);
}

export function normalizeCalendarView(value) {
  const normalized = typeof value === "string" ? value.trim().toLowerCase() : value;
  return CALENDAR_VIEWS.includes(normalized) ? normalized : CALENDAR_DEFAULT_VIEW;
}

function splitRouteHash(hash) {
  const raw = String(hash ?? "").replace(/^#/, "");
  const index = raw.indexOf("?");
  return index < 0
    ? { route: raw, query: "" }
    : { route: raw.slice(0, index), query: raw.slice(index + 1) };
}

function rebuildRouteHash(route, params) {
  const query = params.toString();
  return `#${route}${query ? `?${query}` : ""}`;
}

/**
 * Remove the calendar display keys from a route hash. Returns the input
 * unchanged (as a string) when none are present, so a legacy address stays
 * byte-identical.
 */
export function stripCalendarDisplayState(hash) {
  const { route, query } = splitRouteHash(hash);
  const params = new URLSearchParams(query);
  if (!CALENDAR_DISPLAY_STATE_KEYS.some((key) => params.has(key))) return String(hash ?? "");
  for (const key of CALENDAR_DISPLAY_STATE_KEYS) params.delete(key);
  return rebuildRouteHash(route, params);
}

/** Copy a facet or watch-filter bag without any calendar display key. */
export function omitCalendarDisplayState(values) {
  const source = values && typeof values === "object" && !Array.isArray(values) ? values : {};
  const kept = {};
  for (const [key, value] of Object.entries(source)) {
    if (CALENDAR_DISPLAY_STATE_KEYS.includes(key)) continue;
    kept[key] = value;
  }
  return kept;
}
