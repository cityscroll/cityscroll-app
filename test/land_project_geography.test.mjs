/**
 * Known-point Land geography contract.
 *
 *   node --test test/land_project_geography.test.mjs
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import {
  KNOWN_LAND_POINT_METHODS,
  KNOWN_LAND_POINT_PRECISIONS,
  KNOWN_LAND_UNMAPPED_REASONS,
  REJECTED_KNOWN_LAND_POINT_METHODS,
  nearestRetainedCentroid,
  resolveKnownLandProjectPoint,
  toFiniteKnownLandPoint,
  uniqueKnownBblCentroids,
} from "../site/land_project_geography.mjs";

const geographySrc = readFileSync(new URL("../site/land_project_geography.mjs", import.meta.url), "utf8");
const census = JSON.parse(
  readFileSync(new URL("../docs/evidence/land-map-view-census.json", import.meta.url), "utf8"),
);

const ACCEPTED_METHODS = new Set([
  KNOWN_LAND_POINT_METHODS.PUBLISHER_POINT,
  KNOWN_LAND_POINT_METHODS.SINGLE_BBL_CENTROID,
  KNOWN_LAND_POINT_METHODS.MULTI_BBL_ANCHOR,
  KNOWN_LAND_POINT_METHODS.PROPERTY_COORDINATE,
  KNOWN_LAND_POINT_METHODS.GEOMETRY_REPRESENTATIVE_POINT,
]);

const ACCEPTED_PRECISIONS = new Set([
  KNOWN_LAND_POINT_PRECISIONS.EXACT,
  KNOWN_LAND_POINT_PRECISIONS.ANCHOR,
  KNOWN_LAND_POINT_PRECISIONS.REPRESENTATIVE,
]);

function assertMappedSchema(result) {
  assert.equal(result.status, "mapped");
  assert.equal(Number.isFinite(result.lat), true);
  assert.equal(Number.isFinite(result.lon), true);
  assert.equal(ACCEPTED_METHODS.has(result.method), true);
  assert.equal(ACCEPTED_PRECISIONS.has(result.precision), true);
  assert.equal(Number.isInteger(result.bblCount), true);
  assert.equal(result.bblCount >= 0, true);
  assert.equal(result.reason, undefined);
}

function assertUnmappedSchema(result, reason) {
  assert.equal(result.status, "unmapped");
  assert.equal(result.lat, null);
  assert.equal(result.lon, null);
  assert.equal(result.method, KNOWN_LAND_POINT_METHODS.UNMAPPED);
  assert.equal(result.precision, null);
  assert.equal(result.bbl, null);
  assert.equal(result.reason, reason);
}

function specimenCentroids(projectId) {
  const row = census.projects.find((item) => item.project_id === projectId);
  assert.ok(row, `census row ${projectId} missing`);
  return row.matched_centroids.map((item) => ({ bbl: item.bbl, lat: item.lat, lon: item.lon }));
}

test("A1 2025K0305 anchors on a real nearest-mean centroid, not the mean or first row", () => {
  const points = specimenCentroids("2025K0305");
  assert.equal(points.length, 25);
  const reversed = [...points].reverse();
  const shuffledFirst = [points[0], ...points.slice(1).reverse()];

  const expected = nearestRetainedCentroid(uniqueKnownBblCentroids(points));
  assert.ok(expected);
  const meanIsACentroid = points.some(
    (item) => item.lat === expected.mean.lat && item.lon === expected.mean.lon,
  );
  assert.equal(meanIsACentroid, false);
  assert.equal(
    points.some((item) => item.bbl === expected.bbl && item.lat === expected.lat && item.lon === expected.lon),
    true,
  );
  assert.notEqual(expected.bbl, points[0].bbl);

  for (const bblPoints of [points, reversed, shuffledFirst]) {
    const result = resolveKnownLandProjectPoint({ bblPoints });
    assertMappedSchema(result);
    assert.equal(result.method, KNOWN_LAND_POINT_METHODS.MULTI_BBL_ANCHOR);
    assert.equal(result.precision, KNOWN_LAND_POINT_PRECISIONS.ANCHOR);
    assert.notEqual(result.precision, KNOWN_LAND_POINT_PRECISIONS.EXACT);
    assert.equal(result.bblCount, 25);
    assert.equal(result.bbl, expected.bbl);
    assert.equal(result.lat, expected.lat);
    assert.equal(result.lon, expected.lon);
    assert.notEqual(result.lat, expected.mean.lat);
    assert.notEqual(result.lon, expected.mean.lon);
    assert.notEqual(result.bbl, bblPoints[0].bbl);
  }
});

test("one retained BBL is a single_bbl_centroid with exact precision", () => {
  const result = resolveKnownLandProjectPoint({
    bblPoints: [{ bbl: "5007087501", lat: 40.6128941, lon: -74.1198445 }],
  });
  assertMappedSchema(result);
  assert.equal(result.method, KNOWN_LAND_POINT_METHODS.SINGLE_BBL_CENTROID);
  assert.equal(result.precision, KNOWN_LAND_POINT_PRECISIONS.EXACT);
  assert.equal(result.bblCount, 1);
  assert.equal(result.bbl, "5007087501");
  assert.equal(result.lat, 40.6128941);
  assert.equal(result.lon, -74.1198445);
});

test("publisher point wins over BBL, property, and geometry inputs", () => {
  const result = resolveKnownLandProjectPoint({
    publisherPoint: { lat: 40.7101, lon: -73.96 },
    bblPoints: [{ bbl: "5007087501", lat: 40.6128941, lon: -74.1198445 }],
    propertyPoint: { latitude: 40.73, longitude: -73.93 },
    geometryPoint: { type: "Point", coordinates: [-73.99, 40.72] },
  });
  assertMappedSchema(result);
  assert.equal(result.method, KNOWN_LAND_POINT_METHODS.PUBLISHER_POINT);
  assert.equal(result.precision, KNOWN_LAND_POINT_PRECISIONS.EXACT);
  assert.equal(result.lat, 40.7101);
  assert.equal(result.lon, -73.96);
  assert.equal(result.bblCount, 1);
  assert.equal(result.bbl, null);
});

test("property coordinate is used only after publisher and BBL sources miss", () => {
  const result = resolveKnownLandProjectPoint({
    propertyPoint: { latitude: 40.73061, longitude: -73.935242 },
    geometryPoint: { type: "Point", coordinates: [-73.99, 40.72] },
  });
  assertMappedSchema(result);
  assert.equal(result.method, KNOWN_LAND_POINT_METHODS.PROPERTY_COORDINATE);
  assert.equal(result.precision, KNOWN_LAND_POINT_PRECISIONS.EXACT);
  assert.equal(result.lat, 40.73061);
  assert.equal(result.lon, -73.935242);
  assert.equal(result.bblCount, 0);
});

test("geometry representative point is the lowest accepted source", () => {
  const result = resolveKnownLandProjectPoint({
    geometryPoint: { type: "Point", coordinates: [-73.99, 40.72] },
  });
  assertMappedSchema(result);
  assert.equal(result.method, KNOWN_LAND_POINT_METHODS.GEOMETRY_REPRESENTATIVE_POINT);
  assert.equal(result.precision, KNOWN_LAND_POINT_PRECISIONS.REPRESENTATIVE);
  assert.equal(result.lat, 40.72);
  assert.equal(result.lon, -73.99);
});

test("invalid publisher range falls through to a valid BBL centroid", () => {
  const result = resolveKnownLandProjectPoint({
    publisherPoint: { lat: 91, lon: 0 },
    bblPoints: [{ bbl: "1010101010", lat: 40.73061, lon: -73.935242 }],
  });
  assertMappedSchema(result);
  assert.equal(result.method, KNOWN_LAND_POINT_METHODS.SINGLE_BBL_CENTROID);
  assert.equal(result.lat, 40.73061);
  assert.equal(result.lon, -73.935242);
});

test("duplicate BBLs collapse to one exact centroid regardless of arrival order", () => {
  const first = [
    { bbl: "1010101010", lat: 40.73061, lon: -73.935242 },
    { bbl: "1-0101-01010", lat: 40.73061, lon: -73.935242 },
    { bbl: "1010101010", lat: 40.73061, lon: -73.935242 },
  ];
  const reversed = [...first].reverse();
  for (const bblPoints of [first, reversed]) {
    const result = resolveKnownLandProjectPoint({ bblPoints });
    assertMappedSchema(result);
    assert.equal(result.method, KNOWN_LAND_POINT_METHODS.SINGLE_BBL_CENTROID);
    assert.equal(result.precision, KNOWN_LAND_POINT_PRECISIONS.EXACT);
    assert.equal(result.bblCount, 1);
    assert.equal(result.bbl, "1010101010");
  }
});

test("equidistant multi-BBL ties break by BBL id, not input order", () => {
  const west = { bbl: "3000000002", lat: 40.5, lon: -74.0 };
  const east = { bbl: "3000000001", lat: 40.5, lon: -73.75 };
  const expected = nearestRetainedCentroid(uniqueKnownBblCentroids([west, east]));
  assert.equal(expected.bbl, "3000000001");
  assert.equal(expected.mean.lat, 40.5);
  assert.equal(expected.mean.lon, -73.875);

  const forward = resolveKnownLandProjectPoint({ bblPoints: [west, east] });
  const backward = resolveKnownLandProjectPoint({ bblPoints: [east, west] });
  assertMappedSchema(forward);
  assertMappedSchema(backward);
  assert.equal(forward.method, KNOWN_LAND_POINT_METHODS.MULTI_BBL_ANCHOR);
  assert.equal(forward.precision, KNOWN_LAND_POINT_PRECISIONS.ANCHOR);
  assert.equal(forward.bbl, "3000000001");
  assert.equal(backward.bbl, "3000000001");
  assert.equal(forward.lat, east.lat);
  assert.equal(forward.lon, east.lon);
  assert.deepEqual(
    { lat: forward.lat, lon: forward.lon, bbl: forward.bbl },
    { lat: backward.lat, lon: backward.lon, bbl: backward.bbl },
  );
});

test("missing points return structured unmappedness", () => {
  const result = resolveKnownLandProjectPoint({});
  assertUnmappedSchema(result, KNOWN_LAND_UNMAPPED_REASONS.NO_ACCEPTED_POINT);
  assert.equal(result.bblCount, 0);
});

test("out-of-range and non-finite points stay unmapped", () => {
  const outOfRange = resolveKnownLandProjectPoint({
    publisherPoint: { lat: 41.5, lon: -73.9 },
    propertyPoint: { lat: Number.NaN, lon: -74.0 },
    geometryPoint: { lat: 40.7, lon: Number.POSITIVE_INFINITY },
  });
  assertUnmappedSchema(outOfRange, KNOWN_LAND_UNMAPPED_REASONS.INVALID_RANGE);

  const finiteReject = toFiniteKnownLandPoint({ lat: 39.9, lon: -74.0 });
  assert.equal(finiteReject, null);
});

test("geocode-only input is rejected and never becomes a method", () => {
  const result = resolveKnownLandProjectPoint({
    publisherPoint: { method: "address_geocode", lat: 40.71, lon: -73.96 },
  });
  assertUnmappedSchema(result, KNOWN_LAND_UNMAPPED_REASONS.ADDRESS_GEOCODE_REJECTED);
  assert.equal(result.method === "address_geocode", false);

  const ignored = resolveKnownLandProjectPoint({
    address_geocode: { lat: 40.71, lon: -73.96 },
    geocode: () => ({ lat: 40.71, lon: -73.96 }),
  });
  assertUnmappedSchema(ignored, KNOWN_LAND_UNMAPPED_REASONS.NO_ACCEPTED_POINT);
});

test("A2 rejected placement methods never map", () => {
  for (const method of REJECTED_KNOWN_LAND_POINT_METHODS) {
    const result = resolveKnownLandProjectPoint({
      publisherPoint: { method, lat: 40.71, lon: -73.96 },
    });
    assert.equal(result.status, "unmapped");
    assert.equal(ACCEPTED_METHODS.has(result.method), false);
    assert.equal(result.method === method, false);
  }
  const district = resolveKnownLandProjectPoint({
    publisherPoint: { method: "district_guess", lat: 40.71, lon: -73.96 },
  });
  assertUnmappedSchema(district, KNOWN_LAND_UNMAPPED_REASONS.UNSUPPORTED_METHOD);
});

test("priority conflicts keep publisher, then BBL, then property, then geometry", () => {
  const bblOverProperty = resolveKnownLandProjectPoint({
    bblPoints: [{ bbl: "2020202020", lat: 40.72, lon: -73.99 }],
    propertyPoint: { lat: 40.73, lon: -73.93 },
    geometryPoint: { lat: 40.74, lon: -73.92 },
  });
  assert.equal(bblOverProperty.method, KNOWN_LAND_POINT_METHODS.SINGLE_BBL_CENTROID);
  assert.equal(bblOverProperty.lat, 40.72);

  const propertyOverGeometry = resolveKnownLandProjectPoint({
    propertyPoint: { lat: 40.73, lon: -73.93 },
    geometryPoint: { lat: 40.74, lon: -73.92 },
  });
  assert.equal(propertyOverGeometry.method, KNOWN_LAND_POINT_METHODS.PROPERTY_COORDINATE);
  assert.equal(propertyOverGeometry.lat, 40.73);
});

test("A4 shared resolver has no fetch or geocoder dependency", () => {
  assert.equal(/\bfetch\s*\(/.test(geographySrc), false);
  assert.equal(/\bgeocode\s*\(/.test(geographySrc), false);
  assert.equal(/createPrecomputedAddressGeocoder/.test(geographySrc), false);
  assert.equal(/arcgis|unpkg|nominatim|mapbox|leaflet/i.test(geographySrc), false);
  assert.equal(/https?:\/\//.test(geographySrc), false);
  assert.equal(/from ["'].*app\/land\.mjs["']/.test(geographySrc), false);
  assert.equal(/address_geocode/.test(geographySrc), true);
});
