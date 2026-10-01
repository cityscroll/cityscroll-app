#!/usr/bin/env node
/**
 * Fail closed when a refresh-sensitive test asserts an exact population count
 * against live refreshed site/data. Scheduled first-class refresh rewrites
 * those artifacts; exact pins force hand-restamping and block unattended merges.
 *
 * Permitted shapes:
 *   1. fixture-pin — load from test/fixtures/ and keep exact asserts
 *   2. refresh-invariant — a property that survives refresh and still fails on
 *      an empty or incoherent population
 *
 * Scope starts as the empirical restamp set from the scheduled refresh that
 * proved which suites break; grow architecture/refresh-exact-count-guard.json
 * only when a later refresh proves another member.
 *
 *   node tools/check_refresh_exact_count_assertions.mjs
 *   node tools/check_refresh_exact_count_assertions.mjs --root <dir>
 */

import { readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const POLICY_PATH = "architecture/refresh-exact-count-guard.json";

const ASSERT_EQUAL_RE =
  /\bassert\.(?:equal|strictEqual)\s*\(\s*([^,]+?)\s*,\s*(\d+)\s*(?:,|\))/g;

const LOAD_PATTERNS = [
  /(?:readFileSync|readFile|readJson|requireJson|loadJson)\s*\(\s*(?:new\s+URL\(\s*)?['"`]([^'"`]+)['"`]/g,
  /\bread\s*\(\s*['"`]((?:(?:\.\.\/)+)?site\/data\/[^'"`]+\.json)['"`]\s*\)/g,
  /new\s+URL\(\s*['"`]((?:(?:\.\.\/)+)?site\/data\/[^'"`]+\.json)['"`]/g,
  /(?:path\.join|join)\(\s*ROOT\s*,\s*['"`](site\/data\/[^'"`]+\.json)['"`]\s*\)/g,
  /=\s*['"`]((?:(?:\.\.\/)+)?site\/data\/[^'"`]+\.json)['"`]/g,
];

const EXCLUDED_EXPR_RE = /(?:digest|sha256|hash|hex|status|viewport|width|height)/i;

export function loadPolicy(rootDir = ROOT) {
  return JSON.parse(readFileSync(join(rootDir, POLICY_PATH), "utf8"));
}

function normalizeSiteDataPath(raw) {
  const text = String(raw || "").replaceAll("\\", "/");
  const idx = text.indexOf("site/data/");
  if (idx < 0) return null;
  return text.slice(idx).split(/[?#]/)[0];
}

function lineNumberAt(source, index) {
  let line = 1;
  for (let i = 0; i < index && i < source.length; i += 1) {
    if (source[i] === "\n") line += 1;
  }
  return line;
}

function stripCommentsForScan(source) {
  // Strip only comments. Leaving string/regex literals intact avoids mistaking
  // quotes inside /.../ character classes for string openers (which would blank
  // the rest of the file and hide later asserts).
  let out = "";
  let i = 0;
  const n = source.length;
  while (i < n) {
    const c = source[i];
    const next = source[i + 1];
    if (c === "/" && next === "/") {
      out += "  ";
      i += 2;
      while (i < n && source[i] !== "\n") {
        out += " ";
        i += 1;
      }
      continue;
    }
    if (c === "/" && next === "*") {
      out += "  ";
      i += 2;
      while (i < n && !(source[i] === "*" && source[i + 1] === "/")) {
        out += source[i] === "\n" ? "\n" : " ";
        i += 1;
      }
      if (i < n) {
        out += "  ";
        i += 2;
      }
      continue;
    }
    out += c;
    i += 1;
  }
  return out;
}

export function loadsRefreshedArtifacts(source, refreshedArtifacts) {
  const refreshedSet = new Set(refreshedArtifacts || []);
  const loaded = new Set();
  for (const re of LOAD_PATTERNS) {
    re.lastIndex = 0;
    let match;
    while ((match = re.exec(source))) {
      const normalized = normalizeSiteDataPath(match[1]);
      if (normalized && refreshedSet.has(normalized)) loaded.add(normalized);
    }
  }
  // Builder path constants imported into tests (PAYLOAD_JSON / RECEIPT_JSON).
  if (
    /readFileSync\s*\(\s*new\s+URL\(\s*`[^`]*\$\{(?:PAYLOAD_JSON|RECEIPT_JSON)\}/.test(source)
    && /land_project_map_points/.test(source)
  ) {
    for (const artifact of refreshedSet) {
      if (artifact.includes("land_project_map_points")) loaded.add(artifact);
    }
  }
  return [...loaded].sort();
}

function countLikeExpression(expr, countPropertyPattern) {
  if (EXCLUDED_EXPR_RE.test(expr)) return false;
  const re = new RegExp(`\\b${countPropertyPattern}\\b`, "i");
  return re.test(expr);
}

export function scanSource(source, {
  relativePath,
  refreshedArtifacts,
  countPropertyPattern,
} = {}) {
  const loaded = loadsRefreshedArtifacts(source, refreshedArtifacts);
  if (!loaded.length) return [];

  const scanText = stripCommentsForScan(source);
  const findings = [];
  ASSERT_EQUAL_RE.lastIndex = 0;
  let match;
  while ((match = ASSERT_EQUAL_RE.exec(scanText))) {
    const expr = match[1].trim();
    const literal = Number(match[2]);
    // Exactly-zero empty-state checks are refresh-stable invariants (a required
    // absence), not population pins that move when publishers roll.
    if (literal === 0) continue;
    if (!countLikeExpression(expr, countPropertyPattern)) continue;
    findings.push({
      file: relativePath,
      line: lineNumberAt(source, match.index),
      expression: expr.replace(/\s+/g, " "),
      literal,
      loaded_artifacts: loaded,
    });
  }
  return findings;
}

export function scopedTestFiles(policy, rootDir = ROOT) {
  const listed = policy?.empirical_starting_set?.test_files || [];
  return listed.map((rel) => ({
    absolute: resolve(rootDir, rel),
    relative: rel.replaceAll("\\", "/"),
  }));
}

export function scanRepository({
  rootDir = ROOT,
  policy = loadPolicy(rootDir),
  files = null,
} = {}) {
  const refreshedArtifacts = policy?.scope?.refreshed_site_data_artifacts || [];
  const countPropertyPattern = policy?.count_property_pattern
    || "(?:count|length|total|size|appearances|matter_count|references|universe)";
  const targets = files
    ? files.map((abs) => ({
      absolute: resolve(abs),
      relative: relative(rootDir, resolve(abs)).replaceAll("\\", "/"),
    }))
    : scopedTestFiles(policy, rootDir);

  const findings = [];
  for (const target of targets) {
    let source;
    try {
      source = readFileSync(target.absolute, "utf8");
    } catch {
      findings.push({
        file: target.relative,
        line: 1,
        expression: "<missing file>",
        literal: 0,
        loaded_artifacts: [],
        missing: true,
      });
      continue;
    }
    findings.push(...scanSource(source, {
      relativePath: target.relative,
      refreshedArtifacts,
      countPropertyPattern,
    }));
  }
  return findings.sort((a, b) =>
    a.file === b.file ? a.line - b.line : a.file.localeCompare(b.file));
}

export function formatFinding(finding, policy = null) {
  if (finding.missing) {
    return `${finding.file}: scoped refresh-sensitive test file is missing`;
  }
  const shapes = (policy?.permitted_shapes || []).map((shape) =>
    `${shape.id}: ${shape.summary}`);
  const permitted = shapes.length
    ? shapes.join(" | ")
    : "fixture-pin (load test/fixtures/) | refresh-invariant (property that survives refresh)";
  return `${finding.file}:${finding.line}: exact-count assertion ${finding.expression} == ${finding.literal} reads refreshed site/data (${finding.loaded_artifacts.join(", ")}). `
    + `Replace it with one of the two permitted shapes — ${permitted}`;
}

export function checkRepository(options = {}) {
  const rootDir = options.rootDir || ROOT;
  const policy = options.policy || loadPolicy(rootDir);
  return scanRepository({ ...options, rootDir, policy }).map((finding) =>
    formatFinding(finding, policy));
}

function parseArgs(argv) {
  const options = { rootDir: ROOT };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--root") options.rootDir = resolve(argv[++i]);
  }
  return options;
}

function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  const policy = loadPolicy(options.rootDir);
  const findings = scanRepository({ rootDir: options.rootDir, policy });
  if (findings.length) {
    console.error(`refresh exact-count guard failed: ${findings.length} finding(s)`);
    for (const finding of findings) console.error(`  ${formatFinding(finding, policy)}`);
    process.exitCode = 1;
    return;
  }
  console.log("refresh exact-count guard OK — 0 exact-count asserts on refreshed site/data in the scoped suite");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
