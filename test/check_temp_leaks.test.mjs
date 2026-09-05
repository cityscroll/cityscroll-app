import assert from "node:assert/strict";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import test from "node:test";

import { withTempDir } from "../tools/lib/with_temp_dir.mjs";

const CHECKER = new URL("../tools/check_temp_leaks.mjs", import.meta.url).pathname;

// `check_temp_leaks.mjs` snapshots and diffs the real $TMPDIR, so exercising it
// against the process's actual OS temp dir would race every other test in this
// suite that is concurrently creating and removing its own scratch directories
// (this file runs alongside hundreds of others under `node --test`). Give each
// checker invocation its own private TMPDIR via the child's environment so its
// view of "the temp directory" is isolated to exactly what this test creates.
async function runChecker(args, tmpdirOverride) {
  const { spawnSync } = await import("node:child_process");
  return spawnSync(process.execPath, [CHECKER, ...args], {
    encoding: "utf8",
    env: { ...process.env, TMPDIR: tmpdirOverride },
  });
}

test("check_temp_leaks reports a clean run when nothing new is left behind", async () => {
  await withTempDir("leak-checker-fixture", async (fixtureDir) => {
    const isolatedTmp = join(fixtureDir, "tmp");
    mkdirSync(isolatedTmp);
    const snapshotPath = join(fixtureDir, "snapshot.json");
    const snapshot = await runChecker(["snapshot", "--out", snapshotPath], isolatedTmp);
    assert.equal(snapshot.status, 0, snapshot.stderr);

    const check = await runChecker(["check", "--in", snapshotPath, "--label", "clean-fixture"], isolatedTmp);
    assert.equal(check.status, 0, check.stderr);
    assert.match(check.stdout, /no leaks/);
  });
});

test("check_temp_leaks fails closed and reports a deliberately leaked directory by name", async () => {
  await withTempDir("leak-checker-fixture", async (fixtureDir) => {
    const isolatedTmp = join(fixtureDir, "tmp");
    mkdirSync(isolatedTmp);
    const snapshotPath = join(fixtureDir, "snapshot.json");
    const snapshot = await runChecker(["snapshot", "--out", snapshotPath], isolatedTmp);
    assert.equal(snapshot.status, 0, snapshot.stderr);

    const leakName = `cityscroll-deliberate-leak-${randomUUID()}`;
    const leakPath = join(isolatedTmp, leakName);
    mkdirSync(leakPath);
    const check = await runChecker(["check", "--in", snapshotPath, "--label", "leaky-fixture"], isolatedTmp);
    assert.equal(check.status, 1);
    assert.match(check.stderr, /1 leaked temp directory/);
    assert.match(check.stderr, new RegExp(leakName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  });
});

test("check_temp_leaks ignores known non-repository residue (playwright, fm-secondmate-safety)", async () => {
  await withTempDir("leak-checker-fixture", async (fixtureDir) => {
    const isolatedTmp = join(fixtureDir, "tmp");
    mkdirSync(isolatedTmp);
    const snapshotPath = join(fixtureDir, "snapshot.json");
    const snapshot = await runChecker(["snapshot", "--out", snapshotPath], isolatedTmp);
    assert.equal(snapshot.status, 0, snapshot.stderr);

    const ignoredNames = ["playwright-artifacts-abc123", "playwright_chromiumdev_profile-xyz", "fm-secondmate-safety.lock-dir"];
    for (const name of ignoredNames) mkdirSync(join(isolatedTmp, name));
    const check = await runChecker(["check", "--in", snapshotPath, "--label", "ignored-fixture"], isolatedTmp);
    assert.equal(check.status, 0, check.stderr);
    assert.match(check.stdout, /no leaks/);
  });
});
