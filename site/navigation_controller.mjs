// Latest-wins navigation controller: one live navigation at a time, with a
// counted URL-write suppression that never blocks a route from being applied.
export const NAV = Object.freeze({
  RESOLVING: "resolving",
  LOADING: "loading",
  RENDERING: "rendering",
  FOCUSING: "focusing",
  SETTLED: "settled",
  SUPERSEDED: "superseded",
  FAILED: "failed",
});
const ORDER = [NAV.RESOLVING, NAV.LOADING, NAV.RENDERING, NAV.FOCUSING, NAV.SETTLED];
const TERMINAL = new Set([NAV.SETTLED, NAV.SUPERSEDED, NAV.FAILED]);

export function createNavigator() {
  let seq = 0;
  let active = null;
  let settledRoute = null;
  let suppressed = 0;
  const navs = new Map();
  const listeners = [];
  const log = [];
  const record = (id, state) => {
    navs.get(id).state = state;
    log.push(`${id}:${state}`);
  };
  return {
    onSettled(fn) {
      listeners.push(fn);
    },
    begin(route) {
      if (active !== null && !TERMINAL.has(navs.get(active).state)) record(active, NAV.SUPERSEDED);
      const id = ++seq;
      navs.set(id, { id, route, state: null });
      active = id;
      record(id, NAV.RESOLVING);
      return id;
    },
    /** Move one step forward. A step for a navigation that is not the live one is refused. */
    advance(id) {
      const nav = navs.get(id);
      if (!nav || id !== active || TERMINAL.has(nav.state)) return false;
      const state = ORDER[ORDER.indexOf(nav.state) + 1];
      record(id, state);
      if (state === NAV.SETTLED) {
        settledRoute = nav.route;
        for (const fn of listeners) fn(nav.route, id);
      }
      return true;
    },
    fail(id) {
      const nav = navs.get(id);
      if (!nav || id !== active || TERMINAL.has(nav.state)) return false;
      record(id, NAV.FAILED);
      return true;
    },
    state(id) {
      return navs.get(id)?.state ?? null;
    },
    get settledRoute() {
      return settledRoute;
    },
    get log() {
      return [...log];
    },
    get activeId() {
      return active;
    },
    /** Suppress URL rewrites for a scoped region (e.g. Staffing's auto-picked example). */
    suppressUrlWrites() {
      suppressed += 1;
      let released = false;
      return () => {
        if (released) return false;
        released = true;
        if (suppressed <= 0) return false;
        suppressed -= 1;
        return true;
      };
    },
    /** True while the live navigation is in its apply (rendering) phase. */
    isApplying() {
      return active !== null && navs.get(active)?.state === NAV.RENDERING;
    },
    /** True while one or more suppressUrlWrites scopes are open. */
    urlWritesSuppressed() {
      return suppressed > 0;
    },
  };
}

/** Drive a navigator from a plain event list: ['begin', route] | ['advance', id] | ['fail', id]. */
export function replayNavigation(events) {
  const nav = createNavigator();
  const settled = [];
  nav.onSettled((route, id) => settled.push(`${id}:${route}`));
  const refused = [];
  events.forEach(([type, arg], i) => {
    if (type === "begin") nav.begin(arg);
    else if (!(type === "advance" ? nav.advance(arg) : nav.fail(arg))) refused.push(i);
  });
  return { log: nav.log, settled, refused, settledRoute: nav.settledRoute };
}

/** Same replay, plus URL writes: suppressing URL writes never blocks a navigation; a URL write is
 *  refused while writes are suppressed or while the live navigation is applying (rendering). */
export function replayNavigationWithUrlWrites(events) {
  const nav = createNavigator();
  const settled = [];
  const refused = [];
  const urlWrites = [];
  const releases = [];
  nav.onSettled((route, id) => settled.push(`${id}:${route}`));
  let live = null;
  events.forEach(([type, arg], i) => {
    if (type === "begin") live = nav.begin(arg);
    else if (type === "advance") {
      if (!nav.advance(arg)) refused.push(i);
    } else if (type === "fail") {
      if (!nav.fail(arg)) refused.push(i);
    } else if (type === "suppress-url-writes") {
      releases.push(nav.suppressUrlWrites());
    } else if (type === "release-url-writes") {
      const release = releases.pop();
      if (!release || !release()) refused.push(i);
    } else if (type === "write-url") {
      if (nav.urlWritesSuppressed() || (live !== null && nav.state(live) === NAV.RENDERING)) {
        refused.push(i);
      } else {
        urlWrites.push(arg);
      }
    } else {
      refused.push(i);
    }
  });
  return { log: nav.log, settled, refused, settledRoute: nav.settledRoute, urlWrites };
}
