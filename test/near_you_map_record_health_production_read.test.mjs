import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const READBACK = join(ROOT, "docs/evidence/near-you-map-record-health/read-back.json");
const PRODUCTION = join(ROOT, "docs/evidence/near-you-map-record-health/production-read.json");
const MANIFEST = join(ROOT, "docs/evidence/near-you-map-record-health/capture-manifest.json");

function loadJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function assertCanonicalSortedJson(path) {
  const raw = readFileSync(path, "utf8");
  // Node JSON.stringify preserves insertion order from parse; rebuild via sorted keys.
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

test("map-record-health read-back records A3 pressed-retry recovery values", () => {
  assertCanonicalSortedJson(READBACK);
  assertCanonicalSortedJson(PRODUCTION);
  assertCanonicalSortedJson(MANIFEST);
  const receipt = loadJson(READBACK);
  assert.equal(receipt.schema, "cityscroll.near_you_map_record_health_production_read.v1");
  assert.equal(receipt.public_alias, "c42128caee453");
  assert.equal(receipt.evidence_class, "deployed-production-read-back");
  assert.match(receipt.deployment.revision, /^[0-9a-f]{40}$/);
  assert.equal(
    receipt.producer.path,
    "docs/evidence/near-you-map-record-health/read-back.json",
  );
  assert.deepEqual(receipt.producer.letters, ["A3"]);

  const a3 = receipt.letters.A3;
  assert.equal(a3.clause, "retry_succeeds_after_recoverable_read_failure");
  assert.ok(Array.isArray(a3.reads) && a3.reads.length >= 1);

  for (const row of a3.reads) {
    const values = row.served_values;
    assert.equal(values.before.deferred_state, "error");
    assert.equal(values.before.retry_present, true);
    assert.equal(values.action.retry_pressed, true);
    assert.equal(values.after.deferred_state, "ready");
    assert.equal(typeof values.after.results_heading, "string");
    assert.ok(values.after.results_heading.length > 0);
    assert.equal(values.after.heading, values.before.heading);
    assert.equal(values.neighborhood_context_intact, true);
    assert.equal(values.retry_preserved.geo, "nta2020:BK0101");
    assert.equal(values.retry_preserved.lens, "meetings");
    assert.equal("result" in values.after, false);
  }

  assert.ok((receipt.preservation_reads || []).length >= 6);
  assert.ok(
    receipt.preservation_reads.every((row) => !String(row.name || "").includes("retry-recovery")),
  );
});

test("map-record-health production-read stays aligned with the A3 read-back", () => {
  const receipt = loadJson(READBACK);
  const production = loadJson(PRODUCTION);
  assert.equal(production.schema, receipt.schema);
  assert.equal(production.public_alias, "c42128caee453");
  assert.deepEqual(production.producer.letters, ["A3"]);
  assert.equal(
    production.letters.A3.reads.length,
    receipt.letters.A3.reads.length,
  );
  assert.equal(
    production.deployment.revision,
    receipt.deployment.revision,
  );
});

test("capture-manifest includes preservation and recovery captures for A3", () => {
  const receipt = loadJson(READBACK);
  const manifest = loadJson(MANIFEST);
  assert.equal(manifest.schema, "cityscroll.render_capture_manifest.v1");
  assert.equal(manifest.public_alias, "c42128caee453");
  assert.equal(manifest.image_binaries_committed, false);
  assert.deepEqual(manifest.producer.letters, ["A3"]);
  assert.equal(manifest.revision, receipt.deployment.revision);
  const names = new Set((manifest.captures || []).map((row) => row.name));
  for (const row of receipt.letters.A3.reads) {
    assert.ok(names.has(row.name), `missing recovery capture ${row.name}`);
  }
  assert.ok(
    [...names].some((name) => String(name).includes("production-record-failure")),
    "preservation failure captures must remain",
  );
});

test("generator --check agrees with the retained map-record-health recovery read-back", () => {
  const result = spawnSync(
    "python3",
    ["tools/capture_near_you_map_record_health_retry_recovery_production_read.py", "--check"],
    { cwd: ROOT, encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /check passed/);
});
