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

function requireText(value, path) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${path} must be a non-empty string`);
}

function requireInteger(value, path, min = 1) {
  if (!Number.isInteger(value) || value < min) throw new Error(`${path} must be an integer >= ${min}`);
}

function validateAssetPath(value, path, entry, extensions) {
  requireText(value, path);
  const prefix = `media/changelog/pr-${entry.pr}/`;
  if (!value.startsWith(prefix) || value.includes("..") || value.startsWith("/")) {
    throw new Error(`${path} must stay under ${prefix}`);
  }
  const ext = value.split(".").pop().toLowerCase();
  if (!extensions.includes(ext)) throw new Error(`${path} must use ${extensions.join(" or ")}`);
}

function validateLocalizedText(value, path) {
  requireText(value, path);
  if (!/^[a-z][a-z0-9_]*$/.test(value)) throw new Error(`${path} must be an i18n key`);
}

// Optional entry.media schema. Keeping validation next to the generator means hand edits,
// automated rebuilds, and the pre-merge reading-level simulation all accept the same shape.
export function validateEntries(entries) {
  if (!Array.isArray(entries)) throw new Error("entries must be an array");
  for (const [index, entry] of entries.entries()) {
    // A consolidated entry (several related merged PRs told as one story) carries its full
    // provenance in merged_prs, INCLUDING the entry's own primary `pr` — see entryCoversPr()
    // and AGENTS.md's changelog section for why this exists (the bot's own dedupe check reads
    // this list so a folded-in PR is never re-added as a duplicate entry on a later run).
    if (Object.hasOwn(entry, "merged_prs")) {
      const at = `entries[${index}].merged_prs`;
      if (!Array.isArray(entry.merged_prs) || entry.merged_prs.length < 2) {
        throw new Error(`${at} must be an array of at least two {pr, url} entries`);
      }
      for (const [i, ref] of entry.merged_prs.entries()) {
        requireInteger(ref.pr, `${at}[${i}].pr`, 1);
        requireText(ref.url, `${at}[${i}].url`);
      }
      if (!entry.merged_prs.some((ref) => ref.pr === entry.pr)) {
        throw new Error(`${at} must include the entry's own primary pr (${entry.pr})`);
      }
    }
    if (!Object.hasOwn(entry, "media")) continue;
    const at = `entries[${index}].media`;
    if (!entry.media || typeof entry.media !== "object" || Array.isArray(entry.media)) {
      throw new Error(`${at} must be an object`);
    }
    const { screenshots, recording } = entry.media;
    if (screenshots !== undefined && (!Array.isArray(screenshots) || screenshots.length === 0)) {
      throw new Error("media.screenshots must contain at least one before/after pair");
    }
    if (!screenshots && !recording) throw new Error(`${at} must include screenshots or recording`);

    for (const [pairIndex, pair] of (screenshots || []).entries()) {
      const pairAt = `${at}.screenshots[${pairIndex}]`;
      requireInteger(pair.viewport, `${pairAt}.viewport`, 200);
      requireInteger(pair.width, `${pairAt}.width`, 1);
      requireInteger(pair.height, `${pairAt}.height`, 1);
      for (const side of ["before", "after"]) {
        const image = pair[side];
        if (!image || typeof image !== "object" || Array.isArray(image)) {
          throw new Error(`${pairAt}.${side} must be an object`);
        }
        validateAssetPath(image.src, `${pairAt}.${side}.src`, entry, ["png", "webp", "jpg", "jpeg"]);
        requireText(image.alt, `${pairAt}.${side}.alt`);
        validateLocalizedText(image.alt_i18n, `${pairAt}.${side}.alt_i18n`);
      }
    }

    if (recording !== undefined) {
      const recordingAt = `${at}.recording`;
      if (!recording || typeof recording !== "object" || Array.isArray(recording)) {
        throw new Error(`${recordingAt} must be an object`);
      }
      validateAssetPath(recording.src, `${recordingAt}.src`, entry, ["webm", "mp4"]);
      validateAssetPath(recording.poster, `${recordingAt}.poster`, entry, ["png", "webp", "jpg", "jpeg"]);
      requireInteger(recording.width, `${recordingAt}.width`, 1);
      requireInteger(recording.height, `${recordingAt}.height`, 1);
      requireText(recording.caption, `${recordingAt}.caption`);
      validateLocalizedText(recording.caption_i18n, `${recordingAt}.caption_i18n`);
    }
  }
  return entries;
}

