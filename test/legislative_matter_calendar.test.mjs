import assert from "node:assert/strict";
import { test } from "node:test";

import {
  buildLegislativeMatterDocument,
  LEGISLATIVE_MATTER_SCHEMA,
  renderLegislativeMatterDocument,
} from "../site/legislative_matter_document.mjs";
import {
  buildMatterAppearanceCalendarView,
  MATTER_APPEARANCES_ANCHOR,
  matterAppearanceCalendarRecords,
  renderMatterAppearanceCalendar,
} from "../site/legislative_matter_calendar.mjs";

const MATTER_ID = "78605";

function appearance({
  requestId,
  eventId,
  date,
  name = "Subcommittee on Zoning and Franchises",
  bodyId = null,
  actions = [],
  outcome = null,
  votes = null,
  documents = [],
} = {}) {
  return {
    request_id: requestId,
    event: {
      event_id: eventId,
      name,
      date,
      url: `https://nyc.legistar.com/MeetingDetail.aspx?LEGID=${eventId}`,
      body_id: bodyId,
      documents,
    },
    actions,
    outcome,
    votes,
  };
}

function lookupPayload(appearances, overrides = {}) {
  return {
    schema: "cityscroll.legislative_matter_lookup.v1",
    generated_at: overrides.generated_at || "2026-06-01T00:00:00.000Z",
    matters: {
      [MATTER_ID]: {
        matter_id: MATTER_ID,
        matter_file: overrides.matter_file || "LU 0056-2026",
        title: overrides.title || "147-14 Northern Boulevard rezoning",
        matter_type: overrides.matter_type || "Land Use Application",
        matter_status: overrides.matter_status || "In Committee",
        matter_href: `https://nyc.legistar.com/Gateway.aspx?M=L&ID=${MATTER_ID}`,
        appearances,
      },
    },
  };
}

function matterView(appearances, overrides = {}) {
  return buildLegislativeMatterDocument(lookupPayload(appearances, overrides), MATTER_ID);
}

/* ---------- density scenarios (A4, A5) ---------- */

test("concentrated: three-plus appearances inside the eligibility window earn a compact month", () => {
  const view = matterView([
    appearance({ requestId: "req-1", eventId: "e1", date: "2026-03-04" }),
    appearance({ requestId: "req-2", eventId: "e2", date: "2026-03-11" }),
    appearance({ requestId: "req-3", eventId: "e3", date: "2026-03-25" }),
  ]);
  const calendar = buildMatterAppearanceCalendarView(view, { today: "2026-06-01" });
  assert.equal(calendar.render, true);
  assert.equal(calendar.month, "2026-03");
  assert.equal(calendar.occurrence_days.length, 3);
});

test("dispersed: appearances spread far apart stay list-only with no calendar furniture", () => {
  const view = matterView([
    appearance({ requestId: "req-1", eventId: "e1", date: "2026-01-05" }),
    appearance({ requestId: "req-2", eventId: "e2", date: "2026-05-05" }),
    appearance({ requestId: "req-3", eventId: "e3", date: "2026-09-05" }),
  ]);
  const calendar = buildMatterAppearanceCalendarView(view, { today: "2026-10-01" });
  assert.equal(calendar.render, false);
  assert.equal(calendar.reason, "sparse-no-dense-window");
  const html = renderMatterAppearanceCalendar(calendar);
  assert.equal(html, "");
});

test("sparse: fewer than three appearances stays list-only, matching the real matter 78605 shape", () => {
  const view = matterView([
    appearance({ requestId: "req-1", eventId: "e1", date: "2026-04-22" }),
    appearance({ requestId: "req-2", eventId: "e2", date: "2026-05-19" }),
  ]);
  const calendar = buildMatterAppearanceCalendarView(view, { today: "2026-06-01" });
  assert.equal(calendar.render, false);
  assert.equal(calendar.reason, "sparse-too-few-occurrences");
});

