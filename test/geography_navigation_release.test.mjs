// Fixture-closable release proof for the resident geography navigator.

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import {
  GEOGRAPHY_NAVIGATION_AREA_OVERLAP_EXAMPLE,
  GEOGRAPHY_NAVIGATION_POINT_BUNDLES,
} from "../site/geography_navigation_capability.mjs";
import {
  buildCityHallPointOverlapFixtureModel,
  buildSelectedGeographyOverlapViewModel,
  buildBk1503CouncilOverlapFixtureModel,
  renderSelectedGeographyOverlapDrawerHtml,
} from "../site/geography_navigation_overlap_ui.mjs";
import {
  GEOGRAPHY_ENTRY_RECOVERY,
  resolveGeographyEntryFromGeolocationError,
  resolveGeographyEntryFromPlaceLabel,
  resolveGeographyEntryFromPoint,
} from "../site/geography_navigation_entry.mjs";
import {
  GEOGRAPHY_MAP_FALLBACK_REASONS,
  GEOGRAPHY_MAP_STYLE,
} from "../site/geography_navigation_map.mjs";
import {
  geographyRecordProjection,
} from "../site/geography_navigation_records.mjs";
import {
  GEOGRAPHY_NAVIGATION_EPHEMERAL_KEYS,
  geographyNavigationPayloadLeaksEphemeral,
  parseGeographyNavigationState,
  serializeGeographyNavigationState,
} from "../site/geography_navigation_state.mjs";
import { readFileSync as readText } from "node:fs";

const ROOT = process.cwd();
const EVIDENCE_PATH = join(ROOT, "docs/evidence/geography-navigation-release/capture-manifest.json");
const BUDGETS_PATH = join(ROOT, "performance-budgets.json");
const MAP_SOURCE = readText(join(ROOT, "site/app/map.mjs"), "utf8");
const LAND_SOURCE = readText(join(ROOT, "site/app/land.mjs"), "utf8");
const RELEASE_BROWSER_SOURCE = readText(join(ROOT, "test/browser/geography_navigation_release.py"), "utf8");
const RELEASE_MANIFEST = JSON.parse(readFileSync(EVIDENCE_PATH, "utf8"));

const BK1503 = "geography:nta2020:BK1503";

function activityFixture() {
  const ids = ["meeting-a", "meeting-b", "meeting-c"];
  return {
    geography_items: {
      by_key: {
        [BK1503]: { meetings: ids },
      },
    },
    records: {
      meetings: Object.fromEntries(ids.map((id) => [id, { id }])),
    },
  };
}

function allCaptureRows() {
  return RELEASE_MANIFEST.captures.flatMap((capture) => (
    Array.isArray(capture.captures) ? capture.captures : [capture]
  ));
}

function assertCaptureContract(capture) {
  assert.equal(typeof capture.route, "string");
  assert.ok(capture.viewport?.width >= 320);
  assert.ok(capture.viewport?.height >= 480);
  assert.equal(capture.repository_revision, RELEASE_MANIFEST.repository_revision);
  assert.equal(capture.candidate_revision, RELEASE_MANIFEST.candidate_revision);
  assert.deepEqual(capture.deployed_version, {
    status: "not_taken",
    reason: "deployment-dependent CROL_BASE read-back",
  });
  assert.ok(capture.data_vintages?.nta);
  assert.ok(capture.data_vintages?.community);
  assert.ok(capture.data_vintages?.council);
  assert.ok(capture.data_vintages?.precinct);
  assert.equal(typeof capture.assertion, "string");
  assert.equal(typeof capture.failure_mode, "string");
  assert.ok(Array.isArray(capture.asset_classes));
  assert.equal(typeof capture.timing_samples, "object");
  assert.equal(typeof capture.render_content_sha256, "string");
  assert.match(capture.render_content_sha256, /^[0-9a-f]{64}$/);
}

test("A1: desktop BK1503 comparison shows exact ordered percentages and count-equals-list", () => {
  const model = buildBk1503CouncilOverlapFixtureModel();
  assert.equal(model.selected.key, BK1503);
  assert.deepEqual(
    model.area_section.rows.map((row) => [row.id, row.display_pct]),
    [["48", "69.0%"], ["46", "31.0%"]],
  );
  const projection = geographyRecordProjection(activityFixture(), { key: BK1503, lens: "meetings" });
  assert.equal(projection.count, projection.ids.length);
  assert.equal(projection.count, 3);
  assert.match(renderSelectedGeographyOverlapDrawerHtml(model), /69\.0%[\s\S]*31\.0%/);
});

