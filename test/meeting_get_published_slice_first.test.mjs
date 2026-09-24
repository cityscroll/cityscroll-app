// Exact meeting.get must answer from the published per-id route slice and must
// not JSON.parse the daily hearings:location blob first. That blob can hold the
// whole shared meeting corpus and is what tipped production into Cloudflare
// Error 1102 (worker_exceeded_resources) on the live MCP canary.
//
// Verify: node --test test/meeting_get_published_slice_first.test.mjs

import assert from "node:assert/strict";
import test from "node:test";

import { HEARINGS_KV_KEY, workerMeetingGet } from "../worker/src/hearings.mjs";
import { buildMeetings } from "../tools/build_worker_route_read_models.mjs";

const MEETING_MANIFEST_KEY = "route-read-model:meetings:manifest:v1";

const meeting = {
  object_type: "meeting",
  meeting_id: "meeting:community_board:https://example.org/event/full-board-meeting/",
  source_system: "community_board",
  source_record_id: "full-board-meeting",
  title: "Public Hearing & Full Board Meeting",
  event_date: "2026-01-08T18:00:00-05:00",
  source_receipt: {
    schema: "cityscroll.meeting_source_receipt.v1",
    status: "ok",
    observed_at: "2026-09-07T13:15:46.599Z",
  },
  source_record: {
    source_system: "community_board",
    identifier: "https://example.org/event/full-board-meeting/",
    receipt: { status: "ok" },
  },
};

function model(rows = [meeting]) {
  return {
    schema: "cityscroll.shared_meeting_read_model.v1",
    version: 1,
    generated_at: "2026-09-07T13:15:46.599Z",
    freshness: { generated_at: "2026-09-07T13:15:46.599Z", checked_at: "2026-09-07T13:16:00Z" },
    sources: { community_board: { status: "available", row_count: rows.length } },
    rows,
    hearings: rows,
  };
}

function publishedKv(sharedModel, extra = {}) {
  const built = buildMeetings(sharedModel, "test-published-slice-first");
  const values = new Map(built.entries.map((entry) => [entry.key, entry.value]));
  values.set(MEETING_MANIFEST_KEY, JSON.stringify(built.manifest));
  for (const [key, value] of Object.entries(extra)) values.set(key, value);
  return {
    ALERT_STATE: {
      get: async (key) => values.get(key) ?? null,
    },
  };
}

test("exact get_meeting reads the published per-id slice and skips the daily hearings blob", async () => {
  const built = publishedKv(model());
  const got = [];
  const env = {
    ALERT_STATE: {
      get: async (key) => {
        got.push(key);
        if (key === HEARINGS_KV_KEY) {
          throw new Error("daily hearings blob must not be read when the published slice answers");
        }
        return built.ALERT_STATE.get(key);
      },
    },
  };
  const started = performance.now();
  const result = await workerMeetingGet(env).execute({ meetingId: meeting.meeting_id });
  const elapsedMs = performance.now() - started;
  assert.equal(result.availability, "available");
  assert.equal(result.meeting.meeting_id, meeting.meeting_id);
  assert.equal(got.includes(HEARINGS_KV_KEY), false);
  assert.ok(got.includes(MEETING_MANIFEST_KEY), "published manifest must be consulted");
  assert.ok(
    got.some((key) => key.startsWith("meetings:v1:")),
    `published meeting slice must be consulted (got ${JSON.stringify(got)})`,
  );
  assert.ok(elapsedMs < 50, `published-slice get_meeting took ${elapsedMs.toFixed(1)}ms`);
});

test("get_meeting still falls back to the daily hearings view when no published slice exists", async () => {
  const dailyOnly = model([{
    ...meeting,
    meeting_id: "meeting:city_record:daily-only",
    source_system: "city_record",
    source_record_id: "daily-only",
    source_record: {
      source_system: "city_record",
      identifier: "daily-only",
      receipt: { status: "ok" },
    },
  }]);
  const got = [];
  const env = {
    ALERT_STATE: {
      get: async (key) => {
        got.push(key);
        if (key === HEARINGS_KV_KEY) return JSON.stringify(dailyOnly);
        if (key === MEETING_MANIFEST_KEY) {
          return JSON.stringify({
            schema_version: 1,
            kind: "meetings",
            version: "empty",
            slices: {},
            id_to_slice: {},
            read_model: {
              schema: dailyOnly.schema,
              generated_at: dailyOnly.generated_at,
              freshness: dailyOnly.freshness,
              sources: dailyOnly.sources,
            },
          });
        }
        return null;
      },
    },
  };
  const result = await workerMeetingGet(env).execute({ meetingId: "meeting:city_record:daily-only" });
  assert.equal(result.availability, "available");
  assert.equal(result.meeting.meeting_id, "meeting:city_record:daily-only");
  assert.equal(got.includes(HEARINGS_KV_KEY), true);
});
