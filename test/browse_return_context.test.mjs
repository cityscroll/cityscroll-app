// Browse-return context: after an intentional same-origin full-page visit,
// restore the originating event's focus without stealing it on a cold visit.
//
//   A1 preserve calendar route and scroll (those stay on the history entry);
//      restore the originating event's focus after an explicit return
//   A2 history-state token keyed to scope, selected item and view — never a
//      shareable route, watch, or subscription identity
//   A3 duplicates, reordering, removed events, expiry, blocked history,
//      direct-linked detail pages, heading fallback
//   A4 inspect → close → open full page → Back → continue; Search and
//      Following keep their existing preview/scope machinery
//   A5 every audited host inherits this through the shared month binder
//
//   node --test test/browse_return_context.test.mjs

import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";

import { createCalendarOccurrence } from "../site/calendar_occurrence.mjs";
import { buildCompactMonthView, renderCompactMonth, bindCompactMonthCalendar } from "../site/compact_calendar.mjs";
import {
  BROWSE_RETURN_CONTEXT_SCHEMA,
  BROWSE_RETURN_HISTORY_KEY,
  BROWSE_RETURN_TTL_MS,
  appearanceIndexForUid,
  bindBrowseReturnContext,
  browseReturnFromHistoryState,
  browseReturnHistoryPatch,
  browseReturnIsExpired,
  browseReturnMatchesSurface,
  browseReturnScopeFromLocation,
  createBrowseReturnContext,
  normalizeBrowseReturnContext,
  resolveBrowseReturnFocus,
  restoreBrowseReturnFocus,
  shouldRestoreBrowseReturn,
  writeBrowseReturnHistory,
} from "../site/browse_return_context.mjs";
import { CALENDAR_DISPLAY_STATE_KEYS } from "../site/calendar_display_state.mjs";
import { scopeFromRouteHash, watchFromScope } from "../site/scope_v0.mjs";
import {
  followingPreviewHandoffFromScope,
  pinFollowingPreviewItems,
} from "../site/following_preview_handoff.mjs";
import {
  searchFrontDoorHref,
  searchFrontDoorScopeFromParams,
} from "../site/search_front_door_scope.mjs";
import { click, describeNode, mountDocument } from "./helpers/preview_dom.mjs";

const TODAY = "2026-03-15";

function occ(overrides = {}) {
  return createCalendarOccurrence({
    uid: overrides.uid || "occ:a",
    object_ref: `object:${overrides.uid || "occ:a"}`,
    kind: overrides.kind || "event",
    title: overrides.title || "Full board meeting",
    date: overrides.date || "2026-03-18",
    timezone: overrides.timezone,
    status: overrides.status,
    lifecycle: overrides.lifecycle,
    canonical_url: overrides.canonical_url === undefined
      ? `https://cityscroll.org/meetings/${overrides.uid || "occ:a"}`
      : overrides.canonical_url,
    source: overrides.source === undefined ? { system: "city_record", record_id: "20260318001" } : overrides.source,
    provenance: { basis: "publisher_record" },
  });
}

function bundle(extra = []) {
  return [
    occ({ uid: "occ:a", date: "2026-03-18", title: "Full board meeting" }),
    occ({ uid: "occ:b", date: "2026-03-24", kind: "deadline", title: "Comments due" }),
    occ({ uid: "occ:c", date: "2026-03-30", kind: "milestone", title: "Board vote" }),
    ...extra,
  ];
}

function monthHTML(extra = []) {
  return renderCompactMonth(buildCompactMonthView(bundle(extra), { today: TODAY }));
}

function makeHistory(state = null) {
  let current = state;
  const writes = [];
  return {
    get state() { return current; },
    replaceState(next) {
      if (this.blocked) throw new Error("QuotaExceededError");
      current = next;
      writes.push(next);
    },
    writes,
    blocked: false,
  };
}

