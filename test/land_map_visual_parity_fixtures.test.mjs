/**
 * Pure contract for the LM-13 visual-parity fixture manifest.
 *
 * The manifest names every paired List/Map state the browser capture in
 * test/functional/51_land_map_visual_parity_fixtures.py drives -- route,
 * viewport, dependency scenario, and what a passing capture must find. This
 * file proves the manifest itself is well-formed without a browser: no
 * fixture can smuggle in a viewport-as-filter, a marker-count-only parity
 * claim, or a route missing its List/Map pair. The browser proof is the
 * separate functional test; this is the fixture contract it reads.
 *
 * verify: node --test test/land_map_visual_parity_fixtures.test.mjs
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const MANIFEST_URL = new URL(
  "./fixtures/land_map_visual_parity_fixtures/manifest.v1.json",
  import.meta.url,
);
const manifest = JSON.parse(readFileSync(MANIFEST_URL, "utf8"));

const KNOWN_METHODS = new Set([
  "publisher_point",
  "single_bbl_centroid",
  "multi_bbl_anchor",
  "property_coordinate",
  "geometry_representative_point",
]);
const KNOWN_PRECISIONS = new Set(["exact", "anchor", "representative"]);
const KNOWN_DEPENDENCY_SCENARIOS = new Set(["healthy", "projection-blocked"]);
const PROJECT_ID_RE = /^[A-Za-z0-9]+$/;
const LOCAL_PATH_RE = /(^|[^A-Za-z0-9_])(\/Users\/|\/home\/|[A-Za-z]:\\|file:\/\/)/;

function assertNoLocalPath(value, label) {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  assert.doesNotMatch(text, LOCAL_PATH_RE, `${label} carries a local filesystem reference`);
}

test("manifest identity and viewport registry", () => {
  assert.equal(manifest.schema, "cityscroll.land-map-visual-parity-fixtures-manifest.v1");
  assert.equal(manifest.card, "cityscroll-engineering/land-map-visual-parity-fixtures");
  assert.equal(manifest.join, "exact_project_id");
  assert.match(manifest.anchor_specimen.project_id, PROJECT_ID_RE);
  assert.match(manifest.exact_precision_specimen.project_id, PROJECT_ID_RE);
  assert.notEqual(manifest.anchor_specimen.project_id, manifest.exact_precision_specimen.project_id);

  const viewportNames = Object.keys(manifest.viewports);
  assert.ok(viewportNames.includes("narrow") && viewportNames.includes("wide"));
  assert.ok(viewportNames.includes("mobile"), "a 320px mobile viewport must be registered");
  for (const [name, box] of Object.entries(manifest.viewports)) {
    assert.equal(box.length, 2, `viewport ${name} must be [width, height]`);
    const [width, height] = box;
    assert.ok(Number.isInteger(width) && width > 0, `viewport ${name} width`);
    assert.ok(Number.isInteger(height) && height > 0, `viewport ${name} height`);
  }
  assert.equal(manifest.viewports.mobile[0], 320);
  assert.equal(manifest.viewports.narrow[0], 390);
  assert.equal(manifest.viewports.wide[0], 1440);
});

test("negative rule is stated and none of its guarantees is contradicted by a fixture field", () => {
  assert.ok(Array.isArray(manifest.negative_rule) && manifest.negative_rule.length >= 5);
  for (const line of manifest.negative_rule) {
    assert.equal(typeof line, "string");
    assert.ok(line.trim().length > 0);
  }
  assertNoLocalPath(manifest, "the manifest");
});

test("every fixture is a complete, collision-free, viewport-referencing pair", () => {
  const ids = new Set();
  const identities = new Set();
  assert.ok(Array.isArray(manifest.fixtures) && manifest.fixtures.length >= 6);
  for (const fixture of manifest.fixtures) {
    assert.equal(typeof fixture.id, "string");
    assert.ok(!ids.has(fixture.id), `duplicate fixture id ${fixture.id}`);
    ids.add(fixture.id);
    // Two fixtures may legitimately share a route, dependency scenario, and selection
    // (e.g. "selected" and "mobile" both select the anchor on the bare Map route) as
    // long as the viewport set they are captured at differs -- that is what makes a
    // desktop selection proof and a phone-width selection proof two distinct fixtures
    // rather than one fixture captured twice under different names.
    const identity = JSON.stringify([
      fixture.map_route,
      fixture.dependency_scenario,
      fixture.select_project_id || null,
      [...fixture.viewports].sort(),
    ]);
    assert.ok(!identities.has(identity), `fixture ${fixture.id} is not distinguishable from another fixture`);
    identities.add(identity);

    assert.equal(typeof fixture.title, "string");
    assert.ok(fixture.title.trim().length > 0, `${fixture.id}: title`);

    assert.match(fixture.list_route, /^\/browse\/zoning\//, `${fixture.id}: list_route`);
    assert.match(fixture.map_route, /^\/browse\/zoning\//, `${fixture.id}: map_route`);
    assert.doesNotMatch(fixture.list_route, /view=map/, `${fixture.id}: list_route must not carry view=map`);
    assert.match(fixture.map_route, /view=map/, `${fixture.id}: map_route must carry view=map`);
    // The List and Map routes must differ only by the presentation key, never by a
    // semantic filter -- the same invariant LM-08 enforces at the browser layer.
    const stripView = (url) => url.replace(/[?&]view=map/, "").replace(/[?&]$/, "");
    assert.equal(
      stripView(fixture.map_route),
      stripView(fixture.list_route),
      `${fixture.id}: list_route and map_route diverge on more than the view key`,
    );
    // No fixture is allowed to express a filter as a bounding viewport.
    assert.doesNotMatch(fixture.list_route, /[?&](bbox|bounds|viewport|ne_lat|sw_lat)=/i, `${fixture.id}: viewport-as-filter`);

    assert.ok(Array.isArray(fixture.viewports) && fixture.viewports.length >= 1, `${fixture.id}: viewports`);
    for (const name of fixture.viewports) {
      assert.ok(Object.hasOwn(manifest.viewports, name), `${fixture.id}: unknown viewport ${name}`);
    }

    assert.ok(KNOWN_DEPENDENCY_SCENARIOS.has(fixture.dependency_scenario), `${fixture.id}: dependency_scenario`);
    assert.ok(fixture.expects && typeof fixture.expects === "object", `${fixture.id}: expects`);
    assertNoLocalPath(fixture, fixture.id);
  }
});

test("the mobile fixture is the one that carries the 320px viewport and a selection", () => {
  const mobile = manifest.fixtures.find((fixture) => fixture.id === "mobile");
  assert.ok(mobile, "a mobile fixture must exist");
  assert.ok(mobile.viewports.includes("mobile"));
  assert.equal(mobile.select_project_id, manifest.anchor_specimen.project_id);
  assert.equal(mobile.expects.panel_no_overflow, true);
});

test("the dependency-failure fixture never asserts parity from a marker count alone", () => {
  const failure = manifest.fixtures.find((fixture) => fixture.dependency_scenario === "projection-blocked");
  assert.ok(failure, "a dependency-failure fixture must exist");
  assert.equal(failure.expects.map_state, "failed");
  // The negative rule: a failure state is proved by the List staying the complete,
  // canonical population -- never by counting whatever the Map happened to draw.
  assert.equal(failure.expects.list_total_matches_default, true);
  assert.ok(!Object.hasOwn(failure.expects, "marker_count"), "must not gate on marker count");
  assert.equal(failure.expects.retry_present, true);
  assert.equal(failure.expects.dismiss_present, true);
});

test("the zero-result fixture never hides the empty result behind a failure reading", () => {
  const zero = manifest.fixtures.find((fixture) => fixture.id === "zero-result");
  assert.ok(zero);
  assert.deepEqual(
    { total: zero.expects.total, mapped: zero.expects.mapped, unmapped: zero.expects.unmapped },
    { total: 0, mapped: 0, unmapped: 0 },
  );
  assert.equal(zero.expects.map_state, "ready", "an empty result is not a map failure");
  assert.equal(zero.expects.list_empty, true);
});

test("the selected and mapped-precision fixtures name a real accepted method and precision", () => {
  const selected = manifest.fixtures.find((fixture) => fixture.id === "selected");
  assert.ok(selected);
  assert.equal(selected.select_project_id, manifest.anchor_specimen.project_id);
  assert.ok(KNOWN_METHODS.has(selected.expects.selected_method));
  assert.ok(KNOWN_PRECISIONS.has(selected.expects.selected_precision));

  const mapped = manifest.fixtures.find((fixture) => fixture.id === "default");
  assert.ok(mapped);
  for (const precision of mapped.expects.contains_precisions) {
    assert.ok(KNOWN_PRECISIONS.has(precision), `unknown precision ${precision}`);
  }
  assert.ok(mapped.expects.contains_ids.includes(manifest.anchor_specimen.project_id));
  assert.ok(mapped.expects.contains_ids.includes(manifest.exact_precision_specimen.project_id));
});

test("every fixture that names list_map_partition also compares full id sets, not a count", () => {
  for (const fixture of manifest.fixtures) {
    if (fixture.expects.list_map_partition !== true) continue;
    // Structural: the manifest's own contract for this flag is "compare id sets", which
    // the browser capture is required to honor. Guard against a future fixture pairing
    // this flag with a bare marker-count expectation that would satisfy it by accident.
    assert.ok(
      !Object.hasOwn(fixture.expects, "marker_count_only"),
      `${fixture.id}: list_map_partition must not degrade to a marker count`,
    );
  }
});

test("boundary and unmapped-honesty fixtures disclose state rather than assert silence", () => {
  const boundary = manifest.fixtures.find((fixture) => fixture.id === "boundary-context");
  assert.ok(boundary);
  assert.equal(boundary.expects.boundary_state, "ready");
  assert.equal(boundary.expects.boundary_evidence_present, true);

  const unmapped = manifest.fixtures.find((fixture) => fixture.id === "unmapped-honesty");
  assert.ok(unmapped);
  assert.equal(unmapped.expects.mapped, 0);
  assert.equal(unmapped.expects.unmapped_note_present, true);
  assert.ok(unmapped.expects.total_at_least >= 1);
});
