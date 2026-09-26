import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import {
  hydrateLandRecordDetailPlaces,
  landRecordApplicantHTML,
  landRecordPlaceHTML,
} from "../site/land_record_links.mjs";

const ROOT = process.cwd();

function readJson(relative) {
  return JSON.parse(readFileSync(join(ROOT, relative), "utf8"));
}

test("land record links resolve the published DOT applicant spelling", () => {
  const html = landRecordApplicantHTML("NYC DOT Department of Transportation");
  assert.match(html, /href="\/agencies\/transportation\/"/);
  assert.match(html, /NYC DOT Department of Transportation/);
  assert.match(html, /data-link-confidence="strong"/);
});

test("unresolved land applicants remain honest plain text", () => {
  const html = landRecordApplicantHTML("An Organization Without A Profile");
  assert.equal(html, "An Organization Without A Profile");
  assert.doesNotMatch(html, /href=/);
});

test("exact NYCEDC ZAP applicant spelling links the retained source value", () => {
  const html = landRecordApplicantHTML("EDC - Economic Development Corporation for NYC");
  assert.match(html, /href="\/agencies\/economic-development-corporation\//);
  assert.match(html, /EDC - Economic Development Corporation for NYC/);
  assert.match(html, /data-role-relation="has_applicant"/);
});

test("land record place identifiers use existing near-you scope routes", () => {
  const options = { knownCommunityDistricts: new Set(["Q05"]), knownCouncilDistricts: new Set(["30"]) };
  assert.match(landRecordPlaceHTML("borough", "Queens"), /href="\/near-you\/\?v=0&amp;lens=land&amp;boro=Queens"/);
  assert.match(landRecordPlaceHTML("community", "Q05", options), /href="\/near-you\/\?v=0&amp;lens=land&amp;cd=Q05"/);
  assert.match(landRecordPlaceHTML("council", "30", options), /href="\/near-you\/\?v=0&amp;lens=land&amp;council=30"/);
});

test("unresolved land place identifiers remain plain text", () => {
  const options = { knownCommunityDistricts: new Set(["Q05"]), knownCouncilDistricts: new Set(["30"]) };
  assert.equal(landRecordPlaceHTML("borough", "Atlantis"), "Atlantis");
  assert.equal(landRecordPlaceHTML("community", "Q99", options), "CD Q99");
  assert.equal(landRecordPlaceHTML("council", "99", options), "Council District 99");
});

test("publisher place pivots schedule lot-derived place links from the selected Land row", async () => {
  const catalog = readJson("site/data/land_project_catalog.json");
  const record = (catalog.projects || []).find((row) => row.project_id === "2025K0305");
  assert.ok(record);

  const files = new Map([
    ["land_place_membership.json", readJson("site/data/land_place_membership.json")],
    ["26B.json", readJson("site/data/geography/layers/nta2020/26B.json")],
    ["community_board_geography_lookup.json", readJson("site/data/community_board_geography_lookup.json")],
  ]);
  const fetchImpl = async (url) => {
    const href = String(url);
    for (const [name, body] of files.entries()) {
      if (href.endsWith(name) || href.includes(`/${name}`)) {
        return { ok: true, async json() { return body; } };
      }
    }
    return { ok: false, async json() { return null; } };
  };
  const previousFetch = globalThis.fetch;
  globalThis.fetch = fetchImpl;

  const host = { innerHTML: "" };
  const agencybar = {
    insertAdjacentHTML(_position, html) {
      assert.match(html, /id="land-place-links-host"/);
      detail.nodes.hostMounted = true;
    },
  };
  const detail = {
    nodes: { hostMounted: false },
    querySelector(selector) {
      if (selector === "#land-place-links-host") return detail.nodes.hostMounted ? host : null;
      if (selector === "#land-same-applicant-host") return null;
      if (selector === "[data-land-record-place-group]") return null;
      if (selector === ".agencybar") return agencybar;
      return null;
    },
    insertAdjacentHTML() {},
  };
  const previousDocument = globalThis.document;
  const previousRows = globalThis.lRows;
  const previousSelection = globalThis.landSelectionSeq;
  globalThis.document = {
    querySelector(selector) {
      if (selector === "#ldetail") return detail;
      if (selector === "#llist .row.sel") return { dataset: { i: "0" } };
      return null;
    },
  };
  globalThis.lRows = [record];
  globalThis.landSelectionSeq = 42;

  try {
    landRecordPlaceHTML("borough", record.borough, { escape: (value) => String(value ?? "") });
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(detail.nodes.hostMounted, true);
    assert.match(host.innerHTML, /Calvert Vaux Park/);
    assert.match(host.innerHTML, /14 of 25 lot points placed/);
  } finally {
    globalThis.fetch = previousFetch;
    globalThis.document = previousDocument;
    globalThis.lRows = previousRows;
    globalThis.landSelectionSeq = previousSelection;
  }
});

test("hydrate paints lot-derived place links beside publisher Where pivots", async () => {
  const catalog = readJson("site/data/land_project_catalog.json");
  const record = (catalog.projects || []).find((row) => row.project_id === "2026R0127");
  assert.ok(record);

  const files = new Map([
    ["land_place_membership.json", readJson("site/data/land_place_membership.json")],
    ["26B.json", readJson("site/data/geography/layers/nta2020/26B.json")],
    ["community_board_geography_lookup.json", readJson("site/data/community_board_geography_lookup.json")],
    ["district_boundaries.json", readJson("site/data/district_boundaries.json")],
  ]);

  const fetchImpl = async (url) => {
    const href = String(url);
    for (const [name, body] of files.entries()) {
      if (href.endsWith(name) || href.includes(`/${name}`)) {
        return {
          ok: true,
          async json() { return body; },
        };
      }
    }
    return { ok: false, async json() { return null; } };
  };

  const detail = {
    nodes: {
      borough: { innerHTML: "" },
      community: { innerHTML: "" },
      council: { innerHTML: "" },
      host: { innerHTML: "" },
    },
    querySelector(selector) {
      if (selector === "[data-land-record-place='borough']") return this.nodes.borough;
      if (selector === "[data-land-record-place='community']") return this.nodes.community;
      if (selector === "[data-land-record-place='council']") return this.nodes.council;
      if (selector === "#land-place-links-host") return this.nodes.host;
      if (selector === "#land-same-applicant-host") return null;
      if (selector === "[data-land-record-place-group]") return null;
      if (selector === ".agencybar") return null;
      return null;
    },
  };

  const view = await hydrateLandRecordDetailPlaces(detail, record, {
    fetchImpl,
    labelForCouncilDistrict: (value) => `Council District ${value}`,
  });
  assert.ok(view);
  assert.match(detail.nodes.host.innerHTML, /Westerleigh-Castleton Corners/);
  assert.match(detail.nodes.host.innerHTML, /Staten Island Community Board 1/);
  assert.match(detail.nodes.community.innerHTML, /href=/);
});
