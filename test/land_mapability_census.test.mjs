import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";

import {
  BBL_MAPPLUTO_CENTROID_CANARIES,
  normalizeBbl,
} from "../site/bbl_mappluto_centroids.mjs";
import { LAND_PROJECT_MAP_POINT_SPECIMENS } from "../site/land_project_map_points.mjs";
import {
  LAND_MAPABILITY_CENSUS_SCHEMA,
  LAND_MAPABILITY_DENOMINATOR,
  LAND_MAPABILITY_JOIN_VERSION,
  LAND_MAPABILITY_METHODS,
  REJECTED_PLACEMENT_METHODS,
  assertLandMapabilityContract,
  censusLandMapability,
  landMapabilityContractFindings,
} from "../tools/lib/land_mapability_census.mjs";
import {
  CENSUS_JSON,
  CENSUS_MD,
  buildLandMapabilityCensusFromRepo,
} from "../tools/build_land_mapability_census.mjs";

const requireJson = createRequire(import.meta.url);
const landDefault = requireJson("../site/data/land_default_ulurp.json");
const zapBbl = requireJson("../site/data/zap_bbl_warehouse_lookup.json");
const mapplutoCentroids = requireJson("../site/data/bbl_mappluto_centroids_lookup.json");
const committed = requireJson("../docs/evidence/land-map-view-census.json");

const censusSrc = readFileSync(new URL("../tools/lib/land_mapability_census.mjs", import.meta.url), "utf8");

function census(overrides = {}) {
  return censusLandMapability({
    landDefault,
    zapBbl,
    mapplutoCentroids,
    listBytes: committed.aggregations.list_baseline.bytes,
    artifactHashes: committed.artifacts
      ? {
          land_default: committed.artifacts.land_default.sha256,
          zap_bbl: committed.artifacts.zap_bbl.sha256,
          mappluto_centroids: committed.artifacts.mappluto_centroids.sha256,
        }
      : {},
    geocode: async () => ({ status: "matched", lat: 40.7, lon: -74.0, method: "address_geocode" }),
    districtCentroids: { Brooklyn: { lat: 40.65, lon: -73.95 }, K01: { lat: 40.72, lon: -73.96 } },
    neighborParcels: true,
    ...overrides,
  });
}

test("committed census matches a fresh join of the pinned artifacts", () => {
  const rebuilt = buildLandMapabilityCensusFromRepo();
  assert.deepEqual(rebuilt, committed);
  assertLandMapabilityContract(rebuilt);
});

test("aggregations preserve the 40-row denominator and named counts", () => {
  const agg = committed.aggregations;
  assert.equal(committed.schema, LAND_MAPABILITY_CENSUS_SCHEMA);
  assert.equal(committed.join_version, LAND_MAPABILITY_JOIN_VERSION);
  assert.equal(agg.denominator, 40);
  assert.equal(agg.mapped, 26);
  assert.equal(agg.unmapped, 14);
  assert.equal(agg.coverage_percent, 65);
  assert.equal(agg.exact_bbl_projects, 32);
  assert.equal(agg.bbl_occurrences, 220);
  assert.equal(agg.unique_bbl_keys, 220);
  assert.equal(agg.matched_centroid_occurrences, 170);
  assert.equal(agg.unique_centroid_keys, 170);
  assert.equal(agg.methods.single_bbl_centroid, 3);
  assert.equal(agg.methods.multi_bbl_anchor, 23);
  assert.equal(agg.list_baseline.bytes, committed.artifacts.land_default.bytes);
  assert.equal(committed.projects.length, LAND_MAPABILITY_DENOMINATOR);
  assert.equal(committed.new_publisher_work, false);
  assert.equal(committed.runtime_network, false);
  assert.equal(committed.geocoder_input, false);
});

