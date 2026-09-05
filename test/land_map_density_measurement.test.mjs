// LM-16: the Land Map density-summary measurement gate. Measuring overlap
// must never touch canonical project identity, List access, unmapped
// accounting, selection, or filters (A1); any eventual summary derives
// solely from currently filtered marker ids and discloses its numerator and
// scope (A2); geometry alone never authorizes a district/borough
// choropleth, an area-prevalence claim, or a hidden unmapped placement
// (A3); and sparse, dense, filtered, and stop-receipt fixtures prove
// identity, count reconciliation, and a reversible rollout (A4).

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { landMapMarkerPositions, landMapCanvasSvg } from "../site/app/map_runtime.mjs";
import { buildLandMapModel } from "../site/land_map_model.mjs";
import {
  LAND_MAP_DENSITY_NEGATIVE_RULES,
  LAND_MAP_DENSITY_OVERLAP_RATE_THRESHOLD,
  LAND_MAP_DENSITY_SCHEMA,
  LAND_MAP_DENSITY_STOP_REASONS,
  buildLandMapDensityReceipt,
  computeMarkerOverlap,
  evaluateLandMapDensitySummary,
  markerAccounting,
  validateLandMapDensityReceipt,
} from "../site/land_map_density_measurement.mjs";
import { build as buildDensityReceipt } from "../tools/build_land_map_density_receipt.mjs";

const ROOT = dirname(fileURLToPath(import.meta.url));
const read = (...parts) => readFileSync(join(ROOT, "..", ...parts), "utf8");
const readJson = (...parts) => JSON.parse(read(...parts));

const landDefault = readJson("site", "data", "land_default_ulurp.json");
const points = readJson("site", "data", "land_project_map_points.json");

function accountingFromModel(model, rows) {
  return markerAccounting({
    totalIds: rows.map((row) => String(row.project_id)),
    mappedIds: model.mapped.map((item) => item.projectId),
    unmappedIds: model.unmapped.map((item) => item.projectId),
  });
}

test("a sparse, well-separated marker set stops below the overlap threshold", () => {
  const rows = [
    { project_id: "S1" },
    { project_id: "S2" },
    { project_id: "S3" },
  ];
  const pointLookup = {
    S1: { lat: 40.60, lon: -74.00, method: "single_bbl_centroid", precision: "exact" },
    S2: { lat: 40.75, lon: -73.90, method: "single_bbl_centroid", precision: "exact" },
    S3: { lat: 40.85, lon: -73.80, method: "single_bbl_centroid", precision: "exact" },
  };
  const model = buildLandMapModel({ rows, pointLookup });
  const accounting = accountingFromModel(model, rows);
  const { positions, radius } = landMapMarkerPositions(model);
  const overlap = computeMarkerOverlap(positions, radius);
  assert.equal(overlap.markerCount, 3);
  assert.equal(overlap.overlappingPairs.length, 0);
  assert.equal(overlap.overlapRate, 0);

  const decision = evaluateLandMapDensitySummary({ accounting, overlap });
  assert.equal(decision.outcome, "stop");
  assert.equal(decision.reason, LAND_MAP_DENSITY_STOP_REASONS.BELOW_OVERLAP_THRESHOLD);
});

test("a dense, coincident marker set crosses the threshold but still stops without a task-impact review", () => {
  const rows = Array.from({ length: 6 }, (_, i) => ({ project_id: `D${i}` }));
  const pointLookup = Object.fromEntries(rows.map((row) => [
    row.project_id,
    { lat: 40.70, lon: -73.95, method: "single_bbl_centroid", precision: "exact" },
  ]));
  const model = buildLandMapModel({ rows, pointLookup });
  const accounting = accountingFromModel(model, rows);
  const { positions, radius } = landMapMarkerPositions(model);
  const overlap = computeMarkerOverlap(positions, radius);
  assert.equal(overlap.markerCount, 6);
  assert.ok(overlap.overlapRate >= LAND_MAP_DENSITY_OVERLAP_RATE_THRESHOLD, "coincident markers must cross the threshold");
  assert.deepEqual(overlap.affectedMarkerIds, rows.map((r) => r.project_id).sort());

  const unreviewed = evaluateLandMapDensitySummary({ accounting, overlap });
  assert.equal(unreviewed.outcome, "stop");
  assert.equal(unreviewed.reason, LAND_MAP_DENSITY_STOP_REASONS.UNSUPPORTED_TASK_IMPACT);

  const reviewedWithoutEvidence = evaluateLandMapDensitySummary({ accounting, overlap, reviewed: true, taskImpactEvidence: "" });
  assert.equal(reviewedWithoutEvidence.outcome, "stop");
  assert.equal(reviewedWithoutEvidence.reason, LAND_MAP_DENSITY_STOP_REASONS.UNSUPPORTED_TASK_IMPACT);

  const shipped = evaluateLandMapDensitySummary({
    accounting,
    overlap,
    reviewed: true,
    taskImpactEvidence: "2026-usability-pass: residents missed 4/6 coincident anchors without a summary cue",
  });
  assert.equal(shipped.outcome, "ship");
  assert.equal(shipped.summary.numerator, accounting.mapped.length);
  assert.equal(shipped.summary.scope, "projects currently mapped in the active filtered Land Map result");
  // The summary's own ids must be a subset of the model's real marker ids -- never invented.
  for (const id of shipped.summary.affectedMarkerIds) {
    assert.ok(accounting.mapped.includes(id));
  }
});

