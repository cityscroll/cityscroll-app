// The Land Map is a sibling of the List, not a dependency of it. These tests pin the
// activation boundary that makes that true: nothing map-shaped is fetched when the Land tab
// opens, the map's own module carries every map dependency, activation happens only for a
// route or control that asks for Map, and a map that cannot load leaves the same filtered
// List on screen with a way back and a way to retry.
//
// The module-size gate is part of the boundary, not housekeeping beside it: the activation
// logic had to land in a sibling module because `site/app/land.mjs` was 236 bytes below the
// hard 100,000-byte working bar. A regression that re-merges them is caught here as well as
// in test/site_module_architecture.test.mjs.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { buildLandMapModel } from "../site/land_map_model.mjs";
import {
  LAND_MAP_PANEL_ID,
  LAND_MAP_POINTS_URL,
  LAND_MAP_SHELL_SCHEMA,
  landMapFailureHTML,
  landMapPanelHTML,
  mountLandBrowseMap,
  unmountLandBrowseMap,
} from "../site/app/map_runtime.mjs";
import { ROUTE_ISLAND_MODULES, SITE_MODULES } from "./helpers/site_source.mjs";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

const landSrc = read("site/app/land.mjs");
const runtimeSrc = read("site/app/map_runtime.mjs");
const coreSrc = read("site/app/core.mjs");
const loaderSrc = read("site/app/main.mjs");
const routingSrc = read("site/app/routing.mjs");
const points = JSON.parse(read("site/data/land_project_map_points.json"));
const workingBar = JSON.parse(read("docs/evidence/index-module-split.json")).after.working_bar_bytes;

// Every remote origin the pre-activation Land route already carried for its detail map.
// This card moved them behind activation; it did not add to them and did not migrate them.
const DETAIL_MAP_HOSTS = ["unpkg.com", "{s}.basemaps.cartocdn.com"];

/* ===== A1: List first paint waits on nothing map-shaped ===== */

test("A1 opening the Land tab loads no map assets", () => {
  const landBranch = coreSrc.slice(coreSrc.indexOf('if(name==="land")'));
  const branch = landBranch.slice(0, landBranch.indexOf("\n"));
  assert.ok(branch.includes("landSearch()"), "Land entry still paints the List");
  assert.doesNotMatch(branch, /loadLeaflet/, "Land entry must not warm Leaflet");
  assert.doesNotMatch(branch, /map_runtime|ensureLandMapRuntime/, "Land entry must not pull the map runtime");
});