test("all 14 unmapped projects stay named and without markers", () => {
  assert.deepEqual(committed.unmapped_project_ids, [
    "2023M0452",
    "2020Q0317",
    "P2009K0185",
    "2020K0444",
    "P2012X0048",
    "2024Q0135",
    "2026X0180",
    "2025M0399",
    "2024X0217",
    "2024M0148",
    "2026X0270",
    "2026Q0371",
    "2026K0322",
    "2025Q0494",
  ]);
  for (const id of committed.unmapped_project_ids) {
    const row = committed.projects.find((item) => item.project_id === id);
    assert.equal(row.mapped, false);
    assert.equal(row.point, null);
    assert.equal(row.method, LAND_MAPABILITY_METHODS.UNMAPPED);
    assert.ok(row.unmapped_reason);
  }
});

test(`${LAND_PROJECT_MAP_POINT_SPECIMENS.multi_bbl} is a 24-centroid multi-BBL specimen`, () => {
  // This exact centroid count is a measured fact about the committed,
  // builder-rebuilt artifact above (verified reproducible by the
  // "committed census matches a fresh join" test); it needs re-pinning
  // whenever that artifact's multi-BBL specimen changes shape, same as the
  // reproducibility check it travels with. The specimen id itself is shared
  // with LAND_PROJECT_MAP_POINT_SPECIMENS so it only needs updating in one
  // place when a refresh rotates it out.
  const row = committed.projects.find(
    (item) => item.project_id === LAND_PROJECT_MAP_POINT_SPECIMENS.multi_bbl,
  );
  assert.equal(row.mapped, true);
  assert.equal(row.method, LAND_MAPABILITY_METHODS.MULTI_BBL_ANCHOR);
  assert.equal(row.exact_bbl_count, 24);
  assert.equal(row.unique_matched_centroid_count, 24);
  assert.equal(row.point_role, "existence_proof");
  assert.equal(Number.isFinite(row.point.lat), true);
  assert.equal(Number.isFinite(row.point.lon), true);
  assert.equal(row.join_version, LAND_MAPABILITY_JOIN_VERSION);
});

test(`negative specimen ${LAND_PROJECT_MAP_POINT_SPECIMENS.no_retained_bbl} stays unmapped`, () => {
  const row = committed.projects.find(
    (item) => item.project_id === LAND_PROJECT_MAP_POINT_SPECIMENS.no_retained_bbl,
  );
  assert.equal(row.mapped, false);
  assert.equal(row.exact_bbl_count, 0);
  assert.equal(row.unmapped_reason, "no_retained_bbl");
  assert.equal(row.point, null);
});

test("the 2026K0123 MapPLUTO centroid canary keeps its pinned BBL's centroid retained", () => {
  // The canary's job is permalink continuity if /zap-outcomes KV ever drops
  // 2026K0123: its BBL must always resolve to a centroid regardless of
  // whether the project is currently in the 40-row Default Land snapshot.
  // 2026K0123 has rotated out of the current snapshot, so the coincidence
  // this test once demonstrated (the canary and the project's own exact-BBL
  // match agreeing) is not observable this refresh; the canary's standing
  // guarantee is checked directly against the committed centroid lookup
  // instead of against this census.
  const canaryBbl = Object.keys(BBL_MAPPLUTO_CENTROID_CANARIES).find(
    (bbl) => BBL_MAPPLUTO_CENTROID_CANARIES[bbl] === "2026K0123",
  );
  assert.ok(canaryBbl);
  assert.ok(mapplutoCentroids.by_bbl[normalizeBbl(canaryBbl)]);
});

