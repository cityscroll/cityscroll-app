import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import {
  CALENDAR_OCCURRENCE_KINDS,
  CALENDAR_OCCURRENCE_STATUSES,
  CALENDAR_OCCURRENCE_LIFECYCLES,
  calendarizationCoverage,
  calendarOccurrencesForRecord,
  createCalendarOccurrence,
  displayCandidateOccurrencesForRecord,
  projectCalendarOccurrences,
} from "../site/calendar_occurrence.mjs";
import { boundedDisplayOccurrences, occurrenceDay } from "../site/calendar_display.mjs";
import { buildCalendarDisplayOccurrenceCensus, readCorpus } from "../tools/build_calendar_display_occurrence_census.mjs";
import {
  CALENDAR_DISPLAY_STATE_KEYS,
  omitCalendarDisplayState,
  stripCalendarDisplayState,
} from "../site/calendar_display_state.mjs";
import {
  routeHashFromScope,
  scopeFromRouteHash,
  scopeFromWatch,
  subscriptionWatchFromScope,
  watchFromScope,
} from "../site/scope_v0.mjs";
import { icsFeed } from "../worker/src/lib/feed.mjs";

const fixture = JSON.parse(readFileSync(new URL("./fixtures/calendar-occurrences/cases.json", import.meta.url), "utf8"));

test("CalendarOccurrence is a validated, presentation-neutral contract", () => {
  assert.deepEqual(CALENDAR_OCCURRENCE_KINDS, ["event", "deadline", "window_open", "window_close", "milestone"]);
  assert.deepEqual(CALENDAR_OCCURRENCE_STATUSES, ["scheduled", "cancelled", "completed"]);
  assert.deepEqual(CALENDAR_OCCURRENCE_LIFECYCLES, ["published", "scheduled", "rescheduled", "cancelled"]);
  const occurrence = createCalendarOccurrence({
    uid: "meeting:example:1:event",
    scope_ref: "scope:meetings:example",
    object_ref: "meeting:example:1",
    kind: "event",
    title: "Public hearing — 123 Main Street rezoning",
    starts_at: "2026-09-15T18:00:00-04:00",
    ends_at: "2026-09-15T20:00:00-04:00",
    timezone: "America/New_York",
    status: "scheduled",
    location: "123 Main Street, New York, NY",
    description: "Attend the public hearing.",
    canonical_url: "https://cityscroll.org/meetings/meeting%3Aexample%3A1/",
    source: { system: "city_record", record_id: "1", url: "https://a856-cityrecord.nyc.gov/RequestDetail/1" },
    provenance: { basis: "publisher_record" },
    observed_at: "2026-08-27T12:00:00Z",
  });
  assert.equal(occurrence.schema, "cityscroll.calendar_occurrence.v1");
  assert.equal(occurrence.date, null);
  assert.equal(occurrence.source.url, "https://a856-cityrecord.nyc.gov/RequestDetail/1");
  assert.throws(() => createCalendarOccurrence({ ...occurrence, starts_at: null, date: null }), /starts_at or date/);
  assert.throws(() => createCalendarOccurrence({ ...occurrence, starts_at: "2026-09-15T18:00:00-04:00", date: "2026-09-15" }), /both/);
});

