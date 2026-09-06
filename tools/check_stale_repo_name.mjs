#!/usr/bin/env node

import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const ALLOWLIST_PATH = join(ROOT, ".github", "legacy-name-allowlist.txt");
const GUARD_PATH = relative(ROOT, fileURLToPath(import.meta.url));
const ALLOWLIST_RELATIVE_PATH = relative(ROOT, ALLOWLIST_PATH);
// Paths whose whole-file exemption may be added in the same change that edits
// them. The classification inventory was the only member, and it needed one only
// for the private-term rule this guard no longer carries.
const SAME_CHANGE_WILDCARD_PATHS = new Set([]);
const LEGACY_RE = new RegExp(["crol", "[-_]?", "list"].join(""), "i");
// Private development identifiers are deliberately NOT listed here. A committed
// denylist would publish the very name it exists to keep out, so that half of the
// boundary lives in tools/private_identifier_scan.mjs, which takes its term set
// from an owner-controlled input outside this repository.
const RESERVED_MARKER = "card-seal:5rk8-qj2m-xv91";
const DIGEST_RE = /^(?:[A-Za-z0-9+/]+={0,2}|sha256:[a-f0-9]{64})$/;
const COUNT_RE = /^count=([1-9]\d*)$/;

const DEFAULT_HEADER = [
  "# Each entry is path + base64 of the exact line + a reason comment.",
  "# Matching is content-addressed inside that file: the pinned line may move",
  "# without an allowlist edit. Line numbers are not part of the key and are not",
  "# stored; they never decide the verdict.",
  "# If the same line appears more than once, the entry must declare count=N",
  "# (N >= 2) so an added copy of a pinned line still fails.",
  "#",
  "# Fields (tab-separated):",
  "#   <path> <digest> # reason",
  "#   <path> <digest> count=N # reason",
  "#   <path> * # whole-file exemption",
  "# A `future:` path prefix means the line is absent from the current tree",
  "# (stale-entry bookkeeping only); it does not skip the growth rule.",
  "#",
  "# Growth rule (tools/check_stale_repo_name.mjs): a new entry is only valid for",
  "# content that already exists at the merge-base of main. A change cannot add a",
  "# banned line and the entry that covers it in the same PR. The `future:` prefix",
  "# no longer exempts an entry from that rule: it used to let an entry pre-allow",
  "# content that did not exist anywhere yet, which is exactly the self-certifying",
  "# gap PR 1417 exploited (new files, new lines, and matching allowlist entries",
  "# added together). `future:` now only means \"this line is not in my current",
  "# tree\" for stale-entry bookkeeping; the line must still already be present on",
  "# main's merge-base or the entry is rejected. A wildcard entry (digest `*`)",
  "# exempts a whole file, so a new one is only valid when the change leaves that",
  "# file completely untouched: its content at the merge-base must be",
  "# byte-identical to its current content.",
];

function fail(message) {
  console.error(`Legacy-name guard failed: ${message}`);
  process.exitCode = 1;
}

function identityKey(record) {
  if (record.wildcard) return `${record.path}\0*\0*`;
  return `${record.path}\0${record.digest}\0count=${record.count}`;
}

function decodeAllowlistPath(encodedPath) {
  const deferred = encodedPath?.startsWith("future:");
  let path = encodedPath || "";
  if (deferred) path = path.slice("future:".length);
  const storedEncodedPath = path;
  if (path.startsWith("path64:")) {
    try {
      path = Buffer.from(path.slice("path64:".length), "base64").toString("utf8");
    } catch {
      path = "";
    }
  }
  return { deferred, path, storedEncodedPath };
}

