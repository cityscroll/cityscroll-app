#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { aggregateArchitectureEvidence } from "./architecture_evidence_shards.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const MANIFEST_PATH = "docs/repository-control-plane/inverse-guard.v1.json";
const SCHEMA = "cityscroll.repository_inverse_guard.v1";
const TEXT_PATH = /\.(?:md|json|ya?ml)$/i;
const RETAINED_CLASSES = new Set([
  "accepted-architecture-decision", "public-source-contract", "test",
  "implementation-evidence-shard", "public-code-coupled-evidence", "current-maintainer-runbook",
  "repository-migration-receipt",
]);

function finding(path, rule, classification, owner, detail) {
  return { path, rule, class: classification, owner, detail };
}

function git(root, args) {
  const result = spawnSync("git", ["-C", root, ...args], { encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr.trim() || `git ${args.join(" ")} failed`);
  return result.stdout.split(/\r?\n/).filter(Boolean);
}

function patternRegex(pattern) {
  let source = "";
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index];
    if (char === "*" && pattern[index + 1] === "*") {
      source += ".*";
      index += 1;
    } else if (char === "*") source += "[^/]*";
    else if (char === "?" ) source += "[^/]";
    else if (char === "{" ) {
      const end = pattern.indexOf("}", index);
      if (end < 0) source += "\\{";
      else {
        source += `(?:${pattern.slice(index + 1, end).split(",").map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})`;
        index = end;
      }
    } else source += char.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${source}$`);
}

export function classifyPath(path, manifest) {
  for (const row of manifest.classifications) {
    if (patternRegex(row.path_pattern).test(path)) return row;
  }
  return null;
}

export function validateManifest(manifest, sourceCards) {
  const findings = [];
  if (manifest?.schema !== SCHEMA) findings.push(finding(MANIFEST_PATH, "manifest-schema", "manifest", "repository", `expected ${SCHEMA}`));
  if (manifest?.source_card_inventory?.provider !== "architecture-evidence-shards") {
    findings.push(finding(MANIFEST_PATH, "source-card-inventory", "manifest", "repository", "provider must reuse architecture-evidence-shards"));
  }
  if (!Array.isArray(manifest?.classifications)) return [...findings, finding(MANIFEST_PATH, "manifest-classifications", "manifest", "repository", "classifications must be an array")];
  const inventoryIds = new Set(sourceCards?.cards?.map((row) => row.id) || []);
  const ids = new Set();
  for (const [index, row] of manifest.classifications.entries()) {
    const path = `${MANIFEST_PATH}#classifications[${index}]`;
    for (const field of ["id", "path_pattern", "content_class", "canonical_owner", "register_id", "disposition", "allowed_evidence_contract"]) {
      if (typeof row?.[field] !== "string" || !row[field].trim()) findings.push(finding(path, "manifest-field", row?.content_class || "manifest", row?.canonical_owner || "unknown", `missing ${field}`));
    }
    if (ids.has(row?.id)) findings.push(finding(path, "manifest-id", row?.content_class || "manifest", row?.canonical_owner || "unknown", `duplicate id ${row.id}`));
    ids.add(row?.id);
    if (row?.register_id !== "not-applicable" && !inventoryIds.has(row?.register_id)) {
      findings.push(finding(path, "unresolved-register-id", row?.content_class || "manifest", row?.canonical_owner || "unknown", `${row?.register_id} is absent from cityscroll.card-inventory.v1`));
    }
  }
  return findings;
}

function mutablePlanningRecord(text) {
  const frontmatter = text.match(/^---\s*\n([\s\S]*?)\n---/);
  if (frontmatter && /^(?:status|priority|dependencies?|builds_on):\s*.+$/im.test(frontmatter[1]) && /^(?:card_standard|priority|dependencies?|builds_on):\s*.+$/im.test(frontmatter[1])) return true;
  return /\|\s*(?:priority|status)\s*\|[^\n]*(?:dependencies?|owner)\s*\|/i.test(text);
}

