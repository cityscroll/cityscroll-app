// Selected-area overlap drawer: BK1503 journey, point/area wording, focus restore.
//
//   node --test test/geography_navigation_overlap_ui.test.mjs

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import {
  GEOGRAPHY_CROSSWALK_COMMISSION_PINS,
  GEOGRAPHY_CROSSWALK_MANIFEST_PATH,
} from "../site/geography_crosswalk_artifacts.mjs";
import {
  GEOGRAPHY_NAVIGATION_AREA_OVERLAP_EXAMPLE,
  GEOGRAPHY_NAVIGATION_POINT_BUNDLES,
} from "../site/geography_navigation_capability.mjs";
import {
  OVERLAP_COMPARISON_UNAVAILABLE,
  OVERLAP_POINT_HEADING,
  RESIDENT_GEOGRAPHY_OVERLAP_SCHEMA,
  buildBk1503CouncilOverlapFixtureModel,
  buildCityHallPointOverlapFixtureModel,
  buildSelectedGeographyOverlapViewModel,
  buildSheepsheadStationOverlapFixtureModel,
  crosswalkRowsFromCommittedArtifacts,
  formatOverlapDisplayPercent,
  overlapEscapePolicy,
  rememberOverlapInvoker,
  renderSelectedGeographyOverlapDrawerHtml,
  renderGeographyOverlapWorkspaceChrome,
  restoreOverlapInvokerFocus,
  sortOverlapRows,
} from "../site/geography_navigation_overlap_ui.mjs";
import { buildNearYouViewModel, renderNearYouDocument } from "../site/near_you_view.mjs";
import { scopeFromLensState, scopeWithGeographies } from "../site/scope_v0.mjs";

const ROOT = process.cwd();
const OVERLAP_SOURCE = readFileSync(join(ROOT, "site/geography_navigation_overlap_ui.mjs"), "utf8");
const VIEW_SOURCE = readFileSync(join(ROOT, "site/near_you_view.mjs"), "utf8");
const MAP_SOURCE = readFileSync(join(ROOT, "site/app/map.mjs"), "utf8");

function readJson(relative) {
  return JSON.parse(readFileSync(join(ROOT, relative), "utf8"));
}

function loadCommittedShards() {
  const manifest = readJson(GEOGRAPHY_CROSSWALK_MANIFEST_PATH);
  const shards = Object.fromEntries(
    (manifest.shards || []).map((entry) => [entry.pair_id, readJson(entry.path)]),
  );
  return { manifest, shards };
}

function fixtureActivity() {
  return {
    boundary_vintage: "2026-05-26",
    built_at: "2026-05-26T00:00:00.000Z",
    records: {
      meetings: {
        "m-1": {
          id: "m-1",
          title: "Fixture meeting",
          date: "2026-06-01",
          route: "/notices/m-1",
          agency: "Transportation",
        },
      },
    },
    by_level: { borough: { Brooklyn: { meetings: 1 } } },
    district_items: {
      citywide: { meetings: [] },
      virtual: { meetings: [] },
      unlocated: { meetings: [] },
    },
    geography_items: {
      definitions: {
        "geography:nta2020:BK1503": {
          key: "geography:nta2020:BK1503",
          type: "nta2020",
          id: "BK1503",
          label: "Sheepshead Bay-Manhattan Beach-Gerritsen Beach",
        },
      },
      by_key: {
        "geography:nta2020:BK1503": { meetings: ["m-1"] },
      },
    },
  };
}

test("schema uses the resident geography overlap id", () => {
  assert.equal(RESIDENT_GEOGRAPHY_OVERLAP_SCHEMA, "cityscroll.resident_geography_overlap.v1");
  assert.match(OVERLAP_SOURCE, /cityscroll\.resident_geography_overlap\.v1/);
  // Reject schema ids that skip the resident qualifier between the product
  // prefix and the geography token (folded private-terms guard).
  assert.doesNotMatch(
    RESIDENT_GEOGRAPHY_OVERLAP_SCHEMA,
    /^cityscroll\.geography_/,
  );
});

