import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  D1_PUBLICATION_SNAPSHOT_KV_PLAN_SCHEMA,
  KV_VALUE_LIMIT_BYTES,
} from "../tools/d1_publication_snapshot_kv.mjs";
import {
  PublicationReceiptError,
  SNAPSHOT_SAVE_OUTCOMES,
  buildPublicationReceipt,
  buildSnapshotSaveFromKvPlan,
  resolveSnapshotSaveArgs,
  validatePublicationReceipt,
  validateSnapshotSave,
} from "../tools/d1_publication_receipt.mjs";

const FINGERPRINT = "a".repeat(64);
const SNAPSHOT_FP = "b".repeat(64);

function baseReceipt(overrides = {}) {
  return buildPublicationReceipt({
    run: { workflow: "Deploy worker", run_id: "1", attempt: 1 },
    outcome: "published",
    reason: "test receipt",
    deployFingerprint: FINGERPRINT,
    ...overrides,
  });
}

function samplePlan({ mode = "chunked", packed = 4_190_781 } = {}) {
  const puts = mode === "single"
    ? [{ key: "d1-publication:snapshot:v2:26", relative_path: "primary.json", bytes: packed }]
    : [
      { key: "d1-publication:snapshot:v2:26", relative_path: "primary.json", bytes: packed },
      { key: "d1-publication:snapshot:v2:26:chunk:0", relative_path: "chunk-0.json", bytes: packed },
      { key: "d1-publication:snapshot:v2:26:chunk:1", relative_path: "chunk-1.json", bytes: packed },
    ];
  return {
    schema: D1_PUBLICATION_SNAPSHOT_KV_PLAN_SCHEMA,
    mode,
    generation: 26,
    primary_key: "d1-publication:snapshot:v2:26",
    uncompressed_bytes: 26_290_670,
    uncompressed_sha256: SNAPSHOT_FP,
    gzip_bytes: 3_142_826,
    gzip_sha256: "c".repeat(64),
    packed_primary_bytes: packed,
    kv_limit_bytes: KV_VALUE_LIMIT_BYTES,
    puts,
  };
}

test("snapshot_save outcomes are the closed saved|failed|not_attempted set", () => {
  assert.deepEqual([...SNAPSHOT_SAVE_OUTCOMES], ["saved", "failed", "not_attempted"]);
});

test("saved observation is sourced from the pack plan", () => {
  const plan = samplePlan({ mode: "chunked", packed: 4_190_781 });
  const save = buildSnapshotSaveFromKvPlan({ plan, outcome: "saved" });
  assert.equal(save.outcome, "saved");
  assert.equal(save.encoding, "gzip-base64-chunked");
  assert.equal(save.chunk_count, 2);
  assert.equal(save.packed_bytes, 4_190_781);
  assert.equal(save.kv_limit_bytes, KV_VALUE_LIMIT_BYTES);
  assert.equal(save.fingerprint, SNAPSHOT_FP);
  assert.ok(!("platform_code" in save));

  const receipt = baseReceipt({ snapshotSave: save });
  assert.equal(receipt.snapshot_save.outcome, "saved");
  validatePublicationReceipt(receipt);
});

test("failed observation keeps measured packed_bytes vs kv_limit_bytes and platform_code", () => {
  // Historical gen24 shape: save failed at ~26.3 MiB against the 25 MiB limit.
  const save = buildSnapshotSaveFromKvPlan({
    outcome: "failed",
    packedBytes: 26_300_000,
    kvLimitBytes: KV_VALUE_LIMIT_BYTES,
    encoding: null,
    chunkCount: null,
    fingerprint: null,
    platformCode: 10024,
    reason: "Workers KV value exceeds 25MiB limit",
  });
  assert.equal(save.outcome, "failed");
  assert.equal(save.packed_bytes, 26_300_000);
  assert.equal(save.kv_limit_bytes, KV_VALUE_LIMIT_BYTES);
  assert.equal(save.platform_code, 10024);
  assert.equal(save.encoding, null);
  assert.equal(save.fingerprint, null);
  assert.ok(save.packed_bytes > save.kv_limit_bytes);

  const withPlan = buildSnapshotSaveFromKvPlan({
    plan: samplePlan({ mode: "single", packed: 4_190_781 }),
    outcome: "failed",
    platformCode: 10024,
    reason: "kv put failed after pack",
  });
  assert.equal(withPlan.outcome, "failed");
  assert.equal(withPlan.encoding, "gzip-base64");
  assert.equal(withPlan.chunk_count, 1);
  assert.equal(withPlan.packed_bytes, 4_190_781);
  assert.equal(withPlan.platform_code, 10024);

  const receipt = baseReceipt({
    outcome: "abandoned",
    reason: "record published failed after rebuild",
    snapshotSave: save,
  });
  assert.equal(receipt.snapshot_save.outcome, "failed");
  assert.equal(receipt.snapshot_save.platform_code, 10024);
});

test("not_attempted when no save step ran (no pack plan)", () => {
  const save = buildSnapshotSaveFromKvPlan({ plan: null });
  assert.equal(save.outcome, "not_attempted");
  assert.equal(save.encoding, null);
  assert.equal(save.chunk_count, null);
  assert.equal(save.packed_bytes, null);
  assert.equal(save.kv_limit_bytes, null);
  assert.equal(save.fingerprint, null);

  const receipt = baseReceipt({
    outcome: "skipped",
    reason: "fingerprint-unchanged",
    // Default path with no plan/outcome → not_attempted
  });
  assert.equal(receipt.snapshot_save.outcome, "not_attempted");
});

test("resolveSnapshotSaveArgs maps plan + record-published outcome", () => {
  const dir = mkdtempSync(join(tmpdir(), "d1-snapshot-save-"));
  try {
    const planPath = join(dir, "d1-snapshot-kv-plan.json");
    writeFileSync(planPath, `${JSON.stringify(samplePlan({ mode: "single" }), null, 2)}\n`);

    const saved = resolveSnapshotSaveArgs({
      planPath,
      recordPublishedOutcome: "success",
    });
    assert.equal(saved.outcome, "saved");
    assert.equal(saved.encoding, "gzip-base64");

    const failed = resolveSnapshotSaveArgs({
      planPath,
      recordPublishedOutcome: "failure",
      platformCode: 10024,
      reason: "put rejected",
    });
    assert.equal(failed.outcome, "failed");
    assert.equal(failed.platform_code, 10024);

    const skipped = resolveSnapshotSaveArgs({ planPath: join(dir, "missing.json") });
    assert.equal(skipped.outcome, "not_attempted");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("receipt validation refuses an absent snapshot_save field", () => {
  const receipt = baseReceipt();
  delete receipt.snapshot_save;
  assert.throws(
    () => validatePublicationReceipt(receipt),
    (error) => {
      assert.ok(error instanceof PublicationReceiptError);
      assert.match(error.message, /snapshot_save/);
      assert.match(error.message, /absence is distinct/);
      return true;
    },
  );
});

test("saved claim with packed_bytes over the limit is refused", () => {
  assert.throws(
    () => validateSnapshotSave({
      outcome: "saved",
      encoding: "gzip-base64",
      chunk_count: 1,
      packed_bytes: KV_VALUE_LIMIT_BYTES + 1,
      kv_limit_bytes: KV_VALUE_LIMIT_BYTES,
      fingerprint: SNAPSHOT_FP,
    }),
    /exceeds kv_limit_bytes/,
  );
});