test("full document: no empty calendar chrome renders for a sparse matter", () => {
  const view = matterView([
    appearance({ requestId: "req-1", eventId: "e1", date: "2026-04-22" }),
    appearance({ requestId: "req-2", eventId: "e2", date: "2026-05-19" }),
  ]);
  const html = renderLegislativeMatterDocument(view, { today: "2026-06-01" });
  assert.doesNotMatch(html, /compact-month/);
  assert.match(html, /Observed appearances/);
});

test("full document: a concentrated matter shows the calendar above the observed-appearances list", () => {
  const view = matterView([
    appearance({ requestId: "req-1", eventId: "e1", date: "2026-03-04" }),
    appearance({ requestId: "req-2", eventId: "e2", date: "2026-03-11" }),
    appearance({ requestId: "req-3", eventId: "e3", date: "2026-03-25" }),
  ]);
  const html = renderLegislativeMatterDocument(view, { today: "2026-06-01" });
  const calendarIndex = html.indexOf("compact-month");
  const listIndex = html.indexOf(`id="${MATTER_APPEARANCES_ANCHOR}"`);
  assert.ok(calendarIndex > 0, "calendar markup is present");
  assert.ok(listIndex > 0, "appearances heading is present");
  assert.ok(calendarIndex < listIndex, "calendar renders above the observed appearances section");
});

/* ---------- evidence identity (A1, A5) ---------- */

test("each occurrence's canonical destination is the same notice evidence its appearance links to", () => {
  const view = matterView([
    appearance({ requestId: "20260408025", eventId: "22342", date: "2026-03-04" }),
    appearance({ requestId: "20260428021", eventId: "22375", date: "2026-03-11" }),
    appearance({ requestId: "20260428099", eventId: "22399", date: "2026-03-18" }),
  ]);
  const html = renderLegislativeMatterDocument(view, { today: "2026-06-01" });
  const calendar = buildMatterAppearanceCalendarView(view, { today: "2026-06-01" });
  assert.equal(calendar.render, true);
  const cells = calendar.weeks.flat().flatMap((day) => day.visible_occurrences);
  assert.equal(cells.length, 3);
  for (const cell of cells) {
    const requestId = view.appearances.find((row) => `matter:${MATTER_ID}:${row.event.event_id}` === cell.uid.replace(/:event$/, "")).request_id;
    assert.equal(new URL(cell.canonical_url).pathname, `/notices/${encodeURIComponent(requestId)}/`);
    assert.match(html, new RegExp(`href="/notices/${requestId}/"`));
  }
});

test("parity: calendar and appearance list agree on identity and date", () => {
  const rows = [
    appearance({ requestId: "req-1", eventId: "e1", date: "2026-03-04" }),
    appearance({ requestId: "req-2", eventId: "e2", date: "2026-03-11" }),
    appearance({ requestId: "req-3", eventId: "e3", date: "2026-03-25" }),
  ];
  const view = matterView(rows);
  const calendar = buildMatterAppearanceCalendarView(view, { today: "2026-06-01" });
  const calendarDates = calendar.weeks.flat()
    .flatMap((day) => day.visible_occurrences.map((occ) => occ.date || occ.starts_at));
  assert.deepEqual([...calendarDates].sort(), rows.map((row) => row.event.date).sort());
});

/* ---------- decision boundary (A2, A3) ---------- */

test("an appearance without a proven action or vote never carries decision language onto the calendar", () => {
  const view = matterView([
    appearance({ requestId: "req-1", eventId: "e1", date: "2026-03-04", actions: [], outcome: null, votes: null }),
    appearance({ requestId: "req-2", eventId: "e2", date: "2026-03-11" }),
    appearance({ requestId: "req-3", eventId: "e3", date: "2026-03-18" }),
  ]);
  const html = renderLegislativeMatterDocument(view, { today: "2026-06-01" });
  const calendarHtml = html.slice(html.indexOf("compact-month"), html.indexOf(`id="${MATTER_APPEARANCES_ANCHOR}"`));
  assert.doesNotMatch(calendarHtml, /\b(?:votes?|yes|no|abstain|approved|laid over)\b/i);
});

