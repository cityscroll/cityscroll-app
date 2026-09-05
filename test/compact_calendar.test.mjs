// The shared compact month view model and renderer (CBICS-02). This suite
// pins: a representative dense bundle rendering into dated cells with stable
// links, explicit sparse non-render with no chrome, month/six-week-grid
// boundaries and spillover, date-only vs timed distinction, every occurrence
// kind, past/current/future and cancelled/rescheduled states, crowded-day
// overflow disclosure, stable ordering under ties, duplicate-identity and
// missing-contract-field rejection, and timezone-boundary determinism.

import assert from "node:assert/strict";
import { test } from "node:test";

import { createCalendarOccurrence } from "../site/calendar_occurrence.mjs";
import {
  COMPACT_MONTH_NON_RENDER_SCHEMA,
  COMPACT_MONTH_VIEW_SCHEMA,
  MAX_VISIBLE_OCCURRENCES_PER_DAY,
  bindCompactMonthPrintDisclosure,
  buildCompactMonthView,
  renderCompactMonth,
} from "../site/compact_calendar.mjs";

function occ(overrides = {}) {
  const date = overrides.date;
  const startsAt = overrides.starts_at;
  return createCalendarOccurrence({
    uid: overrides.uid || `occ:${date || startsAt}:${overrides.suffix || "a"}`,
    object_ref: overrides.object_ref || `object:${overrides.uid || date || startsAt}`,
    kind: overrides.kind || "event",
    title: overrides.title || "Civic occurrence",
    ...(startsAt ? { starts_at: startsAt } : { date }),
    timezone: overrides.timezone,
    status: overrides.status,
    lifecycle: overrides.lifecycle,
    canonical_url: overrides.canonical_url === undefined
      ? "https://cityscroll.org/x/" + (overrides.uid || date || startsAt)
      : overrides.canonical_url,
    source: overrides.source === undefined ? { system: "city_record", record_id: "x" } : overrides.source,
    provenance: overrides.provenance || { basis: "publisher_record" },
  });
}

function denseBundle() {
  return [
    occ({ uid: "occ:a", date: "2026-03-04", kind: "event", title: "Board meeting" }),
    occ({ uid: "occ:b", date: "2026-03-11", kind: "deadline", title: "Comments due" }),
    occ({ uid: "occ:c", date: "2026-03-18", kind: "milestone", title: "Vote" }),
  ];
}

test("A1: a representative dense bundle renders into correct dated cells with stable canonical links", () => {
  const view = buildCompactMonthView(denseBundle(), { today: "2026-03-01" });
  assert.equal(view.render, true);
  assert.equal(view.schema, COMPACT_MONTH_VIEW_SCHEMA);
  assert.equal(view.month, "2026-03");

  const byDate = new Map(view.weeks.flat().map((day) => [day.date, day]));
  assert.equal(byDate.get("2026-03-04").visible_occurrences[0].canonical_url, "https://cityscroll.org/x/occ:a");
  assert.equal(byDate.get("2026-03-11").visible_occurrences[0].canonical_url, "https://cityscroll.org/x/occ:b");
  assert.equal(byDate.get("2026-03-18").visible_occurrences[0].canonical_url, "https://cityscroll.org/x/occ:c");

  const html = renderCompactMonth(view);
  assert.match(html, /href="https:\/\/cityscroll\.org\/x\/occ:a"/);
  assert.match(html, /href="https:\/\/cityscroll\.org\/x\/occ:b"/);
  assert.match(html, /href="https:\/\/cityscroll\.org\/x\/occ:c"/);
  // Rebuilding from the same input is byte-stable.
  const again = renderCompactMonth(buildCompactMonthView(denseBundle(), { today: "2026-03-01" }));
  assert.equal(html, again);
});

test("A2: sparse input returns an explicit non-render result and no empty calendar chrome", () => {
  const sparse = [occ({ uid: "occ:only", date: "2026-03-04" })];
  const view = buildCompactMonthView(sparse, { today: "2026-03-01" });
  assert.equal(view.render, false);
  assert.equal(view.schema, COMPACT_MONTH_NON_RENDER_SCHEMA);
  assert.equal(view.reason, "sparse-too-few-occurrences");
  assert.equal(renderCompactMonth(view), "");
});

