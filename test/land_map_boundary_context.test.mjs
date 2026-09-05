import assert from "node:assert/strict";
import { test } from "node:test";

import { buildLandMapModel } from "../site/land_map_model.mjs";
import {
  LAND_MAP_BOUNDARY_ARTIFACTS,
  LAND_MAP_BOUNDARY_LEVELS,
  LAND_MAP_BOUNDARY_CONTEXT_SCHEMA,
  landBoundaryScopeHref,
  landMapBoundarySvg,
  landMapBoundaryEvidenceHTML,
  loadLandMapBoundaryContext,
} from "../site/land_map_boundary_context.mjs";
import { landMapPanelHTML } from "../site/app/map_runtime.mjs";

const COPY = (key, values = {}) => Object.entries(values)
  .reduce((result, [name, value]) => result.replaceAll(`{${name}}`, String(value)), key);

const SOURCE = {
  contract_id: "test-boundaries",
  publisher: "NYC Department of City Planning",
  dataset_id: "test-dataset",
  dataset_name: "Test boundaries",
  url: "https://example.test/boundaries",
};

function payload(level, features, extra = {}) {
  return {
    schema: "cityscroll.geography_layer.v1",
    type: level,
    class: level === "council_district" ? "political" : level === "community_district" ? "community_administrative" : "administrative",
    geometry_fidelity: "simplified",
    source: SOURCE,
    vintage: { id: "2026-05-26", published_at: "2026-05-26T00:00:00.000Z" },
    crs: "EPSG:4326",
    features,
    ...extra,
  };
}

function feature(id, label, x = -74, y = 40.6) {
  return {
    id,
    label,
    geometry: {
      type: "Polygon",
      coordinates: [[[x, y], [x + 0.04, y], [x + 0.04, y + 0.04], [x, y + 0.04], [x, y]]],
    },
  };
}

function validFetch() {
  const docs = {
    borough: payload("borough", [feature("3", "Brooklyn")]),
    community_district: payload("community_district", [feature("K03", "Brooklyn Community District 3")]),
    council_district: payload("council_district", [feature("38", "City Council District 38")]),
  };
  return async (url) => ({ ok: true, json: async () => docs[LAND_MAP_BOUNDARY_LEVELS.find((level) => url.includes(`/${level}/`))] });
}

test("the committed boundary inventory names all supported levels and provenance-bearing artifacts", () => {
  assert.equal(LAND_MAP_BOUNDARY_CONTEXT_SCHEMA, "cityscroll.land_map_boundary_context.v1");
  assert.deepEqual(LAND_MAP_BOUNDARY_LEVELS, ["borough", "community_district", "council_district"]);
  assert.deepEqual(LAND_MAP_BOUNDARY_ARTIFACTS, [
    { level: "borough", artifact_url: "data/geography/layers/borough/2026-05-26.json" },
    { level: "community_district", artifact_url: "data/geography/layers/community_district/2026-05-26.json" },
    { level: "council_district", artifact_url: "data/geography/layers/council_district/2026-05-26.json" },
  ]);
});

test("valid context records are deterministic, labelled, sourced, versioned, and separate from projects", async () => {
  const context = await loadLandMapBoundaryContext(validFetch());
  assert.equal(context.state, "ready");
  assert.deepEqual(context.records.map((record) => [record.level, record.boundary_id, record.label]), [
    ["borough", "3", "Brooklyn"],
    ["community_district", "K03", "Brooklyn Community District 3"],
    ["council_district", "38", "City Council District 38"],
  ]);
  for (const record of context.records) {
    assert.equal(record.disclosure_state, "disclosed");
    assert.equal(record.geometry_artifact.format, "GeoJSON");
    assert.equal(record.geometry_artifact.coordinate_system, "EPSG:4326");
    assert.equal(record.vintage.id, "2026-05-26");
    assert.equal(record.source.publisher, SOURCE.publisher);
    assert.equal("project_id" in record, false);
    assert.equal("count" in record, false);
    assert.equal("watch_scope" in record, false);
  }
});

test("missing and malformed artifacts disclose missingness without erasing healthy layers", async () => {
  const context = await loadLandMapBoundaryContext(async (url) => {
    if (url.includes("council_district")) return { ok: false, status: 404 };
    if (url.includes("community_district")) return { ok: true, json: async () => ({ schema: "wrong" }) };
    return { ok: true, json: async () => payload("borough", [feature("3", "Brooklyn")]) };
  });
  assert.equal(context.state, "partial");
  assert.equal(context.records.length, 1);
  assert.deepEqual(context.missing, ["community_district", "council_district"]);
  const evidence = landMapBoundaryEvidenceHTML(context, { t: COPY });
  assert.match(evidence, /community_district/);
  assert.match(evidence, /council_district/);
  assert.match(evidence, /data-land-boundary-evidence-source="test-boundaries"/);
});

