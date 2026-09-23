import assert from "node:assert/strict";
import test from "node:test";

import {
  DOCUMENT_ROUTE_SCROLL_KEY_PREFIX,
  DOCUMENT_ROUTE_SCROLL_SCHEMA,
  bindDocumentRouteScroll,
  clearDocumentRouteScrollEntry,
  documentRouteScrollKey,
  isDocumentHistoryTraversal,
  normalizeDocumentRouteScrollPoint,
  readDocumentRouteScrollEntry,
  rememberDocumentRouteScroll,
  restoreDocumentRouteScroll,
  takeDocumentRouteScrollEntry,
  writeDocumentRouteScrollEntry,
} from "../site/document_route_scroll.mjs";

function makeStorage() {
  const map = new Map();
  return {
    getItem(key) {
      return map.has(key) ? map.get(key) : null;
    },
    setItem(key, value) {
      map.set(String(key), String(value));
    },
    removeItem(key) {
      map.delete(String(key));
    },
  };
}

function makeWindow({
  href = "https://cityscroll.org/near-you/?geo=nta2020%3AMN0102&lens=meetings&surface=records",
  navigationType = "back_forward",
  scrollY = 0,
} = {}) {
  const url = new URL(href);
  const sessionStorage = makeStorage();
  const listeners = new Map();
  let y = scrollY;
  let x = 0;
  const win = {
    location: {
      pathname: url.pathname,
      search: url.search,
      hash: url.hash,
      href: url.toString(),
    },
    sessionStorage,
    performance: {
      getEntriesByType(type) {
        return type === "navigation" ? [{ type: navigationType }] : [];
      },
    },
    get scrollX() {
      return x;
    },
    get scrollY() {
      return y;
    },
    scrollTo(nextX, nextY) {
      x = Number(nextX) || 0;
      y = Number(nextY) || 0;
    },
    setTimeout(fn) {
      fn();
      return 1;
    },
    requestAnimationFrame(fn) {
      fn();
      return 1;
    },
    addEventListener(type, handler) {
      const list = listeners.get(type) || [];
      list.push(handler);
      listeners.set(type, list);
    },
    removeEventListener(type, handler) {
      const list = listeners.get(type) || [];
      listeners.set(type, list.filter((row) => row !== handler));
    },
    __listeners: listeners,
  };
  return win;
}

test("document route scroll schema and key cover pathname search and hash", () => {
  assert.equal(DOCUMENT_ROUTE_SCROLL_SCHEMA, "cityscroll.document_route_scroll.v1");
  assert.equal(
    documentRouteScrollKey({
      pathname: "/near-you/",
      search: "?geo=nta2020%3AMN0102",
      hash: "",
    }),
    `${DOCUMENT_ROUTE_SCROLL_KEY_PREFIX}/near-you/?geo=nta2020%3AMN0102`,
  );
  assert.equal(normalizeDocumentRouteScrollPoint(1127.4), 1127);
});

test("remembered scroll is restored only on back_forward traversals", () => {
  const back = makeWindow({ navigationType: "back_forward", scrollY: 1127 });
  assert.equal(isDocumentHistoryTraversal(back), true);
  assert.equal(rememberDocumentRouteScroll(back), true);
  assert.deepEqual(
    readDocumentRouteScrollEntry(back.sessionStorage, back.location),
    { x: 0, y: 1127 },
  );

  back.scrollTo(0, 1367);
  assert.equal(restoreDocumentRouteScroll(back, { maxAttempts: 3, intervalMs: 0 }), true);
  assert.equal(back.scrollY, 1127);
  assert.equal(readDocumentRouteScrollEntry(back.sessionStorage, back.location), null);

  const cold = makeWindow({ navigationType: "navigate", scrollY: 900 });
  writeDocumentRouteScrollEntry(cold.sessionStorage, cold.location, { x: 0, y: 900 });
  assert.equal(restoreDocumentRouteScroll(cold), false);
  assert.equal(cold.scrollY, 900);
  assert.deepEqual(
    readDocumentRouteScrollEntry(cold.sessionStorage, cold.location),
    { x: 0, y: 900 },
  );
});

test("pagehide binding remembers the leaving offset for the current document URL", () => {
  const win = makeWindow({ scrollY: 1623 });
  const binding = bindDocumentRouteScroll(win);
  assert.ok(binding);
  for (const handler of win.__listeners.get("pagehide") || []) handler();
  assert.deepEqual(
    takeDocumentRouteScrollEntry(win),
    { x: 0, y: 1623 },
  );
  clearDocumentRouteScrollEntry(win.sessionStorage, win.location);
  binding.destroy();
});

test("restore retries until the remembered offset sticks after late layout shifts", () => {
  const win = makeWindow({ navigationType: "back_forward", scrollY: 1127 });
  rememberDocumentRouteScroll(win);
  let calls = 0;
  win.scrollTo = (nextX, nextY) => {
    calls += 1;
    win.__x = Number(nextX) || 0;
    // First two paints emulate scroll anchoring drifting away from the target.
    win.__y = calls < 3 ? 1367 : Number(nextY) || 0;
  };
  Object.defineProperty(win, "scrollX", { get: () => win.__x || 0 });
  Object.defineProperty(win, "scrollY", { get: () => win.__y || 0 });

  const timers = [];
  assert.equal(
    restoreDocumentRouteScroll(win, {
      maxAttempts: 5,
      intervalMs: 0,
      schedule: (fn) => {
        timers.push(fn);
        return timers.length;
      },
      frame: (fn) => fn(),
    }),
    true,
  );
  while (timers.length) timers.shift()();
  assert.equal(win.scrollY, 1127);
  assert.ok(calls >= 3);
});