test("domain producers emit only meaningful semantic dates and preserve provenance", () => {
  const { occurrences, coverage } = projectCalendarOccurrences(fixture.records, { as_of: fixture.as_of });
  assert.equal(occurrences.length, 7);
  assert.equal(occurrences.filter((item) => item.kind === "event").length, 4);
  assert.equal(occurrences.filter((item) => item.kind === "deadline").length, 2);
  assert.equal(occurrences.filter((item) => item.kind === "window_open").length, 1);
  assert.equal(occurrences.filter((item) => item.kind === "window_close").length, 0);
  assert.equal(occurrences.find((item) => item.kind === "deadline").title, "Bids due — School roof repair");
  assert.equal(occurrences.find((item) => item.object_ref.includes("remote")).location, "Online — https://meet.example.gov/transportation");
  assert.equal(occurrences.find((item) => item.object_ref.startsWith("exam:") && item.kind === "deadline").title, "Applications close — Associate Staff Analyst exam");
  assert.equal(occurrences.find((item) => item.status === "cancelled").status, "cancelled");
  assert.ok(occurrences.every((item) => item.canonical_url && item.source?.url && item.provenance));
  assert.equal(occurrences.some((item) => item.object_ref === "notice:20260827007"), false, "publication-only row emits zero occurrences");
  assert.deepEqual(coverage, {
    schema: "cityscroll.calendarization_coverage.v1",
    records_matching_scope: 8,
    records_with_meaningful_future_time: 6,
    records_with_occurrences: 6,
    occurrences_emitted: 7,
    with_exact_time: 4,
    date_only: 3,
    withheld_for_ambiguity: 1,
  });
});

test("procurement milestones are independently typed, stable, and never publication proxies", () => {
  const record = {
    object_ref: "notice:solicitation-7",
    scope_ref: "scope:procurement:parks",
    title: "Parks playground repair",
    start_date: "2026-08-20T12:00:00-04:00",
    published_at: "2026-08-20T12:00:00-04:00",
    due_date: "2026-09-11",
    questions_due_date: "2026-09-04",
    pre_bid_conference_date: "2026-09-02T10:00:00-04:00",
    source_system: "city_record",
    source_record_id: "solicitation-7",
    source_url: "https://a856-cityrecord.nyc.gov/RequestDetail/solicitation-7",
    provenance: { basis: "publisher_record" },
  };
  const first = projectCalendarOccurrences([record], { kind: "rfp", as_of: "2026-08-27" }).occurrences;
  const second = projectCalendarOccurrences([record], { kind: "rfp", as_of: "2026-08-27" }).occurrences;
  assert.deepEqual(first.map((item) => [item.kind, item.date || item.starts_at]), [
    ["deadline", "2026-09-11"],
    ["deadline", "2026-09-04"],
    ["milestone", "2026-09-02T10:00:00-04:00"],
  ]);
  assert.deepEqual(first.map((item) => item.uid), second.map((item) => item.uid));
  assert.deepEqual(first.map((item) => item.uid), [
    "notice:solicitation-7:deadline",
    "notice:solicitation-7:questions_deadline",
    "notice:solicitation-7:pre_bid_conference",
  ]);
  assert.ok(first.every((item) => item.source?.url && item.provenance));
  assert.equal(first.some((item) => (item.date || item.starts_at).startsWith("2026-08-20")), false);
});

test("exam application close is a deadline and an exam date is emitted only when published", () => {
  const applicationOnly = {
    object_ref: "exam:7016",
    scope_ref: "scope:exams:parks",
    exam_number: "7016",
    title: "Associate Staff Analyst",
    application_start: "2026-09-01",
    application_end: "2026-09-30",
    source_system: "dcas",
    source_record_id: "7016",
    source_url: "https://www.nyc.gov/site/dcas/employment/exams.page",
  };
  const published = { ...applicationOnly, exam_date: "2026-11-14" };
  const withoutDate = projectCalendarOccurrences([applicationOnly], { kind: "exam", as_of: "2026-08-27" }).occurrences;
  const withDate = projectCalendarOccurrences([published], { kind: "exam", as_of: "2026-08-27" }).occurrences;
  assert.deepEqual(withoutDate.map((item) => item.kind), ["window_open", "deadline"]);
  assert.equal(withoutDate.some((item) => item.kind === "event"), false);
  assert.equal(withoutDate.find((item) => item.kind === "deadline").title, "Applications close — Associate Staff Analyst");
  assert.deepEqual(withDate.map((item) => item.kind), ["window_open", "deadline", "event"]);
  assert.equal(withDate.find((item) => item.kind === "event").date, "2026-11-14");
  assert.deepEqual(withDate.map((item) => item.uid), [
    "exam:7016:window_open",
    "exam:7016:deadline",
    "exam:7016:event",
  ]);
});

