// Characterization test for tools/prepare-changelog-base.sh — the shared "which files come
// from where" step both update-changelog.yml (the real post-merge regeneration) and ci.yml
// (the pre-merge reading-level simulation) source.
//
// Field failure this fixes (PR #84): the bot branch (bot/changelog-update) carries its own
// committed changelog.html forward from run to run. The pre-fix workflow step overwrote the
// freshly-checked-out main copy of changelog.html with THAT stale copy before regenerating
// the entries block — so a paragraph deleted from main (PR #83 removed the `chg_auto_note`
// disclaimer) silently survived on the bot branch, because the bot branch's own copy
// predated the deletion. The next regeneration rebuilt only the CHANGELOG:AUTO block on top
// of that stale page and re-failed the i18n reference gate with "missing from dictionary:
// chg_auto_note" — a key that no longer exists anywhere in the real i18n catalog.
//
// Before this fix: regeneration preserves stale non-generated page content (the deleted
// disclaimer paragraph survives).
// After this fix: output is main's current changelog.html (the disclaimer is gone, as it
// should be) plus the regenerated entries block; only changelog-data.json's pending entries
// come from the bot branch.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const SCRIPT = path.join(ROOT, "tools", "prepare-changelog-base.sh");

const STALE_HTML_WITH_DISCLAIMER = `<!doctype html>
<html><body>
<p data-i18n="chg_auto_note">These lines come from merged PR descriptions.</p>
<ul class="chg-auto"><!-- CHANGELOG:AUTO:START -->
  <li>old pending entry</li>
  <!-- CHANGELOG:AUTO:END --></ul>
</body></html>
`;

const CURRENT_HTML_NO_DISCLAIMER = `<!doctype html>
<html><body>
<ul class="chg-auto"><!-- CHANGELOG:AUTO:START -->
  <!-- CHANGELOG:AUTO:END --></ul>
</body></html>
`;

function git(cwd, ...args) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function initRepo(dir) {
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "user.email", "test@example.invalid");
  git(dir, "config", "user.name", "Test");
}

function commitAll(dir, message) {
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", message);
}

test("bot branch's stale changelog.html never overwrites the current tree's copy; only its pending changelog-data.json entries are pulled in", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "changelog-base-"));
  const bareDir = path.join(tmp, "origin.git");
  const workDir = path.join(tmp, "work");
  try {
    // Bare "origin" remote, standing in for the real GitHub repo.
    fs.mkdirSync(bareDir);
    git(bareDir, "init", "-q", "--bare", "-b", "main");

    // A throwaway clone used to seed both branches on "origin".
    const seedDir = path.join(tmp, "seed");
    git(tmp, "clone", "-q", bareDir, seedDir);
    initRepo(seedDir);

    // main: the current, post-PR-#83 state — disclaimer already removed, one recorded entry.
    fs.writeFileSync(path.join(seedDir, "changelog.html"), CURRENT_HTML_NO_DISCLAIMER);
    fs.writeFileSync(
      path.join(seedDir, "changelog-data.json"),
      JSON.stringify({ entries: [{ pr: 83, merged_at: "2026-07-19", url: "", text: "Recorded." }] }, null, 2) + "\n"
    );
    commitAll(seedDir, "seed main");
    git(seedDir, "push", "-q", "origin", "main");

    // bot/changelog-update: a stale copy from BEFORE PR #83 — still has the disclaimer, plus
    // one pending entry (PR #84) that hasn't landed on main yet.
    git(seedDir, "checkout", "-q", "-b", "bot/changelog-update");
    fs.writeFileSync(path.join(seedDir, "changelog.html"), STALE_HTML_WITH_DISCLAIMER);
    fs.writeFileSync(
      path.join(seedDir, "changelog-data.json"),
      JSON.stringify(
        {
          entries: [
            { pr: 84, merged_at: "2026-07-20", url: "", text: "Pending." },
            { pr: 83, merged_at: "2026-07-19", url: "", text: "Recorded." },
          ],
        },
        null,
        2
      ) + "\n"
    );
    commitAll(seedDir, "stale bot branch state");
    git(seedDir, "push", "-q", "origin", "bot/changelog-update");

    // The real workflow's own working tree: checked out at main, with "origin" pointing at
    // the bare repo — exactly what actions/checkout leaves behind.
    git(tmp, "clone", "-q", bareDir, workDir);

    execFileSync("bash", [SCRIPT, "bot/changelog-update"], { cwd: workDir, encoding: "utf8" });

    const html = fs.readFileSync(path.join(workDir, "changelog.html"), "utf8");
    const data = JSON.parse(fs.readFileSync(path.join(workDir, "changelog-data.json"), "utf8"));

    // changelog.html must stay main's current copy — no disclaimer residue from the bot branch.
    assert.equal(html, CURRENT_HTML_NO_DISCLAIMER);
    assert.doesNotMatch(html, /chg_auto_note/);

    // changelog-data.json must reflect the bot branch's pending entries (PR #84 included).
    assert.deepEqual(
      data.entries.map((e) => e.pr),
      [84, 83]
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("no bot branch yet: changelog-data.json is left as the tree's own committed copy", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "changelog-base-nobot-"));
  const bareDir = path.join(tmp, "origin.git");
  const workDir = path.join(tmp, "work");
  try {
    fs.mkdirSync(bareDir);
    git(bareDir, "init", "-q", "--bare", "-b", "main");

    const seedDir = path.join(tmp, "seed");
    git(tmp, "clone", "-q", bareDir, seedDir);
    initRepo(seedDir);
    fs.writeFileSync(path.join(seedDir, "changelog.html"), CURRENT_HTML_NO_DISCLAIMER);
    fs.writeFileSync(
      path.join(seedDir, "changelog-data.json"),
      JSON.stringify({ entries: [{ pr: 83, merged_at: "2026-07-19", url: "", text: "Recorded." }] }, null, 2) + "\n"
    );
    commitAll(seedDir, "seed main");
    git(seedDir, "push", "-q", "origin", "main");

    git(tmp, "clone", "-q", bareDir, workDir);
    const before = fs.readFileSync(path.join(workDir, "changelog-data.json"), "utf8");

    execFileSync("bash", [SCRIPT, "bot/changelog-update"], { cwd: workDir, encoding: "utf8" });

    const after = fs.readFileSync(path.join(workDir, "changelog-data.json"), "utf8");
    const html = fs.readFileSync(path.join(workDir, "changelog.html"), "utf8");
    assert.equal(after, before);
    assert.equal(html, CURRENT_HTML_NO_DISCLAIMER);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
