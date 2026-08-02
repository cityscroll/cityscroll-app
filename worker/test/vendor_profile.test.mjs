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

const CAMBA_NOTICES = Array.from({ length: 18 }, (_, i) => ({
  request_id: `camba-${i + 1}`,
  start_date: `2026-07-${String(27 - i).padStart(2, "0")}`,
  agency_name: i % 2 ? "Human Resources Administration" : "Homeless Services",
  type_of_notice_description: "Award",
  short_title: `CAMBA notice ${i + 1}`,
  contract_amount: String((i + 1) * 1000),
  vendor_name: i % 2 ? "Camba Inc." : "CAMBA, Inc.",
}));

function kvStore(initial = {}) {
  const values = new Map(Object.entries(initial));
  const writes = [];
  return {
    values,
    writes,
    async get(key) { return values.get(key) ?? null; },
    async put(key, value) { values.set(key, value); writes.push(key); },
    async list({ prefix }) {
      return {
        keys: [...values.keys()]
          .filter((key) => key.startsWith(prefix))
          .map((name) => ({ name })),
        list_complete: true,
      };
    },
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
  profile.forecasts = [
    { source: "checkbook", contract_id: "keep", expiration_date: "2027-03-01" },
    { source: "mocs", description: "retired plan row", release_quarter: "Q1 FY2027" },
  ];
  const bucketKey = vendorProfileBucketKey(version, vendorProfileBucket("CAMBA"));
  const store = kvStore({
    "vp:manifest:v1": JSON.stringify({ generated, version }),
    [bucketKey]: JSON.stringify({ generated, profiles: { CAMBA: profile } }),
  });
  const req = new Request("https://api.cityscroll.org/vendor-profile?name=Camba%20Inc.");

  const fresh = await handleVendorProfile(req, { ALERT_STATE: store }, {
    nowMs: Date.parse(generated) + 23 * 60 * 60 * 1000,
  });
  assert.equal(fresh.status, 200);
  const freshBody = await fresh.json();
  assert.equal(freshBody.profile.awardCount, 271);
  assert.deepEqual(freshBody.profile.forecasts, [
    { source: "checkbook", contract_id: "keep", expiration_date: "2027-03-01" },
  ]);
  assert.equal(fresh.headers.get("cache-control"), "public, max-age=300");

  const stale = await handleVendorProfile(req, { ALERT_STATE: store }, {
    nowMs: Date.parse(generated) + 24 * 60 * 60 * 1000 + 1,
  });
  assert.equal(stale.status, 503);
  assert.equal((await stale.json()).reason, "stale-index");
});

const CAMBA_DOING_BUSINESS = [
  {
    organization_name: "CAMBA  INC",
    ownership_structure_code: "COR",
    organization_phone: "7182872600",
    doing_business_start_date: "0009-05-16T00:00:00.000",
  },
];

test("cron refresh writes versioned buckets before publishing the manifest", async () => {
  const forecast = [{
    source: "checkbook",
    vendor_name: "Camba Inc.",
    expiration_date: "2027-03-01",
  }];
  const store = kvStore({ "fc:CAMBA": JSON.stringify(forecast) });
  const fetchImpl = async (url) => {
    const href = String(url);
    let body;
    if (href.includes("72mk-a8z7")) body = CAMBA_DOING_BUSINESS;
    else if (new URL(href).searchParams.get("$group")) body = CAMBA_ROWS;
    else body = CAMBA_NOTICES;
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };
  const result = await refreshVendorProfiles(
    { ALERT_STATE: store },
    { fetchImpl, now: new Date("2026-07-27T13:00:00.000Z") },
  );

  assert.equal(result.profiles, 1);
  assert.equal(result.buckets, 1);
  assert.equal(result.cronCost.socrataRequestsBefore, 1);
  // WH-05: Doing Business comes from warehouse materialization (0 SODA catalog pages)
  // when the committed snapshot includes the vendor stem (CAMBA product seed).
  assert.equal(result.cronCost.doingBusinessRequests, 0);
  assert.equal(result.cronCost.socrataRequestsAfter, 2);
  assert.equal(result.included.recentNotices, 15);
  assert.equal(result.included.forecasts, 1);
  assert.equal(result.included.doingBusiness, 1);
  assert.equal(result.included.mentions, false);
  assert.ok(result.storage.averageBytesAfter > result.storage.averageBytesBefore);
  assert.equal(store.writes.at(-1), "vp:manifest:v1");
  assert.match(store.writes[0], /^vp:v1:20260727130000:/);

  const bucket = JSON.parse(store.values.get(store.writes[0]));
  assert.equal(bucket.profiles.CAMBA.recentNotices.length, 15);
  assert.equal(bucket.profiles.CAMBA.recentNotices[0].request_id, "camba-1");
  assert.equal(bucket.profiles.CAMBA.recentNotices[0].vendor_name, undefined);
  assert.deepEqual(bucket.profiles.CAMBA.forecasts, forecast);
  assert.equal(bucket.profiles.CAMBA.doingBusiness.organization_name, "CAMBA  INC");
  assert.equal(bucket.profiles.CAMBA.doingBusiness.organization_phone, "718-287-2600");
  assert.equal(bucket.profiles.CAMBA.doingBusiness.doing_business_start_date, "2009-05-16");
  const manifest = JSON.parse(store.values.get("vp:manifest:v1"));
  assert.equal(manifest.schema, 2);
});
