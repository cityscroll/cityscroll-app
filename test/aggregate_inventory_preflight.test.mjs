/**
 * The merge-group aggregation preflight for the shipped-site inventory.
 *
 *   node --test test/aggregate_inventory_preflight.test.mjs
 *
 * These tests reconstruct the exact shape that ejected green pull requests from
 * the merge queue: a branch cut before the site-production determinism inventory
 * gate existed, adding a site module it therefore never inventoried. The branch
 * passes on its own head — the gate is not in its checkout — yet poisons any
 * merge group it joins once the gate is present on main. The preflight merges
 * live main into the branch and evaluates the combined tree, so the branch turns
 * red on its own checks before it can reach the queue.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { simulateMergeGroup } from "../tools/aggregate_inventory_preflight.mjs";
import { isolatedGitEnv } from "../tools/architecture_evidence_shards.mjs";
import { SITE_INVENTORY_PATH, SITE_INVENTORY_SCHEMA } from "../tools/determinism_lint.mjs";

const TOOL = fileURLToPath(new URL("../tools/aggregate_inventory_preflight.mjs", import.meta.url));

/** A throwaway repository with a helper that runs git inside it. */
function makeRepo(t) {
  const dir = mkdtempSync(path.join(tmpdir(), "cityscroll-preflight-repo-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const git = (...args) => execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", env: isolatedGitEnv() });
  git("init", "--quiet", "-b", "main");
  git("config", "user.email", "fixture@cityscroll.invalid");
  git("config", "user.name", "Preflight Fixture");
  return { dir, git };
}

function writeModule(dir, relativePath, body = "export const value = 42;\n") {
  const target = path.join(dir, relativePath);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, body);
}

function writeInventory(dir, modules) {
  writeModule(
    dir,
    SITE_INVENTORY_PATH,
    `${JSON.stringify({ schema: SITE_INVENTORY_SCHEMA, modules, third_party: [] }, null, 2)}\n`,
  );
}

test("a stale branch that adds an uninventoried module fails against current main", (t) => {
  const { dir, git } = makeRepo(t);

  // The base main predates the inventory gate: modules ship, nothing enforces
  // that they are inventoried yet.
  writeModule(dir, "site/base_one.mjs");
  writeModule(dir, "site/base_two.mjs");
  git("add", "site");
  git("commit", "--quiet", "-m", "site before the inventory gate");

  // A feature branch is cut here and adds its own module. On its own head there
  // is still no inventory, so nothing complains — exactly the stale green.
  git("checkout", "--quiet", "-b", "feature");
  writeModule(dir, "site/feature_module.mjs");
  git("add", "site/feature_module.mjs");
  git("commit", "--quiet", "-m", "add feature module");

  // Main then lands the inventory gate covering only the modules main ships.
  git("checkout", "--quiet", "main");
  writeInventory(dir, ["site/base_one.mjs", "site/base_two.mjs"]);
  git("add", SITE_INVENTORY_PATH);
  git("commit", "--quiet", "-m", "introduce the shipped-site inventory gate");

  const result = simulateMergeGroup({ repo: dir, base: "main", head: "feature" });
  assert.equal(result.conflict, false);
  assert.ok(
    result.issues.some((issue) => issue.startsWith("site/feature_module.mjs ships from site/")),
    `expected the combined tree to flag the uninventoried module, got:\n${result.issues.join("\n")}`,
  );
});

test("a branch that inventories its own module passes against current main", (t) => {
  const { dir, git } = makeRepo(t);

  writeModule(dir, "site/base_one.mjs");
  writeInventory(dir, ["site/base_one.mjs"]);
  git("add", ".");
  git("commit", "--quiet", "-m", "base with inventory");

  git("checkout", "--quiet", "-b", "feature");
  writeModule(dir, "site/feature_module.mjs");
  // The branch adds its module to the inventory, as a healthy change would.
  writeInventory(dir, ["site/base_one.mjs", "site/feature_module.mjs"]);
  git("add", ".");
  git("commit", "--quiet", "-m", "add feature module and inventory it");

  const result = simulateMergeGroup({ repo: dir, base: "main", head: "feature" });
  assert.equal(result.conflict, false);
  assert.deepEqual(result.issues, [], result.issues.join("\n"));
  assert.ok(result.covered.includes("site/feature_module.mjs"));
});

