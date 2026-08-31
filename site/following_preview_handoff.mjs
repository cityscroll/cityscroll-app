/**
 * Compact Following create-flow handoff.
 *
 * Carries a reviewed watch (lens + filter + cadence) plus optional preview
 * focus and the canonical origin route. It is not a second watch contract:
 * save still posts the ordinary {lens, filter, freq} subscribe body.
 */

export const FOLLOWING_PREVIEW_HANDOFF_SCHEMA = "cityscroll.following_preview_handoff.v1";

export const FOLLOWING_HANDOFF_LENSES = Object.freeze([
  "money", "people", "land", "property", "rules", "meetings", "district", "entity", "mandates",
  "legal_code",
]);

export const FOLLOWING_HANDOFF_LENS_ALIASES = Object.freeze({
  obligations: "mandates",
  award: "money",
});

const FOCUS_ID = /^[A-Za-z0-9_-]{4,40}$/;

function compactFilter(filter) {
  const out = {};
  if (!filter || typeof filter !== "object" || Array.isArray(filter)) return out;
  for (const [key, value] of Object.entries(filter)) {
    if (value == null || value === "" || value === false) continue;
    if (Array.isArray(value) && value.length === 0) continue;
    out[key] = value;
  }
  return out;
}

function cleanFrequency(value) {
  return String(value || "").toLowerCase() === "weekly" ? "weekly" : "daily";
}

function cleanCount(value) {
  if (value == null || value === "") return null;
  const count = Number(value);
  return Number.isInteger(count) && count >= 0 && count <= 10000 ? count : null;
}

export function reviewedFollowingLens(lens) {
  const raw = String(lens || "").trim().toLowerCase();
  if (!raw) return { lens: null, status: "missing_scope", alias: false, raw: null };
  const mapped = FOLLOWING_HANDOFF_LENS_ALIASES[raw] || raw;
  if (!FOLLOWING_HANDOFF_LENSES.includes(mapped)) {
    return { lens: null, status: "unrecognized_scope", alias: false, raw };
  }
  return { lens: mapped, status: "ok", alias: mapped !== raw, raw };
}

export function cleanFollowingFocusId(value) {
  const id = String(value || "").trim();
  return FOCUS_ID.test(id) ? id : null;
}

export function cleanFollowingOriginRoute(value) {
  const raw = String(value || "").trim();
  if (!raw.startsWith("/") || raw.startsWith("//")) return null;
  if (raw.length > 500) return null;
  if (/[<>\\\s]/.test(raw)) return null;
  if (/^[a-z][a-z0-9+.-]*:/i.test(raw)) return null;
  const path = raw.split("#")[0];
  if (!path.startsWith("/")) return null;
  if (/^\/following\/?(?:\?|$)/.test(path)) return null;
  return path;
}

function emptyHandoff(status = "missing_scope") {
  return Object.freeze({
    schema: FOLLOWING_PREVIEW_HANDOFF_SCHEMA,
    status,
    lens: null,
    filter: Object.freeze({}),
    frequency: "daily",
    matchCount: null,
    focus: null,
    originRoute: null,
  });
}

function originFromFocus(focus) {
  if (!focus?.id) return null;
  if (focus.kind === "notice") return `/notices/${focus.id}/`;
  if (focus.kind === "project") return `/browse/zoning/`;
  return null;
}

function focusFromIds(noticeId, projectId) {
  const notice = cleanFollowingFocusId(noticeId);
  if (notice) return Object.freeze({ kind: "notice", id: notice });
  const project = cleanFollowingFocusId(projectId);
  if (project) return Object.freeze({ kind: "project", id: project });
  return null;
}

export function followingPreviewHandoffFromScope(scope = {}, options = {}) {
  const reviewed = reviewedFollowingLens(scope.lens);
  if (reviewed.status !== "ok") return emptyHandoff(scope.lens ? "unrecognized_scope" : "missing_scope");
  const filter = compactFilter(scope.filter);
  const focus = focusFromIds(
    options.noticeId ?? scope.noticeId,
    options.projectId ?? scope.projectId,
  );
  const originRoute = cleanFollowingOriginRoute(options.originRoute ?? scope.originRoute)
    || originFromFocus(focus);
  return Object.freeze({
    schema: FOLLOWING_PREVIEW_HANDOFF_SCHEMA,
    status: "ok",
    lens: reviewed.lens,
    filter: Object.freeze(filter),
    frequency: cleanFrequency(options.frequency ?? scope.freq ?? scope.frequency),
    matchCount: cleanCount(options.matchCount ?? scope.matchCount),
    focus,
    originRoute,
  });
}

