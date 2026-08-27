import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import {
  CALENDAR_OCCURRENCE_KINDS,
  CALENDAR_OCCURRENCE_STATUSES,
  calendarizationCoverage,
  createCalendarOccurrence,
  projectCalendarOccurrences,
} from "../site/calendar_occurrence.mjs";
import { icsFeed } from "../worker/src/lib/feed.mjs";

const fixture = JSON.parse(readFileSync(new URL("./fixtures/calendar-occurrences/cases.json", import.meta.url), "utf8"));

test("CalendarOccurrence is a validated, presentation-neutral contract", () => {
  assert.deepEqual(CALENDAR_OCCURRENCE_KINDS, ["event", "deadline", "window_open", "window_close", "milestone"]);
  assert.deepEqual(CALENDAR_OCCURRENCE_STATUSES, ["scheduled", "cancelled", "completed"]);
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
  assert.equal(occurrences.filter((item) => item.kind === "deadline").length, 1);
  assert.equal(occurrences.filter((item) => item.kind === "window_open").length, 1);
  assert.equal(occurrences.filter((item) => item.kind === "window_close").length, 1);
  assert.equal(occurrences.find((item) => item.kind === "deadline").title, "Bids due — School roof repair");
  assert.equal(occurrences.find((item) => item.object_ref.includes("remote")).location, "Online — https://meet.example.gov/transportation");
  assert.equal(occurrences.find((item) => item.kind === "window_close").title, "Applications close — Associate Staff Analyst exam");
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

test("rescheduling retains the producer-owned UID while changing the time", () => {
  const current = projectCalendarOccurrences([fixture.records[4]], { as_of: fixture.as_of }).occurrences[0];
  const previous = projectCalendarOccurrences([fixture.rescheduled_previous], { as_of: fixture.as_of }).occurrences[0];
  assert.equal(current.uid, previous.uid);
  assert.notEqual(current.starts_at, previous.starts_at);
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
