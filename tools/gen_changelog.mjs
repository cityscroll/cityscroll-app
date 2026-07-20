#!/usr/bin/env node
// tools/gen_changelog.mjs — regenerates changelog.html's "Recent updates" list from
// changelog-data.json, and (given --number/--url/--merged-at/--body-file/--labels) first
// tries to add a new entry extracted from a merged PR's body.
//
// Two call shapes:
//   node tools/gen_changelog.mjs --number 34 --url <html_url> --merged-at 2026-07-15 \
//     --body-file /tmp/pr-body.md --labels "changelog:major,enhancement"
//     Extracts the PR's "## What this means for you" line (changelog_extract.mjs), but only
//     when the PR also carries the `changelog:major` label (see changelog_extract.mjs's
//     header comment for why the marker section alone stopped being a significance signal).
//     No label, or a label but no marker section -> prints a message and exits 0 (this is
//     the expected, common case, not a failure). Already-recorded PR number -> no-op
//     (idempotent, safe to re-run). Otherwise prepends the entry to changelog-data.json and
//     rewrites the HTML block.
//   node tools/gen_changelog.mjs --rebuild
//     Rewrites changelog.html's HTML block from the current changelog-data.json only —
//     useful after a hand-edit to the data file, or to verify the two files agree.
//
// changelog-data.json is the source of truth; the HTML block is a full rebuild every time
// (never hand-patched), so the two can never drift out of sync with each other.
//
// Every rebuild also re-stamps changelog.html's i18n.js?v=<hash8> cache-skew guard from
// whichever i18n.js is actually checked out (see restampI18nVersion below) — the workflow's
// bot branch carries its changelog.html forward run to run, so without this a merged PR
// that changed i18n.js after the bot branch last ran could strand the stamp on a stale hash
// indefinitely.

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { extractUserImpact, hasMajorLabel } from "./changelog_extract.mjs";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const DATA_PATH = path.join(ROOT, "changelog-data.json");
const HTML_PATH = path.join(ROOT, "changelog.html");
const I18N_PATH = path.join(ROOT, "i18n.js");
const START_MARKER = "<!-- CHANGELOG:AUTO:START -->";
const END_MARKER = "<!-- CHANGELOG:AUTO:END -->";
const I18N_VERSION_RE = /(src="i18n\.js\?v=)[0-9a-f]{8}(")/g;

function parseArgs(argv) {
  const out = { rebuild: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--rebuild") out.rebuild = true;
    else if (a === "--number") out.number = Number(argv[++i]);
    else if (a === "--url") out.url = argv[++i];
    else if (a === "--merged-at") out.mergedAt = argv[++i];
    else if (a === "--body-file") out.bodyFile = argv[++i];
    else if (a === "--labels") out.labels = argv[++i];
  }
  return out;
}

function loadData() {
  if (!fs.existsSync(DATA_PATH)) return { _comment: "", entries: [] };
  return JSON.parse(fs.readFileSync(DATA_PATH, "utf8"));
}

