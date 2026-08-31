#!/usr/bin/env node

import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUTPUT = join(ROOT, "docs/repository-control-plane/classification.v1.json");
const SCHEMA = "cityscroll.repository_control_plane_classification.v1";
const CARD = "cityscroll-repository-control-plane/rcp-00";
const LIVING_ARCHITECTURE_CARD = ["cityscroll-", "kra", "ken/cs-living-architecture-la1-architecture-narrative"].join("");
const MAIN_COMMIT = "f4974efeaab38c6224844a0ad0bc78bbe0aa1a75";
const DISPOSITIONS = new Set(["keep", "split", "migrate", "privatize", "archive", "delete-from-tip"]);
const HISTORY = new Set(["none", "review-required"]);

function text(path) { return readFileSync(join(ROOT, path), "utf8"); }
function sha(value) { return createHash("sha256").update(value).digest("hex"); }
function fileSha(path) { return sha(readFileSync(join(ROOT, path))); }
function walk(path) {
  const absolute = join(ROOT, path);
  if (!existsSync(absolute)) return [];
  return readdirSync(absolute, { withFileTypes: true }).flatMap((entry) => {
    const child = join(path, entry.name);
    if (entry.isDirectory() && [".git", ".artifacts", "node_modules"].includes(entry.name)) return [];
    return entry.isDirectory() ? walk(child) : [child];
  });
}
function ref(path, selector = "whole-document") {
  return { path, selector, sha256: fileSha(path) };
}
function entry(id, path, selector, contentClass, owner, registerId, disposition, replacement, historyTreatment = "none") {
  return {
    id, path, selector, content_class: contentClass, canonical_owner: owner,
    register_id: registerId, disposition, stable_replacement_reference: replacement,
    history_treatment: historyTreatment, source: ref(path, selector),
  };
}

