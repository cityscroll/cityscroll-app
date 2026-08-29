#!/usr/bin/env node

import { readFileSync } from "node:fs";
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
  for (const [index, raw] of readFileSync(ALLOWLIST_PATH, "utf8").split(/\r?\n/).entries()) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    if (raw.includes(RESERVED_MARKER)) {
      throw new Error(`reserved content marker cannot be allowlisted at ${ALLOWLIST_RELATIVE_PATH}:${index + 1}`);
    }
    let [path, lineNumber, digest, ...comment] = raw.split("\t");
    const deferred = path?.startsWith("future:");
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
    entries.set(key, comment.join("\t").trim());
    if (deferred) deferredEntries.add(key);
  }
  return { entries, deferredEntries };
}

function trackedFiles() {
  const result = spawnSync("git", ["ls-files", "-co", "--exclude-standard", "-z"], {
    cwd: ROOT,
    encoding: "utf8",
  });
  if (result.status !== 0) throw new Error(result.stderr || "unable to enumerate repository files");
  return result.stdout.split("\0").filter(Boolean);
}

function main() {
  const { entries: allowed, deferredEntries } = loadAllowlist();
  const seen = new Set();
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
      const lineNumber = index + 1;
      const key = `${path}\0${lineNumber}\0${Buffer.from(line, "utf8").toString("base64")}`;
      const hashKey = `${path}\0${lineNumber}\0sha256:${createHash("sha256").update(line, "utf8").digest("hex")}`;
      const wildcardKey = `${path}\0*\0*`;
      const allowedKey = allowed.has(key) ? key : allowed.has(hashKey) ? hashKey : allowed.has(wildcardKey) ? wildcardKey : null;
      const allowlisted = Boolean(allowedKey);
      if (matches.includes("reserved content marker") || !allowlisted) {
        violations.push(`${path}:${lineNumber}: ${matches.join(", ")}: ${line.trim()}`);
      } else if (allowedKey) {
        seen.add(allowedKey);
      }
    });
  }
  const staleAllowlist = [...allowed.keys()].filter((key) => !seen.has(key) && !deferredEntries.has(key));
  if (staleAllowlist.length) violations.push(`${ALLOWLIST_RELATIVE_PATH}: stale entries: ${staleAllowlist.length}`);
  if (violations.length) {
    fail(violations.join("\n"));
    return;
  }
  console.log(`Legacy-name guard passed: ${occurrences} allowlisted occurrence(s).`);
}

try {
  main();
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}