export function scanDocument({ path, text, classification }) {
  const row = classification || { content_class: "unclassified", canonical_owner: "unresolved", allowed_evidence_contract: "none" };
  const results = [];
  const add = (rule, detail) => results.push(finding(path, rule, row.content_class, row.canonical_owner, detail));
  const retained = RETAINED_CLASSES.has(row.content_class);
  if (!retained && /^#{1,3}\s+(?:[A-Z][A-Z0-9-]*\s*[·:-]\s*)?(?:card|story)\b/im.test(text)) add("repo-only-card-heading", "repository-only card or story heading");
  if (!retained && /\brollout register\b/i.test(text)) add("rollout-register", "rollout register belongs in the canonical planning system");
  if (!retained && /\b(?:ready[- ]to[- ]card|next joinable cards?)\b/i.test(text)) add("temporal-intent", "ready-to-card or next-joinable planning language");
  if (!retained && /\b(?:owner[- ]confirmation|confirm(?:ation)? by the (?:site )?owner|rationale[- ]to[- ]confirm)\b/i.test(text)) add("owner-confirmation", "unresolved owner decision");
  if (!retained && mutablePlanningRecord(text)) add("mutable-planning-record", "mutable status, priority, or dependency record outside an owned protocol");
  if (!["test"].includes(row.content_class) && /\b(?:cangshu(?:[-_ ]id)?|research[-_ ](?:item|source|acquisition)[-_ ]id)\s*[:#=]/i.test(text)) add("internal-research-id", "internal research identifier in public-classified content");
  const privateScheme = new RegExp(["backstage", "://", "cityscroll-evidence/"].join(""), "i");
  if (!["test"].includes(row.content_class) && privateScheme.test(text)) add("private-evidence-scheme", "private evidence scheme in public-classified content");
  return results;
}

export function evaluate({ root = ROOT, manifest, paths, sourceCards }) {
  const results = [...validateManifest(manifest, sourceCards)];
  for (const path of [...new Set(paths)].sort()) {
    if (!TEXT_PATH.test(path)) continue;
    let text;
    try { text = readFileSync(join(root, path), "utf8"); } catch { continue; }
    const classification = classifyPath(path, manifest);
    if (!classification) results.push(finding(path, "unclassified-path", "unclassified", "unresolved", "text document has no classification contract"));
    results.push(...scanDocument({ path, text, classification }));
  }
  return results.sort((a, b) => `${a.path}\0${a.rule}\0${a.detail}`.localeCompare(`${b.path}\0${b.rule}\0${b.detail}`));
}

function selectedPaths(root, argv) {
  if (argv.includes("--all")) return git(root, ["ls-files"]).filter((path) => TEXT_PATH.test(path));
  const pathsFileIndex = argv.indexOf("--paths-file");
  if (pathsFileIndex >= 0) return readFileSync(resolve(argv[pathsFileIndex + 1]), "utf8").split(/\r?\n/).filter(Boolean);
  const baseIndex = argv.indexOf("--base");
  const base = (baseIndex >= 0 ? argv[baseIndex + 1] : null) || process.env.INVERSE_GUARD_BASE_SHA;
  if (!base) throw new Error("changed-path scan requires --base, --paths-file, or --all");
  return git(root, ["diff", "--name-only", "--diff-filter=AMR", `${base}...HEAD`]);
}

function main(argv = process.argv.slice(2)) {
  const manifest = JSON.parse(readFileSync(join(ROOT, MANIFEST_PATH), "utf8"));
  const architecture = aggregateArchitectureEvidence({ root: ROOT });
  if (architecture.status !== "PASS") throw new Error(`source-card inventory unavailable: ${architecture.findings.join("; ")}`);
  const paths = selectedPaths(ROOT, argv);
  const findings = evaluate({ root: ROOT, manifest, paths, sourceCards: architecture.sourceCards });
  const receipt = {
    schema: "cityscroll.repository_inverse_guard_receipt.v1",
    status: findings.length ? "FAIL" : "PASS",
    mode: argv.includes("--all") ? "clean-checkout" : "changed-paths",
    scanned_paths: paths.filter((path) => TEXT_PATH.test(path)).sort(),
    source_card_inventory_schema: architecture.sourceCards.schema,
    source_card_inventory_sha256: architecture.receipt.source_cards_sha256,
    credential_free: true,
    findings,
  };
  process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`);
  if (findings.length) process.exitCode = 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
