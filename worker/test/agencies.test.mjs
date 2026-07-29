import { readFileSync } from "node:fs";
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  buildAgencyCrosswalk,
  canonicalAgency,
  crosswalkCSV,
} from "../src/lib/agencies.mjs";
import { handleAgencies } from "../src/agencies.mjs";

const fixtures = JSON.parse(readFileSync(new URL("./fixtures/agencies.json", import.meta.url)));
const liveRows = fixtures.flatMap(({ variants }) => variants.map((agency_name, i) => ({
  agency_name,
  n: String(i + 1),
})));

test("field variants resolve to one canonical id and preferred name", () => {
  for (const fixture of fixtures) {
    const resolved = fixture.variants.map(canonicalAgency);
    assert.equal(new Set(resolved.map((row) => row.canonical_id)).size, 1, fixture.canonical_name);
    assert.deepEqual(new Set(resolved.map((row) => row.canonical_name)), new Set([fixture.canonical_name]));
  }
});

test("the ALL-CAPS and Title-Case field pair share a canonical id", () => {
  assert.equal(
    canonicalAgency("POLICE DEPARTMENT").canonical_id,
    canonicalAgency("Police Department").canonical_id,
  );
});

test("crosswalk keeps one published row for every live raw agency string", () => {
  const crosswalk = buildAgencyCrosswalk(liveRows);
  assert.equal(crosswalk.row_count, liveRows.length);
  assert.equal(crosswalk.rows.length, liveRows.length);
  assert.equal(new Set(crosswalk.rows.map((row) => row.raw_string)).size, liveRows.length);

  const police = crosswalk.rows.find((row) => row.raw_string === "POLICE DEPARTMENT");
  assert.deepEqual(police.variants, ["POLICE DEPARTMENT", "Police Department"]);
});

test("CSV has the same published row count and carries the variant list", () => {
  const crosswalk = buildAgencyCrosswalk(liveRows);
  const csv = crosswalkCSV(crosswalk.rows);
  assert.equal(csv.trimEnd().split("\n").length - 1, crosswalk.row_count);
  assert.match(csv, /^raw_string,canonical_id,canonical_name,variants\r?\n/);
  assert.match(csv, /POLICE DEPARTMENT/);
  assert.match(csv, /\[""POLICE DEPARTMENT"",""Police Department""\]/);
});

test("GET /agencies publishes JSON and CSV with open CORS and cache headers", async (t) => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => Response.json(liveRows);
  t.after(() => { globalThis.fetch = realFetch; });

  const jsonRes = await handleAgencies(
    new Request("https://api.cityscroll.org/agencies"),
    {},
    { waitUntil() {} },
  );
  assert.equal(jsonRes.status, 200);
  assert.equal(jsonRes.headers.get("Access-Control-Allow-Origin"), "*");
  assert.match(jsonRes.headers.get("Cache-Control"), /public/);
  const body = await jsonRes.json();
  assert.equal(body.row_count, liveRows.length);
  assert.equal(body.rows.length, liveRows.length);
  assert.equal(body.data_dictionary, "https://cityscroll.org/api.html#agency-crosswalk");

  const csvRes = await handleAgencies(
    new Request("https://api.cityscroll.org/agencies?format=csv"),
    {},
    { waitUntil() {} },
  );
  assert.match(csvRes.headers.get("Content-Type"), /^text\/csv/);
  assert.equal((await csvRes.text()).trimEnd().split("\n").length - 1, liveRows.length);
});

test("OPTIONS is keyless and CORS-open; unsupported methods and formats are bounded", async () => {
  const preflight = await handleAgencies(new Request("https://api.cityscroll.org/agencies", { method: "OPTIONS" }), {}, {});
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get("Access-Control-Allow-Origin"), "*");
  assert.equal((await handleAgencies(new Request("https://api.cityscroll.org/agencies", { method: "POST" }), {}, {})).status, 405);
  assert.equal((await handleAgencies(new Request("https://api.cityscroll.org/agencies?format=xml"), {}, {})).status, 400);
});
