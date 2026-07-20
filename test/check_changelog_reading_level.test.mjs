// Characterization tests for tools/check_changelog_reading_level.mjs — the pre-merge
// simulation of the changelog reading-level ratchet gate (crol-changelogprose-k8).
//
// Before this existed: a changelog entry's reading-level regression was only ever detected
// on the automated bot PR (bot/changelog-update), AFTER the feature PR that introduced the
// prose had already merged — by which point the author who wrote it is gone and someone has
// to hand-fix the wording on the bot branch instead. This happened twice in one day: PR #70
// (fixed by hand) and PRs #72/#74 together (see AGENTS.md's changelog section and
// tools/gen_changelog.mjs). This script simulates the exact regeneration
// update-changelog.yml performs and runs the same ratchet check DURING the feature PR, so
// the regression is caught while the prose is still editable.
//
// PR_72_ORIGINAL/PR_74_ORIGINAL below are the real, verbatim "What this means for you"
// texts that caused PR #75 (the bot PR) to fail the ratchet post-merge. PR_72_PLAIN/
// PR_74_PLAIN are the real reworded replacements that fixed it (see the commit that reworded
// changelog-data.json on bot/changelog-update).
//
// Fixture grades are computed against a small, self-contained base page (BASE_HTML +
// BASE_DATA) rather than the live repo's own changelog.html/reading-level-baseline.json, so
// this test stays stable as the real page's content and baseline grow over time — the real
// PR #72/#74 texts are still used verbatim, only the surrounding page is synthetic.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { simulate, measureAgainstBaseline, formatRegressionMessage } from "../tools/check_changelog_reading_level.mjs";
import { MAJOR_LABEL } from "../tools/changelog_extract.mjs";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const SCRIPT = path.join(ROOT, "tools", "check_changelog_reading_level.mjs");

let HAS_READABLE_OR_ELSE = true;
try {
  execFileSync("readable-or-else", ["--help"], { stdio: "ignore" });
} catch {
  HAS_READABLE_OR_ELSE = false;
}
const RO_SKIP = HAS_READABLE_OR_ELSE
  ? false
  : "readable-or-else is not on PATH in this environment (only installed in ci.yml's reading-level job)";

const BASE_HTML = `<!doctype html>
<html lang="en">
<head><title>Changelog</title>
<style>body{color:red}</style>
</head>
<body>
<header><nav>Home. About. Data. Stats. API. Changelog.</nav></header>
<main>
<h1>Recent updates</h1>
<p>This page lists changes that visitors can see. New entries are added when a change ships.</p>
<ul class="chg-auto"><!-- CHANGELOG:AUTO:START -->
  <!-- CHANGELOG:AUTO:END --></ul>
<script>console.log("hidden, not measured")</script>
</main>
<footer><p>CROL-List tracks city contracts and hearings in plain English.</p></footer>
</body>
</html>
`;

const BASE_DATA = {
  entries: [
    {
      pr: 10,
      merged_at: "2026-06-01",
      url: "https://example.invalid/10",
      text: "The site now shows more contracts. It also loads faster. Search works the same as before.",
    },
    {
      pr: 9,
      merged_at: "2026-05-01",
      url: "https://example.invalid/9",
      text: "You can now filter by agency. Pick one from the list. Results update right away.",
    },
  ],
};

// Measured once against BASE_HTML + BASE_DATA's two entries (readable-or-else check,
// --preset nycsg7 --mode gate --format json): grade 3.3401990049751227. Pinned here as the
// fixture's own committed baseline, mirroring what a real reading-level-baseline.json entry
// records for changelog.html.
const BASELINE = {
  version: 1,
  preset: "nycsg7",
  entries: {
    "changelog.html": { grade: 3.3401990049751227, formula: "flesch_kincaid_grade", language: "en" },
  },
};

const PR_74_ORIGINAL =
  "Following a link from a CROL-List digest email now shows *why* that notice was in your digest — the matching keyword highlighted in the title or a description snippet, plus a plain-language summary of your watch — instead of a bare notice page.";
const PR_74_PLAIN =
  "Click a link in a CROL-List digest email. You used to land on a bare notice page. Now you see why it matched. The matching word is highlighted. You also see a plain summary of your watch.";
const PR_72_ORIGINAL =
  "If one of your saved alerts hasn't found anything new in a couple of months, its next email will say so and link you straight back to the alerts page with that exact search already loaded, so you can see what it's currently looking for and broaden it in one step.";
const PR_72_PLAIN =
  "Has a saved alert gone quiet? If it finds nothing new for a couple of months, its next email says so. That email links back to the alerts page. Your exact search is already loaded there. You can broaden it in one step.";

