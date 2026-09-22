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
  labelForGeographyId,
  overlapEscapePolicy,
  rememberOverlapInvoker,
  renderSelectedGeographyOverlapDrawerHtml,
  renderGeographyOverlapWorkspaceChrome,
  resolveGeographyOwnerPresentation,
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
  assert.doesNotMatch(html, /<a[^>]+data-geography-compare=[^>]+aria-pressed=/);
  assert.match(html, /<a[^>]+data-geography-compare=[^>]+aria-current="true"/);

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

test("A1: Greenpoint police compare keeps Greenpoint, Precinct 94, and the NTA directory", () => {
  const { manifest, shards } = loadCommittedShards();
  const loaded = crosswalkRowsFromCommittedArtifacts({
    selectedKey: "geography:nta2020:BK0101",
    compareType: "police_precinct",
    manifest,
    shards,
  });
  assert.equal(loaded.available, true);
  const selected = {
    key: "geography:nta2020:BK0101",
    type: "nta2020",
    id: "BK0101",
    label: "Greenpoint",
    boundary_vintage: "26B",
  };
  const model = buildSelectedGeographyOverlapViewModel({
    selected,
    compareType: "police_precinct",
    crosswalkRows: loaded.rows,
    crosswalkAvailable: true,
  });
  assert.equal(model.selected.label, "Greenpoint");
  assert.equal(model.selected.key, "geography:nta2020:BK0101");
  assert.equal(model.compare_type, "police_precinct");
  assert.deepEqual(model.area_section.rows.map((row) => row.id), ["94"]);
  assert.match(model.area_section.rows[0].label, /Police Precinct 94/);
  const drawer = renderSelectedGeographyOverlapDrawerHtml(model);
  assert.match(drawer, /data-geography-selected-label>Greenpoint</);
  assert.match(drawer, /Police Precinct 94/);
  assert.doesNotMatch(drawer, /data-geography-selected-label>BK0101</);

  const layerDoc = {
    type: "nta2020",
    vintage: { id: "26B" },
    features: [
      { key: "geography:nta2020:BK0101", id: "BK0101", type: "nta2020", label: "Greenpoint", subtype: "residential" },
      { key: "geography:nta2020:BK0104", id: "BK0104", type: "nta2020", label: "East Williamsburg", subtype: "residential" },
    ],
  };
  const activity = {
    ...fixtureActivity(),
    geography_items: {
      definitions: {
        "geography:nta2020:BK0101": selected,
      },
      by_key: {
        "geography:nta2020:BK0101": { meetings: ["m-1"] },
      },
    },
  };
  const scope = scopeWithGeographies(scopeFromLensState("meetings", { agency: "Transportation", q: "curb" }), [
    "geography:nta2020:BK0101",
  ]);
  let latestCompare = "police_precinct";
  const views = ["community_district", "council_district", "police_precinct"].map((compareType) => {
    latestCompare = compareType;
    const compareRows = crosswalkRowsFromCommittedArtifacts({
      selectedKey: "geography:nta2020:BK0101",
      compareType,
      manifest,
      shards,
    });
    return buildNearYouViewModel(scope, activity, {
      schema: "cityscroll.district_boundaries.v1",
      boundary_vintage: "2026-05-26",
      community_districts: [],
      council_districts: [],
    }, {
      geographySearch: `?geo=nta2020:BK0101&compare=${compareType}&surface=map&lens=meetings&agency=Transportation&q=curb`,
      navigationLayerDoc: layerDoc,
      navigationLayerType: "nta2020",
      geographyLabelIndex: { "geography:nta2020:BK0101": "Greenpoint" },
      crosswalkRows: compareRows.rows,
      crosswalkAvailable: compareRows.available,
      shellSurface: "map",
      canonicalBase: "https://cityscroll.org/near-you",
    });
  });
  for (const view of views) {
    assert.equal(view.placePresentation.label, "Greenpoint");
    assert.equal(view.activeGeographyLayer, "nta2020");
    assert.equal(view.geographyState?.key, "geography:nta2020:BK0101");
    assert.equal(view.geographyState?.lens, "meetings");
    assert.ok(view.navigationAreas.some((entry) => entry.id === "BK0101"));
    assert.ok(view.navigationAreas.every((entry) => entry.type === "nta2020"));
    const html = renderNearYouDocument(view);
    assert.match(html, /<h1>Greenpoint<\/h1>/);
    assert.match(html, /data-geography-areas[^>]*data-geography-layer="nta2020"/);
    assert.match(html, /data-geography-layer="nta2020"[^>]*aria-pressed="true"/);
    assert.doesNotMatch(html, /No areas match/);
    assert.doesNotMatch(html, /<h1>BK0101<\/h1>/);
  }
  assert.equal(latestCompare, "police_precinct");
  assert.equal(views.at(-1).geographyState?.compare, "police_precinct");
  assert.match(renderNearYouDocument(views.at(-1)), /Police Precinct 94/);

  // Missing crosswalk keeps the primary place and never claims zero areas exist.
  const unavailable = buildNearYouViewModel(scope, activity, {
    schema: "cityscroll.district_boundaries.v1",
    boundary_vintage: "2026-05-26",
    community_districts: [],
    council_districts: [],
  }, {
    geographySearch: "?geo=nta2020:BK0101&compare=police_precinct&surface=map&lens=meetings",
    navigationLayerDoc: layerDoc,
    navigationLayerType: "nta2020",
    geographyLabelIndex: { "geography:nta2020:BK0101": "Greenpoint" },
    crosswalkAvailable: false,
    shellSurface: "map",
    canonicalBase: "https://cityscroll.org/near-you",
  });
  assert.equal(unavailable.placePresentation.label, "Greenpoint");
  assert.equal(unavailable.activeGeographyLayer, "nta2020");
  assert.equal(unavailable.overlapModel?.selected?.label, "Greenpoint");
  assert.equal(unavailable.overlapModel?.area_section?.available, false);
  const unavailableHtml = renderNearYouDocument(unavailable);
  assert.match(unavailableHtml, /Comparison details unavailable/);
  assert.doesNotMatch(unavailableHtml, /No areas match/);
  assert.match(unavailableHtml, /data-geography-areas[^>]*data-geography-layer="nta2020"/);
});