test("A1: BK1503 council compare keeps selection and orders 48 then 46 with display percents", () => {
  const { manifest, shards } = loadCommittedShards();
  const loaded = crosswalkRowsFromCommittedArtifacts({
    selectedKey: GEOGRAPHY_CROSSWALK_COMMISSION_PINS.selected_key,
    compareType: "council_district",
    manifest,
    shards,
  });
  assert.equal(loaded.available, true);
  const model = buildSelectedGeographyOverlapViewModel({
    selected: GEOGRAPHY_NAVIGATION_AREA_OVERLAP_EXAMPLE.selected,
    compareType: "council_district",
    crosswalkRows: loaded.rows,
  });
  assert.equal(model.selected.key, "geography:nta2020:BK1503");
  assert.equal(model.compare_type, "council_district");
  assert.match(model.area_section.summary, /This neighborhood overlaps 2 Council districts/i);
  assert.deepEqual(
    model.area_section.rows.map((row) => [row.id, row.display_pct]),
    [["48", "69.0%"], ["46", "31.0%"]],
  );
  const html = renderSelectedGeographyOverlapDrawerHtml(model);
  assert.match(html, /data-geography-selected-key="geography:nta2020:BK1503"/);
  assert.match(html, /City Council District 48/);
  assert.match(html, /69\.0%/);
  assert.match(html, /City Council District 46/);
  assert.match(html, /31\.0%/);
});