test("A2: narrow touch and keyboard proof records overflow, target, form-text, and drawer constraints", () => {
  const rows = allCaptureRows().filter((capture) => [390, 360].includes(capture.viewport.width));
  assert.ok(rows.length >= 2);
  for (const capture of rows) {
    assert.ok(capture.assertion.includes("horizontal overflow ≤ 1px"));
    assert.ok(capture.assertion.includes("44px"));
    assert.ok(capture.assertion.includes("16px"));
    assert.ok(capture.assertion.includes("drawer"));
    assert.ok(capture.assertion.includes("keyboard"));
  }
});

test("A3: City Hall point journey keeps MN0102, M01, Council 1, and Precinct 1 under At this location", () => {
  const model = buildCityHallPointOverlapFixtureModel();
  const ids = model.point_section.lines.map((line) => line.id);
  assert.deepEqual(ids, ["MN0102", "M01", "1", "1"]);
  assert.equal(model.point_section.heading, "At this location");
  assert.equal(model.area_section.available, false);
  assert.match(renderSelectedGeographyOverlapDrawerHtml(model), /At this location/);
  assert.doesNotMatch(renderSelectedGeographyOverlapDrawerHtml(model), /overlaps 2 Council districts/);
});

test("A4: accessibility matrix names landmarks, focus, escape, zoom, motion, contrast, announcements, and screen-reader output", () => {
  const matrix = RELEASE_MANIFEST.accessibility_matrix;
  for (const required of [
    "landmarks", "names", "focus_order", "focus_visibility", "map_escape",
    "list_equivalence", "status_announcements", "zoom_200_percent", "reduced_motion",
    "forced_colors", "screen_reader_selection",
  ]) {
    assert.equal(matrix[required].result, "passed", required);
    assert.ok(matrix[required].artifact, required);
  }
});

test("A5: failure-mode matrix preserves a named recovery path for every enhancement and data failure", () => {
  const failures = RELEASE_MANIFEST.failure_mode_matrix;
  const required = [
    "no_javascript", "dynamic_import_failure", "no_webgl", "context_loss", "local_layer_failure",
    "offline_basemap", "stale_crosswalk", "geolocation_denied", "address_lookup_failure",
    "outside_covered_land", "zero_records", "records_unavailable",
  ];
  for (const key of required) {
    assert.equal(failures[key].result, "passed", key);
    assert.ok(failures[key].recovery_path, key);
  }
  assert.deepEqual(
    Object.values(GEOGRAPHY_MAP_FALLBACK_REASONS).sort(),
    ["basemap_tile_failure", "destroyed", "dynamic_import_failure", "local_layer_failure", "style_failure", "webgl_context_lost", "webgl_unsupported"].sort(),
  );
});

test("A6: address, URL, storage, analytics, and error payloads exclude raw location inputs", () => {
  const fixture = GEOGRAPHY_NAVIGATION_POINT_BUNDLES[0];
  const state = parseGeographyNavigationState({ geo: "nta2020:BK1503", address: "1508 Sheepshead Bay Road", lat: fixture.coordinates[1], lng: fixture.coordinates[0] });
  const params = serializeGeographyNavigationState(state, { includeDefaults: true });
  assert.equal(geographyNavigationPayloadLeaksEphemeral(params), false);
  for (const key of GEOGRAPHY_NAVIGATION_EPHEMERAL_KEYS) assert.equal(params.has(key), false, key);
  const privacy = RELEASE_MANIFEST.privacy_assertions;
  for (const surface of ["network", "url", "storage", "analytics", "error_reporting"]) {
    assert.equal(privacy[surface].result, "passed", surface);
  }
});

