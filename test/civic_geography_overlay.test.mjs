import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import {
  civicGeometryArea,
  civicGeometryIntersectionArea,
  overlayCivicGeographies,
  projectEpsg2263,
} from "../site/civic_geography_overlay.mjs";

const OVERLAY_SOURCE = readFileSync(
  new URL("../site/civic_geography_overlay.mjs", import.meta.url),
  "utf8",
);

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

test("EPSG:2263 projection routes fractional powers away from `**`/Math.pow", () => {
  // `**`/Math.pow with a non-integer exponent is only "implementation-approximated" per
  // ECMA-262: it previously gave a different result for the same (base, exponent) pair
  // between Node versions on one machine, which propagated into the published geography
  // crosswalk artifacts and failed their byte-identical manifest check. Pinning an exact
  // projected coordinate here would be the wrong level to test at — the raw double can still
  // differ by a few ULPs across CPU architectures even through Math.exp/Math.log, and that
  // residual only vanishes once the production pipeline rounds it (which
  // tools/build_geography_crosswalks.mjs --check verifies against the committed artifacts).
  // So this test pins the structural fix instead: every fractional power in the projection
  // must go through fractionalPow, and none may remain as a bare `**`/Math.pow with a
  // non-integer exponent.
  // One definition plus four call sites: inside `t(phi)`, `t1 ** exponent` in `factor`, and
  // the two `t(...) ** exponent` terms in `rho`/`rhoOrigin`.
  const fractionalPowOccurrences = OVERLAY_SOURCE.match(/fractionalPow\(/g)?.length ?? 0;
  assert.equal(fractionalPowOccurrences, 5, "expected every fractional power in the Lambert Conformal Conic terms to route through fractionalPow");
  const barePowWithVariableExponent = /\*\*\s*\(?\s*(?:exponent\b|eccentricity\s*\/\s*2)/;
  assert.equal(barePowWithVariableExponent.test(OVERLAY_SOURCE), false, "found a fractional-exponent `**`/Math.pow outside fractionalPow");

  const [x, y] = projectEpsg2263([-73.93694879862264, 40.7246524683916]);
  assert.ok(Number.isFinite(x) && Number.isFinite(y));
  assert.ok(Math.abs(x - 1001726.423) < 0.01, `x should be near the known-good projection, got ${x}`);
  assert.ok(Math.abs(y - 203293.27) < 0.01, `y should be near the known-good projection, got ${y}`);
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
