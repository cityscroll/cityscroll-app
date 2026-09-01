import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  buildKeywordSearchIndexShardArtifacts,
  combineKeywordSearchIndexShards,
  readKeywordSearchIndexFromShards,
  writeKeywordSearchIndexShardArtifacts,
} from "../site/keyword_search_index_shards.mjs";

const index = {
  schema: "cityscroll.keyword_search_index.v1",
  generated_at: "2026-08-29T00:00:00.000Z",
  match_mode: "keyword",
  families: {
    people: {
      source: "People",
      as_of: "2026-08-28",
      source_row_count: 1,
      indexed_count: 1,
      coverage: [{ state: "matched" }],
      documents: [{ object_ref: "person:1", title: "A person" }],
    },
    procurements: {
      source: "Procurement",
      as_of: "2026-08-28",
      source_row_count: 1,
      indexed_count: 1,
      coverage: [{ state: "matched" }],
      documents: [{ object_ref: "procurement:1", title: "A contract" }],
    },
  },
  build_receipt: { source_artifacts: { people: "people.json" } },
  coherence_receipt: { schema: "cityscroll.procurement_index_coherence.v1" },
};

test("compressed family shards round-trip the logical index and record both transports", () => {
  const artifacts = buildKeywordSearchIndexShardArtifacts(index);
  assert.equal(artifacts.manifest.representation, "family-sharded-compressed");
  assert.equal(artifacts.manifest.shards.length, 2);
  assert.deepEqual(combineKeywordSearchIndexShards(
    artifacts.manifest,
    artifacts.shards.map((shard) => shard.payload),
  ), index);
  for (const shard of artifacts.shards) {
    assert.equal(shard.payload.family, shard.descriptor.family);
    assert.equal(shard.payload.receipt.family, shard.descriptor.family);
    assert.ok(shard.descriptor.gzip_bytes > 0);
    assert.ok(shard.descriptor.brotli_bytes > 0);
    assert.ok(shard.descriptor.gzip_sha256);
    assert.ok(shard.descriptor.brotli_sha256);
  }
});

test("the shard reader fails closed when a compressed family is stale", () => {
  const dir = mkdtempSync(join(tmpdir(), "keyword-search-shards-"));
  try {
    const artifacts = buildKeywordSearchIndexShardArtifacts(index);
    writeKeywordSearchIndexShardArtifacts(artifacts, dir);
    const manifestPath = join(dir, "manifest.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    manifest.logical_index.sha256 = "0".repeat(64);
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    assert.throws(() => readKeywordSearchIndexFromShards(dir), /source\/index mismatch/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the shard reader fails closed when either compressed transport is missing or tampered", () => {
  for (const mode of ["missing", "tampered"]) {
    const dir = mkdtempSync(join(tmpdir(), "keyword-search-shards-"));
    try {
      const artifacts = buildKeywordSearchIndexShardArtifacts(index);
      writeKeywordSearchIndexShardArtifacts(artifacts, dir);
      const gzipPath = join(dir, artifacts.shards[0].descriptor.gzip_path);
      if (mode === "missing") unlinkSync(gzipPath);
      else writeFileSync(gzipPath, Buffer.from("tampered"));
      assert.throws(
        () => readKeywordSearchIndexFromShards(dir),
        mode === "missing" ? /shard missing: people/ : /gzip shard hash or byte-count mismatch: people/,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

test("the shard reader fails closed when the family set is incomplete", () => {
  const dir = mkdtempSync(join(tmpdir(), "keyword-search-shards-"));
  try {
    const artifacts = buildKeywordSearchIndexShardArtifacts(index);
    writeKeywordSearchIndexShardArtifacts(artifacts, dir);
    const manifestPath = join(dir, "manifest.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    manifest.shards.pop();
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    assert.throws(() => readKeywordSearchIndexFromShards(dir), /family set is incomplete or duplicated/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
