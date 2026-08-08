/** Shareable attendance links for the Zoning hearing view. */

import { routeHashFromScope, scopeFromRouteHash } from "./scope_v0.mjs";

export const ATTENDANCE_SCOPE_LINKS_SCHEMA = "cityscroll.attendance_scope_links.v1";
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
  return routeHashFromScope(scope, { surface: "land" });
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
    return `<a class="chip attendance-scope-link${isActive ? " on" : ""}" href="${escape(href)}" data-attendance-scope-link="${escape(id || "all")}" data-scope-edge="${escape(edge)}"${isActive ? ' aria-current="page"' : ""}>${escape(t(labelKey))}</a>`;
  }).join("");
  return `<div class="attendance-scope-links" data-attendance-scope="land" role="group" aria-label="${escape(t("land_hearings_mode_label"))}">${links}</div>`;
}
