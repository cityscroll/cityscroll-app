// Map-first Near You shell: semantic order, state adoption, list/map key equality.
//
//   node --test test/geography_navigation_shell.test.mjs

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import {
  GEOGRAPHY_SHELL_BASEMAP_CONTRAST_SAMPLES,
  GEOGRAPHY_SHELL_BROWSE_RECORDS_LABEL,
  GEOGRAPHY_SHELL_DIRECTORY_EMPTY,
  GEOGRAPHY_SHELL_DIRECTORY_FILTER_PARAM,
  GEOGRAPHY_SHELL_HEADING,
  GEOGRAPHY_SHELL_LABEL_BUDGET,
  GEOGRAPHY_SHELL_MORE_BOUNDARIES_LABEL,
  GEOGRAPHY_SHELL_SPECIAL_USE_SUMMARY,
  GEOGRAPHY_SHELL_USE_LOCATION_LABEL,
  RESIDENT_GEOGRAPHY_SHELL_SCHEMA,
  aliasesByNtaIdFromGazetteer,
  areaEntryKeys,
  areaListMatchesMapKeys,
  contrastRatio,
  directoryEntryMatchesQuery,
  estimateNeighborhoodLabelBudget,
  geographyShellAreasListHtml,
  geographyShellSearchFormHtml,
  geographyShellLayerSwitcherHtml,
  groupDirectoryEntriesByBorough,
  labelWrapsToAtMostTwoLines,
  navigationAreaEntriesFromLayerDoc,
  navigationDirectoryFromLayerDoc,
  renderGeographyShellEntry,
  resolveShellSurface,
} from "../site/geography_navigation_shell.mjs";
import neighborhoodGazetteer from "../site/data/neighborhood_gazetteer.json" with { type: "json" };
import {
  GEOGRAPHY_NAVIGATION_SURFACE_MAP,
  GEOGRAPHY_NAVIGATION_SURFACE_RECORDS,
} from "../site/geography_navigation_state.mjs";

const DIRECTORY_ACCEPTANCE_CASES = Object.freeze([
  Object.freeze({ id: "BK0101", label: "Greenpoint", borough: "Brooklyn", membership: "residential" }),
  Object.freeze({ id: "MN0102", label: "Tribeca-Civic Center", borough: "Manhattan", membership: "residential" }),
  Object.freeze({ id: "QN0103", label: "Astoria (Central)", borough: "Queens", membership: "residential" }),
  Object.freeze({ id: "BX0101", label: "Mott Haven-Port Morris", borough: "Bronx", membership: "residential" }),
  Object.freeze({ id: "SI0101", label: "St. George-New Brighton", borough: "Staten Island", membership: "residential" }),
  Object.freeze({ id: "QN8381", label: "John F. Kennedy International Airport", borough: "Queens", membership: "special_use" }),
  Object.freeze({ id: "BK0771", label: "Green-Wood Cemetery", borough: "Brooklyn", membership: "special_use" }),
]);
import { geographyNavigationPrimaryLayers, geographyNavigationMoreBoundaryLayers } from "../site/geography_navigation_capability.mjs";
import {
  GEOGRAPHY_MAP_LAYER_IDS,
  GEOGRAPHY_MAP_STYLE,
  __test__ as geographyMapTest,
} from "../site/geography_navigation_map.mjs";
import { buildNearYouViewModel, renderNearYouDocument } from "../site/near_you_view.mjs";
import { scopeFromLensState, scopeWithGeographies } from "../site/scope_v0.mjs";
import { scopeWithPlace } from "../site/near_you_scope_runtime.mjs";

const ROOT = process.cwd();

