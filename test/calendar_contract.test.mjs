import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { meetingCalendarICS } from "../site/hearing_attend_pack.mjs";
import { followingUrlFromWatch, watchFromFollowingParams } from "../site/following_view.mjs";
import {
  calendarFeedUrlForScope,
  routeHashFromScope,
  scopeFromRouteHash,
  scopeFromWatch,
  watchFromScope,
} from "../site/scope_v0.mjs";
import { compileSub } from "../worker/src/lib/compile.mjs";
import { describeFilter } from "../worker/src/lib/confirm_email.mjs";
import { feedItems, icsFeed, parseFeedQuery } from "../worker/src/lib/feed.mjs";
import { handleFeed } from "../worker/src/feed.mjs";
import { handleMeetingICS } from "../worker/src/hearings.mjs";

const ROOT = new URL(".", import.meta.url).pathname.replace(/\/test\/$/, "");
const FIXTURE_DIR = join(ROOT, "test/fixtures/calendar-contract");
const cases = JSON.parse(readFileSync(join(FIXTURE_DIR, "cases.json"), "utf8"));

function golden(name, actual) {
  const expected = readFileSync(join(FIXTURE_DIR, name), "utf8");
  assert.equal(actual, expected, `${name} must remain byte-for-byte stable`);
}

test("standing Meetings feed retains its current ICS projection and UID namespace", () => {
  const fixture = cases.meeting_feed;
  const items = feedItems(fixture.kind, fixture.rows);
  const ics = icsFeed({ title: fixture.title, items });

  golden("meeting-feed.ics", ics);
  assert.match(ics, /PRODID:-\/\/CityScroll\/\/feeds\/\/EN/);
  for (const row of fixture.rows) {
    assert.ok(ics.includes(`UID:${row.meeting_id}@crol-list`), `UID for ${row.meeting_id} must stay in @crol-list`);
  }
});

test("individual meeting ICS keeps the separate timezone-aware calendar contract", () => {
  const ics = meetingCalendarICS(cases.individual_meeting, { now: "2026-08-26T16:00:00Z" });

  golden("meeting.ics", ics);
  assert.match(ics, /UID:meeting:city_record:20260803026@cityscroll\.org/);
  assert.match(ics, /DTSTART;TZID=America\/New_York:20260915T110000/);
  assert.match(ics, /DTEND;TZID=America\/New_York:20260915T123000/);
  assert.match(ics, /SUMMARY:Proposed Rule - Amendment of Rules relating to Certain Qualified In/);
});

test("/meeting.ics resolves the exact materialized meeting and returns that golden event", async () => {
  const raw = JSON.stringify({ rows: [cases.individual_meeting] });
  const env = { ALERT_STATE: { get: async () => raw } };
  const response = await handleMeetingICS(
    new Request("https://api.cityscroll.org/meeting.ics?id=meeting%3Acity_record%3A20260803026"),
    env,
  );
  assert.equal(response.status, 200);
  const body = await response.text();
  assert.match(body, /DTSTAMP:\d{8}T\d{6}Z/);
  golden("meeting.ics", body.replace(/DTSTAMP:\d{8}T\d{6}Z/, "DTSTAMP:20260826T160000Z"));
});

test("keyword and agency feed retains current event-date and summary projection", () => {
  const fixture = cases.keyword_agency_feed;
  const parsed = parseFeedQuery(new URL(fixture.url).searchParams);
  assert.deepEqual(parsed, {
    lens: "rules",
    filter: {
      keywords: ["rat", "inspections"],
      agency: "Health and Mental Hygiene",
      minAmount: null,
      name: null,
      kind: null,
    },
  });
  assert.equal(describeFilter(parsed.lens, parsed.filter), "Rules — about “rat / inspections” · agency “Health and Mental Hygiene”");
  golden("keyword-agency-feed.ics", icsFeed({
    title: fixture.title,
    items: feedItems(fixture.kind, fixture.rows),
  }));
});

test("README-documented lens/q/agency/min URL preserves award omission without an event date", () => {
  const fixture = cases.documented_parameter_feed;
  const parsed = parseFeedQuery(new URL(fixture.url).searchParams);
  assert.deepEqual(parsed.filter, {
    keywords: ["housing", "repair"],
    agency: "Housing Preservation and Development",
    minAmount: 500000,
    name: null,
    kind: null,
  });
  const items = feedItems(fixture.kind, fixture.rows);
  assert.equal(items[0].date, "2026-08-05T00:00:00.000");
  assert.equal(items[0].eventDate, null, "registered awards have no calendar event date");
  golden("documented-parameter-feed.ics", icsFeed({ title: fixture.title, items }));
  assert.doesNotMatch(readFileSync(join(FIXTURE_DIR, "documented-parameter-feed.ics"), "utf8"), /BEGIN:VEVENT/);
});

