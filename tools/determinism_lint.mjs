#!/usr/bin/env node

/**
 * Check-mode determinism lint.
 *
 * The lint starts at explicit `--check` commands in workflows which can run for
 * a pull request or merge group. It follows local JavaScript and shell helper
 * calls, then reports environmental inputs that can make a gate change result
 * without a source change. Schedule-only workflows are monitors, not merge
 * gates, and are intentionally reported separately.
 *
 * Check mode never writes a baseline, receipt, or generated artifact. A
 * finding may be waived only at the finding's line with a reasoned
 * `determinism-lint: allow|inject <category> ...` annotation. Write mode
 * (`--write-receipt`) is a separate command used only to refresh a committed
 * fixture receipt.
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { isolatedGitEnv } from "./architecture_evidence_shards.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SOURCE_EXTENSIONS = new Set([".cjs", ".js", ".mjs", ".py", ".sh"]);
const RECEIPT_SCHEMA = "cityscroll.determinism-lint.receipt.v1";
const SITE_INVENTORY_PATH = "architecture/site-production-determinism.json";
const SITE_INVENTORY_SCHEMA = "cityscroll.site-production-determinism.inventory.v1";
const SITE_MODULE_EXTENSIONS = new Set([".cjs", ".js", ".mjs"]);

const RULES = Object.freeze([
  {
    category: "clock",
    pattern: /\bDate\.now\s*\(\s*\)|\bnew\s+Date\s*\(\s*\)|\bTemporal\.Now\b|\b(?:datetime|date|time)\.(?:now|today|utcnow)\s*\(/i,
    remediation: "inject a fixed clock/now value from the check fixture; do not read the ambient clock",
  },
  {
    category: "timezone",
    pattern: /\b(?:toLocaleDateString|toLocaleString|toLocaleTimeString|getTimezoneOffset)\s*\(|\bIntl\.DateTimeFormat\s*\(|\.(?:getHours|getMinutes|getDay|getMonth)\s*\(/,
    remediation: "format with an explicit UTC or named timeZone, or compare canonical timestamps",
  },
  {
    category: "random",
    pattern: /\bMath\.random\s*\(|\b(?:crypto\.)?randomUUID\s*\(|\bsecrets?\.token_bytes\s*\(/i,
    remediation: "inject a stable fixture seed or deterministic identifier",
  },
  {
    category: "network",
    pattern: /(?<![.\w])\bfetch\s*\(|\b(?:axios|got|request)\s*\(|\b(?:http|https)\.request\s*\(|\b(?:curl|wget)\b|\bgh\s+api\b|\bgit\s+fetch\b|\b(?:requests|urllib)\.(?:get|post|request)\s*\(/i,
    remediation: "read a checked-in fixture or inject a hermetic transport; move live sampling to a scheduled monitor",
  },
  {
    category: "external-data",
    pattern: /(?:^|[^\w-])(?:--from-(?:live|soda)|--against-live|--live)\b|\b(?:SODA|LIVE|PRODUCTION|EXTERNAL)_?(?:URL|DATA|ORIGIN)\b|\bprocess\.env\.[A-Z0-9_]*(?:URL|DATA|ORIGIN|LIVE|TODAY|DATE|TZ)[A-Z0-9_]*\b/i,
    remediation: "make the check consume a pinned local fixture or classify the live path as a non-gate monitor",
  },
  {
    category: "write",
    pattern: /\b(?:writeFile(?:Sync)?|appendFile(?:Sync)?|createWriteStream|mkdir(?:Sync)?|(?:rm|unlink)(?:Sync)?|rename(?:Sync)?)\s*\(|\bgit\s+(?:add|commit|push)\b/i,
    remediation: "separate write mode from --check and guard every mutation behind the non-check branch",
  },
]);

function relative(root, filePath) {
  return path.relative(root, filePath).split(path.sep).join("/");
}

function lineNumber(source, offset) {
  return source.slice(0, offset).split("\n").length;
}

function lineAt(source, line) {
  return source.split("\n")[line - 1] || "";
}

function stripCommentsPreservingLines(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, " "))
    .split("\n")
    .map((line) => line.replace(/(^|\s)(?:#|\/\/).*$/, (match, prefix) => `${prefix}${" ".repeat(Math.max(0, match.length - prefix.length))}`))
    .join("\n");
}

function explicitAllowance(source, line, category) {
  const annotation = /(?:\/\/|#)\s*determinism-lint\s*:\s*(?:allow|inject)\s+([a-z-]+)\b(.*)$/i;
  for (const candidate of [lineAt(source, line), lineAt(source, line - 1)]) {
    const match = candidate.match(annotation);
    if (match && match[1].toLowerCase() === category && match[2].trim()) return true;
  }
  return false;
}

function isInjectedClockLine(text) {
  const line = String(text || "");
  if (/\b(?:now|clock|asOf|observedOn|observed_at|nowMs)\s*=\s*(?:[^=\n]*\?\?|[^=\n]*\|\|)/.test(line) && /Date\.now|new\s+Date\s*\(\s*\)/.test(line)) {
    return true;
  }
  if (/\(\s*\{?\s*(?:[\w$]+\s*,\s*)*(?:now|clock|asOf|nowMs)\s*=\s*(?:Date\.now\s*\(\s*\)|new\s+Date\s*\(\s*\))/.test(line)) {
    return true;
  }
  return false;
}

function innermostIfCondition(source, offset) {
  let depth = 0;
  for (let index = offset; index >= 0; index -= 1) {
    const char = source[index];
    if (char === "}") depth += 1;
    else if (char === "{") {
      if (depth === 0) {
        const before = source.slice(Math.max(0, index - 240), index);
        const match = before.match(/if\s*\(([^)]*)\)\s*$/s);
        return match ? match[1].replace(/\s+/g, " ").trim() : null;
      }
      depth -= 1;
    }
  }
  return null;
}

function isCheckModeCondition(condition) {
  return /^(?:!?!\s*)?(?:args\.)?check(?:\s*===?\s*true)?$/.test(String(condition || "").trim());
}

function isWriteModeCondition(condition) {
  const value = String(condition || "").trim();
  if (!value) return false;
  if (/^!\s*(?:args\.)?check(?:\s*===?\s*true)?$/.test(value)) return true;
  if (/^(?:args\.)?(?:write|fromLive|fromSoda|live|bench)(?:\s*===?\s*true)?$/.test(value)) return true;
  if (/\b(?:args\.)?(?:write|fromLive|fromSoda)\b/.test(value) && !/\bcheck\b/.test(value)) return true;
  return false;
}

function isLiveOnlyCondition(condition) {
  const value = String(condition || "").trim();
  return /(?:args\.)?(?:fromLive|fromSoda|live)\b/.test(value) && !/\bcheck\b/.test(value);
}

function hasPriorCheckReturn(source, offset) {
  const before = source.slice(Math.max(0, offset - 1200), offset);
  return /\bif\s*\(\s*(?:args\.)?check\s*\)\s*\{[\s\S]*?\b(?:return|throw)\b[\s\S]*?\}\s*$/.test(before.trimEnd());
}

function shouldSkipFinding(rule, source, offset) {
  const line = lineNumber(source, offset);
  const text = lineAt(source, line);
  const condition = innermostIfCondition(source, offset);
  if (rule.category === "clock" && isInjectedClockLine(text)) return true;
  if (rule.category === "write") {
    if (isWriteModeCondition(condition)) return true;
    if (isCheckModeCondition(condition)) return false;
    if (hasPriorCheckReturn(source, offset)) return true;
  }
  if ((rule.category === "network" || rule.category === "external-data") && isLiveOnlyCondition(condition)) {
    return true;
  }
  return false;
}

function sourceFinding(root, filePath, source, rule, offset, command) {
  const line = lineNumber(source, offset);
  if (rule.category === "timezone") {
    const context = String(source || "").slice(Math.max(0, offset - 160), offset + 240);
    if (/\btimeZone\s*:/i.test(context)) return null;
    if (/\btoLocaleString\s*\(/.test(context) && !/\b(?:Date|date|time)\b/.test(context)) return null;
  }
  if (explicitAllowance(source, line, rule.category)) return null;
  if (shouldSkipFinding(rule, source, offset)) return null;
  return {
    category: rule.category,
    detector: rule.pattern.source,
    path: relative(root, filePath),
    line,
    source: lineAt(source, line).trim(),
    command: command || null,
    remediation: rule.remediation,
  };
}

export function analyzeSource({ root = ROOT, filePath, source, command = null } = {}) {
  assert.ok(filePath, "analyzeSource requires filePath");
  const findings = [];
  const code = stripCommentsPreservingLines(String(source || ""));
  for (const rule of RULES) {
    for (const match of code.matchAll(new RegExp(rule.pattern.source, rule.pattern.flags.includes("g") ? rule.pattern.flags : `${rule.pattern.flags}g`))) {
      const finding = sourceFinding(root, filePath, String(source || ""), rule, match.index, command);
      if (finding) findings.push(finding);
    }
  }
  return findings.sort((left, right) => left.line - right.line || left.category.localeCompare(right.category));
}

/*
 * Production-site scope.
 *
 * The workflow traversal above starts at `--check` commands, so it can only see
 * a module a gate happens to import. A module that ships to the public site is
 * not reachable that way, and `tools/audit-test-clocks.mjs` deliberately reads
 * only `test/` and `worker/test/`. A shipped `site/` module could therefore add
 * an ambient clock read and pass both. This scope closes that hole: every
 * JavaScript module under `site/` is inventoried, and the inventory is the unit
 * of coverage, so a new module fails the check until it is listed.
 *
 * The rule is about *visibility*, not about what the product may do. A resident
 * must keep being shown the real day, so a deliberate production clock stays
 * legal — it just has to say so at its own line.
 */