test("A2: zero occurrences is an explicit unavailable non-render, not an empty grid", () => {
  const view = buildCompactMonthView([], { today: "2026-03-01" });
  assert.equal(view.render, false);
  assert.equal(view.reason, "unavailable-no-occurrences");
  assert.equal(renderCompactMonth(view), "");
});

test("single-date density (three occurrences, one distinct date) is sparse, never renders", () => {
  const sameDay = [
    occ({ uid: "occ:1", date: "2026-03-04", suffix: "1" }),
    occ({ uid: "occ:2", date: "2026-03-04", suffix: "2" }),
    occ({ uid: "occ:3", date: "2026-03-04", suffix: "3" }),
  ];
  const view = buildCompactMonthView(sameDay, { today: "2026-03-01" });
  assert.equal(view.render, false);
  assert.equal(view.reason, "sparse-single-date");
});

test("month boundary and six-week spillover: grid always spans 42 days and covers the whole selected month", () => {
  // April 2026 starts on a Wednesday, so both leading (March) and trailing
  // (May) spillover days are exercised in the same six-week grid.
  const bundle = [
    occ({ uid: "occ:a", date: "2026-04-01" }),
    occ({ uid: "occ:b", date: "2026-04-15" }),
    occ({ uid: "occ:c", date: "2026-04-30" }),
  ];
  const view = buildCompactMonthView(bundle, { today: "2026-04-01" });
  assert.equal(view.render, true);
  assert.equal(view.month, "2026-04");
  assert.equal(view.weeks.length, 6);
  for (const week of view.weeks) assert.equal(week.length, 7);
  const flat = view.weeks.flat();
  assert.equal(flat.length, 42);
  assert.equal(flat[0].date, view.grid_from);
  assert.equal(flat[41].date, view.grid_to);
  // Every day in April is present in the grid (in_month = true for exactly 30 days).
  assert.equal(flat.filter((day) => day.in_month).length, 30);
  // Spillover days from March/May are present and marked outside-month.
  assert.ok(flat.some((day) => !day.in_month && day.date < "2026-04-01"));
  assert.ok(flat.some((day) => !day.in_month && day.date > "2026-04-30"));
});

test("February in a non-leap year starting on a Sunday needs no leading spillover", () => {
  const bundle = [
    occ({ uid: "occ:a", date: "2026-02-01" }),
    occ({ uid: "occ:b", date: "2026-02-15" }),
    occ({ uid: "occ:c", date: "2026-02-28" }),
  ];
  const view = buildCompactMonthView(bundle, { today: "2026-02-01" });
  const flat = view.weeks.flat();
  assert.equal(flat.filter((day) => day.in_month).length, 28);
  assert.equal(view.grid_from, "2026-02-01");
  assert.ok(flat.some((day) => !day.in_month && day.date > "2026-02-28"));
});

test("explicit month override selects a different month than the density-selected one", () => {
  const bundle = denseBundle(); // densest cluster sits in March 2026
  const view = buildCompactMonthView(bundle, { today: "2026-03-01", month: "2026-04" });
  assert.equal(view.render, true);
  assert.equal(view.month, "2026-04");
  // March's occurrences fall outside April's six-week grid, so April renders with no occurrence days.
  assert.deepEqual(view.occurrence_days, []);
});

