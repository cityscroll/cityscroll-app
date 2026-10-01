import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { gzipSync } from "node:zlib";

import { SNAPSHOT_SCHEMA } from "../tools/d1_delta_plan.mjs";
import {
  D1_PUBLICATION_SNAPSHOT_KV_PLAN_SCHEMA,
  D1_PUBLICATION_SNAPSHOT_KV_SCHEMA,
  KV_VALUE_LIMIT_BYTES,
  assertKvValueFits,
  packSnapshotForKv,
  snapshotChunkKey,
  snapshotKeyForGeneration,
  unpackSnapshotFromKv,
  writePackPlan,
} from "../tools/d1_publication_snapshot_kv.mjs";

const OVERSIZE_UNCOMPRESSED_BYTES = (25 * 1024 * 1024) + (256 * 1024);

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function buildLargeSnapshot(targetBytes) {
  // Highly compressible JSON so gzip stays well under the KV limit while the
  // uncompressed document still exceeds 25 MiB (the Deploy worker failure mode).
  const padUnit = "abcdefghijklmnopqrstuvwxyz0123456789";
  const models = {
    entity_intelligence: {
      model_id: "entity_intelligence",
      partitions: {
        "__model__": {
          watermark: "2026-10-01T00:00:00.000Z",
          rows: {
            current: {
              fp: "a".repeat(32),
              kv: ["h:fixture"],
              pad: "",
            },
          },
        },
      },
    },
  };
  let snapshot = {
    schema: SNAPSHOT_SCHEMA,
    manifest_fingerprint: "b".repeat(64),
    models,
  };
  let text = `${JSON.stringify(snapshot)}\n`;
  if (text.length >= targetBytes) return Buffer.from(text, "utf8");
  const need = targetBytes - text.length + 64;
  const repeats = Math.ceil(need / padUnit.length);
  snapshot.models.entity_intelligence.partitions.__model__.rows.current.pad = padUnit.repeat(repeats);
  text = `${JSON.stringify(snapshot)}\n`;
  while (Buffer.byteLength(text, "utf8") < targetBytes) {
    snapshot.models.entity_intelligence.partitions.__model__.rows.current.pad += padUnit;
    text = `${JSON.stringify(snapshot)}\n`;
  }
  return Buffer.from(text, "utf8");
}

