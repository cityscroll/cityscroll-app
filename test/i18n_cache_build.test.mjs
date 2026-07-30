import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

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

function run(command, args, cwd, expectSuccess = true) {
  const result = spawnSync(command, args, { cwd, encoding: "utf8" });
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

    run("git", ["checkout", "-b", "spanish-update"], repo);
    fs.appendFileSync(path.join(repo, "i18n", "lang", "es.js"), "\n// independent Spanish update\n");
    buildIgnoredArtifact(repo);
    assert.equal(run("git", ["status", "--porcelain"], repo).stdout.trim(), "M i18n/lang/es.js");
    run("git", ["add", "i18n/lang/es.js"], repo);
    run("git", ["commit", "-m", "Update Spanish"], repo);

    run("git", ["checkout", "main"], repo);
    run("git", ["checkout", "-b", "french-update"], repo);
    fs.appendFileSync(path.join(repo, "i18n", "lang", "fr.js"), "\n// independent French update\n");
    buildIgnoredArtifact(repo);
    assert.equal(run("git", ["status", "--porcelain"], repo).stdout.trim(), "M i18n/lang/fr.js");
    run("git", ["add", "i18n/lang/fr.js"], repo);
    run("git", ["commit", "-m", "Update French"], repo);

    run("git", ["merge", "--no-edit", "spanish-update"], repo);
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
