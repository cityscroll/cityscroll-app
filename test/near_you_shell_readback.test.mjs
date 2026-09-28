import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const READBACK = join(ROOT, "docs/evidence/near-you-shell-readback/read-back.json");
const MANIFEST = join(ROOT, "docs/evidence/near-you-shell-readback/capture-manifest.json");
const SHELL_MANIFEST = join(ROOT, "docs/evidence/geography-navigation-shell/capture-manifest.json");
const MAP_SOURCE = readFileSync(join(ROOT, "site/geography_navigation_map.mjs"), "utf8");

function loadJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function assertInRunRequestReceipt(requestReceipt, runReceipt, expectedRevision) {
  assert.equal(typeof requestReceipt, "object");
  assert.equal(requestReceipt.capture_run_id, runReceipt.capture_run_id);
  assert.match(requestReceipt.request_id || "", /^near-you-/);
  const observedAt = Date.parse(requestReceipt.observed_at);
  assert.ok(observedAt >= Date.parse(runReceipt.run_started_at));
  assert.ok(observedAt <= Date.parse(runReceipt.run_finished_at));

  assert.equal(requestReceipt.page_load.http_status, 200);
  assert.match(requestReceipt.page_load.url || "", /^https:\/\/cityscroll\.org\/near-you\//);
  assert.ok(requestReceipt.page_load.headers.date);
  assert.match(
    requestReceipt.page_load.headers["cf-ray"] || "",
    /^[0-9a-f]{16}-[A-Z0-9]{2,4}$/,
  );

  const servedManifest = requestReceipt.served_manifest_read;
  assert.equal(servedManifest.http_status, 200);
  assert.equal(servedManifest.served_revision, expectedRevision);
  assert.match(servedManifest.url || "", /\/artifact-manifest\.json$/);
  assert.ok(servedManifest.headers.date);
  assert.match(servedManifest.headers["cf-ray"] || "", /^[0-9a-f]{16}-[A-Z0-9]{2,4}$/);
  assert.match(servedManifest.payload_sha256 || "", /^[0-9a-f]{64}$/);
}

test("retained Near You shell production read-back carries observed A9/A13 values", () => {
  const receipt = loadJson(READBACK);
  assert.equal(receipt.schema, "cityscroll.near_you_shell_production_read.v1");
  assert.equal(receipt.public_alias, "ced62a84f8213");
  assert.equal(receipt.evidence_class, "deployed-production-read-back");
  assert.match(receipt.deployment.revision, /^[0-9a-f]{40}$/);
  assert.match(receipt.deployment.required_ancestor, /^[0-9a-f]{40}$/);
  assert.equal(receipt.deployment.required_ancestor_contained, true);
  assert.equal(
    receipt.producer.path,
    "docs/evidence/near-you-shell-readback/read-back.json",
  );
  assert.deepEqual(receipt.producer.letters, ["A9", "A13"]);
  for (const banned of ["result", "pass", "passed", "verdict"]) {
    assert.equal(Object.hasOwn(receipt, banned), false);
  }

  const a13 = receipt.letters.A13.reads;
  const allCity = a13.filter((row) => !row.selected_neighborhood_label);
  const selected = a13.filter((row) => row.selected_neighborhood_label);
  assert.equal(allCity.length, 2);
  assert.equal(selected.length, 4);
  const runReceipt = receipt.run_receipt;
  assert.equal(typeof runReceipt, "object");
  assert.match(runReceipt.capture_run_id || "", /^[0-9a-f-]{36}$/);
  assert.equal(runReceipt.served_revision, receipt.deployment.revision);
  assert.equal(runReceipt.request_count, 6);
  assert.equal(runReceipt.initial_served_manifest.served_revision, receipt.deployment.revision);
  assert.equal(runReceipt.final_served_manifest.served_revision, receipt.deployment.revision);
  assert.ok(Date.parse(runReceipt.run_finished_at) >= Date.parse(runReceipt.run_started_at));

  const a13RequestIds = new Set();
  for (const row of a13) {
    assertInRunRequestReceipt(row.request_receipt, runReceipt, receipt.deployment.revision);
    a13RequestIds.add(row.request_receipt.request_id);
  }
  assert.equal(a13RequestIds.size, 6);
  const desktop = allCity.find((row) => row.viewport.width === 1440);
  const mobile = allCity.find((row) => row.viewport.width === 390);
  assert.ok(desktop);
  assert.ok(mobile);
  assert.equal(desktop.viewport.height, 900);
  assert.equal(mobile.viewport.height, 844);
  assert.ok(
    desktop.residential_neighborhood_label_count >= 12
      && desktop.residential_neighborhood_label_count <= 40,
    `desktop count ${desktop.residential_neighborhood_label_count}`,
  );
  assert.ok(
    mobile.residential_neighborhood_label_count >= 6
      && mobile.residential_neighborhood_label_count <= 20,
    `mobile count ${mobile.residential_neighborhood_label_count}`,
  );
  for (const row of allCity) {
    assert.equal(row.map_runtime, "maplibre");
    assert.equal(row.text_allow_overlap, false);
    assert.equal(row.text_ignore_placement, false);
    assert.equal(row.overlapping_label_pair_count, 0);
    assert.equal(row.residential_neighborhood_labels.length, row.residential_neighborhood_label_count);
    assert.ok(row.residential_neighborhood_label_count > 0);
    const geometry = row.geometry;
    assert.ok(geometry);
    assert.equal(
      geometry.measurement,
      "maplibre-collisionIndex-grid-bboxes+getBoundingClientRect",
    );
    assert.equal(typeof geometry.measured_label_box_count, "number");
    assert.ok(geometry.measured_label_box_count >= 1);
    assert.equal(geometry.overlapping_label_pair_count, 0);
    assert.equal(geometry.overlapping_label_pair_count, row.overlapping_label_pair_count);
    assert.equal(typeof geometry.frame_crossing_label_count, "number");
    assert.equal(typeof geometry.obscured_by_primary_control_count, "number");
    assert.equal(geometry.obscured_by_primary_control_count, 0);
    assert.ok(geometry.primary_control_box_count > 0);
    assert.ok(geometry.control_occlusion_label_box_count > 0);
    assert.match(geometry.clip_surface, /map_host_canvas/);
    const controls = row.positive_controls;
    assert.ok(controls.overlap.overlapping_label_pair_count > 0);
    assert.ok(controls.overlap.overlapping_pairs_sample.flat().every(Boolean));
    assert.ok(controls.collision_drop.collision_dropped_label_count > 0);
    assert.ok(controls.collision_drop.collision_dropped_labels_sample.every(Boolean));
    assert.ok(controls.control_occlusion.label_box_count > 0);
    assert.ok(controls.control_occlusion.obscured_by_primary_control_count > 0);
    assert.ok(controls.control_occlusion.obscured_sample.every((sample) => sample.label));
    assert.ok(controls.frame_crossing.frame_crossing_label_count > 0);
    assert.ok(
      controls.frame_crossing.frame_crossing_labels_sample
        .includes(controls.frame_crossing.moved_label),
    );
    // Derived dataset flag must remain ignored, never the geometry source.
    assert.ok(Object.hasOwn(geometry, "dataset_overlap_flag_ignored"));
    for (const banned of ["result", "pass", "passed", "verdict"]) {
      assert.equal(Object.hasOwn(row, banned), false);
      assert.equal(Object.hasOwn(geometry, banned), false);
    }
  }

  const selectedRow = selected.find((row) => (
    row.selected_neighborhood_label === "Greenpoint" && row.viewport.width === 1440
  ));
  assert.ok(selectedRow);
  assert.equal(selectedRow.selected_neighborhood_label, "Greenpoint");
  assert.ok(
    (selectedRow.selected_layer_rendered_labels || []).includes("Greenpoint"),
  );
  assert.ok(selectedRow.selected_layer_rendered_label_count >= 1);
  assert.ok(
    selectedRow.selected_ui_label === "Greenpoint"
      || selectedRow.selected_heading === "Greenpoint",
  );
  assert.match(selectedRow.route, /geo=nta2020%3ABK0101/);

  const a9 = receipt.letters.A9.reads;
  assert.equal(a9.length, 2);
  for (const row of a9) {
    assertInRunRequestReceipt(row.request_receipt, runReceipt, receipt.deployment.revision);
    assert.ok(a13RequestIds.has(row.request_receipt.request_id));
    assert.equal(row.focus_trap_observed, false);
    assert.equal(typeof row.first_map_focus_index, "number");
    assert.equal(typeof row.exit_map_focus_index, "number");
    assert.ok(row.exit_map_focus_index > row.first_map_focus_index);
    assert.ok(Array.isArray(row.map_region_focus_steps));
    assert.ok(row.map_region_focus_steps.length >= 1);
    assert.ok(row.escape_path.tabs_from_map_host_to_leave_region >= 1);
    assert.match(row.escape_path.key_path, /Escape/);
    assert.ok(row.hover_equivalents.area_links_with_href >= 1);
    assert.equal(row.hover_equivalents.title_only_instruction_count, 0);
    assert.ok(row.focus_order.length >= 8);
  }
});

test("capture-manifest stays aligned with the Near You shell production read-back", () => {
  const receipt = loadJson(READBACK);
  const manifest = loadJson(MANIFEST);
  assert.equal(manifest.schema, "cityscroll.render_capture_manifest.v1");
  assert.equal(manifest.public_alias, "ced62a84f8213");
  assert.equal(manifest.revision, receipt.deployment.revision);
  assert.equal(manifest.repository_revision, receipt.deployment.revision);
  assert.equal(manifest.image_binaries_committed, false);
  assert.equal(manifest.captures.length, 8);
  assert.equal(manifest.capture_run_id, receipt.run_receipt.capture_run_id);
  assert.deepEqual(manifest.run_receipt, receipt.run_receipt);
  assert.equal(
    manifest.producer.path,
    "docs/evidence/near-you-shell-readback/read-back.json",
  );
  assert.deepEqual(manifest.producer.letters, ["A9", "A13"]);
  assert.match(manifest.condition, /Production base https:\/\/cityscroll\.org/);
  const selectedCapture = manifest.captures.find((row) => (
    row.name === "a13-selected-greenpoint-1440"
  ));
  assert.ok(selectedCapture);
  assert.match(selectedCapture.route, /geo=nta2020%3ABK0101/);
  assert.equal(selectedCapture.observed.selected_neighborhood_label, "Greenpoint");
  const desktopGeometry = manifest.captures.find((row) => row.name === "a13-desktop");
  assert.ok(desktopGeometry?.observed?.geometry);
  assert.equal(
    desktopGeometry.observed.geometry.measurement,
    "maplibre-collisionIndex-grid-bboxes+getBoundingClientRect",
  );
  assert.ok(desktopGeometry.observed.geometry.primary_control_box_count > 0);
  for (const row of manifest.captures) {
    assertInRunRequestReceipt(
      row.request_receipt,
      receipt.run_receipt,
      receipt.deployment.revision,
    );
  }
});

test("map host records collision observation fields for shell label capture", () => {
  assert.match(MAP_SOURCE, /dataset\.overlappingNeighborhoodLabelCount/);
  assert.match(MAP_SOURCE, /dataset\.labelTextAllowOverlap/);
  assert.match(MAP_SOURCE, /dataset\.labelTextIgnorePlacement/);
  assert.match(MAP_SOURCE, /text-allow-overlap/);
  assert.match(MAP_SOURCE, /text-ignore-placement/);
});

test("A13 branch read-back proves no collision drops, populated control clearance, and selected-name priority", () => {
  const manifest = loadJson(SHELL_MANIFEST);
  const enhanced = manifest.captures.filter((row) => (
    row.mode === "enhanced" && [1440, 390].includes(row.viewport.width)
  ));
  assert.equal(enhanced.length, 2);
  for (const row of enhanced) {
    const geometry = row.snapshot.a13_geometry;
    assert.equal(
      geometry.measurement,
      "maplibre-collisionIndex-grid-bboxes+getBoundingClientRect",
    );
    assert.ok(geometry.collision_source_label_count > 0);
    assert.equal(geometry.placed_label_count, geometry.collision_source_label_count);
    assert.equal(geometry.collision_dropped_label_count, 0);
    assert.equal(geometry.overlapping_label_pair_count, 0);
    assert.equal(typeof geometry.frame_crossing_label_count, "number");
    if (geometry.frame_crossing_label_count > 0) {
      assert.ok(geometry.frame_crossing_labels_sample.length > 0);
      assert.ok(geometry.frame_crossing_labels_sample.every(Boolean));
    }
    assert.ok(geometry.control_occlusion_label_box_count > 0);
    assert.equal(geometry.obscured_by_primary_control_count, 0);

    const controls = row.snapshot.a13_positive_controls;
    assert.ok(controls.overlap.overlapping_label_pair_count > 0);
    assert.ok(controls.overlap.overlapping_pairs_sample.flat().every(Boolean));
    assert.ok(controls.collision_drop.collision_dropped_label_count > 0);
    assert.ok(controls.collision_drop.collision_dropped_labels_sample.every(Boolean));
    assert.ok(controls.control_occlusion.label_box_count > 0);
    assert.ok(controls.control_occlusion.obscured_by_primary_control_count > 0);
    assert.ok(controls.control_occlusion.obscured_sample.every((sample) => sample.label));
    assert.ok(controls.frame_crossing.frame_crossing_label_count > 0);
    assert.ok(
      controls.frame_crossing.frame_crossing_labels_sample
        .includes(controls.frame_crossing.moved_label),
    );
  }

  const selected = manifest.captures.filter((row) => row.mode === "selected-enhanced");
  assert.equal(selected.length, 4);
  assert.deepEqual(
    new Set(selected.map((row) => row.snapshot.selected_neighborhood_label)),
    new Set(["Greenpoint", "East Village"]),
  );
  for (const row of selected) {
    const snapshot = row.snapshot;
    const expected = snapshot.selected_neighborhood_label;
    assert.ok([1440, 390].includes(row.viewport.width));
    assert.ok(snapshot.surrounding_placed_label_count > 0);
    assert.equal(
      snapshot.surrounding_placed_label_count,
      snapshot.surrounding_collision_source_label_count,
    );
    assert.ok(snapshot.selected_layer_rendered_labels.includes(expected));
    const control = snapshot.selected_priority_positive_control;
    assert.ok(control.selected_layer_rendered_labels.includes(expected));
    assert.ok(control.ordinary_collision_dropped_label_count > 0);
    assert.ok(control.ordinary_collision_dropped_labels_sample.every(Boolean));
  }
});

test("generator --check agrees with the retained Near You shell production read-back", () => {
  const result = spawnSync(
    "python3",
    ["tools/capture_near_you_shell_production_read.py", "--check"],
    { cwd: ROOT, encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /check passed/);
});

test("production read-back validation refuses an in-run served revision mismatch", () => {
  const result = spawnSync(
    "python3",
    [
      "-c",
      `import copy, json, sys
sys.path.insert(0, "tools")
import capture_near_you_shell_production_read as capture
receipt = json.loads(open(${JSON.stringify(READBACK)}, encoding="utf-8").read())
mutated = copy.deepcopy(receipt)
mutated["letters"]["A13"]["reads"][0]["request_receipt"]["served_manifest_read"]["served_revision"] = "0" * 40
try:
    capture.validate(mutated)
except AssertionError as error:
    assert "served revision mismatch" in str(error), error
else:
    raise AssertionError("revision mismatch was accepted")`,
    ],
    { cwd: ROOT, encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr || result.stdout);
});