test("native area links and search controls retain non-place filters", () => {
  const base = "/near-you/?geo=nta2020%3ABK0101&scope=citywide&lens=land&agency=Transportation&q=curb&lat=40.7";
  const html = geographyShellAreasListHtml([{type:"nta2020", id:"BK0102", key:"geography:nta2020:BK0102", label:"Williamsburg"}], {base});
  const href = html.match(/href="([^"]+)"/)[1].replaceAll("&amp;", "&");
  const params = new URL(href, "https://cityscroll.org").searchParams;
  assert.equal(params.get("geo"), "nta2020:BK0102");
  assert.equal(params.get("lens"), "land");
  assert.equal(params.get("agency"), "Transportation");
  assert.equal(params.get("q"), "curb");
  assert.equal(params.has("scope"), false);
  assert.equal(params.has("lat"), false);
  const form = geographyShellSearchFormHtml({action:base});
  assert.match(form, /name="lens" value="land"/);
  assert.match(form, /name="agency" value="Transportation"/);
  assert.match(form, /name="q" value="curb"/);
  assert.doesNotMatch(form, /name="(?:geo|scope|lat)"/);
});
const NTA_LAYER = JSON.parse(
  readFileSync(join(ROOT, "site/data/geography/layers/nta2020/26B.json"), "utf8"),
);
const SHELL_SOURCE = readFileSync(join(ROOT, "site/geography_navigation_shell.mjs"), "utf8");
const VIEW_SOURCE = readFileSync(join(ROOT, "site/near_you_view.mjs"), "utf8");
const BRAND_SOURCE = readFileSync(join(ROOT, "site/brand.css"), "utf8");
const DOCUMENT_CSS_SOURCE = readFileSync(join(ROOT, "site/civic-documents.css"), "utf8");
const MAP_ISLAND_SOURCE = readFileSync(join(ROOT, "site/app/map.mjs"), "utf8");
const LAND_RUNTIME_SOURCE = readFileSync(join(ROOT, "site/app/map_runtime.mjs"), "utf8");

const fixtureBoundaries = {
  borough: {
    Manhattan: { path: "M0,0", label_point: { x: 1, y: 1 } },
    Brooklyn: { path: "M0,0", label_point: { x: 2, y: 2 } },
  },
};

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
    by_level: {
      borough: {
        Manhattan: { meetings: 1 },
        Brooklyn: { meetings: 0 },
      },
    },
    district_items: {
      citywide: { meetings: [] },
      virtual: { meetings: [] },
      unlocated: { meetings: [] },
    },
    geography_items: {
      definitions: {
        "geography:nta2020:BK0101": { key: "geography:nta2020:BK0101", type: "nta2020", id: "BK0101", label: "Greenpoint" },
      },
      by_key: {
        "geography:nta2020:BK0101": { meetings: ["m-1"] },
      },
    },
  };
}

test("shell schema and copy constants are resident-facing", () => {
  assert.equal(RESIDENT_GEOGRAPHY_SHELL_SCHEMA, "cityscroll.resident_geography_shell.v1");
  assert.equal(GEOGRAPHY_SHELL_HEADING, "What's near you?");
  assert.equal(GEOGRAPHY_SHELL_BROWSE_RECORDS_LABEL, "Browse records");
  assert.equal(GEOGRAPHY_SHELL_MORE_BOUNDARIES_LABEL, "More boundaries");
  assert.equal(GEOGRAPHY_SHELL_USE_LOCATION_LABEL, "Use my location");
  assert.doesNotMatch(SHELL_SOURCE, /geography_navigation_\w+\.v1/);
});

test("A2: Neighborhoods is the default layer and NTA labels omit codes as primary text", () => {
  const primary = geographyNavigationPrimaryLayers().map((layer) => layer.primary_label);
  assert.deepEqual(primary, ["Neighborhoods", "Community districts", "Council districts"]);
  assert.deepEqual(
    geographyNavigationMoreBoundaryLayers().map((layer) => layer.primary_label),
    ["Precincts"],
  );
  const entries = navigationAreaEntriesFromLayerDoc(NTA_LAYER, { layerType: "nta2020" });
  assert.ok(entries.length >= 100);
  for (const entry of entries.slice(0, 40)) {
    assert.equal(entry.type, "nta2020");
    assert.doesNotMatch(entry.label, /^[A-Z]{2}\d{4}$/);
    assert.match(entry.key, /^geography:nta2020:[A-Z]{2}\d{4}$/);
  }
  const switcher = geographyShellLayerSwitcherHtml({ activeType: "nta2020" });
  assert.match(switcher, /data-geography-layer="nta2020"[^>]*aria-pressed="true"/);
  assert.match(switcher, /More boundaries/);
  assert.match(switcher, /Precincts/);
});