test("compileSub and Following retain the current query and watch serialization boundaries", () => {
  const meetingQuery = compileSub({
    lens: "meetings",
    filter: { keywords: ["rat", "inspections"], agency: "Health and Mental Hygiene" },
  }, "2026-08-26");
  assert.equal(meetingQuery.kind, "meetings");
  assert.equal(meetingQuery.routeReadModel.kind, "meetings");
  assert.deepEqual(meetingQuery.routeReadModel.filter, {
    keywords: ["rat", "inspections"],
    agency: "Health and Mental Hygiene",
  });

  const rulesQuery = compileSub({
    lens: "rules",
    filter: { keywords: ["rat", "inspections"], agency: "Health and Mental Hygiene" },
  }, "2026-08-26");
  assert.match(rulesQuery.params.$where, /section_name='Agency Rules'/);
  assert.match(rulesQuery.params.$where, /agency_name='Health and Mental Hygiene'/);
  assert.equal(rulesQuery.params.$q, "rat inspections");

  const watch = watchFromFollowingParams(new URLSearchParams({
    lens: "meetings",
    filter: JSON.stringify({ keywords: ["rat"], agency: "Health and Mental Hygiene" }),
  }));
  assert.deepEqual(watch.filter, { keywords: ["rat"], agency: "Health and Mental Hygiene" });
  assert.equal(watch.lens, "meetings");
});

test("one canonical civic scope keeps its normalized query across Browse, Following, preview, email, and calendar", async () => {
  const scope = scopeFromRouteHash("#meetings?agency=City%20Planning&council=33");
  const watch = watchFromScope(scope, { lens: "meetings" });
  const browseScope = scopeFromRouteHash(routeHashFromScope(scope, { surface: "meetings" }));
  const followingUrl = followingUrlFromWatch(watch);
  const followingScope = scopeFromWatch(watch);
  const previewQuery = compileSub(watch, "2026-08-26");
  const emailScope = scopeFromWatch(watch);
  const calendarUrl = calendarFeedUrlForScope(scope);
  const calendarQuery = parseFeedQuery(new URL(calendarUrl).searchParams);
  const calendarScope = scopeFromWatch(calendarQuery);

  assert.equal(new URL(followingUrl).searchParams.get("lens"), "meetings");
  assert.equal(new URL(calendarUrl).searchParams.get("lens"), "meetings");
  assert.equal(new URL(followingUrl).search, new URL(calendarUrl).search);
  assert.deepEqual(followingScope, browseScope);
  assert.deepEqual(emailScope, browseScope);
  assert.deepEqual(scopeFromWatch({ lens: previewQuery.routeReadModel.kind, filter: previewQuery.routeReadModel.filter }), browseScope);
  assert.deepEqual(calendarScope, browseScope);
  assert.equal(previewQuery.routeReadModel.filter.councilDistrict, "33");
  assert.equal(calendarQuery.modern, true);

  const response = await handleFeed(new Request(calendarUrl), {}, {});
  assert.equal(response.status, 200, "the canonical scope must be accepted by the standing feed");
});

test("modern feed filters use the Following JSON wire and reject unsupported replay dimensions", async () => {
  const modern = new URL("https://api.cityscroll.org/feed.ics");
  modern.searchParams.set("lens", "meetings");
  modern.searchParams.set("filter", JSON.stringify({ agency: "City Planning", process: "held" }));
  const parsed = parseFeedQuery(modern.searchParams);
  assert.equal(parsed.modern, true);
  assert.deepEqual(parsed.filter, { agency: "City Planning", process: "held" });

  const response = await handleFeed(new Request(modern), {}, {});
  assert.equal(response.status, 400);
  assert.match(await response.text(), /cannot be replayed: process/);
});

test("calendar scope projection suppresses scope dimensions that would be lost", () => {
  const withViewport = scopeFromRouteHash("#meetings?council=33");
  withViewport.place.viewport = {
    level: "council_district",
    id: "33",
    parent: null,
    basis: "performance",
    view_box: null,
  };
  assert.equal(calendarFeedUrlForScope(withViewport), null);

  const relation = scopeFromRouteHash("#meetings?facet=" + encodeURIComponent(JSON.stringify({
    entity_refs_all: ["project:2026R0127"],
  })));
  assert.equal(calendarFeedUrlForScope(relation), null);
});
