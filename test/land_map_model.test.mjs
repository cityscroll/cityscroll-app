/**
 * Pure Land Map projection over filtered result rows.
 *
 *   node --test test/land_map_model.test.mjs
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import {
  KNOWN_LAND_POINT_METHODS,
  KNOWN_LAND_POINT_PRECISIONS,
  REJECTED_KNOWN_LAND_POINT_METHODS,
} from "../site/land_project_geography.mjs";
import {
  LAND_MAP_ACCEPTED_POINT_METHODS,
  LAND_MAP_MODEL_SCHEMA,
  LAND_MAP_UNMAPPED_REASONS,
  buildLandMapModel,
  indexLandMapPoints,
} from "../site/land_map_model.mjs";
import { LAND_PROJECT_MAP_POINT_SPECIMENS } from "../site/land_project_map_points.mjs";
import { filterLandSnapshot } from "../site/resident_snapshot_queries.mjs";
import {
  LAND_FAMILY_OPTIONS,
  LAND_FUTURE_ACTION_OPTIONS,
  LAND_STAGE_OPTIONS,
} from "../site/land_status_facets.mjs";
import { LAND_PROCEDURE_OPTIONS } from "../site/land_procedure_facet.mjs";
import { LAND_REGULATORY_EFFECT_OPTIONS } from "../site/land_regulatory_effect.mjs";

const modelSrc = readFileSync(new URL("../site/land_map_model.mjs", import.meta.url), "utf8");
const landDefault = JSON.parse(
  readFileSync(new URL("../site/data/land_default_ulurp.json", import.meta.url), "utf8"),
);
const pointArtifact = JSON.parse(
  readFileSync(new URL("../site/data/land_project_map_points.json", import.meta.url), "utf8"),
);
const hearings = JSON.parse(
  readFileSync(new URL("../site/data/land_upcoming_hearings.json", import.meta.url), "utf8"),
);

const ACTION_ROWS = Array.isArray(hearings.hearings) ? hearings.hearings : [];
const DEFAULT_FILTER = Object.freeze({ status: "active", stage: "any", limit: 40 });
const EXTRA_POINT_ID = "2099Z9999";

function defaultRows(overrides = {}) {
  return filterLandSnapshot(landDefault.projects, { ...DEFAULT_FILTER, ...overrides });
}

function pointLookupWithExtra(extraId = EXTRA_POINT_ID) {
  return {
    schema: pointArtifact.schema,
    points: {
      ...pointArtifact.points,
      [extraId]: {
        lat: 40.71,
        lon: -74.0,
        method: KNOWN_LAND_POINT_METHODS.PUBLISHER_POINT,
        precision: KNOWN_LAND_POINT_PRECISIONS.EXACT,
        bbl_count: 0,
      },
    },
  };
}

function idsOf(rows) {
  const seen = new Set();
  const ids = [];
  for (const row of rows) {
    const id = String(row?.project_id ?? "").trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }
  return ids;
}

function assertParity(rows, model) {
  const listIds = idsOf(rows);
  const mappedIds = model.mapped.map((item) => item.projectId);
  const markerIds = model.markers.map((item) => item.projectId);
  const unmappedIds = model.unmapped.map((item) => item.projectId);
  assert.deepEqual(markerIds, mappedIds);
  assert.deepEqual([...mappedIds, ...unmappedIds].sort(), [...listIds].sort());
  assert.equal(mappedIds.length + unmappedIds.length, listIds.length);
  assert.equal(model.counts.total, listIds.length);
  assert.equal(model.counts.mapped, mappedIds.length);
  assert.equal(model.counts.unmapped, unmappedIds.length);
  assert.equal(new Set(mappedIds).size, mappedIds.length);
  assert.equal(new Set(unmappedIds).size, unmappedIds.length);
  const mappedSet = new Set(mappedIds);
  for (const id of unmappedIds) assert.equal(mappedSet.has(id), false);
  const relativeMapped = listIds.filter((id) => mappedSet.has(id));
  const relativeUnmapped = listIds.filter((id) => !mappedSet.has(id));
  assert.deepEqual(mappedIds, relativeMapped);
  assert.deepEqual(unmappedIds, relativeUnmapped);
  assert.equal(model.markers.some((item) => item.projectId === extraPointId(model)), false);
}

function extraPointId() {
  return EXTRA_POINT_ID;
}

function assertNoMutation(row, before) {
  assert.deepEqual({ ...row }, before);
  assert.equal("point" in row, false);
  assert.equal("reason" in row, false);
  assert.equal("_mapped" in row, false);
}

test("A1 default filtered Land rows keep the forty-project population", () => {
  const rows = defaultRows();
  assert.equal(rows.length, 40);
  assert.equal(landDefault.projects.length, 40);
  const frozen = rows.map((row) => {
    const copy = { ...row };
    Object.freeze(copy);
    return copy;
  });
  const snapshots = frozen.map((row) => ({ ...row }));
  const model = buildLandMapModel({
    rows: frozen,
    pointLookup: pointLookupWithExtra(),
    selectedProjectId: LAND_PROJECT_MAP_POINT_SPECIMENS.multi_bbl,
    filters: DEFAULT_FILTER,
  });
  assert.equal(model.schema, LAND_MAP_MODEL_SCHEMA);
  assert.equal(model.counts.total, 40);
  assert.equal(model.counts.mapped, 33);
  assert.equal(model.counts.unmapped, 7);
  assertParity(frozen, model);
  const marker = model.markers.find((item) => item.projectId === "2025K0305");
  assert.ok(marker);
  assert.equal(marker.method, KNOWN_LAND_POINT_METHODS.MULTI_BBL_ANCHOR);
  assert.equal(marker.precision, KNOWN_LAND_POINT_PRECISIONS.ANCHOR);
  assert.equal(Number.isFinite(marker.lat), true);
  assert.equal(Number.isFinite(marker.lon), true);
  assert.equal(marker.selected, true);
  const unmapped = model.unmapped.find((item) => item.projectId === "2025M0252");
  assert.ok(unmapped);
  assert.equal(unmapped.reason, LAND_MAP_UNMAPPED_REASONS.POINT_ABSENT);
  assert.equal(model.markers.some((item) => item.projectId === "2025M0252"), false);
  assert.equal(model.markers.some((item) => item.projectId === EXTRA_POINT_ID), false);
  assert.equal(model.unmapped.some((item) => item.projectId === EXTRA_POINT_ID), false);
  assert.equal(model.selectedProjectId, "2025K0305");
  assert.equal(model.selectedRow, frozen.find((row) => row.project_id === "2025K0305"));
  assert.equal(model.selectedMarker.projectId, "2025K0305");
  assert.ok(model.bounds);
  assert.equal(model.bounds.minLat <= model.bounds.maxLat, true);
  assert.equal(model.bounds.minLon <= model.bounds.maxLon, true);
  assert.deepEqual(model.filters, DEFAULT_FILTER);
  frozen.forEach((row, index) => assertNoMutation(row, snapshots[index]));
});

test("A3 borough and keyword-plus-stage fixtures keep List/Map set equality", () => {
  const boroughRows = defaultRows({ borough: "Brooklyn" });
  assert.equal(boroughRows.length < 40, true);
  assert.equal(boroughRows.some((row) => row.project_id === "2025K0305"), true);
  assert.equal(boroughRows.some((row) => row.project_id === "2020K0444"), true);
  const boroughModel = buildLandMapModel({
    rows: boroughRows,
    pointLookup: pointLookupWithExtra(),
  });
  assertParity(boroughRows, boroughModel);
  assert.equal(
    boroughModel.markers.some((item) => item.projectId === "2025K0305"),
    true,
  );
  assert.equal(
    boroughModel.unmapped.some((item) => item.projectId === "2020K0444"),
    true,
  );

  const keywordStageRows = defaultRows({
    keyword: "Westshore",
    stage: "pre_certification",
  });
  assert.deepEqual(keywordStageRows.map((row) => row.project_id), ["2025K0305"]);
  const keywordModel = buildLandMapModel({
    rows: keywordStageRows,
    pointLookup: pointLookupWithExtra(),
  });
  assertParity(keywordStageRows, keywordModel);
  assert.equal(keywordModel.counts.mapped, 1);
  assert.equal(keywordModel.counts.unmapped, 0);
  assert.equal(keywordModel.markers[0].projectId, "2025K0305");
});

test("empty results stay empty without inventing point-only projects", () => {
  const model = buildLandMapModel({
    rows: [],
    pointLookup: pointLookupWithExtra(),
    selectedProjectId: "2025K0305",
  });
  assert.deepEqual(model.mapped, []);
  assert.deepEqual(model.unmapped, []);
  assert.deepEqual(model.markers, []);
  assert.equal(model.bounds, null);
  assert.deepEqual(model.counts, { total: 0, mapped: 0, unmapped: 0 });
  assert.equal(model.selectedProjectId, null);
  assert.equal(model.selectedRow, null);
  assert.equal(model.selectedMarker, null);
});

test("stable order follows filtered rows and does not sort by project id", () => {
  const rows = defaultRows();
  const reversed = [...rows].reverse();
  const forward = buildLandMapModel({ rows, pointLookup: pointArtifact });
  const backward = buildLandMapModel({ rows: reversed, pointLookup: pointArtifact });
  assert.notDeepEqual(
    forward.markers.map((item) => item.projectId),
    [...forward.markers.map((item) => item.projectId)].sort(),
  );
  assert.deepEqual(
    backward.markers.map((item) => item.projectId),
    [...forward.markers.map((item) => item.projectId)].reverse(),
  );
  assert.deepEqual(
    backward.unmapped.map((item) => item.projectId),
    [...forward.unmapped.map((item) => item.projectId)].reverse(),
  );
});

test("A4 extra point keys, duplicate joins, and duplicate lookup keys never mint rows", () => {
  const first = defaultRows()[0];
  const duplicateRows = [first, { ...first }, first];
  const duplicatePoints = [
    { project_id: first.project_id, lat: 40.71, lon: -74.01, method: KNOWN_LAND_POINT_METHODS.PUBLISHER_POINT },
    { project_id: first.project_id, lat: 40.8, lon: -73.9, method: KNOWN_LAND_POINT_METHODS.PROPERTY_COORDINATE },
    { project_id: EXTRA_POINT_ID, lat: 40.72, lon: -74.0, method: KNOWN_LAND_POINT_METHODS.PUBLISHER_POINT },
  ];
  const model = buildLandMapModel({
    rows: duplicateRows,
    pointLookup: duplicatePoints,
  });
  assert.equal(model.counts.total, 1);
  assert.equal(model.markers.length, 1);
  assert.equal(model.markers[0].projectId, first.project_id);
  assert.equal(model.markers[0].lat, 40.71);
  assert.equal(model.markers[0].method, KNOWN_LAND_POINT_METHODS.PUBLISHER_POINT);
  assert.equal(model.markers.some((item) => item.projectId === EXTRA_POINT_ID), false);
  const indexed = indexLandMapPoints(duplicatePoints);
  assert.equal(indexed.size, 2);
  assert.equal(indexed.get(first.project_id).lat, 40.71);
});

test("missing, rejected, and invalid points stay unmapped with a reason", () => {
  const rows = [
    { project_id: "ABSENT", project_name: "Absent" },
    { project_id: "GEOCODE", project_name: "Geocode" },
    { project_id: "RANGE", project_name: "Range" },
    { project_id: "EMPTY", project_name: "Empty" },
    { project_id: "", project_name: "No id" },
  ];
  const model = buildLandMapModel({
    rows,
    pointLookup: {
      GEOCODE: { method: "address_geocode", lat: 40.71, lon: -73.96 },
      RANGE: { method: KNOWN_LAND_POINT_METHODS.PUBLISHER_POINT, lat: 41.5, lon: -73.9 },
      EMPTY: {},
    },
  });
  assert.equal(model.counts.total, 4);
  assert.equal(model.counts.mapped, 0);
  assert.deepEqual(
    model.unmapped.map((item) => [item.projectId, item.reason]),
    [
      ["ABSENT", LAND_MAP_UNMAPPED_REASONS.POINT_ABSENT],
      ["GEOCODE", LAND_MAP_UNMAPPED_REASONS.ADDRESS_GEOCODE_REJECTED],
      ["RANGE", LAND_MAP_UNMAPPED_REASONS.INVALID_RANGE],
      ["EMPTY", LAND_MAP_UNMAPPED_REASONS.NO_ACCEPTED_POINT],
    ],
  );
});

test("every accepted point method can join a filtered row", () => {
  const rows = LAND_MAP_ACCEPTED_POINT_METHODS.map((method, index) => ({
    project_id: `M${index}`,
    project_name: method,
  }));
  const points = Object.fromEntries(LAND_MAP_ACCEPTED_POINT_METHODS.map((method, index) => [
    `M${index}`,
    {
      lat: 40.65 + index * 0.01,
      lon: -74.05 + index * 0.01,
      method,
      precision: method === KNOWN_LAND_POINT_METHODS.MULTI_BBL_ANCHOR
        ? KNOWN_LAND_POINT_PRECISIONS.ANCHOR
        : method === KNOWN_LAND_POINT_METHODS.PROPERTY_COORDINATE
          || method === KNOWN_LAND_POINT_METHODS.GEOMETRY_REPRESENTATIVE_POINT
          ? KNOWN_LAND_POINT_PRECISIONS.REPRESENTATIVE
          : KNOWN_LAND_POINT_PRECISIONS.EXACT,
      bbl_count: method.includes("bbl") ? (method.startsWith("multi") ? 3 : 1) : 0,
    },
  ]));
  const model = buildLandMapModel({ rows, pointLookup: points });
  assert.equal(model.counts.mapped, LAND_MAP_ACCEPTED_POINT_METHODS.length);
  assert.deepEqual(model.markers.map((item) => item.method), LAND_MAP_ACCEPTED_POINT_METHODS);
  for (const method of REJECTED_KNOWN_LAND_POINT_METHODS) {
    const rejected = buildLandMapModel({
      rows: [{ project_id: "R1", project_name: method }],
      pointLookup: { R1: { method, lat: 40.71, lon: -73.96 } },
    });
    assert.equal(rejected.counts.mapped, 0);
    assert.equal(rejected.unmapped[0].reason.includes("point") || rejected.unmapped[0].reason.length > 0, true);
    assert.equal(rejected.markers.length, 0);
  }
});

test("selected row is nullable and never follows a point-only id", () => {
  const rows = defaultRows();
  const missing = buildLandMapModel({
    rows,
    pointLookup: pointLookupWithExtra(),
    selectedProjectId: EXTRA_POINT_ID,
  });
  assert.equal(missing.selectedProjectId, null);
  assert.equal(missing.selectedRow, null);
  assert.equal(missing.selectedMarker, null);

  const blank = buildLandMapModel({
    rows,
    pointLookup: pointArtifact,
    selectedProjectId: "",
  });
  assert.equal(blank.selectedProjectId, null);

  const unmapped = buildLandMapModel({
    rows,
    pointLookup: pointArtifact,
    selectedProjectId: "2025M0252",
  });
  assert.equal(unmapped.selectedProjectId, null);
  assert.equal(unmapped.selectedMarker, null);
  assert.equal(unmapped.selectedRow.project_id, "2025M0252");
  assert.equal(unmapped.markers.every((item) => item.selected === false), true);
});

test("A3 every existing Land filter dimension preserves List/Map id equality", () => {
  const lookup = pointLookupWithExtra();
  const boroughs = [...new Set(landDefault.projects.map((row) => row.borough).filter(Boolean))];
  const districts = [...new Set(landDefault.projects.map((row) => row.community_district).filter(Boolean))];
  const fixtures = [
    ...LAND_STAGE_OPTIONS.map((option) => ({ label: `stage:${option.id}`, opts: { stage: option.id, status: "all" } })),
    ...LAND_FUTURE_ACTION_OPTIONS.map((option) => ({
      label: `future:${option.id}`,
      opts: { futureAction: option.id, status: "all", actionRows: ACTION_ROWS, today: "2026-08-31" },
    })),
    ...LAND_PROCEDURE_OPTIONS.map((option) => ({ label: `procedure:${option.id}`, opts: { procedure: option.id, status: "all" } })),
    ...LAND_FAMILY_OPTIONS.map((option) => ({ label: `family:${option.id}`, opts: { family: option.id, status: "all" } })),
    ...LAND_REGULATORY_EFFECT_OPTIONS.map((option) => ({
      label: `effect:${option.id}`,
      opts: { regulatoryEffect: option.id, status: "all" },
    })),
    ...boroughs.map((borough) => ({ label: `borough:${borough}`, opts: { borough, status: "all", stage: "any" } })),
    ...districts.map((communityDistrict) => ({
      label: `cd:${communityDistrict}`,
      opts: { communityDistrict, status: "all", stage: "any" },
    })),
    { label: "keyword", opts: { keyword: "Rezoning", status: "all", stage: "any" } },
    { label: "council", opts: { councilDistrict: "33", status: "all", stage: "any" } },
    { label: "projectIds", opts: { projectIds: ["2025K0305", "2025M0252", EXTRA_POINT_ID], status: "all", stage: "any" } },
    { label: "status:active", opts: { status: "active" } },
    { label: "status:all", opts: { status: "all" } },
    { label: "status:hearings", opts: { status: "hearings", actionRows: ACTION_ROWS, today: "2026-08-31" } },
  ];
  assert.equal(fixtures.length > 20, true);
  for (const fixture of fixtures) {
    const rows = filterLandSnapshot(landDefault.projects, { limit: 40, ...fixture.opts });
    const model = buildLandMapModel({
      rows,
      pointLookup: lookup,
      filters: fixture.opts,
    });
    assertParity(rows, model);
    assert.equal(model.markers.some((item) => item.projectId === EXTRA_POINT_ID), false);
  }
});

test("LM-17 a single-BBL exact marker carries its committed parcel shape", () => {
  const rows = filterLandSnapshot(landDefault.projects, { limit: 40, status: "all", stage: "any" });
  const model = buildLandMapModel({ rows, pointLookup: pointArtifact });
  const marker = model.markers.find((item) => item.projectId === LAND_PROJECT_MAP_POINT_SPECIMENS.single_bbl);
  assert.ok(marker, "single-BBL specimen must still be a marker");
  assert.ok(marker.geometry, "single-BBL specimen should carry the committed shape");
  assert.equal(marker.geometry.method, "single_bbl_parcel_polygon");
  assert.equal(marker.geometry.precision, "tax_lot_boundary");
  assert.ok(Array.isArray(marker.geometry.rings?.[0]));
});

test("LM-17 a multi-BBL anchor marker never carries a shape", () => {
  const rows = filterLandSnapshot(landDefault.projects, { limit: 40, status: "all", stage: "any" });
  const model = buildLandMapModel({ rows, pointLookup: pointArtifact });
  const marker = model.markers.find((item) => item.projectId === LAND_PROJECT_MAP_POINT_SPECIMENS.multi_bbl);
  assert.ok(marker, "multi-BBL specimen must still be a marker");
  assert.equal(marker.geometry, null);
});

test("LM-17 a malformed shape on a point degrades to no shape, never a broken render", () => {
  const rows = filterLandSnapshot(landDefault.projects, {
    limit: 40,
    projectIds: [LAND_PROJECT_MAP_POINT_SPECIMENS.single_bbl],
    status: "all",
    stage: "any",
  });
  const tampered = {
    ...pointArtifact,
    points: {
      ...pointArtifact.points,
      [LAND_PROJECT_MAP_POINT_SPECIMENS.single_bbl]: {
        ...pointArtifact.points[LAND_PROJECT_MAP_POINT_SPECIMENS.single_bbl],
        shape: { rings: [[[0, 0], [1, 0]]] }, // open, too-short ring
      },
    },
  };
  const model = buildLandMapModel({ rows, pointLookup: tampered });
  const marker = model.markers.find((item) => item.projectId === LAND_PROJECT_MAP_POINT_SPECIMENS.single_bbl);
  assert.ok(marker, "the point itself must still resolve");
  assert.equal(marker.geometry, null, "an invalid shape must not reach the marker");
});

test("A2/A4 model source has no filter engine, fetch, viewport search, or map-only limit", () => {
  assert.equal(/applyLandMapFilters/.test(modelSrc), false);
  assert.equal(/applyLandFilters/.test(modelSrc), false);
  assert.equal(/filterLandSnapshot/.test(modelSrc), false);
  assert.equal(/landSearch\s*\(/.test(modelSrc), false);
  assert.equal(/\bfetch\s*\(/.test(modelSrc), false);
  assert.equal(/XMLHttpRequest/.test(modelSrc), false);
  assert.equal(/viewport|getBounds|fitBounds|bbox/i.test(modelSrc), false);
  assert.equal(/map-only|mapOnly|MAP_LIMIT|slice\(\s*0\s*,/.test(modelSrc), false);
  assert.equal(/https?:\/\//.test(modelSrc), false);
  assert.equal(/from ["'].*app\/land\.mjs["']/.test(modelSrc), false);
  assert.equal(/from ["'].*map_exploration\.mjs["']/.test(modelSrc), false);
  assert.equal(/soda|arcgis|leaflet|unpkg/i.test(modelSrc), false);
  assert.equal(modelSrc.includes("exact_project_id"), true);
});