function saveData(data) {
  fs.writeFileSync(DATA_PATH, JSON.stringify(data, null, 2) + "\n");
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function toCalVer(dateStr) {
  // "2026-07-14" -> "2026.07.14" — matches the site's existing dated-release headings.
  return dateStr.replace(/-/g, ".");
}

// The bot branch's changelog.html is carried forward from run to run (see the workflow's
// "regeneration base" step), so a stale i18n.js?v= stamp — left behind whenever some other
// merged PR bumped i18n.js after the bot branch last regenerated — would otherwise survive
// indefinitely, since nothing else in this file ever touches that stamp. Recomputing it
// from whatever i18n.js is actually checked out, on every regeneration, makes that class of
// staleness impossible: the stamp can never drift from the tree the generator just ran in.
export function i18nVersionHash(i18nSource) {
  return crypto.createHash("sha256").update(i18nSource).digest("hex").slice(0, 8);
}

export function restampI18nVersion(html, i18nSource) {
  const hash = i18nVersionHash(i18nSource);
  return html.replace(I18N_VERSION_RE, `$1${hash}$2`);
}

export function renderEntries(entries) {
  if (!entries.length) return "";
  return entries
    .map(
      (e) =>
        `    <li><time datetime="${escapeHtml(e.merged_at)}">${toCalVer(
          escapeHtml(e.merged_at)
        )}</time> — ${escapeHtml(e.text)}</li>`
    )
    .join("\n");
}

// Pure: rebuilds the CHANGELOG:AUTO block of an in-memory changelog.html string from a
// given entries list, re-stamping the i18n.js?v= cache-skew guard from a given i18n.js
// source. Split out of rewriteHtml() (below) so a caller that isn't regenerating the real
// checked-out files — the pre-merge reading-level simulation (crol-changelogprose-k8) — can
// reuse the identical rendering logic against files it supplies itself, with no risk of the
// two ever drifting apart.
export function buildHtml(html, entries, i18nSource) {
  const startIdx = html.indexOf(START_MARKER);
  const endIdx = html.indexOf(END_MARKER);
  if (startIdx === -1 || endIdx === -1 || endIdx < startIdx) {
    throw new Error(`changelog.html is missing ${START_MARKER}/${END_MARKER} markers`);
  }
  const before = html.slice(0, startIdx + START_MARKER.length);
  const after = html.slice(endIdx);
  const body = entries.length ? `\n${renderEntries(entries)}\n  ` : "\n  ";
  return restampI18nVersion(before + body + after, i18nSource);
}

function rewriteHtml(entries) {
  const src = fs.readFileSync(HTML_PATH, "utf8");
  const rebuilt = buildHtml(src, entries, fs.readFileSync(I18N_PATH));
  fs.writeFileSync(HTML_PATH, rebuilt);
}

// Splits a comma-separated --labels value (as GitHub Actions' `join(labels.*.name, ',')`
// produces) back into a plain array. Tolerant of a missing/empty value (no labels).
export function parseLabels(raw) {
  if (!raw) return [];
  return String(raw)
    .split(",")
    .map((l) => l.trim())
    .filter(Boolean);
}

// Pure: given the current entries list and a candidate PR's body + labels, decides whether
// it adds a new entry — reused by both the real post-merge CLI (main(), below) and the
// pre-merge simulation script (tools/check_changelog_reading_level.mjs) so "what counts as
// harvestable" can never drift between the two call sites.
export function computeEntryAddition(entries, { number, url, mergedAt, body, labels }) {
  if (entries.some((e) => e.pr === number)) {
    return { entries, text: null, reason: "already-recorded" };
  }
  if (!hasMajorLabel(labels)) {
    return { entries, text: null, reason: "not-major" };
  }
  const text = extractUserImpact(body);
  if (!text) {
    return { entries, text: null, reason: "no-marker" };
  }
  const entry = { pr: number, merged_at: (mergedAt || "").slice(0, 10), url: url || "", text };
  return { entries: [entry, ...entries], text, reason: "added" };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const data = loadData();
  data.entries = data.entries || [];

  if (!args.rebuild) {
    if (!args.number || !args.bodyFile) {
      console.error("usage: gen_changelog.mjs --number N --url URL --merged-at DATE --body-file FILE");
      console.error("   or: gen_changelog.mjs --rebuild");
      process.exit(1);
    }
    const body = fs.readFileSync(args.bodyFile, "utf8");
    const result = computeEntryAddition(data.entries, {
      number: args.number,
      url: args.url,
      mergedAt: args.mergedAt,
      body,
      labels: parseLabels(args.labels),
    });
    if (result.reason === "already-recorded") {
      console.log(`PR #${args.number} already recorded — no-op.`);
      return;
    }
    if (result.reason === "not-major") {
      console.log(`PR #${args.number} carries no "changelog:major" label — skipped.`);
      return;
    }
    if (result.reason === "no-marker") {
      console.log(`PR #${args.number} is labeled "changelog:major" but carries no "What this means for you" section — skipped.`);
      return;
    }
    data.entries = result.entries;
    saveData(data);
    console.log(`PR #${args.number} added: ${result.text}`);
  }

  rewriteHtml(data.entries);
  console.log(`changelog.html regenerated — ${data.entries.length} entr${data.entries.length === 1 ? "y" : "ies"}.`);
}

// Only run as a CLI when invoked directly (`node tools/gen_changelog.mjs ...`) — importing
// this module for its pure helpers (restampI18nVersion/i18nVersionHash, from tests) must not
// also trigger a real regeneration run. realpathSync on both sides (not a raw string
// compare) because argv[1] can be an unresolved symlink path (e.g. macOS's /tmp ->
// /private/tmp) that would otherwise never equal import.meta.url's resolved path.
if (process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url))) {
  main();
}
