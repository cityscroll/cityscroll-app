import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const read = (path) => readFileSync(join(ROOT, path), "utf8");
const ISOLATED_GIT_ENV = { ...process.env };
for (const name of Object.keys(ISOLATED_GIT_ENV)) {
  if (name.startsWith("GIT_")) delete ISOLATED_GIT_ENV[name];
}

test("shared browser artifact is exact-input cached and every consumer verifies it", () => {
  const workflow = read(".github/workflows/ci.yml");
  const consumer = read(".github/actions/use-site-artifact/action.yml");
  const producer = workflow.slice(
    workflow.indexOf("  browser-pr-site:\n"),
    workflow.indexOf("  a11y-pr-shard:\n"),
  );

  assert.match(producer, /actions\/cache\/restore@v4/);
  assert.match(producer, /actions\/cache\/save@v4/);
  assert.match(producer, /steps\.site-identity\.outputs\.build-input-identity/);
  assert.match(producer, /site_artifact_identity\.mjs verify --commit-sha "\$GITHUB_SHA"/);
  assert.match(producer, /steps\.cached-site\.outputs\.ready != 'true'[\s\S]*?uses: \.\/\.github\/actions\/build-site/);
  assert.match(producer, /name: browser-pr-site-\$\{\{ github\.run_id \}\}-\$\{\{ github\.run_attempt \}\}/);
  assert.match(producer, /_site\.sha256/);
  assert.match(producer, /_site\.identity\.json/);

  const consumers = workflow.match(/uses: \.\/\.github\/actions\/use-site-artifact/g) || [];
  assert.equal(consumers.length, 5);
  const qualifiedNames = workflow.match(/artifact-name: browser-pr-site-\$\{\{ github\.run_id \}\}-\$\{\{ github\.run_attempt \}\}/g) || [];
  assert.equal(qualifiedNames.length, consumers.length);

  assert.match(consumer, /actions\/download-artifact@v4/);
  assert.match(consumer, /actions\/cache\/restore@v4/);
  assert.match(consumer, /site_artifact_identity\.mjs verify --commit-sha "\$GITHUB_SHA"/);
  assert.match(consumer, /Rebuild site after artifact and cache miss/);
  assert.match(consumer, /Verify site digest and exact build identity/);
});

test("artifact identity verifies digest, tree, lockfile, tool, and derived build inputs", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "cityscroll-site-identity-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  mkdirSync(join(directory, "worker"));
  mkdirSync(join(directory, "_site"));
  writeFileSync(join(directory, "worker/package-lock.json"), "{\"lockfileVersion\":3}\n");
  writeFileSync(join(directory, "_site/index.html"), "<!doctype html><title>Exact</title>\n");
  const git = (...args) => execFileSync("git", args, { cwd: directory, env: ISOLATED_GIT_ENV });
  git("init", "--quiet");
  git("config", "user.name", "CI Artifact Test");
  git("config", "user.email", "ci-artifact@example.invalid");
  git("add", "worker/package-lock.json");
  git("commit", "--quiet", "-m", "Add lockfile");

  const tool = join(ROOT, "tools/site_artifact_identity.mjs");
  execFileSync(process.execPath, [tool, "stamp"], { cwd: directory, env: ISOLATED_GIT_ENV });
  execFileSync(process.execPath, [tool, "verify"], { cwd: directory, env: ISOLATED_GIT_ENV });
  const manifest = JSON.parse(readFileSync(join(directory, "_site.identity.json"), "utf8"));
  assert.match(manifest.commit_sha, /^[a-f0-9]{40}$/);
  assert.match(manifest.tree_sha, /^[a-f0-9]{40}$/);
  assert.match(manifest.lockfile.sha256, /^[a-f0-9]{64}$/);
  assert.equal(manifest.tool.version, process.version);
  assert.deepEqual(manifest.build_inputs, {
    source_dir: ".",
    site_dir: "_site",
    review_channel: "",
    refresh_decision_outcomes: "false",
  });
  assert.match(manifest.build_input_identity, /^[a-f0-9]{64}$/);
  assert.match(manifest.site.checksum_manifest_sha256, /^[a-f0-9]{64}$/);

  writeFileSync(join(directory, "_site/index.html"), "tampered\n");
  const tampered = spawnSync(process.execPath, [tool, "verify"], {
    cwd: directory,
    encoding: "utf8",
    env: ISOLATED_GIT_ENV,
  });
  assert.notEqual(tampered.status, 0);
  assert.match(tampered.stderr, /checksum mismatch/);

  writeFileSync(join(directory, "_site/index.html"), "<!doctype html><title>Exact</title>\n");
  writeFileSync(join(directory, "worker/package-lock.json"), "{\"lockfileVersion\":2}\n");
  const wrongLock = spawnSync(process.execPath, [tool, "verify"], {
    cwd: directory,
    encoding: "utf8",
    env: ISOLATED_GIT_ENV,
  });
  assert.notEqual(wrongLock.status, 0);
  assert.match(wrongLock.stderr, /build_input_identity mismatch|lockfile identity mismatch/);
});