const SITE_RULES = Object.freeze([
  {
    category: "clock",
    pattern: /\bDate\.now\s*\(\s*\)|\bnew\s+Date\s*\(\s*\)|\bTemporal\.Now\b/,
    remediation:
      "take the instant from the caller (an explicit now/today/asOf argument the caller supplies), or declare the deliberate production clock at its own line with `determinism-lint: allow clock <reason>`",
  },
  {
    category: "timezone",
    pattern:
      /\.(?:getFullYear|getMonth|getDate|getDay|getHours|getMinutes|getSeconds|getTimezoneOffset|toLocaleDateString|toLocaleTimeString|toLocaleString)\s*\(|\bIntl\.DateTimeFormat\s*\(/,
    remediation:
      "read the UTC accessor (getUTCFullYear and siblings) or pass an explicit timeZone, or declare the reader-local rendering at its own line with `determinism-lint: allow timezone <reason>`",
  },
]);

/*
 * The names a caller-supplied instant is allowed to arrive under. The list is
 * deliberately a closed vocabulary: widening it is a reviewable edit, whereas
 * "any identifier" would let `const whatever = Date.now()` read as injection.
 */
const SITE_CLOCK_PARAMETERS =
  "(?:now|nowMs|nowISO|nowIso|clock|today|todayISO|todayIso|asOf|asOfISO|as_of|observedOn|observedAt|observed_at|observedISO|retrievedAt|retrieved_at|generatedAt|generated_at|materializedAt|materialized_at|reviewedAt|reviewed_at|currentDay|currentTime)";
const SITE_AMBIENT_CLOCK = "(?:Date\\.now\\s*\\(\\s*\\)|new\\s+Date\\s*\\(\\s*\\)|Temporal\\.Now\\b)";

/* A default value in a parameter list or a destructured options bag. */
const SITE_PARAMETER_DEFAULT = new RegExp(
  `(?:^|[(,{])\\s*${SITE_CLOCK_PARAMETERS}\\s*=\\s*${SITE_AMBIENT_CLOCK}`,
);
/* A named caller-supplied instant, used as a value rather than assigned one. */
const SITE_SUPPLIED_VALUE = new RegExp(`(?<![\\w$])(?<!Date\\.)${SITE_CLOCK_PARAMETERS}(?![\\w$])\\s*(?![:=][^=])`, "g");
/* The operators that put an expression in the arm taken only when nothing was supplied. */
const SITE_FALLBACK_OPERATOR = /\?\?|\|\||\?/g;
/*
 * `CROL_PINNED_TODAY` is a harness seam, not a caller-supplied clock: nothing
 * in the shipped product sets it, so the production arm of that expression is
 * still the ambient read. It must not be mistaken for injection.
 */
const SITE_HARNESS_PIN = /CROL_PINNED_TODAY|pinnedTodayISO/;

const SITE_DATE_FIELD = /\b(?:year|month|day|weekday|era|hour|minute|second|dateStyle|timeStyle|hourCycle|fractionalSecondDigits|timeZoneName)\s*:/;

function callArguments(source, offset) {
  const open = source.indexOf("(", offset);
  if (open < 0) return "";
  let depth = 0;
  for (let index = open; index < source.length; index += 1) {
    const char = source[index];
    if (char === "(") depth += 1;
    else if (char === ")") {
      depth -= 1;
      if (depth === 0) return source.slice(open + 1, index);
    }
  }
  return source.slice(open + 1);
}

function siteTimezoneFinding(source, offset) {
  const matched = source.slice(offset, offset + 64);
  const args = callArguments(source, offset);
  if (/\btimeZone\s*:/.test(args)) return false;
  /*
   * `toLocaleString` and `Intl.DateTimeFormat` are also the ordinary number and
   * currency formatters. Only a call that actually asks for date or time parts
   * is an implicit local-time read.
   */
  if (/\.toLocaleString\s*\(|Intl\.DateTimeFormat\s*\(/.test(matched) && !SITE_DATE_FIELD.test(args)) return false;
  return true;
}

/*
 * The statement the read sits in, so a binding written across several lines is
 * judged by its whole expression rather than by the fragment that happens to
 * carry the call.
 */
function siteEnclosingStatement(source, offset) {
  let start = 0;
  for (let index = offset - 1; index >= 0; index -= 1) {
    if (source[index] === ";" || source[index] === "{" || source[index] === "}") {
      start = index + 1;
      break;
    }
  }
  const lineEnd = source.indexOf("\n", offset);
  const end = lineEnd < 0 ? source.length : lineEnd;
  const prefix = source.slice(start, offset).replace(/\s+/g, " ");
  return { prefix, statement: `${prefix}${source.slice(offset, end)}`.replace(/\s+/g, " ") };
}

/*
 * A read counts as supplied at the boundary only when the caller can reach it:
 * either the read is the default of a named clock parameter, or a named
 * caller-supplied instant is consulted first and the read is the arm taken when
 * that instant is absent. Both shapes are visible in the expression itself, so
 * neither can be claimed by a comment.
 */
function siteClockSuppliedAtBoundary(source, offset) {
  const { prefix, statement } = siteEnclosingStatement(source, offset);
  if (SITE_HARNESS_PIN.test(statement)) return false;
  if (SITE_PARAMETER_DEFAULT.test(statement)) return true;
  const [first] = [...prefix.matchAll(SITE_SUPPLIED_VALUE)];
  if (!first) return false;
  for (const match of prefix.matchAll(SITE_FALLBACK_OPERATOR)) {
    if (match.index > first.index) return true;
  }
  return false;
}

/*
 * The declaration for one category, read from the finding's own line or from
 * the run of annotation comments directly above it. A line can carry more than
 * one kind of finding, so each category answers for itself.
 */
function siteAnnotation(source, line, category) {
  const annotation = /(?:\/\/|#)\s*determinism-lint\s*:\s*(allow|inject)\s+([a-z-]+)\b(.*)$/i;
  const read = (candidate) => {
    const match = String(candidate).match(annotation);
    if (!match || !match[3].trim()) return null;
    return { mode: match[1].toLowerCase(), category: match[2].toLowerCase() };
  };
  const own = read(lineAt(source, line));
  if (own && own.category === category) return own;
  for (let above = line - 1; above >= 1; above -= 1) {
    const declared = read(lineAt(source, above));
    if (!declared) break;
    if (declared.category === category) return declared;
  }
  return null;
}

export function analyzeSiteSource({ root = ROOT, filePath, source } = {}) {
  assert.ok(filePath, "analyzeSiteSource requires filePath");
  const original = String(source || "");
  const code = stripCommentsPreservingLines(original);
  const findings = [];
  for (const rule of SITE_RULES) {
    for (const match of code.matchAll(new RegExp(rule.pattern.source, "g"))) {
      const line = lineNumber(code, match.index);
      const text = lineAt(code, line);
      if (rule.category === "timezone" && !siteTimezoneFinding(code, match.index)) continue;
      const injected = rule.category === "clock" && siteClockSuppliedAtBoundary(code, match.index);
      if (injected) continue;
      const annotation = siteAnnotation(original, line, rule.category);
      if (annotation) {
        /*
         * An annotation is a declaration, never a mechanism. `inject` claims the
         * clock arrives from the caller, so it only holds when that arrival is
         * visible on the line; otherwise the claim itself is the finding.
         */
        if (annotation.mode === "allow") continue;
        findings.push({
          category: rule.category,
          detector: "annotation claims injection with no caller-supplied clock on the line",
          path: relative(root, filePath),
          line,
          source: lineAt(original, line).trim(),
          command: null,
          remediation:
            "`determinism-lint: inject` requires the instant to arrive from the caller on this line; supply it at the boundary or record a reasoned `determinism-lint: allow` instead",
        });
        continue;
      }
      findings.push({
        category: rule.category,
        detector: rule.pattern.source,
        path: relative(root, filePath),
        line,
        source: lineAt(original, line).trim(),
        command: null,
        remediation: rule.remediation,
      });
    }
  }
  const unique = new Map();
  for (const finding of findings) {
    const key = `${finding.category}\n${finding.line}`;
    if (!unique.has(key)) unique.set(key, finding);
  }
  return [...unique.values()].sort((left, right) => left.line - right.line || left.category.localeCompare(right.category));
}

/*
 * The modules a reduced working copy leaves unmaterialised. `site/` is tracked
 * in full, but a card profile may mark a path skip-worktree, and a filesystem
 * walk alone would then report a smaller site than the one that ships.
 */
function trackedSiteModules(root) {
  const git = (...args) => execFileSync("git", ["-C", root, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    // A hook exports GIT_DIR into everything the preflight runs. Inheriting it
    // would answer about the exported repository instead of `root`, and the
    // toplevel check below could not tell: with no work tree exported, that
    // resolves to `root` while `ls-files` reads the other index.
    env: isolatedGitEnv(),
  });
  try {
    // Only trust Git when `root` is the checkout itself; a fixture tree nested
    // inside this repository must not inherit the repository's own site/.
    const canonical = (value) => {
      try { return realpathSync(value); } catch { return path.resolve(value); }
    };
    if (canonical(git("rev-parse", "--show-toplevel").trim()) !== canonical(root)) return [];
    return git("ls-files", "--full-name", "--", "site")
      .split("\n")
      .map((entry) => entry.trim())
      .filter((entry) => SITE_MODULE_EXTENSIONS.has(path.extname(entry)));
  } catch {
    return [];
  }
}

/*
 * Every JavaScript module the public site can serve, taken from the shipped
 * tree rather than by following imports. Reachability would quietly drop a
 * module that only a dynamic import or an inline page script names; the tree
 * cannot hide one.
 */
export function discoverSiteModules({ root = ROOT, siteDir = path.join(root, "site") } = {}) {
  const modules = new Set(trackedSiteModules(root));
  const walk = (directory) => {
    let entries;
    try { entries = readdirSync(directory, { withFileTypes: true }); } catch { return; }
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(absolute);
      else if (entry.isFile() && SITE_MODULE_EXTENSIONS.has(path.extname(entry.name))) modules.add(relative(root, absolute));
    }
  };
  if (existsSync(siteDir)) walk(siteDir);
  return [...modules].sort((left, right) => left.localeCompare(right));
}

/* The committed contents of a path, for a module a reduced checkout omits. */
function committedSource(root, modulePath) {
  try {
    return execFileSync("git", ["-C", root, "show", `HEAD:${modulePath}`], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      env: isolatedGitEnv(),
    });
  } catch {
    return null;
  }
}

export function readSiteInventory({ root = ROOT, inventoryPath = SITE_INVENTORY_PATH } = {}) {
  const absolute = path.resolve(root, inventoryPath);
  if (!existsSync(absolute)) return null;
  try { return JSON.parse(readFileSync(absolute, "utf8")); } catch { return { malformed: true }; }
}

export function buildSiteInventory({ root = ROOT, previous = null } = {}) {
  const thirdParty = (previous?.third_party || []).filter((entry) => entry && typeof entry.path === "string");
  const excluded = new Set(thirdParty.map((entry) => entry.path));
  return {
    schema: SITE_INVENTORY_SCHEMA,
    modules: discoverSiteModules({ root }).filter((module) => !excluded.has(module)),
    third_party: [...thirdParty].sort((left, right) => left.path.localeCompare(right.path)),
  };
}

export function lintSiteProduction({ root = ROOT, inventoryPath = SITE_INVENTORY_PATH } = {}) {
  const inventory = readSiteInventory({ root, inventoryPath });
  const present = discoverSiteModules({ root });
  const issues = [];
  if (!inventory) {
    issues.push(`${inventoryPath} is missing; generate it with --write-site-inventory`);
    return { inventory: null, covered: [], unmaterialised: [], findings: [], issues };
  }
  if (inventory.malformed || inventory.schema !== SITE_INVENTORY_SCHEMA || !Array.isArray(inventory.modules)) {
    issues.push(`${inventoryPath} is not a valid ${SITE_INVENTORY_SCHEMA} document`);
    return { inventory: null, covered: [], unmaterialised: [], findings: [], issues };
  }
  const thirdParty = new Map(
    (Array.isArray(inventory.third_party) ? inventory.third_party : [])
      .filter((entry) => entry && typeof entry.path === "string")
      .map((entry) => [entry.path, entry]),
  );
  for (const [modulePath, entry] of thirdParty) {
    if (!entry.reason || !String(entry.reason).trim()) {
      issues.push(`${inventoryPath}: ${modulePath} is held outside the scan with no recorded reason`);
    }
  }
  const covered = inventory.modules.filter((module) => typeof module === "string");
  const declared = new Set([...covered, ...thirdParty.keys()]);
  for (const modulePath of present) {
    if (!declared.has(modulePath)) {
      issues.push(`${modulePath} ships from site/ but is not in ${inventoryPath}; add it with --write-site-inventory`);
    }
  }
  for (const modulePath of declared) {
    if (!present.includes(modulePath)) {
      issues.push(`${inventoryPath} lists ${modulePath}, which no longer ships from site/`);
    }
  }
  const findings = [];
  const unmaterialised = [];
  for (const modulePath of covered) {
    const absolute = path.resolve(root, modulePath);
    let source = null;
    if (existsSync(absolute)) source = readFileSync(absolute, "utf8");
    else {
      /*
       * A reduced working copy leaves some tracked modules unmaterialised. What
       * ships is still the committed blob, so read that rather than skipping a
       * module and reporting coverage the run did not have.
       */
      source = committedSource(root, modulePath);
      if (source == null) {
        issues.push(`${modulePath} is inventoried but neither materialised nor readable from HEAD; the scan cannot cover it`);
        continue;
      }
      unmaterialised.push(modulePath);
    }
    findings.push(...analyzeSiteSource({ root, filePath: absolute, source }));
  }
  return {
    inventory: { modules: covered, thirdParty: [...thirdParty.values()] },
    covered,
    unmaterialised,
    findings: findings.sort((left, right) => left.path.localeCompare(right.path) || left.line - right.line || left.category.localeCompare(right.category)),
    issues,
  };
}

function workflowEvents(contents) {
  const events = new Set();
  for (const line of contents.split("\n")) {
    const match = line.match(/^\s{2}(pull_request|merge_group|schedule)\s*:/);
    if (match) events.add(match[1]);
  }
  return events;
}

function workflowRunBlocks(contents) {
  const lines = contents.split("\n");
  const blocks = [];
  for (let index = 0; index < lines.length; index += 1) {
    const match = lines[index].match(/^(\s*)(?:-\s+)?run:\s*(.*)$/);
    if (!match) continue;
    const indent = match[1].length;
    const value = match[2];
    if (!/^[|>]([-+])?$/.test(value.trim())) {
      blocks.push({ text: value, line: index + 1 });
      continue;
    }
    const body = [];
    let cursor = index + 1;
    while (cursor < lines.length) {
      const bodyIndent = lines[cursor].match(/^(\s*)\S/)?.[1].length;
      if (bodyIndent == null || bodyIndent <= indent) break;
      body.push(lines[cursor]);
      cursor += 1;
    }
    blocks.push({ text: body.join("\n"), line: index + 1 });
    index = cursor - 1;
  }
  return blocks;
}

function hasCheckMode(text) {
  return /(?:^|\s)--check(?:\s|$)/.test(text) || /(?:^|\s)--gate(?:\s|$)/.test(text);
}

function workflowCommandFindings(root, filePath, block) {
  const source = block.text;
  const findings = analyzeSource({ root, filePath, source, command: `${relative(root, filePath)}:${block.line}` })
    .map((finding) => ({ ...finding, line: block.line + finding.line - 1 }));
  const absoluteLine = (offset) => block.line + String(source).slice(0, offset).split("\n").length - 1;
  const sourceLine = (offset) => String(source).split("\n")[String(source).slice(0, offset).split("\n").length - 1].trim();
  const add = (category, detector, remediation, offset) => findings.push({
    category,
    detector,
    path: relative(root, filePath),
    line: absoluteLine(offset),
    source: sourceLine(offset),
    command: `${relative(root, filePath)}:${block.line}`,
    remediation,
  });
  for (const match of source.matchAll(/\b(?:curl|wget)\b|\bgh\s+api\b|\bgit\s+fetch\b|https?:\/\/[^\s'"`]+/gi)) {
    add("network", "workflow live network/origin command", "read a checked-in fixture or move live sampling to a scheduled monitor", match.index);
  }
  for (const match of source.matchAll(/\bdate\s+(?!.*(?:-u|--utc))/gi)) {
    add("timezone", "workflow ambient date/time command", "use a fixed input or explicit UTC timestamp", match.index);
  }
  for (const match of source.matchAll(/(?:^|\s)(?:>>|>)\s*["'$A-Za-z_]/g)) {
    add("write", "workflow output redirection", "keep --check read-only and write only in a separate mode", match.index);
  }
  return findings;
}

function sourcePathCandidates(text) {
  const candidates = [];
  const matcher = /\b(?:node|nodejs|python3?|bash|sh)\s+(?:(?:--[^\s]+)\s+)*(\.?\/?[A-Za-z0-9_./-]+\.(?:mjs|cjs|js|py|sh))\b/g;
  for (const match of text.matchAll(matcher)) candidates.push({ path: match[1], offset: match.index });
  const direct = /(?:^|[\s;&|])((?:\.?\/?)(?:tools|worker\/scripts|test|worker\/test)\/[A-Za-z0-9_./*-]+\.(?:mjs|cjs|js|py|sh))/g;
  for (const match of text.matchAll(direct)) candidates.push({ path: match[1], offset: match.index });
  const unique = new Map(candidates.map((candidate) => [candidate.path, candidate]));
  return [...unique.values()];
}

function resolveSourcePath(root, candidate, baseDir = root) {
  const normalized = candidate.replace(/^\.\//, "");
  const absolute = path.resolve(baseDir, normalized);
  if (!absolute.startsWith(`${root}${path.sep}`) || !SOURCE_EXTENSIONS.has(path.extname(absolute))) return null;
  return absolute;
}

function resolveImportedPath(filePath, specifier) {
  if (!specifier.startsWith(".")) return null;
  const base = path.resolve(path.dirname(filePath), specifier);
  const candidates = [base, ...[".mjs", ".js", ".cjs"].map((extension) => `${base}${extension}`)];
  return candidates.find((candidate) => {
    try { return statSync(candidate).isFile(); } catch { return false; }
  }) || null;
}

function localDependencies(filePath, source) {
  const dependencies = [];
  if ([".mjs", ".js", ".cjs"].includes(path.extname(filePath))) {
    const imports = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s*)["']([^"']+)["']/g;
    for (const match of source.matchAll(imports)) {
      const target = resolveImportedPath(filePath, match[1]);
      if (target && isGateHelper(target)) dependencies.push(target);
    }
  }
  for (const candidate of sourcePathCandidates(source)) {
    const target = resolveImportedPath(filePath, candidate.path);
    if (target && isGateHelper(target)) dependencies.push(target);
  }
  return [...new Set(dependencies)];
}

function isGateHelper(filePath) {
  const normalized = filePath.split(path.sep).join("/");
  return /(?:^|\/)(?:tools|worker\/scripts|test\/standards|\.github\/actions)(?:\/|$)/.test(normalized);
}

function expandSourcePath(root, candidate, baseDir) {
  const absolute = resolveSourcePath(root, candidate, baseDir);
  if (!absolute && candidate.includes("*")) {
    const directory = path.dirname(path.resolve(baseDir, candidate));
    const pattern = new RegExp(`^${path.basename(candidate).replaceAll(".", "\\.").replace("*", ".*")}$`);
    try {
      return readdirSync(directory).filter((name) => pattern.test(name)).map((name) => path.join(directory, name));
    } catch { return []; }
  }
  return absolute ? [absolute] : [];
}

export function discoverGateRoots({ root = ROOT, workflowDir = path.join(root, ".github", "workflows") } = {}) {
  const gates = [];
  const monitors = [];
  if (!existsSync(workflowDir)) return { gates, monitors };
  for (const name of readdirSync(workflowDir).filter((entry) => /\.(?:yml|yaml)$/.test(entry)).sort()) {
    const filePath = path.join(workflowDir, name);
    const contents = readFileSync(filePath, "utf8");
    const events = workflowEvents(contents);
    const target = events.has("pull_request") || events.has("merge_group") ? gates : monitors;
    for (const block of workflowRunBlocks(contents)) {
      if (!hasCheckMode(block.text)) continue;
      for (const candidate of sourcePathCandidates(block.text)) {
        for (const sourcePath of expandSourcePath(root, candidate.path, root)) {
          target.push({
            workflow: relative(root, filePath),
            command: block.text.trim(),
            sourcePath,
            line: block.line,
            events: [...events].sort(),
          });
        }
      }
    }
  }
  return { gates, monitors };
}

function gitChangedPaths(root) {
  const runGit = (...args) => execFileSync("git", ["-C", root, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    env: isolatedGitEnv(),
  });
  let tracked = "";
  for (const base of ["origin/main", "main", "HEAD^"]) {
    try {
      tracked = runGit("diff", "--name-only", `${base}...HEAD`);
      break;
    } catch { /* Try the next available base. */ }
  }
  let untracked = "";
  try { untracked = runGit("ls-files", "--others", "--exclude-standard"); } catch { /* Not a Git checkout. */ }
  return new Set(`${tracked}\n${untracked}`.split("\n").map((entry) => entry.trim()).filter(Boolean));
}

export function lintRepository({ root = ROOT, workflowDir = path.join(root, ".github", "workflows"), changedOnly = false } = {}) {
  const { gates, monitors } = discoverGateRoots({ root, workflowDir });
  const changed = changedOnly ? gitChangedPaths(root) : null;
  const findings = [];
  const visited = new Set();
  const queue = gates.map((entry) => ({ ...entry, sourcePath: path.resolve(entry.sourcePath) }));
  for (const gate of gates) {
    findings.push(...workflowCommandFindings(root, path.resolve(root, gate.workflow), {
      text: gate.command,
      line: gate.line,
    }));
  }
  while (queue.length) {
    const entry = queue.shift();
    const visitKey = `${entry.sourcePath}\n${entry.command}`;
    if (visited.has(visitKey)) continue;
    visited.add(visitKey);
    if (!existsSync(entry.sourcePath)) continue;
    if (relative(root, entry.sourcePath) === "tools/determinism_lint.mjs") continue;
    if (changed && !changed.has(relative(root, entry.sourcePath))) {
      for (const dependency of localDependencies(entry.sourcePath, readFileSync(entry.sourcePath, "utf8"))) {
        queue.push({ ...entry, sourcePath: dependency });
      }
      continue;
    }
    const source = readFileSync(entry.sourcePath, "utf8");
    findings.push(...analyzeSource({ root, filePath: entry.sourcePath, source, command: `${entry.workflow}:${entry.line}` }));
    for (const dependency of localDependencies(entry.sourcePath, source)) {
      queue.push({ ...entry, sourcePath: dependency });
    }
  }
  const unique = new Map();
  for (const finding of findings) {
    const key = [finding.category, finding.path, finding.line].join("\n");
    if (!unique.has(key)) unique.set(key, finding);
  }
  return {
    gates,
    monitors,
    findings: [...unique.values()].sort((left, right) => left.path.localeCompare(right.path) || left.line - right.line || left.category.localeCompare(right.category)),
  };
}

function rootRelativePath(root, filePath) {
  if (!filePath) return null;
  return path.isAbsolute(filePath) ? relative(root, filePath) : String(filePath).split(path.sep).join("/");
}

export function canonicalEvidence(report, { root = ROOT } = {}) {
  const compact = (entries, kind) => (entries || []).map((entry) => ({
    kind,
    workflow: entry.workflow,
    line: entry.line,
    path: rootRelativePath(root, entry.sourcePath || entry.path),
  })).sort((left, right) => left.workflow.localeCompare(right.workflow) || left.line - right.line || String(left.path).localeCompare(String(right.path)));
  const site = report.site || null;
  return {
    schema: RECEIPT_SCHEMA,
    gates: compact(report.gates, "gate"),
    monitors: compact(report.monitors, "monitor"),
    site: {
      modules: site ? site.covered.length : 0,
      third_party: site ? (site.inventory?.thirdParty || []).map((entry) => entry.path).sort() : [],
      issues: site ? [...site.issues].sort() : [],
      findings: (site ? site.findings : []).map((finding) => ({
        category: finding.category,
        path: finding.path,
        line: finding.line,
        source: finding.source,
        remediation: finding.remediation,
      })),
    },
    findings: (report.findings || []).map((finding) => ({
      category: finding.category,
      path: finding.path,
      line: finding.line,
      source: finding.source,
      remediation: finding.remediation,
    })),
  };
}

export function stableStringify(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function formatFinding(finding) {
  return `${finding.path}:${finding.line}: ${finding.category}: ${finding.source}\n  remediation: ${finding.remediation}`;
}

export function parseArgs(argv = []) {
  const args = { check: false, writeReceipt: false, writeSiteInventory: false, fixture: null, now: null };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--check") args.check = true;
    else if (token === "--write-receipt") args.writeReceipt = true;
    else if (token === "--write-site-inventory") args.writeSiteInventory = true;
    else if (token === "--fixture") {
      args.fixture = argv[index + 1];
      index += 1;
    } else if (token === "--now") {
      args.now = argv[index + 1];
      index += 1;
    } else {
      throw new Error(`Unknown argument: ${token}`);
    }
  }
  return args;
}

export function resolveFixtureRoot(fixturePath, { cwd = process.cwd() } = {}) {
  if (!fixturePath) return null;
  const fixture = path.resolve(cwd, fixturePath);
  const nested = path.join(fixture, "repo");
  if (existsSync(path.join(nested, ".github", "workflows"))) return { fixture, root: nested };
  return { fixture, root: fixture };
}

function expectedReceiptPath(fixture) {
  return path.join(fixture, "expected", "receipt.json");
}

export function main(argv = process.argv.slice(2)) {
  let args;
  try {
    args = parseArgs(argv);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    return 2;
  }
  const modes = [args.check, args.writeReceipt, args.writeSiteInventory].filter(Boolean);
  if (modes.length !== 1) {
    process.stderr.write("Usage: node tools/determinism_lint.mjs --check [--fixture DIR] [--now ISO]\n");
    process.stderr.write("       node tools/determinism_lint.mjs --write-receipt --fixture DIR\n");
    process.stderr.write("       node tools/determinism_lint.mjs --write-site-inventory\n");
    return 2;
  }
  if (args.writeSiteInventory) {
    const inventoryPath = path.join(ROOT, SITE_INVENTORY_PATH);
    const rebuilt = buildSiteInventory({ root: ROOT, previous: readSiteInventory({ root: ROOT }) });
    writeFileSync(inventoryPath, stableStringify(rebuilt));
    process.stdout.write(`wrote ${SITE_INVENTORY_PATH} (${rebuilt.modules.length} production site modules)\n`);
    return 0;
  }
  if (args.now != null && Number.isNaN(Date.parse(args.now))) {
    process.stderr.write("--now must be an ISO-8601 timestamp\n");
    return 2;
  }
  if (args.writeReceipt && !args.fixture) {
    process.stderr.write("--write-receipt requires --fixture\n");
    return 2;
  }

  const fixture = args.fixture ? resolveFixtureRoot(args.fixture) : null;
  const root = fixture ? fixture.root : ROOT;
  const report = lintRepository({
    root,
    workflowDir: path.join(root, ".github", "workflows"),
    changedOnly: !fixture,
  });
  /*
   * The shipped site is scanned in full on every run. The gate traversal above
   * is changed-file scoped because it re-reads whole helper graphs; the site
   * scope is not, because "only the files this branch touched" is exactly the
   * hole a new production clock would slip through.
   */
  report.site = lintSiteProduction({ root });
  const evidence = canonicalEvidence(report, { root });
  // `--now` is an explicit declared input. It is accepted so callers can replay
  // a check across clocks, but it is never copied into invariant evidence.
  void args.now;

  if (args.writeReceipt) {
    const receiptPath = expectedReceiptPath(fixture.fixture);
    mkdirSync(path.dirname(receiptPath), { recursive: true });
    writeFileSync(receiptPath, stableStringify(evidence));
    process.stdout.write(`wrote ${path.relative(process.cwd(), receiptPath)}\n`);
    return 0;
  }

  if (fixture) {
    const receiptPath = expectedReceiptPath(fixture.fixture);
    if (!existsSync(receiptPath)) {
      process.stderr.write(`${relative(ROOT, receiptPath)} is missing; generate it with --write-receipt\n`);
      return 1;
    }
    const expected = readFileSync(receiptPath, "utf8");
    const actual = stableStringify(evidence);
    if (expected !== actual) {
      process.stderr.write("determinism lint fixture receipt drifted:\n");
      process.stderr.write(`  ${relative(ROOT, receiptPath)}\n`);
      return 1;
    }
    process.stdout.write(
      `determinism lint passed (${report.gates.length} gate roots; ${report.monitors.length} scheduled monitor roots excluded; ${report.site.covered.length} production site modules covered)\n`,
    );
    return 0;
  }

  let failed = false;
  if (report.findings.length) {
    process.stderr.write("determinism lint failed for required check-mode gates:\n");
    process.stderr.write(`${report.findings.map(formatFinding).join("\n")}\n`);
    failed = true;
  }
  if (report.site.issues.length) {
    process.stderr.write(`${SITE_INVENTORY_PATH} does not describe the shipped site:\n`);
    process.stderr.write(`${report.site.issues.map((issue) => `  ${issue}`).join("\n")}\n`);
    failed = true;
  }
  if (report.site.findings.length) {
    process.stderr.write("determinism lint failed for production site modules:\n");
    process.stderr.write(`${report.site.findings.map(formatFinding).join("\n")}\n`);
    failed = true;
  }
  if (failed) return 1;
  const reduced = report.site.unmaterialised.length
    ? `; ${report.site.unmaterialised.length} read from HEAD in this reduced working copy`
    : "";
  process.stdout.write(
    `determinism lint passed (${report.gates.length} gate roots; ${report.monitors.length} scheduled monitor roots excluded; ${report.site.covered.length} production site modules covered${reduced})\n`,
  );
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main();
}

export { RECEIPT_SCHEMA, RULES, SITE_INVENTORY_PATH, SITE_INVENTORY_SCHEMA, SITE_RULES, stripCommentsPreservingLines };
