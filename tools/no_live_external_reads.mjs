#!/usr/bin/env node

import assert from "node:assert/strict";
import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const POLICY_PATH = path.join(ROOT, "architecture", "resident-read-policy.json");
const DEBT_PATH = path.join(ROOT, "architecture", "no-live-external-debt.json");
const CALL_NAMES = new Set(["fetch", "api", "soda", "workerFetch"]);
const STATIC_FETCH_PREFIXES = ["/data/", "data/", "./data/", "../data/"];

function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, "utf8"));
}

function relative(filePath) {
  return path.relative(ROOT, filePath).split(path.sep).join("/");
}

function lineNumber(source, offset) {
  return source.slice(0, offset).split("\n").length;
}

function normalizeSignature(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function extractBalancedCall(source, openIndex) {
  let depth = 0;
  let quote = null;
  let escaped = false;
  for (let index = openIndex; index < source.length; index += 1) {
    const char = source[index];
    if (quote) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === quote) quote = null;
      continue;
    }
    if (char === "\"" || char === "'" || char === "`") {
      quote = char;
      continue;
    }
    if (char === "(") depth += 1;
    else if (char === ")") {
      depth -= 1;
      if (depth === 0) return source.slice(openIndex + 1, index);
    }
  }
  return null;
}

function firstArgument(callBody) {
  let depth = 0;
  let quote = null;
  let escaped = false;
  for (let index = 0; index < callBody.length; index += 1) {
    const char = callBody[index];
    if (quote) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === quote) quote = null;
      continue;
    }
    if (char === "\"" || char === "'" || char === "`") quote = char;
    else if (char === "(" || char === "[" || char === "{") depth += 1;
    else if (char === ")" || char === "]" || char === "}") depth -= 1;
    else if (char === "," && depth === 0) return callBody.slice(0, index).trim();
  }
  return callBody.trim();
}

function literalValue(expression) {
  const match = String(expression || "").trim().match(/^["'`]([^"'`]*)["'`]$/s);
  return match ? match[1] : null;
}

function leadingLiteralValue(expression) {
  return literalValue(expression) || String(expression || "").trim().match(/^["'`]([^"'`]*)["'`]/s)?.[1] || null;
}

function topLevelConstants(sources) {
  const constants = new Map();
  const assignment = /\bconst\s+([A-Z][A-Z0-9_]*)\s*=\s*["'`](https?:\/\/[^"'`]+)["'`]/g;
  for (const source of sources.values()) {
    for (const match of source.matchAll(assignment)) constants.set(match[1], match[2]);
  }
  return constants;
}

function localExternalAliases(source, constants, externalOrigins) {
  const aliases = new Map();
  const assignments = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*([^;\n]+)/g;
  let changed = true;
  while (changed) {
    changed = false;
    for (const match of source.matchAll(assignments)) {
      const [, name, expression] = match;
      if (aliases.has(name)) continue;
      const urls = expression.match(/https?:\/\/[^\s"'`)]+/g) || [];
      let origin = urls.map((url) => {
        try { return new URL(url).hostname.toLowerCase(); } catch { return null; }
      }).find((hostname) => externalOrigins.has(hostname));
      if (!origin) {
        for (const identifier of expression.matchAll(/\b[A-Za-z_$][\w$]*\b/g)) {
          const constantUrl = constants.get(identifier[0]);
          if (constantUrl) {
            const hostname = new URL(constantUrl).hostname.toLowerCase();
            if (externalOrigins.has(hostname)) { origin = hostname; break; }
          }
          if (aliases.has(identifier[0])) { origin = aliases.get(identifier[0]); break; }
        }
      }
      if (origin) {
        aliases.set(name, origin);
        changed = true;
      }
    }
  }
  return aliases;
}