test("A7: field-vital budgets and retained route samples are explicit, while production measurement stays open", () => {
  const budgets = JSON.parse(readFileSync(BUDGETS_PATH, "utf8"));
  assert.equal(budgets.fixtures["near-you.geography-navigation"], undefined);
  assert.equal(budgets.fieldVitals.lcpMs, 2500);
  assert.equal(budgets.fieldVitals.inpMs, 200);
  assert.equal(budgets.fieldVitals.cls, 0.1);
  assert.equal(RELEASE_MANIFEST.performance.production_field_vitals.status, "not_taken");
  assert.equal(RELEASE_MANIFEST.performance.route_budget.status, "not_taken");
  assert.equal(RELEASE_MANIFEST.performance.route_budget.reduced_copy_mobile_observation.sample_count, 20);
  assert.equal(RELEASE_MANIFEST.performance.route_budget.reduced_copy_mobile_observation.wire_bytes_p95, 484311);
  for (const sample of RELEASE_MANIFEST.performance.retained_samples) {
    assert.equal(sample.samples.length, 20);
    for (const metric of ["readiness_ms", "wire_bytes"]) {
      assert.ok(sample.reviewed_premerge_p95[metric] > 0, metric);
      assert.ok(sample.route_ceiling[metric] <= sample.reviewed_premerge_p95[metric] * 1.05 + 1, metric);
    }
  }
});

test("A8: unrelated routes omit the navigator runtime and the map requests simplified geometry only", () => {
  const unrelated = readFileSync(join(ROOT, "site/index.html"), "utf8");
  assert.doesNotMatch(unrelated, /geography_navigation_(?:map|shell)/);
  assert.doesNotMatch(LAND_SOURCE, /geography_navigation_(?:map|shell)/);
  assert.match(MAP_SOURCE, /loadSimplifiedNavigationLayer|simplifiedLayerSiteUrl/);
  assert.doesNotMatch(MAP_SOURCE, /artifacts\.full/);
  assert.equal(RELEASE_MANIFEST.boundaries.full_fidelity_geometry_requested, false);
  assert.equal(RELEASE_MANIFEST.performance.route_budget.status, "not_taken");
});

test("A9: every retained manifest entry carries route, viewport, vintages, assertion, timings, mode, assets, and render hash", () => {
  assert.match(RELEASE_MANIFEST.repository_revision, /^[0-9a-f]{40}$/);
  assert.match(RELEASE_MANIFEST.candidate_revision, /^[0-9a-f]{40}$/);
  assert.match(RELEASE_MANIFEST.grounded_at, /^[0-9a-f]{40}$/);
  assert.equal(RELEASE_MANIFEST.repository_revision, RELEASE_MANIFEST.grounded_at);
  assert.ok(RELEASE_MANIFEST.deployed_version);
  for (const capture of allCaptureRows()) assertCaptureContract(capture);
});

test("A10: manifests contain no address or raw coordinate and no screenshot binary is required", () => {
  const serialized = JSON.stringify(RELEASE_MANIFEST);
  assert.doesNotMatch(serialized, /40\.5869|-73\.9542|40\.7128|-74\.006/);
  assert.doesNotMatch(serialized, /address_query|raw_coordinate|screenshot_binary/i);
  assert.equal(RELEASE_MANIFEST.image_binaries_committed, false);
  assert.match(RELEASE_MANIFEST.capture_policy, /no image capture was taken/i);
  assert.ok(RELEASE_MANIFEST.not_taken.includes("production screenshot binaries"));
});

test("A11: the existing geography suites retain explicit full-checkout verification ownership", () => {
  const suites = RELEASE_MANIFEST.validation.existing_suites;
  assert.ok(suites.length >= 7);
  for (const suite of suites) {
    assert.equal(suite.result, "not_taken", suite.path);
    assert.match(suite.reason, /full-checkout-only/i);
    assert.ok(existsSync(join(ROOT, suite.path)), suite.path);
  }
});

test("A12: pre-deployment verification is green and the deployed journey remains explicitly open", () => {
  assert.equal(RELEASE_MANIFEST.validation.predeployment.full_verify.result, "passed");
  assert.equal(RELEASE_MANIFEST.validation.predeployment.make_a11y.result, "not_taken");
  assert.match(RELEASE_MANIFEST.validation.predeployment.make_a11y.reason, /full-checkout-only/i);
  assert.equal(RELEASE_MANIFEST.validation.predeployment.make_prepush.result, "not_taken");
  assert.match(RELEASE_MANIFEST.validation.predeployment.make_prepush.reason, /full-checkout-only/i);
  assert.equal(RELEASE_MANIFEST.validation.deployed_crol_base.result, "not_taken");
  assert.match(RELEASE_MANIFEST.validation.deployed_crol_base.reason, /deployment-dependent/i);
});