function listingLocation() {
  return {
    href: "https://cityscroll.org/#now?calview=calendar",
    origin: "https://cityscroll.org",
    hash: "#now?calview=calendar",
    pathname: "/",
    search: "",
  };
}

function context(overrides = {}, now = 1_000_000) {
  return createBrowseReturnContext({
    uid: "occ:a",
    href: "https://cityscroll.org/meetings/occ:a",
    appearance: 0,
    invoker: "link",
    scope: "#now?calview=calendar",
    view: "calendar",
    day: "2026-03-18",
    ...overrides,
  }, now);
}

test("A2: a return token is presentation state on the history entry, not a route key", () => {
  const token = context();
  assert.equal(token.schema, BROWSE_RETURN_CONTEXT_SCHEMA);
  const patch = browseReturnHistoryPatch(token);
  assert.equal(Object.keys(patch)[0], BROWSE_RETURN_HISTORY_KEY);
  assert.equal(browseReturnFromHistoryState({ cityscrollRoute: patch }).uid, "occ:a");
  assert.equal(browseReturnFromHistoryState({ cityscrollRoute: patch }).view, "calendar");
  assert.deepEqual(CALENDAR_DISPLAY_STATE_KEYS, ["calview", "calfrom", "calto"]);
  assert.ok(!CALENDAR_DISPLAY_STATE_KEYS.includes(BROWSE_RETURN_HISTORY_KEY));
});

test("A2: junk, tracking-shaped, and cross-scheme values are dropped", () => {
  assert.equal(normalizeBrowseReturnContext(null), null);
  assert.equal(normalizeBrowseReturnContext({ uid: "occ:a" }), null);
  assert.equal(createBrowseReturnContext({ uid: "occ:a", href: "javascript:alert(1)" }), null);
  assert.equal(normalizeBrowseReturnContext({
    schema: "other.schema",
    uid: "occ:a",
    href: "https://cityscroll.org/x",
    createdAt: 10,
  }), null);
  assert.equal(createBrowseReturnContext({ uid: "", href: "https://cityscroll.org/x" }), null);
  assert.equal(createBrowseReturnContext({
    uid: "occ:a",
    href: "https://cityscroll.org/x",
    createdAt: "nope",
  }), null);
  const token = createBrowseReturnContext({
    uid: "occ:a",
    href: "/notices/occ:a",
    createdAt: 10,
    scope: "#now?calview=calendar",
  });
  assert.equal(token.href, "/notices/occ:a");
});

test("A2: filters never become subscription scope, and return keys never join a watch", () => {
  const stuffed = scopeFromRouteHash("#now?calview=calendar&browseReturn=occ:a&selected=occ:a&boro=Bronx");
  const watch = watchFromScope(stuffed);
  const encoded = JSON.stringify({ scope: stuffed, watch });
  assert.ok(!encoded.includes("browseReturn"), "return state leaked into a scope or watch");
  assert.ok(!encoded.includes("occ:a"), "a selected item leaked into a scope or watch");
  assert.deepEqual(stuffed.place.boroughs, ["Bronx"]);
});

test("A1: Back/Forward restore; a fresh visit or reload does not steal focus", () => {
  const token = context();
  assert.equal(shouldRestoreBrowseReturn({
    context: token,
    navigationType: "back_forward",
    scope: "#now?calview=calendar",
    view: "calendar",
    now: 1_000_000,
  }), true);
  assert.equal(shouldRestoreBrowseReturn({
    context: token,
    persisted: true,
    navigationType: "navigate",
    scope: "#now?calview=calendar",
    view: "calendar",
    now: 1_000_000,
  }), true);
  assert.equal(shouldRestoreBrowseReturn({
    context: token,
    navigationType: "navigate",
    scope: "#now?calview=calendar",
    view: "calendar",
    now: 1_000_000,
  }), false);
  assert.equal(shouldRestoreBrowseReturn({
    context: token,
    navigationType: "reload",
    scope: "#now?calview=calendar",
    view: "calendar",
    now: 1_000_000,
  }), false);
});

