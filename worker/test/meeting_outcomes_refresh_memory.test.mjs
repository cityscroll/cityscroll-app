/**
 * The meeting-outcomes refresh must publish every joined record without
 * retaining unused publisher payload beside the assembled view. A page of
 * oversized unused fields has to be released before the next page is kept.
 *
 * verify: node --test worker/test/meeting_outcomes_refresh_memory.test.mjs
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

import { buildMeetingOutcomes, refreshMeetingOutcomes } from "../src/lib/meeting_outcomes.mjs";

const CHILD_FLAG = "CITYSCROLL_MEETING_REFRESH_MEMORY_CHILD";
const EVENT_PAGE_SIZE = 200;
const EVENT_PAGES = 4;
const BLOB_CHARS = 100_000;
const NOW = new Date("2026-11-18T12:00:00.000Z");

function eventRow(index) {
  const day = String(1 + (index % 28)).padStart(2, "0");
  const upcoming = index < 3;
  return {
    EventId: 70_000 + index,
    EventBodyName: `Committee ${index % 12}`,
    EventDate: upcoming ? `2026-12-${day}T00:00:00` : `2026-04-${day}T00:00:00`,
    EventTime: "10:00 AM",
    EventLocation: "250 Broadway, New York, NY 10007",
    UnusedPublisherBlob: "Z".repeat(BLOB_CHARS),
  };
}

function noticeRows() {
  return [{
    request_id: "20261118001",
    start_date: "2026-11-01T00:00:00.000",
    agency_name: "City Council",
    type_of_notice_description: "Public Hearing",
    section_name: "Public Hearings and Meetings",
    short_title: "Unmatched public hearing",
    event_date: "2026-11-18T00:00:00.000",
  }];
}

function jsonResponse(value) {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function fixtureFetch() {
  return async (input) => {
    const url = new URL(String(input));
    if (url.hostname === "data.cityofnewyork.us") return jsonResponse(noticeRows());
    if (/\/Events$/.test(url.pathname)) {
      const skip = Number(url.searchParams.get("$skip") || 0);
      const page = Array.from({ length: EVENT_PAGE_SIZE }, (_, index) => eventRow(skip + index));
      return jsonResponse(page);
    }
    const itemMatch = /\/Events\/(\d+)\/EventItems$/.exec(url.pathname);
    if (itemMatch) return jsonResponse([]);
    if (/\/Votes$/.test(url.pathname)) return jsonResponse([]);
    throw new Error(`unexpected fixture request ${url.pathname}`);
  };
}

test("streamed meeting outcomes keep every record from the retained assembly", () => {
  const notices = noticeRows();
  const events = [eventRow(0), eventRow(20)];
  const items = [{
    EventItemId: 1,
    EventItemEventId: events[0].EventId,
    EventItemTitle: "A resolution",
    EventItemMatterId: 55,
    EventItemMatterName: "A resolution",
    EventItemActionName: "Adopted",
    UnusedPublisherBlob: "not-a-public-field",
  }];
  const retained = buildMeetingOutcomes(notices, events, items, [], []);
  const streamed = buildMeetingOutcomes(notices, events, items, [], [], { emitJson: true });
  assert.equal(streamed.counts.records, retained.counts.records);
  assert.equal(streamed.counts.event_rows, retained.counts.event_rows);
  const parsed = JSON.parse(streamed.json);
  delete parsed.generated_at;
  delete retained.generated_at;
  assert.deepEqual(parsed, retained);
  assert.equal(streamed.json.includes("UnusedPublisherBlob"), false);
  assert.equal(JSON.stringify(retained).includes("UnusedPublisherBlob"), false);
});

if (process.env[CHILD_FLAG] === "1") {
  const values = new Map();
  const env = {
    LEGISTAR_API_TOKEN: "fixture-token",
    LEGISTAR_SOURCE_RECORD_DUAL_WRITE: "false",
    ALERT_STATE: {
      async get(key) { return values.get(key) ?? null; },
      async put(key, value) {
        if (String(key).includes("publisher-spill")) return;
        values.set(key, value);
      },
      async delete(key) { values.delete(key); },
    },
  };
  const result = await refreshMeetingOutcomes(env, fixtureFetch(), NOW);
  const published = JSON.parse(values.get("meeting-outcomes:materialized:v2"));
  if (published.counts.event_rows !== EVENT_PAGE_SIZE * EVENT_PAGES) {
    throw new Error(`event_rows ${published.counts.event_rows}`);
  }
  if (JSON.stringify(published).includes("UnusedPublisherBlob")) {
    throw new Error("unused publisher payload was published");
  }
  if (!published.generated_at || published.generated_at === "2026-11-16T08:00:44.881Z") {
    throw new Error("publication did not advance");
  }
  if (result.status !== "success") throw new Error(result.status);
  process.stdout.write(`${published.counts.event_rows}\n`);
} else {
  test("refresh releases unused publisher payload before the next events page is retained", () => {
    const result = spawnSync(process.execPath, [
      "--max-old-space-size=80",
      new URL(import.meta.url).pathname,
    ], {
      cwd: process.cwd(),
      encoding: "utf8",
      timeout: 120_000,
      env: { ...process.env, [CHILD_FLAG]: "1" },
    });
    assert.equal(
      result.status,
      0,
      `refresh retained the unused publisher payload (status=${result.status})\n${result.stderr}`,
    );
    assert.match(result.stdout, /800/);
  });
}