test("rescheduling retains the producer-owned UID while changing the time", () => {
  const current = projectCalendarOccurrences([fixture.records[4]], { as_of: fixture.as_of }).occurrences[0];
  const previous = projectCalendarOccurrences([fixture.rescheduled_previous], { as_of: fixture.as_of }).occurrences[0];
  assert.equal(current.uid, previous.uid);
  assert.notEqual(current.starts_at, previous.starts_at);
});

test("refreshing a reschedule moves one UID and emits update metadata", () => {
  const before = projectCalendarOccurrences([fixture.lifecycle.scheduled], { as_of: fixture.as_of }).occurrences;
  const after = projectCalendarOccurrences([fixture.lifecycle.rescheduled], { as_of: fixture.as_of }).occurrences;
  assert.equal(before.length, 1);
  assert.equal(after.length, 1);
  assert.equal(after[0].uid, before[0].uid);
  assert.equal(after[0].starts_at, "2026-09-15T19:00:00-04:00");
  assert.equal(after[0].lifecycle, "rescheduled");
  assert.equal(after[0].sequence, 1);
  const ics = icsFeed({ title: "Hearing calendar", occurrences: after });
  assert.equal((ics.match(/BEGIN:VEVENT/g) || []).length, 1);
  assert.match(ics, /UID:meeting:city_record:hearing-a@crol-list/);
  assert.match(ics, /DTSTART;TZID=America\/New_York:20260915T190000/);
  assert.doesNotMatch(ics, /20260915T180000/);
  assert.match(ics, /SEQUENCE:1/);
  assert.match(ics, /LAST-MODIFIED:20260827T170000Z/);
});

test("the lifecycle records publication, scheduling, rescheduling, and cancellation", () => {
  assert.deepEqual(
    ["published", "scheduled", "rescheduled", "cancelled"].map((state) =>
      projectCalendarOccurrences([fixture.lifecycle[state]], { as_of: fixture.as_of }).occurrences[0].lifecycle),
    ["published", "scheduled", "rescheduled", "cancelled"],
  );
});

test("cancellation retains identity and is communicated as a cancelled VEVENT", () => {
  const occurrence = projectCalendarOccurrences([fixture.lifecycle.cancelled], { as_of: fixture.as_of }).occurrences[0];
  assert.equal(occurrence.uid, "meeting:city_record:hearing-a");
  assert.equal(occurrence.lifecycle, "cancelled");
  assert.equal(occurrence.status, "cancelled");
  const ics = icsFeed({ title: "Hearing calendar", occurrences: [occurrence] });
  assert.match(ics, /UID:meeting:city_record:hearing-a@crol-list/);
  assert.match(ics, /STATUS:CANCELLED/);
  assert.match(ics, /SEQUENCE:2/);
});

test("explicit cancellation language is retained when the source has no typed status", () => {
  const occurrence = projectCalendarOccurrences([{
    object_ref: "meeting:city_record:hearing-b",
    scope_ref: "scope:meetings:district-33",
    title: "CANCELLED: Hearing B",
    event_date: "2026-09-20T18:00:00-04:00",
    source_system: "city_record",
    source_record_id: "hearing-b",
    source_url: "https://a856-cityrecord.nyc.gov/RequestDetail/hearing-b",
  }], { as_of: fixture.as_of }).occurrences[0];
  assert.equal(occurrence.status, "cancelled");
  assert.equal(occurrence.lifecycle, "cancelled");
});

test("same-UID rows collapse to the latest source state", () => {
  const occurrences = projectCalendarOccurrences([
    fixture.lifecycle.scheduled,
    fixture.lifecycle.rescheduled,
  ], { as_of: fixture.as_of }).occurrences;
  assert.equal(occurrences.length, 1);
  assert.equal(occurrences[0].starts_at, "2026-09-15T19:00:00-04:00");
  assert.equal(occurrences[0].sequence, 1);
});