function bodyWithMarker(text) {
  return `## What this means for you\n${text}\n`;
}

const NO_MARKER_BODY = "## Summary\nInternal refactor. No visible change.\n";

test("a PR with no marker section produces no simulation and no grade check — before: this class of check didn't exist at all, so a plumbing PR was never in scope; after: it stays out of scope explicitly", () => {
  const result = simulate({
    baseDataJson: JSON.stringify(BASE_DATA),
    baseHtml: BASE_HTML,
    i18nSource: Buffer.from(""),
    number: 99,
    url: "https://example.invalid/99",
    mergedAt: "2026-07-17",
    body: NO_MARKER_BODY,
    labels: [MAJOR_LABEL],
  });
  assert.equal(result.reason, "no-marker");
  assert.equal(result.text, null);
  assert.equal(result.html, null);
});

test("a PR with no changelog:major label produces no simulation, even with a marker section present", () => {
  const result = simulate({
    baseDataJson: JSON.stringify(BASE_DATA),
    baseHtml: BASE_HTML,
    i18nSource: Buffer.from(""),
    number: 99,
    url: "https://example.invalid/99",
    mergedAt: "2026-07-17",
    body: bodyWithMarker(PR_74_PLAIN),
    labels: ["enhancement"],
  });
  assert.equal(result.reason, "not-major");
  assert.equal(result.text, null);
  assert.equal(result.html, null);
});

test("a PR number already recorded in the base produces no simulation (mirrors gen_changelog.mjs's own idempotency)", () => {
  const result = simulate({
    baseDataJson: JSON.stringify(BASE_DATA),
    baseHtml: BASE_HTML,
    i18nSource: Buffer.from(""),
    number: 10,
    url: "https://example.invalid/10",
    mergedAt: "2026-07-17",
    body: bodyWithMarker(PR_74_PLAIN),
  });
  assert.equal(result.reason, "already-recorded");
});

test(
  "PR #74's real, verbatim original wording regresses the simulated page's grade past the committed baseline — before: this was only caught post-merge on the bot PR (#75); after: the same regression is detectable from the feature PR's own body",
  { skip: RO_SKIP },
  () => {
    const sim = simulate({
      baseDataJson: JSON.stringify(BASE_DATA),
      baseHtml: BASE_HTML,
      i18nSource: Buffer.from(""),
      number: 74,
      url: "https://github.com/cityscroll/crol-list/pull/74",
      mergedAt: "2026-07-17",
      body: bodyWithMarker(PR_74_ORIGINAL),
      labels: [MAJOR_LABEL],
    });
    assert.equal(sim.reason, "added");
    assert.equal(sim.text, PR_74_ORIGINAL);

    const result = measureAgainstBaseline(sim.html, { baseline: writeTmpBaseline(), preset: "nycsg7" });
    assert.equal(result.status, "fail");
    assert.ok(result.grade > result.baseline_grade);

    const message = formatRegressionMessage(result, sim.text);
    assert.match(message, /::error::/);
    assert.ok(message.includes(PR_74_ORIGINAL), "message must name the offending entry text");
    assert.match(message, /\+\d+\.\d{2}/, "message must state the grade delta");
  }
);

test(
  "PR #72's real, verbatim original wording also regresses the simulated page — the second of the two entries that failed PR #75 together",
  { skip: RO_SKIP },
  () => {
    const sim = simulate({
      baseDataJson: JSON.stringify(BASE_DATA),
      baseHtml: BASE_HTML,
      i18nSource: Buffer.from(""),
      number: 72,
      url: "https://github.com/cityscroll/crol-list/pull/72",
      mergedAt: "2026-07-17",
      body: bodyWithMarker(PR_72_ORIGINAL),
      labels: [MAJOR_LABEL],
    });
    assert.equal(sim.reason, "added");

    const result = measureAgainstBaseline(sim.html, { baseline: writeTmpBaseline(), preset: "nycsg7" });
    assert.equal(result.status, "fail");
  }
);

test(
  "the real reworded (plain) text that actually fixed PR #75 passes the same simulated check — proves the gate isn't just a tripwire, it accepts the real fix",
  { skip: RO_SKIP },
  () => {
    for (const [number, text] of [
      [74, PR_74_PLAIN],
      [72, PR_72_PLAIN],
    ]) {
      const sim = simulate({
        baseDataJson: JSON.stringify(BASE_DATA),
        baseHtml: BASE_HTML,
        i18nSource: Buffer.from(""),
        number,
        url: `https://github.com/cityscroll/crol-list/pull/${number}`,
        mergedAt: "2026-07-17",
        body: bodyWithMarker(text),
        labels: [MAJOR_LABEL],
      });
      const result = measureAgainstBaseline(sim.html, { baseline: writeTmpBaseline(), preset: "nycsg7" });
      assert.equal(result.status, "pass", `PR #${number}'s reworded text should pass: ${result.reason}`);
    }
  }
);

