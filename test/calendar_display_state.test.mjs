// Calendar display presentation state (CBICS-01 keys; CBICS-05 adds the
// generic route/switch helpers a consuming surface needs, mirroring
// `land_view_state.mjs`). This suite pins: List-default omission from the
// route, additive calview serialization, round-trip parsing, and the
// presentation-resolution fallback ladder (unknown request, absent/failed
// renderer, sparse population).

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  CALENDAR_DEFAULT_VIEW,
  CALENDAR_DISPLAY_STATE_KEYS,
  CALENDAR_VIEW_CALENDAR,
  CALENDAR_VIEW_FALLBACK_REASONS,
  CALENDAR_VIEW_LIST,
  CALENDAR_VIEW_PARAM,
  calendarViewFromRouteHash,
  calendarViewFromSearchParams,
  normalizeCalendarView,
  resolveCalendarPresentation,
  routeHashWithCalendarView,
} from "../site/calendar_display_state.mjs";

test("List is the default view and stays out of the route", () => {
  assert.equal(CALENDAR_DEFAULT_VIEW, CALENDAR_VIEW_LIST);
  assert.equal(routeHashWithCalendarView("#now", "list"), "#now");
  assert.equal(routeHashWithCalendarView("#now?boro=BX", "list"), "#now?boro=BX");
  assert.equal(routeHashWithCalendarView("#now", "not-a-view"), "#now");
});

test("Calendar serializes additively beside existing semantic keys", () => {
  const hash = routeHashWithCalendarView("#now?boro=BX", "calendar");
  assert.equal(hash, `#now?boro=BX&${CALENDAR_VIEW_PARAM}=calendar`);
  assert.equal(calendarViewFromRouteHash(hash), CALENDAR_VIEW_CALENDAR);
});

test("An explicit List request removes a previously carried calview key", () => {
  const withCalendar = routeHashWithCalendarView("#now", "calendar");
  const backToList = routeHashWithCalendarView(withCalendar, "list");
  assert.equal(backToList, "#now");
});

test("calendarViewFromRouteHash round-trips through routeHashWithCalendarView for both views", () => {
  for (const view of [CALENDAR_VIEW_LIST, CALENDAR_VIEW_CALENDAR]) {
    const hash = routeHashWithCalendarView("#now?boro=BX&q=parks", view);
    assert.equal(calendarViewFromRouteHash(hash), view);
  }
});

test("an unknown or repeated calview value falls back to List", () => {
  assert.equal(normalizeCalendarView("globe"), CALENDAR_VIEW_LIST);
  assert.equal(calendarViewFromSearchParams("calview=globe"), CALENDAR_VIEW_LIST);
  assert.equal(calendarViewFromSearchParams("calview=globe&calview=calendar"), CALENDAR_VIEW_LIST);
});

test("resolveCalendarPresentation: List request always paints List with no fallback reason", () => {
  const resolved = resolveCalendarPresentation({ requested: "list" });
  assert.deepEqual(resolved, { view: CALENDAR_VIEW_LIST, requested: CALENDAR_VIEW_LIST, fallback: false, reason: null });
});

test("resolveCalendarPresentation: an unknown request falls back to List with a reason", () => {
  const resolved = resolveCalendarPresentation({ requested: "globe" });
  assert.equal(resolved.view, CALENDAR_VIEW_LIST);
  assert.equal(resolved.fallback, true);
  assert.equal(resolved.reason, CALENDAR_VIEW_FALLBACK_REASONS.UNKNOWN_VIEW);
});

test("resolveCalendarPresentation: a sparse population falls back to List without touching scope", () => {
  const resolved = resolveCalendarPresentation({ requested: "calendar", sparse: true });
  assert.deepEqual(resolved, {
    view: CALENDAR_VIEW_LIST,
    requested: CALENDAR_VIEW_CALENDAR,
    fallback: true,
    reason: CALENDAR_VIEW_FALLBACK_REASONS.SPARSE,
  });
});

test("resolveCalendarPresentation: a healthy renderer with a dense population paints Calendar", () => {
  const resolved = resolveCalendarPresentation({ requested: "calendar", rendererReady: true, sparse: false });
  assert.deepEqual(resolved, { view: CALENDAR_VIEW_CALENDAR, requested: CALENDAR_VIEW_CALENDAR, fallback: false, reason: null });
});

test("resolveCalendarPresentation: a failed renderer falls back to List even for a dense population", () => {
  const resolved = resolveCalendarPresentation({ requested: "calendar", failure: "boom", sparse: false });
  assert.equal(resolved.view, CALENDAR_VIEW_LIST);
  assert.equal(resolved.reason, CALENDAR_VIEW_FALLBACK_REASONS.RENDERER_FAILED);
});

test("the calendar view key set is exactly the presentation keys this module owns", () => {
  assert.deepEqual([...CALENDAR_DISPLAY_STATE_KEYS], [CALENDAR_VIEW_PARAM, "calfrom", "calto"]);
});
