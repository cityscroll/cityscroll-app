// Progressive Near You map runtime — renderer seam and fallback contract.
//
//   node --test test/geography_navigation_runtime.test.mjs

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import {
  GEOGRAPHY_MAP_BASEMAP,
  GEOGRAPHY_MAP_FALLBACK_REASONS,
  GEOGRAPHY_MAP_LAYER_IDS,
  GEOGRAPHY_MAP_SOURCE_IDS,
  GEOGRAPHY_MAP_STYLE,
  MAPLIBRE_PIN,
  RESIDENT_GEOGRAPHY_MAP_SCHEMA,
  createGeographyNavigationMap,
  hideServerMapFallback,
  importPinnedMapLibre,
  interiorLabelLonLat,
  isPublisherGisUrl,
  loadSimplifiedNavigationLayer,
  projectLayerCollectionForMap,
  restoreServerMapFallback,
  simplifiedLayerSiteUrl,
  __test__,
} from "../site/geography_navigation_map.mjs";
import { GEOGRAPHY_NAVIGATION_LAYER_TYPES } from "../site/geography_navigation_capability.mjs";

const ROOT = process.cwd();
const MODULE_PATH = "site/geography_navigation_map.mjs";
const MODULE_SOURCE = readFileSync(join(ROOT, MODULE_PATH), "utf8");
const LAND_RUNTIME_SOURCE = readFileSync(join(ROOT, "site/app/map_runtime.mjs"), "utf8");
const LAND_APP_SOURCE = readFileSync(join(ROOT, "site/app/land.mjs"), "utf8");
const MAP_ISLAND_SOURCE = readFileSync(join(ROOT, "site/app/map.mjs"), "utf8");
const LICENSE = readFileSync(join(ROOT, "LICENSE"), "utf8");
const MAPLIBRE_LICENSE = readFileSync(join(ROOT, "site/vendor/maplibre-gl-LICENSE.txt"), "utf8");
const INVENTORY = JSON.parse(
  readFileSync(join(ROOT, "architecture/site-production-determinism.json"), "utf8"),
);
const LAYER_REGISTRY = JSON.parse(
  readFileSync(join(ROOT, "site/data/geography/layer_registry.json"), "utf8"),
);
const NTA_LAYER = JSON.parse(
  readFileSync(join(ROOT, "site/data/geography/layers/nta2020/26B.json"), "utf8"),
);

function sheepheadFeature() {
  return NTA_LAYER.features.find((feature) => feature.id === "BK1503");
}

function parkFeature() {
  return NTA_LAYER.features.find((feature) => feature.id === "BK5591");
}

function fakeDocument() {
  const nodes = new Map();
  const headChildren = [];
  const head = {
    appendChild(node) {
      headChildren.push(node);
      return node;
    },
    querySelector(selector) {
      if (selector.startsWith("link[")) {
        return headChildren.find((node) => node.rel === "stylesheet") || null;
      }
      return null;
    },
  };
  const documentRef = {
    head,
    createElement(tag) {
      const node = {
        tagName: tag,
        rel: "",
        href: "",
        src: "",
        async: false,
        dataset: {},
        onload: null,
        onerror: null,
        getContext() {
          return {};
        },
      };
      return node;
    },
    querySelector() {
      return null;
    },
  };
  return { documentRef, headChildren, nodes };
}

