/**
 * The resident-facing Land List/Map control.
 *
 * The control is reversible by construction: both destinations are ordinary
 * shareable Land routes that differ only in presentation state, and List is
 * always present, so a resident is never stranded in a renderer that cannot
 * paint. Semantic filters are carried through untouched — this module never
 * reads or writes a filter key.
 */

import { filterChip } from "./affordance_grammar.mjs";
import {
  LAND_VIEWS,
  LAND_VIEW_FALLBACK_REASONS,
  LAND_VIEW_LIST,
  LAND_VIEW_MAP,
  normalizeLandView,
  resolveLandPresentation,
  routeHashWithLandView,
} from "./land_view_state.mjs";

export const LAND_VIEW_SWITCH_SCHEMA = "cityscroll.land_view_switch.v1";

const VIEW_LABEL_KEYS = Object.freeze({
  [LAND_VIEW_LIST]: "land_view_list",
  [LAND_VIEW_MAP]: "land_view_map",
});

const FALLBACK_NOTE_KEYS = Object.freeze({
  [LAND_VIEW_FALLBACK_REASONS.RENDERER_ABSENT]: "land_view_map_pending",
  [LAND_VIEW_FALLBACK_REASONS.RENDERER_FAILED]: "land_view_map_failed",
  [LAND_VIEW_FALLBACK_REASONS.UNKNOWN_VIEW]: null,
});

function escapeSwitchHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

/**
 * The shareable Land route for one presentation view.
 *
 * @param {"list"|"map"|string} view
 * @param {string} currentHash
 * @returns {string}
 */
export function landViewHref(view, currentHash = "#land") {
  return routeHashWithLandView(currentHash || "#land", view);
}

/**
 * Render the two-destination presentation control.
 *
 * `view` is what actually painted, so a Map request that fell back to List
 * shows List as the pressed state and never claims a map is on screen.
 *
 * @param {{view?: unknown, currentHash?: string, t?: (key: string) => string, escape?: (value: unknown) => string}} input
 * @returns {string}
 */
export function landViewSwitchHTML({
  view = LAND_VIEW_LIST,
  currentHash = "#land",
  t = (key) => key,
  escape = escapeSwitchHtml,
} = {}) {
  const active = normalizeLandView(view);
  return LAND_VIEWS.map((candidate) => filterChip({
    label: t(VIEW_LABEL_KEYS[candidate]),
    pressed: candidate === active,
    className: `land-view-link${candidate === active ? " on" : ""}`,
    attributes: {
      "data-land-view": candidate,
      "data-scope-edge": `land.view.${candidate}`,
      "data-filter-href": landViewHref(candidate, currentHash),
    },
    escape,
  })).join("");
}

/**
 * The plain-language note explaining a List fallback, or an empty string when
 * the requested view is the one that painted.
 *
 * @param {{fallback?: boolean, reason?: string|null, t?: (key: string) => string}} input
 * @returns {string}
 */
export function landViewFallbackNote({ fallback = false, reason = null, t = (key) => key } = {}) {
  if (!fallback) return "";
  const key = FALLBACK_NOTE_KEYS[reason];
  return key ? t(key) : "";
}

/** The Map renderer seam.
 *
 * The route-lazy Map shell registers itself here. Until one does, a Map request
 * is reported honestly as unavailable and List paints the same filtered rows.
 * This module never loads, fetches, or implements a renderer of its own.
 */
export function landMapRenderer(scope = globalThis) {
  const seam = scope?.CROL_LAND_MAP_RENDERER;
  return typeof seam?.mount === "function" ? seam : null;
}

/**
 * Paint the presentation layer for the current Land route.
 *
 * This changes which renderer is shown and nothing else: it reads no filter,
 * runs no query, and rebuilds no population.
 *
 * @returns {{view: "list"|"map", requested: "list"|"map", fallback: boolean, reason: string|null}}
 */
export function paintLandViewPresentation({
  view = LAND_VIEW_LIST,
  currentHash = "#land",
  rendererReady = false,
  failure = null,
  doc = globalThis.document,
  t = (key) => key,
  escape = escapeSwitchHtml,
} = {}) {
  const presentation = resolveLandPresentation({ requested: view, rendererReady, failure });
  const host = doc?.getElementById?.("land-view-switch");
  if (host) {
    host.innerHTML = landViewSwitchHTML({ view: presentation.view, currentHash, t, escape });
  }
  const grid = doc?.getElementById?.("land-results-grid");
  if (grid) grid.dataset.landView = presentation.view;
  const note = doc?.getElementById?.("land-view-note");
  if (note) {
    const message = landViewFallbackNote({ ...presentation, t });
    note.textContent = message;
    note.hidden = !message;
  }
  return presentation;
}

/**
 * Install the one-time click delegation for the control.
 *
 * Each chip records its shareable destination in `data-filter-href`, the same way
 * the other Land filter chips do, but this one is not wired to
 * `installFilterChipNavigation`: a presentation switch rewrites the current
 * route and repaints in place instead of re-entering the search.
 */
export function installLandViewSwitch(doc = globalThis.document, onSelect = () => {}) {
  const host = doc?.getElementById?.("land-view-switch");
  if (!host || host.dataset.landViewSwitchInstalled === "true") return;
  host.dataset.landViewSwitchInstalled = "true";
  host.addEventListener("click", (event) => {
    const control = event.target?.closest?.("[data-land-view]");
    if (!control || !host.contains(control)) return;
    event.preventDefault();
    onSelect(control.dataset.landView);
  });
}

export { LAND_VIEW_LIST, LAND_VIEW_MAP };
