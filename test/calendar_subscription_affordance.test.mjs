import assert from "node:assert/strict";
import { test } from "node:test";

import { readFileSync } from "node:fs";

import {
  calendarOccurrenceForRow,
  calendarNativeSubscriptionUrl,
  calendarScopeLabel,
  calendarSubscriptionDetailsForScope,
  calendarSubscriptionHrefForBrowseView,
  calendarSubscriptionHrefForScope,
  hasDefensibleDatedOccurrences,
  renderCalendarSubscriptionAffordance,
  renderCalendarSubscriptionHandoff,
} from "../site/calendar_subscription.mjs";
import { calendarOccurrencesForRows } from "../site/calendar_occurrence.mjs";
import { meetingCalendarICS } from "../site/hearing_attend_pack.mjs";
import {
  collapseMeetingDeliveryRows,
  meetingDeliveryKey,
  reconcileMeetingDelivery,
} from "../site/meeting_delivery_identity.mjs";
import { buildBrowseView, renderBrowseView } from "../site/browse_view.mjs";
import { scopeFromRouteHash } from "../site/scope_v0.mjs";
import { compileSub } from "../worker/src/lib/compile.mjs";
import { icsFeed } from "../worker/src/lib/feed.mjs";
import { loadMeetingRecord } from "../worker/src/lib/route_read_model_kv.mjs";

const upcomingFixture = JSON.parse(readFileSync(new URL("./fixtures/legistar/upcoming_contracts_22691.json", import.meta.url)));
const PINNED_TODAY = "2026-09-09";
const FIXTURE_EVENT_ID = String(upcomingFixture.event.EventId);
const FIXTURE_MEETING_ID = `meeting:nyc_legistar_events:${FIXTURE_EVENT_ID}`;
const FIXTURE_VENUE = "250 Broadway - 8th Floor - Hearing Room 2";

function councilNativeCompileRows(filter = {}) {
  return compileSub({ lens: "meetings", filter }, PINNED_TODAY).readRows();
}

function councilNativeSubscriptionIcs(rows) {
  return icsFeed({
    title: "CityScroll — meetings",
    occurrences: calendarOccurrencesForRows(rows, {
      kind: "meetings",
      legacy_uid: true,
      as_of: PINNED_TODAY,
    }),
  });
}

test("subscription eligibility requires a feed identity and a defensible date", () => {
  assert.deepEqual(
    calendarOccurrenceForRow("meetings", {
      meeting_id: "meeting:city_record:123",
      event_date: "2026-09-15T11:00:00.000",
    }),
    { id: "meeting:city_record:123", date: "2026-09-15T11:00:00.000" },
  );
  assert.equal(calendarOccurrenceForRow("meetings", { event_date: "2026-09-15" }), null);
  assert.equal(calendarOccurrenceForRow("meetings", { meeting_id: "meeting:1" }), null);
  assert.equal(calendarOccurrenceForRow("money", { procurement_id: "CT1", due_date: "2026-09-15" }), null);
  assert.deepEqual(
    calendarOccurrenceForRow("people", { exam_number: "7016", application_end: "2026-09-30" }),
    { id: "exam:7016", date: "2026-09-30" },
  );
  assert.equal(calendarOccurrenceForRow("people", { exam_number: "7016" }), null);
  assert.equal(calendarOccurrenceForRow("land", { request_id: "1", event_date: "2026-09-15" }), null);
  assert.equal(hasDefensibleDatedOccurrences("rules", [{ request_id: "1", due_date: "2026-09-15" }]), true);
  assert.equal(hasDefensibleDatedOccurrences("rules", [{ request_id: "1" }]), false);
});

test("civil-service exam subscription keeps the guide scope and label", () => {
  const scope = scopeFromRouteHash("#people?agency=Parks%20and%20Recreation&view=guide");
  const href = calendarSubscriptionHrefForScope(scope, {
    lens: "people",
    rows: [{ exam_number: "7016", application_start: "2026-09-01", application_end: "2026-09-30" }],
  });
  assert.ok(href);
  const url = new URL(href);
  assert.equal(url.searchParams.get("lens"), "people");
  assert.deepEqual(JSON.parse(url.searchParams.get("filter")), {
    agency: "Parks and Recreation",
    view: "guide",
  });
  const details = calendarSubscriptionDetailsForScope(scope, {
    lens: "people",
    rows: [{ exam_number: "7016", application_end: "2026-09-30" }],
  });
  assert.match(details.scopeLabel, /Civil-service exams/);
  assert.match(details.scopeLabel, /Parks and Recreation/);
});