test("ICS consumes occurrences without selecting publication time", () => {
  const { occurrences } = projectCalendarOccurrences(fixture.records, { as_of: fixture.as_of });
  const ics = icsFeed({ title: "CityScroll — fixture calendar", occurrences });
  assert.equal((ics.match(/BEGIN:VEVENT/g) || []).length, 7);
  assert.match(ics, /DTSTART;TZID=America\/New_York:20260915T180000/);
  assert.match(ics, /DTSTART;VALUE=DATE:20260911/);
  assert.match(ics, /DTEND;VALUE=DATE:20260912/);
  assert.match(ics, /SUMMARY:Bids due — School roof repair/);
  assert.match(ics, /STATUS:CANCELLED/);
  assert.doesNotMatch(ics, /20260827T120000/, "publication timestamp must not become a calendar date");
  assert.match(ics, /URL:https:\/\/cityscroll.org\/notices\/notice%3A20260827003/);
});

test("coverage accepts a matching-scope denominator independent of ingestion count", () => {
  const { occurrences } = projectCalendarOccurrences(fixture.records, { as_of: fixture.as_of });
  const coverage = calendarizationCoverage(fixture.records.slice(0, 2), occurrences.slice(0, 1), { matching_scope: 12, as_of: fixture.as_of });
  assert.equal(coverage.records_matching_scope, 12);
  assert.equal(coverage.occurrences_emitted, 1);
});

/* ===== CBICS-01: bounded display query, eligibility, density census, scope boundary ===== */

const displayRow = {
  object_ref: "meeting:history-1",
  scope_ref: "scope:meetings:district-33",
  title: "Prior public hearing",
  event_date: "2026-01-05T18:00:00-05:00",
  timezone: "America/New_York",
  canonical_url: "https://cityscroll.org/meetings/meeting%3Ahistory-1/",
  source_system: "city_record",
  source_record_id: "history-1",
  source_url: "https://a856-cityrecord.nyc.gov/RequestDetail/history-1",
  provenance: { basis: "publisher_record", field: "event_date" },
};

test("A1 the bounded display query includes a past occurrence while the feed stays future-only", () => {
  // The new path, given explicit bounds, looks backwards.
  const displayed = boundedDisplayOccurrences([displayRow], { from: "2026-01-01", to: "2026-01-31" });
  assert.equal(displayed.length, 1);
  assert.equal(occurrenceDay(displayed[0]), "2026-01-05");

  // The standing feed adapter, with the same record and an as-of after that day, emits nothing.
  const feed = calendarOccurrencesForRecord(displayRow, { kind: "meetings", as_of: "2026-06-01" });
  assert.deepEqual(feed, []);
  const projected = projectCalendarOccurrences([displayRow], { kind: "meetings", as_of: "2026-06-01" }).occurrences;
  assert.deepEqual(projected, []);

  // Bounds are a required parameter of the new path; there is no backward-looking default.
  assert.throws(() => boundedDisplayOccurrences([displayRow]), /bounds/);
});

test("A5 the additive production seam is future-agnostic and does not change the feed", () => {
  // The feed retains its future-only default (past record => no occurrence).
  assert.deepEqual(calendarOccurrencesForRecord(displayRow, { kind: "meetings", as_of: "2026-06-01" }), []);
  // The additive seam produces the same occurrence regardless of as-of, without a temporal filter.
  const candidates = displayCandidateOccurrencesForRecord(displayRow, { kind: "meetings", as_of: "2026-06-01" });
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].uid, "meeting:history-1:event");
  // A future record still flows through the feed unchanged.
  const future = { ...displayRow, object_ref: "meeting:future-1", event_date: "2026-12-05T18:00:00-05:00", canonical_url: "https://cityscroll.org/meetings/meeting%3Afuture-1/" };
  assert.equal(calendarOccurrencesForRecord(future, { kind: "meetings", as_of: "2026-06-01" }).length, 1);
});

