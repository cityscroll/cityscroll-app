/**
 * A test that builds a scratch Git repository must not touch the ambient one.
 *
 * Git exports GIT_DIR — and sometimes GIT_WORK_TREE, GIT_INDEX_FILE, and
 * GIT_COMMON_DIR — into every hook it runs, and `tools/git-hooks/pre-push` runs
 * the whole preflight, so the unit suites execute with those variables set. This
 * repository is normally worked on from a linked worktree, and a worktree's
 * exported GIT_DIR does not behave like a plain repository's: it points at the
 * per-worktree gitdir under `<hub>/.git/worktrees/<name>`, which carries a
 * `gitdir` backlink to the real linked work tree, so Git resolves the ambient
 * work tree from GIT_DIR alone — no GIT_WORK_TREE needed, and a `-C <fixture>`
 * or `cwd` pointed at the fixture does not override it. A fixture's `add -A`
 * plus `commit` then lands on the real branch as a commit that deletes every
 * path the fixture does not contain, and `--show-toplevel` guards do not help
 * because that resolves to the ambient tree too. Read-only calls are quieter
 * and no better: they answer about the wrong repository, so a fixture assertion
 * can pass for the wrong reason.
 *
 * This is not hypothetical. It happened twice, and recovering took a hand-run
 * reset both times — the second time from inside a linked worktree exactly
 * like the one described above, which is what exposed that the first fix's
 * hostile-environment simulation below used a plain repository's GIT_DIR
 * shape and so never actually exercised the worktree backlink.
 *
 * Each suite below is therefore executed under exactly that hostile
 * environment, pointed at a throwaway worktree stand-in for the ambient
 * repository. A suite passes only if it still passes AND leaves that stand-in
 * byte-identical. The negative control at the end proves the detector can
 * actually fail.
 *
 * Scope, from the audit that produced this file. Every git invocation under
 * `tools/` and `test/` was inspected and split by what a leak would cost:
 *
 *   WRITES  — `init`, `add`, `commit` and their kin against a scratch tree. A
 *             leak here rewrites the ambient repository. Two have existed:
 *             the determinism suite (fixed first) and
 *             `test/list_pr_changed_paths.test.mjs`'s fixture-repo builder
 *             (fixed alongside the worktree-shaped simulation below). None
 *             remain; that is what these tests hold.
 *   READS   — `ls-files`, `rev-parse`, `merge-base`, `diff`. A leak answers
 *             about the wrong repository instead of damaging one. Several of
 *             these still inherit the environment, and they are correct under
 *             `pre-push` because the exported GIT_DIR IS the repository they
 *             mean to read. They are fragile rather than broken, and pinning
 *             them belongs to its own change: `test/card_profile.test.mjs`,
 *             `test/stale_name_guard.test.mjs`, and
 *             `test/warehouse_ocp_lookup.test.mjs` each answer from the
 *             exported repository when one is forced on them.
 *
 * Only the suites that build a scratch repository are listed here, because only
 * those can turn a leak into a write.
 *
 * verify: node --test test/hook_safe_git_subprocesses.test.mjs
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { isolatedGitEnv } from "../tools/architecture_evidence_shards.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

/*
 * Every suite that builds a scratch repository. Running one of these under a
 * leaked environment is the exact operation that damaged this repository, so the
 * list is the audit: adding a scratch-repo suite without adding it here leaves
 * that suite unproven.
 */
const SCRATCH_REPO_SUITES = Object.freeze([
  "test/architecture_evidence_shards.test.mjs",
  "test/ci_exact_commit_artifact.test.mjs",
  "test/functional_corpus_readiness.test.mjs",
  "test/i18n_cache_build.test.mjs",
  "test/list_pr_changed_paths.test.mjs",
  "test/prepare_changelog_base.test.mjs",
  "test/private_identifier_scan.test.mjs",
  "test/governance_evidence_placement.test.mjs",
  "test/site_production_determinism.test.mjs",
]);

function git(cwd, args, env = isolatedGitEnv()) {
  return spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8", env });
}