test("A1 the Land route module carries no map dependency of its own", () => {
  for (const marker of [/leaflet/i, /unpkg/i, /cartocdn/i, /L\.map\(/, /L\.tileLayer/, /land_project_map_points/]) {
    assert.doesNotMatch(landSrc, marker, `land.mjs still references ${marker}`);
  }
});

test("A1 the map runtime is registered behind activation, never awaited on load", () => {
  assert.match(loaderSrc, /globalThis\.ensureLandMapRuntime = \(\) => landMapRuntimePromise \|\|= import\("\.\/map_runtime\.mjs"\)/);
  assert.doesNotMatch(loaderSrc, /await import\("\.\/map_runtime\.mjs"\)/);
  assert.ok(
    SITE_MODULES.includes("map_runtime.mjs"),
    "the runtime stays in the ordered module graph so the size gate and digest still see it",
  );
});

test("A1 the split kept every application module under the working bar with headroom", () => {
  const sizes = Object.fromEntries([...SITE_MODULES, ...ROUTE_ISLAND_MODULES].map(
    (name) => [name, Buffer.byteLength(read(`site/app/${name}`))],
  ));
  assert.equal(workingBar, 100_000, "the hard module gate is unchanged");
  for (const [name, bytes] of Object.entries(sizes)) {
    assert.ok(bytes < workingBar, `${name}: ${bytes} bytes`);
  }
  // The card's premise: land.mjs was 236 bytes below the bar before the extraction.
  assert.ok(
    workingBar - sizes["land.mjs"] > 5_000,
    `land.mjs headroom is only ${workingBar - sizes["land.mjs"]} bytes`,
  );
});

/* ===== A2: activation loads only the approved substrate and projection ===== */

test("A2 the route activates the runtime only for a Map request", () => {
  assert.match(
    routingSrc,
    /if\(presentation\.requested===LAND_VIEW_MAP&&!renderer&&!landMapPresentationFailure\) activateLandMapRuntime\(\);/,
  );
  assert.match(routingSrc, /const ensure=globalThis\.ensureLandMapRuntime;/);
  // The only teardown trigger is an explicit List request, so a failed Map keeps its retry.
  assert.match(routingSrc, /if\(presentation\.requested===LAND_VIEW_LIST\)\{\s*\n\s*try\{ renderer\?\.unmount\?\.\(\); \}/);
});

test("A2 the runtime registers the renderer seam LM-04 left for it", () => {
  assert.match(runtimeSrc, /globalThis\.CROL_LAND_MAP_RENDERER = landBrowseMapRenderer;/);
  assert.equal(globalThis.CROL_LAND_MAP_RENDERER.schema, LAND_MAP_SHELL_SCHEMA);
  assert.equal(typeof globalThis.CROL_LAND_MAP_RENDERER.mount, "function");
  assert.equal(typeof globalThis.CROL_LAND_MAP_RENDERER.unmount, "function");
});

test("A2 browse Map activation requests exactly one approved projection path", () => {
  assert.equal(LAND_MAP_POINTS_URL, "data/land_project_map_points.json");
  const fetches = [...runtimeSrc.matchAll(/fetch\(([^,)]+)/g)].map((match) => match[1].trim());
  assert.deepEqual(fetches, ["LAND_MAP_POINTS_URL"], "the shell adds no second request");
  assert.equal(points.schema, "cityscroll.land_project_map_points.v1");
});

test("A2 no map SDK or tile provider is added, and the detail map keeps its own", () => {
  const hosts = [...runtimeSrc.matchAll(/https:\/\/([a-z0-9.{}-]+)/g)].map((match) => match[1]);
  const remote = [...new Set(hosts)].filter((host) => !host.startsWith("data.cityofnewyork.us"));
  assert.deepEqual(remote.sort(), [...DETAIL_MAP_HOSTS].sort(), "unexpected remote map dependency");
  // Those hosts stay inside the detail-map functions; the browse shell never reaches them.
  const shell = runtimeSrc.slice(runtimeSrc.indexOf("BROWSE MAP SHELL"));
  for (const host of ["unpkg", "cartocdn"]) assert.ok(!shell.includes(host), `${host} leaked into the browse shell`);
  assert.match(runtimeSrc, /from "\.\.\/map_exploration\.mjs"/, "the browse shell uses the local SVG substrate");
  assert.match(runtimeSrc, /from "\.\.\/land_map_model\.mjs"/, "the browse shell uses LM-03's filtered model");
});

test("A2 the detail map keeps every export the extraction moved", () => {
  for (const name of ["loadLeaflet", "landShowMap", "landShowLots", "wireLandPanControls", "resolveLandMapLocation"]) {
    assert.equal(typeof globalThis[name], "function", `${name} is no longer published`);
  }
  // land.mjs still owns the map DOM handle and the no-map path, so a resident who never
  // activates a map still gets the "location not resolved" note without loading the runtime.
  assert.match(landSrc, /function hideLandMap\(selection, reason\)\{/);
  assert.match(landSrc, /const \[runtime, propertyPayload, centroidLookup, bblSnapshot\] = await Promise\.all\(\[\s*\n\s*ensureLandMapRuntime\(\),/);
  for (const name of ["landSearch", "landSelect", "landRenderList", "paintLandRows"]) {
    assert.ok(landSrc.includes(`globalThis.${name} = ${name};`), `land.mjs stopped publishing ${name}`);
  }
});

/* ===== A3: a blocked or failed map leaves the same filtered List ===== */

function fakeElement(id = "") {
  const node = {
    id,
    className: "",
    dataset: {},
    children: [],
    innerHTML: "",
    attributes: {},
    parent: null,
    setAttribute(key, value) { this.attributes[key] = value; },
    insertBefore(child) { this.children.unshift(child); child.parent = this; return child; },
    get firstChild() { return this.children[0] || null; },
    querySelector(selector) {
      const attribute = selector.replace(/^\[|\]$/g, "");
      return this.innerHTML.includes(attribute) ? { addEventListener() {} } : null;
    },
    remove() {
      if (!this.parent) return;
      this.parent.children = this.parent.children.filter((child) => child !== this);
      this.parent = null;
    },
  };
  return node;
}

function landResultsGrid() {
  const grid = fakeElement("land-results-grid");
  const list = fakeElement("llist");
  list.innerHTML = "<div class=\"row\">2026R0127</div><div class=\"row\">2023K0183</div>";
  const detail = fakeElement("land-item-card");
  grid.children.push(list, detail);
  list.parent = grid;
  detail.parent = grid;
  return { grid, list, detail };
}

function installFakeDocument(fetchImpl) {
  const created = new Map();
  const previous = { document: globalThis.document, fetch: globalThis.fetch, t: globalThis.t };
  globalThis.document = {
    createElement() { return fakeElement(); },
    getElementById(id) { return created.get(id) || null; },
  };
  globalThis.fetch = fetchImpl;
  globalThis.t = (key, values = {}) => Object.entries(values)
    .reduce((copy, [name, value]) => copy.replaceAll(`{${name}}`, String(value)), key);
  return {
    register(node) { created.set(node.id, node); },
    restore() { Object.assign(globalThis, previous); },
  };
}

async function mountWith(fetchImpl) {
  const { grid, list, detail } = landResultsGrid();
  const dom = installFakeDocument(fetchImpl);
  const rows = [{ project_id: "2026R0127" }, { project_id: "2023K0183" }, { project_id: "no-such-project" }];
  let panel = null;
  let error = null;
  const originalCreate = globalThis.document.createElement;
  globalThis.document.createElement = () => {
    const node = originalCreate();
    node.id = LAND_MAP_PANEL_ID;
    dom.register(node);
    return node;
  };
  try {
    panel = await mountLandBrowseMap(grid, { rows });
  } catch (thrown) {
    error = thrown;
    panel = globalThis.document.getElementById(LAND_MAP_PANEL_ID);
  } finally {
    dom.restore();
  }
  return { grid, list, detail, panel, error, rows };
}

const blocked = () => Promise.reject(new TypeError("blocked by the browser"));
const notFound = () => Promise.resolve({ ok: false, status: 404, json: () => Promise.resolve(null) });
const malformed = () => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ schema: "x" }) });

for (const [label, fetchImpl] of [["blocked", blocked], ["404", notFound], ["malformed", malformed]]) {
  test(`A3 a ${label} projection leaves the filtered List intact and offers a way forward`, async () => {
    const { grid, list, panel, error } = await mountWith(fetchImpl);
    assert.ok(error instanceof Error, "the failure reaches the route so the switch can fall back");
    assert.equal(panel.dataset.landMapState, "failed");
    assert.match(panel.innerHTML, /data-land-map-retry/, "no retry control");
    assert.match(panel.innerHTML, /data-land-map-dismiss/, "no direct return to List");
    // The list panel, its rows, and the detail panel are exactly as List left them.
    assert.ok(grid.children.includes(list), "the List panel was removed");
    assert.match(list.innerHTML, /2026R0127/);
    assert.match(list.innerHTML, /2023K0183/);
    assert.equal(grid.children.filter((child) => child.id === "llist").length, 1);
  });
}

test("A3 a successful mount adds the map beside the List rather than replacing it", async () => {
  const payload = JSON.parse(read("site/data/land_project_map_points.json"));
  const { grid, list, detail, panel, error, rows } = await mountWith(
    () => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(payload) }),
  );
  assert.equal(error, null);
  assert.equal(panel.dataset.landMapState, "ready");
  assert.ok(grid.children.includes(list) && grid.children.includes(detail));
  assert.equal(grid.children[0], panel, "the map mounts as a sibling above the list");

  const model = buildLandMapModel({ rows, pointLookup: payload });
  const markers = [...panel.innerHTML.matchAll(/class="land-map-marker"/g)].length;
  assert.equal(markers, model.counts.mapped, "one marker per mapped row, no invented points");
  assert.equal(model.counts.total, rows.length);
  assert.ok(model.counts.unmapped >= 1, "the unrepresented row stays an explicit unmapped identity");
  assert.match(panel.innerHTML, new RegExp(`${model.counts.mapped}.*${model.counts.total}`));
});