function parseAllowlistEntry(raw, index, sourceLabel = ALLOWLIST_RELATIVE_PATH) {
  if (raw.includes(RESERVED_MARKER)) {
    throw new Error(`reserved content marker cannot be allowlisted at ${sourceLabel}:${index + 1}`);
  }
  const fields = raw.split("\t");
  const encodedPath = fields[0];
  const { deferred, path, storedEncodedPath } = decodeAllowlistPath(encodedPath);
  const field1 = fields[1] || "";
  const field2 = fields[2] || "";
  let wildcard = false;
  let digest = "";
  let count = 1;
  let commentParts;
  let format = "new";

  if (field1 === "*" && field2 === "*") {
    format = "old";
    wildcard = true;
    digest = "*";
    commentParts = fields.slice(3);
  } else if (/^\d+$/.test(field1) && DIGEST_RE.test(field2)) {
    format = "old";
    digest = field2;
    commentParts = fields.slice(3);
  } else if (field1 === "*") {
    wildcard = true;
    digest = "*";
    commentParts = fields.slice(2);
  } else if (DIGEST_RE.test(field1)) {
    digest = field1;
    if (COUNT_RE.test(field2)) {
      count = Number(field2.slice("count=".length));
      commentParts = fields.slice(3);
    } else {
      commentParts = fields.slice(2);
    }
  } else {
    throw new Error(`malformed allowlist entry at ${sourceLabel}:${index + 1}`);
  }

  const comment = commentParts.join("\t").trim();
  if (!path || !comment || (wildcard && count !== 1) || (!wildcard && !DIGEST_RE.test(digest))) {
    throw new Error(`malformed allowlist entry at ${sourceLabel}:${index + 1}`);
  }
  if (!wildcard && count < 1) {
    throw new Error(`malformed allowlist entry at ${sourceLabel}:${index + 1}`);
  }
  const record = {
    path,
    encodedPath: storedEncodedPath,
    digest,
    count,
    comment,
    deferred,
    wildcard,
    format,
  };
  record.key = identityKey(record);
  return record;
}

function collapseRecords(records, sourceLabel = ALLOWLIST_RELATIVE_PATH) {
  const groups = new Map();
  for (const record of records) {
    if (record.wildcard) {
      const wildKey = `${record.deferred ? "future:" : ""}${record.path}\0*`;
      if (groups.has(wildKey)) {
        throw new Error(`duplicate wildcard allowlist entry for ${record.path} in ${sourceLabel}`);
      }
      groups.set(wildKey, [record]);
      continue;
    }
    const groupKey = `${record.deferred ? "future:" : ""}${record.path}\0${record.digest}`;
    if (!groups.has(groupKey)) groups.set(groupKey, []);
    groups.get(groupKey).push(record);
  }
  const result = [];
  const seen = new Set();
  for (const record of records) {
    if (record.wildcard) {
      result.push(record);
      continue;
    }
    const groupKey = `${record.deferred ? "future:" : ""}${record.path}\0${record.digest}`;
    if (seen.has(groupKey)) continue;
    seen.add(groupKey);
    const group = groups.get(groupKey);
    const formats = new Set(group.map((item) => item.format));
    if (formats.has("new") && group.length > 1) {
      throw new Error(`duplicate content pin for ${record.path} in ${sourceLabel}; declare a single count=N entry`);
    }
    if (formats.has("old") && formats.has("new")) {
      throw new Error(`mixed old and new allowlist formats for ${record.path} in ${sourceLabel}`);
    }
    let count = group[0].count;
    if (formats.has("old")) {
      // Old line-number pins: live duplicates are real repeated lines, so the
      // expected count is the number of pins. Deferred duplicates were
      // alternative line placements for one expected occurrence.
      count = record.deferred ? 1 : group.length;
    }
    const next = { ...group[0], count };
    next.key = identityKey(next);
    result.push(next);
  }
  return result;
}

export function parseAllowlistText(text, sourceLabel = ALLOWLIST_RELATIVE_PATH) {
  const records = [];
  const header = [];
  let inHeader = true;
  for (const [index, raw] of text.split(/\r?\n/).entries()) {
    const line = raw.trim();
    if (!line) {
      if (inHeader) header.push(raw);
      continue;
    }
    if (line.startsWith("#")) {
      if (inHeader) header.push(raw);
      continue;
    }
    inHeader = false;
    records.push(parseAllowlistEntry(raw, index, sourceLabel));
  }
  return { header, records: collapseRecords(records, sourceLabel) };
}

function loadAllowlist() {
  const { header, records } = parseAllowlistText(readFileSync(ALLOWLIST_PATH, "utf8"));
  const entries = new Map();
  const deferredEntries = new Set();
  for (const record of records) {
    entries.set(record.key, record.comment);
    if (record.deferred) deferredEntries.add(record.key);
  }
  return { entries, deferredEntries, records, header };
}

function trackedFiles() {
  const result = spawnSync("git", ["ls-files", "-co", "--exclude-standard", "-z"], {
    cwd: ROOT,
    encoding: "utf8",
  });
  if (result.status !== 0) throw new Error(result.stderr || "unable to enumerate repository files");
  return result.stdout.split("\0").filter(Boolean);
}

