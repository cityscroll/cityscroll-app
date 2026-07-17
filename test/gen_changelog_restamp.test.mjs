// Characterization test for the i18n.js?v=<hash8> cache-skew stamp inside changelog.html's
// generated block (tools/gen_changelog.mjs). See AGENTS.md's "Changelog — self-updating
// from merged-PR marker sections" note for the incident this fixes: the automated-update
// workflow's bot branch carries its changelog.html forward from run to run, so a merged PR
// that changed i18n.js (bumping its hash) after the bot branch last regenerated left the
// bot's changelog.html stamped with the OLD hash forever — nothing in gen_changelog.mjs
// used to touch that stamp at all, since it only ever rewrote the entries list between the
// CHANGELOG:AUTO markers. That's exactly what happened live: PR #71 failed
// test/standards/i18n_refs.py with "FAIL stale version param — changelog.html has
// v=866d57e7, i18n.js hashes to e279c695" after PR #70 changed i18n.js.
//
// Before this fix: regenerating changelog.html over a tree whose i18n.js hash differs from
// the one already embedded in changelog.html left the OLD, now-wrong hash in place. After:
// every regeneration re-stamps it from the i18n.js actually present in the tree it ran in,
// so the class of bug (not just this one instance) can't recur.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { restampI18nVersion, i18nVersionHash } from "../tools/gen_changelog.mjs";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

test("restampI18nVersion overwrites a stale hash with sha256(i18n.js)[:8] of the given source", () => {
  const html = '<script src="i18n.js?v=deadbeef"></script>\n<p>unrelated</p>';
  const i18nSource = Buffer.from("window.STRINGS = { en: {} };\n");
  const expected = crypto.createHash("sha256").update(i18nSource).digest("hex").slice(0, 8);

  assert.notEqual(expected, "deadbeef"); // the fixture's stale stamp must not coincidentally match
  const out = restampI18nVersion(html, i18nSource);
  assert.equal(out, `<script src="i18n.js?v=${expected}"></script>\n<p>unrelated</p>`);
  assert.equal(i18nVersionHash(i18nSource), expected);
});

test("a full --rebuild run over a tree whose i18n.js hash differs from changelog.html's embedded stamp emits the current hash", () => {
  // Fixture tree: copy just the generator + its dependency, plus minimal changelog-data.json/
  // changelog.html/i18n.js fixtures whose stamp is deliberately stale — this reproduces the
  // exact "bot branch carried an old stamp forward" scenario from the incident above.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gen-changelog-restamp-"));
  try {
    fs.mkdirSync(path.join(tmp, "tools"));
    fs.copyFileSync(path.join(ROOT, "tools", "gen_changelog.mjs"), path.join(tmp, "tools", "gen_changelog.mjs"));
    fs.copyFileSync(path.join(ROOT, "tools", "changelog_extract.mjs"), path.join(tmp, "tools", "changelog_extract.mjs"));

    fs.writeFileSync(
      path.join(tmp, "changelog-data.json"),
      JSON.stringify({ entries: [{ pr: 1, merged_at: "2026-07-01", url: "", text: "Fixture entry." }] }, null, 2) + "\n"
    );
    fs.writeFileSync(
      path.join(tmp, "changelog.html"),
      '<script src="i18n.js?v=aaaaaaaa"></script>\n<ul>\n  <!-- CHANGELOG:AUTO:START -->\n  <!-- CHANGELOG:AUTO:END -->\n</ul>\n'
    );
    const i18nSource = "window.STRINGS = { en: { hello: \"hi\" } };\n";
    fs.writeFileSync(path.join(tmp, "i18n.js"), i18nSource);
    const currentHash = crypto.createHash("sha256").update(i18nSource).digest("hex").slice(0, 8);
    assert.notEqual(currentHash, "aaaaaaaa"); // the fixture's embedded stamp must be genuinely stale

    execFileSync(process.execPath, [path.join(tmp, "tools", "gen_changelog.mjs"), "--rebuild"], { cwd: tmp });

    const rebuilt = fs.readFileSync(path.join(tmp, "changelog.html"), "utf8");
    assert.match(rebuilt, new RegExp(`src="i18n\\.js\\?v=${currentHash}"`));
    assert.doesNotMatch(rebuilt, /v=aaaaaaaa/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
