/**
 * Document-route scroll continuity for multi-page Near You journeys.
 *
 * Hash-route scroll already lives in `site/app/routing.mjs`. Near You is a
 * separate document island (`/near-you/` → `/notices/…` → Back) that loads
 * deferred results and overlap chrome after the first paint. Browser scroll
 * restoration can land correctly, then scroll anchoring from those late
 * insertions moves the viewport. This module remembers the leaving offset on
 * `pagehide` and re-applies it after the island settles on a back/forward
 * traversal.
 */

export const DOCUMENT_ROUTE_SCROLL_SCHEMA = "cityscroll.document_route_scroll.v1";
export const DOCUMENT_ROUTE_SCROLL_KEY_PREFIX = "cityscroll:route-scroll:";

const boundWindows = new WeakSet();

function asWindow(value) {
  if (value && typeof value === "object") return value;
  if (typeof globalThis !== "undefined" && globalThis.window) return globalThis.window;
  return null;
}

export function isDocumentHistoryTraversal(win = globalThis) {
  const target = asWindow(win);
  if (!target?.performance?.getEntriesByType) return false;
  try {
    return target.performance.getEntriesByType("navigation")[0]?.type === "back_forward";
  } catch {
    return false;
  }
}

export function documentRouteScrollKey(locationLike) {
  const location = locationLike || asWindow()?.location;
  if (!location) return `${DOCUMENT_ROUTE_SCROLL_KEY_PREFIX}/`;
  return `${DOCUMENT_ROUTE_SCROLL_KEY_PREFIX}${location.pathname || ""}${location.search || ""}${location.hash || ""}`;
}

export function normalizeDocumentRouteScrollPoint(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 0;
  return Math.round(number);
}

export function readDocumentRouteScrollEntry(storage, locationLike) {
  if (!storage || typeof storage.getItem !== "function") return null;
  try {
    const parsed = JSON.parse(storage.getItem(documentRouteScrollKey(locationLike)) || "null");
    if (!Number.isFinite(parsed?.x) || !Number.isFinite(parsed?.y)) return null;
    return {
      x: normalizeDocumentRouteScrollPoint(parsed.x),
      y: normalizeDocumentRouteScrollPoint(parsed.y),
    };
  } catch {
    return null;
  }
}

export function writeDocumentRouteScrollEntry(storage, locationLike, point) {
  if (!storage || typeof storage.setItem !== "function") return false;
  try {
    storage.setItem(
      documentRouteScrollKey(locationLike),
      JSON.stringify({
        x: normalizeDocumentRouteScrollPoint(point?.x),
        y: normalizeDocumentRouteScrollPoint(point?.y),
      }),
    );
    return true;
  } catch {
    return false;
  }
}

export function clearDocumentRouteScrollEntry(storage, locationLike) {
  if (!storage || typeof storage.removeItem !== "function") return;
  try {
    storage.removeItem(documentRouteScrollKey(locationLike));
  } catch {
    // Best-effort cleanup only.
  }
}

export function rememberDocumentRouteScroll(win = globalThis) {
  const target = asWindow(win);
  if (!target?.location) return false;
  return writeDocumentRouteScrollEntry(
    target.sessionStorage,
    target.location,
    {
      x: target.scrollX || 0,
      y: target.scrollY || 0,
    },
  );
}

export function takeDocumentRouteScrollEntry(win = globalThis) {
  const target = asWindow(win);
  if (!target?.location) return null;
  const entry = readDocumentRouteScrollEntry(target.sessionStorage, target.location);
  if (entry) clearDocumentRouteScrollEntry(target.sessionStorage, target.location);
  return entry;
}

/**
 * Re-apply a remembered document scroll point with short retries so deferred
 * result and overlap insertions cannot leave the reader stranded.
 */
export function restoreDocumentRouteScroll(win = globalThis, options = {}) {
  const target = asWindow(win);
  if (!target || typeof target.scrollTo !== "function") return false;
  const onlyBackForward = options.onlyBackForward !== false;
  if (onlyBackForward && !isDocumentHistoryTraversal(target)) return false;

  const entry = options.entry || takeDocumentRouteScrollEntry(target);
  if (!entry) return false;

  const maxAttempts = Number.isFinite(options.maxAttempts) ? Math.max(1, options.maxAttempts) : 40;
  const intervalMs = Number.isFinite(options.intervalMs) ? Math.max(0, options.intervalMs) : 50;
  const schedule = typeof options.schedule === "function"
    ? options.schedule
    : (fn, wait) => {
      const timer = target.setTimeout || globalThis.setTimeout;
      if (typeof timer === "function") return timer(fn, wait);
      fn();
      return 0;
    };
  const frame = typeof options.frame === "function"
    ? options.frame
    : (fn) => {
      if (typeof target.requestAnimationFrame === "function") return target.requestAnimationFrame(fn);
      return schedule(fn, 0);
    };

  let attempts = 0;
  let active = true;
  const apply = () => {
    if (!active) return false;
    target.scrollTo(entry.x, entry.y);
    attempts += 1;
    const y = normalizeDocumentRouteScrollPoint(target.scrollY || 0);
    const closeEnough = Math.abs(y - entry.y) <= 2;
    if (closeEnough || attempts >= maxAttempts) {
      active = false;
      return closeEnough;
    }
    schedule(apply, intervalMs);
    return false;
  };

  frame(apply);
  return true;
}

export function bindDocumentRouteScroll(win = globalThis) {
  const target = asWindow(win);
  if (!target || typeof target.addEventListener !== "function") return null;
  if (boundWindows.has(target)) return { alreadyBound: true };
  boundWindows.add(target);

  const onPageHide = () => {
    rememberDocumentRouteScroll(target);
  };
  target.addEventListener("pagehide", onPageHide);

  return {
    destroy() {
      target.removeEventListener("pagehide", onPageHide);
      boundWindows.delete(target);
    },
  };
}