test("geocoded points, district guesses, neighboring parcels, and outcome points do not map", () => {
  const unmappedSpecimen = LAND_PROJECT_MAP_POINT_SPECIMENS.no_retained_bbl;
  const baseline = census();
  const mutatedProjects = landDefault.projects.map((project) => {
    if (project.project_id !== unmappedSpecimen) return project;
    return { ...project, latitude: 40.694, longitude: -73.986, lat: 40.694, lon: -73.986 };
  });
  const neighborBbl = Object.keys(mapplutoCentroids.by_bbl)[0];
  const mutatedBbl = {
    ...zapBbl,
    rows: [
      ...zapBbl.rows,
      { project_id: `${unmappedSpecimen}-neighbor-ignored`, bbls: [neighborBbl] },
    ],
  };
  const polluted = census({
    landDefault: { ...landDefault, projects: mutatedProjects, outcomes: { [unmappedSpecimen]: { lat: 40.69, lon: -73.98 } } },
    zapBbl: mutatedBbl,
    geocode: () => ({ status: "matched", lat: 40.71, lon: -74.01, method: "address_geocode" }),
    districtCentroids: { Brooklyn: { lat: 40.65, lon: -73.95 } },
    neighborParcels: { "2023M0452": [neighborBbl] },
  });
  assert.deepEqual(polluted.unmapped_project_ids, baseline.unmapped_project_ids);
  assert.equal(polluted.aggregations.mapped, 26);
  assert.equal(polluted.aggregations.unmapped, 14);
  const k0123 = polluted.projects.find((row) => row.project_id === unmappedSpecimen);
  assert.equal(k0123.mapped, false);
  assert.equal(k0123.point, null);
  const m0452 = polluted.projects.find((row) => row.project_id === "2023M0452");
  assert.equal(m0452.mapped, false);
  assert.equal(m0452.exact_bbl_keys.includes(neighborBbl), false);
  for (const method of REJECTED_PLACEMENT_METHODS) {
    assert.equal(polluted.projects.some((row) => row.method === method), false);
  }
});

test("dropping unmapped rows is a denominator change and fails the contract", () => {
  const mappedOnly = {
    ...committed,
    aggregations: {
      ...committed.aggregations,
      denominator: 33,
      unmapped: 0,
      coverage_percent: 100,
      list_baseline: { rows: 33, bytes: committed.aggregations.list_baseline.bytes },
    },
    unmapped_project_ids: [],
    projects: committed.projects.filter((row) => row.mapped),
  };
  const findings = landMapabilityContractFindings(mappedOnly);
  assert.equal(findings.some((line) => /denominator/.test(line)), true);
  assert.throws(() => assertLandMapabilityContract(mappedOnly), /denominator/);
});

test("serialized list byte growth is recorded evidence, not a semantic failure", () => {
  const changedBytes = structuredClone(committed);
  changedBytes.aggregations.list_baseline.bytes += 1;
  changedBytes.artifacts.land_default.bytes += 1;
  assert.deepEqual(landMapabilityContractFindings(changedBytes), []);
});

test("census module does not fetch, geocode, or call a live GIS service", () => {
  assert.equal(/\bfetch\s*\(/.test(censusSrc), false);
  assert.equal(/\bgeocode\s*\(/.test(censusSrc), false);
  assert.equal(/arcgis|unpkg|nominatim|mapbox/i.test(censusSrc), false);
  assert.equal(/https?:\/\//.test(censusSrc), false);
  assert.equal(/from ["'].*app\/land\.mjs["']/.test(censusSrc), false);
});

test("markdown receipt names coverage and the unmapped set", () => {
  const markdown = readFileSync(new URL(`../${CENSUS_MD}`, import.meta.url), "utf8");
  assert.match(markdown, /26 of 40 projects \(65 percent\)/);
  assert.match(markdown, new RegExp(LAND_PROJECT_MAP_POINT_SPECIMENS.multi_bbl));
  assert.match(markdown, new RegExp(LAND_PROJECT_MAP_POINT_SPECIMENS.no_retained_bbl));
  assert.match(markdown, new RegExp(String(committed.aggregations.list_baseline.bytes)));
  assert.match(markdown, /node tools\/build_land_mapability_census\.mjs --check/);
  assert.ok(CENSUS_JSON.endsWith("land-map-view-census.json"));
});
