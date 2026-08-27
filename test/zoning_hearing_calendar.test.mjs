import assert from "node:assert/strict";
import { test } from "node:test";

import { buildBrowseView, renderBrowseView } from "../site/browse_view.mjs";
import {
  calendarSubscriptionHrefForScope,
  calendarSubscriptionHrefForBrowseView,
} from "../site/calendar_subscription.mjs";
import { scopeFromRouteHash } from "../site/scope_v0.mjs";
import {
  zoningHearingCalendarOccurrence,
  zoningHearingOccurrencesForScope,
  zoningHearingRowsForScope,
} from "../site/zoning_hearing_calendar.mjs";
import { compileSub, rowsForCompiledQuery } from "../worker/src/lib/compile.mjs";
import { feedItems, icsFeed } from "../worker/src/lib/feed.mjs";

const PROJECTS = [
  {
    project_id: "2026Q0001",
    project_name: "Known Rezoning",
    project_status: "Active",
    borough: "Queens",
    community_district: "Q07",
    cc_district: "33",
  },
  {
    project_id: "2026Q0002",
    project_name: "Adjacent Rezoning",
    project_status: "Active",
    borough: "Queens",
    community_district: "Q08",
    cc_district: "34",
  },
];

function hearing(overrides = {}) {
  return {
    schema_version: 1,
    source: "zap-api-milestones",
    project_id: "2026Q0001",
    project_name: "Known Rezoning",
    milestone_id: "hearing-1",
    milestone_title: "CPC Public Meeting - Public Hearing",
    milestone_source_title: "CPC Public Meeting - Public Hearing",
    event_class: "cpc_public_hearing",
    representing: "City Planning Commission",
    hearing_date: "2026-09-15",
    hearing_at: "2026-09-15T22:30:00.000Z",
    cc_district: "33",
    venue_address: "123 Main Street, Queens",
    portal_url: "https://zap.planning.nyc.gov/projects/2026Q0001",
    provenance: { field: "dcp-reviewmeetingdate", source: "zap-api-milestones" },
    ...overrides,
  };
}

