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

function publishedStore(sharedModel, { includeDailyView = false, forceSliceMiss = false } = {}) {
  const built = buildMeetings(sharedModel, "test-published-slice-first");
  const values = new Map(built.entries.map((entry) => [entry.key, entry.value]));
  const manifest = forceSliceMiss
    ? { ...built.manifest, slices: {}, id_to_slice: {} }
    : built.manifest;
  values.set(MEETING_MANIFEST_KEY, JSON.stringify(manifest));
  if (includeDailyView) values.set(HEARINGS_KV_KEY, JSON.stringify(sharedModel));
  const expectedSliceKey = built.manifest.id_to_slice?.[meeting.meeting_id] || null;
  return { values, expectedSliceKey, manifest: built.manifest };
}

function instrumentedEnv(values, { forbidDailyView = false } = {}) {
  const got = [];
  return {
    got,
    env: {
      ALERT_STATE: {
        get: async (key) => {
          got.push(key);
          if (forbidDailyView && key === HEARINGS_KV_KEY) {
            throw new Error("daily hearings blob must not be read when the published slice answers");
          }
          return values.get(key) ?? null;
        },
      },
    },
  };
}

test("exact get_meeting reads the published per-id slice and skips the daily hearings blob", async () => {
  const shared = model();
  const { values, expectedSliceKey } = publishedStore(shared, { includeDailyView: true });
  assert.ok(expectedSliceKey, "fixture must publish a per-id slice key");
  const { got, env } = instrumentedEnv(values, { forbidDailyView: true });
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

test("happy-path get_meeting is bounded to the published manifest and one per-id slice", async () => {
  // Structural read bound: with the daily hearings blob present in KV, the
  // request may touch only the meetings manifest and the single slice that
  // owns the requested id. Reintroducing a full daily-view parse fails this.
  const shared = model();
  const { values, expectedSliceKey } = publishedStore(shared, { includeDailyView: true });
  assert.equal(typeof expectedSliceKey, "string");
  assert.match(expectedSliceKey, /^meetings:v1:/);
  assert.ok(values.has(HEARINGS_KV_KEY), "daily view must be present so a regression can touch it");

  const { got, env } = instrumentedEnv(values, { forbidDailyView: true });
  const result = await workerMeetingGet(env).execute({ meetingId: meeting.meeting_id });
  assert.equal(result.availability, "available");
  assert.equal(result.meeting.meeting_id, meeting.meeting_id);

  const uniqueKeys = [...new Set(got)];
  assert.deepEqual(
    uniqueKeys.sort(),
    [MEETING_MANIFEST_KEY, expectedSliceKey].sort(),
    `happy-path get_meeting must read only the meetings manifest and one per-id slice (got ${JSON.stringify(got)})`,
  );
  assert.equal(got.filter((key) => key === expectedSliceKey).length, 1);
  assert.equal(got.includes(HEARINGS_KV_KEY), false);
});

test("slice-path and fallback-path envelopes match for the same meeting", async () => {
  const shared = model();
  const sliceStore = publishedStore(shared, { includeDailyView: true, forceSliceMiss: false });
  const fallbackStore = publishedStore(shared, { includeDailyView: true, forceSliceMiss: true });

  const sliceProbe = instrumentedEnv(sliceStore.values, { forbidDailyView: true });
  const fallbackProbe = instrumentedEnv(fallbackStore.values);

  const fromSlice = await workerMeetingGet(sliceProbe.env).execute({ meetingId: meeting.meeting_id });
  const fromFallback = await workerMeetingGet(fallbackProbe.env).execute({ meetingId: meeting.meeting_id });

  assert.equal(fromSlice.availability, "available");
  assert.equal(fromFallback.availability, "available");
  assert.equal(sliceProbe.got.includes(HEARINGS_KV_KEY), false);
  assert.equal(fallbackProbe.got.includes(HEARINGS_KV_KEY), true);
  assert.ok(
    sliceProbe.got.some((key) => key.startsWith("meetings:v1:")),
    "slice path must read a published meetings slice",
  );
  assert.equal(
    fallbackProbe.got.some((key) => key.startsWith("meetings:v1:")),
    false,
    "forced slice miss must not invent a meetings slice read",
  );

  assert.deepEqual(
    fromSlice,
    fromFallback,
    "published-slice get_meeting must preserve the fallback envelope for the same meeting",
  );
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