test("a proven vote and action still stay off the calendar cell; only the detailed appearance carries them", () => {
  const view = matterView([
    appearance({
      requestId: "req-1",
      eventId: "e1",
      date: "2026-03-04",
      bodyId: "34",
      actions: ["Hearing Held by Committee", "Approved by Committee"],
      outcome: "Approved by Committee",
      votes: { result: "Approved", yes: 8, no: 0, abstain: 1, by_person: [{ person_id: "p1", person_name: "Farah N. Louis", vote_bucket: "Affirmative" }] },
    }),
    appearance({ requestId: "req-2", eventId: "e2", date: "2026-03-11" }),
    appearance({ requestId: "req-3", eventId: "e3", date: "2026-03-18" }),
  ]);
  const html = renderLegislativeMatterDocument(view, { today: "2026-06-01" });
  // The detailed appearance below still proves the decision.
  assert.match(html, /8 yes/);
  assert.match(html, /Farah N\. Louis/);
  // The calendar cell for that same date carries no vote/action identity.
  const calendarHtml = html.slice(html.indexOf("compact-month"), html.indexOf(`id="${MATTER_APPEARANCES_ANCHOR}"`));
  assert.doesNotMatch(calendarHtml, /Farah N\. Louis|8 yes|Approved by Committee/);
  assert.match(calendarHtml, /Subcommittee on Zoning and Franchises/);
});

/* ---------- duplicate identity ---------- */

test("two notices for the same committee event collapse to one calendar cell entry", () => {
  const view = matterView([
    appearance({ requestId: "req-1a", eventId: "e1", date: "2026-03-04" }),
    appearance({ requestId: "req-1b", eventId: "e1", date: "2026-03-04" }),
    appearance({ requestId: "req-2", eventId: "e2", date: "2026-03-11" }),
    appearance({ requestId: "req-3", eventId: "e3", date: "2026-03-18" }),
  ]);
  // The list itself is untouched: both notices for the duplicated event remain.
  assert.equal(view.appearances.filter((row) => row.event.event_id === "e1").length, 2);
  const calendar = buildMatterAppearanceCalendarView(view, { today: "2026-06-01" });
  assert.equal(calendar.render, true);
  const marchFourth = calendar.weeks.flat().find((day) => day.date === "2026-03-04");
  assert.equal(marchFourth.occurrence_count, 1);
});

/* ---------- reschedule / cancellation (forward-compatible pass-through) ---------- */

test("a cancelled appearance renders the shared component's cancelled state truthfully", () => {
  const view = {
    schema: LEGISLATIVE_MATTER_SCHEMA,
    id: MATTER_ID,
    ref: `matter:${MATTER_ID}`,
    title: "Cancellation test matter",
    generated_at: "2026-06-01T00:00:00.000Z",
    appearances: [
      { request_id: "req-1", event: { event_id: "e1", name: "Full Council Stated Meeting", date: "2026-03-04", href: "" }, status: "cancelled", lifecycle: "cancelled" },
      { request_id: "req-2", event: { event_id: "e2", name: "Full Council Stated Meeting", date: "2026-03-11", href: "" } },
      { request_id: "req-3", event: { event_id: "e3", name: "Full Council Stated Meeting", date: "2026-03-18", href: "" } },
    ],
  };
  const calendar = buildMatterAppearanceCalendarView(view, { today: "2026-06-01" });
  assert.equal(calendar.render, true);
  const html = renderMatterAppearanceCalendar(calendar);
  assert.match(html, /compact-month-occ-lifecycle-cancelled/);
  assert.match(html, /Cancelled/);
});