test("A3 leaving Map removes only the map panel", () => {
  const { grid, list } = landResultsGrid();
  const panel = fakeElement(LAND_MAP_PANEL_ID);
  grid.insertBefore(panel);
  const dom = installFakeDocument(() => Promise.reject(new Error("unused")));
  dom.register(panel);
  try {
    unmountLandBrowseMap();
  } finally {
    dom.restore();
  }
  assert.ok(!grid.children.includes(panel));
  assert.ok(grid.children.includes(list));
});

test("A3 the failure copy names the two ways forward in plain language", () => {
  const copy = (key) => key;
  const html = landMapFailureHTML({ t: copy });
  assert.match(html, /land_map_failed_heading/);
  assert.match(html, /land_map_retry/);
  assert.match(html, /land_map_show_list/);
  for (const key of ["land_map_failed_heading", "land_map_retry", "land_map_show_list", "land_map_summary"]) {
    assert.ok(read("site/i18n.js").includes(`${key}:`), `${key} has no English string`);
  }
});

test("A3 an empty projection join is reported honestly, not as an empty map", () => {
  const html = landMapPanelHTML(
    buildLandMapModel({ rows: [{ project_id: "unmapped-only" }], pointLookup: { points: {} } }),
    { t: (key, values = {}) => `${key}:${JSON.stringify(values)}` },
  );
  assert.match(html, /land_map_summary:\{&quot;mapped&quot;:0,&quot;total&quot;:1\}/);
  assert.match(html, /land_map_unmapped_note/);
});

/* ===== A4: the receipts name what was measured ===== */

