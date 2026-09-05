import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { oversizedKvPayloads, inspectBundle, WORKER_COMPRESSED_LIMIT_BYTES, WORKER_RAW_LIMIT_BYTES, WORKER_STARTUP_LIMIT_MS } from "../tools/worker_deploy_guard.mjs";
import { withTempDir } from "../tools/lib/with_temp_dir.mjs";

test("Worker budget guard stays quiet for healthy raw, compressed, startup, and KV values", async () => {
  await withTempDir("budget", async (dir) => {
    const bundle = join(dir, "bundle.js");
    await writeFile(bundle, "small worker");
    const meta = join(dir, "meta.json");
    await writeFile(meta, JSON.stringify({ outputs: { [bundle]: { entryPoint: "worker/src/worker.mjs", bytes: 100, compressedBytes: 100, startupTimeMs: 50, inputs: {} } } }));
    assert.deepEqual(inspectBundle(meta), { rawBytes: 100, compressedBytes: 100, startupMs: 50 });
    await mkdir(join(dir, "kv"));
    await writeFile(join(dir, "kv", "bulk.json"), JSON.stringify([{ key: "ok", value: "value" }]));
    assert.deepEqual(oversizedKvPayloads(join(dir, "kv")), []);
    assert.equal(WORKER_RAW_LIMIT_BYTES, 64 * 1024 * 1024);
    assert.equal(WORKER_COMPRESSED_LIMIT_BYTES, 10 * 1024 * 1024);
    assert.equal(WORKER_STARTUP_LIMIT_MS, 1000);
  });
});

test("Worker budget guard fires on compressed and startup ceilings", async () => {
  await withTempDir("budget", async (dir) => {
    const meta = join(dir, "meta.json");
    await writeFile(meta, JSON.stringify({ outputs: { "bundle.js": { entryPoint: "worker/src/worker.mjs", bytes: 100, compressedBytes: 10 * 1024 * 1024 + 1, startupTimeMs: 1001, inputs: {} } } }));
    assert.throws(() => inspectBundle(meta), /compressed budget/);
  });
});

test("Worker budget guard rejects a successful profiler with no numeric startup output", async () => {
  await withTempDir("budget", async (dir) => {
    const meta = join(dir, "meta.json");
    await writeFile(meta, JSON.stringify({
      outputs: { "bundle.js": { entryPoint: "worker/src/worker.mjs", bytes: 100, compressedBytes: 100, inputs: {} } },
    }));
    assert.throws(() => inspectBundle(meta), /startup measurement is missing/);
  });
});

test("KV budget guard fires on a published value over 25 MiB", async () => {
  await withTempDir("budget", async (dir) => {
    const value = "x".repeat(25 * 1024 * 1024 + 1);
    await writeFile(join(dir, "bulk.json"), JSON.stringify([{ key: "oversized", value }]));
    assert.equal(oversizedKvPayloads(dir).length, 1);
  });
});
