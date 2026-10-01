import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const READBACK = join(ROOT, "docs/evidence/geography-navigation-preserve-place/read-back.json");
const PRODUCTION = join(
  ROOT,
  "docs/evidence/geography-navigation-preserve-place/production-read.json",
);
const MANIFEST = join(
  ROOT,
  "docs/evidence/geography-navigation-preserve-place/capture-manifest.json",
);
const DELIVERY = join(
  ROOT,
  "docs/evidence/geography-navigation-preserve-place/delivery.json",
);
const CAPTURE_TOOL = join(
  ROOT,
  "tools/capture_near_you_map_health_preserve_place_production_read.py",
);

const CAMERA_COMPARE_TYPES = [
  "police_precinct",
  "community_district",
  "council_district",
];

const CAMERA_PAGE_EXTRACTED_FIELDS = [
  "camera.center.lng",
  "camera.center.lat",
  "camera.zoom",
  "heading",
  "geo",
  "lens",
  "compare",
  "selected_key",
  "active_layer",
];

function loadJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function assertCanonicalSortedJson(path) {
  const raw = readFileSync(path, "utf8");
  const sorted = `${JSON.stringify(sortKeysDeep(JSON.parse(raw)), null, 2)}\n`;
  assert.equal(raw, sorted, `${path} must be committed as sorted-key JSON`);
}

function sortKeysDeep(value) {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, sortKeysDeep(value[key])]),
    );
  }
  return value;
}

test("preserve-place read-back records A1 observed Greenpoint and Precinct 94 values", () => {
  assertCanonicalSortedJson(READBACK);
  assertCanonicalSortedJson(PRODUCTION);
  assertCanonicalSortedJson(MANIFEST);
  const receipt = loadJson(READBACK);
  assert.equal(receipt.schema, "cityscroll.near_you_preserve_place_production_read.v1");
  assert.equal(receipt.public_alias, "cc669bf6bea4a");
  assert.equal(receipt.evidence_class, "deployed-production-read-back");
  assert.match(receipt.deployment.revision, /^[0-9a-f]{40}$/);
  assert.equal(
    receipt.producer.path,
    "docs/evidence/geography-navigation-preserve-place/read-back.json",
  );
  assert.deepEqual(receipt.producer.letters, ["A1"]);

  const a1 = receipt.letters.A1;
  assert.equal(a1.clause, "preserved_place_shown_through_boundary_comparison");
  assert.ok(Array.isArray(a1.reads) && a1.reads.length >= 2);

  for (const row of a1.reads) {
    const values = row.served_values;
    assert.ok(values && typeof values === "object", `${row.name} must carry served_values`);
    assert.equal(values.heading, "Greenpoint");
    assert.match(String(values.overlap_label || ""), /Police Precinct 94/);
    assert.equal(values.compare, "police_precinct");
    assert.equal(values.active_layer, "nta2020");
    assert.equal(values.place_preserved, true);
    assert.equal(values.precinct_shown, true);
    assert.equal("result" in values, false);
    assert.equal("pass" in values, false);
  }
});

