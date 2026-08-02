import assert from "node:assert/strict";
import { test } from "node:test";

import {
  buildPropertyView,
  handleProperties,
  PROPERTY_KV_KEY,
  refreshProperties,
} from "../src/property.mjs";

const sourceRows = [
  {
    request_id: "property-address",
    section_name: "Property Disposition",
    short_title: "Residential property sale",
    additional_description_1: "The City offers property located at 35 Beebe Street, Staten Island. Block 684; Lot 261.",
  },
  {
    request_id: "property-unlocated",
    section_name: "Property Disposition",
    short_title: "Online auto auction",
    additional_description_1: "Registration is free. Auctions are held online each week.",
  },
];

function fetchFixture(calls) {
  return async (url) => {
    calls.push(url);
    if (url.startsWith("https://data.cityofnewyork.us/")) {
      return new Response(JSON.stringify(sourceRows), { status: 200 });
    }
    return new Response(JSON.stringify({
      features: [{
        geometry: { coordinates: [-74.101, 40.601] },
        properties: {
          borough: "Staten Island",
          neighbourhood: "Todt Hill",
          addendum: { pad: { bbl: "5006840261" } },
        },
      }],
    }), { status: 200 });
  };
}

function memoryKV() {
  const values = new Map();
  return {
    values,
    async get(key) { return values.get(key) || null; },
    async put(key, value) { values.set(key, value); },
  };
}

test("Property view extracts sites, abstains honestly, and geocodes a representative address", async () => {
  const calls = [];
  const view = await buildPropertyView(fetchFixture(calls), new Date("2026-07-29T12:00:00Z"));
  assert.match(new URL(calls[0]).searchParams.get("$where"), /Property Disposition/);
  assert.equal(view.properties[0].property_location.geometry.label, "35 Beebe Street");
  assert.deepEqual(view.properties[0].property_location.boroughs, ["Staten Island"]);
  assert.ok(view.properties[0].property_location.bbls.includes("5006840261"));
  assert.equal(view.properties[1].property_location.scope, "unlocated");
  assert.deepEqual(view.counts, { total: 2, local: 1, unlocated: 1, geometry: 1 });
});

test("Property refresh writes the materialized view and its route serves it", async () => {
  const kv = memoryKV();
  // handleProperties live-refreshes when generated_at is older than MAX_AGE_MS (~36h).
  // Use wall-clock "now" so the route serves the fixture write, not a live SODA pull.
  const now = new Date();
  const result = await refreshProperties(
    { ALERT_STATE: kv },
    fetchFixture([]),
    now,
  );
  assert.equal(result.status, "success");
  assert.ok(kv.values.has(PROPERTY_KV_KEY));
  const response = await handleProperties(
    new Request("https://api.cityscroll.org/property-locations"),
    { ALERT_STATE: kv },
  );
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("access-control-allow-origin"), "*");
  const body = await response.json();
  assert.equal(body.properties[0].request_id, "property-address");
  // Default GET is the slim list projection (first-paint); full body dumps are omitted.
  assert.equal(body.view, "list");
  assert.equal(body.properties[0].additional_description_1.includes("35 Beebe"), true);
  assert.equal(body.properties[0].printout_1, undefined);
});

test("Property full view remains available via ?full=1", async () => {
  const kv = memoryKV();
  const now = new Date();
  await refreshProperties({ ALERT_STATE: kv }, fetchFixture([]), now);
  const fullRow = {
    ...sourceRows[0],
    printout_1: "FULL-PRINTOUT",
    additional_description_2: "extra body",
  };
  const stored = JSON.parse(kv.values.get(PROPERTY_KV_KEY));
  stored.properties[0] = { ...stored.properties[0], ...fullRow };
  kv.values.set(PROPERTY_KV_KEY, JSON.stringify(stored));

  const slim = await handleProperties(
    new Request("https://api.cityscroll.org/property-locations"),
    { ALERT_STATE: kv },
  ).then((r) => r.json());
  assert.equal(slim.view, "list");
  assert.equal(slim.properties[0].printout_1, undefined);

  const full = await handleProperties(
    new Request("https://api.cityscroll.org/property-locations?full=1"),
    { ALERT_STATE: kv },
  ).then((r) => r.json());
  assert.notEqual(full.view, "list");
  assert.equal(full.properties[0].printout_1, "FULL-PRINTOUT");
  assert.equal(full.properties[0].additional_description_2, "extra body");
});
