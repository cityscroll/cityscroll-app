/**
 * Browse-return context: resume the item a reader was inspecting.
 *
 * Calendar route and scroll restoration already live on the history entry
 * (`cityscrollRoute.entry`). What they do not restore is *which* event had
 * focus. After an intentional same-origin full-page visit, Browser Back can
 * keep `#now?calview=calendar` and the scroll offset while dropping keyboard
 * focus on the document body.
 *
 * This module is the missing half of that round trip. It is presentation
 * state, twice over: it never narrows a result set, and it is never
 * serialized into a shareable route, a Follow, a Browse, a project, a watch,
 * or a subscription scope. The history entry is the only copy, so Back and
 * Forward reverse it and a copied URL still describes the population, not
 * one reader's last click.
 *
 * Every mounted calendar inherits this through `bindCompactMonthCalendar`.
 * Search and Following keep their own preview/scope machinery; this module
 * does not wrap unrelated links in a preview.
 */

import {
  CALENDAR_VIEW_CALENDAR,
  CALENDAR_VIEW_LIST,
  calendarViewFromRouteHash,
  isKnownCalendarView,
  normalizeCalendarView,
} from "./calendar_display_state.mjs";

export const BROWSE_RETURN_CONTEXT_SCHEMA = "cityscroll.browse_return_context.v1";
export const BROWSE_RETURN_HISTORY_KEY = "browseReturn";
export const BROWSE_RETURN_TTL_MS = 30 * 60 * 1000;
export const BROWSE_RETURN_READY_ATTRIBUTE = "data-browse-return-ready";

const UID_MAX = 200;
const SCOPE_MAX = 3000;
const HREF_MAX = 2000;
const APPEARANCE_MAX = 99;

const boundBrowseReturnRoots = new WeakSet();

function asText(value, max) {
  const text = String(value ?? "").replace(/[\u0000-\u001f\u007f]/g, "").trim();
  if (!text || text.length > max) return null;
  return text;
}

function asAppearance(value) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 0 || number > APPEARANCE_MAX) return 0;
  return number;
}

function asView(value) {
  if (value == null || value === "") return null;
  return isKnownCalendarView(value) ? normalizeCalendarView(value) : null;
}

function asCreatedAt(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.round(number) : null;
}

function asInvoker(value) {
  return value === "link" ? "link" : "preview";
}

function asHref(value) {
  const href = asText(value, HREF_MAX);
  if (!href) return null;
  if (/^[a-z][a-z0-9+.-]*:/i.test(href) && !/^https?:/i.test(href)) return null;
  if (href.toLowerCase().startsWith("javascript:")) return null;
  return href;
}

function asScope(value) {
  const scope = asText(value, SCOPE_MAX);
  if (!scope) return null;
  if (scope[0] !== "#" && scope[0] !== "/") return null;
  return scope;
}

function asDay(value) {
  const day = asText(value, 10);
  return day && /^\d{4}-\d{2}-\d{2}$/.test(day) ? day : null;
}

/**
 * A return token is accepted only when it names a real item against a real
 * listing. Anything else is dropped rather than restored.
 */
export function normalizeBrowseReturnContext(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  if (value.schema != null && value.schema !== BROWSE_RETURN_CONTEXT_SCHEMA) return null;
  const uid = asText(value.uid, UID_MAX);
  const href = asHref(value.href);
  if (!uid || !href) return null;
  const createdAt = asCreatedAt(value.createdAt);
  if (createdAt == null) return null;
  return Object.freeze({
    schema: BROWSE_RETURN_CONTEXT_SCHEMA,
    uid,
    href,
    appearance: asAppearance(value.appearance),
    invoker: asInvoker(value.invoker),
    createdAt,
    scope: asScope(value.scope),
    view: asView(value.view),
    day: asDay(value.day),
  });
}

export function createBrowseReturnContext(input = {}, now = Date.now()) {
  return normalizeBrowseReturnContext({
    schema: BROWSE_RETURN_CONTEXT_SCHEMA,
    uid: input.uid,
    href: input.href,
    appearance: input.appearance,
    invoker: input.invoker,
    createdAt: input.createdAt ?? now,
    scope: input.scope,
    view: input.view,
    day: input.day,
  });
}

export function browseReturnFromHistoryState(state) {
  const route = state && typeof state === "object" && !Array.isArray(state)
    ? state.cityscrollRoute
    : null;
  return normalizeBrowseReturnContext(route && typeof route === "object" ? route[BROWSE_RETURN_HISTORY_KEY] : null);
}

/** History-state patch that remembers, or forgets, one return token. */
export function browseReturnHistoryPatch(context) {
  return { [BROWSE_RETURN_HISTORY_KEY]: normalizeBrowseReturnContext(context) };
}