export function buildManifest() {
  const entries = [];
  const frontierPaths = walk("docs/data-frontiers/2026-08/entries").filter((p) => p.endsWith(".json")).sort();
  for (const path of frontierPaths) {
    const data = JSON.parse(text(path));
    const sourceId = data.id ?? data.entry_id ?? path.split("/").at(-1).replace(/\.json$/, "");
    entries.push(entry(
      `frontier:${sourceId}`, path, `entry:${sourceId}`, "mixed-measurement-and-temporal-intent",
      "cityscroll-repository-control-plane/rcp-01", "cityscroll-repository-control-plane/rcp-01", "split",
      `register:cityscroll-repository-control-plane/rcp-01#frontier-${sourceId}`,
    ));
  }

  const meta = JSON.parse(text("docs/data-frontiers/2026-08/meta.json"));
  entries.push(entry(
    "frontier:declared-count-discrepancy", "docs/data-frontiers/2026-08/meta.json", "json-pointer:/entry_count",
    "stale-measurement-and-reconciliation-intent", "cityscroll-repository-control-plane/rcp-01",
    "cityscroll-repository-control-plane/rcp-01", "split",
    "register:cityscroll-repository-control-plane/rcp-01#frontier-count-reconciliation",
  ));

  for (let n = 1; n <= 5; n += 1) {
    const lensId = `lens-tmpl-0${n}`;
    entries.push(entry(
      `lens:${lensId}`, "docs/lens-filter-template.md", `heading:card ${lensId}`,
      "repo-only-rollout-register", "unresolved", "unresolved", "migrate",
      `register:cityscroll-repository-control-plane/rcp-01#unresolved-${lensId}`,
    ));
  }

  for (const [id, selector] of [
    ["resident-rendering-rationale", "heading:Proposed invariant: resident-surface rendering standard"],
    ["home-wire-budget-rationale", "heading:Proposed rationale: home cold-load wire budget"],
  ]) {
    entries.push(entry(
      `architecture-decision:${id}`, "ARCHITECTURE.md", selector, "unresolved-owner-decision",
      "cityscroll-living-architecture", LIVING_ARCHITECTURE_CARD,
      "migrate", `register:${LIVING_ARCHITECTURE_CARD}#${id}`,
    ));
  }
  entries.push(entry(
    "architecture:accepted-current-contracts", "ARCHITECTURE.md", "sections excluding the two rationale-to-confirm requests",
    "accepted-architecture", "cityscroll-living-architecture", LIVING_ARCHITECTURE_CARD,
    "keep", "repo:ARCHITECTURE.md",
  ));

  entries.push(entry("agents:durable-routing", "AGENTS.md", "durable routing and current invariants", "current-maintainer-routing", "repository", "not-applicable", "split", "repo:AGENTS.md#durable-routing"));
  entries.push(entry("agents:implementation-scrapbook", "AGENTS.md", "implementation-history and temporal status entries", "implementation-history-scrapbook", "cityscroll-repository-control-plane/rcp-02", "cityscroll-repository-control-plane/rcp-02", "migrate", "register:cityscroll-repository-control-plane/rcp-02#root-guidance-rewrite"));
  entries.push(entry("scrim:generated-inventory", "docs/repository-scrim-review.md", "1144-occurrence generated inventory", "bulky-generated-review-inventory", "cityscroll-repository-control-plane/rcp-03", "cityscroll-repository-control-plane/rcp-03", "privatize", "register:cityscroll-repository-control-plane/rcp-03#scrim-inventory", "review-required"));

  for (const path of ["docs/adr/civic-time-event-contract.md", "docs/design-principles-lens.md"]) {
    entries.push(entry(`research:${path}`, path, "Cangshu identifiers, acquisition state, or internal research debt", "internal-research-bookkeeping", "cityscroll-repository-control-plane/rcp-03", "cityscroll-repository-control-plane/rcp-03", "split", `register:cityscroll-repository-control-plane/rcp-03#research-${sha(path).slice(0, 12)}`, "review-required"));
  }

  for (const [id, path, selector, owner, registerId] of [
    ["frontier-projection:future-queue", "docs/data-frontiers-2026-08.md", "Ready-to-card bodies and Next joinable cards sections", "cityscroll-repository-control-plane/rcp-01", "cityscroll-repository-control-plane/rcp-01"],
    ["property-a11y:ranked-plan", "docs/property-a11y-census-2026-08.md", "ranked plan for ships 2-4", "unresolved", "unresolved"],
    ["precompute-first:migration-plan", "docs/precompute-first-inventory-2026-07-29.md", "mutable migration-plan sections", "unresolved", "unresolved"],
    ["drift-inventory:pending-work", "docs/drift-inventory.md", "pending implementation design and unwired triggers", "cityscroll-living-architecture", "unresolved"],
    ["source-health:follow-up-queue", "docs/source-health-participation.md", "uncarded follow-up queue", "unresolved", "unresolved"],
    ["semantic-trial:next-step", "docs/research/semantic-layer-trial-2026-08-04.md", "best next step and internal research state", "unresolved", "unresolved"],
  ]) {
    entries.push(entry(id, path, selector, "mixed-current-contract-and-temporal-intent", owner, registerId, "split", `register:cityscroll-repository-control-plane/rcp-01#${id}`));
  }

  const publicDocs = walk("")
    .filter((p) => /\.(?:md|json|ya?ml)$/i.test(p))
    .filter((p) => !p.startsWith("docs/repository-control-plane/"))
    .filter((p) => !p.startsWith("test/fixtures/repository_control_plane/"))
    .sort();
  const privateUriPaths = publicDocs.filter((p) => text(p).includes("backstage://cityscroll-evidence/"));
  for (const path of privateUriPaths) {
    entries.push(entry(`private-uri:${path}`, path, "all backstage://cityscroll-evidence/ URI occurrences", "private-evidence-reference", "cityscroll-repository-control-plane/rcp-03", "cityscroll-repository-control-plane/rcp-03", "privatize", `register:cityscroll-repository-control-plane/rcp-03#private-uri-${sha(path).slice(0, 12)}`, "review-required"));
  }

  const retained = [
    ["retained:accepted-adrs", "docs/adr/*.md", "accepted-architecture", "cityscroll-living-architecture", "repo:docs/adr/"],
    ["retained:source-contracts", "ontology/**; site/**/*.schema.json", "source-contracts", "repository", "repo:ontology/"],
    ["retained:tests", "test/**; worker/test/**", "tests", "repository", "repo:test/"],
    ["retained:fixtures", "test/fixtures/**", "fixtures", "repository", "repo:test/fixtures/"],
    ["retained:generators", "tools/build_*.mjs", "deterministic-generators", "repository", "repo:tools/"],
    ["retained:runbooks", "docs/*runbook*.md", "current-maintainer-runbooks", "repository", "repo:docs/"],
    ["retained:mt7-shards", "architecture/evidence.d/*.json", "implementation-evidence-shards", "cityscroll-merge-throughput/mt-7-architecture-evidence-shards", "repo:architecture/evidence.d/"],
    ["retained:public-evidence", "docs/evidence/** excluding private-reference sections", "reproducible-public-evidence", "repository", "repo:docs/evidence/"],
  ];
  for (const [id, path, contentClass, owner, replacement] of retained) {
    entries.push({ id, path, selector: "pattern", content_class: contentClass, canonical_owner: owner, register_id: owner === "repository" ? "not-applicable" : owner, disposition: "keep", stable_replacement_reference: replacement, history_treatment: "none", source: { path, selector: "pattern", sha256: sha(path) } });
  }

  entries.sort((a, b) => a.id.localeCompare(b.id));
  return {
    schema: SCHEMA,
    inspection: {
      main_commit: MAIN_COMMIT,
      register_card: CARD,
      frontier_declared_count: meta.entry_count,
      frontier_enumerated_count: frontierPaths.length,
      frontier_discrepancy: frontierPaths.length - meta.entry_count,
      root_agents_bytes: statSync(join(ROOT, "AGENTS.md")).size,
      root_agents_lines: text("AGENTS.md").split("\n").length - 1,
      scrim_occurrences_declared: 1144,
      private_uri_document_count: privateUriPaths.length,
    },
    entries,
  };
}

