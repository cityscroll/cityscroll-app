import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { NEAR_YOU_FLOOR } from "../src/data/route_read_model_floor.mjs";
import { handleNearYou } from "../src/near_you.mjs";
import { buildNearYou } from "../../tools/build_worker_route_read_models.mjs";
import { geographyRecordProjection } from "../../site/geography_navigation_records.mjs";
import { landGeographyArtifactState } from "../../site/land_nta_watch_scope.mjs";
import {
  COVERAGE_CONFLICT_REASON,
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

// Coverage metadata merge (public alias c419deec4d475): slices built by the
// real builder from compact pinned rows, with conflicting metadata injected
// into one stored slice before the real loader merges them.
const pinnedRows = JSON.parse(readFileSync(new URL("../../test/fixtures/near_you_coverage_semantics.v1.json", import.meta.url), "utf8"));
const MN = pinnedRows.keys.positive_meetings;
const BX = pinnedRows.keys.explicit_zero_meetings;

function publishedLandPair(inject = null) {
  const built = buildNearYou(pinnedRows.activity, {}, "coverage-merge");
  const values = new Map(built.entries.map(({ key, value }) => [key, value]));
  values.set(NEAR_YOU_MANIFEST_KEY, JSON.stringify(built.manifest));
  if (inject) {
    const key = built.manifest.slices[`${BX}:land`];
    const slice = JSON.parse(values.get(key));
    inject(slice.activity.geography_items.coverage);
    values.set(key, JSON.stringify(slice));
  }
  return { built, values };
}

async function loadLand(values, geographies) {
  return loadNearYouActivity({ ALERT_STATE: kv(values) }, { place: { geographies }, facets: { domains: ["land"] } });
}

test("equal same-lens coverage is shared once, never added or dropped", async () => {
  const { built, values } = publishedLandPair();
  const stored = JSON.parse(values.get(built.manifest.slices[`${MN}:land`])).activity.geography_items.coverage;
  const loaded = await loadLand(values, [MN, BX]);
  assert.deepEqual(loaded.activity.geography_items.coverage, stored);
  assert.equal(loaded.activity.geography_items.coverage.by_lens.land.admitted, pinnedRows.activity.geography_items.coverage.by_lens.land.admitted);
  const projection = geographyRecordProjection(loaded.activity, { key: MN, lens: "land" });
  assert.equal(projection.state, "ready");
  assert.equal(projection.count, pinnedRows.activity.geography_items.by_key[MN].land.length);
});

for (const [name, inject] of [
  ["an incompatible generation identifier", (coverage) => {
    coverage.by_lens.land.generation_id = "other-generation";
    coverage.by_lens.land.types.nta2020.generation_id = "other-generation";
  }],
  ["a contradictory ready/error state", (coverage) => { coverage.by_lens.land.types.nta2020.status = "error"; }],
]) {
  test(`A3: ${name} in one same-lens slice is a typed unavailable result in either slice order`, async () => {
    const { values } = publishedLandPair(inject);
    const forward = await loadLand(values, [MN, BX]);
    const reverse = await loadLand(values, [BX, MN]);
    // The injected data really is order-sensitive: a first-wins merge would
    // publish different metadata for the two orders.
    const storedCoverage = (key) => JSON.parse(values.get(JSON.parse(values.get(NEAR_YOU_MANIFEST_KEY)).slices[`${key}:land`]))
      .activity.geography_items.coverage;
    assert.notDeepEqual(storedCoverage(MN), storedCoverage(BX));

    for (const loaded of [forward, reverse]) {
      const coverage = loaded.activity.geography_items.coverage;
      assert.equal(coverage.status, "unavailable");
      assert.equal(coverage.reason, COVERAGE_CONFLICT_REASON);
      assert.deepEqual(coverage.by_lens, { land: { status: "unavailable", reason: COVERAGE_CONFLICT_REASON } });
      for (const key of [MN, BX]) {
        const projection = geographyRecordProjection(loaded.activity, { key, lens: "land" });
        assert.equal(projection.state, "unavailable", key);
        assert.equal(projection.exact, false, key);
        assert.equal(projection.count, null, key);
        assert.ok(loaded.activity.geography_items.by_key[key].land.length > 0, "the IDs are present but not current");
      }
      assert.equal(landGeographyArtifactState(loaded).status, "unavailable");
    }
    assert.deepEqual(forward.activity.geography_items.coverage, reverse.activity.geography_items.coverage);
    assert.deepEqual(forward.activity.geography_items.by_key, reverse.activity.geography_items.by_key);
  });
}

test("A4: slices without coverage merge without inventing any", async () => {
  const built = buildNearYou({
    ...pinnedRows.activity,
    geography_items: { ...pinnedRows.activity.geography_items, coverage: undefined },
  }, {}, "legacy-merge");
  const values = new Map(built.entries.map(({ key, value }) => [key, value]));
  values.set(NEAR_YOU_MANIFEST_KEY, JSON.stringify(built.manifest));
  const loaded = await loadLand(values, [MN, BX]);
  assert.equal(Object.hasOwn(loaded.activity.geography_items, "coverage"), false);
  assert.equal(geographyRecordProjection(loaded.activity, { key: MN, lens: "land" }).state, "ready");
  const meetings = await loadNearYouActivity({ ALERT_STATE: kv(values) }, {
    place: { geographies: [pinnedRows.keys.unfilterable_meetings] }, facets: { domains: ["meetings"] },
  });
  assert.equal(geographyRecordProjection(meetings.activity, { key: pinnedRows.keys.unfilterable_meetings, lens: "meetings" }).state, "unfilterable");
});