test("a filtered fixture with one unmapped project preserves unmapped accounting untouched", () => {
  const rows = [
    { project_id: "F1" },
    { project_id: "F2" },
    { project_id: "UNMAPPED1" },
  ];
  const pointLookup = {
    F1: { lat: 40.60, lon: -74.00, method: "single_bbl_centroid", precision: "exact" },
    F2: { lat: 40.75, lon: -73.90, method: "single_bbl_centroid", precision: "exact" },
  };
  const model = buildLandMapModel({ rows, pointLookup });
  assert.deepEqual(model.unmapped.map((u) => u.projectId), ["UNMAPPED1"]);
  const accounting = accountingFromModel(model, rows);
  assert.equal(accounting.total.length, 3);
  assert.equal(accounting.mapped.length, 2);
  assert.deepEqual(accounting.unmapped, ["UNMAPPED1"]);

  const { positions, radius } = landMapMarkerPositions(model);
  assert.equal(positions.length, 2, "an unmapped project never contributes a position");
  const overlap = computeMarkerOverlap(positions, radius);
  const decision = evaluateLandMapDensitySummary({ accounting, overlap });
  const receipt = buildLandMapDensityReceipt({ decision, sourceVintages: { fixture: "inline" } });
  // The stop/ship decision never hides or reclassifies the unmapped row.
  assert.deepEqual(receipt.marker_accounting.unmapped_ids, ["UNMAPPED1"]);
  assert.equal(receipt.marker_accounting.total_count, 3);
});

test("an accounting mismatch stops even when the geometry would otherwise ship", () => {
  const accounting = markerAccounting({ totalIds: ["A", "B"], mappedIds: ["A"], unmappedIds: ["A"] });
  assert.equal(accounting.reconciled, false);
  const overlap = computeMarkerOverlap([{ projectId: "A", x: 0, y: 0 }, { projectId: "A2", x: 0, y: 0 }], 5);
  const decision = evaluateLandMapDensitySummary({
    accounting,
    overlap,
    reviewed: true,
    taskImpactEvidence: "should not matter",
  });
  assert.equal(decision.outcome, "stop");
  assert.equal(decision.reason, LAND_MAP_DENSITY_STOP_REASONS.MARKER_ACCOUNTING_MISMATCH);
});

test("an all-unmapped population stops as having no mapped markers", () => {
  const accounting = markerAccounting({ totalIds: ["A", "B"], mappedIds: [], unmappedIds: ["A", "B"] });
  const overlap = computeMarkerOverlap([], 5);
  const decision = evaluateLandMapDensitySummary({ accounting, overlap });
  assert.equal(decision.outcome, "stop");
  assert.equal(decision.reason, LAND_MAP_DENSITY_STOP_REASONS.NO_MAPPED_MARKERS);
});

test("negative-rule ledger matches the card's negative rule bullets one for one", () => {
  assert.deepEqual([...LAND_MAP_DENSITY_NEGATIVE_RULES].sort(), [
    "add_density_as_new_filter_engine",
    "aggregate_raw_point_data_outside_filtered_model",
    "infer_density_for_unmapped_projects",
    "ship_district_or_borough_choropleth",
    "suppress_project_markers",
    "use_boundary_geometry_as_denominator",
  ]);
});

