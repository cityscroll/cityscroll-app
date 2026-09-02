/**
 * Land Map marker selection: one identity, held in memory, checked against the filtered rows.
 *
 *   node --test test/land_map_marker_selection.test.mjs
 *
 * LM-06 proved a marker is a rendering of a filtered row. Selection is the seam where that
 * claim is easiest to lose, so the three ways it is normally lost are pinned here:
 *
 *   - a selection that is not a row. A project id the current filter does not hold must not
 *     become a selected marker, a summary, or a record reconstructed from a point.
 *   - a selection that says more than the point knows. A 25-lot anchor and a single-lot
 *     centre are both "selected"; only the summary's own words keep them apart.
 *   - a selection that is two things at once. Exactly one active marker, and the detail route
 *     it offers is the same canonical route the List card offers -- never a second address
 *     for the same project.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { buildLandMapModel } from "../site/land_map_model.mjs";
import {
  LAND_MAP_SELECTION_HISTORY_KEY,
  landMapSelectionFocusIntent,
  landSelectionFromHistoryState,
  landSelectionHistoryPatch,
  nextLandMapSelection,
} from "../site/land_map_selection.mjs";
import { landProjectPath } from "../site/land_project_route.mjs";
import { filterLandSnapshot } from "../site/resident_snapshot_queries.mjs";
import {
  landMapMarkerLayer,
  landMapPanelHTML,
  landMapSelectionHTML,
  landMarkerDetailHref,
} from "../site/app/map_runtime.mjs";

const ROOT = dirname(fileURLToPath(import.meta.url));
const read = (...parts) => readFileSync(join(ROOT, "..", ...parts), "utf8");

const landDefault = JSON.parse(read("site", "data", "land_default_ulurp.json"));
const points = JSON.parse(read("site", "data", "land_project_map_points.json"));
const runtimeSrc = read("site", "app", "map_runtime.mjs");
const routingSrc = read("site", "app", "routing.mjs");
const selectionSrc = read("site", "land_map_selection.mjs");
const viewStateSrc = read("site", "land_view_state.mjs");

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
/** A project with no published point at all. Reachable through the List, never through a marker. */
const UNMAPPED_SPECIMEN = "2026K0123";
/** A point the projection knows and no filtered row claims. */
const POINT_ONLY_ID = "2099Z9999";

const pointsWithOrphan = () => ({
  schema: points.schema,
  points: {
    ...points.points,
    [POINT_ONLY_ID]: { lat: 40.71, lon: -74.0, method: "publisher_point", precision: "exact", bbl_count: 0 },
  },
});

const rowsFor = (overrides = {}) =>
  filterLandSnapshot(landDefault.projects, { ...DEFAULT_FILTER, ...overrides });

const modelFor = (selectedProjectId, overrides = {}) => buildLandMapModel({
  rows: rowsFor(overrides),
  pointLookup: pointsWithOrphan(),
  selectedProjectId,
  filters: { ...DEFAULT_FILTER, ...overrides },
});

const panelFor = (selectedProjectId, overrides = {}) =>
  landMapPanelHTML(modelFor(selectedProjectId, overrides), { t, sourceVintage: points.schema });

/** The single-lot centroid the default filter happens to hold, whichever it is. */
function exactSpecimen() {
  const model = modelFor(null);
  const marker = model.markers.find((item) => item.precision === "exact");
  assert.ok(marker, "the default filter holds no exact single-lot point to compare against");
  return marker.projectId;
}

test("a selected marker is the filtered row, not a second lookup", () => {
  const model = modelFor(ANCHOR_SPECIMEN);
  assert.equal(model.selectedProjectId, ANCHOR_SPECIMEN);
  // The selected row is the row object the filter produced -- the same identity the List
  // renders, not a copy assembled from the point projection.
  const row = rowsFor().find((item) => item.project_id === ANCHOR_SPECIMEN);
  assert.ok(row, "the default filter no longer holds the specimen");
  assert.equal(model.selectedRow.project_id, row.project_id);
  assert.equal(model.selectedRow.project_name, row.project_name);
  assert.equal(model.selectedMarker.projectId, ANCHOR_SPECIMEN);
});

test("selection does not change the filtered population", () => {
  const unselected = modelFor(null);
  const selected = modelFor(ANCHOR_SPECIMEN);
  assert.deepEqual(selected.counts, unselected.counts);
  assert.equal(selected.markers.length, unselected.markers.length);
  assert.deepEqual(
    selected.markers.map((m) => m.projectId),
    unselected.markers.map((m) => m.projectId),
    "selecting a project reordered or re-filtered the map",
  );
});