test("A2: map island keeps primary layer independent of compare and ignores stale loads", () => {
  assert.match(VIEW_SOURCE, /geographyState\?\.type/);
  assert.doesNotMatch(
    VIEW_SOURCE,
    /activeGeographyLayer = options\.navigationLayerType\s*\|\|\s*geographyState\?\.compare/,
  );
  assert.match(MAP_SOURCE, /selected\?\.type/);
  assert.doesNotMatch(MAP_SOURCE, /initialType = selected\?\.compare/);
  assert.match(MAP_SOURCE, /refreshGeographyAreasList\(primaryType, primaryDoc\)/);
  assert.match(MAP_SOURCE, /setActiveLayerButtons\(primaryType\)/);
  assert.match(
    MAP_SOURCE,
    /if \(\(current\.compare \|\| null\) !== requestedCompare\) return/,
  );
});

test("A1/A2: geography owners keep friendly labels and vintage when records are unavailable", () => {
  const layerDoc = {
    type: "nta2020",
    vintage: { id: "26B" },
    features: [
      { key: "geography:nta2020:BK0101", id: "BK0101", type: "nta2020", label: "Greenpoint", subtype: "residential" },
      { key: "geography:nta2020:QN0103", id: "QN0103", type: "nta2020", label: "Astoria (Central)", subtype: "residential" },
      { key: "geography:nta2020:SI0101", id: "SI0101", type: "nta2020", label: "St. George-New Brighton", subtype: "residential" },
    ],
  };
  const labelIndex = {
    "geography:nta2020:BK0101": "Greenpoint",
    "geography:nta2020:QN0103": "Astoria (Central)",
    "geography:nta2020:SI0101": "St. George-New Brighton",
  };

  for (const specimen of [
    { id: "BK0101", label: "Greenpoint" },
    { id: "QN0103", label: "Astoria (Central)" },
    { id: "SI0101", label: "St. George-New Brighton" },
  ]) {
    const owner = resolveGeographyOwnerPresentation({
      type: "nta2020",
      id: specimen.id,
      labelIndex,
      layerDoc,
    });
    assert.equal(owner.label, specimen.label, specimen.id);
    assert.equal(owner.boundary_vintage, "26B", specimen.id);
    assert.equal(owner.has_friendly_label, true, specimen.id);
    assert.notEqual(owner.label, specimen.id, specimen.id);
  }

  assert.equal(
    labelForGeographyId("nta2020", "BK0101", { labelIndex }),
    "Greenpoint",
  );
  assert.equal(
    labelForGeographyId("nta2020", "BK0101"),
    "BK0101",
  );

  const missing = resolveGeographyOwnerPresentation({
    type: "nta2020",
    id: "BK0101",
    labelIndex,
    layerDoc: null,
  });
  assert.equal(missing.label, "Greenpoint");
  assert.equal(missing.boundary_vintage, null);

  const scope = scopeWithGeographies(scopeFromLensState("meetings", { agency: "Transportation", q: "curb" }), [
    "geography:nta2020:BK0101",
  ]);
  const view = buildNearYouViewModel(scope, null, {
    schema: "cityscroll.district_boundaries.v1",
    boundary_vintage: "2026-05-26",
    community_districts: [],
    council_districts: [],
  }, {
    dataState: "error",
    geometryState: "ready",
    geographySearch: "?geo=nta2020:BK0101&surface=map&compare=council_district&lens=meetings&agency=Transportation&q=curb",
    navigationLayerDoc: layerDoc,
    geographyLabelIndex: labelIndex,
    canonicalBase: "https://cityscroll.org/near-you",
  });
  const html = renderNearYouDocument(view);
  assert.equal(view.placePresentation.label, "Greenpoint");
  assert.equal(view.boundaryVintage, "26B");
  assert.equal(view.overlapModel?.selected?.label, "Greenpoint");
  assert.equal(view.overlapModel?.selected?.boundary_vintage, "26B");
  assert.match(html, /Map boundaries: 26B/);
  assert.match(html, /<h1>Greenpoint<\/h1>/);
  assert.doesNotMatch(html, /buyer_history_retry/);
  assert.doesNotMatch(html, /<h1>BK0101<\/h1>/);
});
