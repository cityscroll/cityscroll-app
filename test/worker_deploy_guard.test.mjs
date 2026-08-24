import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const ROOT = new URL("../", import.meta.url).pathname;
const guard = join(ROOT, "tools/worker_deploy_guard.mjs");
const fixture = join(ROOT, "test/fixtures/worker-bundle/oversize-metafile.json");

test("the 52 MiB guard trips on an oversize Wrangler metafile and prints largest inputs", () => {
  const result = spawnSync(process.execPath, [guard, "--metafile", fixture], { encoding: "utf8" });
  assert.notEqual(result.status, 0);
  assert.match(`${result.stdout}\n${result.stderr}`, /oversize.json/);
  assert.match(result.stderr, /exceeds 52 MiB/);
});

test("the read-model canary gate trips when a published slice is empty", () => {
  const out = mkdtempSync(join(tmpdir(), "crol-route-read-model-test-"));
  try {
    const build = spawnSync(process.execPath, [join(ROOT, "tools/build_worker_route_read_models.mjs"), "--output-dir", out], { encoding: "utf8" });
    assert.equal(build.status, 0, build.stderr);
    const manifest = JSON.parse(readFileSync(join(out, "near-you.manifest.json"), "utf8"));
    const target = manifest.slices["borough:Queens:meetings"];
    const bulkPath = readdirSync(out)
      .filter((name) => /^near-you\.bulk\.\d+\.json$/.test(name))
      .map((name) => join(out, name))
      .find((path) => JSON.parse(readFileSync(path, "utf8")).some((candidate) => candidate.key === target));
    const entries = JSON.parse(readFileSync(bulkPath, "utf8"));
    const entry = entries.find((candidate) => candidate.key === target);
    assert.ok(entry);
    entry.value = JSON.stringify({ activity: { records: { meetings: {} } } });
    writeFileSync(bulkPath, JSON.stringify(entries));
    const result = spawnSync(process.execPath, [guard, "--read-model-dir", out], { encoding: "utf8" });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /canary returned empty\/unknown/);
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});