test("exactly one marker is active, and duplicate activation adds none", () => {
  const model = modelFor(ANCHOR_SPECIMEN);
  const active = model.markers.filter((marker) => marker.selected);
  assert.equal(active.length, 1, "more than one marker claimed to be selected");
  assert.equal(active[0].projectId, ANCHOR_SPECIMEN);

  // Selecting the same id again is the same state, not a second one.
  const again = modelFor(ANCHOR_SPECIMEN);
  assert.equal(again.markers.filter((marker) => marker.selected).length, 1);

  const html = panelFor(ANCHOR_SPECIMEN);
  assert.equal((html.match(/aria-current="true"/g) || []).length, 1);
  assert.equal((html.match(/id="land-map-selected"/g) || []).length, 1);
});

test("the selected detail action is the canonical List route and nothing else", () => {
  const selection = landMapSelectionHTML(modelFor(ANCHOR_SPECIMEN), { t, sourceVintage: points.schema });
  const href = landMarkerDetailHref(ANCHOR_SPECIMEN);
  assert.equal(href, landProjectPath(ANCHOR_SPECIMEN));
  assert.ok(selection.includes(`href="${href}"`), "the summary does not offer the canonical route");
  // One project, one address. A selection must never mint a second way to name it.
  const routes = [...selection.matchAll(/#land\/([A-Za-z0-9_-]+)/g)].map((match) => match[1]);
  assert.deepEqual([...new Set(routes)], [ANCHOR_SPECIMEN], `selection linked to ${routes}`);
  // Every marker offers the same canonical route it did before selection existed, so the
  // summary's link and the marker's own identity can never name different projects.
  const layer = landMapMarkerLayer(modelFor(ANCHOR_SPECIMEN), { t });
  for (const marker of layer) assert.equal(marker.href, landProjectPath(marker.projectId));
});

test("a filtered-out project cannot be selected, and is never resurrected", () => {
  // Queens holds no Brooklyn specimen. The id is remembered by the caller; the model refuses.
  const narrowed = modelFor(ANCHOR_SPECIMEN, { borough: "Queens" });
  assert.equal(narrowed.selectedProjectId, null, "a filtered-out project stayed selected");
  assert.equal(narrowed.selectedMarker, null);
  assert.equal(narrowed.markers.filter((marker) => marker.selected).length, 0);
  assert.equal(landMapSelectionHTML(narrowed, { t, sourceVintage: points.schema }), "");
  // And the refusal costs the population nothing.
  const unselected = modelFor(null, { borough: "Queens" });
  assert.deepEqual(narrowed.counts, unselected.counts);
  assert.ok(narrowed.counts.total > 0, "the borough filter emptied the result set");
});

test("a point with no filtered row behind it cannot become a selection", () => {
  const model = modelFor(POINT_ONLY_ID);
  assert.equal(model.selectedProjectId, null, "a point artifact minted a selected project");
  assert.equal(model.selectedRow, null);
  assert.ok(!panelFor(POINT_ONLY_ID).includes(POINT_ONLY_ID));
});

test("a stale or malformed remembered id is refused, not repaired", () => {
  for (const stale of ["2099Z9998", "not a project id", "../../etc/passwd", "", "   ", null, undefined]) {
    const model = modelFor(stale);
    assert.equal(model.selectedProjectId, null, `${JSON.stringify(stale)} produced a selection`);
    assert.equal(landMapSelectionHTML(model, { t }), "");
  }
});

test("an unmapped project has no marker to select", () => {
  const model = modelFor(UNMAPPED_SPECIMEN);
  assert.ok(
    model.unmapped.some((item) => item.projectId === UNMAPPED_SPECIMEN),
    "the specimen is no longer an unmapped row",
  );
  // It stays in the result set and in the count; it simply has no point to activate.
  assert.equal(model.selectedMarker, null);
  assert.equal(model.selectedProjectId, null);
  assert.equal(landMapSelectionHTML(model, { t }), "", "an unplaced project was given a map summary");
});

test("the summary keeps method, precision and source vintage, and calls an anchor an anchor", () => {
  const html = panelFor(ANCHOR_SPECIMEN);
  assert.ok(html.includes('data-land-map-method="multi_bbl_anchor"'));
  assert.ok(html.includes('data-land-map-precision="anchor"'));
  assert.ok(html.includes(`data-land-map-source-vintage="${points.schema}"`),
    "the selection dropped the projection vintage it was placed from");
  assert.ok(html.includes(t("land_map_method_multi_bbl_anchor", { n: 25 })), "the 25-lot anchor lost its count");
  assert.ok(html.includes(t("land_map_precision_anchor")));
  assert.ok(/not an exact address/.test(html), "a multi-lot anchor did not disclaim exactness");

  const exactId = exactSpecimen();
  const exactHtml = panelFor(exactId);
  assert.ok(exactHtml.includes('data-land-map-precision="exact"'));
  const selection = landMapSelectionHTML(modelFor(exactId), { t, sourceVintage: points.schema });
  assert.ok(!/not an exact address/.test(selection), `an exact point was hedged: ${selection}`);
  assert.ok(selection.includes(t("land_map_precision_exact")));
});

test("the summary states the row's own status and never invents one", () => {
  const row = rowsFor().find((item) => item.project_id === ANCHOR_SPECIMEN);
  const status = String(row.public_status ?? row.project_status ?? "").trim();
  const html = panelFor(ANCHOR_SPECIMEN);
  if (status) assert.ok(html.includes(status), "the summary dropped the row's status");

  const statusless = buildLandMapModel({
    rows: [{ project_id: ANCHOR_SPECIMEN, project_name: "Anchor specimen" }],
    pointLookup: points,
    selectedProjectId: ANCHOR_SPECIMEN,
  });
  const bare = landMapSelectionHTML(statusless, { t });
  assert.ok(bare.includes("Anchor specimen"));
  assert.ok(!bare.includes("land-map-selected-status"), "a row with no status was given one anyway");
});

test("the summary is a summary, not a second copy of the project record", () => {
  const html = landMapSelectionHTML(modelFor(ANCHOR_SPECIMEN), { t, sourceVintage: points.schema });
  const row = rowsFor().find((item) => item.project_id === ANCHOR_SPECIMEN);
  // The dossier fields belong to the detail route, which is one link away.
  for (const field of ["project_brief", "current_milestone", "primary_applicant"]) {
    const value = String(row?.[field] ?? "").trim();
    if (value.length > 12) {
      assert.ok(!html.includes(value), `the map summary repeated the project's ${field}`);
    }
  }
});

test("population orientation is read before the selection, never after it", () => {
  const html = panelFor(ANCHOR_SPECIMEN);
  const counts = html.indexOf('id="land-map-summary"');
  const selected = html.indexOf('id="land-map-selected"');
  assert.ok(counts > -1 && selected > -1);
  assert.ok(counts < selected, "the selected project displaced the filtered-population summary");
  // And the selection is not permanent furniture.
  assert.ok(!panelFor(null).includes('id="land-map-selected"'));
});

test("markers are operable without a pointer", () => {
  const html = panelFor(ANCHOR_SPECIMEN);
  assert.ok(html.includes('role="button"'), "markers carry no activation role");
  assert.ok(html.includes('tabindex="0"'), "markers are not in the tab order");
  assert.ok(/aria-label="[^"]+"/.test(html), "a marker has no accessible name");
  // The keyboard path is wired explicitly, not inherited from the pointer.
  assert.match(runtimeSrc, /addEventListener\("keydown"/);
  assert.match(runtimeSrc, /event\.key!=="Enter" && event\.key!==" "/);
  // And focus is never allowed to fall out of the panel on a repaint.
  assert.match(runtimeSrc, /restoreLandMapFocus/);
});

test("selection stays out of shareable route and watch scope", () => {
  // The presentation keys the Land route may carry are still exactly one: the view.
  assert.match(viewStateSrc, /LAND_PRESENTATION_STATE_KEYS = Object\.freeze\(\[LAND_VIEW_PARAM\]\)/);
  // Nothing in the route serializer learned a selection parameter.
  assert.ok(!/["']selected["']\s*[,:)]/.test(viewStateSrc), "the view state grew a selection key");
  // Query-shaped, so an ordinary `.map(marker=>...)` is not mistaken for a route parameter.
  for (const source of [routingSrc, selectionSrc, runtimeSrc]) {
    for (const forbidden of ["selectedProject", "selected_project", "selection", "marker", "viewport", "bbox"]) {
      const asParameter = new RegExp(`[?&"'\`]${forbidden}=`, "i");
      assert.ok(!asParameter.test(source), `a selection parameter reached the route: ${forbidden}=`);
    }
  }
  // It is remembered on the history entry instead, which is not shareable, and the key that
  // carries it is a history key rather than a route key.
  assert.equal(LAND_MAP_SELECTION_HISTORY_KEY, "landSelection");
  assert.deepEqual(landSelectionHistoryPatch("2025K0305"), { landSelection: "2025K0305" });
  assert.deepEqual(landSelectionHistoryPatch(null), { landSelection: null });
  // The route module itself is untouched by selection: it neither reads nor writes one.
  assert.ok(!routingSrc.includes("landSelection"), "the route serializer learned about selection");
});

test("a remembered id is read from the history entry, and only when it is a project id", () => {
  const entry = (value) => ({ cityscrollRoute: { landSelection: value } });
  assert.equal(landSelectionFromHistoryState(entry("2025K0305")), "2025K0305");
  assert.equal(landSelectionFromHistoryState(entry("  2025K0305  ")), "2025K0305");
  for (const junk of ["not a project id", "../../etc/passwd", "", "  ", null, undefined, 42, {}]) {
    assert.equal(landSelectionFromHistoryState(entry(junk)), null, `${JSON.stringify(junk)} was accepted`);
  }
  // A history entry that never carried one, or is not an entry at all.
  for (const absent of [null, undefined, {}, [], "string", { cityscrollRoute: null }]) {
    assert.equal(landSelectionFromHistoryState(absent), null);
  }
});

test("a paint decides membership only when it had rows to decide with", () => {
  const requested = "2025K0305";
  // The filter still holds it: kept.
  assert.equal(nextLandMapSelection({ requested, painted: requested, population: 40 }), requested);
  // The filter dropped it: forgotten, so widening the filter cannot bring it back selected.
  assert.equal(nextLandMapSelection({ requested, painted: "", population: 40 }), null);
  assert.equal(nextLandMapSelection({ requested, painted: "2024Q0325", population: 34 }), null);
  // No rows behind the paint -- the cold Map load on the way back from a project detail --
  // is not a verdict, and must not lose the selection the resident is returning to.
  for (const population of [0, "0", null, undefined, NaN, -1]) {
    assert.equal(nextLandMapSelection({ requested, painted: "", population }), requested,
      `a paint over ${JSON.stringify(population)} rows was treated as a refusal`);
  }
  assert.equal(nextLandMapSelection({ requested: "", painted: "", population: 40 }), null);
});

test("focus intent names a control, and never nothing", () => {
  assert.deepEqual(landMapSelectionFocusIntent({ projectId: "2025K0305" }),
    { kind: "selection", projectId: "2025K0305" });
  assert.deepEqual(landMapSelectionFocusIntent({ projectId: "2025K0305", kind: "marker" }),
    { kind: "marker", projectId: "2025K0305" });
  // A cleared selection still has somewhere to put focus: the panel, never the document root.
  for (const empty of [null, undefined, "", "   "]) {
    assert.deepEqual(landMapSelectionFocusIntent({ projectId: empty }), { kind: "panel" });
  }
  assert.deepEqual(landMapSelectionFocusIntent(), { kind: "panel" });
});

test("activating a marker cannot reach the network", () => {
  // The runtime fetches exactly one thing, and it is the committed projection LM-06 named.
  const fetches = [...runtimeSrc.matchAll(/fetch\(/g)];
  assert.equal(fetches.length, 1, "the map runtime grew a second fetch");
  assert.match(runtimeSrc, /fetch\(LAND_MAP_POINTS_URL/);
  // Selection reports intent to the route and paints. It never searches.
  for (const forbidden of ["landSearch", "loadLandProjectsSnapshot", "showLandEntry"]) {
    assert.ok(!runtimeSrc.includes(forbidden), `marker selection reached ${forbidden}`);
  }
});

test("the List handoff reuses List's own selection and issues no query", () => {
  const landSrc = read("site", "app", "land.mjs");
  const start = landSrc.indexOf("function landFocusListProject");
  assert.ok(start > -1, "the List handoff target is missing");
  const body = landSrc.slice(start, landSrc.indexOf("\n}", start));
  assert.match(body, /lRows\.findIndex/, "the handoff does not look in the filtered rows");
  assert.match(body, /landSelect\(index, el\)/, "the handoff does not reuse List's own selection");
  for (const forbidden of ["landSearch", "loadLandProjectsSnapshot", "fetch("]) {
    assert.ok(!body.includes(forbidden), `the List handoff reached ${forbidden}`);
  }
  // A project outside the filtered rows is reported missing, never fetched into existence.
  assert.match(body, /if\(index<0\) return false/);
});

test("the marker layer still renders one marker per mapped filtered row", () => {
  // LM-06's arithmetic is not this card's to move, selected or not.
  const model = modelFor(ANCHOR_SPECIMEN);
  const layer = landMapMarkerLayer(model, { t, sourceVintage: points.schema });
  assert.equal(layer.length, model.counts.mapped);
  assert.equal(model.counts.mapped + model.counts.unmapped, model.counts.total);
  assert.equal(new Set(layer.map((marker) => marker.projectId)).size, layer.length);
  for (const marker of layer) assert.equal(marker.sourceVintage, points.schema);
});
