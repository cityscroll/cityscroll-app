import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { isolatedGitEnv } from "./architecture_evidence_shards.mjs";

const TEST_PATH = /^(?:test|worker\/test)\/(?!fixtures\/).*\.(?:js|mjs|cjs)$/;
const WALL_CLOCK = /\b(?:new\s+(?:globalThis\.)?Date\s*\(\s*\)|(?:globalThis\.)?Date\.now\s*\(\s*\)|Temporal\.Now(?:\.[A-Za-z_$][\w$]*)?\s*\(|(?:todayISO|testClockISOString)\s*\()/;
const PINNED_CLOCK_IMPORT = /import\s+[\s\S]*?\bwithPinnedClock\b[\s\S]*?from\s*["'][^"']*helpers\/test_clock\.mjs["']/;
const EXPLICIT_CLOCK_INJECTION = /\b(?:now|clock|nowMs|clockMs)\s*(?=[,:})])/i;
const ALLOW_REAL_CLOCK = /(?:\/\/|\/\*)\s*test-clock:\s*allow-real-clock\b/i;
const RULE = "docs/testing.md#wall-clock-tests";

function isTestPath(path) {
  return TEST_PATH.test(path);
}

function lineFindings(path, source, onlyLines = null) {
  if (!isTestPath(path)) return [];
  const findings = [];
  for (const [index, line] of String(source || "").split("\n").entries()) {
    if (onlyLines && !onlyLines.has(index + 1)) continue;
    if (!WALL_CLOCK.test(line) || ALLOW_REAL_CLOCK.test(line)) continue;
    findings.push({ path, line: index + 1, source: line.trim() });
  }
  return findings;
}

function fileAllowsClock(source) {
  return PINNED_CLOCK_IMPORT.test(source) || EXPLICIT_CLOCK_INJECTION.test(source);
}

export function findUninjectedClockReads(path, source) {
  return fileAllowsClock(source) ? [] : lineFindings(path, source);
}

function changedLinesByPath(diff) {
  const changed = new Map();
  let path = null;
  let newLine = 0;

  for (const line of String(diff || "").split("\n")) {
    if (line.startsWith("+++ b/")) {
      path = line.slice(6);
      if (isTestPath(path) && !changed.has(path)) changed.set(path, new Set());
      continue;
    }
    const hunk = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)/);
    if (hunk) {
      newLine = Number(hunk[1]);
      continue;
    }
    if (!path || line.startsWith("--- ") || line.startsWith("diff --git ")) continue;
    if (line.startsWith("+")) {
      if (isTestPath(path)) changed.get(path)?.add(newLine);
      newLine++;
    } else if (!line.startsWith("-")) {
      newLine++;
    }
  }
  return changed;
}

export function findUninjectedClockAdditions(diff) {
  const findings = [];
  const sourceByPath = new Map();
  let path = null;
  let newLine = 0;

  for (const line of String(diff || "").split("\n")) {
    if (line.startsWith("+++ b/")) {
      path = line.slice(6);
      continue;
    }
    const hunk = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)/);
    if (hunk) {
      newLine = Number(hunk[1]);
      continue;
    }
    if (!path || line.startsWith("--- ") || line.startsWith("diff --git ")) continue;
    if (line.startsWith("+")) {
      const source = line.slice(1);
      if (isTestPath(path)) sourceByPath.set(path, `${sourceByPath.get(path) || ""}${source}\n`);
      if (isTestPath(path) && WALL_CLOCK.test(source) && !ALLOW_REAL_CLOCK.test(source)) {
        findings.push({ path, line: newLine, source: source.trim() });
      }
      newLine++;
    } else if (!line.startsWith("-")) {
      newLine++;
    }
  }
  return findings.filter(({ path: findingPath }) => !fileAllowsClock(sourceByPath.get(findingPath) || ""));
}

function git(...args) {
  return execFileSync("git", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    // The comparison base has to come from the checkout this audit is standing
    // in. A hook exports GIT_DIR, and inheriting it would resolve the merge base
    // in another repository — which silently changes which added lines are
    // audited at all.
    env: isolatedGitEnv(),
  }).trim();
}

function comparisonBase() {
  for (const ref of ["origin/main", "main"]) {
    try {
      return git("merge-base", "HEAD", ref);
    } catch {
      // Try the next conventional default-branch ref.
    }
  }
  try {
    return git("rev-parse", "HEAD^");
  } catch {
    return "HEAD";
  }
}

function untrackedTestDiff() {
  let paths = [];
  try {
    paths = git("ls-files", "--others", "--exclude-standard", "--", "test", "worker/test")
      .split("\n")
      .filter(Boolean)
      .filter((path) => TEST_PATH.test(path));
  } catch {
    return "";
  }
  return paths.map((path) => {
    const lines = readFileSync(path, "utf8").split("\n");
    return [`+++ b/${path}`, `@@ -0,0 +1,${lines.length} @@`, ...lines.map((line) => `+${line}`)].join("\n");
  }).join("\n");
}

export function auditTestClocks() {
  const base = comparisonBase();
  const tracked = git("diff", "--unified=0", "--no-color", base, "--", "test", "worker/test");
  const untracked = untrackedTestDiff();
  const diff = `${tracked}\n${untracked}`;
  const changed = changedLinesByPath(diff);
  const findings = [];

  for (const [path] of changed) {
    let source;
    try {
      source = readFileSync(path, "utf8");
    } catch {
      continue;
    }
    if (fileAllowsClock(source)) continue;
    findings.push(...lineFindings(path, source));
  }
  return findings;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const findings = auditTestClocks();
  assert.equal(
    findings.length,
    0,
    `changed tests must pin or explicitly inject wall-clock reads; see ${RULE}:\n${findings
      .map((finding) => `${finding.path}:${finding.line}: ${finding.source}`)
      .join("\n")}`,
  );
  console.log("test clock audit passed");
}
