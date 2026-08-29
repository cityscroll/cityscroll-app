import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MANIFEST_PATH = path.join(ROOT, "warehouse/derived_json_build_manifest.json");

test("derived JSON manifest pins static delivery and a retained source snapshot", () => {
  const manifest = JSON.parse(readFileSync(MANIFEST_PATH, "utf8"));
  assert.equal(manifest.schema, "cityscroll.derived_json_build_manifest.v1");
  assert.equal(manifest.delivery.public_tree, "site/data");
  assert.equal(manifest.delivery.mode, "materialized-static");
  assert.equal(manifest.delivery.request_time_source_reads, false);
  assert.equal(manifest.ci_time_budget.seconds, 900);
  assert.equal(manifest.ci_time_budget.scope, "derived-json-build-boundary");
  assert.match(manifest.source_snapshot.sha256, /^[a-f0-9]{64}$/);
  assert.ok(manifest.source_snapshot.required_receipts.length >= 4);
  assert.ok(manifest.generated_families.length >= 10);
  assert.equal(
    new Set(manifest.generated_families.map((family) => family.id)).size,
    manifest.generated_families.length,
  );
  for (const family of manifest.generated_families) {
    assert.ok(family.generator);
    assert.ok(family.source_paths.length);
    assert.ok(family.output_paths.length);
  }
});

test("keyword search boundary tracks the committed sharded output tree", () => {
  const manifest = JSON.parse(readFileSync(MANIFEST_PATH, "utf8"));
  const family = manifest.generated_families.find(({ id }) => id === "keyword-search");
  assert.ok(family);
  assert.deepEqual(family.output_paths, ["worker/src/data/keyword_search_index_shards"]);
  assert.ok(existsSync(path.join(ROOT, family.output_paths[0])));
  assert.equal(existsSync(path.join(ROOT, "worker/src/data/keyword_search_index.json")), false);
});

test("the retained source snapshot validation fails closed before generation", () => {
  const result = spawnSync(process.execPath, [
    path.join(ROOT, "tools/derived_json_build_boundary.mjs"),
    "--source-dir",
    ROOT,
    "--validate-only",
  ], { cwd: ROOT, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Derived JSON build boundary valid/);
});

test("payload integrity can inspect the materialized artifact directory", () => {
  const artifact = mkdtempSync(path.join(os.tmpdir(), "cityscroll-pages-"));
  try {
    mkdirSync(path.join(artifact, "data"));
    writeFileSync(path.join(artifact, "index.html"), "<!doctype html><title>CityScroll</title>\n");
    writeFileSync(path.join(artifact, "data", "example.json"), "{}\n");
    const result = spawnSync(process.execPath, [
      path.join(ROOT, "tools/check_public_payload_integrity.mjs"),
      "--site-dir",
      artifact,
    ], { cwd: ROOT, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /1 payload trees/);
  } finally {
    rmSync(artifact, { recursive: true, force: true });
  }
});
