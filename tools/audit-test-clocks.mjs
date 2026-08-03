import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const TEST_PATH = /^(?:test|worker\/test)\/.*\.(?:js|mjs|cjs)$/;
const WALL_CLOCK = /\b(?:new\s+Date\s*\(\s*\)|Date\.now\s*\(\s*\))/;
const INJECTED_DEFAULT = /\b(?:now|clock|nowMs)\s*=\s*(?:new\s+Date\s*\(\s*\)|Date\.now\s*\(\s*\))/i;

export function findUninjectedClockAdditions(diff) {
  const findings = [];
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
      if (TEST_PATH.test(path) && WALL_CLOCK.test(source) && !INJECTED_DEFAULT.test(source)) {
        findings.push({ path, line: newLine, source: source.trim() });
      }
      newLine++;
    } else if (!line.startsWith("-")) {
      newLine++;
    }
  }
  return findings;
}

function git(...args) {
  return execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
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
  return findUninjectedClockAdditions(`${tracked}\n${untrackedTestDiff()}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const findings = auditTestClocks();
  assert.equal(
    findings.length,
    0,
    `new tests must use a fixed fixture clock and inject it into the code under test:\n${findings
      .map((finding) => `${finding.path}:${finding.line}: ${finding.source}`)
      .join("\n")}`,
  );
  console.log("test clock audit passed");
}
