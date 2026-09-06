// LM-12: fixed List/Map budgets, deferred-request bounds, and typed failure states, proven at
// the mount boundary. site/land_map_performance_budget.mjs (test/land_map_performance_
// budget.test.mjs) owns the classification and retry rules in isolation; this file proves the
// browse Map shell (site/app/map_runtime.mjs) actually applies them: List stays complete and
// canonical through every one of the five failure kinds, activation never exceeds its fixed
// deferred-request budget, and a transient failure that clears within the bounded retry still
// reaches the same ready map a resident on a clean connection would have seen.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { beforeEach, test } from "node:test";

import { buildLandMapModel } from "../site/land_map_model.mjs";
import { LAND_MAP_BUDGETS, LAND_MAP_FAILURE_KINDS } from "../site/land_map_performance_budget.mjs";
import {
  LAND_MAP_PANEL_ID,
  __resetLandMapRuntimeCachesForTests,
  mountLandBrowseMap,
} from "../site/app/map_runtime.mjs";

// The shell memoizes both its own-origin fetches for the resident's page session (LM-12's
// __resetLandMapRuntimeCachesForTests exists for exactly this): each test here exercises a
// distinct fetch outcome and needs a fresh attempt rather than the previous test's cached one.
beforeEach(() => { __resetLandMapRuntimeCachesForTests(); });

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const points = JSON.parse(read("site/data/land_project_map_points.json"));

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

function landResultsGrid(rowIds) {
  const grid = fakeElement("land-results-grid");
  const list = fakeElement("llist");
  list.innerHTML = rowIds.map((id) => `<div class="row">${id}</div>`).join("");
  grid.children.push(list);
  list.parent = grid;
  return { grid, list };
}

function installFakeDocument(fetchImpl) {
  const created = new Map();
  const previous = { document: globalThis.document, fetch: globalThis.fetch, t: globalThis.t };
  globalThis.document = {
    createElement() {
      const node = fakeElement();
      node.id = LAND_MAP_PANEL_ID;
      created.set(node.id, node);
      return node;
    },
    getElementById(id) { return created.get(id) || null; },
  };
  globalThis.fetch = fetchImpl;
  globalThis.t = (key, values = {}) => Object.entries(values)
    .reduce((copy, [name, value]) => copy.replaceAll(`{${name}}`, String(value)), key);
  return { restore() { Object.assign(globalThis, previous); } };
}

/** A fetch fake that counts calls and routes by URL substring, so a test can assert both the
 * total deferred-request count and which artifact a given failure came from. */
function countingFetch(handlers, calls) {
  return (url, init) => {
    calls.total += 1;
    calls.urls.push(url);
    for (const [marker, handler] of handlers) {
      if (url.includes(marker)) return Promise.resolve(handler(url, init));
    }
    return Promise.resolve({ ok: false, status: 404 });
  };
}

const READY_BOUNDARY = { ok: true, status: 200, json: () => Promise.resolve({ schema: "cityscroll.geography_layer.v1", features: [] }) };
const READY_PROJECTION = () => ({ ok: true, status: 200, json: () => Promise.resolve(points) });

async function mount(rows, fetchImpl) {
  const { grid, list } = landResultsGrid(rows.map((row) => row.project_id));
  const dom = installFakeDocument(fetchImpl);
  let error = null;
  try {
    await mountLandBrowseMap(grid, { rows });
  } catch (thrown) {
    error = thrown;
  } finally {
    dom.restore();
  }
  const panel = grid.children.find((child) => child.id === LAND_MAP_PANEL_ID) || null;
  return { grid, list, panel, error };
}

const ROWS = [{ project_id: "2026R0127" }, { project_id: "2023K0183" }, { project_id: "no-such-project" }];

/* ===== A1: List stays complete and canonical through every failure kind ===== */

// The fourth kind, `timeout`, is proven fast at the unit level (test/land_map_performance_
// budget.test.mjs, with an injected millisecond-scale budget) instead of here: reaching it
// through a real mount would mean actually waiting out the fixed 4-second production budget
// (times the retry bound), three times over in this file's earlier "never settles" attempts.
for (const [label, marker, handler, expectedKind] of [
  ["projection 404", "land_project_map_points", () => ({ ok: false, status: 404 }), LAND_MAP_FAILURE_KINDS.PROJECTION],
  ["malformed projection", "land_project_map_points", () => ({ ok: true, status: 200, json: () => Promise.resolve({ schema: "wrong" }) }), LAND_MAP_FAILURE_KINDS.INVALID_DATA],
  ["offline/blocked projection", "land_project_map_points", () => Promise.reject(new TypeError("Failed to fetch")), LAND_MAP_FAILURE_KINDS.DEPENDENCY],
]) {
  test(`A1/A2 a ${label} leaves the List complete and records failure kind "${expectedKind}"`, async () => {
    const calls = { total: 0, urls: [] };
    const fetchImpl = countingFetch([[marker, handler], ["geography/layers", () => READY_BOUNDARY]], calls);
    const { list, panel, error } = await mount(ROWS, fetchImpl);
    assert.ok(error, "the failure must still reach the route so the switch can fall back");
    assert.equal(panel.dataset.landMapState, "failed");
    assert.equal(panel.dataset.landMapFailureKind, expectedKind);
    // List: same rows, same count, untouched by which way the Map failed.
    assert.match(list.innerHTML, /2026R0127/);
    assert.match(list.innerHTML, /2023K0183/);
    assert.equal([...list.innerHTML.matchAll(/class="row"/g)].length, ROWS.length);
  });
}