function createFakeMap() {
  const sources = new Map();
  const featureState = new Map();
  const filters = new Map();
  const handlers = new Map();
  const calls = {
    fitBounds: [],
    flyTo: [],
    jumpTo: [],
    easeTo: [],
    panBy: [],
    setData: [],
    remove: 0,
  };

  const map = {
    calls,
    sources,
    featureState,
    filters,
    on(type, handler) {
      if (!handlers.has(type)) handlers.set(type, []);
      handlers.get(type).push(handler);
    },
    off(type, handler) {
      const list = handlers.get(type) || [];
      handlers.set(type, list.filter((entry) => entry !== handler));
    },
    emit(type, event) {
      for (const handler of handlers.get(type) || []) handler(event);
    },
    getSource(id) {
      return sources.get(id) || null;
    },
    setFeatureState(ref, state) {
      const key = `${ref.source}:${ref.id}`;
      featureState.set(key, { ...(featureState.get(key) || {}), ...state });
    },
    setFilter(layerId, filter) {
      filters.set(layerId, filter);
    },
    queryRenderedFeatures(point, { layers } = {}) {
      const active = sources.get(GEOGRAPHY_MAP_SOURCE_IDS.active)?.data?.features || [];
      if (!active.length) return [];
      return [{
        properties: active[0].properties,
        layer: { id: layers?.[0] },
      }];
    },
    fitBounds(bounds, options) {
      calls.fitBounds.push({ bounds, options });
    },
    flyTo(options) {
      calls.flyTo.push(options);
    },
    jumpTo(options) {
      calls.jumpTo.push(options);
    },
    easeTo(options) {
      calls.easeTo.push(options);
    },
    panBy(offset, options) {
      calls.panBy.push({ offset, options });
    },
    getZoom() {
      return 10;
    },
    getCenter() {
      return { lng: -73.95, lat: 40.7 };
    },
    remove() {
      calls.remove += 1;
    },
  };

  return {
    map,
    createMap(_maplibregl, options) {
      for (const [id, source] of Object.entries(options.style.sources)) {
        if (source.type === "geojson") {
          sources.set(id, {
            type: "geojson",
            data: source.data,
            setData(data) {
              this.data = data;
              calls.setData.push({ id, data });
            },
          });
        } else {
          sources.set(id, source);
        }
      }
      return map;
    },
  };
}

function fakeRoot() {
  const svgPaths = [
    { dataset: {}, getAttribute: () => "0", setAttribute() {}, removeAttribute() {} },
  ];
  const svg = {
    hidden: false,
    attributes: {},
    setAttribute(name, value) { this.attributes[name] = value; },
    removeAttribute(name) { delete this.attributes[name]; },
    getAttribute(name) { return this.attributes[name]; },
    querySelectorAll(selector) {
      if (selector.includes("tabindex")) return svgPaths;
      return [];
    },
  };
  const buttons = [
    { hidden: false, dataset: {}, setAttribute() {}, removeAttribute() {} },
    { hidden: false, dataset: {}, setAttribute() {}, removeAttribute() {} },
  ];
  const host = {
    hidden: true,
    attributes: { "aria-hidden": "true" },
    tabIndex: 0,
    listeners: {},
    setAttribute(name, value) { this.attributes[name] = value; },
    removeAttribute(name) { delete this.attributes[name]; },
    hasAttribute(name) { return Object.prototype.hasOwnProperty.call(this.attributes, name); },
    replaceChildren() { this.children = []; },
    addEventListener(type, handler) {
      this.listeners[type] = handler;
    },
    removeEventListener(type, handler) {
      if (this.listeners[type] === handler) delete this.listeners[type];
    },
  };
  const wrap = { dataset: {} };
  const root = {
    dataset: {},
    querySelector(selector) {
      if (selector === "#nearMapSvg") return svg;
      if (selector === ".near-map-wrap") return wrap;
      return null;
    },
    querySelectorAll(selector) {
      if (selector.includes("data-map-zoom") || selector.includes("data-map-pan")) return buttons;
      return [];
    },
  };
  return { root, svg, host, wrap, buttons };
}

