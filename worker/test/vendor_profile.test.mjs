import { test } from "node:test";
import assert from "node:assert/strict";

import {
  buildVendorProfiles,
  handleVendorProfile,
  refreshVendorProfiles,
  vendorProfileBucket,
  vendorProfileBucketKey,
} from "../src/vendor_profile.mjs";

const CAMBA_ROWS = [
  ["CAMBA", 3, 11800080, "2008-03-10", "2011-05-02"],
  ["Camba Inc.", 135, 1106326956.53, "2010-10-05", "2025-07-31"],
  ["Camba, Inc", 7, 85947407.33, "2016-01-28", "2020-11-04"],
  ["CAMBA Inc", 9, 147676229, "2026-05-13", "2026-07-27"],
  ["CAMBA  Inc", 17, 141415368.94, "2019-07-12", "2022-12-07"],
  ["CAMBA, Inc.", 92, 352563435.1, "2007-09-14", "2026-03-18"],
  ["CAMBA, Inc.,", 4, 9496422, "2012-06-13", "2022-06-06"],
  ["CAMBA. Inc.", 2, 61057155, "2015-09-03", "2021-07-21"],
  ["CAMBA., Inc.", 2, 30033469, "2010-05-12", "2022-07-08"],
].map(([vendor_name, n, t, first, last], i) => ({
  vendor_name, agency_name: i % 2 ? "Human Resources Administration" : "Homeless Services",
  n: String(n), t: String(t), first, last,
}));

function kvStore(initial = {}) {
  const values = new Map(Object.entries(initial));
  const writes = [];
  return {
    values,
    writes,
    async get(key) { return values.get(key) ?? null; },
    async put(key, value) { values.set(key, value); writes.push(key); },
  };
}

test("CAMBA fixture folds nine variants into the pinned identity totals", () => {
  const profile = buildVendorProfiles(CAMBA_ROWS).CAMBA;
  assert.equal(profile.display, "Camba Inc.");
  assert.equal(profile.variants.length, 9);
  assert.equal(profile.awardCount, 271);
  assert.equal(profile.total, 1946316522.9);
  assert.equal(profile.first, "2007-09-14");
  assert.equal(profile.last, "2026-07-27");
  assert.equal(profile.topAgencies.length, 2);
});

test("GET /vendor-profile serves a fresh record and rejects it after 24 hours", async () => {
  const generated = "2026-07-27T13:00:00.000Z";
  const version = "20260727130000";
  const profile = buildVendorProfiles(CAMBA_ROWS).CAMBA;
  const bucketKey = vendorProfileBucketKey(version, vendorProfileBucket("CAMBA"));
  const store = kvStore({
    "vp:manifest:v1": JSON.stringify({ generated, version }),
    [bucketKey]: JSON.stringify({ generated, profiles: { CAMBA: profile } }),
  });
  const req = new Request("https://api.crol-list.org/vendor-profile?name=Camba%20Inc.");

  const fresh = await handleVendorProfile(req, { ALERT_STATE: store }, {
    nowMs: Date.parse(generated) + 23 * 60 * 60 * 1000,
  });
  assert.equal(fresh.status, 200);
  assert.equal((await fresh.json()).profile.awardCount, 271);
  assert.equal(fresh.headers.get("cache-control"), "public, max-age=300");

  const stale = await handleVendorProfile(req, { ALERT_STATE: store }, {
    nowMs: Date.parse(generated) + 24 * 60 * 60 * 1000 + 1,
  });
  assert.equal(stale.status, 503);
  assert.equal((await stale.json()).reason, "stale-index");
});

test("cron refresh writes versioned buckets before publishing the manifest", async () => {
  const store = kvStore();
  const fetchImpl = async () => new Response(JSON.stringify(CAMBA_ROWS), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
  const result = await refreshVendorProfiles(
    { ALERT_STATE: store },
    { fetchImpl, now: new Date("2026-07-27T13:00:00.000Z") },
  );

  assert.equal(result.profiles, 1);
  assert.equal(result.buckets, 1);
  assert.equal(store.writes.at(-1), "vp:manifest:v1");
  assert.match(store.writes[0], /^vp:v1:20260727130000:/);
});