test("subscription URL reuses the complete displayed scope serialization", () => {
  const scope = scopeFromRouteHash("#meetings?agency=City%20Planning&council=33&when=upcoming");
  const href = calendarSubscriptionHrefForScope(scope, {
    rows: [{ meeting_id: "meeting:city_record:123", event_date: "2026-09-15" }],
  });
  assert.ok(href);
  const url = new URL(href);
  assert.equal(url.searchParams.get("lens"), "meetings");
  assert.deepEqual(JSON.parse(url.searchParams.get("filter")), {
    agency: "City Planning",
    councilDistrict: "33",
    dateWindow: "upcoming",
    when: "upcoming",
  });
});

test("Browse renders a subscription sibling only for eligible dated rows", () => {
  const eligible = buildBrowseView("meetings", {
    rows: [{
      meeting_id: "meeting:city_record:123",
      title: "Public hearing",
      agency_name: "City Planning",
      event_date: "2026-09-15T11:00:00.000",
    }],
  }, new URLSearchParams("agency=City%20Planning"));
  const html = renderBrowseView(eligible);
  assert.match(html, /class="calendar-subscribe-btn"[^>]+aria-label="Subscribe to calendar"/);
  assert.match(html, />Subscribe to calendar<\/a>/);
  assert.doesNotMatch(html, /ui-object-card-action-rail|What can I do now/);

  const empty = buildBrowseView("meetings", {
    rows: [{ meeting_id: "meeting:city_record:456", title: "Undated notice" }],
  });
  assert.doesNotMatch(renderBrowseView(empty), /Subscribe to calendar/);
});

test("Browse subscription helper remains fail-closed for unsupported scope dimensions", () => {
  const scope = scopeFromRouteHash("#meetings?council=33");
  scope.place.viewport = { level: "council_district", id: "33", parent: null, basis: "performance", view_box: null };
  const view = {
    facet: "meetings",
    config: { tab: "meetings" },
    scope: { mode: "scoped" },
    scopeObject: scope,
    calendarRows: [{ meeting_id: "meeting:1", event_date: "2026-09-15" }],
  };
  assert.equal(calendarSubscriptionHrefForBrowseView(view), null);
  assert.equal(renderCalendarSubscriptionAffordance(view), "");
});

