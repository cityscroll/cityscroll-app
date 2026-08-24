import assert from "node:assert/strict";
import test from "node:test";

import { NEAR_YOU_FLOOR } from "../src/data/route_read_model_floor.mjs";
import { handleNearYou } from "../src/near_you.mjs";
import {
  loadMeetingRecord,
  loadNearYouActivity,
  MEETING_MANIFEST_KEY,
  NEAR_YOU_MANIFEST_KEY,
} from "../src/lib/route_read_model_kv.mjs";

function kv(values) {
  let reads = 0;
  return {
    getCount: () => reads,
    async get(key) { reads += 1; return values.get(key) || null; },
  };
}

test("Near You isolate cache performs one manifest read and one cold-key read", async () => {
  const key = "near-you:v1:test:queens";
  const values = new Map([
    [NEAR_YOU_MANIFEST_KEY, JSON.stringify({ schema_version: 1, kind: "near-you", version: "test", slices: {
      "borough:Queens:meetings": key,
      "citywide:meetings": key,
      "virtual:meetings": key,
      "unlocated:meetings": key,
    } })],
    [key, JSON.stringify({ activity: NEAR_YOU_FLOOR, community_geography: {} })],
  ]);
  const store = kv(values);
  const env = { ALERT_STATE: store };
  const scope = { place: { boroughs: ["Queens"] }, facets: { domains: ["meetings"] } };
  await Promise.all([loadNearYouActivity(env, scope), loadNearYouActivity(env, scope)]);
  assert.equal(store.getCount(), 2, "manifest and slice are each fetched once for concurrent cold reads");
  await loadNearYouActivity(env, scope);
  assert.equal(store.getCount(), 2, "a warm isolate read performs no KV fetch");
});

test("meeting record reads are keyed and cache the versioned slice", async () => {
  const id = "meeting:test:one";
  const key = "meetings:v1:test:2026-08";
  const values = new Map([
    [MEETING_MANIFEST_KEY, JSON.stringify({ schema_version: 1, kind: "meetings", version: "test", slices: { "2026-08": key }, id_to_slice: { [id]: key } })],
    [key, JSON.stringify({ rows: [{ meeting_id: id, title: "Canary meeting", event_date: "2026-08-23T19:00:00Z" }] })],
  ]);
  const store = kv(values);
  const env = { ALERT_STATE: store };
  assert.equal((await loadMeetingRecord(env, id)).title, "Canary meeting");
  assert.equal((await loadMeetingRecord(env, id)).title, "Canary meeting");
  assert.equal(store.getCount(), 2, "manifest and keyed meeting slice are each fetched once");
});

test("Near You edge-cache miss fetches the route slice once, then serves the cached document", async () => {
  const key = "near-you:v1:test:queens";
  const values = new Map([
    [NEAR_YOU_MANIFEST_KEY, JSON.stringify({ schema_version: 1, kind: "near-you", version: "test", slices: {
      "borough:Queens:meetings": key, "citywide:meetings": key, "virtual:meetings": key, "unlocated:meetings": key,
    } })],
    [key, JSON.stringify({ activity: NEAR_YOU_FLOOR, community_geography: {} })],
  ]);
  const store = kv(values);
  const cached = new Map();
  globalThis.caches = { default: {
    async match(request) { return cached.get(request.url)?.clone() || null; },
    async put(request, response) { cached.set(request.url, response); },
  } };
  try {
    const request = new Request("https://cityscroll.org/near-you?v=0&lens=meetings&boro=Queens");
    const first = await handleNearYou(request, { ALERT_STATE: store });
    const second = await handleNearYou(request, { ALERT_STATE: store });
    assert.equal(first.status, 200);
    assert.equal(second.status, 200);
    assert.equal(store.getCount(), 2, "edge hit avoids another manifest or slice read");
  } finally {
    delete globalThis.caches;
  }
});
