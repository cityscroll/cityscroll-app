/**
 * Bounded Land project-location materializer.
 *
 *   node --test test/land_project_map_points.test.mjs
 */
import assert from "node:assert/strict";
import { readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";

import {
  KNOWN_LAND_POINT_METHODS,
  KNOWN_LAND_POINT_PRECISIONS,
  nearestRetainedCentroid,
  uniqueKnownBblCentroids,
} from "../site/land_project_geography.mjs";
import {
  LAND_PROJECT_MAP_POINTS_JOIN_VERSION,
  LAND_PROJECT_MAP_POINTS_MAX_BYTES,
  LAND_PROJECT_MAP_POINTS_RECEIPT_SCHEMA,
  LAND_PROJECT_MAP_POINTS_RESOLVER_VERSION,
  LAND_PROJECT_MAP_POINTS_SCHEMA,
  LAND_PROJECT_MAP_POINT_SPECIMENS,
  assertLandProjectMapPoints,
  landProjectMapPointsFindings,
  materializeLandProjectMapPoints,
} from "../site/land_project_map_points.mjs";
import {
  PAYLOAD_JSON,
  RECEIPT_JSON,
  buildLandProjectMapPointsFromRepo,
} from "../tools/build_land_project_map_points.mjs";
import { reconcileDerivedArchitectureEvidence } from "../tools/architecture_evidence_shards.mjs";

const requireJson = createRequire(import.meta.url);
const fixture = requireJson("./fixtures/land_project_map_points/inputs.json");
const materializerSrc = readFileSync(new URL("../site/land_project_map_points.mjs", import.meta.url), "utf8");
const builderSrc = readFileSync(new URL("../tools/build_land_project_map_points.mjs", import.meta.url), "utf8");

const SIX_EXACT_BBL_MISSES = [
  "2020M0385",
  "2020K0444",
  "2024Q0135",
  "P2012X0048",
  "2020Q0317",
  "2023M0452",
];

function fixtureRun(overrides = {}) {
  return materializeLandProjectMapPoints({
    ...fixture,
    artifactHashes: {
      land_default: "a".repeat(64),
      zap_bbl: "b".repeat(64),
      mappluto_centroids: "c".repeat(64),
    },
    ...overrides,
  });
}

test("fixture single-BBL output is exact for 2026R0127", () => {
  const { payload, receipt } = fixtureRun();
  const point = payload.points["2026R0127"];
  assert.equal(payload.schema, LAND_PROJECT_MAP_POINTS_SCHEMA);
  assert.equal(point.lat, 40.6128941);
  assert.equal(point.lon, -74.1198445);
  assert.equal(point.method, KNOWN_LAND_POINT_METHODS.SINGLE_BBL_CENTROID);
  assert.equal(point.precision, KNOWN_LAND_POINT_PRECISIONS.EXACT);
  assert.equal(point.bbl_count, 1);
  assert.equal(receipt.mapped_project_ids.includes("2026R0127"), true);
  assert.equal("2026R0127" in payload.points, true);
});

test("fixture multi-BBL anchor is a real nearest-mean centroid, not the mean", () => {
  const { payload } = fixtureRun();
  const expected = nearestRetainedCentroid(uniqueKnownBblCentroids([
    { bbl: "3069440002", lat: 40.60, lon: -74.04 },
    { bbl: "3069440004", lat: 40.66, lon: -73.98 },
    { bbl: "3069440007", lat: 40.70, lon: -74.00 },
  ]));
  const point = payload.points["2025K0305"];
  assert.equal(point.method, KNOWN_LAND_POINT_METHODS.MULTI_BBL_ANCHOR);
  assert.equal(point.precision, KNOWN_LAND_POINT_PRECISIONS.ANCHOR);
  assert.equal(point.bbl_count, 3);
  assert.equal(point.lat, expected.lat);
  assert.equal(point.lon, expected.lon);
  assert.notEqual(point.lat, expected.mean.lat);
  assert.notEqual(point.lon, expected.mean.lon);
  const isRetained = [
    [40.60, -74.04],
    [40.66, -73.98],
    [40.70, -74.00],
  ].some(([lat, lon]) => lat === point.lat && lon === point.lon);
  assert.equal(isRetained, true);
});

test("2026K0123 is receipt-only unmapped with no retained BBL", () => {
  const { payload, receipt } = fixtureRun();
  assert.equal("2026K0123" in payload.points, false);
  assert.equal(receipt.source_missing_project_ids.includes("2026K0123"), true);
  const row = receipt.outcomes.find((item) => item.project_id === "2026K0123");
  assert.equal(row.status, "source_missing");
  assert.equal(row.reason, "no_retained_bbl");
  assert.equal(row.bbl_count, 0);
});

test("exact-BBL misses stay source-missing without centroid substitution", () => {
  const { payload, receipt } = fixtureRun();
  assert.equal("2020M0385" in payload.points, false);
  assert.deepEqual(receipt.unmapped_exact_bbl_missing_centroid, ["2020M0385"]);
  const row = receipt.outcomes.find((item) => item.project_id === "2020M0385");
  assert.equal(row.status, "source_missing");
  assert.equal(row.reason, "exact_bbl_missing_centroid");
  assert.equal(row.exact_bbl_count, 1);
  assert.equal(row.bbl_count, 0);
});

test("repeated materialization is byte-stable", () => {
  const first = fixtureRun();
  const second = fixtureRun();
  assert.deepEqual(first.payload, second.payload);
  assert.deepEqual(first.receipt, second.receipt);
});

test("geocoded, district, borough, and invalid extras never publish", () => {
  const { payload, receipt } = fixtureRun({
    publisherPoints: {
      REJECTED1: { method: "address_geocode", lat: 40.71, lon: -73.96 },
      "2026K0123": { method: "district_guess", lat: 40.69, lon: -73.98 },
      "2020M0385": { method: "borough_centroid", lat: 40.78, lon: -73.96 },
      "2026R0127": { lat: Number.NaN, lon: -74.1 },
    },
    propertyPoints: {
      "2026K0123": { method: "outcome_point", lat: 40.7, lon: -74.0 },
    },
  });
  assert.equal("REJECTED1" in payload.points, false);
  assert.equal("2026K0123" in payload.points, false);
  assert.equal("2020M0385" in payload.points, false);
  assert.equal(payload.points["2026R0127"].method, KNOWN_LAND_POINT_METHODS.SINGLE_BBL_CENTROID);
  const rejected = receipt.outcomes.find((item) => item.project_id === "REJECTED1");
  assert.equal(rejected.status, "rejected");
  assert.equal(rejected.reason, "address_geocode_rejected");
  assert.equal(receipt.rejected_project_ids.includes("REJECTED1"), true);
  const exactMiss = receipt.outcomes.find((item) => item.project_id === "2020M0385");
  assert.equal(exactMiss.status, "source_missing");
  assert.equal(exactMiss.reason, "exact_bbl_missing_centroid");
});

test("source vintages and generation identity stay on the receipt", () => {
  const { payload, receipt } = fixtureRun();
  assert.equal(payload.generation, undefined);
  assert.equal(payload.inputs, undefined);
  assert.equal(payload.outcomes, undefined);
  assert.equal(receipt.schema, LAND_PROJECT_MAP_POINTS_RECEIPT_SCHEMA);
  assert.equal(receipt.resolver_version, LAND_PROJECT_MAP_POINTS_RESOLVER_VERSION);
  assert.equal(receipt.join_version, LAND_PROJECT_MAP_POINTS_JOIN_VERSION);
  assert.equal(receipt.inputs.land_default.vintage.generated_at, "2026-08-23T07:59:14.162Z");
  assert.equal(receipt.inputs.zap_bbl.vintage.phase, "WH-06");
  assert.equal(receipt.inputs.mappluto_centroids.vintage.source, "mappluto");
  assert.deepEqual(receipt.inputs.join_keys, ["project_id", "bbl"]);
  assert.equal(receipt.counts.universe, 5);
  assert.equal(receipt.generation.derivation, "node tools/build_land_project_map_points.mjs");
  assert.equal(receipt.inputs.land_default.sha256.length, 64);
});

test("every default project is a payload point or a receipt row", () => {
  const { payload, receipt } = fixtureRun();
  assertLandProjectMapPoints(payload, receipt);
  const represented = new Set([
    ...Object.keys(payload.points),
    ...receipt.outcomes.map((row) => row.project_id),
  ]);
  assert.deepEqual([...represented].sort(), [
    "2020M0385",
    "2025K0305",
    "2026K0123",
    "2026R0127",
    "REJECTED1",
  ]);
  assert.equal(receipt.counts.universe, 5);
  assert.equal(Object.keys(payload.points).length, receipt.counts.mapped);
});

test("dropping unmapped rows fails the contract", () => {
  const { payload, receipt } = fixtureRun();
  const mappedOnly = {
    ...receipt,
    counts: { ...receipt.counts, unmapped: 0, source_missing: 0, rejected: 0 },
    unmapped_project_ids: [],
    rejected_project_ids: [],
    source_missing_project_ids: [],
    outcomes: receipt.outcomes.filter((row) => row.status === "mapped"),
  };
  const findings = landProjectMapPointsFindings(payload, mappedOnly);
  assert.equal(findings.some((line) => /universe/.test(line)), true);
});

test("materializer and builder have no fetch or geocoder dependency", () => {
  for (const src of [materializerSrc, builderSrc]) {
    assert.equal(/\bfetch\s*\(/.test(src), false);
    assert.equal(/\bgeocode\s*\(/.test(src), false);
    assert.equal(/createPrecomputedAddressGeocoder/.test(src), false);
    assert.equal(/arcgis|unpkg|nominatim|mapbox|leaflet/i.test(src), false);
    assert.equal(/from ["'].*app\/land\.mjs["']/.test(src), false);
  }
});

test("committed projection maps 2026R0127 and anchors 2025K0305 on a retained centroid", () => {
  const built = buildLandProjectMapPointsFromRepo();
  const census = requireJson("../docs/evidence/land-map-view-census.json");
  const payload = JSON.parse(readFileSync(new URL(`../${PAYLOAD_JSON}`, import.meta.url), "utf8"));
  const receipt = JSON.parse(readFileSync(new URL(`../${RECEIPT_JSON}`, import.meta.url), "utf8"));
  assert.deepEqual(built.payload, payload);
  assert.deepEqual(built.receipt, receipt);
  assertLandProjectMapPoints(payload, receipt, { payloadBytes: receipt.generation.payload_bytes });

  const single = payload.points[LAND_PROJECT_MAP_POINT_SPECIMENS.single_bbl];
  assert.equal(single.method, KNOWN_LAND_POINT_METHODS.SINGLE_BBL_CENTROID);
  assert.equal(single.precision, KNOWN_LAND_POINT_PRECISIONS.EXACT);
  assert.equal(single.bbl_count, 1);
  assert.equal(single.lat, 40.6128941);
  assert.equal(single.lon, -74.1198445);

  const multiRow = census.projects.find((row) => row.project_id === LAND_PROJECT_MAP_POINT_SPECIMENS.multi_bbl);
  const expected = nearestRetainedCentroid(uniqueKnownBblCentroids(multiRow.matched_centroids));
  const multi = payload.points[LAND_PROJECT_MAP_POINT_SPECIMENS.multi_bbl];
  assert.equal(multi.method, KNOWN_LAND_POINT_METHODS.MULTI_BBL_ANCHOR);
  assert.equal(multi.precision, KNOWN_LAND_POINT_PRECISIONS.ANCHOR);
  assert.equal(multi.bbl_count, 25);
  assert.equal(multi.lat, expected.lat);
  assert.equal(multi.lon, expected.lon);
  assert.equal(
    multiRow.matched_centroids.some((item) => item.lat === multi.lat && item.lon === multi.lon),
    true,
  );
  assert.notEqual(multi.lat, expected.mean.lat);
  assert.notEqual(multi.lon, expected.mean.lon);
});

test("committed receipt keeps 2026K0123 and the six exact-BBL misses out of the payload", () => {
  const payload = JSON.parse(readFileSync(new URL(`../${PAYLOAD_JSON}`, import.meta.url), "utf8"));
  const receipt = JSON.parse(readFileSync(new URL(`../${RECEIPT_JSON}`, import.meta.url), "utf8"));
  assert.equal(LAND_PROJECT_MAP_POINT_SPECIMENS.no_retained_bbl in payload.points, false);
  assert.equal(receipt.source_missing_project_ids.includes("2026K0123"), true);
  const missingBbl = receipt.outcomes.find((row) => row.project_id === "2026K0123");
  assert.equal(missingBbl.status, "source_missing");
  assert.equal(missingBbl.reason, "no_retained_bbl");
  assert.deepEqual(receipt.unmapped_exact_bbl_missing_centroid, SIX_EXACT_BBL_MISSES);
  for (const id of SIX_EXACT_BBL_MISSES) {
    assert.equal(id in payload.points, false);
    const row = receipt.outcomes.find((item) => item.project_id === id);
    assert.equal(row.status, "source_missing");
    assert.equal(row.reason, "exact_bbl_missing_centroid");
    assert.equal(row.exact_bbl_count >= 1, true);
    assert.equal(row.bbl_count, 0);
  }
  assert.equal(receipt.counts.universe, 40);
  assert.equal(receipt.counts.mapped + receipt.counts.source_missing + receipt.counts.unmapped + receipt.counts.rejected, 40);
  assert.equal(Object.keys(payload.points).length, receipt.counts.mapped);
});

test("resident payload stays bounded and does not copy the WH-06 corpus", () => {
  const payloadText = readFileSync(new URL(`../${PAYLOAD_JSON}`, import.meta.url), "utf8");
  const receipt = JSON.parse(readFileSync(new URL(`../${RECEIPT_JSON}`, import.meta.url), "utf8"));
  const zapBytes = statSync(new URL("../site/data/zap_bbl_warehouse_lookup.json", import.meta.url)).size;
  assert.equal(payloadText.includes("\"rows\""), false);
  assert.equal(payloadText.includes("by_bbl"), false);
  assert.equal(Buffer.byteLength(payloadText) < LAND_PROJECT_MAP_POINTS_MAX_BYTES, true);
  assert.equal(Buffer.byteLength(payloadText) < zapBytes / 50, true);
  assert.equal(receipt.generation.payload_bytes, Buffer.byteLength(payloadText));
  assert.equal(receipt.generation.payload_sha256.length, 64);
});

test("architecture-evidence projections reconcile the materializer card", () => {
  const result = reconcileDerivedArchitectureEvidence();
  assert.equal(result.status, "PASS", result.findings.join("; "));
  assert.equal(
    result.evidence.projections["site/data/land_project_map_points.json"].represented_card_ids.includes(
      "cityscroll-land-map-view/lm-02-project-point-materializer",
    ),
    true,
  );
});