test("a stop receipt carries the full evidence contract and validates", () => {
  const accounting = markerAccounting({ totalIds: ["A", "B"], mappedIds: ["A", "B"], unmappedIds: [] });
  const overlap = computeMarkerOverlap([{ projectId: "A", x: 0, y: 0 }, { projectId: "B", x: 500, y: 500 }], 5);
  const decision = evaluateLandMapDensitySummary({ accounting, overlap });
  const receipt = buildLandMapDensityReceipt({ decision, sourceVintages: { fixture: "inline" } });
  assert.equal(receipt.schema, LAND_MAP_DENSITY_SCHEMA);
  assert.equal(receipt.outcome, "stop");
  assert.ok(receipt.stop_reason);
  assert.equal(receipt.disclosure.numerator, 2);
  assert.ok(Object.keys(receipt.source_vintages).length > 0);
  assert.equal(validateLandMapDensityReceipt(receipt).ok, true);
});

test("a ship receipt carries no stop reason and validates", () => {
  const accounting = markerAccounting({ totalIds: ["A", "B"], mappedIds: ["A", "B"], unmappedIds: [] });
  const overlap = computeMarkerOverlap([{ projectId: "A", x: 0, y: 0 }, { projectId: "B", x: 0, y: 0 }], 5);
  const decision = evaluateLandMapDensitySummary({
    accounting,
    overlap,
    reviewed: true,
    taskImpactEvidence: "recorded usability pass",
  });
  const receipt = buildLandMapDensityReceipt({ decision });
  assert.equal(receipt.outcome, "ship");
  assert.equal(receipt.stop_reason, null);
  assert.equal(validateLandMapDensityReceipt(receipt).ok, true);
});

test("computing overlap and a decision never mutates the model or its markers/selection/counts", () => {
  const rows = (landDefault.projects || []).slice(0, 10);
  const model = buildLandMapModel({ rows, pointLookup: points, selectedProjectId: rows[0]?.project_id });
  const before = JSON.parse(JSON.stringify({
    markers: model.markers,
    selectedProjectId: model.selectedProjectId,
    counts: model.counts,
    unmapped: model.unmapped,
  }));
  assert.ok(Object.isFrozen(model));
  assert.ok(Object.isFrozen(model.markers));

  const accounting = accountingFromModel(model, rows);
  const { positions, radius } = landMapMarkerPositions(model);
  const overlap = computeMarkerOverlap(positions, radius);
  evaluateLandMapDensitySummary({ accounting, overlap });

  const after = JSON.parse(JSON.stringify({
    markers: model.markers,
    selectedProjectId: model.selectedProjectId,
    counts: model.counts,
    unmapped: model.unmapped,
  }));
  assert.deepEqual(after, before, "measuring density must be read-only over the canonical model");
});

test("marker positions match the exact cx/cy the browse Map canvas actually renders", () => {
  const rows = (landDefault.projects || []).slice(0, 8);
  const model = buildLandMapModel({ rows, pointLookup: points });
  const svg = landMapCanvasSvg(model, {});
  const rendered = new Map();
  for (const match of svg.matchAll(/data-land-map-project="([^"]+)"[^>]*cx="([-\d.]+)" cy="([-\d.]+)"/g)) {
    rendered.set(match[1], { x: Number(match[2]), y: Number(match[3]) });
  }
  const { positions } = landMapMarkerPositions(model);
  assert.ok(positions.length > 0);
  for (const position of positions) {
    const paint = rendered.get(position.projectId);
    assert.ok(paint, `${position.projectId} must be rendered in the canvas`);
    assert.ok(Math.abs(paint.x - position.x) < 0.01, `${position.projectId} x drift`);
    assert.ok(Math.abs(paint.y - position.y) < 0.01, `${position.projectId} y drift`);
  }
});

test("the committed LM-16 receipt is a valid, current, reproducible stop receipt", () => {
  const receipt = JSON.parse(read("docs", "evidence", "land-map-density-measurement.json"));
  assert.equal(validateLandMapDensityReceipt(receipt).ok, true);
  assert.equal(receipt.outcome, "stop");
  assert.equal(
    receipt.marker_accounting.mapped_count + receipt.marker_accounting.unmapped_count,
    receipt.marker_accounting.total_count,
  );
  for (const id of receipt.overlap_measurement?.affected_marker_ids || []) {
    assert.ok(receipt.marker_accounting.mapped_ids.includes(id), `${id} must be a real mapped marker id`);
  }
  // The committed artifact is derived, not hand-typed: rebuilding it now must match byte for byte.
  assert.deepEqual(buildDensityReceipt(), receipt);
});