/* ===== A3: no failure path adds a request beyond the fixed activation budget ===== */

test("A3 a full successful activation never exceeds the fixed deferred-request budget", async () => {
  const calls = { total: 0, urls: [] };
  const fetchImpl = countingFetch(
    [["land_project_map_points", READY_PROJECTION], ["geography/layers", () => READY_BOUNDARY]],
    calls,
  );
  const { panel, error } = await mount(ROWS, fetchImpl);
  assert.equal(error, null);
  assert.equal(panel.dataset.landMapState, "ready");
  assert.ok(
    calls.total <= LAND_MAP_BUDGETS.map_activation_requests_max,
    `activation issued ${calls.total} requests, over the fixed budget of ${LAND_MAP_BUDGETS.map_activation_requests_max}`,
  );
  assert.equal(calls.total, LAND_MAP_BUDGETS.map_activation_requests_max, "the projection plus every boundary layer, and nothing else");
  for (const url of calls.urls) {
    assert.ok(
      url.includes("land_project_map_points") || url.includes("geography/layers"),
      `activation reached an unapproved request: ${url}`,
    );
  }
});

test("A3 a failed projection never reaches for a publisher, ZAP, GIS, or geocoder fallback", async () => {
  const calls = { total: 0, urls: [] };
  const fetchImpl = countingFetch(
    [["land_project_map_points", () => ({ ok: false, status: 404 })], ["geography/layers", () => READY_BOUNDARY]],
    calls,
  );
  await mount(ROWS, fetchImpl);
  for (const url of calls.urls) {
    assert.doesNotMatch(url, /zap|publisher|geocod|planninglabs|cityofnewyork/i, `unapproved fallback request: ${url}`);
  }
});

/* ===== A4: a transient failure that clears within the bounded retry still reaches ready ===== */

test("A4 a transient dependency failure that clears within the bounded retry reaches the same ready map", async () => {
  let projectionCalls = 0;
  const calls = { total: 0, urls: [] };
  const fetchImpl = countingFetch(
    [
      ["land_project_map_points", () => {
        projectionCalls += 1;
        if (projectionCalls < LAND_MAP_BUDGETS.map_transient_retry_max + 1) return Promise.reject(new TypeError("Failed to fetch"));
        return READY_PROJECTION();
      }],
      ["geography/layers", () => READY_BOUNDARY],
    ],
    calls,
  );
  const { panel, error } = await mount(ROWS, fetchImpl);
  assert.equal(error, null, "the bounded retry should have recovered before the retry budget was exhausted");
  assert.equal(panel.dataset.landMapState, "ready");
  assert.equal(projectionCalls, LAND_MAP_BUDGETS.map_transient_retry_max + 1);
  const model = buildLandMapModel({ rows: ROWS, pointLookup: points });
  assert.equal(model.counts.total, ROWS.length);
});

/* ===== the deterministic receipt names what was measured against the same fixed budgets ===== */

test("the committed receipt reports every scenario against the budget module's own fixed numbers", () => {
  const receipt = JSON.parse(read("docs/evidence/land-map-performance-and-failure.json"));
  assert.equal(receipt.schema, "cityscroll.land-map-performance-and-failure-receipt.v1");
  assert.equal(receipt.card, "cityscroll-engineering/land-map-performance-and-failure");
  assert.deepEqual(receipt.budgets, LAND_MAP_BUDGETS, "the receipt's budgets must be read from the module, not retyped");
  for (const [name, passed] of Object.entries(receipt.budget_checks)) {
    assert.equal(passed, true, `${name} failed in the committed receipt`);
  }
  assert.equal(
    receipt.list_completeness.list_remained_complete_and_canonical_through_every_map_failure,
    true,
  );
  assert.deepEqual(receipt.list_completeness.distinct_row_counts_across_every_scenario, [40]);
  const kinds = Object.fromEntries(receipt.scenarios.map((entry) => [entry.scenario, entry.state.failure_kind]));
  assert.equal(kinds["successful-map"], null);
  assert.equal(kinds.offline, LAND_MAP_FAILURE_KINDS.DEPENDENCY);
  assert.equal(kinds.malformed, LAND_MAP_FAILURE_KINDS.INVALID_DATA);
  assert.equal(kinds["dependency-404"], LAND_MAP_FAILURE_KINDS.PROJECTION);
  assert.equal(kinds["slow-network-recovering"], null, "a transient failure that clears must still reach ready");
  for (const [state, cache] of [["cold", receipt.measurements.cold], ["warm", receipt.measurements.warm]]) {
    assert.ok(cache.list_first_paint_ms > 0, `${state}: list first paint was never observed`);
    assert.ok(cache.map_activation_ms > 0, `${state}: map activation was never observed`);
    assert.equal(cache.list_state.rows, cache.map_state.rows, `${state}: Map changed the result set`);
    assert.equal(cache.map_state.map_state, "ready");
    assert.ok(cache.map_state.markers > 0, `${state}: activation painted no markers`);
  }
});