test("a rescheduled appearance's later sequence supersedes the earlier one at the same identity", () => {
  const matterId = "99999";
  const olderView = {
    schema: LEGISLATIVE_MATTER_SCHEMA,
    id: matterId,
    ref: `matter:${matterId}`,
    title: "Reschedule test matter",
    generated_at: "2026-06-01T00:00:00.000Z",
    appearances: [
      { request_id: "req-1", event: { event_id: "e1", name: "Full Council Stated Meeting", date: "2026-03-04", href: "" }, sequence: 0 },
      { request_id: "req-1", event: { event_id: "e1", name: "Full Council Stated Meeting", date: "2026-03-06", href: "" }, sequence: 1, lifecycle: "rescheduled" },
      { request_id: "req-2", event: { event_id: "e2", name: "Full Council Stated Meeting", date: "2026-03-11", href: "" } },
      { request_id: "req-3", event: { event_id: "e3", name: "Full Council Stated Meeting", date: "2026-03-18", href: "" } },
    ],
  };
  const calendar = buildMatterAppearanceCalendarView(olderView, { today: "2026-06-01" });
  assert.equal(calendar.render, true);
  assert.equal(calendar.occurrence_days.includes("2026-03-04"), false);
  assert.equal(calendar.occurrence_days.includes("2026-03-06"), true);
});

/* ---------- partial / unavailable ---------- */

test("an appearance missing a usable date or event id is excluded without crashing the calendar", () => {
  const view = matterView([
    appearance({ requestId: "req-1", eventId: "e1", date: "2026-03-04" }),
    appearance({ requestId: "req-2", eventId: "e2", date: "" }),
    { request_id: "req-3", event: { event_id: "", name: "Untitled", date: "2026-03-18", url: "" }, actions: [], outcome: null, votes: null },
  ]);
  const records = matterAppearanceCalendarRecords(view);
  assert.equal(records.length, 1);
  // One usable date remains, so the calendar degrades to "sparse" (below the
  // density threshold) rather than "unavailable" — it does not crash either way.
  const calendar = buildMatterAppearanceCalendarView(view, { today: "2026-06-01" });
  assert.equal(calendar.render, false);
  assert.equal(calendar.reason, "sparse-too-few-occurrences");
});

test("a matter with no usable date at all is reported unavailable, not crashed", () => {
  const view = matterView([
    { request_id: "req-1", event: { event_id: "", name: "Untitled", date: "", url: "" }, actions: [], outcome: null, votes: null },
    appearance({ requestId: "req-2", eventId: "e2", date: "" }),
  ]);
  assert.equal(matterAppearanceCalendarRecords(view).length, 0);
  const calendar = buildMatterAppearanceCalendarView(view, { today: "2026-06-01" });
  assert.equal(calendar.render, false);
  assert.equal(calendar.reason, "unavailable-no-occurrences");
});

test("a matter document that does not exist yields no calendar view and does not throw", () => {
  const missing = buildLegislativeMatterDocument(lookupPayload([]), "00000");
  assert.equal(missing, null);
  assert.doesNotThrow(() => buildMatterAppearanceCalendarView(null, { today: "2026-06-01" }));
  const calendar = buildMatterAppearanceCalendarView(null, { today: "2026-06-01" });
  assert.equal(calendar.render, false);
});

test("buildMatterAppearanceCalendarView never reads a hidden clock: omitted today falls back to the document vintage", () => {
  const view = matterView([
    appearance({ requestId: "req-1", eventId: "e1", date: "2026-03-04" }),
    appearance({ requestId: "req-2", eventId: "e2", date: "2026-03-11" }),
    appearance({ requestId: "req-3", eventId: "e3", date: "2026-03-18" }),
  ], { generated_at: "2026-04-01T00:00:00.000Z" });
  const calendar = buildMatterAppearanceCalendarView(view);
  assert.equal(calendar.render, true);
  const marchEighteenth = calendar.weeks.flat().find((day) => day.date === "2026-03-18");
  assert.equal(marchEighteenth.visible_occurrences[0].state, "past");
});
