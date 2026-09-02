/**
 * The Land Map marker join: markers are a rendering of rows the List already filtered,
 * never a second database of places.
 *
 *   node --test test/land_map_marker_join.test.mjs
 *
 * Three things separate a marker layer from a map that merely has dots on it, and each one
 * is pinned here:
 *
 *   - membership: a marker exists because a filtered Land row exists. The point projection
 *     holds 29 places, but a narrower filter must never paint the ones it excluded, and a
 *     point key with no row behind it must never mint a project.
 *   - identity: a marker leads to the same canonical project route a List card leads to.
 *     Two ways in, one project.
 *   - honesty: the map shows fewer projects than the List holds, so all three counts travel
 *     together, and a marker says how it was placed. An anchor for a 25-lot rezoning and the
 *     centre of a single lot are both "on the map"; only the label keeps them from reading
 *     as the same claim.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  LAND_MAP_ACCEPTED_POINT_METHODS,
  LAND_MAP_UNMAPPED_REASONS,
  buildLandMapModel,
} from "../site/land_map_model.mjs";
import { KNOWN_LAND_POINT_PRECISIONS } from "../site/land_project_geography.mjs";
import { landProjectPath } from "../site/land_project_route.mjs";
import { filterLandSnapshot } from "../site/resident_snapshot_queries.mjs";
import {
  landMapMarkerLayer,
  landMapPanelHTML,
  landMarkerDetailHref,
} from "../site/app/map_runtime.mjs";

const ROOT = dirname(fileURLToPath(import.meta.url));
const read = (...parts) => readFileSync(join(ROOT, "..", ...parts), "utf8");

const runtimeSrc = read("site", "app", "map_runtime.mjs");
const landDefault = JSON.parse(read("site", "data", "land_default_ulurp.json"));
const points = JSON.parse(read("site", "data", "land_project_map_points.json"));

const en = new Function(
  "window",
  read("site", "i18n.js") + "\nreturn window.STRINGS.en;",
)({ LANG: "en", LANG_META: { en: { intlDate: "en-US" } } });

/** The app's own copy seam, resolved against the real English dictionary. */
function t(key, values = {}) {
  const template = en[key];
  assert.ok(template, `${key} has no English string`);
  return String(template).replace(/\{(\w+)\}/g, (whole, name) =>
    Object.prototype.hasOwnProperty.call(values, name) ? String(values[name]) : whole);
}

const DEFAULT_FILTER = Object.freeze({ status: "active", stage: "any", limit: 40 });
const MAPPED_SPECIMEN = "2025K0305";
const UNMAPPED_SPECIMEN = "2026K0123";
// A point the projection knows and the filtered rows do not. It is the whole "the map is not
// a search" question in one id: it has a perfectly good coordinate and still may not appear.
const POINT_ONLY_ID = "2099Z9999";

const rowsFor = (overrides = {}) =>
  filterLandSnapshot(landDefault.projects, { ...DEFAULT_FILTER, ...overrides });

const pointsWithOrphan = () => ({
  schema: points.schema,
  points: {
    ...points.points,
    [POINT_ONLY_ID]: { lat: 40.71, lon: -74.0, method: "publisher_point", precision: "exact", bbl_count: 0 },
  },
});

const modelFor = (overrides = {}, pointLookup = pointsWithOrphan()) =>
  buildLandMapModel({ rows: rowsFor(overrides), pointLookup, filters: { ...DEFAULT_FILTER, ...overrides } });

const layerFor = (model) => landMapMarkerLayer(model, { t, sourceVintage: points.schema });
const htmlFor = (model) => landMapPanelHTML(model, { t, sourceVintage: points.schema });

const attr = (html, name) => [...html.matchAll(new RegExp(`${name}="([^"]*)"`, "g"))].map((m) => m[1]);

/* ===== A1: one marker per mapped row, on the route List already uses ===== */

