import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { withTempDir, withTempDirSync } from "../tools/lib/with_temp_dir.mjs";

const REPOSITORY_ROOT = fileURLToPath(new URL("../", import.meta.url));

test("withTempDir names the directory with the cityscroll- namespace and cleans up on success", async () => {
  let captured;
  const result = await withTempDir("temp-dir-helper", async (dir) => {
    captured = dir;
    assert.ok(existsSync(dir));
    assert.match(dir.split("/").pop(), /^cityscroll-temp-dir-helper-/);
    return "ok";
  });
  assert.equal(result, "ok");
  assert.equal(existsSync(captured), false);
});

test("withTempDir cleans up when the callback throws", async () => {
  let captured;
  await assert.rejects(
    withTempDir("temp-dir-helper", async (dir) => {
      captured = dir;
      throw new Error("boom");
    }),
    /boom/,
  );
  assert.equal(existsSync(captured), false);
});

test("withTempDirSync cleans up on success and on a thrown error", () => {
  let dirA;
  withTempDirSync("temp-dir-helper-sync", (dir) => {
    dirA = dir;
  });
  assert.equal(existsSync(dirA), false);

  let dirB;
  assert.throws(() => {
    withTempDirSync("temp-dir-helper-sync", (dir) => {
      dirB = dir;
      throw new Error("boom-sync");
    });
  }, /boom-sync/);
  assert.equal(existsSync(dirB), false);
});

test("a prefix that already carries the cityscroll- namespace is not doubled", async () => {
  await withTempDir("cityscroll-already-namespaced", async (dir) => {
    assert.match(dir.split("/").pop(), /^cityscroll-already-namespaced-/);
    assert.doesNotMatch(dir, /cityscroll-cityscroll-/);
  });
});

test("SIGTERM during the callback still removes the temp directory", async () => {
  const child = spawnSync(process.execPath, ["-e", `
    const { withTempDir } = await import(${JSON.stringify(new URL("../tools/lib/with_temp_dir.mjs", import.meta.url).href)});
    await withTempDir("sigterm-check", async (dir) => {
      process.stdout.write(dir + "\\n");
      await new Promise((resolve) => setTimeout(resolve, 5000));
    });
  `, "--input-type=module"], {
    cwd: REPOSITORY_ROOT,
    encoding: "utf8",
    // Give the child a moment to create the directory and print it, then
    // signal it the way a pre-push gate timeout would.
    timeout: 1000,
    killSignal: "SIGTERM",
  });
  const createdDir = child.stdout.trim().split("\n")[0];
  assert.ok(createdDir, `expected the child to report a temp dir, got stdout=${JSON.stringify(child.stdout)} stderr=${JSON.stringify(child.stderr)}`);
  assert.equal(existsSync(createdDir), false, "SIGTERM should have triggered cleanup");
});