test("a module main adds after the branch is caught in the combined tree", (t) => {
  // The mirror image: the branch is clean on its own head, but main adds a
  // module the branch's inventory cannot know about. The queue would fail the
  // combined tree; the preflight surfaces it on the branch first.
  const { dir, git } = makeRepo(t);

  writeModule(dir, "site/base_one.mjs");
  writeInventory(dir, ["site/base_one.mjs"]);
  git("add", ".");
  git("commit", "--quiet", "-m", "base with inventory");

  git("checkout", "--quiet", "-b", "feature");
  writeModule(dir, "site/feature_module.mjs");
  writeInventory(dir, ["site/base_one.mjs", "site/feature_module.mjs"]);
  git("add", ".");
  git("commit", "--quiet", "-m", "branch inventories its own module");

  git("checkout", "--quiet", "main");
  writeModule(dir, "site/main_only_module.mjs");
  // Main ships a module but its inventory update lands in a way the text merge
  // keeps disjoint from the branch's — the combined tree ends up uncovered.
  git("add", "site/main_only_module.mjs");
  git("commit", "--quiet", "-m", "main ships a module without inventorying it");

  const result = simulateMergeGroup({ repo: dir, base: "main", head: "feature" });
  assert.equal(result.conflict, false);
  assert.ok(
    result.issues.some((issue) => issue.startsWith("site/main_only_module.mjs ships from site/")),
    `expected the combined tree to flag main's uninventoried module, got:\n${result.issues.join("\n")}`,
  );
});

test("the CLI exits non-zero and names the offending module", (t) => {
  const { dir, git } = makeRepo(t);
  writeModule(dir, "site/base_one.mjs");
  git("add", "site");
  git("commit", "--quiet", "-m", "site before the inventory gate");
  git("checkout", "--quiet", "-b", "feature");
  writeModule(dir, "site/feature_module.mjs");
  git("add", "site/feature_module.mjs");
  git("commit", "--quiet", "-m", "add feature module");
  git("checkout", "--quiet", "main");
  writeInventory(dir, ["site/base_one.mjs"]);
  git("add", SITE_INVENTORY_PATH);
  git("commit", "--quiet", "-m", "introduce the inventory gate");

  let status = 0;
  let stderr = "";
  try {
    execFileSync(process.execPath, [TOOL, "--repo", dir, "--base", "main", "--head", "feature"], {
      encoding: "utf8",
      env: isolatedGitEnv(),
    });
  } catch (error) {
    status = error.status;
    stderr = `${error.stdout || ""}${error.stderr || ""}`;
  }
  assert.equal(status, 1);
  assert.match(stderr, /site\/feature_module\.mjs ships from site\//);
});

test("a clean branch removes its temporary checkout", (t) => {
  const { dir, git } = makeRepo(t);
  writeModule(dir, "site/base_one.mjs");
  writeInventory(dir, ["site/base_one.mjs"]);
  git("add", ".");
  git("commit", "--quiet", "-m", "base with inventory");
  git("checkout", "--quiet", "-b", "feature");
  writeModule(dir, "site/feature_module.mjs");
  writeInventory(dir, ["site/base_one.mjs", "site/feature_module.mjs"]);
  git("add", ".");
  git("commit", "--quiet", "-m", "add and inventory module");

  simulateMergeGroup({ repo: dir, base: "main", head: "feature" });
  const registered = git("worktree", "list", "--porcelain");
  assert.equal(
    registered.split(/\r?\n/).filter((line) => line.startsWith("worktree ")).length,
    1,
    `expected only the primary checkout to remain:\n${registered}`,
  );
});