test("A1 every mapped filtered row becomes exactly one marker on the canonical Land route", () => {
  const model = modelFor();
  const layer = layerFor(model);

  assert.equal(layer.length, model.counts.mapped);
  assert.deepEqual(layer.map((m) => m.projectId), model.markers.map((m) => m.projectId),
    "the layer renders the model's markers in the model's order");
  assert.equal(new Set(layer.map((m) => m.projectId)).size, layer.length, "no project is marked twice");

  const listIds = new Set(rowsFor().map((row) => row.project_id));
  for (const marker of layer) {
    assert.ok(listIds.has(marker.projectId), `${marker.projectId} is not a filtered Land row`);
    // The identity a List card links to, produced by the same canonical route builder.
    assert.equal(marker.href, landProjectPath(marker.projectId));
    assert.match(marker.href, /^\/browse\/zoning\/#land\//);
    assert.ok(Number.isFinite(marker.lat) && Number.isFinite(marker.lon));
    assert.ok(marker.title, "a marker always has a display name to announce");
  }
});

test("A1 the evidence contract travels on every marker", () => {
  for (const marker of layerFor(modelFor())) {
    assert.equal(typeof marker.projectId, "string");
    assert.ok(marker.projectId.length);
    assert.equal(typeof marker.title, "string");
    assert.ok(Number.isFinite(marker.lat) && Number.isFinite(marker.lon));
    assert.ok(LAND_MAP_ACCEPTED_POINT_METHODS.includes(marker.method), `${marker.method} is not an accepted method`);
    assert.ok(Object.values(KNOWN_LAND_POINT_PRECISIONS).includes(marker.precision));
    // Inherited from the projection the shell fetched, never minted here.
    assert.equal(marker.sourceVintage, points.schema);
    assert.ok(marker.href);
  }
  // And the vintage the layer inherited is on the painted map, so what a resident sees can
  // be traced back to the exact projection it came from.
  assert.ok(htmlFor(modelFor()).includes(`data-land-map-source-vintage="${points.schema}"`));
});

test("A1 the painted map carries one linked marker per mapped row and links nowhere else", () => {
  const model = modelFor();
  const html = htmlFor(model);

  assert.equal([...html.matchAll(/class="land-map-marker"/g)].length, model.counts.mapped);
  assert.equal([...html.matchAll(/class="land-map-marker-link"/g)].length, model.counts.mapped);

  const hrefs = attr(html, "href");
  assert.equal(hrefs.length, model.counts.mapped);
  const listIds = new Set(rowsFor().map((row) => row.project_id));
  for (const href of hrefs) {
    const id = decodeURIComponent(String(href.split("#land/")[1] || ""));
    assert.ok(listIds.has(id), `${href} does not lead to a filtered Land row`);
    assert.equal(href, landProjectPath(id));
  }
  assert.ok(hrefs.includes(landProjectPath(MAPPED_SPECIMEN)), "the specimen marker reaches its project detail");
});

/* ===== A2: the map's count and the List's count are both told ===== */

test("A2 default Map reports 40 total, 29 mapped and 11 unmapped, consistently", () => {
  const model = modelFor();
  assert.deepEqual({ ...model.counts }, { total: 40, mapped: 29, unmapped: 11 });
  assert.equal(model.counts.mapped + model.counts.unmapped, model.counts.total);

  const html = htmlFor(model);
  assert.equal(attr(html, "data-land-map-total")[0], "40");
  assert.equal(attr(html, "data-land-map-mapped")[0], "29");
  assert.equal(attr(html, "data-land-map-unmapped")[0], "11");

  // The failure this card exists to prevent: the marker count standing in for the total.
  const markers = [...html.matchAll(/class="land-map-marker"/g)].length;
  assert.equal(markers, 29);
  assert.notEqual(markers, model.counts.total);
  assert.ok(html.includes(t("land_map_unmapped_note", { n: 11 })), "the 11 unmapped rows are stated, not implied");
});

test("A2 the unmapped specimen keeps its identity in the count and never reaches the canvas", () => {
  const model = modelFor();
  const unmapped = model.unmapped.find((item) => item.projectId === UNMAPPED_SPECIMEN);
  assert.ok(unmapped, "the specimen is an explicit unmapped identity");
  assert.equal(unmapped.reason, LAND_MAP_UNMAPPED_REASONS.POINT_ABSENT);
  assert.ok(unmapped.row, "it keeps its Land row, so the List handoff stays actionable");

  const html = htmlFor(model);
  assert.equal(layerFor(model).some((m) => m.projectId === UNMAPPED_SPECIMEN), false);
  assert.equal(html.includes(UNMAPPED_SPECIMEN), false, "an unplaced project is never drawn");
  assert.equal(html.includes(landProjectPath(UNMAPPED_SPECIMEN)), false);
});

/* ===== A3: a marker says how it was placed ===== */

test("A3 marker labels name the placement method and its precision", () => {
  const layer = layerFor(modelFor());
  const specimen = layer.find((m) => m.projectId === MAPPED_SPECIMEN);
  assert.ok(specimen);
  assert.equal(specimen.method, "multi_bbl_anchor");
  assert.equal(specimen.precision, KNOWN_LAND_POINT_PRECISIONS.ANCHOR);
  assert.equal(specimen.bblCount, 25);

  assert.ok(specimen.label.includes(specimen.title), "the label names the project");
  assert.ok(specimen.label.includes(t("land_map_method_multi_bbl_anchor", { n: 25 })),
    "the label names the method, with the lot count it was anchored across");
  assert.ok(specimen.label.includes(t("land_map_precision_anchor")), "the label names the precision");
  assert.ok(specimen.label.includes("25"), "a 25-lot anchor says 25");
});

test("A3 anchor and representative markers never claim an exact address", () => {
  const exact = t("land_map_precision_exact");
  for (const precision of ["anchor", "representative"]) {
    const copy = t(`land_map_precision_${precision}`);
    assert.notEqual(copy, exact);
    assert.match(copy, /not an exact address/,
      `${precision} precision must not read as an exact location`);
  }
  // The distinction survives into the rendered map, not just the record.
  const html = htmlFor(modelFor());
  const precisions = new Set(attr(html, "data-land-map-precision"));
  assert.ok(precisions.has("anchor"), "multi-lot anchors stay labelled as anchors");
  assert.ok(precisions.has("exact"), "single-lot centroids keep their own precision");
  const methods = new Set(attr(html, "data-land-map-method"));
  assert.deepEqual([...methods].sort(), ["multi_bbl_anchor", "single_bbl_centroid"],
    "the rendered methods are exactly the ones the projection published");
});

test("A3 every accepted method and precision has resident-facing English copy", () => {
  for (const method of LAND_MAP_ACCEPTED_POINT_METHODS) {
    const copy = t(`land_map_method_${method}`, { n: 2 });
    assert.ok(copy.trim().length, `${method} has no label`);
    assert.equal(copy.includes("{"), false, `${method} label left a placeholder unfilled`);
    // No control-plane or schema vocabulary on a resident-facing surface.
    assert.doesNotMatch(copy, /bbl|centroid|geometry|projection|schema/i, `${method} label leaks source jargon`);
  }
  for (const precision of Object.values(KNOWN_LAND_POINT_PRECISIONS)) {
    assert.ok(t(`land_map_precision_${precision}`).trim().length, `${precision} has no label`);
  }
  assert.ok(t("land_map_marker_label", { title: "T", method: "M", precision: "P" }).includes("T"));
});

/* ===== A4: what the marker layer must refuse to be ===== */

test("A4 a point the projection knows but the filter excluded never becomes a marker", () => {
  const model = modelFor();
  assert.ok(pointsWithOrphan().points[POINT_ONLY_ID], "the orphan point really is in the projection");
  assert.equal(layerFor(model).some((m) => m.projectId === POINT_ONLY_ID), false);
  assert.equal(htmlFor(model).includes(POINT_ONLY_ID), false);
});

test("A4 a Queens filter paints a subset of the filtered rows, not of the projection", () => {
  const queensRows = rowsFor({ borough: "Queens" });
  assert.ok(queensRows.length > 0 && queensRows.length < 40, "the borough filter really narrows the population");
  const model = modelFor({ borough: "Queens" });
  const layer = layerFor(model);

  const queensIds = new Set(queensRows.map((row) => row.project_id));
  for (const marker of layer) assert.ok(queensIds.has(marker.projectId), `${marker.projectId} is outside the filter`);
  assert.ok(layer.length < 29, "a narrower filter paints fewer markers than the whole projection");
  assert.equal(model.counts.total, queensRows.length, "the total follows the List, not the projection");
  assert.equal(model.counts.mapped + model.counts.unmapped, model.counts.total);

  // Every marker in the wider view that this filter dropped is genuinely gone.
  const dropped = layerFor(modelFor()).filter((m) => !queensIds.has(m.projectId));
  const html = htmlFor(model);
  for (const marker of dropped) assert.equal(html.includes(marker.projectId), false);
});

test("A4 unmapped rows are never given a coordinate", () => {
  const model = modelFor();
  const layer = layerFor(model);
  const placed = new Set(layer.map((m) => m.projectId));
  for (const item of model.unmapped) {
    assert.equal(placed.has(item.projectId), false);
    assert.equal("lat" in item, false);
    assert.equal("lon" in item, false);
  }
  // A centre-of-the-city fallback is the classic invented coordinate; no marker sits on one.
  for (const marker of layer) {
    assert.ok(marker.lat !== 0 && marker.lon !== 0);
    assert.equal(marker.lat === 40.71 && marker.lon === -74.0, false, "no marker fell back to a default centre");
  }
  assert.equal(layer.length, model.counts.mapped);
});

test("A4 the marker layer adds no choropleth, no search, and no fetch of its own", () => {
  const region = runtimeSrc.slice(runtimeSrc.indexOf("landMapMarkerLayer"));
  assert.doesNotMatch(region, /\bfetch\s*\(/, "the marker layer fetches nothing beyond the route-lazy projection");
  assert.doesNotMatch(region, /landSearch|runSearch|applyLandMapFilters|searchLand/,
    "activating a marker must never start a new search");
  // A choropleth would need a per-area value scale and a filled area per project.
  assert.doesNotMatch(region, /choropleth|colorScale|colourScale|quantile|fillOpacity/i);
  const html = htmlFor(modelFor());
  assert.equal([...html.matchAll(/<path /g)].length, [...html.matchAll(/class="land-map-outline"/g)].length,
    "the only filled shapes are the schematic borough outlines");
  assert.doesNotMatch(html, /data-land-map-value|land-map-choropleth/);

  // The whole projection is only ever reached through the shell's one committed URL.
  assert.equal([...runtimeSrc.matchAll(/fetch\s*\(/g)].length, 1);
  assert.match(runtimeSrc, /fetch\(LAND_MAP_POINTS_URL/);
});

test("A4 an id the canonical route rejects gets a point but never a link", () => {
  const model = buildLandMapModel({
    rows: [{ project_id: "not a project id", project_name: "Malformed" }],
    pointLookup: { schema: points.schema, points: { "not a project id": { lat: 40.7, lon: -74, method: "publisher_point", precision: "exact" } } },
  });
  assert.equal(model.counts.mapped, 1);
  const marker = layerFor(model)[0];
  assert.equal(landMarkerDetailHref("not a project id"), null);
  assert.equal(marker.href, null, "a route that does not exist is not offered");
  const html = htmlFor(model);
  assert.equal(html.includes("land-map-marker-link"), false);
  assert.match(html, /class="land-map-marker"/, "the point it really has is still drawn");
});

/* ===== The capture receipt names what was shown, at the sizes it was shown at ===== */

test("A4 the marker-join receipt reports the before/after states it captured", () => {
  const receipt = JSON.parse(read("docs", "evidence", "land-map-marker-join.json"));
  assert.equal(receipt.schema, "cityscroll.land-map-marker-join-receipt.v1");
  assert.equal(receipt.card, "cityscroll-land-map-view/lm-06-marker-join");
  assert.match(receipt.browser_mode, /headless chromium/);
  assert.deepEqual(receipt.viewports, [[390, 844], [1440, 900]]);
  assert.equal(receipt.routes.default_map, "/browse/zoning/?view=map");
  assert.equal(receipt.routes.filtered_map, "/browse/zoning/?boro=Queens&view=map");
  assert.match(receipt.revision.before_commit, /^[0-9a-f]{40}$/);

  for (const [width] of receipt.viewports) {
    const after = receipt.after[`default-map@${width}`];
    assert.ok(after, `no default-map capture at ${width}px`);
    assert.deepEqual(after.counts_published, { total: 40, mapped: 29, unmapped: 11 });
    assert.equal(after.markers, 29);
    // Every marker painted is a marker a resident can follow.
    assert.equal(after.marker_links, after.markers);
    assert.equal(after.methods_published, after.markers);
    assert.equal(after.unmapped_drawn, false);
    assert.ok(after.unmapped_note.includes("11"), "the capture shows the unmapped count on screen");
    assert.ok(after.specimen_href.includes(`#land/${MAPPED_SPECIMEN}`));
    assert.match(after.specimen_label, /not an exact address/);
    assert.ok(after.screenshot.startsWith("docs/screenshots/land-map-marker-join/"));

    // The before tree is what makes the pair evidence rather than assertion: markers that
    // led nowhere, no method, and a panel that reported no counts at all.
    const before = receipt.before[`default-map@${width}`];
    assert.equal(before.counts_published, null);
    assert.equal(before.marker_links, 0);
    assert.equal(before.methods_published, 0);
    assert.ok(before.list_rows > 0, "the before List did hold rows the map did not show");
  }

  // The filtered pair is the subset proof at both sizes.
  for (const [width] of receipt.viewports) {
    const filtered = receipt.after[`filtered-map@${width}`];
    assert.ok(filtered.counts_published.total < 40);
    assert.ok(filtered.counts_published.mapped < 29, "a filtered map painted the whole projection");
    assert.equal(
      filtered.counts_published.mapped + filtered.counts_published.unmapped,
      filtered.counts_published.total,
    );
    assert.equal(filtered.markers, filtered.counts_published.mapped);
  }
});