export function browseReturnIsExpired(context, now = Date.now()) {
  const normalized = normalizeBrowseReturnContext(context);
  if (!normalized) return true;
  if (normalized.createdAt > now) return true;
  return now - normalized.createdAt > BROWSE_RETURN_TTL_MS;
}

export function browseReturnMatchesSurface(context, { scope = null, view = null } = {}) {
  const normalized = normalizeBrowseReturnContext(context);
  if (!normalized) return false;
  if (normalized.scope && scope && normalized.scope !== scope) return false;
  if (normalized.view && view && normalized.view !== view) return false;
  return true;
}

/**
 * Restore only after an explicit return (Back/Forward or a persisted history
 * entry). A cold visit, a reload, and a missing or expired token leave focus
 * where the browser put it.
 */
export function shouldRestoreBrowseReturn({
  context,
  navigationType = "navigate",
  persisted = false,
  now = Date.now(),
  scope = null,
  view = null,
} = {}) {
  const normalized = normalizeBrowseReturnContext(context);
  if (!normalized) return false;
  if (browseReturnIsExpired(normalized, now)) return false;
  if (!browseReturnMatchesSurface(normalized, { scope, view })) return false;
  if (persisted === true) return true;
  return navigationType === "back_forward";
}

export function browseReturnScopeFromLocation(location) {
  if (!location) return null;
  const hash = asScope(location.hash);
  if (hash) return hash;
  const path = asText(location.pathname, SCOPE_MAX);
  if (!path || path[0] !== "/") return null;
  const search = typeof location.search === "string" ? location.search : "";
  return asScope(`${path}${search}`);
}

export function browseReturnViewFromLocation(location) {
  const scope = browseReturnScopeFromLocation(location);
  if (scope && scope[0] === "#") return calendarViewFromRouteHash(scope);
  return null;
}

export function appearanceIndexForUid(nodes, uid, node) {
  const matches = [];
  for (const candidate of nodes || []) {
    if (candidate && candidate.getAttribute?.("data-calendar-event-preview-uid") === uid) {
      matches.push(candidate);
    }
  }
  const index = matches.indexOf(node);
  return index >= 0 ? index : 0;
}

/**
 * Where focus belongs after a return. An exact uid+appearance match wins;
 * a uid that has moved in the list is still the same event; a missing
 * invoker falls back to the calendar/list heading. Never none, never a loop.
 */
export function resolveBrowseReturnFocus({ context, candidates = [], heading = null } = {}) {
  const normalized = normalizeBrowseReturnContext(context);
  if (!normalized) {
    return heading ? { kind: "heading", node: heading } : { kind: "none", node: null };
  }
  const rows = Array.isArray(candidates) ? candidates.filter((row) => row && row.node) : [];
  const sameUid = rows.filter((row) => row.uid === normalized.uid);
  const exact = sameUid.find((row) => row.appearance === normalized.appearance)
    || (normalized.day ? sameUid.find((row) => row.day === normalized.day) : null);
  const item = exact || sameUid[0] || null;
  if (item) return { kind: "item", node: item.node, invoker: normalized.invoker };
  if (heading) return { kind: "heading", node: heading };
  return { kind: "none", node: null };
}

function ownerDocument(root) {
  if (!root) return typeof document === "undefined" ? null : document;
  if (typeof root.querySelectorAll !== "function") return null;
  return root.ownerDocument || (root.nodeType === 9 ? root : null);
}

function isUnmodifiedActivation(event) {
  if (!event || event.defaultPrevented) return false;
  if (event.button != null && event.button !== 0) return false;
  return !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey;
}

function destinationFromHref(href, locationObj) {
  try {
    return new URL(href, locationObj?.href || "https://cityscroll.org/");
  } catch {
    return null;
  }
}

function isSameOriginInternalHref(href, locationObj) {
  const destination = destinationFromHref(href, locationObj);
  if (!destination || !/^https?:$/i.test(destination.protocol)) return false;
  const origin = locationObj?.origin;
  if (origin) return destination.origin === origin;
  return destination.hostname === "cityscroll.org";
}

function currentHistoryState(historyObj) {
  const state = historyObj && historyObj.state;
  return state && typeof state === "object" && !Array.isArray(state) ? state : {};
}

export function writeBrowseReturnHistory(historyObj, context, locationObj) {
  if (!historyObj || typeof historyObj.replaceState !== "function") return false;
  const patch = browseReturnHistoryPatch(context);
  try {
    const current = currentHistoryState(historyObj);
    const build = typeof globalThis !== "undefined" ? globalThis.routeHistoryState : null;
    const next = typeof build === "function"
      ? build(patch)
      : {
        ...current,
        cityscrollRoute: {
          ...(current.cityscrollRoute && typeof current.cityscrollRoute === "object" ? current.cityscrollRoute : {}),
          ...patch,
        },
      };
    historyObj.replaceState(next, "", locationObj?.href || "");
    return true;
  } catch {
    // A history or storage that will not take a note is not a reason to trap
    // the click or to steal focus later.
    return false;
  }
}

