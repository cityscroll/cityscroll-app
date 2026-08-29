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
const LEGACY_RE = new RegExp(["crol", "[-_]?", "list"].join(""), "i");
const BANNED_VOCABULARY_RE = /kraken/i;
const RESERVED_MARKER = "card-seal:5rk8-qj2m-xv91";

function fail(message) {
  console.error(`Legacy-name guard failed: ${message}`);
  process.exitCode = 1;
}

function loadAllowlist() {
  const entries = new Map();
  const deferredEntries = new Set();
  const records = [];
  const header = [];
  let inHeader = true;
  for (const [index, raw] of readFileSync(ALLOWLIST_PATH, "utf8").split(/\r?\n/).entries()) {
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
    if (raw.includes(RESERVED_MARKER)) {
      throw new Error(`reserved content marker cannot be allowlisted at ${ALLOWLIST_RELATIVE_PATH}:${index + 1}`);
    }
    let [encodedPath, lineNumber, digest, ...comment] = raw.split("\t");
    const deferred = encodedPath?.startsWith("future:");
    let path = encodedPath;
    if (deferred) path = path.slice("future:".length);
    if (path?.startsWith("path64:")) {
      try {
        path = Buffer.from(path.slice("path64:".length), "base64").toString("utf8");
      } catch {
        path = "";
      }
    }
    if (!path || (!/^\d+$/.test(lineNumber || "") && lineNumber !== "*") || (lineNumber !== "*" && !/^(?:[A-Za-z0-9+/]+={0,2}|sha256:[a-f0-9]{64})$/.test(digest || "")) || (lineNumber === "*" && digest !== "*") || !comment.join("\t").trim()) {
      throw new Error(`malformed allowlist entry at ${ALLOWLIST_RELATIVE_PATH}:${index + 1}`);
    }
    const key = `${path}\0${lineNumber}\0${digest}`;
    const record = {
      key,
      path,
      encodedPath,
      lineNumber,
      digest,
      comment: comment.join("\t").trim(),
      deferred,
    };
    entries.set(key, record.comment);
    records.push(record);
    if (deferred) deferredEntries.add(key);
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

function digestIndex(records) {
  const byDigest = new Map();
  for (const record of records) {
    if (record.lineNumber === "*") continue;
    const digestKey = `${record.path}\0${record.digest}`;
    if (!byDigest.has(digestKey)) byDigest.set(digestKey, []);
    byDigest.get(digestKey).push(record);
  }
  return byDigest;
}

function rewriteAllowlist({ header, records, seenRecords, remapped }) {
  const kept = new Set();
  const lines = header.length ? [...header] : [
    "# Every entry is path + exact line number + base64 of the exact line + a reason comment.",
    "# The encoded line makes an allowed exception narrow: moving, changing, or adding a",
    "# matching line requires an explicit review and a new allowlist entry.",
  ];
  for (const record of records) {
    if (record.deferred) {
      lines.push(`${record.encodedPath}\t${record.lineNumber}\t${record.digest}\t${record.comment}`);
      continue;
    }
    const next = remapped.get(record.key) || (seenRecords.has(record.key) ? record : null);
    if (!next) continue;
    const emittedKey = `${next.path}\0${next.lineNumber}\0${next.digest}`;
    if (kept.has(emittedKey) && next.lineNumber !== "*") continue;
    kept.add(emittedKey);
    lines.push(`${next.encodedPath}\t${next.lineNumber}\t${next.digest}\t${next.comment}`);
  }
  writeFileSync(ALLOWLIST_PATH, `${lines.join("\n")}\n`);
}

function main() {
  const write = process.argv.includes("--write");
  const { entries: allowed, deferredEntries, records, header } = loadAllowlist();
  const byDigest = digestIndex(records);
  const seen = new Set();
  const seenRecords = new Set();
  const remapped = new Map();
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
    source.split(/\r?\n/).forEach((line, index) => {
      const matches = [];
      if (LEGACY_RE.test(line)) matches.push("legacy repository name");
      if (BANNED_VOCABULARY_RE.test(line)) matches.push("banned vocabulary");
      if (line.includes(RESERVED_MARKER)) matches.push("reserved content marker");
      if (!matches.length) return;
      occurrences += matches.length;
      const lineNumber = String(index + 1);
      const key = `${path}\0${lineNumber}\0${Buffer.from(line, "utf8").toString("base64")}`;
      const hashKey = `${path}\0${lineNumber}\0sha256:${createHash("sha256").update(line, "utf8").digest("hex")}`;
      const wildcardKey = `${path}\0*\0*`;
      let allowedKey = allowed.has(key) ? key : allowed.has(hashKey) ? hashKey : allowed.has(wildcardKey) ? wildcardKey : null;
      if (!allowedKey) {
        for (const digest of [Buffer.from(line, "utf8").toString("base64"), `sha256:${createHash("sha256").update(line, "utf8").digest("hex")}`]) {
          const candidates = byDigest.get(`${path}\0${digest}`) || [];
          const record = candidates.find((item) => !item.deferred);
          if (record) {
            allowedKey = record.key;
            remapped.set(record.key, { ...record, lineNumber });
            break;
          }
        }
      }
      const allowlisted = Boolean(allowedKey);
      if (matches.includes("reserved content marker") || !allowlisted) {
        violations.push(`${path}:${lineNumber}: ${matches.join(", ")}: ${line.trim()}`);
      } else if (allowedKey) {
        seen.add(allowedKey);
        seenRecords.add(allowedKey);
      }
    });
  }
  const staleAllowlist = [...allowed.keys()].filter((key) => !seen.has(key) && !deferredEntries.has(key) && !remapped.has(key));
  if (!write && staleAllowlist.length) violations.push(`${ALLOWLIST_RELATIVE_PATH}: stale entries: ${staleAllowlist.length}`);
  if (violations.length) {
    fail(violations.join("\n"));
    return;
  }
  if (write) {
    rewriteAllowlist({ header, records, seenRecords, remapped });
    console.log(`Legacy-name allowlist rewritten: dropped ${staleAllowlist.length} stale entr${staleAllowlist.length === 1 ? "y" : "ies"}; remapped ${remapped.size}.`);
    return;
  }
  console.log(`Legacy-name guard passed: ${occurrences} allowlisted occurrence(s).`);
}

try {
  main();
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}
