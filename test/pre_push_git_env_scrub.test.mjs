/**
 * Root guard for the nested-git hazard on the pre-push path.
 *
 * Git exports GIT_DIR and GIT_INDEX_FILE (and often related bindings) into every
 * hook. `tools/git-hooks/pre-push` runs the full preflight, so a child that
 * shells out to `git -C <tmpdir> init/add/commit` under that inherited
 * environment writes into the ambient repository instead of the fixture.
 *
 * Per-suite `isolatedGitEnv()` defenses remain. This file pins the hook-entry
 * scrub: `tools/git-hooks/scrub-hook-exported-git-env.sh`, sourced by pre-push
 * after its own git reads and before preflight. Removing that source line, or
 * emptying the scrub list, must fail here.
 *
 * verify: node --test test/pre_push_git_env_scrub.test.mjs
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { isolatedGitEnv } from "../tools/architecture_evidence_shards.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const PRE_PUSH = path.join(ROOT, "tools/git-hooks/pre-push");
const SCRUB = path.join(ROOT, "tools/git-hooks/scrub-hook-exported-git-env.sh");

const HOOK_EXPORTED_BINDINGS = Object.freeze([
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_INDEX_FILE",
  "GIT_OBJECT_DIRECTORY",
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_PREFIX",
  "GIT_COMMON_DIR",
]);

function git(cwd, args, env = isolatedGitEnv()) {
  return spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8", env });
}

/**
 * Throwaway linked worktree stand-in for the ambient repository a hook exposes.
 * GIT_DIR alone resolves the work tree via the gitdir backlink, matching a real
 * worktree checkout's hook environment.
 */
function ambientStandIn() {
  const hub = mkdtempSync(path.join(tmpdir(), "cityscroll-prepush-ambient-"));
  writeFileSync(path.join(hub, "kept.txt"), "this file must survive the nested git op\n");
  mkdirSync(path.join(hub, "nested"), { recursive: true });
  writeFileSync(path.join(hub, "nested", "also-kept.txt"), "and so must this one\n");
  assert.equal(git(hub, ["init", "-q", "-b", "main"]).status, 0);
  git(hub, ["config", "user.email", "baseline@example.invalid"]);
  git(hub, ["config", "user.name", "Baseline"]);
  git(hub, ["add", "-A"]);
  assert.equal(git(hub, ["commit", "-qm", "ambient baseline"]).status, 0);

  const worktree = path.join(mkdtempSync(path.join(tmpdir(), "cityscroll-prepush-wt-")), "wt");
  assert.equal(git(hub, ["worktree", "add", "--quiet", "--detach", worktree, "main"]).status, 0);
  const gitDir = git(worktree, ["rev-parse", "--absolute-git-dir"]).stdout.trim();
  const indexFile = path.join(gitDir, "index");
  return { root: worktree, hub, gitDir, indexFile };
}

function removeStandIn(standIn) {
  git(standIn.hub, ["worktree", "remove", "--force", standIn.root]);
  rmSync(path.dirname(standIn.root), { recursive: true, force: true });
  rmSync(standIn.hub, { recursive: true, force: true });
}

function repositoryState(root) {
  return {
    head: git(root, ["rev-parse", "HEAD"]).stdout.trim(),
    commits: git(root, ["rev-list", "--count", "HEAD"]).stdout.trim(),
    status: git(root, ["status", "--porcelain"]).stdout,
    tracked: git(root, ["ls-files"]).stdout,
  };
}

/** Hook-shaped environment: GIT_DIR plus GIT_INDEX_FILE, as git often exports both. */
function hookEnvironment(standIn) {
  return {
    ...process.env,
    GIT_DIR: standIn.gitDir,
    GIT_INDEX_FILE: standIn.indexFile,
  };
}

/**
 * Representative nested-git fixture op: init/add/commit under an inherited
 * environment. Without the scrub this rewrites the ambient stand-in.
 */
function nestedGitCommitScript(fixture) {
  return [
    "set -euo pipefail",
    `fixture=${JSON.stringify(fixture)}`,
    'git -C "$fixture" init -q',
    'git -C "$fixture" config user.email nested@example.invalid',
    'git -C "$fixture" config user.name Nested',
    'git -C "$fixture" add -A',
    'git -C "$fixture" commit -qm nested-fixture',
  ].join("\n");
}

test("pre-push sources the shared scrub before launching preflight", () => {
  const source = readFileSync(PRE_PUSH, "utf8");
  const scrubIdx = source.indexOf("source \"$ROOT/tools/git-hooks/scrub-hook-exported-git-env.sh\"");
  assert.ok(scrubIdx >= 0, "pre-push must source scrub-hook-exported-git-env.sh");
  const preflightIdx = source.indexOf('preflight_cmd=("$A11Y_RUNNER"');
  assert.ok(preflightIdx >= 0, "pre-push must build the preflight command");
  assert.ok(
    scrubIdx < preflightIdx,
    "the scrub must run after range detection and before the preflight launch",
  );
  const scrubBody = readFileSync(SCRUB, "utf8");
  for (const key of HOOK_EXPORTED_BINDINGS) {
    assert.match(scrubBody, new RegExp(`\\b${key}\\b`), `scrub must unset ${key}`);
  }
});

test("hook-entry scrub keeps the ambient repo intact under exported GIT_DIR/GIT_INDEX_FILE", () => {
  const standIn = ambientStandIn();
  const fixture = mkdtempSync(path.join(tmpdir(), "cityscroll-prepush-fixture-"));
  try {
    writeFileSync(path.join(fixture, "only-file.txt"), "fixture tree\n");
    const before = repositoryState(standIn.root);
    const script = [
      "set -euo pipefail",
      `source ${JSON.stringify(SCRUB)}`,
      nestedGitCommitScript(fixture),
    ].join("\n");
    const run = spawnSync("bash", ["-c", script], {
      encoding: "utf8",
      env: hookEnvironment(standIn),
    });
    assert.equal(run.status, 0, `nested git through the hook scrub failed:\n${run.stdout}\n${run.stderr}`);
    assert.deepEqual(
      repositoryState(standIn.root),
      before,
      "sourcing the hook scrub must leave the ambient repository untouched",
    );
    assert.equal(
      git(fixture, ["rev-parse", "--is-inside-work-tree"]).stdout.trim(),
      "true",
      "the fixture itself must receive the nested commit",
    );
  } finally {
    rmSync(fixture, { recursive: true, force: true });
    removeStandIn(standIn);
  }
});

test("without the hook scrub the same nested git op rewrites the ambient repo", () => {
  const standIn = ambientStandIn();
  const fixture = mkdtempSync(path.join(tmpdir(), "cityscroll-prepush-leak-"));
  try {
    writeFileSync(path.join(fixture, "only-file.txt"), "fixture tree\n");
    const before = repositoryState(standIn.root);
    const run = spawnSync("bash", ["-c", nestedGitCommitScript(fixture)], {
      encoding: "utf8",
      env: hookEnvironment(standIn),
    });
    assert.equal(run.status, 0, `leaky nested git failed:\n${run.stdout}\n${run.stderr}`);
    const after = repositoryState(standIn.root);
    assert.notEqual(after.head, before.head, "a leaked commit must move ambient HEAD");
    assert.equal(Number(after.commits), Number(before.commits) + 1);
    assert.ok(
      !after.tracked.includes("kept.txt"),
      "a leaked commit deletes every path the fixture does not contain",
    );
  } finally {
    rmSync(fixture, { recursive: true, force: true });
    removeStandIn(standIn);
  }
});