test("schema and style constants meet the binding visual hierarchy", () => {
  assert.equal(RESIDENT_GEOGRAPHY_MAP_SCHEMA, "cityscroll.resident_geography_map.v1");
  assert.doesNotMatch(RESIDENT_GEOGRAPHY_MAP_SCHEMA, /geography_navigation/);
  assert.ok(GEOGRAPHY_MAP_STYLE.ACTIVE_FILL_OPACITY >= 0.08);
  assert.ok(GEOGRAPHY_MAP_STYLE.ACTIVE_FILL_OPACITY <= 0.14);
  assert.equal(GEOGRAPHY_MAP_STYLE.ACTIVE_LINE_WIDTH, 1);
  assert.ok(GEOGRAPHY_MAP_STYLE.HOVER_LINE_WIDTH >= 2);
  assert.ok(GEOGRAPHY_MAP_STYLE.SELECTED_LINE_WIDTH >= 3);
  assert.ok(GEOGRAPHY_MAP_STYLE.SELECTED_FILL_OPACITY <= 0.24);
  assert.deepEqual(GEOGRAPHY_MAP_STYLE.COMPARISON_LINE_DASHARRAY, [2, 2]);
  assert.notDeepEqual(
    GEOGRAPHY_MAP_STYLE.SELECTED_LINE_DASHARRAY,
    GEOGRAPHY_MAP_STYLE.COMPARISON_LINE_DASHARRAY,
  );
  assert.ok(GEOGRAPHY_MAP_STYLE.FORCED_COLORS_SELECTED_LINE_WIDTH >= GEOGRAPHY_MAP_STYLE.SELECTED_LINE_WIDTH);
  assert.match(GEOGRAPHY_MAP_BASEMAP.attribution, /OpenStreetMap/);
  assert.match(GEOGRAPHY_MAP_BASEMAP.attribution, /CARTO/);
  assert.equal(GEOGRAPHY_MAP_BASEMAP.role, "contextual_decoration");
  assert.equal(MAPLIBRE_PIN.license, "BSD-3-Clause");
});

