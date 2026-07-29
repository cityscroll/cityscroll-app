// The changelog bot carries changelog.html forward between runs. Its generator must keep
// the merge-stable source token and leave content hashing to the Pages build artifact.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { restampI18nVersion } from "../tools/gen_changelog.mjs";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

test("restampI18nVersion normalizes a stale committed hash to the build token", () => {
  const html = '<script src="i18n.js?v=deadbeef"></script>\n<p>unrelated</p>';
  const out = restampI18nVersion(html);
  assert.equal(out, '<script src="i18n.js?v=__I18N_ASSET_VERSION__"></script>\n<p>unrelated</p>');
});

test("a full --rebuild run cannot put a generated hash back into source", () => {
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
    fs.writeFileSync(path.join(tmp, "i18n.js"), "window.STRINGS = { en: { hello: \"hi\" } };\n");

    execFileSync(process.execPath, [path.join(tmp, "tools", "gen_changelog.mjs"), "--rebuild"], { cwd: tmp });

    const rebuilt = fs.readFileSync(path.join(tmp, "changelog.html"), "utf8");
    assert.match(rebuilt, /src="i18n\.js\?v=__I18N_ASSET_VERSION__"/);
    assert.doesNotMatch(rebuilt, /v=aaaaaaaa/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
