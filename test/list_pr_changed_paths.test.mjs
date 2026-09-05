// Characterization test for tools/list_pr_changed_paths.sh — the script every
// diff-collecting CI guard (Detect changed paths, Capture-manifest image
// guard, Public image capture guard) now goes through so a PR whose diff
// GitHub can't render (large generated-data PRs) still gets a correct changed
// file list instead of the guard failing on an unrelated GitHub API error.
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import fs from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { withTempDir } from "../tools/lib/with_temp_dir.mjs";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const SCRIPT = path.join(ROOT, "tools", "list_pr_changed_paths.sh");

function sh(cmd, args, opts = {}) {
  return execFileSync(cmd, args, { encoding: "utf8", ...opts });
}

// Builds a throwaway repo with a base commit (fileA.txt, fileB.txt) and a
// head commit that modifies fileA.txt and adds fileC.txt — the small PR the
// task asks us to prove the fallback against. `dir` is a caller-owned temp
// directory (see withTempDir at each call site).
function setupFixtureRepo(dir) {
  const env = { ...process.env, GIT_AUTHOR_NAME: "test", GIT_AUTHOR_EMAIL: "test@localhost", GIT_COMMITTER_NAME: "test", GIT_COMMITTER_EMAIL: "test@localhost" };
  sh("git", ["init", "-q"], { cwd: dir, env });
  fs.writeFileSync(path.join(dir, "fileA.txt"), "a\n");
  fs.writeFileSync(path.join(dir, "fileB.txt"), "b\n");
  sh("git", ["add", "."], { cwd: dir, env });
  sh("git", ["commit", "-q", "-m", "base"], { cwd: dir, env });
  const baseSha = sh("git", ["rev-parse", "HEAD"], { cwd: dir, env }).trim();

  fs.writeFileSync(path.join(dir, "fileA.txt"), "a changed\n");
  fs.writeFileSync(path.join(dir, "fileC.txt"), "c\n");
  sh("git", ["add", "."], { cwd: dir, env });
  sh("git", ["commit", "-q", "-m", "head"], { cwd: dir, env });

  return { dir, env, baseSha };
}

// Installs a fake `gh` ahead of the real one on PATH. FAKE_GH_MODE=fail makes
// it reproduce GitHub's "diff taking too long to generate" error exactly as
// seen on the failing checks; FAKE_GH_MODE=success echoes a canned file list
// so the API path can be exercised without a network call. `dir` is a
// caller-owned temp directory (see withTempDir at each call site).
function setupFakeGhBin(dir) {
  const ghPath = path.join(dir, "gh");
  fs.writeFileSync(
    ghPath,
    `#!/usr/bin/env bash
set -euo pipefail
if [ "\${FAKE_GH_MODE:-}" = "fail" ]; then
  echo '{"message":"Server Error: Sorry, this diff is taking too long to generate.","errors":[{"resource":"PullRequest","field":"diff","code":"not_available"}]}' >&2
  exit 1
fi
query=""
prev=""
for a in "$@"; do
  if [ "$prev" = "-q" ]; then
    query="$a"
  fi
  prev="$a"
done
if echo "$query" | grep -q "select"; then
  echo "fileC.txt"
else
  printf "fileA.txt\\nfileC.txt\\n"
fi
`,
    { mode: 0o755 },
  );
  return dir;
}

function run(status, { fakeGhMode, fakeGhDir, cwd, extraEnv = {} }) {
  const env = {
    ...process.env,
    PATH: fakeGhDir ? `${fakeGhDir}:${process.env.PATH}` : process.env.PATH,
    FAKE_GH_MODE: fakeGhMode,
    ...extraEnv,
  };
  const result = spawnSync("bash", [SCRIPT, "owner/repo", "123", extraEnv.__BASE_SHA__ ?? "", status], {
    cwd,
    env,
    encoding: "utf8",
  });
  return { code: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

test("API path: added-only list matches the fixture PR", async () => {
  await withTempDir("pr-changed-paths", async (dir) => {
    const { baseSha } = setupFixtureRepo(dir);
    await withTempDir("fake-gh", async (fakeGh) => {
      setupFakeGhBin(fakeGh);
      const result = run("added", { fakeGhMode: "success", fakeGhDir: fakeGh, cwd: dir, extraEnv: { __BASE_SHA__: baseSha } });
      assert.equal(result.code, 0);
      assert.deepEqual(result.stdout.trim().split("\n").filter(Boolean).sort(), ["fileC.txt"]);
    });
  });
});

test("API path: full changed list matches the fixture PR", async () => {
  await withTempDir("pr-changed-paths", async (dir) => {
    const { baseSha } = setupFixtureRepo(dir);
    await withTempDir("fake-gh", async (fakeGh) => {
      setupFakeGhBin(fakeGh);
      const result = run("all", { fakeGhMode: "success", fakeGhDir: fakeGh, cwd: dir, extraEnv: { __BASE_SHA__: baseSha } });
      assert.equal(result.code, 0);
      assert.deepEqual(result.stdout.trim().split("\n").filter(Boolean).sort(), ["fileA.txt", "fileC.txt"]);
    });
  });
});

test("git fallback: reproduces the same added-only list as the API when gh returns the diff-too-large error", async () => {
  await withTempDir("pr-changed-paths", async (dir) => {
    const { baseSha } = setupFixtureRepo(dir);
    await withTempDir("fake-gh", async (fakeGh) => {
      setupFakeGhBin(fakeGh);
      const result = run("added", { fakeGhMode: "fail", fakeGhDir: fakeGh, cwd: dir, extraEnv: { __BASE_SHA__: baseSha } });
      assert.equal(result.code, 0);
      assert.deepEqual(result.stdout.trim().split("\n").filter(Boolean).sort(), ["fileC.txt"]);
      assert.match(result.stderr, /falling back to git diff/);
    });
  });
});

test("git fallback: reproduces the same full changed list as the API when gh returns the diff-too-large error", async () => {
  await withTempDir("pr-changed-paths", async (dir) => {
    const { baseSha } = setupFixtureRepo(dir);
    await withTempDir("fake-gh", async (fakeGh) => {
      setupFakeGhBin(fakeGh);
      const result = run("all", { fakeGhMode: "fail", fakeGhDir: fakeGh, cwd: dir, extraEnv: { __BASE_SHA__: baseSha } });
      assert.equal(result.code, 0);
      assert.deepEqual(result.stdout.trim().split("\n").filter(Boolean).sort(), ["fileA.txt", "fileC.txt"]);
    });
  });
});

test("fails closed when gh fails and the base commit is not available locally either", async () => {
  await withTempDir("pr-changed-paths", async (dir) => {
    setupFixtureRepo(dir);
    await withTempDir("fake-gh", async (fakeGh) => {
      setupFakeGhBin(fakeGh);
      const bogusSha = "0".repeat(40);
      const result = run("all", { fakeGhMode: "fail", fakeGhDir: fakeGh, cwd: dir, extraEnv: { __BASE_SHA__: bogusSha } });
      assert.equal(result.code, 1);
      assert.match(result.stderr, /not available locally/);
    });
  });
});

test("rejects an unknown status argument", async () => {
  await withTempDir("pr-changed-paths", async (dir) => {
    const { baseSha } = setupFixtureRepo(dir);
    await withTempDir("fake-gh", async (fakeGh) => {
      setupFakeGhBin(fakeGh);
      const result = run("bogus-status", { fakeGhMode: "success", fakeGhDir: fakeGh, cwd: dir, extraEnv: { __BASE_SHA__: baseSha } });
      assert.equal(result.code, 1);
    });
  });
});