test("preserve-place A1 camera rows are page-extracted and equal within recorded tolerance", () => {
  const receipt = loadJson(READBACK);
  const delivery = loadJson(DELIVERY);
  const a1 = receipt.letters.A1;
  const cameraReads = a1.camera_reads;
  assert.ok(Array.isArray(cameraReads) && cameraReads.length === 6, "three compares × two viewports");
  assert.equal(delivery.schema, "cityscroll.capture_delivery.v1");
  assert.equal(delivery.public_alias, "cc669bf6bea4a");
  assert.equal(receipt.deployment.required_ancestor, delivery.landed_commit);
  assert.equal(receipt.deployment.required_ancestor_contained, true);

  const tolerance = receipt.capture.camera_tolerance;
  assert.ok(tolerance && typeof tolerance.center_degrees === "number");
  assert.ok(typeof tolerance.zoom === "number");
  assert.deepEqual(receipt.capture.camera_page_extracted_fields, CAMERA_PAGE_EXTRACTED_FIELDS);

  const byViewport = new Map();
  for (const row of cameraReads) {
    const values = row.served_values;
    assert.ok(values?.camera, `${row.name} must carry page-observed camera`);
    assert.equal(typeof values.camera.center.lng, "number", `${row.name} camera.center.lng`);
    assert.equal(typeof values.camera.center.lat, "number", `${row.name} camera.center.lat`);
    assert.equal(typeof values.camera.zoom, "number", `${row.name} camera.zoom`);
    assert.equal(values.heading, "Greenpoint");
    assert.ok(CAMERA_COMPARE_TYPES.includes(values.compare), values.compare);
    assert.equal(values.active_layer, "nta2020");
    assert.equal(row.revision, receipt.deployment.revision);
    assert.ok(row.route, `${row.name} route`);
    assert.ok(row.viewport?.width && row.viewport?.height, `${row.name} viewport`);
    assert.deepEqual(values.camera_page_extracted_fields, CAMERA_PAGE_EXTRACTED_FIELDS);
    assert.deepEqual(values.camera_tolerance, tolerance);
    assert.equal("result" in values, false);
    assert.equal("pass" in values, false);

    const key = `${row.viewport.width}x${row.viewport.height}`;
    if (!byViewport.has(key)) byViewport.set(key, []);
    byViewport.get(key).push(row);
  }

  assert.equal(byViewport.size, 2);
  for (const [viewport, rows] of byViewport) {
    assert.equal(rows.length, 3, `${viewport} must cover three compares`);
    const compares = new Set(rows.map((row) => row.served_values.compare));
    assert.deepEqual([...compares].sort(), [...CAMERA_COMPARE_TYPES].sort());
    const baseline = rows[0].served_values.camera;
    for (const row of rows.slice(1)) {
      const camera = row.served_values.camera;
      assert.ok(
        Math.abs(camera.center.lng - baseline.center.lng) <= tolerance.center_degrees,
        `${row.name} lng retained`,
      );
      assert.ok(
        Math.abs(camera.center.lat - baseline.center.lat) <= tolerance.center_degrees,
        `${row.name} lat retained`,
      );
      assert.ok(
        Math.abs(camera.zoom - baseline.zoom) <= tolerance.zoom,
        `${row.name} zoom retained`,
      );
    }
  }

  assert.equal(a1.camera_retention.length, 2);
  for (const group of a1.camera_retention) {
    assert.equal(group.equal, true);
    assert.deepEqual(group.tolerance, tolerance);
    assert.equal(group.compare_types.length, 3);
    assert.equal(group.revision, receipt.deployment.revision);
  }
});

test("preserve-place production-read stays aligned with the A1 read-back", () => {
  const receipt = loadJson(READBACK);
  const production = loadJson(PRODUCTION);
  assert.equal(production.schema, receipt.schema);
  assert.equal(production.public_alias, "cc669bf6bea4a");
  assert.deepEqual(production.producer.letters, ["A1"]);
  assert.equal(production.letters.A1.reads.length, receipt.letters.A1.reads.length);
  assert.equal(production.letters.A1.camera_reads.length, receipt.letters.A1.camera_reads.length);
  assert.equal(production.deployment.revision, receipt.deployment.revision);
});

test("capture-manifest includes A1 place and camera captures", () => {
  const receipt = loadJson(READBACK);
  const manifest = loadJson(MANIFEST);
  assert.equal(manifest.schema, "cityscroll.render_capture_manifest.v1");
  assert.equal(manifest.public_alias, "cc669bf6bea4a");
  assert.equal(manifest.image_binaries_committed, false);
  assert.deepEqual(manifest.producer.letters, ["A1"]);
  assert.equal(manifest.revision, receipt.deployment.revision);
  assert.deepEqual(manifest.camera_tolerance, receipt.capture.camera_tolerance);
  const names = new Set((manifest.captures || []).map((row) => row.name));
  for (const row of receipt.letters.A1.reads) {
    assert.ok(names.has(row.name), `missing A1 capture ${row.name}`);
    assert.ok(row.served_values?.heading === "Greenpoint");
    assert.match(String(row.served_values?.overlap_label || ""), /Police Precinct 94/);
  }
  for (const row of receipt.letters.A1.camera_reads) {
    assert.ok(names.has(row.name), `missing A1 camera capture ${row.name}`);
    assert.equal(typeof row.served_values?.camera?.zoom, "number");
  }
});

test("generator --check agrees with the retained preserve-place A1 read-back", () => {
  const result = spawnSync(
    "python3",
    ["tools/capture_near_you_map_health_preserve_place_production_read.py", "--check"],
    { cwd: ROOT, encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /check passed/);
});

test("A1 camera helpers refuse missing cameras and record page-extracted fields", () => {
  const source = readFileSync(CAPTURE_TOOL, "utf8");
  assert.match(source, /CAMERA_PAGE_EXTRACTED_FIELDS/);
  assert.match(source, /camera\.center\.lng/);
  assert.match(source, /read_page_camera/);
  assert.match(source, /assert_cameras_retained/);
  assert.match(source, /--mutation-control/);
  assert.match(source, /map camera absent or unreadable/);
  assert.match(source, /camera diverged across comparison switches/);
  // Positive control: the helper names which fields come from the page.
  for (const field of CAMERA_PAGE_EXTRACTED_FIELDS) {
    assert.match(source, new RegExp(field.replace(/\./g, "\\.")));
  }
});