function headingFor(root, doc) {
  const month = root.querySelector?.(".compact-month") || doc?.querySelector?.(".compact-month");
  if (month) return month;
  return root.querySelector?.("h1, h2, [data-browse-return-heading]")
    || doc?.querySelector?.("h1, h2, [data-browse-return-heading]")
    || null;
}

function collectCandidates(root) {
  const rows = [];
  const buttons = [...(root.querySelectorAll?.("[data-calendar-event-preview-uid]") || [])];
  const seen = new Map();
  for (const button of buttons) {
    const uid = button.getAttribute("data-calendar-event-preview-uid");
    if (!uid) continue;
    const appearance = seen.get(uid) || 0;
    seen.set(uid, appearance + 1);
    const item = button.closest?.(".compact-month-occ") || button.parentNode;
    const link = item?.querySelector?.(".compact-month-occ-link") || null;
    const day = button.closest?.("[data-compact-month-day]")?.getAttribute("data-compact-month-day") || null;
    rows.push({
      uid,
      appearance,
      day,
      href: link?.getAttribute?.("href") || "",
      preview: button,
      link,
      item,
    });
  }
  return rows;
}

function focusNode(node) {
  if (!node || typeof node.focus !== "function") return null;
  if (node.nodeType === 1 && !node.hasAttribute("tabindex") && !/^(a|button|input|select|textarea)$/i.test(node.tagName || "")) {
    node.setAttribute("tabindex", "-1");
  }
  node.focus();
  return node;
}

function targetNode(resolved, candidate) {
  if (!resolved || resolved.kind === "none") return null;
  if (resolved.kind === "heading") return resolved.node;
  if (!candidate) return resolved.node;
  if (resolved.invoker === "link" && candidate.link) return candidate.link;
  return candidate.preview || candidate.link || resolved.node;
}

function readNavigationType(options) {
  if (options.navigationType) return options.navigationType;
  try {
    const nav = globalThis.performance?.getEntriesByType?.("navigation")?.[0];
    if (nav && typeof nav.type === "string") return nav.type;
    const legacy = globalThis.performance?.navigation?.type;
    if (legacy === 2) return "back_forward";
    if (legacy === 1) return "reload";
  } catch {
    // A missing Performance API is a cold visit, not a return.
  }
  return "navigate";
}

/**
 * Restore focus for a remembered item when this document is a return.
 * Exported so a test can drive the same decision the binder makes on bind.
 */
export function restoreBrowseReturnFocus(root, options = {}) {
  const doc = ownerDocument(root);
  if (!doc) return null;
  const historyObj = options.history || globalThis.history;
  const locationObj = options.location || globalThis.location;
  const context = options.context || browseReturnFromHistoryState(historyObj?.state);
  const scope = options.scope || browseReturnScopeFromLocation(locationObj);
  const view = options.view !== undefined ? options.view : browseReturnViewFromLocation(locationObj);
  if (!shouldRestoreBrowseReturn({
    context,
    navigationType: readNavigationType(options),
    persisted: options.persisted === true,
    now: options.now ?? Date.now(),
    scope,
    view,
  })) return null;

  const active = doc.activeElement;
  if (active && active !== doc.body && active !== doc.documentElement && options.steal !== true) {
    // A reader who already focused a control on this document keeps it.
    if (active !== root && root.contains?.(active)) return active;
    if (active.closest?.(".compact-month-occ, .calendar-event-preview-dialog")) return active;
  }

  const candidates = collectCandidates(root);
  const mapped = candidates.map((row) => ({
    uid: row.uid,
    appearance: row.appearance,
    day: row.day,
    node: row.preview || row.link || row.item,
    invoker: row.preview ? "preview" : "link",
    row,
  }));
  const heading = headingFor(root, doc);
  const resolved = resolveBrowseReturnFocus({ context, candidates: mapped, heading });
  const candidate = resolved.kind === "item"
    ? mapped.find((row) => row.node === resolved.node)
    : null;
  return focusNode(targetNode(resolved, candidate?.row || candidate));
}