test(
  "an absent bot branch falls back to a fresh base (this PR's own already-committed changelog files, no bot-branch overlay) and the simulation still runs cleanly — before: no fallback existed to test since the pre-merge check itself didn't exist",
  { skip: RO_SKIP },
  () => {
    // "Absent bot branch" only changes WHICH files the CI step hands in as --base-data/
    // --base-html (see ci.yml's "Load the changelog regeneration base" step) — the script
    // itself is agnostic to their provenance. BASE_HTML/BASE_DATA here stand in for "this
    // PR's own committed changelog-data.json/changelog.html", exactly what the CI step's
    // fallback branch copies when `git ls-remote --heads origin bot/changelog-update` finds
    // nothing.
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "changelog-gate-fresh-"));
    try {
      const baseDataPath = path.join(tmp, "base-data.json");
      const baseHtmlPath = path.join(tmp, "base.html");
      const i18nPath = path.join(tmp, "i18n.js");
      const bodyPath = path.join(tmp, "body.md");
      const baselinePath = path.join(tmp, "baseline.json");
      fs.writeFileSync(baseDataPath, JSON.stringify(BASE_DATA));
      fs.writeFileSync(baseHtmlPath, BASE_HTML);
      fs.writeFileSync(i18nPath, "");
      fs.writeFileSync(bodyPath, bodyWithMarker(PR_74_PLAIN));
      fs.writeFileSync(baselinePath, JSON.stringify(BASELINE));

      const out = execFileSync(
        process.execPath,
        [
          SCRIPT,
          "--base-data", baseDataPath,
          "--base-html", baseHtmlPath,
          "--i18n", i18nPath,
          "--number", "74",
          "--url", "https://github.com/cityscroll/crol-list/pull/74",
          "--merged-at", "2026-07-17",
          "--body-file", bodyPath,
          "--labels", MAJOR_LABEL,
          "--baseline", baselinePath,
        ],
        { encoding: "utf8" }
      );
      assert.match(out, /^OK — simulated changelog\.html grade/);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }
);

test(
  "CLI exit-code contract: regression exits 1 with an annotated stderr message, a passing entry exits 0",
  { skip: RO_SKIP },
  () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "changelog-gate-cli-"));
    try {
      const baseDataPath = path.join(tmp, "base-data.json");
      const baseHtmlPath = path.join(tmp, "base.html");
      const i18nPath = path.join(tmp, "i18n.js");
      const baselinePath = path.join(tmp, "baseline.json");
      fs.writeFileSync(baseDataPath, JSON.stringify(BASE_DATA));
      fs.writeFileSync(baseHtmlPath, BASE_HTML);
      fs.writeFileSync(i18nPath, "");
      fs.writeFileSync(baselinePath, JSON.stringify(BASELINE));

      const regressBody = path.join(tmp, "regress.md");
      fs.writeFileSync(regressBody, bodyWithMarker(PR_74_ORIGINAL));
      assert.throws(() => {
        execFileSync(
          process.execPath,
          [SCRIPT, "--base-data", baseDataPath, "--base-html", baseHtmlPath, "--i18n", i18nPath,
            "--number", "74", "--url", "https://github.com/cityscroll/crol-list/pull/74",
            "--merged-at", "2026-07-17", "--body-file", regressBody, "--labels", MAJOR_LABEL,
            "--baseline", baselinePath],
          { encoding: "utf8", stdio: "pipe" }
        );
      }, (err) => {
        assert.equal(err.status, 1);
        assert.match(err.stderr, /::error::/);
        assert.ok(err.stderr.includes(PR_74_ORIGINAL));
        return true;
      });

      const passBody = path.join(tmp, "pass.md");
      fs.writeFileSync(passBody, bodyWithMarker(PR_74_PLAIN));
      const out = execFileSync(
        process.execPath,
        [SCRIPT, "--base-data", baseDataPath, "--base-html", baseHtmlPath, "--i18n", i18nPath,
          "--number", "74", "--url", "https://github.com/cityscroll/crol-list/pull/74",
          "--merged-at", "2026-07-17", "--body-file", passBody, "--labels", MAJOR_LABEL,
          "--baseline", baselinePath],
        { encoding: "utf8" }
      );
      assert.match(out, /^OK —/);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }
);

function writeTmpBaseline() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "changelog-gate-baseline-"));
  const p = path.join(dir, "baseline.json");
  fs.writeFileSync(p, JSON.stringify(BASELINE));
  return p;
}
