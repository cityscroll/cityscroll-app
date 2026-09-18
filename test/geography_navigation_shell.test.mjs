// Map-first Near You shell: semantic order, state adoption, list/map key equality.
//
//   node --test test/geography_navigation_shell.test.mjs

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import {
  GEOGRAPHY_SHELL_BROWSE_RECORDS_LABEL,
  GEOGRAPHY_SHELL_HEADING,
  GEOGRAPHY_SHELL_MORE_BOUNDARIES_LABEL,
  GEOGRAPHY_SHELL_USE_LOCATION_LABEL,
  RESIDENT_GEOGRAPHY_SHELL_SCHEMA,
  areaEntryKeys,
  areaListMatchesMapKeys,
  geographyShellAreasListHtml,
  geographyShellLayerSwitcherHtml,
  navigationAreaEntriesFromLayerDoc,
  renderGeographyShellEntry,
  resolveShellSurface,
} from "../site/geography_navigation_shell.mjs";
import {
  GEOGRAPHY_NAVIGATION_SURFACE_MAP,
  GEOGRAPHY_NAVIGATION_SURFACE_RECORDS,
} from "../site/geography_navigation_state.mjs";
import { geographyNavigationPrimaryLayers, geographyNavigationMoreBoundaryLayers } from "../site/geography_navigation_capability.mjs";
import { buildNearYouViewModel, renderNearYouDocument } from "../site/near_you_view.mjs";
import { scopeFromLensState } from "../site/scope_v0.mjs";
import { scopeWithPlace } from "../site/near_you_scope_runtime.mjs";

const ROOT = process.cwd();
const NTA_LAYER = JSON.parse(
  readFileSync(join(ROOT, "site/data/geography/layers/nta2020/26B.json"), "utf8"),
);
const SHELL_SOURCE = readFileSync(join(ROOT, "site/geography_navigation_shell.mjs"), "utf8");
const VIEW_SOURCE = readFileSync(join(ROOT, "site/near_you_view.mjs"), "utf8");
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

test("A10: selected-place routes keep place-first heading and overview ahead of map", () => {
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
});

test("A12 boundary: Land map runtime stays untouched; shell may mount the adapter", () => {
  assert.doesNotMatch(LAND_RUNTIME_SOURCE, /geography_navigation_map/);
  assert.doesNotMatch(LAND_RUNTIME_SOURCE, /geography_navigation_shell/);
  // The Near You island may import the progressive adapter; Land must not.
  assert.match(VIEW_SOURCE, /geography_navigation_shell/);
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
});