// Growth guard: an allowlist entry is only legitimate for content that already
// existed on the merge-base of main. Without this, a single PR can add both a
// banned line and the allowlist entry that covers it, self-certifying its own
// exception. See docs comment above ALLOWLIST_PATH's header for the full rule.
function resolveMergeBase(baseSha) {
  const result = spawnSync("git", ["merge-base", "HEAD", baseSha], { cwd: ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (result.status !== 0) return null;
  return result.stdout.trim() || null;
}

function readFileAtRevision(rev, path) {
  const result = spawnSync("git", ["show", `${rev}:${path}`], { cwd: ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (result.status !== 0) return null;
  return result.stdout;
}

function parseAllowlistKeys(text) {
  if (text === null) return new Set();
  const { records } = parseAllowlistText(text, `${ALLOWLIST_RELATIVE_PATH}@base`);
  return new Set(records.map((record) => record.key));
}

function lineDigests(line) {
  return {
    b64: Buffer.from(line, "utf8").toString("base64"),
    sha: `sha256:${createHash("sha256").update(line, "utf8").digest("hex")}`,
  };
}

function lineDigestMatches(line, digest) {
  const pair = lineDigests(line);
  return digest === pair.b64 || digest === pair.sha;
}

function countMatchingLines(lines, digest) {
  return lines.filter((line) => lineDigestMatches(line, digest)).length;
}

function entryContentExistsAtMergeBase(record, mergeBase, baseFileLinesCache) {
  if (record.wildcard) {
    // A wildcard entry exempts the whole file, so it is only legitimate for a
    // file this change does not touch at all: the merge-base content must be
    // byte-identical to the current content, not merely present.
    const baseText = readFileAtRevision(mergeBase, record.path);
    if (baseText === null) return false;
    let currentText;
    try {
      currentText = readFileSync(join(ROOT, record.path), "utf8");
    } catch {
      return false;
    }
    return baseText === currentText;
  }
  if (!baseFileLinesCache.has(record.path)) {
    const text = readFileAtRevision(mergeBase, record.path);
    baseFileLinesCache.set(record.path, text === null ? null : text.split(/\r?\n/));
  }
  const baseLines = baseFileLinesCache.get(record.path);
  if (!baseLines) return false;
  return countMatchingLines(baseLines, record.digest) >= record.count;
}

function checkAllowlistGrowth(records, baseSha) {
  const mergeBase = resolveMergeBase(baseSha);
  if (!mergeBase) {
    return { ok: false, reason: `unable to resolve a merge-base with ${baseSha}; cannot validate allowlist growth` };
  }
  const baseKeys = parseAllowlistKeys(readFileAtRevision(mergeBase, ALLOWLIST_RELATIVE_PATH));
  const added = records.filter(
    (record) => !baseKeys.has(record.key)
      && !(record.wildcard && SAME_CHANGE_WILDCARD_PATHS.has(record.path)),
  );
  const baseFileLinesCache = new Map();
  const invalid = added.filter((record) => !entryContentExistsAtMergeBase(record, mergeBase, baseFileLinesCache));
  return { ok: true, mergeBase, added, invalid };
}

function printAllowlistGrowthSummary(added) {
  const filesCovered = new Set(added.map((record) => record.path));
  const banner = "=".repeat(72);
  console.log(banner);
  console.log(
    `ALLOWLIST GROWTH: ${added.length} new entr${added.length === 1 ? "y" : "ies"} added, covering ${filesCovered.size} file${filesCovered.size === 1 ? "" : "s"}`,
  );
  for (const record of added) {
    const countLabel = !record.wildcard && record.count > 1 ? ` count=${record.count}` : "";
    console.log(`  + ${record.path}${countLabel}  ${record.comment}`);
  }
  console.log(banner);
}

function pinIndex(records) {
  const byPath = new Map();
  for (const record of records) {
    if (!byPath.has(record.path)) byPath.set(record.path, { wildcard: null, pins: new Map() });
    const entry = byPath.get(record.path);
    if (record.wildcard) {
      entry.wildcard = record;
      continue;
    }
    entry.pins.set(record.digest, record);
    if (!record.digest.startsWith("sha256:")) {
      try {
        const line = Buffer.from(record.digest, "base64").toString("utf8");
        entry.pins.set(lineDigests(line).sha, record);
      } catch {
        // Keep the stored digest as the only lookup key.
      }
    }
  }
  return byPath;
}

export function formatAllowlistRecord(record) {
  const pathField = `${record.deferred ? "future:" : ""}${record.encodedPath}`;
  if (record.wildcard) return `${pathField}\t*\t${record.comment}`;
  if (record.count > 1) return `${pathField}\t${record.digest}\tcount=${record.count}\t${record.comment}`;
  return `${pathField}\t${record.digest}\t${record.comment}`;
}

export function renderAllowlistFile(header, records) {
  const lines = header.length ? [...header] : [...DEFAULT_HEADER];
  for (const record of records) lines.push(formatAllowlistRecord(record));
  return `${lines.join("\n")}\n`;
}

export { DEFAULT_HEADER };

function rewriteAllowlist({ header, records, seenRecords, observedCounts }) {
  const kept = new Set();
  const lines = header.length ? [...header] : DEFAULT_HEADER;
  for (const record of records) {
    if (record.deferred) {
      const emitted = formatAllowlistRecord(record);
      if (kept.has(record.key)) continue;
      kept.add(record.key);
      lines.push(emitted);
      continue;
    }
    if (!seenRecords.has(record.key)) continue;
    const observed = observedCounts.get(record.key) || 0;
    const next = observed > 0 && observed !== record.count ? { ...record, count: observed } : record;
    next.key = identityKey(next);
    if (kept.has(next.key) && !next.wildcard) continue;
    kept.add(next.key);
    lines.push(formatAllowlistRecord(next));
  }
  writeFileSync(ALLOWLIST_PATH, `${lines.join("\n")}\n`);
}

function main() {
  const write = process.argv.includes("--write");
  const { entries: allowed, deferredEntries, records, header } = loadAllowlist();
  const byPath = pinIndex(records);
  const seen = new Set();
  const seenRecords = new Set();
  const observedCounts = new Map();
  const violations = [];
  let occurrences = 0;
  for (const path of trackedFiles()) {
    if (path === GUARD_PATH || path === ALLOWLIST_RELATIVE_PATH) continue;
    let source;
    try {
      source = readFileSync(join(ROOT, path), "utf8");
    } catch {
      continue;
    }
    const pathPins = byPath.get(path);
    source.split(/\r?\n/).forEach((line, index) => {
      const matches = [];
      if (LEGACY_RE.test(line)) matches.push("legacy repository name");
      if (line.includes(RESERVED_MARKER)) matches.push("reserved content marker");
      if (!matches.length) return;
      occurrences += matches.length;
      const lineNumber = String(index + 1);
      if (matches.includes("reserved content marker")) {
        violations.push(`${path}:${lineNumber}: ${matches.join(", ")}: ${line.trim()}`);
        return;
      }
      if (pathPins?.wildcard) {
        seen.add(pathPins.wildcard.key);
        seenRecords.add(pathPins.wildcard.key);
        return;
      }
      const pair = lineDigests(line);
      const pin = pathPins?.pins.get(pair.b64) || pathPins?.pins.get(pair.sha) || null;
      if (!pin) {
        violations.push(`${path}:${lineNumber}: ${matches.join(", ")}: ${line.trim()}`);
        return;
      }
      const used = (observedCounts.get(pin.key) || 0) + 1;
      observedCounts.set(pin.key, used);
      if (used > pin.count) {
        violations.push(`${path}:${lineNumber}: ${matches.join(", ")}: ${line.trim()}`);
        return;
      }
      seen.add(pin.key);
      seenRecords.add(pin.key);
    });
  }
  const staleAllowlist = [...allowed.keys()].filter((key) => {
    if (deferredEntries.has(key)) return false;
    const record = records.find((item) => item.key === key);
    if (!record) return !seen.has(key);
    if (record.wildcard) return !seen.has(key);
    const observed = observedCounts.get(key) || 0;
    return observed < record.count;
  });
  if (!write && staleAllowlist.length) violations.push(`${ALLOWLIST_RELATIVE_PATH}: stale entries: ${staleAllowlist.length}`);

  const baseSha = process.env.LEGACY_ALLOWLIST_BASE_SHA?.trim();
  if (!write && baseSha) {
    const growth = checkAllowlistGrowth(records, baseSha);
    if (!growth.ok) {
      violations.push(`${ALLOWLIST_RELATIVE_PATH}: ${growth.reason}`);
    } else {
      if (growth.added.length) printAllowlistGrowthSummary(growth.added);
      for (const record of growth.invalid) {
        violations.push(
          `${ALLOWLIST_RELATIVE_PATH}: new entry for ${record.path} covers content that does not exist at the merge-base of main (${growth.mergeBase}); allowlisting only covers legacy lines already on main, never material introduced in the same change`,
        );
      }
    }
  }

  if (violations.length) {
    fail(violations.join("\n"));
    return;
  }
  if (write) {
    rewriteAllowlist({ header, records, seenRecords, observedCounts });
    console.log(`Legacy-name allowlist rewritten: dropped ${staleAllowlist.length} stale entr${staleAllowlist.length === 1 ? "y" : "ies"}.`);
    return;
  }
  console.log(`Legacy-name guard passed: ${occurrences} allowlisted occurrence(s).`);
}

const executedDirectly = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (executedDirectly) {
  try {
    main();
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
}
