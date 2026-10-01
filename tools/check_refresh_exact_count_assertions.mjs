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
 * Default scan discovers every test file that loads a governed refreshed
 * artifact by content. architecture/refresh-exact-count-guard.json records
 * the empirical restamp set as provenance (which suites a real refresh
 * invalidated); that list stays covered but is not the scan allowlist.
 * Grow refreshed_site_data_artifacts only when a later refresh proves another
 * member.
 *
 *   node tools/check_refresh_exact_count_assertions.mjs
 *   node tools/check_refresh_exact_count_assertions.mjs --root <dir>
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
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

const SITE_DATA_PATH_RE = /site\/data\/[A-Za-z0-9_./-]+\.json/g;

function extractSiteDataPaths(text) {
  const out = [];
  SITE_DATA_PATH_RE.lastIndex = 0;
  let match;
  while ((match = SITE_DATA_PATH_RE.exec(text))) out.push(match[0]);
  return out;
}

/**
 * Identifiers bound to a governed refreshed artifact load. Path aliases
 * (join(ROOT, "site/data/...")) are followed one hop into JSON.parse/readJson
 * loads so `const land = JSON.parse(readFileSync(LAND_DEFAULT))` couples.
 * Count asserts must reference one of these bindings; otherwise a file that
 * merely loads a governed artifact would flag unrelated markup/source counts.
 */
export function refreshedLoadBindings(source, refreshedArtifacts) {
  const refreshedSet = new Set(refreshedArtifacts || []);
  const pathAliases = new Set();
  const bindings = new Set();
  const decl = /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*([^;]+);/g;
  let match;
  while ((match = decl.exec(source))) {
    const name = match[1];
    const rhs = match[2];
    const paths = extractSiteDataPaths(rhs);
    if (!paths.some((path) => refreshedSet.has(path))) continue;
    const loadsJson = /JSON\.parse|readJson\s*\(/.test(rhs);
    if (loadsJson) {
      bindings.add(name);
      continue;
    }
    // Path string / join / URL only — remember as alias for a later load.
    pathAliases.add(name);
  }
  decl.lastIndex = 0;
  while ((match = decl.exec(source))) {
    const name = match[1];
    const rhs = match[2];
    if (bindings.has(name)) continue;
    if (!/JSON\.parse|readJson\s*\(/.test(rhs)) continue;
    for (const alias of pathAliases) {
      if (new RegExp(`\\b${alias}\\b`).test(rhs)) {
        bindings.add(name);
        break;
      }
    }
  }
  return bindings;
}

function expressionReferencesBinding(expr, bindings) {
  for (const name of bindings) {
    if (new RegExp(`\\b${name}\\b`).test(expr)) return true;
  }
  return false;
}

export function scanSource(source, {
  relativePath,
  refreshedArtifacts,
  countPropertyPattern,
} = {}) {
  const loaded = loadsRefreshedArtifacts(source, refreshedArtifacts);
  if (!loaded.length) return [];

  const scanText = stripCommentsForScan(source);
  const bindings = refreshedLoadBindings(scanText, refreshedArtifacts);
  // Without a coupled binding, exact-count asserts in the file are treated as
  // unrelated (markup/source/constants). The direct probe shape always binds.
  if (!bindings.size) return [];

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
    if (!expressionReferencesBinding(expr, bindings)) continue;
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

const TEST_SCAN_ROOTS = ["test", "worker/test"];
const TEST_FILE_RE = /\.(?:mjs|cjs|js|py)$/;
const SKIP_DIR_NAMES = new Set(["node_modules", "fixtures", ".git", "__pycache__"]);
// Meta-tests embed live-load probe source as strings; scanning them is noise.
const SCAN_SKIP_FILES = new Set([
  "test/refresh_exact_count_guard.test.mjs",
]);

function walkTestFiles(rootDir, relativeRoot) {
  const absRoot = join(rootDir, relativeRoot);
  const out = [];
  function visit(dir) {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      const abs = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (SKIP_DIR_NAMES.has(entry.name)) continue;
        visit(abs);
        continue;
      }
      if (!entry.isFile() || !TEST_FILE_RE.test(entry.name)) continue;
      const rel = relative(rootDir, abs).replaceAll("\\", "/");
      if (rel.includes("/fixtures/")) continue;
      out.push({ absolute: abs, relative: rel });
    }
  }
  try {
    if (statSync(absRoot).isDirectory()) visit(absRoot);
  } catch {
    // Missing scan root (e.g. hermetic temp tree without worker/test).
  }
  return out;
}

/**
 * Discover every test file that loads a governed refreshed site/data artifact.
 * Content-based: a new file that imports a governed path is scanned without
 * being listed in empirical_starting_set.
 */
export function discoverGovernedTestFiles(policy, rootDir = ROOT) {
  const refreshedArtifacts = policy?.scope?.refreshed_site_data_artifacts || [];
  const discovered = [];
  for (const scanRoot of TEST_SCAN_ROOTS) {
    for (const target of walkTestFiles(rootDir, scanRoot)) {
      if (SCAN_SKIP_FILES.has(target.relative)) continue;
      let source;
      try {
        source = readFileSync(target.absolute, "utf8");
      } catch {
        continue;
      }
      if (loadsRefreshedArtifacts(source, refreshedArtifacts).length) {
        discovered.push(target);
      }
    }
  }
  return discovered.sort((a, b) => a.relative.localeCompare(b.relative));
}

/**
 * Empirical restamp provenance files — always covered, even if a load-pattern
 * miss would omit them from content discovery.
 */
export function empiricalProvenanceFiles(policy, rootDir = ROOT) {
  const listed = policy?.empirical_starting_set?.test_files || [];
  return listed.map((rel) => ({
    absolute: resolve(rootDir, rel),
    relative: rel.replaceAll("\\", "/"),
  }));
}

/** @deprecated Prefer discoverGovernedTestFiles; kept as alias for callers. */
export function scopedTestFiles(policy, rootDir = ROOT) {
  return defaultScanTargets(policy, rootDir);
}

export function defaultScanTargets(policy, rootDir = ROOT) {
  const byRel = new Map();
  for (const target of [
    ...discoverGovernedTestFiles(policy, rootDir),
    ...empiricalProvenanceFiles(policy, rootDir),
  ]) {
    byRel.set(target.relative, target);
  }
  return [...byRel.values()].sort((a, b) => a.relative.localeCompare(b.relative));
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
    : defaultScanTargets(policy, rootDir);

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
  const scanned = defaultScanTargets(policy, options.rootDir);
  const findings = scanRepository({
    rootDir: options.rootDir,
    policy,
    files: scanned.map((target) => target.absolute),
  });
  const scannedCount = scanned.length;
  if (findings.length) {
    console.error(
      `refresh exact-count guard failed: scanned ${scannedCount} test file(s); ${findings.length} finding(s)`,
    );
    for (const finding of findings) console.error(`  ${formatFinding(finding, policy)}`);
    process.exitCode = 1;
    return;
  }
  console.log(
    `refresh exact-count guard OK — scanned ${scannedCount} test file(s) that load governed refreshed site/data; 0 exact-count asserts`,
  );
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
