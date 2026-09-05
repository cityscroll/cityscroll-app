import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { findOffendingImages, loadAllowlist, readPaths } from "../tools/check_capture_manifest_images.mjs";
import { manifestPaths, missingShaEntries } from "../tools/lint_capture_manifest_schema.mjs";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const IMAGE_GUARD = fileURLToPath(new URL("../tools/check_capture_manifest_images.mjs", import.meta.url));
const MANIFEST_LINT = fileURLToPath(new URL("../tools/lint_capture_manifest_schema.mjs", import.meta.url));

function withTempFile(lines, fn) {
  const dir = mkdtempSync(join(tmpdir(), "capture-manifest-guard-"));
  const file = join(dir, "paths.txt");
  writeFileSync(file, `${lines.join("\n")}\n`);
  try {
    return fn(file);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function runImageGuard(pathsFile, extraEnv = {}) {
  return execFileSync(process.execPath, [IMAGE_GUARD, "--paths-file", pathsFile], {
    cwd: ROOT,
    encoding: "utf8",
    stdio: "pipe",
    env: { ...process.env, ...extraEnv },
  });
}

function runManifestLint(pathsFile) {
  return execFileSync(process.execPath, [MANIFEST_LINT, "--paths-file", pathsFile], {
    cwd: ROOT,
    encoding: "utf8",
    stdio: "pipe",
  });
}

// --- Added-file detection ---

test("an added PNG under docs/ fails the guard", () => {
  withTempFile(["docs/screenshots/scratch/new-capture.png"], (file) => {
    assert.throws(() => runImageGuard(file), /docs\/screenshots\/scratch\/new-capture\.png/);
  });
});

test("an added PNG under site/ passes — production static assets are out of scope", () => {
  // The convention (docs/capture-manifest-guard.md) governs visual-proof evidence under docs/;
  // site/ holds shipped product assets (icons, logos) that are a different category entirely and
  // are not covered by "commit a manifest instead of a screenshot".
  withTempFile(["site/icons/foo.png"], (file) => {
    const output = runImageGuard(file);
    assert.match(output, /guard OK/i);
  });
});

test("a non-image path under docs/ passes", () => {
  withTempFile(["docs/notes.md", "docs/evidence/some-card/capture-manifest.json"], (file) => {
    const output = runImageGuard(file);
    assert.match(output, /guard OK/i);
  });
});

test("a modified legacy image never reaching the added-paths list passes", () => {
  // The workflow only ever feeds this script the ADDED half of the diff (git diff-filter=A / the
  // GitHub API's status == "added"), so a path present in the wider changed-set but not passed
  // here — the shape a modified legacy screenshot takes — never gets flagged.
  withTempFile(["docs/notes.md"], (file) => {
    const output = runImageGuard(file);
    assert.match(output, /guard OK/i);
  });
});

test("findOffendingImages is the same decision the CLI makes", () => {
  const added = [
    "docs/screenshots/new.png",
    "docs/screenshots/new.PNG",
    "docs/evidence/card/capture-manifest.json",
    "site/icons/new.png",
  ];
  assert.deepEqual(findOffendingImages(added, {}), ["docs/screenshots/new.png", "docs/screenshots/new.PNG"]);
});

// --- Allowlist: exact-path behaviour ---

test("an allowlisted exact path is not flagged even though it is a new docs/ image", () => {
  const dir = mkdtempSync(join(tmpdir(), "capture-manifest-allowlist-"));
  try {
    const allowlistPath = join(dir, "allowlist.json");
    writeFileSync(
      allowlistPath,
      JSON.stringify({ images: { "docs/screenshots/logo.png": "Public documentation logo." } }),
    );
    const allowlist = loadAllowlist(allowlistPath);
    assert.deepEqual(findOffendingImages(["docs/screenshots/logo.png", "docs/screenshots/other.png"], allowlist), [
      "docs/screenshots/other.png",
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an allowlist entry without a reason is rejected", () => {
  const dir = mkdtempSync(join(tmpdir(), "capture-manifest-allowlist-"));
  try {
    const allowlistPath = join(dir, "allowlist.json");
    writeFileSync(allowlistPath, JSON.stringify({ images: { "docs/screenshots/logo.png": "" } }));
    assert.throws(() => loadAllowlist(allowlistPath), /non-empty one-line reason/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a glob allowlist entry is rejected — exact paths only, no self-certifying growth", () => {
  const dir = mkdtempSync(join(tmpdir(), "capture-manifest-allowlist-"));
  try {
    const allowlistPath = join(dir, "allowlist.json");
    writeFileSync(allowlistPath, JSON.stringify({ images: { "docs/screenshots/*.png": "Everything, please." } }));
    assert.throws(() => loadAllowlist(allowlistPath), /exact paths, not patterns/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a missing allowlist file behaves like an empty allowlist", () => {
  const allowlist = loadAllowlist(join(tmpdir(), "does-not-exist-capture-manifest-allowlist.json"));
  assert.deepEqual(allowlist, {});
});

test("the repository's own allowlist loads and covers no globs", () => {
  const allowlist = loadAllowlist();
  for (const path of Object.keys(allowlist)) {
    assert.ok(!path.includes("*"), `${path} must be an exact path`);
  }
});

// --- readPaths / usage ---

test("readPaths trims blank lines", () => {
  withTempFile(["docs/a.png", "", "  ", "docs/b.png"], (file) => {
    assert.deepEqual(readPaths(file), ["docs/a.png", "docs/b.png"]);
  });
});

test("the guard's usage message exits non-zero without --paths-file", () => {
  assert.throws(() => execFileSync(process.execPath, [IMAGE_GUARD], { cwd: ROOT, stdio: "pipe" }));
});

// --- git plumbing: renames and modifications of legacy images do not fail the guard ---

// git sets GIT_DIR/GIT_WORK_TREE (and friends) in a hook's environment so the hook naturally
// targets the invoking repository. This test suite can itself run from inside that pre-push hook
// (node --test test/*.test.mjs), so those variables must be stripped here — otherwise a nested
// `git init`/`git commit` in the scratch repo below would silently operate on this repository's
// real .git despite an explicit `cwd`, rather than the throwaway temp directory.
function sanitizedGitEnv() {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith("GIT_")) delete env[key];
  }
  return env;
}

function initTempRepo() {
  const dir = mkdtempSync(join(tmpdir(), "capture-manifest-repo-"));
  const env = sanitizedGitEnv();
  const run = (...args) => execFileSync("git", args, { cwd: dir, encoding: "utf8", env });
  run("init", "--quiet", "-b", "main");
  run("config", "user.email", "capture-manifest-guard-test");
  run("config", "user.name", "Test");
  return { dir, run };
}

test("git diff --diff-filter=A -M does not list a renamed pre-existing image as added", () => {
  const { dir, run } = initTempRepo();
  try {
    mkdirSync(join(dir, "docs", "screenshots"), { recursive: true });
    writeFileSync(join(dir, "docs", "screenshots", "old-name.png"), "fake-png-bytes-for-rename-test");
    run("add", "-A");
    run("commit", "-m", "base");
    const base = run("rev-parse", "HEAD").trim();
    run("mv", "docs/screenshots/old-name.png", "docs/screenshots/new-name.png");
    run("commit", "-m", "rename");
    const head = run("rev-parse", "HEAD").trim();
    const added = run("diff", "--diff-filter=A", "-M", "--name-only", `${base}...${head}`).trim();
    assert.equal(added, "");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("git diff --diff-filter=A does not list a modified pre-existing image as added", () => {
  const { dir, run } = initTempRepo();
  try {
    mkdirSync(join(dir, "docs", "screenshots"), { recursive: true });
    writeFileSync(join(dir, "docs", "screenshots", "legacy.png"), "fake-png-bytes-v1");
    run("add", "-A");
    run("commit", "-m", "base");
    const base = run("rev-parse", "HEAD").trim();
    writeFileSync(join(dir, "docs", "screenshots", "legacy.png"), "fake-png-bytes-v2-modified");
    run("add", "-A");
    run("commit", "-m", "modify legacy screenshot");
    const head = run("rev-parse", "HEAD").trim();
    const added = run("diff", "--diff-filter=A", "-M", "--name-only", `${base}...${head}`).trim();
    assert.equal(added, "");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("git diff --diff-filter=A -M still lists a genuinely new image as added", () => {
  const { dir, run } = initTempRepo();
  try {
    mkdirSync(join(dir, "docs", "screenshots"), { recursive: true });
    writeFileSync(join(dir, "docs", "screenshots", "existing.png"), "fake-png-bytes");
    run("add", "-A");
    run("commit", "-m", "base");
    const base = run("rev-parse", "HEAD").trim();
    writeFileSync(join(dir, "docs", "screenshots", "brand-new.png"), "unrelated-new-bytes-not-a-rename");
    run("add", "-A");
    run("commit", "-m", "add new screenshot");
    const head = run("rev-parse", "HEAD").trim();
    const added = run("diff", "--diff-filter=A", "-M", "--name-only", `${base}...${head}`).trim();
    assert.equal(added, "docs/screenshots/brand-new.png");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- Advisory manifest-schema lint ---

test("manifestPaths matches only docs/evidence capture-manifest.json files", () => {
  assert.deepEqual(
    manifestPaths([
      "docs/evidence/some-card/capture-manifest.json",
      "docs/evidence/nested/deep/capture-manifest.json",
      "docs/notes.md",
      "site/data/capture-manifest.json",
    ]),
    ["docs/evidence/some-card/capture-manifest.json", "docs/evidence/nested/deep/capture-manifest.json"],
  );
});

test("missingShaEntries flags captures without sha256 or content_sha256", () => {
  const payload = {
    captures: [
      { fixture: "a", sha256: "abc" },
      { fixture: "b", content_sha256: "def" },
      { fixture: "c" },
      { fixture: "d", sha256: "" },
    ],
  };
  const missing = missingShaEntries(payload);
  assert.deepEqual(
    missing.map((entry) => entry.label),
    ["c", "d"],
  );
});

test("the manifest lint warns but always exits zero", () => {
  const dir = mkdtempSync(join(tmpdir(), "capture-manifest-lint-"));
  try {
    mkdirSync(join(dir, "docs", "evidence", "scratch"), { recursive: true });
    const manifestPath = "docs/evidence/scratch/capture-manifest.json";
    writeFileSync(join(dir, manifestPath), JSON.stringify({ captures: [{ fixture: "no-sha" }] }));
    writeFileSync(join(dir, "paths.txt"), `${manifestPath}\n`);
    const result = spawnSync(process.execPath, [MANIFEST_LINT, "--paths-file", "paths.txt"], {
      cwd: dir,
      encoding: "utf8",
    });
    assert.equal(result.status, 0);
    assert.match(result.stderr, /missing sha256/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the manifest lint is quiet when every capture has a sha256", () => {
  withTempFile(["docs/evidence/result-group-navigation/capture-manifest.json"], (file) => {
    const output = runManifestLint(file);
    assert.match(output, /OK/);
  });
});
