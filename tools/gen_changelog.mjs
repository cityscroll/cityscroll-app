#!/usr/bin/env node
// tools/gen_changelog.mjs — regenerates changelog.html's "Recent updates" list from
// changelog-data.json, and (given --number/--url/--merged-at/--body-file) first tries to
// add a new entry extracted from a merged PR's body.
//
// Two call shapes:
//   node tools/gen_changelog.mjs --number 34 --url <html_url> --merged-at 2026-07-15 \
//     --body-file /tmp/pr-body.md
//     Extracts the PR's "## What this means for you" line (changelog_extract.mjs). No
//     marker section -> prints a message and exits 0 (plumbing PRs are expected to lack
//     one; this is not a failure). Already-recorded PR number -> no-op (idempotent, safe
//     to re-run). Otherwise prepends the entry to changelog-data.json and rewrites the
//     HTML block.
//   node tools/gen_changelog.mjs --rebuild
//     Rewrites changelog.html's HTML block from the current changelog-data.json only —
//     useful after a hand-edit to the data file, or to verify the two files agree.
//
// changelog-data.json is the source of truth; the HTML block is a full rebuild every time
// (never hand-patched), so the two can never drift out of sync with each other.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { extractUserImpact } from "./changelog_extract.mjs";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const DATA_PATH = path.join(ROOT, "changelog-data.json");
const HTML_PATH = path.join(ROOT, "changelog.html");
const START_MARKER = "<!-- CHANGELOG:AUTO:START -->";
const END_MARKER = "<!-- CHANGELOG:AUTO:END -->";

function parseArgs(argv) {
  const out = { rebuild: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--rebuild") out.rebuild = true;
    else if (a === "--number") out.number = Number(argv[++i]);
    else if (a === "--url") out.url = argv[++i];
    else if (a === "--merged-at") out.mergedAt = argv[++i];
    else if (a === "--body-file") out.bodyFile = argv[++i];
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

function renderEntries(entries) {
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

function rewriteHtml(entries) {
  const src = fs.readFileSync(HTML_PATH, "utf8");
  const startIdx = src.indexOf(START_MARKER);
  const endIdx = src.indexOf(END_MARKER);
  if (startIdx === -1 || endIdx === -1 || endIdx < startIdx) {
    throw new Error(`changelog.html is missing ${START_MARKER}/${END_MARKER} markers`);
  }
  const before = src.slice(0, startIdx + START_MARKER.length);
  const after = src.slice(endIdx);
  const body = entries.length ? `\n${renderEntries(entries)}\n  ` : "\n  ";
  fs.writeFileSync(HTML_PATH, before + body + after);
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
    if (data.entries.some((e) => e.pr === args.number)) {
      console.log(`PR #${args.number} already recorded — no-op.`);
      return;
    }
    const body = fs.readFileSync(args.bodyFile, "utf8");
    const text = extractUserImpact(body);
    if (!text) {
      console.log(`PR #${args.number} carries no "What this means for you" section — not user-facing, skipped.`);
      return;
    }
    const mergedAt = (args.mergedAt || "").slice(0, 10);
    data.entries.unshift({ pr: args.number, merged_at: mergedAt, url: args.url || "", text });
    saveData(data);
    console.log(`PR #${args.number} added: ${text}`);
  }

  rewriteHtml(data.entries);
  console.log(`changelog.html regenerated — ${data.entries.length} entr${data.entries.length === 1 ? "y" : "ies"}.`);
}

main();