test("A4 the activation receipt reports cold and warm List-versus-Map cost", () => {
  const receipt = JSON.parse(read("docs/evidence/land-map-route-lazy-shell.json"));
  assert.equal(receipt.schema, "cityscroll.land-map-route-lazy-shell-receipt.v1");
  assert.match(receipt.browser_mode, /headless chromium/);
  assert.equal(receipt.routes.list, "/browse/zoning/?boro=Queens&stage=public_review");
  assert.equal(receipt.routes.map, "/browse/zoning/?boro=Queens&stage=public_review&view=map");
  assert.deepEqual(receipt.viewports, [[390, 844], [1440, 900]]);

  // The gate, with the exact command and the exact byte counts it was run against.
  const gate = receipt.module_size_gate;
  assert.equal(gate.limit_bytes, 100_000);
  assert.equal(gate.limit_bytes, workingBar, "the receipt and the gate disagree about the limit");
  assert.equal(gate.command, "node --test test/site_module_architecture.test.mjs");
  assert.ok(gate.before["site/app/land.mjs"] > gate.limit_bytes - 1_000, "the card's premise: land.mjs was at the gate");
  assert.equal(gate.after["site/app/land.mjs"], Buffer.byteLength(landSrc), "stale land.mjs measurement");
  assert.equal(gate.after["site/app/map_runtime.mjs"], Buffer.byteLength(runtimeSrc), "stale map_runtime.mjs measurement");
  assert.ok(gate.after["site/app/land.mjs"] < gate.limit_bytes);

  // The measured comparison the card asks for, rather than an unmeasured speedup claim.
  assert.ok(
    receipt.before_land_entry.first_paint_ordering.blocking_map_dependencies_before_first_row
      .some((url) => url.includes("leaflet")),
    "the before tree's Land entry did warm Leaflet before first paint",
  );
  for (const state of ["cold", "warm"]) {
    const measurement = receipt.measurements[state];
    assert.ok(measurement, `${state} measurement missing`);
    assert.equal(measurement.cache_state, state);
    assert.ok(measurement.list_first_paint_ms > 0);
    assert.ok(measurement.list_first_paint_ordering.first_row_at_ms >= 0, "first paint was never observed");
    assert.deepEqual(
      measurement.list_first_paint_ordering.blocking_map_dependencies_before_first_row,
      [],
      `List first paint waited on a map dependency (${state})`,
    );
    // Activation's cost is the projection, and nothing else new from this origin.
    const activation = measurement.map_activation_requests.filter((entry) => entry.url.startsWith("/"));
    assert.deepEqual(activation.map((entry) => entry.url), [`/${LAND_MAP_POINTS_URL}`]);
    assert.ok(measurement.map_activation_bytes > 0);
    assert.ok(measurement.map_activation_ms > 0);
    assert.equal(measurement.map_observed.map_state, "ready");
    assert.ok(measurement.map_observed.map_markers > 0, "activation painted no markers");
    assert.equal(measurement.map_observed.rows, measurement.list_observed.rows, "Map changed the result set");
    // The auto-selected detail map is reported as its own phase, not folded into List.
    assert.ok(Array.isArray(measurement.post_paint_detail_map.requests));
  }
  assert.equal(receipt.dependency_identity.projection, LAND_MAP_POINTS_URL);
  assert.match(receipt.dependency_identity.substrate, /map_exploration\.mjs/);
  assert.match(receipt.dependency_identity.model, /land_map_model\.mjs/);
  assert.equal(
    receipt.dependency_identity.snapshot_vintage.projection_schema,
    "cityscroll.land_project_map_points.v1",
  );
  for (const input of Object.values(receipt.dependency_identity.snapshot_vintage.inputs)) {
    assert.match(input.sha256, /^[0-9a-f]{64}$/);
  }

  // A blocked projection leaves the same filtered List, and says so with numbers.
  const failure = receipt.failure_behavior;
  assert.equal(failure.blocked_request, LAND_MAP_POINTS_URL);
  assert.ok(failure.list_rows_after_failure > 0);
  assert.equal(failure.list_rows_after_failure, failure.list_rows_before_failure);
  assert.deepEqual(failure.semantic_filters_after_failure, ["boro=Queens", "stage=public_review"]);
  assert.equal(failure.retry_control_present, true);
  assert.equal(failure.list_control_pressed, true);
  assert.ok(failure.fallback_note.length > 0);

  // Every capture the card asks for, at both viewports.
  const names = receipt.files.map((file) => file.name.replaceAll("\\", "/"));
  for (const width of [390, 1440]) {
    for (const name of [
      `before/land-list-${width}.png`,
      `after/land-list-${width}.png`,
      `after/land-map-${width}.png`,
      `after/land-map-blocked-${width}.png`,
    ]) {
      assert.ok(names.includes(name), `missing capture ${name}`);
    }
  }
});
