// LM-18: the Land Map viewport feasibility gate. Pan/zoom stays reversible
// presentation state (A1); a candidate viewport action ships only when it
// reuses already-loaded rows or compiles to a reviewed canonical Land filter
// (A2); nothing here can add a second search, live GIS, a geocoder, or a
// publisher request, or hide an unloaded/unmapped row (A3); and every
// decision carries a full evidence-contract receipt (A4).

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import {
  LAND_CANONICAL_FILTER_KEYS,
  LAND_VIEWPORT_FEASIBILITY_SCHEMA,
  LAND_VIEWPORT_NEGATIVE_RULES,
  LAND_VIEWPORT_REQUEST_KINDS,
  LAND_VIEWPORT_STOP_REASONS,
  buildLandViewportFeasibilityReceipt,
  evaluateLandViewportFeasibility,
  validateLandViewportFeasibilityReceipt,
} from "../site/land_viewport_feasibility_gate.mjs";
import { LAND_PRESENTATION_STATE_KEYS } from "../site/land_view_state.mjs";
import { SITE_SOURCE } from "./helpers/site_source.mjs";

const LOADED = {
  totalIds: ["A1", "A2", "A3", "A4"],
  mappedIds: ["A1", "A2"],
  unmappedIds: ["A3", "A4"],
};

test("canonical filter keys are exactly filterLandSnapshot's own parameter names", () => {
  const filterLandSnapshotSource = readFileSync(
    new URL("../site/resident_snapshot_queries.mjs", import.meta.url),
    "utf8",
  );
  const start = filterLandSnapshotSource.indexOf("export function filterLandSnapshot(");
  const end = filterLandSnapshotSource.indexOf("\nexport function", start + 1);
  const body = filterLandSnapshotSource.slice(start, end < 0 ? undefined : end);
  for (const key of LAND_CANONICAL_FILTER_KEYS) {
    assert.match(body, new RegExp(`\\b${key}\\s*(=|,|\\})`), `${key} must still be a filterLandSnapshot option`);
  }
  // Disjoint from presentation state: a viewport action can never compile to `view`.
  for (const key of LAND_PRESENTATION_STATE_KEYS) {
    assert.ok(!LAND_CANONICAL_FILTER_KEYS.includes(key), `${key} must never become a canonical Land filter key`);
  }
});

