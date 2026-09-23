import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const READBACK = join(ROOT, "docs/evidence/near-you-shell-readback/read-back.json");
const MANIFEST = join(ROOT, "docs/evidence/near-you-shell-readback/capture-manifest.json");
const MAP_SOURCE = readFileSync(join(ROOT, "site/geography_navigation_map.mjs"), "utf8");

function loadJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

test("retained Near You shell production read-back carries observed A9/A13 values", () => {
  const receipt = loadJson(READBACK);
  assert.equal(receipt.schema, "cityscroll.near_you_shell_production_read.v1");
  assert.equal(receipt.public_alias, "ced62a84f8213");
  assert.equal(receipt.evidence_class, "deployed-production-read-back");
  assert.match(receipt.deployment.revision, /^[0-9a-f]{40}$/);
  assert.equal(
    receipt.producer.path,
    "docs/evidence/near-you-shell-readback/read-back.json",
  );
  assert.deepEqual(receipt.producer.letters, ["A9", "A13"]);

  const a13 = receipt.letters.A13.reads;
  assert.equal(a13.length, 2);
  const desktop = a13.find((row) => row.viewport.width === 1440);
  const mobile = a13.find((row) => row.viewport.width === 390);
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
  for (const row of a13) {
    assert.equal(row.map_runtime, "maplibre");
    assert.equal(row.text_allow_overlap, false);
    assert.equal(row.text_ignore_placement, false);
    assert.equal(row.overlapping_label_pair_count, 0);
    assert.equal(row.residential_neighborhood_labels.length, row.residential_neighborhood_label_count);
    assert.ok(row.residential_neighborhood_label_count > 0);
  }

  const a9 = receipt.letters.A9.reads;
  assert.equal(a9.length, 2);
  for (const row of a9) {
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
  assert.ok(manifest.captures.length >= 4);
  assert.equal(
    manifest.producer.path,
    "docs/evidence/near-you-shell-readback/read-back.json",
  );
  assert.deepEqual(manifest.producer.letters, ["A9", "A13"]);
  assert.match(manifest.condition, /Production base https:\/\/cityscroll\.org/);
});

test("map host records collision observation fields for shell label capture", () => {
  assert.match(MAP_SOURCE, /dataset\.overlappingNeighborhoodLabelCount/);
  assert.match(MAP_SOURCE, /dataset\.labelTextAllowOverlap/);
  assert.match(MAP_SOURCE, /dataset\.labelTextIgnorePlacement/);
  assert.match(MAP_SOURCE, /text-allow-overlap/);
  assert.match(MAP_SOURCE, /text-ignore-placement/);
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