test("LM-12: a layer request that never settles degrades to 'unavailable' within its budget instead of hanging the whole context", async () => {
  const now = Date.now();
  const context = await loadLandMapBoundaryContext(async (url) => {
    if (url.includes("council_district")) return new Promise(() => {}); // never resolves or rejects
    if (url.includes("community_district")) return { ok: true, json: async () => payload("community_district", [feature("K03", "Brooklyn Community District 3")]) };
    return { ok: true, json: async () => payload("borough", [feature("3", "Brooklyn")]) };
  }, { timeoutMs: 30 });
  const nowMs = Date.now();
  assert.ok(nowMs - now < 500, "a hung layer must not hold the whole context open anywhere near a real request budget");
  assert.equal(context.state, "partial");
  assert.deepEqual(context.missing, ["council_district"]);
  assert.equal(context.records.length, 2, "the two healthy layers still resolved");
});

test("boundary labels are explicit canonical links and geometry is non-interactive context", async () => {
  const context = await loadLandMapBoundaryContext(validFetch());
  const hash = "#land?status=all&stage=any&family=rezoning&view=map&facet=%7B%22regulatoryEffect%22%3A%22upzone%22%7D";
  const html = landMapBoundarySvg(context, { currentHash: hash });
  assert.equal((html.match(/<path[^>]+land-map-boundary-outline/g) || []).length, 3);
  assert.equal((html.match(/<a class="land-map-boundary-label/g) || []).length, 3);
  assert.match(html, /data-land-boundary-level="community_district"/);
  assert.match(html, /data-land-boundary-source="test-boundaries"/);
  assert.match(html, /data-land-boundary-vintage="2026-05-26"/);
  assert.match(html, /data-land-boundary-disclosure="disclosed"/);
  assert.match(html, /pointer-events="none"/);
  assert.doesNotMatch(html, /data-land-map-project|data-land-map-value|choropleth|fill-density/);
  assert.match(html, /href="#land\?status=all&amp;stage=any&amp;family=rezoning&amp;view=map&amp;facet=/);
  assert.match(html, /aria-label="Brooklyn Community District 3; community_district;/);
});

test("scope links change only geographic keys and preserve the canonical Land filter state", () => {
  const base = "#land?status=all&stage=any&future=hearing&procedure=ulurp&family=rezoning&q=school&attendance=hybrid&view=map";
  const borough = landBoundaryScopeHref({ level: "borough", boundary_id: "3", label: "Brooklyn" }, base);
  const community = landBoundaryScopeHref({ level: "community_district", boundary_id: "K03", label: "Brooklyn Community District 3" }, base);
  const council = landBoundaryScopeHref({ level: "council_district", boundary_id: "38", label: "City Council District 38" }, base);
  for (const [href, expected] of [[borough, { boro: "Brooklyn" }], [community, { boro: "Brooklyn", cd: "K03" }], [council, { council: "38" }]]) {
    const params = new URLSearchParams(href.split("?", 2)[1]);
    assert.equal(params.get("status"), "all");
    assert.equal(params.get("family"), "rezoning");
    assert.equal(params.get("q"), "school");
    assert.equal(params.get("view"), "map");
    assert.equal(params.get("boro"), expected.boro || null);
    assert.equal(params.get("cd"), expected.cd || null);
    assert.equal(params.get("council"), expected.council || null);
  }
});

test("adding boundary context does not change the project model or create a choropleth", async () => {
  const context = await loadLandMapBoundaryContext(validFetch());
  const rows = [{ project_id: "2025K0305", project_name: "Brooklyn specimen" }];
  const pointLookup = { points: { "2025K0305": { lat: 40.62, lon: -73.98, method: "publisher_point", precision: "exact" } } };
  const without = buildLandMapModel({ rows, pointLookup });
  const withContext = landMapPanelHTML(without, { boundaryContext: context, t: COPY });
  assert.deepEqual(without.counts, { total: 1, mapped: 1, unmapped: 0 });
  assert.match(withContext, /Brooklyn/);
  assert.match(withContext, /land-map-boundary-evidence/);
  assert.equal((withContext.match(/class="land-map-marker"/g) || []).length, 1);
  assert.doesNotMatch(withContext, /land-map-choropleth|fill-density|data-land-map-value/);
});