/**
 * A throwaway repository that stands in for the one a hook would expose,
 * shaped like a real linked worktree rather than a plain repository: `hub` is
 * a normal repo, and `root` is a detached worktree of it, so `root`'s GIT_DIR
 * is `<hub>/.git/worktrees/<name>` carrying the `gitdir` backlink a real
 * worktree checkout exports. Its whole job is to be damaged if anything
 * leaks, so it carries a committed file and a recorded state to compare
 * against.
 */
function ambientStandIn() {
  const root = mkdtempSync(path.join(tmpdir(), "cityscroll-ambient-"));
  writeFileSync(path.join(root, "kept.txt"), "this file must survive every suite\n");
  mkdirSync(path.join(root, "nested"), { recursive: true });
  writeFileSync(path.join(root, "nested", "also-kept.txt"), "and so must this one\n");
  assert.equal(git(root, ["init", "-q", "-b", "main"]).status, 0);
  git(root, ["config", "user.email", "baseline@example.invalid"]);
  git(root, ["config", "user.name", "Baseline"]);
  git(root, ["add", "-A"]);
  assert.equal(git(root, ["commit", "-qm", "ambient baseline"]).status, 0);

  // A linked, detached worktree of `root`. Its GIT_DIR is `root/.git/worktrees/<name>`,
  // which carries a `gitdir` backlink to this directory — the same shape a real
  // worktree checkout exports, unlike `root`'s own plain GIT_DIR.
  const worktree = path.join(mkdtempSync(path.join(tmpdir(), "cityscroll-ambient-worktree-")), "wt");
  assert.equal(git(root, ["worktree", "add", "--quiet", "--detach", worktree, "main"]).status, 0);
  const gitDir = git(worktree, ["rev-parse", "--absolute-git-dir"]).stdout.trim();
  return { root: worktree, hub: root, gitDir };
}

function removeStandIn(standIn) {
  git(standIn.hub, ["worktree", "remove", "--force", standIn.root]);
  rmSync(path.dirname(standIn.root), { recursive: true, force: true });
  rmSync(standIn.hub, { recursive: true, force: true });
}

/** Everything about the stand-in that a leaked write would move. */
function repositoryState(root) {
  return {
    head: git(root, ["rev-parse", "HEAD"]).stdout.trim(),
    commits: git(root, ["rev-list", "--count", "HEAD"]).stdout.trim(),
    status: git(root, ["status", "--porcelain"]).stdout,
    tracked: git(root, ["ls-files"]).stdout,
    config: git(root, ["config", "--local", "--null", "--list"]).stdout,
  };
}

/**
 * The environment a Git hook hands to everything the preflight runs.
 *
 * GIT_DIR alone, deliberately: that is what Git exports for a worktree
 * checkout, and it is what makes the leak destructive. `standIn.gitDir` is
 * itself a worktree gitdir (see `ambientStandIn`), so it carries the `gitdir`
 * backlink that resolves the ambient work tree directly — no GIT_WORK_TREE
 * needed, and a `-C <fixture>` or `cwd` pointed at the fixture does not
 * override it. Exporting a work tree as well would point every command back
 * at the stand-in and quietly defuse the very failure this file exists to
 * reproduce.
 */
function hookEnvironment(standIn) {
  return { ...process.env, GIT_DIR: standIn.gitDir };
}