function importTargets(filePath, source) {
  if (!filePath.endsWith(".mjs") && !filePath.endsWith(".js")) return [];
  const targets = [];
  const matcher = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s*)["']([^"']+)["']/g;
  for (const match of source.matchAll(matcher)) {
    const specifier = match[1];
    if (!specifier.startsWith(".")) continue;
    const resolved = path.resolve(path.dirname(filePath), specifier);
    if (resolved.startsWith(path.join(ROOT, "site")) && statSafe(resolved)?.isFile()) targets.push(resolved);
  }
  return targets;
}

function statSafe(filePath) {
  try { return statSync(filePath); } catch { return null; }
}

export function loadResidentSources(policy, { root = ROOT } = {}) {
  const sources = new Map();
  const queue = policy.browser_entrypoints.map((item) => path.resolve(root, item));
  while (queue.length) {
    const filePath = queue.shift();
    if (sources.has(filePath)) continue;
    assert.ok(statSafe(filePath)?.isFile(), `resident-read entrypoint is missing: ${relative(filePath)}`);
    const source = readFileSync(filePath, "utf8");
    sources.set(filePath, source);
    queue.push(...importTargets(filePath, source));
  }
  return sources;
}

function externalOriginForCall({ name, body, first, constants, aliases, externalOrigins }) {
  if (name === "soda") return "data.cityofnewyork.us";
  const directUrls = body.match(/https?:\/\/[^\s"'`)}]+/g) || [];
  for (const raw of directUrls) {
    const hostname = new URL(raw).hostname.toLowerCase();
    if (externalOrigins.has(hostname)) return hostname;
  }
  const identifiers = new Set([
    ...String(first).matchAll(/\b[A-Z][A-Z0-9_]*\b/g),
  ].map((match) => match[0]));
  for (const identifier of identifiers) {
    const url = constants.get(identifier);
    if (!url) continue;
    const hostname = new URL(url).hostname.toLowerCase();
    if (externalOrigins.has(hostname)) return hostname;
  }
  for (const identifier of String(first).matchAll(/\b[A-Za-z_$][\w$]*\b/g)) {
    if (aliases.has(identifier[0])) return aliases.get(identifier[0]);
  }
  return null;
}

function routeBase(value) {
  if (!value || !value.startsWith("/")) return null;
  return value.split(/[?${]/, 1)[0].replace(/\/$/, "") || "/";
}

function routeClassification(route, policy) {
  for (const [classification, routes] of Object.entries(policy.first_party_routes || {})) {
    if (routes.some((candidate) => route === candidate || route.startsWith(`${candidate}/`))) return classification;
  }
  return null;
}

function isDeclaration(source, callStart, name) {
  const prefix = source.slice(Math.max(0, callStart - 30), callStart);
  return new RegExp(`(?:function|class)\\s+$|(?:const|let|var)\\s+${name}\\s*=\\s*$`).test(prefix);
}

export function analyzeResidentSources(sources, policy) {
  const findings = [];
  const constants = topLevelConstants(sources);
  const externalOrigins = new Set(policy.external_data_origins.map((item) => item.toLowerCase()));
  const callPattern = /\b(fetch|api|soda|workerFetch)\s*\(/g;
  for (const [filePath, source] of sources) {
    const aliases = localExternalAliases(source, constants, externalOrigins);
    for (const match of source.matchAll(callPattern)) {
      const name = match[1];
      const callStart = match.index;
      if (!CALL_NAMES.has(name) || isDeclaration(source, callStart, name)) continue;
      const openIndex = source.indexOf("(", callStart);
      const body = extractBalancedCall(source, openIndex);
      if (body == null) continue;
      const first = firstArgument(body);
      const signature = normalizeSignature(`${name}(${body})`);
      if (name === "workerFetch") {
        const route = routeBase(leadingLiteralValue(first));
        if (!route) continue;
        const classification = routeClassification(route, policy);
        if (!classification || classification === "temporary_debt") {
          findings.push({
            path: relative(filePath),
            line: lineNumber(source, callStart),
            call_signature: signature,
            origin: classification === "temporary_debt" ? "first-party:temporary-debt" : "first-party:unclassified",
            route,
            detector: classification === "temporary_debt" ? "temporary-first-party-route" : "unclassified-first-party-route",
          });
        }
        continue;
      }
      if (name === "fetch") {
        const literal = literalValue(first);
        if (literal && STATIC_FETCH_PREFIXES.some((prefix) => literal.startsWith(prefix))) continue;
      }
      const origin = externalOriginForCall({ name, body, first, constants, aliases, externalOrigins });
      if (!origin) continue;
      findings.push({
        path: relative(filePath),
        line: lineNumber(source, callStart),
        call_signature: signature,
        origin,
        route: null,
        detector: "external-data-call",
      });
    }
  }
  return findings.sort((left, right) => left.path.localeCompare(right.path) || left.line - right.line);
}

function debtIdentity(item) {
  return [item.path, item.line, item.call_signature, item.origin, item.route || ""].join("\n");
}

export function evaluateDebt(findings, debt, policy, { today = new Date().toISOString().slice(0, 10) } = {}) {
  assert.equal(debt.schema_version, 1, "no-live debt manifest schema_version must be 1");
  assert.ok(Array.isArray(debt.entries), "no-live debt manifest entries must be an array");
  const maxMs = Number(policy.temporary_debt_max_days || 30) * 86400000;
  const generated = Date.parse(`${debt.generated_at}T00:00:00Z`);
  const expires = Date.parse(`${debt.expires_on}T00:00:00Z`);
  assert.ok(Number.isFinite(generated) && Number.isFinite(expires), "debt manifest dates must be ISO dates");
  assert.ok(expires - generated <= maxMs, `debt manifest may cover at most ${policy.temporary_debt_max_days} days`);
  assert.ok(today <= debt.expires_on, `no-live debt manifest expired on ${debt.expires_on}`);
  const findingById = new Map(findings.map((item) => [debtIdentity(item), item]));
  const debtById = new Map();
  for (const entry of debt.entries) {
    for (const key of ["id", "surface", "path", "line", "call_signature", "origin", "route", "owner", "migration_card", "reason", "expires_on"]) {
      assert.notEqual(entry[key], undefined, `debt entry ${entry.id || "<unknown>"} is missing ${key}`);
    }
    assert.ok(!String(entry.path).includes("*"), `debt entry ${entry.id} may not use wildcards`);
    assert.ok(entry.expires_on <= debt.expires_on, `debt entry ${entry.id} exceeds manifest expiry`);
    const identity = debtIdentity(entry);
    assert.ok(!debtById.has(identity), `duplicate debt entry ${entry.id}`);
    debtById.set(identity, entry);
  }
  return {
    unapproved: findings.filter((item) => !debtById.has(debtIdentity(item))),
    stale_debt: debt.entries.filter((item) => !findingById.has(debtIdentity(item))),
    approved: findings.filter((item) => debtById.has(debtIdentity(item))),
  };
}

export function runNoLiveExternalReads({ inventory = false } = {}) {
  const policy = readJson(POLICY_PATH);
  const debt = readJson(DEBT_PATH);
  const sources = loadResidentSources(policy);
  const findings = analyzeResidentSources(sources, policy);
  if (inventory) {
    process.stdout.write(`${JSON.stringify(findings, null, 2)}\n`);
    return findings;
  }
  const report = evaluateDebt(findings, debt, policy);
  if (report.unapproved.length || report.stale_debt.length) {
    const lines = ["resident-read zero-egress gate failed"];
    for (const item of report.unapproved) lines.push(`NEW ${item.path}:${item.line} ${item.origin} ${item.call_signature}`);
    for (const item of report.stale_debt) lines.push(`STALE-DEBT ${item.id} ${item.path}:${item.line}`);
    throw new Error(lines.join("\n"));
  }
  return { ...report, scanned_files: sources.size };
}

const invoked = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (invoked) {
  const inventory = process.argv.includes("--inventory");
  const result = runNoLiveExternalReads({ inventory });
  if (!inventory) process.stdout.write(`resident-read zero-egress gate passed (${result.scanned_files} files, ${result.approved.length} temporary debts)\n`);
}