export function followingPreviewHandoffFromParams(input) {
  const params = input instanceof URLSearchParams
    ? input
    : new URL(input, "https://cityscroll.invalid").searchParams;
  const hasScopeToken = params.has("lens") || params.has("filter") || params.has("q")
    || params.has("agency") || params.has("boro") || params.has("council")
    || params.has("boardBorough") || params.has("boardNumber")
    || params.has("notice") || params.has("project");
  const reviewed = reviewedFollowingLens(params.get("lens"));
  if (params.has("lens") && reviewed.status === "unrecognized_scope") {
    return Object.freeze({
      ...emptyHandoff("unrecognized_scope"),
      frequency: cleanFrequency(params.get("freq")),
      matchCount: cleanCount(params.get("count")),
      focus: focusFromIds(params.get("notice"), params.get("project")),
      originRoute: cleanFollowingOriginRoute(params.get("from")),
    });
  }
  if (!hasScopeToken) return emptyHandoff("missing_scope");
  let filter = {};
  try {
    const parsed = JSON.parse(params.get("filter") || "{}");
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) filter = parsed;
  } catch { /* malformed JSON stays an empty reviewed filter */ }
  const lens = reviewed.lens || "money";
  const focus = focusFromIds(params.get("notice"), params.get("project"));
  return Object.freeze({
    schema: FOLLOWING_PREVIEW_HANDOFF_SCHEMA,
    status: "ok",
    lens,
    filter: Object.freeze(compactFilter(filter)),
    frequency: cleanFrequency(params.get("freq")),
    matchCount: cleanCount(params.get("count")),
    focus,
    originRoute: cleanFollowingOriginRoute(params.get("from")) || originFromFocus(focus),
  });
}

export function applyFollowingPreviewHandoffParams(params, handoff, { includeScope = false } = {}) {
  if (!params || !handoff || handoff.status !== "ok") return params;
  if (includeScope && handoff.lens) {
    params.set("lens", handoff.lens);
    params.set("filter", JSON.stringify(handoff.filter || {}));
  }
  if (handoff.frequency === "daily" || handoff.frequency === "weekly") {
    params.set("freq", handoff.frequency);
  }
  if (handoff.matchCount != null) params.set("count", String(handoff.matchCount));
  if (handoff.focus?.kind === "notice") {
    params.set("notice", handoff.focus.id);
    params.delete("project");
  } else if (handoff.focus?.kind === "project") {
    params.set("project", handoff.focus.id);
    params.delete("notice");
  }
  if (handoff.originRoute) params.set("from", handoff.originRoute);
  return params;
}

export function followingFocusHref(handoff) {
  if (!handoff) return null;
  if (handoff.focus?.kind === "notice") return `/notices/${handoff.focus.id}/`;
  if (handoff.originRoute) return handoff.originRoute;
  if (handoff.focus?.kind === "project") return "/browse/zoning/";
  return null;
}

export function previewItemMatchesFocus(item, handoff) {
  const id = handoff?.focus?.id;
  if (!id || !item) return false;
  const itemId = String(item.id || "");
  const url = String(item.url || "");
  if (itemId === id) return true;
  if (itemId.endsWith(`:${id}`) || itemId.includes(id)) return true;
  if (url.includes(`/${id}`) || url.includes(id)) return true;
  return false;
}

export function pinFollowingPreviewItems(items, handoff) {
  const rows = Array.isArray(items) ? items.slice(0, 5) : [];
  if (!handoff?.focus?.id) return rows;
  const index = rows.findIndex((item) => previewItemMatchesFocus(item, handoff));
  if (index <= 0) return rows;
  const next = rows.slice();
  const [hit] = next.splice(index, 1);
  next.unshift(hit);
  return next;
}