test("A3: expired, mismatched, and missing tokens are not restored", () => {
  const token = context();
  assert.equal(browseReturnIsExpired(token, 1_000_000), false);
  assert.equal(browseReturnIsExpired(token, 1_000_000 + BROWSE_RETURN_TTL_MS + 1), true);
  assert.equal(shouldRestoreBrowseReturn({
    context: token,
    navigationType: "back_forward",
    now: 1_000_000 + BROWSE_RETURN_TTL_MS + 1,
    scope: "#now?calview=calendar",
    view: "calendar",
  }), false);
  assert.equal(browseReturnMatchesSurface(token, { scope: "#now?calview=calendar", view: "list" }), false);
  assert.equal(browseReturnMatchesSurface(token, { scope: "#rules", view: "calendar" }), false);
  assert.equal(shouldRestoreBrowseReturn({ context: null, navigationType: "back_forward" }), false);
});

test("A3: duplicate appearances keep the instance that was activated", () => {
  const nodes = [
    { getAttribute: () => "occ:a" },
    { getAttribute: () => "occ:a" },
    { getAttribute: () => "occ:b" },
  ];
  assert.equal(appearanceIndexForUid(nodes, "occ:a", nodes[1]), 1);
  const first = { uid: "occ:a", appearance: 0, node: { id: "first" } };
  const second = { uid: "occ:a", appearance: 1, node: { id: "second" } };
  const resolved = resolveBrowseReturnFocus({
    context: context({ appearance: 1 }),
    candidates: [first, second],
    heading: { id: "heading" },
  });
  assert.equal(resolved.kind, "item");
  assert.equal(resolved.node.id, "second");
});

test("A3: changed ordering still finds the same uid; a removed event uses the heading", () => {
  const moved = resolveBrowseReturnFocus({
    context: context({ appearance: 0 }),
    candidates: [
      { uid: "occ:b", appearance: 0, node: { id: "other" } },
      { uid: "occ:a", appearance: 1, node: { id: "moved" } },
    ],
    heading: { id: "heading" },
  });
  assert.equal(moved.node.id, "moved");
  const missing = resolveBrowseReturnFocus({
    context: context(),
    candidates: [{ uid: "occ:b", appearance: 0, node: { id: "other" } }],
    heading: { id: "heading" },
  });
  assert.equal(missing.kind, "heading");
  assert.equal(missing.node.id, "heading");
});

test("A3: blocked history does not trap the click or invent a token", () => {
  const history = makeHistory();
  history.blocked = true;
  const written = writeBrowseReturnHistory(history, context(), listingLocation());
  assert.equal(written, false);
  assert.equal(history.writes.length, 0);
  assert.equal(writeBrowseReturnHistory(null, context(), listingLocation()), false);
});

test("A1/A3: an unmodified same-origin click remembers the item; a modified click does not", () => {
  const { doc, container } = mountDocument(monthHTML());
  const history = makeHistory();
  const location = listingLocation();
  bindBrowseReturnContext(container, { history, location, restore: false, now: 1_000_000 });
  const link = container.querySelector(".compact-month-occ-link");
  assert.ok(link, "expected a canonical occurrence link");
  click(link);
  const remembered = browseReturnFromHistoryState(history.state);
  assert.equal(remembered.uid, "occ:a");
  assert.equal(remembered.invoker, "link");
  assert.equal(remembered.view, "calendar");
  assert.equal(remembered.scope, "#now?calview=calendar");
  assert.match(remembered.href, /occ:a/);

  const history2 = makeHistory();
  const { container: container2 } = mountDocument(monthHTML());
  bindBrowseReturnContext(container2, { history: history2, location, restore: false, now: 1_000_000 });
  click(container2.querySelector(".compact-month-occ-link"), { metaKey: true });
  assert.equal(browseReturnFromHistoryState(history2.state), null);
});

