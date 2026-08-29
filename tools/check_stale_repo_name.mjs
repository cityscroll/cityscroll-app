#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const ALLOWLIST_PATH = join(ROOT, ".github", "legacy-name-allowlist.txt");
const GUARD_PATH = relative(ROOT, fileURLToPath(import.meta.url));
const ALLOWLIST_RELATIVE_PATH = relative(ROOT, ALLOWLIST_PATH);
const LEGACY_RE = new RegExp(["crol", "[-_]?", "list"].join(""), "i");

function fail(message) {
  console.error(`Legacy-name guard failed: ${message}`);
  process.exitCode = 1;
}

function loadAllowlist() {
  const entries = new Map();
  for (const [index, raw] of readFileSync(ALLOWLIST_PATH, "utf8").split(/\r?\n/).entries()) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    let [path, lineNumber, digest, ...comment] = raw.split("\t");
    if (path?.startsWith("path64:")) {
      try {
        path = Buffer.from(path.slice("path64:".length), "base64").toString("utf8");
      } catch {
        path = "";
      }
    }
    if (!path || (!/^\d+$/.test(lineNumber || "") && lineNumber !== "*") || (lineNumber !== "*" && !/^[A-Za-z0-9+/]+={0,2}$/.test(digest || "")) || (lineNumber === "*" && digest !== "*") || !comment.join("\t").trim()) {
      throw new Error(`malformed allowlist entry at ${ALLOWLIST_RELATIVE_PATH}:${index + 1}`);
    }
    entries.set(`${path}\0${lineNumber}\0${digest}`, comment.join("\t").trim());
  }
  return entries;
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
  const allowed = loadAllowlist();
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
      if (!LEGACY_RE.test(line)) return;
      occurrences += 1;
      const lineNumber = index + 1;
      const key = `${path}\0${lineNumber}\0${Buffer.from(line, "utf8").toString("base64")}`;
      const wildcardKey = `${path}\0*\0*`;
      if (allowed.has(key)) seen.add(key);
      else if (allowed.has(wildcardKey)) seen.add(wildcardKey);
      else violations.push(`${path}:${lineNumber}: ${line.trim()}`);
    });
  }
  const staleAllowlist = [...allowed.keys()].filter((key) => !seen.has(key));
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