test("district scope shares one precise upcoming hearing across Browse, Following, and calendar", async () => {
  const hearings = [
    hearing(),
    hearing({ project_id: "2026Q0002", project_name: "Adjacent Rezoning", milestone_id: "hearing-2", cc_district: "34" }),
  ];
  const filter = { councilDistrict: "33", futureAction: "hearing" };
  const rows = zoningHearingRowsForScope(hearings, PROJECTS, filter, { today: "2026-09-01" });
  assert.deepEqual(rows.map((row) => row.project_id), ["2026Q0001"]);

  const view = buildBrowseView("zoning", { projects: PROJECTS, hearings }, new URLSearchParams("future=hearing&council=33"), {
    asOf: "2026-09-01",
  });
  assert.equal(view.total, 1);
  assert.equal(view.calendarRows.length, 1);
  assert.match(renderBrowseView(view), /Subscribe to calendar/);
  assert.match(renderBrowseView(view), /Known Rezoning/);
  assert.match(renderBrowseView(view), /browse\/zoning\/#land\/2026Q0001/);
  assert.ok(calendarSubscriptionHrefForBrowseView(view));

  const query = compileSub({ lens: "land", filter }, "2026-09-01");
  assert.equal(query.kind, "land-hearings");
});

test("calendar occurrence carries published logistics and the same UID survives rescheduling", () => {
  const original = hearing();
  const rescheduled = hearing({
    hearing_date: "2026-09-22",
    hearing_at: "2026-09-22T22:30:00.000Z",
    updated_at: "2026-09-10T12:00:00.000Z",
  });
  const first = zoningHearingCalendarOccurrence(original, { scope_ref: "council-district:33" });
  const next = zoningHearingCalendarOccurrence(rescheduled, { scope_ref: "council-district:33" });
  assert.equal(first.uid, next.uid);
  assert.equal(next.starts_at, "2026-09-22T18:30:00");
  assert.equal(next.timezone, "America/New_York");
  assert.equal(next.location, "123 Main Street, Queens");
  assert.equal(next.object_ref, "project:2026Q0001");
  assert.equal(next.canonical_url, original.portal_url);

  const occurrences = zoningHearingOccurrencesForScope(
    [original, rescheduled],
    PROJECTS,
    { councilDistrict: "33" },
    { today: "2026-09-01" },
  );
  assert.equal(occurrences.length, 1);
  const calendar = icsFeed({ title: "Zoning hearings · Council District 33", occurrences });
  assert.equal((calendar.match(/BEGIN:VEVENT/g) || []).length, 1);
  assert.match(calendar, /DTSTART;TZID=America\/New_York:20260922T183000/);
  assert.doesNotMatch(calendar, /20260915/);
});

test("low-confidence inferred geography does not become a district calendar event", () => {
  const lowConfidence = hearing({
    geography_confidence: "inferred",
    community_district: "Q07",
    cc_district: "33",
  });
  assert.deepEqual(
    zoningHearingRowsForScope([lowConfidence], [], { councilDistrict: "33" }, { today: "2026-09-01" }),
    [],
  );
  assert.equal(zoningHearingCalendarOccurrence({ ...lowConfidence, _geography_eligible: false }), null);
});

test("attendance scope keeps published in-person, livestream, and hybrid details precise", () => {
  const inPerson = hearing({ attendance_modes: ["in_person"], venue_address: "123 Main Street, Queens" });
  const livestream = hearing({ milestone_id: "hearing-live", attendance_modes: ["livestream"], venue_address: null, livestream_url: "https://example.test/live" });
  const hybrid = hearing({ milestone_id: "hearing-hybrid", attendance_modes: ["in_person", "livestream"], livestream_url: "https://example.test/live" });
  assert.deepEqual(zoningHearingRowsForScope([inPerson, livestream, hybrid], PROJECTS, { councilDistrict: "33", attendance: "in_person" }, { today: "2026-09-01" }).map((row) => row.milestone_id), ["hearing-1", "hearing-hybrid"]);
  assert.deepEqual(zoningHearingRowsForScope([inPerson, livestream, hybrid], PROJECTS, { councilDistrict: "33", attendance: "livestream" }, { today: "2026-09-01" }).map((row) => row.milestone_id), ["hearing-live", "hearing-hybrid"]);
});

test("modern calendar scope preserves the hearing action and district filter", () => {
  const scope = scopeFromRouteHash("#land?future=hearing&council=33");
  const href = calendarSubscriptionHrefForScope(scope, {
    lens: "land",
    rows: [hearing({ cc_district: "33" })],
  });
  assert.ok(href);
  const filter = JSON.parse(new URL(href).searchParams.get("filter"));
  assert.equal(filter.futureAction, "hearing");
  assert.equal(filter.councilDistrict, "33");
  assert.deepEqual(feedItems("land-hearings", [hearing({ cc_district: "33" })])[0], {
    id: "2026Q0001",
    url: "https://zap.planning.nyc.gov/projects/2026Q0001",
    title: "Public hearing — Known Rezoning",
    date: "2026-09-15T22:30:00.000Z",
    summary: "City Planning Commission · 123 Main Street, Queens",
    eventDate: "2026-09-15T22:30:00.000Z",
    phase: "Zoning hearing",
    nextStep: "Event 2026-09-15",
  });
});

test("published date-only hearing remains date-only rather than inventing a time", () => {
  const occurrence = zoningHearingCalendarOccurrence(hearing({
    parse_status: "published_date_only",
    hearing_date: "2026-09-15",
    hearing_at: "2026-09-15T04:00:00.000Z",
  }));
  assert.equal(occurrence.date, "2026-09-15");
  assert.equal(occurrence.starts_at, null);
});