test("land.mjs defines exactly one landSearch function", () => {
  assert.equal((SITE_SOURCE.match(/\basync function landSearch\(/g) || []).length, 1);
});

test("the project-detail pan-control installer issues no request of any kind", () => {
  const start = SITE_SOURCE.indexOf("function wireLandPanControls(");
  assert.ok(start >= 0, "wireLandPanControls must exist in the shipped site bundle");
  const body = SITE_SOURCE.slice(start, SITE_SOURCE.indexOf("\n}", start));
  for (const forbidden of ["fetch(", "landSearch(", "geocode", "XMLHttpRequest", "filterLandSnapshot("]) {
    assert.ok(!body.includes(forbidden), `wireLandPanControls must not reference ${forbidden}`);
  }
  assert.match(body, /\.panBy\(/, "pan stays a Leaflet viewport move, not a data operation");
});

test("loaded rows ship without any new request", () => {
  const decision = evaluateLandViewportFeasibility({
    requestedKind: LAND_VIEWPORT_REQUEST_KINDS.LOADED_ROWS,
    loadedModel: LOADED,
    requestSequence: [],
  });
  assert.equal(decision.outcome, "ship");
  assert.deepEqual(decision.accounting.mapped, ["A1", "A2"]);
  assert.deepEqual(decision.accounting.unmapped, ["A3", "A4"]);
});

test("loaded rows still ship when the one canonical search is the only request made", () => {
  const decision = evaluateLandViewportFeasibility({
    requestedKind: LAND_VIEWPORT_REQUEST_KINDS.LOADED_ROWS,
    loadedModel: LOADED,
    requestSequence: [{ kind: "canonical_search", name: "landSearch" }],
  });
  assert.equal(decision.outcome, "ship");
});

test("a reviewed compilation to canonical filter keys ships", () => {
  const decision = evaluateLandViewportFeasibility({
    requestedKind: LAND_VIEWPORT_REQUEST_KINDS.CANONICAL_FILTER_COMPILATION,
    compiledFilterKeys: ["borough", "stage"],
    reviewed: true,
    loadedModel: LOADED,
  });
  assert.equal(decision.outcome, "ship");
  assert.deepEqual(decision.compiled_filter_keys, ["borough", "stage"]);
});

test("an unreviewed compilation to otherwise-valid filter keys stops — this is the P0 default", () => {
  const decision = evaluateLandViewportFeasibility({
    requestedKind: LAND_VIEWPORT_REQUEST_KINDS.CANONICAL_FILTER_COMPILATION,
    compiledFilterKeys: ["borough"],
    reviewed: false,
    loadedModel: LOADED,
  });
  assert.equal(decision.outcome, "stop");
  assert.equal(decision.reason, LAND_VIEWPORT_STOP_REASONS.UNREVIEWED_COMPILATION);
});

test("a compilation naming a noncanonical key (e.g. a bounds/viewport key) stops even if reviewed", () => {
  const decision = evaluateLandViewportFeasibility({
    requestedKind: LAND_VIEWPORT_REQUEST_KINDS.CANONICAL_FILTER_COMPILATION,
    compiledFilterKeys: ["borough", "viewportBounds"],
    reviewed: true,
    loadedModel: LOADED,
  });
  assert.equal(decision.outcome, "stop");
  assert.equal(decision.reason, LAND_VIEWPORT_STOP_REASONS.NONCANONICAL_FILTER_KEY);
  assert.deepEqual(decision.noncanonical_keys, ["viewportBounds"]);
});

test("a new bounds query, live GIS request, geocode request, and publisher request all stop by kind alone", () => {
  const cases = [
    [LAND_VIEWPORT_REQUEST_KINDS.NEW_BOUNDS_QUERY, LAND_VIEWPORT_STOP_REASONS.NEW_SEARCH_REQUEST],
    [LAND_VIEWPORT_REQUEST_KINDS.LIVE_GIS_REQUEST, LAND_VIEWPORT_STOP_REASONS.LIVE_GIS_REQUEST],
    [LAND_VIEWPORT_REQUEST_KINDS.GEOCODE_REQUEST, LAND_VIEWPORT_STOP_REASONS.GEOCODE_REQUEST],
    [LAND_VIEWPORT_REQUEST_KINDS.PUBLISHER_REQUEST, LAND_VIEWPORT_STOP_REASONS.PUBLISHER_REQUEST],
  ];
  for (const [requestedKind, reason] of cases) {
    const decision = evaluateLandViewportFeasibility({ requestedKind, loadedModel: LOADED });
    assert.equal(decision.outcome, "stop");
    assert.equal(decision.reason, reason);
  }
});

test("an unrecognized request kind stops as unknown, never as an implicit ship", () => {
  const decision = evaluateLandViewportFeasibility({ requestedKind: "resident_drew_a_polygon", loadedModel: LOADED });
  assert.equal(decision.outcome, "stop");
  assert.equal(decision.reason, LAND_VIEWPORT_STOP_REASONS.UNKNOWN_REQUEST_KIND);
});

test("a second search function in the request sequence stops as a detected second search", () => {
  const decision = evaluateLandViewportFeasibility({
    requestedKind: LAND_VIEWPORT_REQUEST_KINDS.LOADED_ROWS,
    loadedModel: LOADED,
    requestSequence: [
      { kind: "canonical_search", name: "landSearch" },
      { kind: "canonical_search", name: "applyLandMapFilters" },
    ],
  });
  assert.equal(decision.outcome, "stop");
  assert.equal(decision.reason, LAND_VIEWPORT_STOP_REASONS.SECOND_SEARCH_DETECTED);
});

test("an unnamed or unrecognized request-sequence entry stops rather than silently passing", () => {
  const decision = evaluateLandViewportFeasibility({
    requestedKind: LAND_VIEWPORT_REQUEST_KINDS.LOADED_ROWS,
    loadedModel: LOADED,
    requestSequence: [{ kind: "mystery_request" }],
  });
  assert.equal(decision.outcome, "stop");
  assert.equal(decision.reason, LAND_VIEWPORT_STOP_REASONS.SECOND_SEARCH_DETECTED);
});

test("a project missing from both mapped and unmapped ids is a hidden-row accounting mismatch", () => {
  const decision = evaluateLandViewportFeasibility({
    requestedKind: LAND_VIEWPORT_REQUEST_KINDS.LOADED_ROWS,
    loadedModel: { totalIds: ["A1", "A2", "A3"], mappedIds: ["A1"], unmappedIds: ["A2"] },
  });
  assert.equal(decision.outcome, "stop");
  assert.equal(decision.reason, LAND_VIEWPORT_STOP_REASONS.LOADED_ROW_ACCOUNTING_MISMATCH);
});

test("a project double-counted in both mapped and unmapped ids is also a mismatch", () => {
  const decision = evaluateLandViewportFeasibility({
    requestedKind: LAND_VIEWPORT_REQUEST_KINDS.LOADED_ROWS,
    loadedModel: { totalIds: ["A1", "A2"], mappedIds: ["A1", "A2"], unmappedIds: ["A2"] },
  });
  assert.equal(decision.outcome, "stop");
  assert.equal(decision.reason, LAND_VIEWPORT_STOP_REASONS.LOADED_ROW_ACCOUNTING_MISMATCH);
});

test("an all-unmapped population still reconciles and may ship", () => {
  const decision = evaluateLandViewportFeasibility({
    requestedKind: LAND_VIEWPORT_REQUEST_KINDS.LOADED_ROWS,
    loadedModel: { totalIds: ["A1", "A2"], mappedIds: [], unmappedIds: ["A1", "A2"] },
  });
  assert.equal(decision.outcome, "ship");
});

test("negative-rule ledger matches the card's negative rule bullets one for one", () => {
  assert.deepEqual([...LAND_VIEWPORT_NEGATIVE_RULES].sort(), [
    "add_viewport_to_watches",
    "change_land_search_semantics_from_map_code",
    "fetch_live_gis",
    "geocode_visible_areas",
    "hide_unloaded_or_unmapped_rows",
    "label_pan_zoom_as_canonical_land_scope_without_review",
    "query_projects_by_viewport",
  ]);
});

test("a stop receipt carries the full evidence contract", () => {
  const decision = evaluateLandViewportFeasibility({ requestedKind: LAND_VIEWPORT_REQUEST_KINDS.NEW_BOUNDS_QUERY, loadedModel: LOADED });
  const receipt = buildLandViewportFeasibilityReceipt({
    viewport: { center: [40.7, -73.9], zoom: 12 },
    loadedModel: LOADED,
    decision,
    requestSequence: [],
    sourceVintages: { land_default_ulurp: "site/data/land_default_ulurp.json" },
  });
  assert.equal(receipt.schema, LAND_VIEWPORT_FEASIBILITY_SCHEMA);
  assert.equal(receipt.outcome, "stop");
  assert.equal(receipt.stop_reason, LAND_VIEWPORT_STOP_REASONS.NEW_SEARCH_REQUEST);
  assert.deepEqual(receipt.loaded_model.unmapped_ids, ["A3", "A4"]);
  assert.equal(receipt.loaded_model.accounting_reconciled, true);
  assert.ok(receipt.viewport);
  assert.ok(Object.keys(receipt.source_vintages).length > 0);
  assert.equal(validateLandViewportFeasibilityReceipt(receipt).ok, true);
});

test("a ship receipt carries no stop reason", () => {
  const decision = evaluateLandViewportFeasibility({
    requestedKind: LAND_VIEWPORT_REQUEST_KINDS.LOADED_ROWS,
    loadedModel: LOADED,
  });
  const receipt = buildLandViewportFeasibilityReceipt({ loadedModel: LOADED, decision });
  assert.equal(receipt.outcome, "ship");
  assert.equal(receipt.stop_reason, null);
  assert.equal(validateLandViewportFeasibilityReceipt(receipt).ok, true);
});

test("the committed LM-18 receipt is a valid, current stop receipt", () => {
  const receipt = JSON.parse(readFileSync("docs/evidence/land-map-viewport-feasibility.json", "utf8"));
  assert.equal(validateLandViewportFeasibilityReceipt(receipt).ok, true);
  assert.equal(receipt.outcome, "stop");
  assert.equal(receipt.canonical_filter_compilation.compiled_filter_keys.length, 0);
  assert.equal(
    receipt.loaded_model.mapped_count + receipt.loaded_model.unmapped_count,
    receipt.loaded_model.total_count,
  );
});
