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

test("preserve-place production-read stays aligned with the A1 read-back", () => {
  const receipt = loadJson(READBACK);
  const production = loadJson(PRODUCTION);
  assert.equal(production.schema, receipt.schema);
  assert.equal(production.public_alias, "cc669bf6bea4a");
  assert.deepEqual(production.producer.letters, ["A1"]);
  assert.equal(production.letters.A1.reads.length, receipt.letters.A1.reads.length);
  assert.equal(production.deployment.revision, receipt.deployment.revision);
});

test("capture-manifest includes A1 Greenpoint/Precinct 94 captures", () => {
  const receipt = loadJson(READBACK);
  const manifest = loadJson(MANIFEST);
  assert.equal(manifest.schema, "cityscroll.render_capture_manifest.v1");
  assert.equal(manifest.public_alias, "cc669bf6bea4a");
  assert.equal(manifest.image_binaries_committed, false);
  assert.deepEqual(manifest.producer.letters, ["A1"]);
  assert.equal(manifest.revision, receipt.deployment.revision);
  const names = new Set((manifest.captures || []).map((row) => row.name));
  for (const row of receipt.letters.A1.reads) {
    assert.ok(names.has(row.name), `missing A1 capture ${row.name}`);
    assert.ok(row.served_values?.heading === "Greenpoint");
    assert.match(String(row.served_values?.overlap_label || ""), /Police Precinct 94/);
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
