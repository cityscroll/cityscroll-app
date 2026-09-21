import assert from "node:assert/strict";
import { test } from "node:test";

import { calendarOccurrencesForRows } from "../site/calendar_occurrence.mjs";
import { calendarFeedUrlForScope } from "../site/scope_v0.mjs";
import { atomFeed, feedItems, icsFeed, jsonFeed } from "../worker/src/lib/feed.mjs";
import { handleFeed } from "../worker/src/feed.mjs";

const AVAILABILITY = {
  schema: "cityscroll.meeting_availability.v1",
  timezone: "America/New_York",
  windows: [
    { weekdays: [1, 2, 3, 4, 5], start: "17:00", end: null },
    { weekdays: [0, 6], start: null, end: null },
  ],
  unknown_start: "exclude",
};

const ROWS = [
  {
    meeting_id: "meeting:city_record:weekday-evening",
    title: "Evening hearing",
    event_date: "2026-10-05T17:00:00",
    schedule: {
      status: "resolved", precision: "exact_time", starts_at: "2026-10-05T17:00:00",
      timezone: "America/New_York", raw_date: "2026-10-05", raw_time: "17:00",
      basis: "publisher_field", source_url: "https://official.example/evening",
    },
  },
  {
    meeting_id: "meeting:public_body_calendar:weekend",
    title: "Weekend hearing",
    event_date: "2026-10-04T10:00:00",
    schedule: {
      status: "resolved", precision: "exact_time", starts_at: "2026-10-04T10:00:00",
      timezone: "America/New_York", raw_date: "2026-10-04", raw_time: "10:00",
      basis: "publisher_event", source_url: "https://official.example/weekend",
    },
  },
];

test("standing calendar URLs preserve the admitted availability expression", () => {
  const url = calendarFeedUrlForScope({ lens: "meetings", filter: { availability: AVAILABILITY } });
  assert.match(url, /lens=meetings/);
  assert.match(decodeURIComponent(url), /"availability"/);
  assert.match(decodeURIComponent(url), /America\/New_York/);
  assert.equal(calendarFeedUrlForScope({
    lens: "meetings",
    filter: { availability: { timezone: "Mars/Olympus", windows: [{ weekdays: [1] }] } },
  }), null);
});

test("JSON, Atom, and ICS preserve the same meeting identities and schedule evidence", () => {
  const items = feedItems("meetings", ROWS);
  const occurrences = calendarOccurrencesForRows(ROWS, { kind: "meetings", legacy_uid: true, as_of: "2026-09-01" });
  const json = JSON.parse(jsonFeed({ title: "Meetings", selfUrl: "https://example.test/feed.json", siteUrl: "https://cityscroll.org/", items, availability: AVAILABILITY }));
  const atom = atomFeed({ title: "Meetings", selfUrl: "https://example.test/feed.xml", siteUrl: "https://cityscroll.org/", updated: "2026-09-30T12:00:00Z", items, availability: AVAILABILITY });
  const ics = icsFeed({ title: "Meetings", occurrences, availability: AVAILABILITY });

  assert.deepEqual(json.items.map((item) => item.id), ROWS.map((row) => row.meeting_id));
  assert.deepEqual([...atom.matchAll(/<id>tag:[^,]+,\d{4}:([^<]+)<\/id>/g)].map((match) => match[1]), ROWS.map((row) => row.meeting_id));
  assert.deepEqual([...ics.matchAll(/UID:([^\r\n]+)@[^\r\n]+/g)].map((match) => match[1]), ROWS.map((row) => row.meeting_id));
  assert.deepEqual(json.cityscroll_availability, AVAILABILITY);
  assert.match(atom, /America\/New_York/);
  assert.match(atom, /https:\/\/official\.example\/evening/);
  assert.match(ics, /X-CITYSCROLL-AVAILABILITY:/);
  assert.match(ics, /X-CITYSCROLL-TEMPORAL-PRECISION:exact_time/);
  assert.match(ics, /X-CITYSCROLL-SOURCE-URL:https:\/\/official\.example\/evening/);
});

test("modern delivery refuses invalid saved availability instead of sanitizing it away", async () => {
  const filter = encodeURIComponent(JSON.stringify({
    availability: { timezone: "Mars/Olympus", windows: [{ weekdays: [1], start: "17:00" }] },
  }));
  const response = await handleFeed(new Request(`https://api.cityscroll.org/feed.json?lens=meetings&filter=${filter}`), {}, {});
  assert.equal(response.status, 400);
  assert.match(await response.text(), /cannot be admitted/);
});
