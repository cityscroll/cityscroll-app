#!/usr/bin/env node

/**
 * Check-mode determinism lint.
 *
 * The lint starts at explicit `--check` commands in workflows which can run for
 * a pull request or merge group. It follows local JavaScript imports and shell
 * helper calls, then reports environmental inputs that can make a gate change
 * result without a source change. Schedule-only workflows are monitors, not
 * merge gates, and are intentionally reported separately.
 *
 * This is a source inspection tool. It never writes a baseline, receipt, or
 * generated artifact. A finding may be waived only at the finding's line with
 * a reasoned `determinism-lint: allow <category> ...` annotation.
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const WORKFLOW_DIR = path.join(ROOT, ".github", "workflows");
const SOURCE_EXTENSIONS = new Set([".cjs", ".js", ".mjs", ".py", ".sh"]);

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
    pattern: /\b(?:--from-(?:live|soda)|--against-live|--live)\b|\b(?:SODA|LIVE|PRODUCTION|EXTERNAL)_?(?:URL|DATA|ORIGIN)\b|\bprocess\.env\.[A-Z0-9_]*(?:URL|DATA|ORIGIN|LIVE|TODAY|DATE|TZ)[A-Z0-9_]*\b/i,
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

function sourceFinding(root, filePath, source, rule, offset, command) {
  const line = lineNumber(source, offset);
  if (rule.category === "timezone") {
    const context = String(source || "").slice(Math.max(0, offset - 160), offset + 240);
    if (/\btimeZone\s*:/i.test(context)) return null;
    if (/\btoLocaleString\s*\(/.test(context) && !/\b(?:Date|date|time)\b/.test(context)) return null;
  }
  if (explicitAllowance(source, line, rule.category)) return null;
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
  const findings = analyzeSource({ root, filePath, source, command: `${relative(root, filePath)}:${block.line}` });
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
  const runGit = (...args) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
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

function formatFinding(finding) {
  return `${finding.path}:${finding.line}: ${finding.category}: ${finding.source}\n  remediation: ${finding.remediation}`;
}

export function main(argv = process.argv.slice(2)) {
  if (!argv.includes("--check")) {
    process.stderr.write("Usage: node tools/determinism_lint.mjs --check\n");
    return 2;
  }
  const report = lintRepository({ changedOnly: true });
  if (report.findings.length) {
    process.stderr.write("determinism lint failed for required check-mode gates:\n");
    process.stderr.write(`${report.findings.map(formatFinding).join("\n")}\n`);
    return 1;
  }
  process.stdout.write(`determinism lint passed (${report.gates.length} gate roots; ${report.monitors.length} scheduled monitor roots excluded)\n`);
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main();
}

export { RULES, stripCommentsPreservingLines };