test("A13: closure evidence maps every letter to a named test or manifest assertion", () => {
  const letters = RELEASE_MANIFEST.closure_evidence.map((row) => row.letter);
  assert.deepEqual(letters, Array.from({ length: 14 }, (_value, index) => `A${index + 1}`));
  for (const row of RELEASE_MANIFEST.closure_evidence) {
    assert.ok(row.artifact, row.letter);
    assert.ok(row.assertion, row.letter);
    assert.ok(["accepted", "partial"].includes(row.result), row.letter);
  }
});

test("A14: desktop and mobile manifests record visual metrics and meet the binding map contract", () => {
  const metrics = allCaptureRows().map((capture) => capture.visual_metrics);
  assert.ok(metrics.some((row) => row.viewport.width === 1440));
  assert.ok(metrics.some((row) => row.viewport.width === 390));
  assert.ok(metrics.some((row) => row.viewport.width === 360));
  for (const row of metrics) {
    assert.equal(typeof row.rendered_neighborhood_label_count, "number");
    assert.equal(typeof row.selected_label_present, "boolean");
    assert.equal(typeof row.clipped_or_overlapping_label_count, "number");
    assert.ok(row.computed_styles.active);
    assert.ok(row.computed_styles.selected);
    assert.ok(row.computed_styles.comparison);
    assert.ok(row.visible_map_area_css_px.width > 0);
    assert.equal(row.control_occlusion, false);
    assert.equal(row.nta_codes_in_primary_labels, 0);
  }
  assert.ok(GEOGRAPHY_MAP_STYLE.ACTIVE_FILL_OPACITY < 0.2);
  assert.ok(GEOGRAPHY_MAP_STYLE.SELECTED_LINE_WIDTH > GEOGRAPHY_MAP_STYLE.ACTIVE_LINE_WIDTH);
});

test("Near You A1/A3: default, Greenpoint, and Tribeca captures bind first-view map geometry", () => {
  assert.match(RELEASE_BROWSER_SOURCE, /MINIMUM_VISIBLE_MAP_HEIGHT = 240/);
  assert.match(RELEASE_BROWSER_SOURCE, /BK0101/);
  assert.match(RELEASE_BROWSER_SOURCE, /MN0102/);
  const rows = allCaptureRows().filter((capture) => /^entry-(?:default|greenpoint|tribeca)-/.test(capture.name || ""));
  assert.equal(rows.length, 6);
  for (const place of ["default", "greenpoint", "tribeca"]) {
    const placeRows = rows.filter((capture) => capture.name.startsWith(`entry-${place}-`));
    assert.deepEqual(placeRows.map((capture) => capture.viewport.width).sort((a, b) => a - b), [390, 1440]);
    for (const capture of placeRows) {
      assert.ok(capture.visual_metrics.initial_viewport_map_height_css_px >= 240, capture.name);
      assert.equal(capture.visual_metrics.place_choice_visible, true, capture.name);
      assert.equal(capture.visual_metrics.control_occlusion, false, capture.name);
    }
  }
});

test("Near You A2/A3: capture focus order keeps the primary place action ahead of map detail", () => {
  const rows = allCaptureRows().filter((capture) => /^entry-(?:default|greenpoint|tribeca)-/.test(capture.name || "") && capture.viewport.width === 390);
  assert.equal(rows.length, 3);
  for (const capture of rows) {
    const order = capture.visual_metrics.focus_order;
    assert.ok(Array.isArray(order) && order.length > 0, capture.name);
    const primaryAt = order.findIndex((label) => /Search|Change (?:place|neighborhood)/.test(label));
    const mapDetailAt = order.findIndex((label) => /Map details|Toggle attribution/.test(label));
    assert.ok(primaryAt >= 0, `${capture.name}: primary place action missing`);
    assert.ok(mapDetailAt < 0 || primaryAt < mapDetailAt, `${capture.name}: unreadable focus order`);
  }
});

test("Near You A2: 360px boundary capture combines 200% zoom, reduced motion, and unavailable WebGL", () => {
  const capture = allCaptureRows().find((row) => row.name === "entry-boundary-360-zoom-200");
  assert.ok(capture);
  assert.equal(capture.viewport.width, 360);
  assert.equal(capture.visual_metrics.zoom_percent, 200);
  assert.equal(capture.visual_metrics.reduced_motion, true);
  assert.equal(capture.failure_mode, "webgl_unavailable");
  assert.notEqual(capture.visual_metrics.map_runtime, "maplibre");
  assert.match(capture.assertion, /horizontal overflow ≤ 1px/);
  assert.match(capture.assertion, /≥44px targets/);
  assert.match(capture.assertion, /keyboard focus order/);
});