test("assertKvValueFits names the measured size and limit when a value is over budget", () => {
  const key = snapshotKeyForGeneration(24);
  assert.throws(
    () => assertKvValueFits(KV_VALUE_LIMIT_BYTES + 1, { key, label: "packed D1 publication snapshot" }),
    (error) => {
      assert.match(String(error.message), /exceeds Workers KV limit/);
      assert.match(String(error.message), new RegExp(`key=${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
      assert.match(String(error.message), new RegExp(`size=${KV_VALUE_LIMIT_BYTES + 1} bytes`));
      assert.match(String(error.message), new RegExp(`limit=${KV_VALUE_LIMIT_BYTES} bytes`));
      return true;
    },
  );
  assert.equal(assertKvValueFits(KV_VALUE_LIMIT_BYTES, { key }), KV_VALUE_LIMIT_BYTES);
});

test("a snapshot larger than 25 MiB uncompressed packs under the KV limit and round-trips", () => {
  const raw = buildLargeSnapshot(OVERSIZE_UNCOMPRESSED_BYTES);
  assert.ok(raw.byteLength > KV_VALUE_LIMIT_BYTES, `fixture must exceed KV limit uncompressed (got ${raw.byteLength})`);

  const plan = packSnapshotForKv(raw, { generation: 24 });
  assert.equal(plan.schema, D1_PUBLICATION_SNAPSHOT_KV_PLAN_SCHEMA);
  assert.equal(plan.mode, "single");
  assert.equal(plan.primary_key, "d1-publication:snapshot:v2:24");
  assert.equal(plan.uncompressed_bytes, raw.byteLength);
  assert.equal(plan.uncompressed_sha256, sha256(raw));
  assert.ok(plan.packed_primary_bytes < KV_VALUE_LIMIT_BYTES);
  assert.ok(plan.gzip_bytes < plan.uncompressed_bytes);
  assert.equal(plan.puts.length, 1);

  const primary = plan.values[plan.primary_key];
  const envelope = JSON.parse(primary);
  assert.equal(envelope.schema, D1_PUBLICATION_SNAPSHOT_KV_SCHEMA);
  assert.equal(envelope.encoding, "gzip-base64");
  assert.ok(Buffer.byteLength(primary, "utf8") <= KV_VALUE_LIMIT_BYTES);

  const unpacked = unpackSnapshotFromKv(primary);
  assert.equal(sha256(unpacked), sha256(raw));
  assert.deepEqual(JSON.parse(unpacked.toString("utf8")), JSON.parse(raw.toString("utf8")));
});

test("chunked packing splits when the compressed envelope still exceeds the limit", () => {
  // Incompressible payload so gzip cannot shrink the single envelope under a
  // tiny artificial limit; production stays on the single-key path for gen24.
  const entropy = randomBytes(96 * 1024);
  const raw = Buffer.from(`${JSON.stringify({
    schema: SNAPSHOT_SCHEMA,
    manifest_fingerprint: "d".repeat(64),
    models: {
      entity_intelligence: {
        model_id: "entity_intelligence",
        partitions: {
          __model__: {
            watermark: "2026-10-01T00:00:00.000Z",
            rows: { current: { fp: "e".repeat(32), kv: ["h:chunk"], blob: entropy.toString("base64") } },
          },
        },
      },
    },
  })}\n`, "utf8");
  const tinyLimit = 12 * 1024;
  const plan = packSnapshotForKv(raw, {
    generation: 7,
    limitBytes: tinyLimit,
    chunkPayloadBudgetBytes: 2 * 1024,
  });
  assert.equal(plan.mode, "chunked");
  assert.ok(plan.puts.length > 2, `expected manifest plus multiple chunks, got ${plan.puts.length}`);
  assert.equal(plan.puts[0].key, snapshotKeyForGeneration(7));
  assert.equal(plan.puts[1].key, snapshotChunkKey(7, 0));
  for (const put of plan.puts) {
    assert.ok(put.bytes <= tinyLimit, `${put.key} bytes ${put.bytes} over tiny limit`);
    assertKvValueFits(plan.values[put.key], { key: put.key, limitBytes: tinyLimit });
  }

  const dir = mkdtempSync(join(tmpdir(), "d1-snap-kv-"));
  try {
    writePackPlan(plan, dir);
    const primary = readFileSync(join(dir, "primary.json"), "utf8");
    const chunksByKey = {};
    for (const put of plan.puts.slice(1)) {
      chunksByKey[put.key] = readFileSync(join(dir, put.relative_path), "utf8");
    }
    const unpacked = unpackSnapshotFromKv(primary, { chunksByKey });
    assert.equal(sha256(unpacked), sha256(raw));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("legacy raw partition snapshots still unpack", () => {
  const legacy = `${JSON.stringify({
    schema: SNAPSHOT_SCHEMA,
    manifest_fingerprint: "c".repeat(64),
    models: {},
  }, null, 2)}\n`;
  const unpacked = unpackSnapshotFromKv(legacy);
  assert.equal(unpacked.toString("utf8"), legacy);
});

test("assert-fits CLI refuses an oversize packed path loudly", () => {
  const dir = mkdtempSync(join(tmpdir(), "d1-snap-kv-assert-"));
  try {
    const path = join(dir, "too-big.json");
    writeFileSync(path, "x".repeat(KV_VALUE_LIMIT_BYTES + 3));
    const result = spawnSync(process.execPath, [
      "tools/d1_publication_snapshot_kv.mjs",
      "assert-fits",
      "--path", path,
      "--key", "d1-publication:snapshot:v2:99",
    ], { encoding: "utf8" });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /exceeds Workers KV limit/);
    assert.match(result.stderr, /size=/);
    assert.match(result.stderr, /limit=/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// Keep a direct gzip sanity check aligned with the measured gen24 artifact shape.
test("gzip of a >25MiB compressible snapshot stays far under the KV limit", () => {
  const raw = buildLargeSnapshot(OVERSIZE_UNCOMPRESSED_BYTES);
  const gzipBytes = gzipSync(raw, { level: 9 }).byteLength;
  assert.ok(gzipBytes < 5 * 1024 * 1024, `unexpectedly large gzip ${gzipBytes}`);
  assert.ok(gzipBytes < KV_VALUE_LIMIT_BYTES);
});
