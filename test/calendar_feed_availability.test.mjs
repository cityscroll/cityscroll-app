import assert from "node:assert/strict";
import { test } from "node:test";

import { calendarOccurrencesForRows } from "../site/calendar_occurrence.mjs";
import { calendarFeedUrlForScope } from "../site/scope_v0.mjs";
import { atomFeed, feedItems, icsFeed, jsonFeed } from "../worker/src/lib/feed.mjs";
import { handleFeed } from "../worker/src/feed.mjs";
import { collapseMeetingDeliveryRows } from "../site/meeting_delivery_identity.mjs";
import {
  CANONICAL_WATCH_AVAILABILITY,
  EXPECTED_WATCH_MEETING_IDENTITIES,
  WATCH_AVAILABILITY,
  WATCH_CORPUS_ROWS,
} from "./helpers/watch_availability_corpus.mjs";

// The rows admission hands the formatters: the collapsed corpus restricted to
// the accepted identity set. Preservation of exactly these identities (and
// their schedule evidence) is this suite's job; equal acceptance across every
// surface is proven over the same corpus in watch_availability_parity.test.mjs.
const ADMITTED_ROWS = collapseMeetingDeliveryRows(WATCH_CORPUS_ROWS)
  .filter((row) => EXPECTED_WATCH_MEETING_IDENTITIES.includes(row.meeting_id));

test("standing calendar URLs preserve the admitted availability expression", () => {
  const url = calendarFeedUrlForScope({ lens: "meetings", filter: { availability: WATCH_AVAILABILITY } });
  assert.match(url, /lens=meetings/);
  assert.match(decodeURIComponent(url), /"availability"/);
  assert.match(decodeURIComponent(url), /America\/New_York/);
  assert.equal(calendarFeedUrlForScope({
    lens: "meetings",
    filter: { availability: { timezone: "Mars/Olympus", windows: [{ weekdays: [1] }] } },
  }), null);
});

test("JSON, Atom, and ICS preserve the same meeting identities and schedule evidence over the shared corpus", () => {
  const items = feedItems("meetings", ADMITTED_ROWS);
  const occurrences = calendarOccurrencesForRows(ADMITTED_ROWS, { kind: "meetings", legacy_uid: true, as_of: "0000-01-01" });
  const json = JSON.parse(jsonFeed({ title: "Meetings", selfUrl: "https://example.test/feed.json", siteUrl: "https://cityscroll.org/", items, availability: CANONICAL_WATCH_AVAILABILITY }));
  const atom = atomFeed({ title: "Meetings", selfUrl: "https://example.test/feed.xml", siteUrl: "https://cityscroll.org/", updated: "2026-09-30T12:00:00Z", items, availability: CANONICAL_WATCH_AVAILABILITY });
  const ics = icsFeed({ title: "Meetings", occurrences, availability: CANONICAL_WATCH_AVAILABILITY });
  const expectedIds = ADMITTED_ROWS.map((row) => row.meeting_id);

  assert.deepEqual(json.items.map((item) => item.id), expectedIds);
  assert.deepEqual([...atom.matchAll(/<id>tag:[^,]+,\d{4}:([^<]+)<\/id>/g)].map((match) => match[1]), expectedIds);
  assert.deepEqual([...ics.matchAll(/UID:([^\r\n]+)@[^\r\n]+/g)].map((match) => match[1]), expectedIds);
  assert.deepEqual(json.cityscroll_availability, CANONICAL_WATCH_AVAILABILITY);
  assert.match(atom, /America\/New_York/);
  for (const row of ADMITTED_ROWS) {
    assert.match(atom, new RegExp(row.schedule.source_url.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.match(ics, new RegExp(`X-CITYSCROLL-SOURCE-URL:${row.schedule.source_url.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
    assert.match(ics, new RegExp(`X-CITYSCROLL-TEMPORAL-PRECISION:${row.schedule.precision}`));
  }
  assert.match(ics, /X-CITYSCROLL-AVAILABILITY:/);
});

test("modern delivery refuses invalid saved availability instead of sanitizing it away", async () => {
  const filter = encodeURIComponent(JSON.stringify({
    availability: { timezone: "Mars/Olympus", windows: [{ weekdays: [1], start: "17:00" }] },
  }));
  const response = await handleFeed(new Request(`https://api.cityscroll.org/feed.json?lens=meetings&filter=${filter}`), {}, {});
  assert.equal(response.status, 400);
  assert.match(await response.text(), /cannot be admitted/);
});