for (const suite of SCRATCH_REPO_SUITES) {
  test(`${suite} is safe to run from a Git hook`, () => {
    const standIn = ambientStandIn();
    try {
      const before = repositoryState(standIn.root);
      // The child is a real `node --test` run, so it must not inherit this
      // file's own test-runner context; Node detects it and skips the run.
      const childEnvironment = hookEnvironment(standIn);
      delete childEnvironment.NODE_TEST_CONTEXT;
      const run = spawnSync(process.execPath, ["--test", suite], {
        cwd: ROOT,
        encoding: "utf8",
        env: childEnvironment,
        maxBuffer: 64 * 1024 * 1024,
      });

      // Damage first: a suite that corrupts the ambient repository has already
      // done the harm even if it goes on to report success.
      assert.deepEqual(
        repositoryState(standIn.root),
        before,
        `${suite} changed the ambient repository exported to it by the hook`,
      );
      assert.equal(
        run.status,
        0,
        `${suite} must pass with a hook environment set:\n${run.stdout}\n${run.stderr}`,
      );
      // A suite that never started would satisfy both assertions above without
      // proving anything, so require that it reported real passing tests.
      const passed = Number(run.stdout.match(/^. pass (\d+)$/m)?.[1] || 0);
      assert.ok(
        passed > 0,
        `${suite} did not actually run under the hook environment:\n${run.stdout}\n${run.stderr}`,
      );
    } finally {
      removeStandIn(standIn);
    }
  });
}

test("the detector fails when a subprocess really does leak", () => {
  const standIn = ambientStandIn();
  const fixture = mkdtempSync(path.join(tmpdir(), "cityscroll-leaky-"));
  try {
    const before = repositoryState(standIn.root);
    writeFileSync(path.join(fixture, "only-file.txt"), "the fixture's whole tree\n");

    // Exactly the unguarded shape that caused the incident: `git -C <fixture>`
    // with the hook environment inherited rather than stripped.
    const leaked = hookEnvironment(standIn);
    spawnSync("git", ["-C", fixture, "init", "-q"], { env: leaked });
    spawnSync("git", ["-C", fixture, "add", "-A"], { env: leaked });
    const committed = spawnSync("git", ["-C", fixture, "commit", "-qm", "fixture"], {
      env: leaked,
      encoding: "utf8",
    });
    assert.equal(committed.status, 0, committed.stderr);

    const after = repositoryState(standIn.root);
    assert.notEqual(after.head, before.head, "a leaked commit must move the ambient HEAD");
    assert.equal(Number(after.commits), Number(before.commits) + 1);
    assert.ok(
      !after.tracked.includes("kept.txt"),
      "a leaked commit deletes every path the fixture does not contain — that is the damage",
    );

    // And the same commands are harmless once the bindings are stripped.
    const clean = mkdtempSync(path.join(tmpdir(), "cityscroll-clean-"));
    const guarded = ambientStandIn();
    try {
      const guardedBefore = repositoryState(guarded.root);
      writeFileSync(path.join(clean, "only-file.txt"), "the fixture's whole tree\n");
      const safe = isolatedGitEnv({ ...hookEnvironment(guarded) });
      spawnSync("git", ["-C", clean, "init", "-q"], { env: safe });
      spawnSync("git", ["-C", clean, "config", "user.email", "test@example.invalid"], { env: safe });
      spawnSync("git", ["-C", clean, "config", "user.name", "test"], { env: safe });
      spawnSync("git", ["-C", clean, "add", "-A"], { env: safe });
      spawnSync("git", ["-C", clean, "commit", "-qm", "fixture"], { env: safe });
      assert.deepEqual(repositoryState(guarded.root), guardedBefore, "stripping the bindings is the fix");
    } finally {
      rmSync(clean, { recursive: true, force: true });
      removeStandIn(guarded);
    }
  } finally {
    rmSync(fixture, { recursive: true, force: true });
    removeStandIn(standIn);
  }
});

test("the detector observes a leaked repository-config write", () => {
  const standIn = ambientStandIn();
  const fixture = mkdtempSync(path.join(tmpdir(), "cityscroll-config-leak-"));
  try {
    const before = repositoryState(standIn.root);
    const leaked = hookEnvironment(standIn);
    const written = spawnSync("git", ["-C", fixture, "config", "user.name", "test"], {
      env: leaked,
      encoding: "utf8",
    });
    assert.equal(written.status, 0, written.stderr);
    assert.notEqual(
      repositoryState(standIn.root).config,
      before.config,
      "a leaked git config write must be visible to the ambient-repository guard",
    );
  } finally {
    rmSync(fixture, { recursive: true, force: true });
    removeStandIn(standIn);
  }
});
