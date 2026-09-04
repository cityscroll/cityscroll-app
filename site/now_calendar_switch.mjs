/**
 * The resident-facing Now Cards/Calendar control.
 *
 * Mirrors `land_view_switch.mjs`: the control is reversible by construction
 * (both destinations are ordinary shareable Now routes that differ only in
 * presentation state, and Cards is always present), and it never reads or
 * writes a Now scope filter — domain, place, and agency scope pass through
 * untouched (A4). A Calendar request that cannot paint — a bundle too sparse
 * for the commissioned density rule — is a presentation fallback, never a
 * scope failure: List keeps painting the same eligible population.
 *
 * `compact_calendar.css` is not part of every page's cold load; it is
 * fetched only the first time a resident's session actually paints the
 * calendar, the same way Land only activates its Map runtime on request.
 */

import { filterChip } from "./affordance_grammar.mjs";
import {
  CALENDAR_VIEW_CALENDAR,
  CALENDAR_VIEW_FALLBACK_REASONS,
  CALENDAR_VIEW_LIST,
  CALENDAR_VIEWS,
  normalizeCalendarView,
  resolveCalendarPresentation,
  routeHashWithCalendarView,
} from "./calendar_display_state.mjs";

export const NOW_CALENDAR_SWITCH_SCHEMA = "cityscroll.now_calendar_switch.v1";

const VIEW_LABEL_KEYS = Object.freeze({
  [CALENDAR_VIEW_LIST]: "now_calview_cards",
  [CALENDAR_VIEW_CALENDAR]: "now_calview_calendar",
});

const FALLBACK_NOTE_KEYS = Object.freeze({
  [CALENDAR_VIEW_FALLBACK_REASONS.SPARSE]: "now_calview_sparse_note",
  [CALENDAR_VIEW_FALLBACK_REASONS.RENDERER_ABSENT]: "now_calview_sparse_note",
  [CALENDAR_VIEW_FALLBACK_REASONS.RENDERER_FAILED]: "now_calview_sparse_note",
  [CALENDAR_VIEW_FALLBACK_REASONS.UNKNOWN_VIEW]: null,
});

function escapeSwitchHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

/** The shareable Now route for one presentation view. */
export function nowCalendarViewHref(view, currentHash = "#now") {
  return routeHashWithCalendarView(currentHash || "#now", view);
}

/**
 * Render the two-destination presentation control. `view` is what actually
 * painted, so a Calendar request that fell back to Cards shows Cards as the
 * pressed state and never claims a calendar is on screen.
 */
export function nowCalendarSwitchHTML({
  view = CALENDAR_VIEW_LIST,
  currentHash = "#now",
  t = (key) => key,
  escape = escapeSwitchHtml,
} = {}) {
  const active = normalizeCalendarView(view);
  return CALENDAR_VIEWS.map((candidate) => filterChip({
    label: t(VIEW_LABEL_KEYS[candidate]),
    pressed: candidate === active,
    className: `now-calview-link${candidate === active ? " on" : ""}`,
    attributes: {
      "data-now-calview": candidate,
      "data-filter-href": nowCalendarViewHref(candidate, currentHash),
    },
    escape,
  })).join("");
}

/** The plain-language note explaining a Cards fallback, or "" when the requested view painted. */
export function nowCalendarFallbackNote({ fallback = false, reason = null, t = (key) => key } = {}) {
  if (!fallback) return "";
  const key = FALLBACK_NOTE_KEYS[reason];
  return key ? t(key) : "";
}

let cssRequested = false;

/**
 * Load `compact_calendar.css` once, only when a calendar is actually about to
 * paint. Idempotent and safe to call from environments with no `document`.
 */
export function ensureNowCalendarStylesheet(doc = globalThis.document) {
  if (cssRequested || !doc?.head || typeof doc.createElement !== "function") return;
  if (doc.querySelector('link[data-now-calendar-stylesheet]')) { cssRequested = true; return; }
  cssRequested = true;
  const link = doc.createElement("link");
  link.rel = "stylesheet";
  link.href = "compact_calendar.css";
  link.dataset.nowCalendarStylesheet = "true";
  doc.head.appendChild(link);
}

/**
 * Decide which renderer actually paints for this request, loading the
 * calendar stylesheet only when a calendar is about to be shown.
 */
export function resolveNowCalendarPresentation({ requested, sparse = false, doc = globalThis.document } = {}) {
  const presentation = resolveCalendarPresentation({ requested, sparse });
  if (presentation.view === CALENDAR_VIEW_CALENDAR) ensureNowCalendarStylesheet(doc);
  return presentation;
}

/** Install the one-time click delegation for the control. */
export function installNowCalendarSwitch(doc = globalThis.document, onSelect = () => {}) {
  const host = doc?.getElementById?.("now-calview-switch");
  if (!host || host.dataset.nowCalviewSwitchInstalled === "true") return;
  host.dataset.nowCalviewSwitchInstalled = "true";
  host.addEventListener("click", (event) => {
    const control = event.target?.closest?.("[data-now-calview]");
    if (!control || !host.contains(control)) return;
    event.preventDefault();
    onSelect(control.dataset.nowCalview);
  });
}

export { CALENDAR_VIEW_CALENDAR, CALENDAR_VIEW_LIST };
