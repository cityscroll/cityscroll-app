import assert from "node:assert/strict";
import { test } from "node:test";

import {
  civicGeometryArea,
  civicGeometryIntersectionArea,
  overlayCivicGeographies,
} from "../site/civic_geography_overlay.mjs";

const identity = (point) => point;
const ring = (x1, y1, x2, y2) => [
  [x1, y1], [x2, y1], [x2, y2], [x1, y2], [x1, y1],
];
const feature = (key, coordinates) => ({
  key,
  geometry: { type: "MultiPolygon", coordinates },
});
const layer = (vintage, fidelity = "full") => ({
  geometry_fidelity: fidelity,
  vintage: { id: vintage },
});

test("exact intersection computes concave/hole area instead of boundary-touch membership", () => {
  const withHole = feature("geography:test:a", [[ring(0, 0, 10, 10), ring(4, 4, 6, 6)]]);
  const rightHalf = feature("geography:test:b", [[ring(5, 0, 15, 10)]]);
  assert.equal(civicGeometryArea(withHole, { projector: identity }), 96);
  assert.equal(civicGeometryIntersectionArea(withHole, rightHalf, { projector: identity }), 48);
});

test("overlay emits quantitative area/share and keeps each layer vintage", () => {
  const left = feature("geography:community_district:M01", [[ring(-74.01, 40.70, -74.00, 40.71)]]);
  const right = feature("geography:council_district:1", [[ring(-74.005, 40.70, -73.995, 40.71)]]);
  const result = overlayCivicGeographies({
    fromLayer: layer("2025-01-02"),
    fromFeature: left,
    toLayer: layer("2026-03-04"),
    toFeature: right,
  });
  assert.equal(result.relation, "intersects");
  assert.equal(result.method, "polygon_intersection_epsg2263");
  assert.ok(result.intersection_area_sqft > 0);
  assert.ok(Math.abs(result.pct_from - 50) < 0.02);
  assert.ok(Math.abs(result.pct_to - 50) < 0.02);
  assert.deepEqual(result.source_vintages, { from: "2025-01-02", to: "2026-03-04" });
});

test("boundary-only contact is touches, never an area intersection", () => {
  const left = feature("geography:test:left", [[ring(0, 0, 1, 1)]]);
  const right = feature("geography:test:right", [[ring(1, 0, 2, 1)]]);
  const result = overlayCivicGeographies({
    fromLayer: layer("a"),
    fromFeature: left,
    toLayer: layer("b"),
    toFeature: right,
    projector: identity,
  });
  assert.equal(result.relation, "touches");
  assert.equal(result.intersection_area_sqft, 0);
  assert.equal(result.pct_from, 0);
  assert.equal(result.pct_to, 0);
});

test("overlay fails closed on simplified delivery geometry", () => {
  const left = feature("geography:test:left", [[ring(0, 0, 1, 1)]]);
  const right = feature("geography:test:right", [[ring(0, 0, 1, 1)]]);
  assert.throws(() => overlayCivicGeographies({
    fromLayer: layer("a", "simplified"),
    fromFeature: left,
    toLayer: layer("b"),
    toFeature: right,
  }), /full-fidelity/);
});