test("A2 publication-only, derived, predicted, low-confidence, unjoined and undated records emit nothing", () => {
  const wide = { from: "2000-01-01", to: "2099-12-31" };
  const ineligible = [
    { ...displayRow, object_ref: "notice:pub", event_date: undefined, published_at: "2026-01-05T09:00:00-05:00" },
    { ...displayRow, object_ref: "notice:derived", deadline_date: "2026-01-05", event_date: undefined, derived: true, confidence: 0.2, provenance: { basis: "derived" } },
    { ...displayRow, object_ref: "meeting:predicted", predicted: true, provenance: { basis: "prediction" } },
    { ...displayRow, object_ref: "meeting:unjoined", join_status: "rejected" },
    { ...displayRow, object_ref: "notice:undated", event_date: undefined },
  ];
  for (const record of ineligible) {
    assert.deepEqual(boundedDisplayOccurrences([record], wide), [], record.object_ref);
  }
  // A single eligible record alongside them still comes through.
  assert.equal(boundedDisplayOccurrences([...ineligible, displayRow], wide).length, 1);
});

test("A3 a deterministic census records eligible, sparse, excluded and unavailable surfaces", () => {
  const census = buildCalendarDisplayOccurrenceCensus(readCorpus());
  assert.deepEqual(buildCalendarDisplayOccurrenceCensus(readCorpus()), census, "census is reproducible");
  const qualifications = new Set(census.surfaces.map((surface) => surface.qualification));
  for (const value of ["eligible", "sparse", "excluded", "unavailable"]) {
    assert.ok(qualifications.has(value), `census records a ${value} surface`);
  }
  assert.equal(census.summary.status_counts.eligible, 5);
  const rules = census.surfaces.find((surface) => surface.surface === "rules");
  assert.equal(rules.qualifies, true);
  assert.equal(rules.selected_month, "2026-03");
});

test("A4 presentation bounds and the calendar/list selector never enter serialized scope", () => {
  // The keys carry no civic meaning and the helpers strip them from any bag.
  assert.deepEqual(omitCalendarDisplayState({ stage: "public_review", calview: "calendar", calfrom: "2026-01-01", calto: "2026-02-11" }), { stage: "public_review" });
  assert.equal(stripCalendarDisplayState("#land?boro=Queens&calview=calendar&calfrom=2026-01-01"), "#land?boro=Queens");

  // A hostile facet blob that smuggles calendar display state into a route cannot reach scope.
  const blob = encodeURIComponent(JSON.stringify({ calview: "calendar", calfrom: "2026-01-01", calto: "2026-02-11", stage: "public_review" }));
  const scope = scopeFromRouteHash(`#land?boro=Queens&facet=${blob}`);
  for (const key of CALENDAR_DISPLAY_STATE_KEYS) assert.equal(key in scope.facets.values, false, key);
  assert.doesNotMatch(routeHashFromScope(scope, { surface: "land" }), /calview|calfrom|calto/);

  // A watch filter that already carries the keys cannot serialize them into Following, watch, or subscription scope.
  const hostileWatch = { lens: "meetings", filter: { process: "all", calview: "calendar", calfrom: "2026-01-01", calto: "2026-02-11" } };
  const fromWatch = scopeFromWatch(hostileWatch);
  for (const key of CALENDAR_DISPLAY_STATE_KEYS) assert.equal(key in fromWatch.facets.values, false, key);
  for (const view of [watchFromScope(fromWatch, { lens: "meetings" }).filter, subscriptionWatchFromScope(hostileWatch).filter]) {
    for (const key of CALENDAR_DISPLAY_STATE_KEYS) assert.equal(key in view, false, key);
  }

  // The bounds are a query argument, not part of occurrence identity: a different window yields the same occurrence bytes.
  const first = boundedDisplayOccurrences([displayRow], { from: "2026-01-01", to: "2026-01-31" })[0];
  const second = boundedDisplayOccurrences([displayRow], { from: "2025-06-01", to: "2026-12-31" })[0];
  assert.deepEqual(first, second);
  assert.equal("calview" in first, false);
});