test("A5: Areas list keys equal the active layer feature keys", () => {
  const entries = navigationAreaEntriesFromLayerDoc(NTA_LAYER, { layerType: "nta2020" });
  const mapKeys = entries.map((entry) => entry.key);
  assert.equal(areaListMatchesMapKeys(entries, mapKeys), true);
  assert.equal(areaListMatchesMapKeys(entries, mapKeys.slice(1)), false);
  const html = geographyShellAreasListHtml(entries.slice(0, 5), { activeType: "nta2020" });
  assert.match(html, /<h3>Areas<\/h3>/);
  assert.doesNotMatch(html, /equivalent area list/i);
  for (const key of areaEntryKeys(entries.slice(0, 5))) {
    assert.match(html, new RegExp(`data-geography-key="${key}"`));
  }
});

test("A7: resolveShellSurface defaults Map for fresh entry and Records for selected place", () => {
  assert.equal(resolveShellSurface(null, { hasPlace: false }), GEOGRAPHY_NAVIGATION_SURFACE_MAP);
  assert.equal(resolveShellSurface(null, { hasPlace: true }), GEOGRAPHY_NAVIGATION_SURFACE_RECORDS);
  assert.equal(resolveShellSurface("records", { hasPlace: false }), GEOGRAPHY_NAVIGATION_SURFACE_RECORDS);
  assert.equal(resolveShellSurface("list", { hasPlace: false }), GEOGRAPHY_NAVIGATION_SURFACE_RECORDS);
  assert.equal(resolveShellSurface("map", { hasPlace: true }), GEOGRAPHY_NAVIGATION_SURFACE_MAP);
});

