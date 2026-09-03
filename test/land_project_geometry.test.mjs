/**
 * node --test test/land_project_geometry.test.mjs
 */
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";

import {
  LAND_PROJECT_GEOMETRY_COVERAGE_STATES as STATES,
  LAND_PROJECT_GEOMETRY_METHOD,
  LAND_PROJECT_GEOMETRY_PRECISION,
  LAND_PROJECT_GEOMETRY_RECEIPT_SCHEMA,
  LAND_PROJECT_GEOMETRY_RELATION,
  LAND_PROJECT_GEOMETRY_SCHEMA,
  assertLandProjectGeometry,
  landMapParcelSvg,
  landParcelPolygonFindings,
  landProjectGeometryFindings,
  materializeLandProjectGeometry,
  singleBblGeometryCandidates,
} from "../site/land_project_geometry.mjs";

const requireJson = createRequire(import.meta.url);
const fixture = requireJson("./fixtures/land_project_geometry/inputs.json");

function run(overrides = {}, opts = {}) {
  return materializeLandProjectGeometry({ ...fixture, ...overrides }, opts);
}

test("single-BBL exact candidate renders a valid shape with method, relation, precision", () => {
  const { payload, receipt } = run();
  const shape = payload.shapes["2026R0127"];
  assert.equal(payload.schema, LAND_PROJECT_GEOMETRY_SCHEMA);
  assert.equal(shape.method, LAND_PROJECT_GEOMETRY_METHOD);
  assert.equal(shape.precision, LAND_PROJECT_GEOMETRY_PRECISION);
  assert.equal(shape.relation, LAND_PROJECT_GEOMETRY_RELATION);
  assert.equal(shape.coverage_state, STATES.EXACT);
  assert.equal(shape.bbl, "5007087501");
  assert.equal(shape.vintage, "2026-08-30T00:00:00.000Z");
  assert.equal(landParcelPolygonFindings(shape), null);
  assert.equal(receipt.project_ids[STATES.EXACT].includes("2026R0127"), true);
});

test("multi-BBL project is always ambiguous_relation and never receives a shape", () => {
  const { payload, receipt } = run();
  assert.equal("2025K0305" in payload.shapes, false);
  assert.equal(receipt.project_ids[STATES.AMBIGUOUS_RELATION].includes("2025K0305"), true);
  const row = receipt.projects.find((item) => item.project_id === "2025K0305");
  assert.equal(row.coverage_state, STATES.AMBIGUOUS_RELATION);
  assert.equal(row.exact_bbl_count, 3);
  assert.match(row.reason, /complete-assemblage/);
});

test("projects with no accepted point are not_applicable_unmapped regardless of BBL relation", () => {
  const { payload, receipt } = run();
  assert.equal("2026K0123" in payload.shapes, false);
  assert.equal("2020M0385" in payload.shapes, false);
  assert.equal(receipt.project_ids[STATES.NOT_APPLICABLE_UNMAPPED].includes("2026K0123"), true);
  assert.equal(receipt.project_ids[STATES.NOT_APPLICABLE_UNMAPPED].includes("2020M0385"), true);
});

test("an open, invalid ring is rejected and falls back to the point", () => {
  const { payload, receipt } = run();
  assert.equal("INVALIDGEOM" in payload.shapes, false);
  assert.equal(receipt.project_ids[STATES.INVALID].includes("INVALIDGEOM"), true);
  const row = receipt.projects.find((item) => item.project_id === "INVALIDGEOM");
  assert.equal(row.coverage_state, STATES.INVALID);
  assert.match(row.reason, /ring/);
});

test("an exact single BBL with no retained geometry row is missing_geometry_row", () => {
  const { payload, receipt } = run();
  assert.equal("MISSINGROW" in payload.shapes, false);
  assert.equal(receipt.project_ids[STATES.MISSING_GEOMETRY_ROW].includes("MISSINGROW"), true);
});