test("A1: restoring after Back focuses the originating event, not the document body", () => {
  const { doc, container } = mountDocument(monthHTML());
  const history = makeHistory();
  const location = listingLocation();
  bindBrowseReturnContext(container, { history, location, restore: false, now: 1_000_000 });
  const link = container.querySelector(".compact-month-occ-link");
  click(link);
  doc.activeElement = doc.body;
  const focused = restoreBrowseReturnFocus(container, {
    history,
    location,
    navigationType: "back_forward",
    now: 1_000_000,
  });
  assert.equal(describeNode(focused), describeNode(link));
  assert.equal(doc.activeElement, link);
});

test("A1: a fresh direct visit with leftover state does not steal focus", () => {
  const { doc, container } = mountDocument(monthHTML());
  const history = makeHistory({
    cityscrollRoute: browseReturnHistoryPatch(context()),
  });
  doc.activeElement = doc.body;
  const focused = restoreBrowseReturnFocus(container, {
    history,
    location: listingLocation(),
    navigationType: "navigate",
    now: 1_000_000,
  });
  assert.equal(focused, null);
  assert.equal(doc.activeElement, doc.body);
});

test("A3: a missing invoker focuses the calendar heading without looping", () => {
  const { doc, container } = mountDocument(monthHTML());
  const history = makeHistory({
    cityscrollRoute: browseReturnHistoryPatch(context({ uid: "occ:gone", href: "https://cityscroll.org/meetings/gone" })),
  });
  doc.activeElement = doc.body;
  const focused = restoreBrowseReturnFocus(container, {
    history,
    location: listingLocation(),
    navigationType: "back_forward",
    now: 1_000_000,
  });
  const heading = container.querySelector(".compact-month");
  assert.equal(focused, heading);
  assert.equal(heading.getAttribute("tabindex"), "-1");
});

test("A3: a publisher (cross-origin) occurrence is left to the browser", () => {
  const { container } = mountDocument(monthHTML([
    occ({
      uid: "occ:ext",
      date: "2026-03-19",
      canonical_url: "https://rules.cityofnewyork.us/rule/energy-code/",
    }),
  ]));
  const history = makeHistory();
  bindBrowseReturnContext(container, {
    history,
    location: listingLocation(),
    restore: false,
    now: 1_000_000,
  });
  const external = [...container.querySelectorAll(".compact-month-occ-link")]
    .find((node) => (node.getAttribute("href") || "").includes("rules.cityofnewyork.us"));
  assert.ok(external);
  click(external);
  assert.equal(browseReturnFromHistoryState(history.state), null);
});

test("A4: inspect, close, then the full-page link remembers the preview invoker", () => {
  const { doc, container } = mountDocument(monthHTML());
  const history = makeHistory();
  const location = listingLocation();
  bindCompactMonthCalendar(container, { history, location, restore: false, now: 1_000_000 });
  const trigger = container.querySelector("[data-calendar-event-preview-uid]");
  click(trigger);
  const dialog = doc.getElementById("calendar-event-preview");
  assert.equal(dialog.open, true);
  click(dialog.querySelector("[data-calendar-event-preview-close]"));
  assert.equal(dialog.open, false);
  click(trigger);
  const open = dialog.querySelector("[data-calendar-event-preview-open]");
  click(open);
  const remembered = browseReturnFromHistoryState(history.state);
  assert.equal(remembered.uid, "occ:a");
  assert.equal(remembered.invoker, "preview");
  doc.activeElement = doc.body;
  const focused = restoreBrowseReturnFocus(container, {
    history,
    location,
    navigationType: "back_forward",
    now: 1_000_000,
  });
  assert.equal(describeNode(focused), describeNode(trigger));
});