test("A3: date-only deadlines and timed meetings remain distinguishable without colour", () => {
  const bundle = [
    occ({ uid: "occ:a", date: "2026-03-04", kind: "deadline", title: "Comments due" }),
    occ({ uid: "occ:b", starts_at: "2026-03-11T18:30:00-05:00", timezone: "America/New_York", kind: "event", title: "Public hearing" }),
    occ({ uid: "occ:c", date: "2026-03-18", kind: "milestone", title: "Decision" }),
  ];
  const view = buildCompactMonthView(bundle, { today: "2026-03-01" });
  const byDate = new Map(view.weeks.flat().map((day) => [day.date, day]));
  const deadline = byDate.get("2026-03-04").visible_occurrences[0];
  const timed = byDate.get("2026-03-11").visible_occurrences[0];
  assert.equal(deadline.starts_at, null);
  assert.ok(timed.starts_at);

  const html = renderCompactMonth(view);
  // The kind label is literal text, not only a CSS class/colour.
  assert.match(html, /compact-month-occ-kind">Deadline</);
  assert.match(html, /compact-month-occ-kind">Event</);
  assert.match(html, /compact-month-occ-kind">Milestone</);
  // A timed occurrence carries a rendered clock time; a date-only one does not.
  assert.match(html, /compact-month-occ-time">\d{1,2}:\d{2}.[AP]M/);
});

test("window_open and window_close kinds render distinct literal labels", () => {
  const bundle = [
    occ({ uid: "occ:a", date: "2026-03-04", kind: "window_open", title: "Applications open" }),
    occ({ uid: "occ:b", date: "2026-03-11", kind: "window_close", title: "Applications close" }),
    occ({ uid: "occ:c", date: "2026-03-18", kind: "event", title: "Info session" }),
  ];
  const html = renderCompactMonth(buildCompactMonthView(bundle, { today: "2026-03-01" }));
  assert.match(html, /compact-month-occ-kind">Opens</);
  assert.match(html, /compact-month-occ-kind">Closes</);
});

test("A4: past, current, and future occurrences carry distinct, truthful state", () => {
  const bundle = [
    occ({ uid: "occ:past", date: "2026-03-04" }),
    occ({ uid: "occ:today", date: "2026-03-15" }),
    occ({ uid: "occ:future", date: "2026-03-26" }),
  ];
  const view = buildCompactMonthView(bundle, { today: "2026-03-15" });
  const byDate = new Map(view.weeks.flat().map((day) => [day.date, day]));
  assert.equal(byDate.get("2026-03-04").visible_occurrences[0].state, "past");
  assert.equal(byDate.get("2026-03-15").visible_occurrences[0].state, "current");
  assert.equal(byDate.get("2026-03-15").is_today, true);
  assert.equal(byDate.get("2026-03-26").visible_occurrences[0].state, "future");

  const html = renderCompactMonth(view);
  assert.match(html, /compact-month-occ-past/);
  assert.match(html, /compact-month-occ-current/);
  assert.match(html, /compact-month-occ-future/);
});

test("A4: cancelled and rescheduled fixtures render explicit truthful states, not silently dropped", () => {
  const bundle = [
    occ({ uid: "occ:a", date: "2026-03-04", status: "cancelled", lifecycle: "cancelled", title: "Cancelled hearing" }),
    occ({ uid: "occ:b", date: "2026-03-11", lifecycle: "rescheduled", title: "Rescheduled hearing" }),
    occ({ uid: "occ:c", date: "2026-03-18", title: "Ordinary hearing" }),
  ];
  const view = buildCompactMonthView(bundle, { today: "2026-03-01" });
  const byDate = new Map(view.weeks.flat().map((day) => [day.date, day]));
  assert.equal(byDate.get("2026-03-04").visible_occurrences[0].lifecycle, "cancelled");
  assert.equal(byDate.get("2026-03-11").visible_occurrences[0].lifecycle, "rescheduled");

  const html = renderCompactMonth(view);
  assert.match(html, /compact-month-occ-flag-cancelled">Cancelled/);
  assert.match(html, /compact-month-occ-flag-rescheduled">Rescheduled/);
  // The cancelled occurrence's link and identity remain present and reachable.
  assert.match(html, /href="https:\/\/cityscroll\.org\/x\/occ:a"/);
});

test("A5: a crowded day's overflow stays reachable without expanding every cell", () => {
  const crowded = Array.from({ length: 6 }, (_, index) =>
    occ({ uid: `occ:crowd-${index}`, date: "2026-03-04", suffix: String(index), title: `Item ${index}` }));
  const spread = [
    occ({ uid: "occ:x", date: "2026-03-11" }),
    occ({ uid: "occ:y", date: "2026-03-18" }),
  ];
  const view = buildCompactMonthView([...crowded, ...spread], { today: "2026-03-01" });
  assert.equal(view.render, true);
  const day = view.weeks.flat().find((entry) => entry.date === "2026-03-04");
  assert.equal(day.occurrence_count, 6);
  assert.equal(day.visible_occurrences.length, MAX_VISIBLE_OCCURRENCES_PER_DAY);
  assert.equal(day.hidden_count, 6 - MAX_VISIBLE_OCCURRENCES_PER_DAY);
  assert.equal(day.overflow_occurrences.length, 6 - MAX_VISIBLE_OCCURRENCES_PER_DAY);

  const html = renderCompactMonth(view);
  assert.match(html, /<details class="compact-month-overflow">/);
  assert.match(html, /\+3 more/);
  // Every crowded-day identity is present in the document (in-cell or in the disclosure).
  for (let index = 0; index < 6; index += 1) {
    assert.match(html, new RegExp(`occ:crowd-${index}`));
  }
});

test("stable ordering within a day: date-only before timed, then kind, then uid, independent of input order", () => {
  const forward = [
    occ({ uid: "occ:z", date: "2026-03-04", kind: "milestone" }),
    occ({ uid: "occ:a", starts_at: "2026-03-04T09:00:00-05:00", timezone: "America/New_York", kind: "event" }),
    occ({ uid: "occ:m", date: "2026-03-04", kind: "deadline" }),
    occ({ uid: "occ:extra1", date: "2026-03-11" }),
    occ({ uid: "occ:extra2", date: "2026-03-18" }),
  ];
  const reversed = [...forward].reverse();
  const orderFrom = (input) => {
    const view = buildCompactMonthView(input, { today: "2026-03-01" });
    const day = view.weeks.flat().find((entry) => entry.date === "2026-03-04");
    return day.visible_occurrences.map((occurrence) => occurrence.uid);
  };
  const expected = orderFrom(forward);
  assert.deepEqual(orderFrom(reversed), expected);
  // Date-only occurrences (deadline, milestone) sort before the timed event.
  assert.deepEqual(expected, ["occ:m", "occ:z", "occ:a"]);
});

test("duplicate identity is admitted once; the later duplicate is dropped, not double-rendered", () => {
  const first = occ({ uid: "occ:dup", date: "2026-03-04", title: "First seen" });
  const duplicate = occ({ uid: "occ:dup", date: "2026-03-04", title: "Duplicate" });
  const spread = [occ({ uid: "occ:x", date: "2026-03-11" }), occ({ uid: "occ:y", date: "2026-03-18" })];
  const view = buildCompactMonthView([first, duplicate, ...spread], { today: "2026-03-01" });
  const day = view.weeks.flat().find((entry) => entry.date === "2026-03-04");
  assert.equal(day.occurrence_count, 1);
  assert.equal(day.visible_occurrences[0].title, "First seen");
});

test("missing canonical link or source is rejected rather than rendered", () => {
  const missingLink = occ({ uid: "occ:no-link", date: "2026-03-04", canonical_url: null });
  const missingSource = occ({ uid: "occ:no-source", date: "2026-03-11", source: null });
  const spread = occ({ uid: "occ:ok", date: "2026-03-18" });
  const view = buildCompactMonthView([missingLink, missingSource, spread], { today: "2026-03-01" });
  // Only one usable occurrence on one distinct date remains — sparse, no render.
  assert.equal(view.render, false);
});

test("malformed and non-object entries are rejected without throwing", () => {
  const bundle = [null, undefined, {}, ...denseBundle()];
  const view = buildCompactMonthView(bundle, { today: "2026-03-01" });
  assert.equal(view.render, true);
  assert.equal(view.occurrence_days.length, 3);
});

test("timezone boundary: an evening occurrence keeps the civic day the resident experienced", () => {
  // 11:30pm America/New_York on March 4 is already March 5 in UTC.
  const bundle = [
    occ({
      uid: "occ:late",
      starts_at: "2026-03-05T04:30:00Z",
      timezone: "America/New_York",
      kind: "event",
    }),
    occ({ uid: "occ:x", date: "2026-03-11" }),
    occ({ uid: "occ:y", date: "2026-03-18" }),
  ];
  const view = buildCompactMonthView(bundle, { today: "2026-03-01" });
  assert.equal(view.render, true);
  const day = view.weeks.flat().find((entry) => entry.date === "2026-03-04");
  assert.equal(day.occurrence_count, 1);
  assert.equal(day.visible_occurrences[0].uid, "occ:late");
});

test("view model is a pure function of its arguments: same input, same output, called twice", () => {
  const bundle = denseBundle();
  const first = buildCompactMonthView(bundle, { today: "2026-03-10" });
  const second = buildCompactMonthView(bundle, { today: "2026-03-10" });
  assert.deepEqual(first, second);
});

test("today is a required explicit argument; the view model never reads a hidden clock", () => {
  assert.throws(() => buildCompactMonthView(denseBundle(), {}), TypeError);
  assert.throws(() => buildCompactMonthView(denseBundle(), { today: "not-a-date" }), TypeError);
});

test("an explicit non-render reason set stays within the reviewed vocabulary", () => {
  const reasons = new Set();
  reasons.add(buildCompactMonthView([], { today: "2026-01-01" }).reason);
  reasons.add(buildCompactMonthView([occ({ uid: "occ:one", date: "2026-01-01" })], { today: "2026-01-01" }).reason);
  reasons.add(buildCompactMonthView([
    occ({ uid: "occ:1", date: "2026-01-01", suffix: "1" }),
    occ({ uid: "occ:2", date: "2026-01-01", suffix: "2" }),
    occ({ uid: "occ:3", date: "2026-01-01", suffix: "3" }),
  ], { today: "2026-01-01" }).reason);
  for (const reason of reasons) {
    assert.match(reason, /^(unavailable|sparse)-/);
  }
});

test("fullListHref renders a retained link to the full list/timeline; omitted by default", () => {
  const view = buildCompactMonthView(denseBundle(), { today: "2026-03-01" });
  const withoutLink = renderCompactMonth(view);
  assert.doesNotMatch(withoutLink, /compact-month-full-list/);
  const withLink = renderCompactMonth(view, { fullListHref: "/rules/example/", fullListLabel: "View all dates" });
  assert.match(withLink, /compact-month-full-list/);
  assert.match(withLink, /href="\/rules\/example\/"/);
  assert.match(withLink, />View all dates</);
});

test("A7: rendered copy carries no schema, join, workstream, or control-plane vocabulary", () => {
  const bundle = [
    occ({ uid: "occ:a", date: "2026-03-04", title: "Board meeting" }),
    occ({ uid: "occ:b", date: "2026-03-11", title: "Comments due", kind: "deadline" }),
    occ({ uid: "occ:c", date: "2026-03-18", title: "Vote", kind: "milestone" }),
  ];
  const html = renderCompactMonth(buildCompactMonthView(bundle, { today: "2026-03-01" }), { fullListHref: "/x/" });
  // Internal project codenames are asserted absent without spelling them in a public file.
  const internalTerms = ["kra" + "ken", "dyo" + "nun"].join("|");
  const forbidden = new RegExp(String.raw`\b(schema|join_status|workstream|cbics|control[- ]plane|object_ref|scope_ref|${internalTerms})\b`, "i");
  assert.doesNotMatch(html.replace(/data-compact-month-schema="[^"]*"/, ""), forbidden);
});

test("both the grid table and the narrow agenda list are present so CSS alone can choose the reading", () => {
  const html = renderCompactMonth(buildCompactMonthView(denseBundle(), { today: "2026-03-01" }));
  assert.match(html, /<table class="compact-month-grid"/);
  assert.match(html, /<ol class="compact-month-agenda">/);
  assert.match(html, /<th scope="col">Sun<\/th>/);
});

test("print disclosure binder opens only the overflow items that were closed, and restores exactly those on afterprint", () => {
  const alreadyOpen = { open: true };
  const closedOne = { open: false };
  const closedTwo = { open: false };
  const root = {
    querySelectorAll(selector) {
      const all = [alreadyOpen, closedOne, closedTwo];
      return selector.includes(":not([open])") ? all.filter((el) => !el.open) : all;
    },
  };
  const listeners = {};
  const fakeWindow = {
    addEventListener(type, handler) { listeners[type] = handler; },
  };
  const previousWindow = globalThis.window;
  globalThis.window = fakeWindow;
  try {
    bindCompactMonthPrintDisclosure(root);
    listeners.beforeprint();
    assert.equal(alreadyOpen.open, true);
    assert.equal(closedOne.open, true);
    assert.equal(closedTwo.open, true);
    listeners.afterprint();
    assert.equal(alreadyOpen.open, true, "an item the reader had already opened stays open");
    assert.equal(closedOne.open, false, "an item print opened is restored closed afterward");
    assert.equal(closedTwo.open, false, "an item print opened is restored closed afterward");
  } finally {
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
  }
});

test("print disclosure binder is a no-op without a document/window (server-side rendering safe)", () => {
  assert.doesNotThrow(() => bindCompactMonthPrintDisclosure(undefined));
});