test("geometry older than the max age gates to stale, not exact", () => {
  const farFuture = "2027-06-01T00:00:00.000Z";
  const { payload, receipt } = run({}, { now: farFuture });
  assert.equal("2026R0127" in payload.shapes, false);
  assert.equal(receipt.project_ids[STATES.STALE].includes("2026R0127"), true);
  const row = receipt.projects.find((item) => item.project_id === "2026R0127");
  assert.match(row.reason, /exceeds max/);
});

test("repeated materialization is byte-stable", () => {
  const first = run();
  const second = run();
  assert.deepEqual(first.payload, second.payload);
  assert.deepEqual(first.receipt, second.receipt);
});

test("every default project is represented exactly once in the receipt", () => {
  const { receipt } = run();
  const represented = Object.values(receipt.project_ids).flat();
  assert.equal(new Set(represented).size, represented.length);
  assert.equal(represented.length, receipt.counts.universe);
  assert.equal(receipt.counts.universe, 6);
});

test("receipt discloses rejected relation classes and stays network/publisher free", () => {
  const { receipt } = run();
  assert.equal(receipt.schema, LAND_PROJECT_GEOMETRY_RECEIPT_SCHEMA);
  assert.equal(receipt.new_publisher_work, false);
  assert.equal(receipt.runtime_network, false);
  assert.equal(receipt.geocoder_input, false);
  assert.equal(receipt.point_fallback_preserved, true);
  assert.ok(receipt.rejected_relations.includes("multi_bbl_union"));
  assert.ok(receipt.rejected_relations.includes("address_or_title_join"));
  assert.ok(receipt.rejected_relations.includes("proximity_or_overlap_join"));
});

test("single-BBL candidate finder is independent of centroid match status", () => {
  const candidates = singleBblGeometryCandidates(fixture);
  assert.equal(candidates.get("2026R0127"), "5007087501");
  assert.equal(candidates.get("2020M0385"), "1010060013");
  assert.equal(candidates.has("2025K0305"), false);
  assert.equal(candidates.has("2026K0123"), false);
});

test("contract findings pass for a real fixture run and fail closed on tampering", () => {
  const { payload, receipt } = run();
  assertLandProjectGeometry(payload, receipt);
  const tampered = { ...receipt, new_publisher_work: true };
  assert.ok(landProjectGeometryFindings(payload, tampered).some((f) => f.includes("new_publisher_work")));
  const overBudget = landProjectGeometryFindings(payload, receipt, { payloadBytes: 1024 * 1024 });
  assert.ok(overBudget.some((f) => f.includes("exceeds")));
});

test("landMapParcelSvg draws only markers that carry a shape, and never interactively", () => {
  const shape = run().payload.shapes["2026R0127"];
  const markerLayer = [
    { projectId: "2026R0127", geometry: shape, label: "One lot" },
    { projectId: "2025K0305", geometry: null, label: "Many lots" },
  ];
  const svg = landMapParcelSvg(markerLayer);
  assert.match(svg, /<g class="land-map-parcels" aria-hidden="true">/);
  assert.match(svg, /data-land-map-project="2026R0127"/);
  assert.doesNotMatch(svg, /data-land-map-project="2025K0305"/);
  assert.match(svg, /pointer-events="none"/);
  assert.match(svg, /<title>One lot<\/title>/);
  assert.doesNotMatch(svg, /<a /, "a parcel outline must never be its own control");
});

test("landMapParcelSvg renders nothing for an empty marker layer", () => {
  assert.equal(landMapParcelSvg([]), '<g class="land-map-parcels" aria-hidden="true"></g>');
  assert.equal(landMapParcelSvg(undefined), '<g class="land-map-parcels" aria-hidden="true"></g>');
});

test("payload never carries receipt-only operational fields", () => {
  const { payload } = run();
  assert.equal(payload.projects, undefined);
  assert.equal(payload.generation, undefined);
  assert.equal(payload.counts, undefined);
});
