#!/usr/bin/env node
// tools/check_changelog_reading_level.mjs — pre-merge simulation of the changelog
// reading-level ratchet gate.
//
// The problem this closes: the "Update changelog" workflow
// (.github/workflows/update-changelog.yml) harvests a merged PR's "## What this means for
// you" section into changelog-data.json/changelog.html on the bot branch (bot/changelog-
// update), which then rides the site's reading-level ratchet (see ci.yml's `reading-level`
// job) as part of the BOT'S OWN pull request — by which point the PR author who wrote the
// prose is gone. Twice now (two different merged feature PRs), that regenerated page failed
// the ratchet only after merge, stranding the bot PR until someone rewrote the wording by
// hand on the bot branch.
//
// This script runs during the FEATURE PR itself (see ci.yml's `reading-level` job, gated to
// `github.event_name == 'pull_request'`): it simulates the exact regeneration the merge-
// triggered workflow would perform — the given base entries (the bot branch's pending state,
// or this repo's own committed state if no bot branch exists yet) plus this PR's own
// harvested entry, if it has one — and runs the SAME readable-or-else ratchet check against
// the simulated page. A wording regression fails the feature PR, naming the offending entry
// text and the grade delta, while the prose is still in the author's hands to fix.
//
// This never touches the real changelog-data.json/changelog.html — only tools/gen_changelog.mjs
// (the post-merge path) writes those. Reuses gen_changelog.mjs's own computeEntryAddition/
// buildHtml so "what counts as harvestable" and "how the page renders" can never drift
// between the pre-merge simulation and the real post-merge run.
//
// Usage:
//   node tools/check_changelog_reading_level.mjs \
//     --base-data <path> --base-html <path> --i18n <path> \
//     --number N --url URL --merged-at DATE --body-file FILE --labels "changelog:major,..." \
//     --baseline <path> [--preset nycsg7]
//
// Exit 0: no harvestable entry (nothing to simulate), or the simulated page meets the
//         committed baseline.
// Exit 1: the simulated page regresses the committed baseline.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { computeEntryAddition, buildHtml, parseLabels } from "./gen_changelog.mjs";

export function parseArgs(argv) {
  const out = { preset: "nycsg7" };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--base-data") out.baseData = argv[++i];
    else if (a === "--base-html") out.baseHtml = argv[++i];
    else if (a === "--i18n") out.i18n = argv[++i];
    else if (a === "--number") out.number = Number(argv[++i]);
    else if (a === "--url") out.url = argv[++i];
    else if (a === "--merged-at") out.mergedAt = argv[++i];
    else if (a === "--body-file") out.bodyFile = argv[++i];
    else if (a === "--labels") out.labels = argv[++i];
    else if (a === "--baseline") out.baseline = argv[++i];
    else if (a === "--preset") out.preset = argv[++i];
  }
  return out;
}

// Builds the simulated changelog.html for a candidate entry. Returns { reason, text, html }
// — html is null when there's nothing to simulate (reason is "no-marker" or
// "already-recorded"). Pure aside from the two base-file/i18n reads the caller hands it as
// already-loaded strings, so it's directly unit-testable with fixture strings.
export function simulate({ baseDataJson, baseHtml, i18nSource, number, url, mergedAt, body, labels }) {
  const data = JSON.parse(baseDataJson);
  const entries = data.entries || [];
  const result = computeEntryAddition(entries, { number, url, mergedAt, body, labels });
  if (result.reason !== "added") {
    return { reason: result.reason, text: null, html: null };
  }
  const html = buildHtml(baseHtml, result.entries, i18nSource);
  return { reason: "added", text: result.text, html };
}

// Runs `readable-or-else check` against the simulated html (written to a temp dir as
// literally "changelog.html", so the CLI's ratchet lookup matches the baseline's
// "changelog.html" key) and returns its single parsed result.
export function measureAgainstBaseline(html, { baseline, preset }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "changelog-reading-level-"));
  try {
    fs.writeFileSync(path.join(dir, "changelog.html"), html);
    // `readable-or-else check` exits 1 when the ratchet fails — that's the verdict we're
    // asking for, not a broken invocation, so a non-zero exit is read from `error.stdout`
    // the same as a clean run's stdout rather than treated as a thrown failure.
    let out;
    try {
      out = execFileSync(
        "readable-or-else",
        ["check", "changelog.html", "--preset", preset, "--mode", "ratchet", "--baseline", path.resolve(baseline), "--format", "json"],
        { cwd: dir, encoding: "utf8" }
      );
    } catch (err) {
      if (err.stdout) out = err.stdout;
      else throw err;
    }
    return JSON.parse(out)[0];
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

export function formatRegressionMessage(result, entryText) {
  const delta = result.grade - result.baseline_grade;
  return (
    `::error::Changelog reading-level regression — merging this PR's harvested changelog ` +
    `entry would push changelog.html's grade from ${result.baseline_grade.toFixed(2)} to ` +
    `${result.grade.toFixed(2)} (+${delta.toFixed(2)}), past the committed baseline. ` +
    `Offending entry text: "${entryText}". Reword the "What this means for you" section ` +
    `into plainer, shorter sentences before merging.`
  );
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  for (const req of ["baseData", "baseHtml", "i18n", "bodyFile", "baseline"]) {
    if (!args[req]) {
      console.error(`missing required --${req.replace(/[A-Z]/g, (c) => "-" + c.toLowerCase())}`);
      process.exit(2);
    }
  }

  const baseDataJson = fs.readFileSync(args.baseData, "utf8");
  const baseHtml = fs.readFileSync(args.baseHtml, "utf8");
  const i18nSource = fs.readFileSync(args.i18n);
  const body = fs.readFileSync(args.bodyFile, "utf8");

  const sim = simulate({
    baseDataJson,
    baseHtml,
    i18nSource,
    number: args.number,
    url: args.url,
    mergedAt: args.mergedAt,
    body,
    labels: parseLabels(args.labels),
  });

  if (sim.reason === "not-major" || sim.reason === "no-marker") {
    console.log('This PR is not labeled "changelog:major" (or has no "What this means for you" section) — nothing to simulate.');
    return;
  }
  if (sim.reason === "already-recorded") {
    console.log(`PR #${args.number} is already recorded in the base changelog — nothing new to simulate.`);
    return;
  }

  const result = measureAgainstBaseline(sim.html, { baseline: args.baseline, preset: args.preset });

  if (result.status === "fail") {
    console.error(formatRegressionMessage(result, sim.text));
    process.exit(1);
  }

  console.log(
    `OK — simulated changelog.html grade ${result.grade.toFixed(2)} meets committed baseline ` +
      `${result.baseline_grade != null ? result.baseline_grade.toFixed(2) : "(none)"}.`
  );
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url))) {
  main();
}