function contextFromControl(control, locationObj, now, invoker) {
  const uid = control.getAttribute("data-calendar-event-preview-uid")
    || control.closest?.("[data-compact-month-occ-uid]")?.getAttribute("data-compact-month-occ-uid");
  const item = control.closest?.(".compact-month-occ") || control.parentNode;
  const link = control.matches?.(".compact-month-occ-link")
    ? control
    : item?.querySelector?.(".compact-month-occ-link");
  const href = link?.getAttribute?.("href") || control.getAttribute("href");
  if (!uid || !href) return null;
  const root = control.closest?.("[data-browse-return-ready]") || control.ownerDocument;
  const nodes = root?.querySelectorAll?.("[data-calendar-event-preview-uid]") || [];
  const preview = item?.querySelector?.("[data-calendar-event-preview-uid]") || control;
  return createBrowseReturnContext({
    uid,
    href,
    appearance: appearanceIndexForUid(nodes, uid, preview),
    invoker,
    scope: browseReturnScopeFromLocation(locationObj),
    view: browseReturnViewFromLocation(locationObj),
    day: control.closest?.("[data-compact-month-day]")?.getAttribute("data-compact-month-day"),
  }, now);
}

function contextFromPreviewOpen(control, dialog, locationObj, now) {
  const uid = dialog?.getAttribute("data-browse-return-uid")
    || control.getAttribute("data-browse-return-uid");
  const href = control.getAttribute("href");
  if (!uid || !href) return null;
  return createBrowseReturnContext({
    uid,
    href,
    appearance: asAppearance(dialog?.getAttribute("data-browse-return-appearance")),
    invoker: "preview",
    scope: browseReturnScopeFromLocation(locationObj),
    view: browseReturnViewFromLocation(locationObj),
    day: asDay(dialog?.getAttribute("data-browse-return-day")),
  }, now);
}

/**
 * Mount return-context remembering on one calendar container. Idempotent and
 * delegated. Never cancels a navigation, never intercepts a modified click,
 * and never writes a query parameter.
 */
export function bindBrowseReturnContext(root, options = {}) {
  const doc = ownerDocument(root);
  if (!doc || typeof doc.createElement !== "function") return null;
  const scope = root && typeof root.querySelectorAll === "function" ? root : doc;
  if (boundBrowseReturnRoots.has(scope)) return null;
  boundBrowseReturnRoots.add(scope);
  if (typeof scope.setAttribute === "function") scope.setAttribute(BROWSE_RETURN_READY_ATTRIBUTE, "");

  const historyObj = options.history || globalThis.history;
  const locationObj = options.location || globalThis.location;
  const now = () => options.now ?? Date.now();

  const rememberFromEvent = (event) => {
    if (!isUnmodifiedActivation(event)) return;
    const target = event.target && typeof event.target.closest === "function" ? event.target : null;
    if (!target) return;
    const previewOpen = target.closest("[data-calendar-event-preview-open]");
    if (previewOpen) {
      const href = previewOpen.getAttribute("href");
      if (!isSameOriginInternalHref(href, locationObj)) return;
      const dialog = previewOpen.closest("dialog") || doc.getElementById("calendar-event-preview");
      const context = contextFromPreviewOpen(previewOpen, dialog, locationObj, now());
      if (context) writeBrowseReturnHistory(historyObj, context, locationObj);
      return;
    }
    const link = target.closest(".compact-month-occ-link");
    if (!link || (typeof scope.contains === "function" && !scope.contains(link))) return;
    const href = link.getAttribute("href");
    if (!isSameOriginInternalHref(href, locationObj)) return;
    const destination = destinationFromHref(href, locationObj);
    if (destination && locationObj?.href && destination.href === locationObj.href) return;
    const context = contextFromControl(link, locationObj, now(), "link");
    if (context) writeBrowseReturnHistory(historyObj, context, locationObj);
  };

  scope.addEventListener("click", rememberFromEvent);
  if (typeof scope.contains !== "function" || !scope.contains(doc.getElementById?.("calendar-event-preview"))) {
    doc.addEventListener("click", rememberFromEvent);
  }

  const restore = (extra = {}) => restoreBrowseReturnFocus(scope, {
    history: historyObj,
    location: locationObj,
    now: now(),
    navigationType: options.navigationType,
    persisted: extra.persisted,
    ...extra,
  });

  if (options.restore !== false) restore();

  const onPageShow = (event) => {
    restore({ persisted: Boolean(event?.persisted), navigationType: event?.persisted ? "back_forward" : readNavigationType(options) });
  };
  const pageShowTarget = options.window || (typeof window !== "undefined" ? window : doc.defaultView);
  if (pageShowTarget && typeof pageShowTarget.addEventListener === "function") {
    pageShowTarget.addEventListener("pageshow", onPageShow);
  }

  return {
    restore,
    destroy() {
      scope.removeEventListener("click", rememberFromEvent);
      doc.removeEventListener("click", rememberFromEvent);
      if (pageShowTarget && typeof pageShowTarget.removeEventListener === "function") {
        pageShowTarget.removeEventListener("pageshow", onPageShow);
      }
      boundBrowseReturnRoots.delete(scope);
    },
  };
}

export const BROWSE_RETURN_VIEWS = Object.freeze([CALENDAR_VIEW_CALENDAR, CALENDAR_VIEW_LIST]);