test("A1/A6/A8/A10: unselected document leads with map-first shell and keeps no-JS completeness", () => {
  const view = buildNearYouViewModel(scopeFromLensState("meetings"), fixtureActivity(), fixtureBoundaries, {
    canonicalBase: "https://cityscroll.org/near-you",
    navigationLayerDoc: NTA_LAYER,
    navigationLayerType: "nta2020",
  });
  const html = renderNearYouDocument(view);
  const headingAt = html.search(/What(?:'|&#39;)s near you\?/);
  const advancedAt = html.search(/Advanced filters/i);
  const mapAt = html.indexOf('id="nearMapSvg"');
  const areasAt = html.indexOf('id="near-area-list"');
  const resultsAt = html.indexOf("near-results");
  assert.ok(headingAt >= 0, "heading present");
  assert.match(html, /What(?:'|&#39;)s near you\?/);
  assert.match(html, /data-use-location/);
  assert.match(html, /Use my location/);
  assert.match(html, /data-geography-layer-switcher/);
  assert.match(html, /Neighborhoods/);
  assert.match(html, /Community districts/);
  assert.match(html, /Council districts/);
  assert.match(html, /More boundaries/);
  assert.match(html, /Browse records/);
  assert.match(html, /data-near-surface="map"/);
  assert.match(html, /data-near-surface="records"/);
  assert.match(html, /id="near-map-enhanced"/);
  assert.match(html, /id="nearMapSvg"/);
  assert.match(html, /<h3>Areas<\/h3>/);
  assert.match(html, /data-geography-key="geography:nta2020:/);
  assert.match(html, /method="get"/);
  assert.match(html, /near-results/);
  assert.doesNotMatch(html, /equivalent area list/i);
  // Advanced filters must not precede the location task / map on the unselected shell.
  if (advancedAt > 0) {
    assert.ok(headingAt < advancedAt, "heading precedes advanced filters");
    assert.ok(mapAt < advancedAt || areasAt < advancedAt, "map/areas precede advanced filters");
  }
  assert.ok(headingAt < mapAt, "heading precedes map");
  assert.ok(areasAt > 0 && resultsAt > 0);
  // No duplicate layer switcher ids.
  assert.equal((html.match(/data-geography-layer-switcher/g) || []).length, 1);
  assert.equal((html.match(/id="near-geo-heading"/g) || []).length, 1);
  assert.equal((html.match(/id="nearMapSvg"/g) || []).length, 1);
  assert.equal((html.match(/id="near-area-list"/g) || []).length, 1);
  assert.equal((html.match(/id="near-map-enhanced"/g) || []).length, 1);
});

test("A10: selected-place routes keep the heading first and secondary context after the map", () => {
  const scope = scopeWithPlace(scopeFromLensState("meetings"), {
    borough: "Brooklyn",
    communityDistrict: "K15",
  });
  const view = buildNearYouViewModel(scope, fixtureActivity(), fixtureBoundaries, {
    canonicalBase: "https://cityscroll.org/near-you",
    communityGeography: {
      public_edges: [{ type: "covers", from: "community-board:brooklyn-cb-15", to: "community-district:K15" }],
      nodes: [{
        id: "community-board:brooklyn-cb-15",
        name: "Brooklyn Community Board 15",
        properties: { body_id: "brooklyn-cb-15" },
      }],
    },
    navigationLayerDoc: NTA_LAYER,
  });
  const html = renderNearYouDocument(view);
  assert.match(html, />Brooklyn Community District 15<\/h1>/);
  assert.match(html, /Advanced filters/);
  assert.match(html, /<h3>Areas<\/h3>/);
  assert.match(html, /data-near-surface="records"|data-near-surface="map"/);
  assert.ok(html.indexOf("<h1>Brooklyn Community District 15</h1>") < html.indexOf('class="near-map-wrap"'));
  assert.ok(html.indexOf('class="near-map-wrap"') < html.indexOf('class="near-selected-context"'));
});

test("A12 boundary: Land map runtime stays untouched; shell may mount the adapter", () => {
  assert.doesNotMatch(LAND_RUNTIME_SOURCE, /geography_navigation_map/);
  assert.doesNotMatch(LAND_RUNTIME_SOURCE, /geography_navigation_shell/);
  // The Near You island may import the progressive adapter; Land must not.
  assert.match(VIEW_SOURCE, /geography_navigation_shell/);
});

test("A1: comparison keeps Neighborhoods as the browsable primary layer for Greenpoint", () => {
  const entries = navigationAreaEntriesFromLayerDoc(NTA_LAYER, { layerType: "nta2020" });
  assert.ok(entries.some((entry) => entry.id === "BK0101" && entry.label === "Greenpoint"));
  const areas = geographyShellAreasListHtml(entries.slice(0, 8), { activeType: "nta2020" });
  assert.match(areas, /data-geography-layer="nta2020"/);
  assert.doesNotMatch(areas, /No areas match/);

  const switcher = geographyShellLayerSwitcherHtml({
    activeType: "nta2020",
    selectedGeo: "nta2020:BK0101",
    surface: GEOGRAPHY_NAVIGATION_SURFACE_MAP,
  });
  assert.match(switcher, /data-geography-layer="nta2020"[^>]*aria-pressed="true"/);
  assert.match(switcher, /data-geography-layer="community_district"[^>]*aria-pressed="false"/);
  assert.match(SHELL_SOURCE, /Comparison overlays\s+live in the overlap drawer|must not steal the pressed primary control/);

  const view = buildNearYouViewModel(
    scopeWithGeographies(scopeFromLensState("meetings"), ["geography:nta2020:BK0101"]),
    fixtureActivity(),
    fixtureBoundaries,
    {
      geographySearch: "?geo=nta2020:BK0101&compare=police_precinct&surface=map",
      navigationLayerDoc: NTA_LAYER,
      navigationLayerType: "nta2020",
      shellSurface: "map",
      canonicalBase: "https://cityscroll.org/near-you",
    },
  );
  assert.equal(view.activeGeographyLayer, "nta2020");
  assert.equal(view.geographyState?.compare, "police_precinct");
  assert.ok(view.navigationAreas.length > 0);
  assert.ok(view.navigationAreas.every((entry) => entry.type === "nta2020"));
  const html = renderNearYouDocument(view);
  assert.match(html, /data-geography-layer="nta2020"/);
  assert.doesNotMatch(html, /No areas match this layer|No areas match these filters/);
});

test("entry chrome render includes required first-viewport controls", () => {
  const html = renderGeographyShellEntry({
    canonicalBase: "/near-you/",
    surface: GEOGRAPHY_NAVIGATION_SURFACE_MAP,
  });
  assert.match(html, /What(?:'|&#39;)s near you\?/);
  assert.match(html, /near-geo-search-input/);
  assert.match(html, /Use my location/);
  assert.match(html, /Browse records/);
  assert.match(html, /data-near-surface="map"[^>]*aria-current="true"|aria-current="true"[^>]*data-near-surface="map"/);
  assert.match(html, /<details class="near-entry-secondary">\s*<summary>More ways to choose<\/summary>/);
  assert.ok(html.indexOf("near-geo-search-input") < html.indexOf("near-entry-secondary"));
  assert.ok(html.indexOf('data-near-surface="records"') < html.indexOf("near-entry-secondary"));
  assert.ok(html.indexOf("near-entry-secondary") < html.indexOf("data-geography-layer-switcher"));
});

test("A1: residential directory groups by borough and keeps special-use behind a labeled option", () => {
  const aliases = aliasesByNtaIdFromGazetteer(neighborhoodGazetteer);
  const directory = navigationDirectoryFromLayerDoc(NTA_LAYER, {
    layerType: "nta2020",
    aliasesByNtaId: aliases,
  });
  assert.equal(directory.residential_total, 197);
  assert.equal(directory.special_use_total, 65);
  assert.ok(directory.groups.length >= 5);
  assert.deepEqual(
    directory.groups.map((group) => group.borough),
    ["Bronx", "Brooklyn", "Manhattan", "Queens", "Staten Island"],
  );
  for (const entry of directory.residential) {
    assert.equal(entry.is_special_use, false);
    assert.ok(entry.borough);
  }
  for (const entry of directory.special_use) {
    assert.equal(entry.is_special_use, true);
  }
  const html = geographyShellAreasListHtml(directory.residential, {
    activeType: "nta2020",
    directory,
  });
  assert.match(html, /data-geography-directory="residential"/);
  assert.match(html, /data-geography-borough-group="Brooklyn"/);
  assert.match(html, new RegExp(`<summary>${GEOGRAPHY_SHELL_SPECIAL_USE_SUMMARY}</summary>`));
  assert.match(html, /data-geography-special-use-directory/);
  const withoutSpecial = html.replace(/<details class="near-area-special-use"[\s\S]*?<\/details>/, "");
  assert.doesNotMatch(withoutSpecial, /data-map-area="QN8381"/);
  assert.doesNotMatch(withoutSpecial, /data-map-area="BK0771"/);
  assert.doesNotMatch(withoutSpecial, /data-geography-special-use="true"/);
  for (const row of DIRECTORY_ACCEPTANCE_CASES) {
    if (row.membership === "residential") {
      assert.ok(directory.residential.some((entry) => entry.id === row.id), row.label);
      assert.match(html, new RegExp(`data-map-area="${row.id}"`));
    } else {
      assert.ok(directory.special_use.some((entry) => entry.id === row.id), row.label);
      assert.equal(directory.residential.some((entry) => entry.id === row.id), false);
    }
  }
});

test("A1/A2: local name filter retains aliases and recovers on no match", () => {
  const aliases = aliasesByNtaIdFromGazetteer(neighborhoodGazetteer);
  const mott = navigationDirectoryFromLayerDoc(NTA_LAYER, {
    layerType: "nta2020",
    aliasesByNtaId: aliases,
    query: "Mott Haven",
  });
  assert.equal(mott.residential.length, 1);
  assert.equal(mott.residential[0].id, "BX0101");
  assert.equal(mott.empty, false);

  const tribeca = navigationDirectoryFromLayerDoc(NTA_LAYER, {
    layerType: "nta2020",
    aliasesByNtaId: aliases,
    query: "Tribeca",
  });
  assert.ok(tribeca.residential.some((entry) => entry.id === "MN0102"));

  const jfk = navigationDirectoryFromLayerDoc(NTA_LAYER, {
    layerType: "nta2020",
    aliasesByNtaId: aliases,
    query: "JFK Airport",
  });
  assert.equal(jfk.residential.length, 0);
  assert.ok(jfk.special_use.some((entry) => entry.id === "QN8381"));

  const none = navigationDirectoryFromLayerDoc(NTA_LAYER, {
    layerType: "nta2020",
    aliasesByNtaId: aliases,
    query: "zzz-no-such-neighborhood",
  });
  assert.equal(none.empty, true);
  const emptyHtml = geographyShellAreasListHtml([], { activeType: "nta2020", directory: none, query: none.query });
  assert.match(emptyHtml, new RegExp(GEOGRAPHY_SHELL_DIRECTORY_EMPTY.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(emptyHtml, new RegExp(`name="${GEOGRAPHY_SHELL_DIRECTORY_FILTER_PARAM}"`));
});

test("A2: directory native links keep topic filters and omit location permission", () => {
  const directory = navigationDirectoryFromLayerDoc(NTA_LAYER, { layerType: "nta2020", query: "Greenpoint" });
  const base = "/near-you/?lens=land&agency=Transportation&q=curb&area_q=Greenpoint";
  const html = geographyShellAreasListHtml(directory.residential, {
    activeType: "nta2020",
    base,
    directory,
    query: "Greenpoint",
  });
  const href = html.match(/data-map-area="BK0101"[^>]*href="([^"]+)"/)[1].replaceAll("&amp;", "&");
  const params = new URL(href, "https://cityscroll.org").searchParams;
  assert.equal(params.get("geo"), "nta2020:BK0101");
  assert.equal(params.get("lens"), "land");
  assert.equal(params.get("agency"), "Transportation");
  assert.equal(params.get("q"), "curb");
  assert.equal(params.has("lat"), false);
  assert.equal(params.has("lon"), false);
  assert.doesNotMatch(SHELL_SOURCE, /geolocation|getCurrentPosition/);
  assert.ok(directoryEntryMatchesQuery(directory.residential[0], "Greenpoint"));
  assert.ok(groupDirectoryEntriesByBorough(directory.residential).length >= 1);
});

test("A3: directory fixtures and Browse records precede the area-link tab sequence", () => {
  const aliases = aliasesByNtaIdFromGazetteer(neighborhoodGazetteer);
  const view = buildNearYouViewModel(scopeFromLensState("meetings"), fixtureActivity(), fixtureBoundaries, {
    canonicalBase: "https://cityscroll.org/near-you",
    navigationLayerDoc: NTA_LAYER,
    navigationLayerType: "nta2020",
  });
  const html = renderNearYouDocument(view);
  const recordsAt = html.search(/data-near-surface="records"/);
  const firstAreaLink = html.search(/data-map-area="/);
  assert.ok(recordsAt >= 0 && firstAreaLink >= 0);
  assert.ok(recordsAt < firstAreaLink, "Browse records precedes area links");
  assert.ok(!html.slice(0, recordsAt).includes("data-map-area="));

  const withoutSpecial = html.replace(/<details class="near-area-special-use"[\s\S]*?<\/details>/, "");
  const defaultTabAreaLinks = (withoutSpecial.match(/data-map-area="/g) || []).length;
  assert.equal(defaultTabAreaLinks, 197);
  assert.ok(defaultTabAreaLinks < 262, "special-use stays out of the default tab sequence");
  assert.equal(view.navigationDirectory.residential_total, 197);
  assert.equal(view.navigationDirectory.special_use_total, 65);
  assert.ok(recordsAt < withoutSpecial.search(/data-map-area="/));

  for (const expected of DIRECTORY_ACCEPTANCE_CASES) {
    const entry = [...view.navigationDirectory.residential, ...view.navigationDirectory.special_use]
      .find((row) => row.id === expected.id);
    assert.ok(entry, expected.label);
    assert.equal(entry.label, expected.label);
    assert.equal(entry.borough, expected.borough);
    assert.equal(entry.is_special_use, expected.membership === "special_use");
  }
  assert.match(html, /data-geography-special-use-directory/);
  assert.match(html, /data-geography-borough-group="Brooklyn"/);
  assert.ok(aliases.BK0101?.includes("Greenpoint") || aliases.BX0101?.includes("Mott Haven"));
});

test("first-view geometry uses shared target and map-visibility floors", () => {
  assert.match(BRAND_SOURCE, /--control-min-size:\s*2\.75rem/);
  assert.match(BRAND_SOURCE, /--near-map-first-view-min:\s*15rem/);
  assert.match(DOCUMENT_CSS_SOURCE, /\.near-geo-search input[\s\S]*min-height:\s*var\(--control-min-size\)/);
  assert.match(DOCUMENT_CSS_SOURCE, /\.near-map-enhanced[\s\S]*min-height:\s*var\(--near-map-first-view-min\)/);
  assert.match(DOCUMENT_CSS_SOURCE, /\.near-map-state a\[data-near-recovery\][\s\S]*min-height:\s*var\(--control-min-size\)/);
});

test("A13: all-city label budgets stay inside 12–40 desktop and 6–20 narrow", () => {
  const desktop = estimateNeighborhoodLabelBudget(GEOGRAPHY_SHELL_LABEL_BUDGET.desktop);
  const narrow = estimateNeighborhoodLabelBudget(GEOGRAPHY_SHELL_LABEL_BUDGET.narrow);
  assert.ok(desktop);
  assert.ok(narrow);
  assert.ok(desktop.estimate >= 12 && desktop.estimate <= 40, `desktop budget ${desktop.estimate}`);
  assert.ok(narrow.estimate >= 6 && narrow.estimate <= 20, `narrow budget ${narrow.estimate}`);
  assert.deepEqual(
    { min: desktop.min, max: desktop.max },
    { min: GEOGRAPHY_SHELL_LABEL_BUDGET.desktop.min, max: GEOGRAPHY_SHELL_LABEL_BUDGET.desktop.max },
  );
  assert.deepEqual(
    { min: narrow.min, max: narrow.max },
    { min: GEOGRAPHY_SHELL_LABEL_BUDGET.narrow.min, max: GEOGRAPHY_SHELL_LABEL_BUDGET.narrow.max },
  );

  const style = geographyMapTest.buildBaseStyle();
  const labels = style.layers.find((layer) => layer.id === GEOGRAPHY_MAP_LAYER_IDS.labels);
  const selected = style.layers.find((layer) => layer.id === GEOGRAPHY_MAP_LAYER_IDS.selectedLabel);
  assert.equal(labels.layout["text-allow-overlap"], false);
  assert.equal(labels.layout["text-ignore-placement"], false);
  assert.equal(selected.layout["text-allow-overlap"], true);
  assert.equal(selected.layout["text-field"][1], "label");
  assert.equal(labels.layout["text-field"][1], "label");
  // Selected neighborhood name remains drawable even when ordinary labels collide.
  assert.notEqual(labels.layout["text-allow-overlap"], selected.layout["text-allow-overlap"]);
});

test("A14: quiet fills, two-line wrap, label/halo contrast, and no NTA codes as primary copy", () => {
  assert.ok(GEOGRAPHY_MAP_STYLE.ACTIVE_FILL_OPACITY < 0.2);
  assert.ok(GEOGRAPHY_MAP_STYLE.SELECTED_FILL_OPACITY <= 0.25);
  assert.ok(GEOGRAPHY_MAP_STYLE.SELECTED_LINE_WIDTH > GEOGRAPHY_MAP_STYLE.ACTIVE_LINE_WIDTH);
  assert.ok(labelWrapsToAtMostTwoLines(10));
  assert.ok(labelWrapsToAtMostTwoLines(12));
  assert.equal(labelWrapsToAtMostTwoLines(1, { typicalChars: 18 }), false);

  const style = geographyMapTest.buildBaseStyle();
  const labels = style.layers.find((layer) => layer.id === GEOGRAPHY_MAP_LAYER_IDS.labels);
  assert.equal(labels.paint["text-color"], GEOGRAPHY_MAP_STYLE.LABEL_TEXT_COLOR);
  assert.equal(labels.paint["text-halo-color"], GEOGRAPHY_MAP_STYLE.LABEL_HALO_COLOR);
  const labelOnHalo = contrastRatio(
    GEOGRAPHY_MAP_STYLE.LABEL_TEXT_COLOR,
    GEOGRAPHY_MAP_STYLE.LABEL_HALO_COLOR,
  );
  assert.ok(labelOnHalo >= 4.5, `label/halo contrast ${labelOnHalo}`);
  for (const sample of GEOGRAPHY_SHELL_BASEMAP_CONTRAST_SAMPLES) {
    const haloOnBasemap = contrastRatio(GEOGRAPHY_MAP_STYLE.LABEL_HALO_COLOR, sample);
    // Halo stays light against quiet basemap samples; label contrast is via halo.
    assert.ok(haloOnBasemap != null);
    const labelThroughHalo = contrastRatio(GEOGRAPHY_MAP_STYLE.LABEL_TEXT_COLOR, sample);
    assert.ok(labelThroughHalo >= 4.5, `label vs basemap ${sample}: ${labelThroughHalo}`);
  }

  const entries = navigationAreaEntriesFromLayerDoc(NTA_LAYER, { layerType: "nta2020" });
  assert.ok(entries.every((entry) => !/^[A-Z]{2}\d{4}$/.test(entry.label)));
  assert.doesNotMatch(MAP_ISLAND_SOURCE, /map_runtime\.mjs/);
  assert.match(MAP_ISLAND_SOURCE, /createGeographyNavigationMap/);
});
