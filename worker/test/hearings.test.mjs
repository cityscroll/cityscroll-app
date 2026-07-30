import assert from "node:assert/strict";
import { test } from "node:test";

import {
  buildHearingView,
  handleHearings,
  HEARINGS_KV_KEY,
  refreshHearings,
} from "../src/hearings.mjs";

const TEST_NOW = new Date();

function fixtureDate(offsetDays) {
  const date = new Date(TEST_NOW.getTime() + (offsetDays * 24 * 60 * 60 * 1000));
  return date.toISOString().replace(".000Z", ".000");
}

function makeSourceRow() {
  return {
  request_id: "fixture-hearing-view",
  start_date: fixtureDate(-1),
  event_date: fixtureDate(6),
  agency_name: "City Planning Commission",
  type_of_notice_description: "Public Hearings",
  section_name: "Public Hearings and Meetings",
  short_title: "Queens zoning map amendment",
  street_address_1: "120 Broadway",
  city: "New York",
  state: "NY",
  zip_code: "10271",
  additional_description_1: "IN THE MATTER OF property located at 37-18 Queens Boulevard in the Sunnyside neighborhood, Community District 2, Queens.",
  };
}

const sourceRow = makeSourceRow();

function fetchFixture(calls) {
  return async (url) => {
    calls.push(url);
    if (url.startsWith("https://data.cityofnewyork.us/")) {
      return new Response(JSON.stringify([sourceRow]), { status: 200 });
    }
    const query = new URL(url).searchParams.get("text") || "";
    const queens = query.includes("Queens Boulevard");
    return new Response(JSON.stringify({
      features: [{
        properties: {
          borough: queens ? "Queens" : "Manhattan",
          neighbourhood: queens ? "Sunnyside" : "Financial District",
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

test("materialized view queries both hearing-bearing sections and geocodes venue and subject separately", async () => {
  const calls = [];
  const view = await buildHearingView(fetchFixture(calls), TEST_NOW);
  assert.equal(view.hearings.length, 1);
  const where = new URL(calls[0]).searchParams.get("$where");
  assert.match(where, /Public Hearings and Meetings/);
  assert.match(where, /Agency Rules/);
  assert.match(where, /type_of_notice_description='Public Hearings'/);
  assert.equal(view.hearings[0].venue.borough, "Manhattan");
  assert.deepEqual(view.hearings[0].affected_area.boroughs, ["Queens"]);
  assert.deepEqual(view.counts, { total: 1, local: 1, citywide: 0, unlocated: 0 });
});

test("refresh writes one materialized view and the read route serves it", async () => {
  const kv = memoryKV();
  const result = await refreshHearings({ ALERT_STATE: kv }, fetchFixture([]), TEST_NOW);
  assert.equal(result.status, "success");
  assert.ok(kv.values.has(HEARINGS_KV_KEY));

  const response = await handleHearings(new Request("https://api.cityscroll.org/hearings"), { ALERT_STATE: kv });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("access-control-allow-origin"), "*");
  const body = await response.json();
  assert.equal(body.hearings[0].request_id, "fixture-hearing-view");
});