test("A3: simplified layer URLs come from committed artifacts; publisher GIS URLs are rejected", () => {
  for (const type of GEOGRAPHY_NAVIGATION_LAYER_TYPES) {
    const url = simplifiedLayerSiteUrl(type, LAYER_REGISTRY);
    assert.ok(url, type);
    assert.match(url, /^\/data\/geography\/layers\//);
    assert.equal(isPublisherGisUrl(url), false);
  }
  assert.equal(
    isPublisherGisUrl("https://s-media.nyc.gov/agencies/dcp/assets/files/zip/data-tools/bytes/x.zip"),
    true,
  );
  assert.equal(
    isPublisherGisUrl("https://data.cityofnewyork.us/resource/i6mn-amj2.geojson"),
    true,
  );
  assert.equal(simplifiedLayerSiteUrl("sanitation_district", LAYER_REGISTRY), null);
});

test("A4/A13: projected features keep canonical labels and interior anchors; codes are not primary text", () => {
  const projected = projectLayerCollectionForMap(NTA_LAYER, { layerType: "nta2020" });
  assert.equal(projected.geometry_fidelity, "simplified");
  const sheep = projected.features.find((feature) => feature.properties.id === "BK1503");
  assert.ok(sheep);
  assert.equal(sheep.properties.label, "Sheepshead Bay-Manhattan Beach-Gerritsen Beach");
  assert.equal(sheep.properties.key, "geography:nta2020:BK1503");
  assert.equal(sheep.properties.may_label_as_neighborhood, true);
  assert.equal(sheep.properties.is_special_use, false);
  assert.ok(Number.isFinite(sheep.properties.label_lon));
  assert.ok(Number.isFinite(sheep.properties.label_lat));
  assert.doesNotMatch(sheep.properties.label, /^BK\d{4}$/);

  const park = projected.features.find((feature) => feature.properties.id === "BK5591");
  assert.ok(park);
  assert.equal(park.properties.label, "Prospect Park");
  assert.equal(park.properties.may_label_as_neighborhood, false);
  assert.equal(park.properties.is_special_use, true);

  const anchor = interiorLabelLonLat(sheepheadFeature());
  assert.ok(anchor);
  assert.equal(anchor.length, 2);
});

test("A1/A2/A8: renderer seam drives pan, zoom, selection, comparison persistence, and reduced-motion fit", async () => {
  const { root, host } = fakeRoot();
  const fake = createFakeMap();
  const selections = [];
  const controller = await createGeographyNavigationMap({
    container: host,
    root,
    reducedMotion: true,
    importMapLibre: async () => ({ Map: function Map() {} }),
    createMap: fake.createMap,
    onSelect: (event) => selections.push(event),
  });

  assert.equal(controller.schema, RESIDENT_GEOGRAPHY_MAP_SCHEMA);
  assert.equal(controller.reducedMotion, true);
  assert.equal(root.dataset.nearMapRuntime, "maplibre");

  controller.setActiveLayer("nta2020", NTA_LAYER);
  controller.setSelectedKey("geography:nta2020:BK1503");
  const beforeCompare = fake.map.getSource(GEOGRAPHY_MAP_SOURCE_IDS.selected).data.features;
  assert.equal(beforeCompare.length, 1);
  assert.equal(beforeCompare[0].properties.id, "BK1503");

  const council = {
    type: "council_district",
    geometry_fidelity: "simplified",
    features: [{
      id: "48",
      key: "geography:council_district:48",
      type: "council_district",
      label: "City Council District 48",
      geometry: sheepheadFeature().geometry,
      bbox: sheepheadFeature().bbox,
    }],
  };
  controller.setComparisonLayer("council_district", council);
  const afterCompare = fake.map.getSource(GEOGRAPHY_MAP_SOURCE_IDS.selected).data.features;
  assert.equal(afterCompare.length, 1);
  assert.equal(afterCompare[0].properties.key, "geography:nta2020:BK1503");
  assert.equal(controller.getState().selectedKey, "geography:nta2020:BK1503");
  assert.equal(controller.getState().comparisonType, "council_district");

  controller.fitSelection({ maxZoom: 13 });
  assert.equal(fake.map.calls.fitBounds.length, 1);
  assert.equal(fake.map.calls.fitBounds[0].options.animate, false);
  assert.equal(fake.map.calls.fitBounds[0].options.duration, 0);
  assert.equal(fake.map.calls.flyTo.length, 0);

  controller.zoomBy(1);
  assert.ok(fake.map.calls.jumpTo.length >= 1);
  controller.panBy([40, 0]);
  assert.equal(fake.map.calls.panBy.length, 1);
  assert.equal(fake.map.calls.panBy[0].options.animate, false);

  controller.setFocusedKey("geography:nta2020:BK1503");
  host.listeners.keydown?.({ key: "Enter", preventDefault() {} });
  assert.ok(selections.some((event) => event.method === "keyboard"));

  controller.setPointMarker([-73.9542, 40.5869]);
  assert.equal(
    fake.map.getSource(GEOGRAPHY_MAP_SOURCE_IDS.point).data.features[0].geometry.coordinates[0],
    -73.9542,
  );

  controller.destroy();
  assert.equal(fake.map.calls.remove, 1);
  assert.equal(root.dataset.nearMapRuntime, "svg");
});

test("A5: basemap attribution is present; tile failure does not destroy local layers", async () => {
  const { root, host } = fakeRoot();
  const fake = createFakeMap();
  const tileFailures = [];
  const fallbacks = [];
  const controller = await createGeographyNavigationMap({
    container: host,
    root,
    reducedMotion: true,
    importMapLibre: async () => ({ Map: function Map() {} }),
    createMap: fake.createMap,
    onTileFailure: (reason) => tileFailures.push(reason),
    onFallback: (reason) => fallbacks.push(reason),
  });
  controller.setActiveLayer("nta2020", NTA_LAYER);
  controller.setSelectedKey("geography:nta2020:BK1503");

  const style = __test__.buildBaseStyle();
  assert.equal(style.sources[GEOGRAPHY_MAP_SOURCE_IDS.basemap].attribution, GEOGRAPHY_MAP_BASEMAP.attribution);
  assert.deepEqual(style.sources[GEOGRAPHY_MAP_SOURCE_IDS.basemap].tiles, [...GEOGRAPHY_MAP_BASEMAP.tiles]);

  fake.map.emit("error", { error: new Error("basemap tile failed from cartocdn") });
  assert.deepEqual(tileFailures, [GEOGRAPHY_MAP_FALLBACK_REASONS.tile_failure]);
  assert.equal(fallbacks.length, 0);
  assert.equal(controller.getState().selectedKey, "geography:nta2020:BK1503");
  assert.ok(fake.map.getSource(GEOGRAPHY_MAP_SOURCE_IDS.active).data.features.length > 0);
  controller.destroy();
});

test("A6: dynamic-import, WebGL, context-loss, style, and layer failures restore the SVG fallback", async () => {
  const { root, host, svg, buttons } = fakeRoot();

  await assert.rejects(
    () => createGeographyNavigationMap({
      container: host,
      root,
      webglSupported: true,
      importMapLibre: async () => {
        throw new Error(GEOGRAPHY_MAP_FALLBACK_REASONS.dynamic_import);
      },
    }),
    /dynamic_import_failure/,
  );
  assert.equal(svg.hidden, false);
  assert.equal(root.dataset.nearMapRuntime, "failed");

  const noWebGlDoc = {
    head: { appendChild() {}, querySelector() { return null; } },
    createElement() {
      return { getContext() { return null; }, dataset: {} };
    },
  };
  await assert.rejects(
    () => createGeographyNavigationMap({
      container: host,
      root,
      documentRef: noWebGlDoc,
      webglSupported: false,
      importMapLibre: async () => ({ Map: function Map() {} }),
    }),
    /webgl_unsupported/,
  );

  const fake = createFakeMap();
  const controller = await createGeographyNavigationMap({
    container: host,
    root,
    importMapLibre: async () => ({ Map: function Map() {} }),
    createMap: fake.createMap,
  });
  hideServerMapFallback(root, { enhancedHost: host });
  assert.equal(svg.hidden, true);
  assert.equal(buttons[0].hidden, true);

  fake.map.emit("webglcontextlost");
  assert.equal(svg.hidden, false);
  assert.equal(root.dataset.nearMapRuntime, "failed");
  assert.equal(root.dataset.nearMapRuntimeReason, GEOGRAPHY_MAP_FALLBACK_REASONS.context_lost);

  restoreServerMapFallback(root, { enhancedHost: host });
  assert.equal(host.hidden, true);
  assert.ok(buttons.every((button) => button.hidden === false || button.dataset.geographyMapPrevHidden === undefined));
});

test("A6 layer-load failure restores fallback when fidelity is not simplified", async () => {
  const { root, host } = fakeRoot();
  const fake = createFakeMap();
  const controller = await createGeographyNavigationMap({
    container: host,
    root,
    importMapLibre: async () => ({ Map: function Map() {} }),
    createMap: fake.createMap,
  });
  assert.throws(
    () => controller.setActiveLayer("nta2020", { ...NTA_LAYER, geometry_fidelity: "full" }),
    /local_layer_failure/,
  );
  assert.equal(root.dataset.nearMapRuntime, "failed");
});

test("A7: MapLibre loads only through the adapter seam; Land does not adopt it", () => {
  assert.match(MODULE_SOURCE, /importPinnedMapLibre|createGeographyNavigationMap/);
  assert.doesNotMatch(MODULE_SOURCE, /from\s+["'].*map_runtime\.mjs["']/);
  assert.doesNotMatch(MODULE_SOURCE, /ensureLandMapRuntime|landShowMap|L\.map\s*\(/);
  assert.doesNotMatch(MODULE_SOURCE, /getCurrentPosition|navigator\.geolocation/);
  assert.doesNotMatch(LAND_RUNTIME_SOURCE, /geography_navigation_map/);
  assert.doesNotMatch(LAND_APP_SOURCE, /geography_navigation_map/);
  // Near You island mounts the progressive adapter; Land stays on map_runtime.
  assert.match(MAP_ISLAND_SOURCE, /geography_navigation_map/);
  assert.doesNotMatch(MAP_ISLAND_SOURCE, /map_runtime\.mjs/);
  assert.equal(typeof importPinnedMapLibre, "function");
});

test("A9: MapLibre license is retained; no GPL or BetaNYC dependency", () => {
  assert.match(MAPLIBRE_LICENSE, /BSD/);
  assert.match(MAPLIBRE_LICENSE, /MapLibre/);
  assert.doesNotMatch(MAPLIBRE_LICENSE, /GNU General Public License|GPL-3/);
  assert.match(LICENSE, /MIT License/);
  assert.doesNotMatch(MODULE_SOURCE, /BetaNYC|beta\.nyc|betanyc/i);
  assert.doesNotMatch(MODULE_SOURCE, /gpl-3\.0|GPL-3/);
  const thirdPartyPaths = (INVENTORY.third_party || []).map((entry) => entry.path);
  assert.ok(thirdPartyPaths.includes(`site/${MAPLIBRE_PIN.js}`));
  assert.ok(thirdPartyPaths.includes(`site/${MAPLIBRE_PIN.worker}`));
});

test("A10: inventory includes the public module; adapter never computes membership or overlap", async () => {
  assert.ok(INVENTORY.modules.includes(MODULE_PATH));
  assert.doesNotMatch(MODULE_SOURCE, /pct_from|pct_to|overlayCivic|record_membership|geography_items/);
  assert.doesNotMatch(MODULE_SOURCE, /choroplethFill/);

  const docs = [];
  const collection = await loadSimplifiedNavigationLayer("nta2020", {
    registry: LAYER_REGISTRY,
    fetchImpl: async (url) => {
      assert.equal(isPublisherGisUrl(url), false);
      docs.push(url);
      return {
        ok: true,
        async json() { return NTA_LAYER; },
      };
    },
  });
  assert.equal(docs.length, 1);
  assert.ok(collection.features.some((feature) => feature.properties.id === "BK1503"));

  await assert.rejects(
    () => loadSimplifiedNavigationLayer("nta2020", {
      registry: {
        layers: [{
          type: "nta2020",
          artifacts: {
            simplified: {
              site_path: "https://data.cityofnewyork.us/resource/i6mn-amj2.geojson",
            },
          },
        }],
      },
      fetchImpl: async () => {
        throw new Error("should not fetch");
      },
    }),
    /layer_load|publisher_gis|simplified/,
  );
});

test("A12: style paint uses named constants; ordinary map is not a choropleth", () => {
  const style = __test__.buildBaseStyle();
  const activeFill = style.layers.find((layer) => layer.id === GEOGRAPHY_MAP_LAYER_IDS.activeFill);
  const selectedLine = style.layers.find((layer) => layer.id === GEOGRAPHY_MAP_LAYER_IDS.selectedLine);
  const comparisonLine = style.layers.find((layer) => layer.id === GEOGRAPHY_MAP_LAYER_IDS.comparisonLine);
  const labels = style.layers.find((layer) => layer.id === GEOGRAPHY_MAP_LAYER_IDS.labels);
  const selectedLabel = style.layers.find((layer) => layer.id === GEOGRAPHY_MAP_LAYER_IDS.selectedLabel);

  assert.equal(activeFill.paint["fill-opacity"], GEOGRAPHY_MAP_STYLE.ACTIVE_FILL_OPACITY);
  assert.equal(selectedLine.paint["line-width"], GEOGRAPHY_MAP_STYLE.SELECTED_LINE_WIDTH);
  assert.deepEqual(comparisonLine.paint["line-dasharray"], [...GEOGRAPHY_MAP_STYLE.COMPARISON_LINE_DASHARRAY]);
  assert.equal(labels.layout["text-allow-overlap"], false);
  assert.equal(labels.layout["text-field"][1], "label");
  assert.equal(selectedLabel.layout["text-allow-overlap"], true);
  assert.equal(selectedLabel.layout["text-field"][1], "label");
  assert.doesNotMatch(JSON.stringify(style), /choropleth|fill-color.*interpolate.*count/i);
});

test("A13 special-use labels stay off the ordinary filter until zoom or selection", async () => {
  const { root, host } = fakeRoot();
  const fake = createFakeMap();
  const controller = await createGeographyNavigationMap({
    container: host,
    root,
    importMapLibre: async () => ({ Map: function Map() {} }),
    createMap: fake.createMap,
  });
  controller.setActiveLayer("nta2020", {
    type: "nta2020",
    geometry_fidelity: "simplified",
    features: [parkFeature()],
  });
  const filterBefore = fake.map.filters.get(GEOGRAPHY_MAP_LAYER_IDS.labels);
  assert.ok(filterBefore);
  controller.setSelectedKey("geography:nta2020:BK5591");
  const filterAfter = fake.map.filters.get(GEOGRAPHY_MAP_LAYER_IDS.labels);
  assert.ok(JSON.stringify(filterAfter).includes("geography:nta2020:BK5591"));
  controller.destroy();
});