function renderLocalizedText(tag, text, key) {
  return `<${tag} data-i18n="${escapeHtml(key)}">${escapeHtml(text)}</${tag}>`;
}

function renderMedia(entry) {
  const media = entry.media;
  if (!media) return "";
  const screenshots = (media.screenshots || []).map((pair) => {
    const renderSide = (side, labelKey, label) => {
      const image = pair[side];
      return `        <figure class="chg-media-shot">
          <a href="${escapeHtml(image.src)}"><img src="${escapeHtml(image.src)}" width="${pair.width}" height="${pair.height}" loading="lazy" decoding="async" alt="${escapeHtml(image.alt)}" data-i18n-alt="${escapeHtml(image.alt_i18n)}"></a>
          <figcaption><strong data-i18n="${labelKey}">${label}</strong>${renderLocalizedText("span", image.alt, image.alt_i18n)}</figcaption>
        </figure>`;
    };
    const headingId = `chg-media-pr-${entry.pr}-${pair.viewport}`;
    return `      <section class="chg-media-pair" aria-labelledby="${headingId}">
        <h3 id="${headingId}"><span data-i18n="chg_media_viewport">Viewport</span> ${pair.viewport} px</h3>
        <div class="chg-media-grid">
${renderSide("before", "chg_media_before", "Before")}
${renderSide("after", "chg_media_after", "After")}
        </div>
      </section>`;
  }).join("\n");
  const recording = media.recording ? `      <figure class="chg-media-recording">
        <video controls preload="none" playsinline width="${media.recording.width}" height="${media.recording.height}" poster="${escapeHtml(media.recording.poster)}">
          <source src="${escapeHtml(media.recording.src)}" type="video/${media.recording.src.toLowerCase().endsWith(".mp4") ? "mp4" : "webm"}">
          ${renderLocalizedText("span", "Your browser cannot play this video.", "chg_media_video_fallback")}
        </video>
        <figcaption><strong data-i18n="chg_media_recording">Screen recording</strong>${renderLocalizedText("span", media.recording.caption, media.recording.caption_i18n)}</figcaption>
      </figure>` : "";
  return `
    <div class="chg-media" aria-label="Before-and-after feature media" data-i18n-aria="chg_media_visual_aria">
${screenshots}${screenshots && recording ? "\n" : ""}${recording}
    </div>`;
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
  validateEntries(entries);
  if (!entries.length) return "";
  return entries
    .map((e) => {
      const copy = `<time datetime="${escapeHtml(e.merged_at)}">${toCalVer(
        escapeHtml(e.merged_at)
      )}</time> — ${escapeHtml(e.text)}`;
      if (!e.media) return `    <li>${copy}</li>`;
      return `    <li class="chg-entry chg-entry--media"><div class="chg-entry-copy">${copy}</div>${renderMedia(e)}
    </li>`;
    })
    .join("\n");
}

// Pure: rebuilds the CHANGELOG:AUTO block of an in-memory changelog.html string from a
// given entries list, re-stamping the i18n.js?v= cache-skew guard from a given i18n.js
// source. Split out of rewriteHtml() (below) so a caller that isn't regenerating the real
// checked-out files — the pre-merge reading-level simulation — can
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

// True when a PR number is already accounted for by an entry — either as that entry's own
// primary `pr` or folded into a consolidated entry's `merged_prs` (see validateEntries above).
// Without the second check, merging related entries into one story would make the bot
// re-add a "new" entry for every PR number that consolidation absorbed the next time this
// function runs.
function entryCoversPr(entry, number) {
  if (entry.pr === number) return true;
  return Array.isArray(entry.merged_prs) && entry.merged_prs.some((ref) => ref.pr === number);
}

// Pure: given the current entries list and a candidate PR's body + labels, decides whether
// it adds a new entry — reused by both the real post-merge CLI (main(), below) and the
// pre-merge simulation script (tools/check_changelog_reading_level.mjs) so "what counts as
// harvestable" can never drift between the two call sites.
export function computeEntryAddition(entries, { number, url, mergedAt, body, labels }) {
  if (entries.some((e) => entryCoversPr(e, number))) {
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