test("A4: Following preview/scope machinery stays a positive control, not a new overlay", () => {
  const handoff = followingPreviewHandoffFromScope({
    lens: "meetings",
    filter: { agency: "Transportation" },
    noticeId: "20260716009",
    originRoute: "/notices/20260716009/",
  });
  assert.equal(handoff.status, "ok");
  assert.equal(handoff.focus.id, "20260716009");
  assert.equal(handoff.originRoute, "/notices/20260716009/");
  assert.equal(handoff.filter.agency, "Transportation");
  assert.equal(Object.hasOwn(handoff.filter, "calview"), false);
  assert.equal(Object.hasOwn(handoff.filter, BROWSE_RETURN_HISTORY_KEY), false);
  const pinned = pinFollowingPreviewItems([
    { id: "other", title: "Other" },
    { id: "20260716009", title: "The meeting" },
    { id: "later", title: "Later" },
  ], handoff);
  assert.equal(pinned[0].id, "20260716009");
});

test("A4: Search scope stays on the canonical route and does not absorb a return token", () => {
  const params = new URLSearchParams("q=parks&source_scope=contracts");
  params.set(BROWSE_RETURN_HISTORY_KEY, "occ:a");
  const scope = searchFrontDoorScopeFromParams(params);
  assert.equal(scope.id, "contracts");
  const href = searchFrontDoorHref(scope.id, new URLSearchParams("q=parks&source_scope=contracts"));
  assert.match(href, /^\/search\/\?/);
  assert.match(href, /q=parks/);
  assert.match(href, /source_scope=contracts/);
  assert.doesNotMatch(href, new RegExp(BROWSE_RETURN_HISTORY_KEY));
  assert.equal(searchFrontDoorScopeFromParams(new URLSearchParams(`${BROWSE_RETURN_HISTORY_KEY}=occ:a`)).id, "all");
  const nowScope = scopeFromRouteHash("#now?q=parks&boro=Bronx");
  assert.equal(nowScope.topic.query, "parks");
  assert.ok(!JSON.stringify(watchFromScope(nowScope)).includes(BROWSE_RETURN_HISTORY_KEY));
});

test("A5: all eight audited hosts inherit return context through the shared binder", () => {
  const hosts = [
    ["site/now_view.mjs", /bindCompactMonthCalendar\(/],
    ["site/app/property.mjs", /bindCompactMonthCalendar\(/],
    ["site/app/land.mjs", /bindCompactMonthCalendar\(/],
    ["site/app/rules.mjs", /bindCompactMonthCalendar\(/],
    ["site/exam_document.mjs", /bindCompactMonthCalendar\(/],
    ["site/community_board_constellation.mjs", /renderCalendarEventPreviewScript\(/],
    ["site/legislative_matter_document.mjs", /renderCalendarEventPreviewScript\(/],
    ["site/procurement_document.mjs", /renderCalendarEventPreviewScript\(/],
  ];
  assert.equal(hosts.length, 8);
  for (const [path, pattern] of hosts) {
    assert.match(readFileSync(new URL(`../${path}`, import.meta.url), "utf8"), pattern, `${path} mounts the shared component`);
  }
  const binder = readFileSync(new URL("../site/compact_calendar.mjs", import.meta.url), "utf8");
  assert.match(binder, /bindBrowseReturnContext\(/);
  const boot = readFileSync(new URL("../site/calendar_event_preview_boot.mjs", import.meta.url), "utf8");
  assert.match(boot, /bindCompactMonthCalendar\(document[,)]/);
});

test("A5: a ninth host inherits the behaviour by mounting the shared component", () => {
  const { container } = mountDocument(monthHTML());
  const history = makeHistory();
  bindCompactMonthCalendar(container, {
    history,
    location: listingLocation(),
    restore: false,
    now: 1_000_000,
  });
  click(container.querySelector(".compact-month-occ-link"));
  assert.equal(browseReturnFromHistoryState(history.state).uid, "occ:a");
});

test("A2: the listing hash is the scope key, not a new tracking identity", () => {
  assert.equal(
    browseReturnScopeFromLocation(listingLocation()),
    "#now?calview=calendar",
  );
  assert.equal(browseReturnScopeFromLocation({ pathname: "/search", search: "?q=parks", hash: "" }), "/search?q=parks");
});
