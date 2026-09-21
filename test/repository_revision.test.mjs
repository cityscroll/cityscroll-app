import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { resolveRepositoryRevision } from "../tools/repository_revision.mjs";

const ROOT = resolve(import.meta.dirname, "..");
const EVIDENCE = join(ROOT, "docs", "evidence");
const REVISION_KEYS = new Set(["repository_revision", "grounded_at", "revision", "production_revision"]);

function git(args) {
  return execFileSync("git", args, { cwd: ROOT, encoding: "utf8" }).trim();
}

function originAvailable() {
  return spawnSync("git", ["rev-parse", "--verify", "origin/main^{commit}"], {
    cwd: ROOT,
    stdio: "ignore",
  }).status === 0;
}

function jsonFiles(directory) {
  const result = [];
  for (const name of readdirSync(directory)) {
    const path = join(directory, name);
    if (statSync(path).isDirectory()) result.push(...jsonFiles(path));
    else if (name.endsWith(".json")) result.push(path);
  }
  return result;
}

function normalizeRevision(value) {
  if (typeof value !== "string") return null;
  const grounded = /^grounded at ([0-9a-f]{7,40})$/i.exec(value.trim());
  if (grounded) return grounded[1];
  return /^[0-9a-f]{7,40}$/i.test(value) ? value : null;
}

function recordedRevisions(value, path = [], manifest = false) {
  const result = { revisions: [], invalid: [] };
  if (Array.isArray(value)) {
    value.forEach((entry, index) => {
      const nested = recordedRevisions(entry, [...path, String(index)], manifest);
      result.revisions.push(...nested.revisions);
      result.invalid.push(...nested.invalid);
    });
  } else if (value && typeof value === "object") {
    for (const [key, entry] of Object.entries(value)) {
      if (REVISION_KEYS.has(key)) {
        const revision = normalizeRevision(entry);
        if (revision) result.revisions.push({ path: [...path, key], value: revision });
        else if (manifest && (entry === null || typeof entry === "string")) {
          result.invalid.push({ path: [...path, key], value: entry });
        }
      }
      const nested = recordedRevisions(entry, [...path, key], manifest);
      result.revisions.push(...nested.revisions);
      result.invalid.push(...nested.invalid);
    }
  }
  return result;
}

test("the shared helper resolves the merge-base with origin/main", (t) => {
  if (!originAvailable()) {
    t.skip("origin/main is unavailable");
    return;
  }
  let captureHead = "HEAD";
  if (process.env.GITHUB_HEAD_SHA) {
    captureHead = git(["rev-parse", "--verify", `${process.env.GITHUB_HEAD_SHA}^{commit}`]);
  } else if (process.env.GITHUB_EVENT_NAME === "pull_request") {
    const parents = git(["rev-list", "--parents", "-n", "1", "HEAD"]).split(/\s+/);
    if (parents.length === 3 && git(["merge-base", parents[1], "origin/main"]) === parents[1]) {
      captureHead = parents[2];
    }
  }
  const expected = git(["merge-base", captureHead, "origin/main"]);
  assert.equal(resolveRepositoryRevision(ROOT), expected);
  const python = spawnSync("python3", [join(ROOT, "tools", "repository_revision.py"), "--cwd", ROOT], {
    cwd: ROOT,
    encoding: "utf8",
  });
  assert.equal(python.status, 0, python.stderr);
  assert.equal(python.stdout.trim(), expected);
});

test("the shared helper ignores a synthetic pull-request merge parent", () => {
  const fixture = mkdtempSync(join(tmpdir(), "cityscroll-revision-"));
  const run = (args) => execFileSync("git", args, { cwd: fixture, encoding: "utf8" }).trim();
  const previousEvent = process.env.GITHUB_EVENT_NAME;
  const previousHead = process.env.GITHUB_HEAD_SHA;
  try {
    run(["init", "-q", "-b", "main"]);
    run(["config", "user.email", "test@example.invalid"]);
    run(["config", "user.name", "test"]);
    writeFileSync(join(fixture, "marker"), "base\n");
    run(["add", "marker"]);
    run(["commit", "-qm", "base"]);
    const grounded = run(["rev-parse", "HEAD"]);
    run(["checkout", "-qb", "feature"]);
    writeFileSync(join(fixture, "feature-marker"), "feature\n");
    run(["add", "feature-marker"]);
    run(["commit", "-qm", "feature"]);
    run(["checkout", "main"]);
    writeFileSync(join(fixture, "main-marker"), "main\n");
    run(["add", "main-marker"]);
    run(["commit", "-qm", "main"]);
    run(["update-ref", "refs/remotes/origin/main", "HEAD"]);
    run(["merge", "--no-ff", "feature", "-m", "synthetic pull request"]);

    process.env.GITHUB_EVENT_NAME = "pull_request";
    delete process.env.GITHUB_HEAD_SHA;
    assert.equal(resolveRepositoryRevision(fixture), grounded);
    const python = spawnSync("python3", [join(ROOT, "tools", "repository_revision.py"), "--cwd", fixture], {
      cwd: ROOT,
      encoding: "utf8",
      env: { ...process.env, GITHUB_EVENT_NAME: "pull_request" }
    });
    assert.equal(python.status, 0, python.stderr);
    assert.equal(python.stdout.trim(), grounded);
  } finally {
    if (previousEvent === undefined) delete process.env.GITHUB_EVENT_NAME;
    else process.env.GITHUB_EVENT_NAME = previousEvent;
    if (previousHead === undefined) delete process.env.GITHUB_HEAD_SHA;
    else process.env.GITHUB_HEAD_SHA = previousHead;
    rmSync(fixture, { recursive: true, force: true });
  }
});

test("committed evidence revisions are reachable from origin/main", (t) => {
  if (!originAvailable()) {
    t.skip("origin/main is unavailable");
    return;
  }
  const failures = [];
  for (const file of jsonFiles(EVIDENCE)) {
    if (file === join(EVIDENCE, "assistant-setup", "capture-manifest.json")) continue;
    let document;
    try {
      document = JSON.parse(readFileSync(file, "utf8"));
    } catch {
      continue;
    }
    const collected = recordedRevisions(document, [], /manifest\.json$/i.test(file));
    for (const entry of collected.revisions) {
      const status = spawnSync("git", ["merge-base", "--is-ancestor", entry.value, "origin/main"], {
        cwd: ROOT,
        stdio: "ignore",
      }).status;
      if (status !== 0) failures.push(`${relative(ROOT, file)}:${entry.path.join(".")}=${entry.value}`);
    }
    for (const entry of collected.invalid) {
      failures.push(`${relative(ROOT, file)}:${entry.path.join(".")}=${String(entry.value)}`);
    }
  }
  assert.deepEqual(failures, [], "unreachable retained revisions:\n" + failures.join("\n"));
});
