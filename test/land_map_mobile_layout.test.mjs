/**
 * Land Map on a narrow screen: the same population orientation, and a way out, before
 * the canvas asks for a marker.
 *
 *   node --test test/land_map_mobile_layout.test.mjs
 *
 * LM-07 proved a marker pairs with a focusable summary; LM-09 proved the boundary context.
 * Neither guarantees a resident scrolling a tall canvas on a phone can still see the total,
 * the unmapped count, or a way back to the List without scrolling past it first. This pins
 * the fix: the orientation strip -- counts, unmappedness, and an unconditional List link --
 * reads before the canvas, on every model and at every width, because CSS reflow changes
 * arrangement, not membership, and this content has to be first in the DOM to read first on
 * a phone that never zooms out far enough to see two things at once.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { buildLandMapModel } from "../site/land_map_model.mjs";
import { filterLandSnapshot } from "../site/resident_snapshot_queries.mjs";
import {
  landMapListHandoff,
  landMapOrientationHTML,
  landMapPanelHTML,
} from "../site/app/map_runtime.mjs";

const ROOT = dirname(fileURLToPath(import.meta.url));
const read = (...parts) => readFileSync(join(ROOT, "..", ...parts), "utf8");

const landDefault = JSON.parse(read("site", "data", "land_default_ulurp.json"));
const points = JSON.parse(read("site", "data", "land_project_map_points.json"));

const en = new Function(
  "window",
  read("site", "i18n.js") + "\nreturn window.STRINGS.en;",
)({ LANG: "en", LANG_META: { en: { intlDate: "en-US" } } });

function t(key, values = {}) {
  const template = en[key];
  assert.ok(template, `${key} has no English string`);
  return String(template).replace(/\{(\w+)\}/g, (whole, name) =>
    Object.prototype.hasOwnProperty.call(values, name) ? String(values[name]) : whole);
}

const DEFAULT_FILTER = Object.freeze({ status: "active", stage: "any", limit: 40 });
/** A 25-lot rezoning: on the map, and emphatically not at an address. */
const ANCHOR_SPECIMEN = "2025K0305";
/** A project with no published point at all -- reachable only through the List. */
const UNMAPPED_SPECIMEN = "2025M0252";

const rowsFor = (overrides = {}) =>
  filterLandSnapshot(landDefault.projects, { ...DEFAULT_FILTER, ...overrides });

const modelFor = (selectedProjectId, overrides = {}) => buildLandMapModel({
  rows: rowsFor(overrides),
  pointLookup: points,
  selectedProjectId,
  filters: { ...DEFAULT_FILTER, ...overrides },
});

const panelFor = (selectedProjectId, currentHash = "#land") =>
  landMapPanelHTML(modelFor(selectedProjectId), { t, sourceVintage: points.schema, currentHash });

test("the default 40-row corpus keeps its documented mapped/unmapped split", () => {
  const model = modelFor(null);
  assert.equal(model.counts.total, 40);
  assert.equal(model.counts.mapped, 33);
  assert.equal(model.counts.unmapped, 7);
  const rows = rowsFor();
  assert.ok(rows.some((row) => row.project_id === ANCHOR_SPECIMEN), "anchor specimen left the corpus");
  assert.ok(rows.some((row) => row.project_id === UNMAPPED_SPECIMEN), "unmapped specimen left the corpus");
  assert.ok(
    !model.markers.some((marker) => marker.projectId === UNMAPPED_SPECIMEN),
    "the unmapped specimen minted a marker it has no point for",
  );
});

test("orientation -- counts and the List exit -- reads before the canvas, every time", () => {
  for (const selected of [null, ANCHOR_SPECIMEN]) {
    const html = panelFor(selected);
    const orientation = html.indexOf('class="land-map-orientation"');
    const canvas = html.indexOf('class="land-map-canvas"');
    const summary = html.indexOf('id="land-map-summary"');
    const listLink = html.indexOf('data-land-map-list-handoff=""');
    assert.ok(orientation > -1 && canvas > -1 && summary > -1 && listLink > -1, html);
    assert.ok(orientation < canvas, "orientation was not first");
    assert.ok(summary < canvas, "the population summary moved behind the canvas");
    assert.ok(listLink < canvas, "the unconditional List exit moved behind the canvas");
  }
});

test("the List exit is a real route, not only a script hook", () => {
  const html = landMapOrientationHTML(modelFor(null), { t, currentHash: "#land?boro=Queens" });
  assert.match(html, /<a class="land-map-list-link act mini" href="#land\?boro=Queens"/);
  assert.match(html, /data-land-map-list-handoff="">/);
  assert.ok(html.includes(t("land_map_back_to_list")), "the List link carries no accessible name");
});

test("a Map request stays out of the List link's own route", () => {
  // The link this card adds always names the List destination, even while the resident is
  // looking at Map -- naming the current view would be a link to nowhere.
  const html = landMapOrientationHTML(modelFor(null), { t, currentHash: "#land?view=map" });
  assert.match(html, /href="#land"/);
});

test("counts and the List exit survive an empty filtered population", () => {
  const empty = buildLandMapModel({ rows: [], pointLookup: points, selectedProjectId: null });
  const html = landMapOrientationHTML(empty, { t, currentHash: "#land" });
  assert.match(html, /land-map-summary/);
  assert.match(html, /data-land-map-list-handoff=""/);
  assert.ok(!html.includes('class="land-map-unmapped"'), "an empty population has nothing unmapped to report");
});

test("the unconditional handoff clears presentation without naming a row", () => {
  const calls = [];
  const priorSetLandView = globalThis.setLandView;
  const priorFocusListProject = globalThis.landFocusListProject;
  globalThis.setLandView = (view) => calls.push(view);
  globalThis.landFocusListProject = () => {
    throw new Error("the generic List exit must not try to focus a row");
  };
  try {
    const result = landMapListHandoff("");
    assert.deepEqual(calls, ["list"]);
    assert.equal(result, false, "an id-less handoff reported focusing a row");
  } finally {
    globalThis.setLandView = priorSetLandView;
    globalThis.landFocusListProject = priorFocusListProject;
  }
});

test("orientation never displaces the selected-project summary", () => {
  const html = panelFor(ANCHOR_SPECIMEN);
  const listLink = html.indexOf('data-land-map-list-handoff=""');
  const selected = html.indexOf('id="land-map-selected"');
  assert.ok(listLink > -1 && selected > -1);
  assert.ok(listLink < selected, "the generic List exit displaced the selected project's own summary");
});