export function validateManifest(manifest) {
  const findings = [];
  if (manifest?.schema !== SCHEMA) findings.push("schema: unsupported manifest schema");
  if (!Array.isArray(manifest?.entries)) return [...findings, "entries: must be an array"];
  const ids = new Set();
  for (const [index, item] of manifest.entries.entries()) {
    const label = item?.id || `entry[${index}]`;
    if (ids.has(item?.id)) findings.push(`${label}: duplicate id`);
    ids.add(item?.id);
    for (const field of ["id", "path", "selector", "content_class", "canonical_owner", "register_id", "disposition", "stable_replacement_reference", "history_treatment"]) {
      if (typeof item?.[field] !== "string" || item[field].trim() === "") findings.push(`${label}: missing ${field}`);
    }
    if (!DISPOSITIONS.has(item?.disposition)) findings.push(`${label}: invalid disposition`);
    if (!HISTORY.has(item?.history_treatment)) findings.push(`${label}: invalid history_treatment`);
    if (!item?.source?.path || !item?.source?.selector || !/^[a-f0-9]{64}$/.test(item?.source?.sha256 ?? "")) findings.push(`${label}: invalid source reference`);
  }
  return findings;
}

export function scanUnclassifiedFixture(documents, manifestEntries = []) {
  const covered = new Set(manifestEntries.map((item) => item.path));
  const findings = [];
  for (const document of documents) {
    if (covered.has(document.path)) continue;
    if (/rollout register|ready-to-card|next joinable cards/i.test(document.text)) findings.push(`${document.path}: unclassified-rollout-register`);
    if (/rationale-to-confirm by the site owner/i.test(document.text)) findings.push(`${document.path}: unresolved-owner-decision`);
    if (/backstage:\/\/cityscroll-evidence\//i.test(document.text)) findings.push(`${document.path}: private-evidence-uri`);
  }
  return findings.sort();
}

function stable(value) { return `${JSON.stringify(value, null, 2)}\n`; }
function main() {
  const expected = buildManifest();
  const findings = validateManifest(expected);
  if (findings.length) throw new Error(findings.join("\n"));
  if (process.argv.includes("--write")) {
    writeFileSync(OUTPUT, stable(expected));
  } else if (process.argv.includes("--check")) {
    if (!existsSync(OUTPUT) || readFileSync(OUTPUT, "utf8") !== stable(expected)) throw new Error(`stale classification manifest: run node ${relative(ROOT, fileURLToPath(import.meta.url))} --write`);
    console.log(`repository control-plane manifest: ${expected.entries.length} entries; frontier ${expected.inspection.frontier_enumerated_count} enumerated vs ${expected.inspection.frontier_declared_count} declared; ${expected.inspection.private_uri_document_count} private-URI documents`);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
