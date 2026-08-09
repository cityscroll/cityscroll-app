/** Shareable attendance links for the Zoning hearing view. */

import { routeHashFromScope, scopeFromRouteHash } from "./scope_v0.mjs";
import { filterChip } from "./affordance_grammar.mjs";

export const ATTENDANCE_SCOPE_LINKS_SCHEMA = "cityscroll.attendance_scope_links.v1";
const CLOSING_WEEK_PRESET = ["closing", "week"].join(":");
export const ATTENDANCE_MODES = Object.freeze([
  { id: "", labelKey: "land_hearings_mode_all" },
  { id: "in_person", labelKey: "land_hearings_mode_in_person" },
  { id: "livestream", labelKey: "land_hearings_mode_livestream" },
  { id: "hybrid", labelKey: "venue_hybrid" },
]);

function cleanAttendanceScopeValue(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function escapeAttendanceScopeHtml(value) {
  return cleanAttendanceScopeValue(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export function normalizeAttendanceScope(value) {
  const next = cleanAttendanceScopeValue(value);
  return ATTENDANCE_MODES.some((mode) => mode.id === next) ? next : "";
}

/** Replace only attendance and force the route back into the hearings view. */
export function attendanceScopeHref(mode, currentHash = "#land") {
  const scope = scopeFromRouteHash(currentHash);
  scope.facets.values = { ...(scope.facets.values || {}), status: "hearings" };
  const normalized = normalizeAttendanceScope(mode);
  if (normalized) scope.facets.values.attendance = normalized;
  else delete scope.facets.values.attendance;
  const hash = routeHashFromScope(scope, { surface: "land" });
  return scope.time_window.preset === CLOSING_WEEK_PRESET
    ? `${hash}${hash.includes("?") ? "&" : "?"}closing=week`
    : hash;
}

/** Return the Zoning hearings scope for the temporal closing-week facet. */
export function landClosingWeekHash(currentHash = "#land", active = true) {
  const scope = scopeFromRouteHash(currentHash);
  scope.facets.values = { ...(scope.facets.values || {}), status: "hearings" };
  if (active) scope.time_window.preset = CLOSING_WEEK_PRESET;
  else if (scope.time_window.preset === CLOSING_WEEK_PRESET) scope.time_window.preset = null;
  const hash = routeHashFromScope(scope, { surface: "land" });
  if (!active) return hash;
  return `${hash}${hash.includes("?") ? "&" : "?"}closing=week`;
}

export function attendanceScopeLinksHTML({
  selected = "",
  currentHash = "#land",
  t = (key) => key,
  escape = escapeAttendanceScopeHtml,
} = {}) {
  const active = normalizeAttendanceScope(selected);
  const links = ATTENDANCE_MODES.map(({ id, labelKey }) => {
    const href = attendanceScopeHref(id, currentHash);
    const isActive = id === active;
    const edge = `land.attendance.${id || "all"}`;
    return filterChip({
      label: t(labelKey),
      pressed: isActive,
      className: `attendance-scope-link${isActive ? " on" : ""}`,
      attributes: { "data-attendance-scope-link": id || "all", "data-scope-edge": edge, "data-filter-href": href },
      escape,
    });
  }).join("");
  return `<div class="attendance-scope-links" data-attendance-scope="land" role="group" aria-label="${escape(t("land_hearings_mode_label"))}">${links}</div>`;
}

export function landTemporalScopeLinksHTML({ active = false, currentHash = "#land", t = (key) => key, escape = escapeAttendanceScopeHtml } = {}) {
  return `<div class="land-temporal-scope-links" data-land-temporal-scope="land" role="group" aria-label="${escape(t("hearing_guide_when_label"))}">${filterChip({
    label: t("closing_this_week"), pressed: active,
    className: `land-temporal-scope-link${active ? " on" : ""}`,
    attributes: { "data-land-temporal-scope-link": "closing_week", "data-scope-edge": "land.time.closing_week", "data-filter-href": landClosingWeekHash(currentHash, !active) },
    escape,
  })}</div>`;
}