test("handoff keeps HTTPS for copying and uses webcal for native subscription", () => {
  const scope = scopeFromRouteHash("#meetings?agency=City%20Planning&council=33&when=upcoming");
  const details = calendarSubscriptionDetailsForScope(scope, {
    rows: [{ meeting_id: "meeting:city_record:123", event_date: "2026-09-15" }],
  });
  assert.ok(details);
  assert.match(details.feedUrl, /^https:\/\//);
  assert.match(details.webcalUrl, /^webcal:\/\//);
  assert.equal(calendarNativeSubscriptionUrl(details.feedUrl), details.webcalUrl);
  assert.match(details.scopeLabel, /Meetings/);
  assert.match(details.scopeLabel, /City Planning/);
  assert.match(details.scopeLabel, /Council District 33/);
  assert.equal(calendarScopeLabel(scope, "meetings"), details.scopeLabel);
  const handoff = renderCalendarSubscriptionHandoff(details);
  assert.match(handoff, /<dialog[^>]+data-calendar-subscription-dialog/);
  assert.match(handoff, /Subscribe to Meetings/);
  assert.match(handoff, /Keep new and rescheduled events from this scope in your calendar automatically/);
  assert.match(handoff, /href="webcal:/);
  assert.match(handoff, /data-copy-url="https:/);
  assert.match(handoff, /Open calendar subscription/);
  assert.match(handoff, /Copy subscription URL/);
  assert.match(handoff, /Google Calendar/);
  assert.match(handoff, /Outlook/);
  assert.match(handoff, /How to subscribe/);
  assert.match(handoff, /Auto-refresh/);
  assert.match(handoff, /up to 12 hours/);
  assert.doesNotMatch(handoff, /calendar_subscribed|Calendar: Active/);
});

test("the committed Council fixture is the Events feed EventId, not the InSite calendar number", () => {
  assert.equal(FIXTURE_EVENT_ID, "22691");
  assert.equal(String(upcomingFixture.insite_calendar.meeting_id), "1439673");
  assert.notEqual(FIXTURE_EVENT_ID, String(upcomingFixture.insite_calendar.meeting_id));
});

test("Council-native fixture appears in one-event ICS at New York wall time and venue", async () => {
  const rows = councilNativeCompileRows({ keywords: ["disparity study"] });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].meeting_id, FIXTURE_MEETING_ID);
  assert.equal(rows[0].request_id, FIXTURE_MEETING_ID);
  assert.equal(rows[0].event_date, "2026-09-23T10:00:00");
  assert.equal(rows[0].venue.address, FIXTURE_VENUE);
  assert.doesNotMatch(String(rows[0].request_id), /^20\d{6}/);

  const ics = meetingCalendarICS(rows[0], { now: "2026-09-09T12:00:00.000Z" });
  assert.match(ics, /BEGIN:VEVENT/);
  assert.equal((ics.match(/BEGIN:VEVENT/g) || []).length, 1);
  assert.match(ics, new RegExp(`UID:${FIXTURE_MEETING_ID.replaceAll(":", "\\:")}@cityscroll\\.org`));
  assert.match(ics, /DTSTART;TZID=America\/New_York:20260923T100000/);
  assert.match(ics, new RegExp(`LOCATION:${FIXTURE_VENUE.replaceAll(" ", "\\s")}`));
  assert.doesNotMatch(ics, /Join online|Dial-in|Passcode/);

  const served = await loadMeetingRecord({}, FIXTURE_MEETING_ID);
  assert.equal(served.meeting_id, FIXTURE_MEETING_ID);
  const servedIcs = meetingCalendarICS(served, { now: "2026-09-09T12:00:00.000Z" });
  assert.match(servedIcs, /DTSTART;TZID=America\/New_York:20260923T100000/);
  assert.match(servedIcs, /250 Broadway - 8th Floor - Hearing Room 2/);
});

test("Council-native fixture appears once in the meetings subscription ICS", () => {
  const rows = councilNativeCompileRows({ keywords: ["M/WBE"] });
  const ics = councilNativeSubscriptionIcs(rows);
  assert.equal((ics.match(/BEGIN:VEVENT/g) || []).length, 1);
  assert.match(ics, new RegExp(`UID:${FIXTURE_MEETING_ID.replaceAll(":", "\\:")}@crol-list`));
  assert.match(ics, /DTSTART;TZID=America\/New_York:20260923T100000/);
  assert.match(ics, /250 Broadway - 8th Floor - Hearing Room 2/);
  assert.equal(calendarOccurrenceForRow("meetings", rows[0])?.id, FIXTURE_MEETING_ID);
});

test("calendar compilation keeps cancellation and reschedule on the original EventId", () => {
  const base = councilNativeCompileRows({ keywords: ["disparity study"] })[0];
  const cancelled = collapseMeetingDeliveryRows([{ ...base, status: "cancelled", lifecycle: "cancelled" }])[0];
  const cancelledIcs = meetingCalendarICS(cancelled, { now: "2026-09-09T12:00:00.000Z" });
  assert.match(cancelledIcs, new RegExp(`UID:${FIXTURE_MEETING_ID.replaceAll(":", "\\:")}@cityscroll\\.org`));
  assert.match(cancelledIcs, /STATUS:CANCELLED/);

  const rescheduled = collapseMeetingDeliveryRows([{
    ...base,
    lifecycle: "rescheduled",
    sequence: 1,
    event_date: "2026-09-24T11:00:00",
    last_modified: "2026-09-10T15:00:00.000Z",
  }])[0];
  const rescheduledIcs = councilNativeSubscriptionIcs([rescheduled]);
  assert.equal((rescheduledIcs.match(/BEGIN:VEVENT/g) || []).length, 1);
  assert.match(rescheduledIcs, new RegExp(`UID:${FIXTURE_MEETING_ID.replaceAll(":", "\\:")}@crol-list`));
  assert.match(rescheduledIcs, /DTSTART;TZID=America\/New_York:20260924T110000/);
  assert.match(rescheduledIcs, /SEQUENCE:1/);
});

test("an exact later City Record join keeps one calendar event on the original EventId", () => {
  const legistar = councilNativeCompileRows({ keywords: ["disparity study"] })[0];
  const city = {
    meeting_id: "meeting:city_record:20260923001",
    source_system: "city_record",
    title: "Committee on Contracts meeting — M/WBE Utilization and the Required Disparity Study",
    event_date: "2026-09-23T10:00:00",
    venue: { address: FIXTURE_VENUE },
    collection_visibility: "visible",
    same_proceeding: {
      meeting_ids: ["meeting:city_record:20260923001", FIXTURE_MEETING_ID],
      nyc_legistar_events_meeting_id: FIXTURE_MEETING_ID,
      city_record_meeting_id: "meeting:city_record:20260923001",
    },
    source_url: "https://a856-cityrecord.nyc.gov/RequestDetail/20260923001",
  };
  const collapsed = collapseMeetingDeliveryRows([
    { ...legistar, collection_visibility: "suppressed", same_proceeding: city.same_proceeding },
    city,
  ]);
  assert.equal(collapsed.length, 1);
  assert.equal(meetingDeliveryKey(collapsed[0]), FIXTURE_MEETING_ID);
  const ics = councilNativeSubscriptionIcs(collapsed);
  assert.equal((ics.match(/BEGIN:VEVENT/g) || []).length, 1);
  assert.match(ics, new RegExp(`UID:${FIXTURE_MEETING_ID.replaceAll(":", "\\:")}@crol-list`));
});

test("temporal delivery keys cover first observation, replay, join, reschedule, cancellation, and a near-candidate", () => {
  const identity = { meeting_id: FIXTURE_MEETING_ID, source_system: "nyc_legistar_events", event_date: "2026-09-23T10:00:00" };
  const first = reconcileMeetingDelivery({ rows: [identity], seen: new Set() });
  assert.equal(first.fresh.length, 1);
  assert.ok(first.markSeenIds.includes(FIXTURE_MEETING_ID));

  const replay = reconcileMeetingDelivery({ rows: [identity], seen: new Set(first.markSeenIds) });
  assert.equal(replay.fresh.length, 0);

  const joined = {
    meeting_id: "meeting:city_record:20260923001",
    source_system: "city_record",
    event_date: "2026-09-23T10:00:00",
    same_proceeding: {
      meeting_ids: ["meeting:city_record:20260923001", FIXTURE_MEETING_ID],
      nyc_legistar_events_meeting_id: FIXTURE_MEETING_ID,
      city_record_meeting_id: "meeting:city_record:20260923001",
    },
  };
  const afterJoin = reconcileMeetingDelivery({ rows: [joined], seen: new Set(first.markSeenIds) });
  assert.equal(afterJoin.fresh.length, 0);
  assert.ok(afterJoin.markSeenIds.includes("meeting:city_record:20260923001"));

  const rescheduled = reconcileMeetingDelivery({
    rows: [{ ...identity, lifecycle: "rescheduled", event_date: "2026-09-24T11:00:00" }],
    seen: new Set(first.markSeenIds),
  });
  assert.equal(rescheduled.fresh.length, 1);

  const cancelled = reconcileMeetingDelivery({
    rows: [{ ...identity, lifecycle: "cancelled" }],
    seen: new Set(first.markSeenIds),
  });
  assert.equal(cancelled.fresh.length, 1);

  const nearCandidate = {
    meeting_id: "meeting:city_record:20260923002",
    source_system: "city_record",
    event_date: "2026-09-23T10:00:00",
  };
  const unmatched = reconcileMeetingDelivery({
    rows: [joined, nearCandidate],
    seen: new Set(first.markSeenIds),
  });
  assert.equal(unmatched.fresh.map((row) => row.meeting_id).join(), nearCandidate.meeting_id);
});
