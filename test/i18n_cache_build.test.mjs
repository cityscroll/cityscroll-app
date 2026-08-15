import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { primaryDocumentOutputs } from "../tools/build_primary_documents.mjs";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const SITE_ROOT = path.join(ROOT, "site");
const PAGES = [
  "index.html",
  "about.html",
  "data.html",
  "stats.html",
  "api.html",
  "changelog.html",
  "standards.html",
];

function cleanGitEnv() {
  // Parallel suite / worktree sessions can leak GIT_DIR and friends into child
  // processes; sandbox tests must not inherit them or they mutate the host repo.
  const env = { ...process.env };
  for (const key of [
    "GIT_DIR",
    "GIT_WORK_TREE",
    "GIT_COMMON_DIR",
    "GIT_INDEX_FILE",
    "GIT_OBJECT_DIRECTORY",
    "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  ]) {
    delete env[key];
  }
  return env;
}

function run(command, args, cwd, expectSuccess = true) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    env: cleanGitEnv(),
  });
  if (expectSuccess && result.status !== 0) {
    assert.fail(`${command} ${args.join(" ")} failed:\n${result.stdout}\n${result.stderr}`);
  }
  return result;
}

function copySiteFiles(source, destination) {
  fs.mkdirSync(destination, { recursive: true });
  for (const page of PAGES) {
    fs.copyFileSync(path.join(source, page), path.join(destination, page));
  }
  fs.copyFileSync(path.join(source, "i18n.js"), path.join(destination, "i18n.js"));
  fs.cpSync(path.join(source, "i18n"), path.join(destination, "i18n"), { recursive: true });
}

function copyPrimaryDocuments(destination) {
  for (const [sourcePath, html] of primaryDocumentOutputs()) {
    const relative = path.relative(SITE_ROOT, sourcePath);
    const target = path.join(destination, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, html);
  }
}

function buildIgnoredArtifact(repo) {
  const output = path.join(repo, "_site");
  fs.rmSync(output, { recursive: true, force: true });
  copySiteFiles(repo, output);
  run(
    "python3",
    [path.join(repo, "tools", "stamp_i18n_assets.py"), "--site-root", output, "--stamp"],
    repo
  );
}

test("two independently built language branches merge without shared generated edits", () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "i18n-merge-friendly-"));
  try {
    copySiteFiles(SITE_ROOT, repo);
    fs.mkdirSync(path.join(repo, "tools"), { recursive: true });
    fs.copyFileSync(
      path.join(ROOT, "tools", "stamp_i18n_assets.py"),
      path.join(repo, "tools", "stamp_i18n_assets.py")
    );
    fs.writeFileSync(path.join(repo, ".gitignore"), "_site/\n");

    run("git", ["init", "-b", "main"], repo);
    run("git", ["config", "user.name", "Merge Test"], repo);
    run("git", ["config", "user.email", "merge-test"], repo);
    run("git", ["add", "."], repo);
    run("git", ["commit", "-m", "base"], repo);

    // Unique per process for parallel suite isolation.
    const spanishBranch = `spanish-update-${process.pid}`;
    const frenchBranch = `french-update-${process.pid}`;
    run("git", ["checkout", "-b", spanishBranch], repo);
    fs.appendFileSync(path.join(repo, "i18n", "lang", "es.js"), "\n// independent Spanish update\n");
    buildIgnoredArtifact(repo);
    assert.equal(run("git", ["status", "--porcelain"], repo).stdout.trim(), "M i18n/lang/es.js");
    run("git", ["add", "i18n/lang/es.js"], repo);
    run("git", ["commit", "-m", "Update Spanish"], repo);

    run("git", ["checkout", "main"], repo);
    run("git", ["checkout", "-b", frenchBranch], repo);
    fs.appendFileSync(path.join(repo, "i18n", "lang", "fr.js"), "\n// independent French update\n");
    buildIgnoredArtifact(repo);
    assert.equal(run("git", ["status", "--porcelain"], repo).stdout.trim(), "M i18n/lang/fr.js");
    run("git", ["add", "i18n/lang/fr.js"], repo);
    run("git", ["commit", "-m", "Update French"], repo);

    run("git", ["merge", "--no-edit", spanishBranch], repo);
    assert.equal(run("git", ["diff", "--name-only", "--diff-filter=U"], repo).stdout, "");
    assert.match(fs.readFileSync(path.join(repo, "i18n", "lang", "es.js"), "utf8"), /Spanish update/);
    assert.match(fs.readFileSync(path.join(repo, "i18n", "lang", "fr.js"), "utf8"), /French update/);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test("the built-artifact gate rejects real skew after a dictionary changes", () => {
  const site = fs.mkdtempSync(path.join(os.tmpdir(), "i18n-built-skew-"));
  try {
    copySiteFiles(SITE_ROOT, site);
    run("python3", [path.join(ROOT, "tools", "stamp_i18n_assets.py"), "--site-root", site, "--stamp"], ROOT);
    run(
      "python3",
      [path.join(ROOT, "test", "standards", "i18n_refs.py"), "--root", site, "--built"],
      ROOT
    );

    fs.appendFileSync(path.join(site, "i18n", "lang", "es.js"), "\n// changed after stamping\n");
    const skew = run(
      "python3",
      [path.join(ROOT, "test", "standards", "i18n_refs.py"), "--root", site, "--built"],
      ROOT,
      false
    );
    assert.notEqual(skew.status, 0);
    assert.match(`${skew.stdout}\n${skew.stderr}`, /built i18n cache skew/);
  } finally {
    fs.rmSync(site, { recursive: true, force: true });
  }
});

test("the built /now/ and /browse/* pages do not ship the literal i18n asset placeholder", () => {
  const site = fs.mkdtempSync(path.join(os.tmpdir(), "i18n-primary-routes-"));
  try {
    copySiteFiles(SITE_ROOT, site);
    copyPrimaryDocuments(site);

    const routePages = primaryDocumentOutputs()
      .map(([sourcePath]) => path.relative(SITE_ROOT, sourcePath))
      .filter((relative) => relative === "now/index.html" || relative.startsWith("browse/"));
    assert.equal(routePages.length, 11);
    for (const relative of routePages) {
      assert.match(
        fs.readFileSync(path.join(site, relative), "utf8"),
        /i18n\.js\?v=__I18N_ASSET_VERSION__/,
        `${relative} must characterize the observed pre-fix failure`,
      );
    }

    run("python3", [path.join(ROOT, "tools", "stamp_i18n_assets.py"), "--site-root", site, "--stamp"], ROOT);
    const rootHtml = fs.readFileSync(path.join(site, "index.html"), "utf8");
    const version = rootHtml.match(/i18n\.js\?v=([0-9a-f]{12})/)?.[1];
    assert.ok(version, "the root page must receive a content-derived asset version");
    for (const relative of routePages) {
      const html = fs.readFileSync(path.join(site, relative), "utf8");
      assert.doesNotMatch(html, /__I18N_ASSET_VERSION__/i, relative);
      assert.match(html, new RegExp(`i18n\\.js\\?v=${version}`), relative);
    }
    run("python3", [path.join(ROOT, "tools", "stamp_i18n_assets.py"), "--site-root", site, "--verify-built"], ROOT);
  } finally {
    fs.rmSync(site, { recursive: true, force: true });
  }
});
