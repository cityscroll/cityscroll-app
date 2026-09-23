import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const READBACK = join(ROOT, "docs/evidence/residential-directory-readback/read-back.json");
const MANIFEST = join(ROOT, "docs/evidence/residential-directory-readback/capture-manifest.json");
const SHELL_TEST = readFileSync(join(ROOT, "test/geography_navigation_shell.test.mjs"), "utf8");
const ENTRY_TEST = readFileSync(join(ROOT, "test/geography_navigation_entry.test.mjs"), "utf8");

const EXPECTED_BOROUGHS = ["Bronx", "Brooklyn", "Manhattan", "Queens", "Staten Island"];
const DIRECTORY_FIXTURES = [
  "BK0101",
  "MN0102",
  "QN0103",
  "BX0101",
  "SI0101",
  "QN8381",
  "BK0771",
];

function loadJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

test("retained residential-directory production read-back carries observed A1/A2 values", () => {
  const receipt = loadJson(READBACK);
  assert.equal(receipt.schema, "cityscroll.residential_directory_production_read.v1");
  assert.equal(receipt.public_alias, "cd5ed919f3be2");
  assert.equal(receipt.evidence_class, "deployed-production-read-back");
  assert.match(receipt.deployment.revision, /^[0-9a-f]{40}$/);
  assert.equal(
    receipt.producer.path,
    "docs/evidence/residential-directory-readback/read-back.json",
  );
  assert.deepEqual(receipt.producer.letters, ["A1", "A2"]);

  const a1 = receipt.letters.A1.observed;
  assert.deepEqual(a1.borough_group_order, EXPECTED_BOROUGHS);
  assert.equal(a1.borough_groups.length, 5);
  assert.ok(a1.residential_link_count >= 190);
  assert.equal(a1.special_use.summary_label, "Special-use areas");
  for (const row of a1.special_use.named_reachable) {
    assert.equal(row.in_special_use_directory, true, row.id);
    assert.equal(row.in_residential_directory, false, row.id);
    assert.ok(row.observed_label, row.id);
  }
  assert.ok(a1.special_use.airport_ids_sample.includes("QN8381"));
  assert.ok(a1.special_use.cemetery_ids_sample.includes("BK0771"));
  assert.equal(a1.filter_control.param_name, "area_q");

  const a2Reads = receipt.letters.A2.reads;
  assert.ok(a2Reads.length >= 6);
  for (const read of a2Reads) {
    assert.equal(read.script_tags_after_strip, 0);
    assert.equal(read.java_script_enabled, false);
    assert.deepEqual(read.location_permission_events_observed, []);
    assert.match(read.dom_sha256, /^[0-9a-f]{64}$/);
  }

  const aliasReads = a2Reads.filter((row) => row.alias);
  assert.ok(aliasReads.length >= 2);
  for (const read of aliasReads) {
    assert.ok(read.alias.matched_ids.includes("MN0102"));
  }

  const nomatchReads = a2Reads.filter((row) => row.no_match);
  assert.ok(nomatchReads.length >= 2);
  for (const read of nomatchReads) {
    assert.match(read.no_match.empty_status_text, /No neighborhoods match/i);
    assert.equal(read.no_match.residential_link_count, 0);
    assert.equal(read.no_match.special_use_directory_present, true);
    assert.equal(read.no_match.special_use_filter_empty_message_present, true);
  }

  const entryReads = a2Reads.filter((row) => row.route === "/near-you/");
  assert.ok(entryReads.some((row) => row.native_link_count > 0));
  for (const read of entryReads) {
    assert.ok(read.closed_area_links_in_tab_order < 262);
    assert.equal(read.keyboard_reached.browse_records, true);
  }
});

test("capture-manifest stays aligned with the production read-back", () => {
  const receipt = loadJson(READBACK);
  const manifest = loadJson(MANIFEST);
  assert.equal(manifest.schema, "cityscroll.render_capture_manifest.v1");
  assert.equal(manifest.public_alias, "cd5ed919f3be2");
  assert.equal(manifest.revision, receipt.deployment.revision);
  assert.equal(manifest.repository_revision, receipt.deployment.revision);
  assert.equal(manifest.image_binaries_committed, false);
  assert.ok(manifest.captures.length >= 7);
  assert.equal(
    manifest.producer.path,
    "docs/evidence/residential-directory-readback/read-back.json",
  );
});

test("A3 offline fixtures for the seven named places remain in shell and entry suites", () => {
  for (const id of DIRECTORY_FIXTURES) {
    assert.match(SHELL_TEST, new RegExp(`id: "${id}"`));
    assert.match(ENTRY_TEST, new RegExp(`id: "${id}"`));
  }
  assert.match(SHELL_TEST, /A3: directory fixtures and Browse records precede the area-link tab sequence/);
  assert.match(ENTRY_TEST, /A3: directory fixtures resolve through retained labels and aliases/);
  assert.match(SHELL_TEST, /defaultTabAreaLinks < 262/);
});

test("generator --check agrees with the retained production read-back", () => {
  const result = spawnSync(
    "python3",
    ["tools/capture_residential_directory_production_read.py", "--check"],
    { cwd: ROOT, encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /check passed/);
});