test("A2: point uses At this location; area uses overlaps; never sole-district claim", () => {
  const model = buildSheepsheadStationOverlapFixtureModel();
  assert.equal(model.point_section.heading, OVERLAP_POINT_HEADING);
  assert.equal(model.point_section.heading, "At this location");
  assert.match(model.area_section.summary, /overlaps/i);
  assert.equal(model.area_section.rows.length, 2);
  const pointCouncil = model.point_section.lines.find((line) => line.type === "council_district");
  assert.equal(pointCouncil.id, "48");
  const html = renderSelectedGeographyOverlapDrawerHtml(model);
  assert.match(html, /At this location/);
  assert.match(html, /This neighborhood overlaps/);
  for (const banned of model.hard_negatives) {
    assert.doesNotMatch(html.toLowerCase(), new RegExp(banned.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"));
  }
  assert.doesNotMatch(html, /your district/i);
  assert.doesNotMatch(html, /sole .*district/i);
  assert.doesNotMatch(html, /the Council district for this neighborhood/i);
});

test("A3: CD13, CD18, and Precinct 60 stay out of primary list but appear in details", () => {
  const fixture = GEOGRAPHY_NAVIGATION_AREA_OVERLAP_EXAMPLE;
  const community = buildSelectedGeographyOverlapViewModel({
    selected: fixture.selected,
    compareType: "community_district",
    crosswalkRows: fixture.relations,
  });
  assert.deepEqual(community.area_section.rows.map((row) => row.id), ["K15"]);
  assert.ok(community.details.retained_immaterial.some((row) => row.id === "K13"));
  assert.ok(community.details.retained_immaterial.some((row) => row.id === "K18"));
  const precinct = buildSelectedGeographyOverlapViewModel({
    selected: fixture.selected,
    compareType: "police_precinct",
    crosswalkRows: fixture.relations,
  });
  assert.deepEqual(precinct.area_section.rows.map((row) => row.id), ["61"]);
  assert.ok(precinct.details.retained_immaterial.some((row) => row.id === "60"));
  const html = renderSelectedGeographyOverlapDrawerHtml(community);
  assert.doesNotMatch(html.split("near-geo-overlap-details")[0], /Community District 13/);
  assert.doesNotMatch(html.split("near-geo-overlap-details")[0], /Community District 18/);
  assert.match(html, /data-geography-overlap-immaterial="geography:community_district:K13"/);
  assert.match(html, /not material|below threshold/i);
});

test("A4: switching compare updates rows only; selection key unchanged", () => {
  const fixture = GEOGRAPHY_NAVIGATION_AREA_OVERLAP_EXAMPLE;
  const council = buildSelectedGeographyOverlapViewModel({
    selected: fixture.selected,
    compareType: "council_district",
    crosswalkRows: fixture.relations,
  });
  const community = buildSelectedGeographyOverlapViewModel({
    selected: fixture.selected,
    compareType: "community_district",
    crosswalkRows: fixture.relations,
  });
  const precinct = buildSelectedGeographyOverlapViewModel({
    selected: fixture.selected,
    compareType: "police_precinct",
    crosswalkRows: fixture.relations,
  });
  assert.equal(council.selected.key, community.selected.key);
  assert.equal(community.selected.key, precinct.selected.key);
  assert.notDeepEqual(
    council.area_section.rows.map((row) => row.id),
    community.area_section.rows.map((row) => row.id),
  );
  assert.equal(council.compare_controls.find((row) => row.type === "community_district").pressed, false);
  assert.equal(community.compare_controls.find((row) => row.type === "community_district").pressed, true);
});

test("A5/A6: material rows expose highlight control and a separate select link", () => {
  const model = buildBk1503CouncilOverlapFixtureModel();
  const html = renderSelectedGeographyOverlapDrawerHtml(model);
  assert.match(html, /data-geography-overlap-highlight="geography:council_district:48"/);
  assert.match(html, /data-geography-overlap-select="geography:council_district:48"/);
  assert.match(html, /Select this area/);
  const selectHref = model.area_section.rows[0].select_href;
  assert.match(selectHref, /geo=council_district%3A48|geo=council_district:48/);
  assert.doesNotMatch(selectHref, /geo=nta2020%3ABK1503/);
  // Hover/focus helpers must not be selection writers.
  assert.match(OVERLAP_SOURCE, /overlapEscapePolicy/);
  const policy = overlapEscapePolicy();
  assert.equal(policy.clears_selection, false);
  assert.equal(policy.clears_hover, true);
});

test("A7: details disclose sources, vintages, ids, exact pct, and method without raw debug dumps", () => {
  const model = buildBk1503CouncilOverlapFixtureModel();
  const html = renderSelectedGeographyOverlapDrawerHtml(model);
  assert.match(html, /Source and exact figures/);
  assert.match(html, /data-geography-detail="selected-id">BK1503</);
  assert.match(html, /data-geography-detail="selected-key">geography:nta2020:BK1503</);
  assert.match(html, /NYC Department of City Planning/);
  assert.match(html, /Direct polygon intersection/);
  assert.match(html, /68\.986772%/);
  assert.match(html, /31\.008101%/);
  assert.doesNotMatch(html, /"pct_from"\s*:/);
  assert.doesNotMatch(html, /\[object Object\]/);
});

test("A8: missing/stale crosswalk yields Comparison details unavailable without browser fallback math", () => {
  const model = buildSelectedGeographyOverlapViewModel({
    selected: GEOGRAPHY_NAVIGATION_AREA_OVERLAP_EXAMPLE.selected,
    compareType: "council_district",
    crosswalkAvailable: false,
    crosswalkRows: null,
  });
  assert.equal(model.area_section.available, false);
  assert.equal(model.area_section.summary, OVERLAP_COMPARISON_UNAVAILABLE);
  assert.equal(model.selected.key, "geography:nta2020:BK1503");
  assert.ok(model.continuation.href);
  assert.ok(model.compare_controls.length >= 3);
  const html = renderSelectedGeographyOverlapDrawerHtml(model);
  assert.match(html, /Comparison details unavailable/);
  assert.match(html, /Selected source:/);
  assert.doesNotMatch(OVERLAP_SOURCE, /overlayCivicGeographies|centroid|simplified.*pct_from/);
  assert.match(OVERLAP_SOURCE, /never invents percentages|only presents committed crosswalk/i);

  const stale = crosswalkRowsFromCommittedArtifacts({
    selectedKey: GEOGRAPHY_CROSSWALK_COMMISSION_PINS.selected_key,
    compareType: "council_district",
    manifest: {
      source_layers: {
        nta2020: { boundary_vintage: "26B" },
        council_district: { boundary_vintage: "2026-05-26" },
      },
      shards: [{ pair_id: "nta2020__council_district", path: "x" }],
    },
    shards: {
      nta2020__council_district: {
        source_vintages: { from: "25A", to: "2026-05-26" },
        rows: [],
      },
    },
  });
  assert.equal(stale.available, false);
  assert.equal(stale.reason, "stale_from_vintage");
});

test("A9: drawer markup order is shared; focus restore returns to invoker", () => {
  const model = buildBk1503CouncilOverlapFixtureModel({ focusToken: "map:nta2020:BK1503" });
  const html = renderSelectedGeographyOverlapDrawerHtml(model);
  const selectedIdx = html.indexOf("data-geography-selected-label");
  const compareIdx = html.indexOf("data-geography-compare-controls");
  const areaIdx = html.indexOf("data-geography-overlap-area");
  const detailsIdx = html.indexOf("data-geography-overlap-details");
  const recordsIdx = html.indexOf("data-geography-overlap-records");
  assert.ok(selectedIdx < compareIdx && compareIdx < areaIdx && areaIdx < detailsIdx && detailsIdx < recordsIdx);

  const store = {};
  const invoker = {
    focused: false,
    focus() { this.focused = true; },
  };
  rememberOverlapInvoker("map:nta2020:BK1503", invoker, store);
  const restored = restoreOverlapInvokerFocus("map:nta2020:BK1503", { store });
  assert.equal(restored, invoker);
  assert.equal(invoker.focused, true);

  const closedWorkspace = renderGeographyOverlapWorkspaceChrome(model, { drawerState: "closed" });
  assert.match(closedWorkspace, /data-geography-drawer-state="closed"/);
  assert.match(closedWorkspace, /data-geography-drawer-toggle[^>]+aria-expanded="false"/);
  assert.match(MAP_SOURCE, /toggle\.addEventListener\("click"/);
  assert.match(MAP_SOURCE, /workspace\.dataset\.geographyDrawerState = next/);
  assert.match(
    MAP_SOURCE,
    /if \(next === GEOGRAPHY_NAVIGATION_DRAWER_CLOSED\)[\s\S]*restoreOverlapInvokerFocus\(token, \{ root \}\)/,
  );
});

test("A10: keyboard/hover/tap expose equivalent names; Escape keeps selection", () => {
  const model = buildBk1503CouncilOverlapFixtureModel();
  const html = renderSelectedGeographyOverlapDrawerHtml(model);
  assert.match(html, /data-geography-overlap-highlight="geography:council_district:48"/);
  assert.match(html, /data-geography-focus-target="geography:council_district:48"/);
  assert.match(html, /City Council District 48/);
  const policy = overlapEscapePolicy();
  assert.equal(policy.clears_selection, false);
  assert.equal(policy.closes_drawer, false);
  assert.equal(policy.clears_hover, true);
});

test("formatting and sorting helpers match commission pins", () => {
  assert.equal(formatOverlapDisplayPercent(68.986772), "69.0%");
  assert.equal(formatOverlapDisplayPercent(31.008101), "31.0%");
  assert.equal(formatOverlapDisplayPercent(99.994497), "~100%");
  const sorted = sortOverlapRows([
    { id: "46", pct_from: 31.008101 },
    { id: "48", pct_from: 68.986772 },
  ]);
  assert.deepEqual(sorted.map((row) => row.id), ["48", "46"]);
});

test("City Hall point bundle keeps independent containment language", () => {
  const hall = GEOGRAPHY_NAVIGATION_POINT_BUNDLES.find((row) => row.id === "new-york-city-hall");
  const model = buildCityHallPointOverlapFixtureModel();
  assert.equal(model.selected.id, "MN0102");
  assert.equal(model.point_section.lines.find((line) => line.type === "council_district").id, "1");
  assert.equal(model.point_section.lines.find((line) => line.type === "community_district").id, "M01");
  assert.equal(model.area_section.available, false);
  assert.match(renderSelectedGeographyOverlapDrawerHtml(model), /At this location/);
  assert.equal(hall.membership.council_district.id, "1");
});

test("near_you_view and map island adopt the overlap drawer module", () => {
  assert.match(VIEW_SOURCE, /geography_navigation_overlap_ui/);
  assert.match(VIEW_SOURCE, /renderSelectedGeographyOverlapDrawerHtml|renderGeographyOverlapWorkspaceChrome|buildSelectedGeographyOverlapViewModel/);
  assert.match(MAP_SOURCE, /geography_navigation_overlap_ui/);
  assert.match(MAP_SOURCE, /setComparisonLayer|loadCrosswalkRowsForSelection|restoreOverlapInvokerFocus/);
});

test("selected Near You document renders overlap drawer for BK1503 council compare", () => {
  const { manifest, shards } = loadCommittedShards();
  const loaded = crosswalkRowsFromCommittedArtifacts({
    selectedKey: GEOGRAPHY_CROSSWALK_COMMISSION_PINS.selected_key,
    compareType: "council_district",
    manifest,
    shards,
  });
  const scope = scopeWithGeographies(scopeFromLensState("meetings"), [
    "geography:nta2020:BK1503",
  ]);
  const view = buildNearYouViewModel(scope, fixtureActivity(), {
    borough: { Brooklyn: { path: "M0,0", label_point: { x: 1, y: 1 } } },
  }, {
    geographySearch: "geo=nta2020:BK1503&compare=council_district&surface=map",
    crosswalkRows: loaded.rows,
    crosswalkAvailable: true,
    shellSurface: "map",
  });
  assert.equal(view.geographyState?.compare, "council_district");
  assert.ok(view.overlapModel);
  assert.equal(view.overlapModel.selected.id, "BK1503");
  const html = renderNearYouDocument(view);
  assert.match(html, /This neighborhood overlaps 2 Council districts/);
  assert.match(html, /69\.0%/);
  assert.match(html, /data-geography-overlap-root/);
});
