import assert from "node:assert/strict";
import test from "node:test";

import { NEAR_YOU_FLOOR } from "../src/data/route_read_model_floor.mjs";
import { handleNearYou } from "../src/near_you.mjs";
import {
  loadMeetingRecord,
  loadCommunityDistrictDigest,
  loadNearYouActivity,
  COMMUNITY_DISTRICT_DIGEST_MANIFEST_KEY,
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

function recoveryFixture() {
  return new Map([
    [NEAR_YOU_MANIFEST_KEY, JSON.stringify({ schema_version: 1, kind: "near-you", version: "recovery", slices: {
      "borough:Queens:meetings": "slice", "citywide:meetings": "slice",
      "virtual:meetings": "slice", "unlocated:meetings": "slice",
    } })],
    ["slice", JSON.stringify({ activity: NEAR_YOU_FLOOR })],
  ]);
}

const recoveryScope = { place: { boroughs: ["Queens"] }, facets: { domains: ["meetings"] } };

test("a failed manifest read does not poison the next resident request", async () => {
  const values = recoveryFixture();
  let fail = true;
  const store = { async get(key) {
    if (fail) { fail = false; throw new Error("temporary KV failure"); }
    return values.get(key);
  } };
  await assert.rejects(loadNearYouActivity({ ALERT_STATE: store }, recoveryScope));
  const recovered = await loadNearYouActivity({ ALERT_STATE: store }, recoveryScope);
  assert.ok(recovered.activity.records);
});

test("missing neighborhood coverage starts no orphaned shared slice reads", async () => {
  const store = kv(recoveryFixture());
  await assert.rejects(loadNearYouActivity({ ALERT_STATE: store }, {
    place: { geographies: ["geography:nta2020:missing"] }, facets: { domains: ["meetings"] },
  }), /missing near-you slice/);
  assert.equal(store.getCount(), 1, "validate all slice keys before beginning any slice I/O");
  assert.ok((await loadNearYouActivity({ ALERT_STATE: store }, recoveryScope)).activity.records);
});

test("a new request does not inherit another request's pending KV read", async () => {
  const values = recoveryFixture();
  let first = true;
  const store = { async get(key) {
    if (first) { first = false; return new Promise(() => {}); }
    return values.get(key);
  } };
  const abandoned = loadNearYouActivity({ ALERT_STATE: store, NEAR_YOU_READ_MODEL_TIMEOUT_MS: 100 }, recoveryScope)
    .catch((error) => error);
  await new Promise((resolve) => setImmediate(resolve));
  const recovered = await loadNearYouActivity({ ALERT_STATE: store, NEAR_YOU_READ_MODEL_TIMEOUT_MS: 20 }, recoveryScope);
  assert.ok(recovered.activity.records);
  assert.match((await abandoned).message, /exceeded/);
});

test("Near You caches completed data but keeps concurrent cold reads request-local", async () => {
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
  assert.equal(store.getCount(), 4, "each request owns its manifest and deduplicated slice I/O");
  await loadNearYouActivity(env, scope);
  assert.equal(store.getCount(), 4, "a warm isolate read performs no KV fetch");
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

test("community district digest request reads only the keyed slice, never the full corpus", async () => {
  const key = "community-district-digest:v1:test:K15";
  const values = new Map([
    [COMMUNITY_DISTRICT_DIGEST_MANIFEST_KEY, JSON.stringify({
      schema_version: 1,
      kind: "community-district-digest",
      version: "test",
      slices: { K15: key },
    })],
    [key, JSON.stringify({
      schema_version: 1,
      kind: "community-district-digest",
      version: "test",
      slice_id: "K15",
      digest: { by_community_district: { K15: { community_district: "K15", sections: {} } } },
    })],
  ]);
  const store = kv(values);
  const env = { ALERT_STATE: store };
  const first = await loadCommunityDistrictDigest(env, "K15");
  const second = await loadCommunityDistrictDigest(env, "K15");
  assert.equal(first.community_district, "K15");
  assert.equal(second.community_district, "K15");
  assert.equal(store.getCount(), 2, "a served request reads the manifest and K15 slice, not a full digest corpus");
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
