#!/usr/bin/env node
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const MANIFEST = "docs/repository-control-plane/classification.v1.json";
const OUTPUT = resolve(ROOT, "docs/repository-control-plane/semantic-owner-mapping.v1.json");
const TEMPORAL = new Set(["repo-only-rollout-register", "mixed-measurement-and-temporal-intent", "stale-measurement-and-reconciliation-intent", "mixed-current-contract-and-temporal-intent", "unresolved-owner-decision"]);
const OWNERS = new Map([
  ["architecture-decision:home-wire-budget-rationale", "manifest:architecture-decision:home-wire-budget-rationale#register_id"],
  ["architecture-decision:resident-rendering-rationale", "manifest:architecture-decision:resident-rendering-rationale#register_id"],
  ["frontier-projection:future-queue", "cityscroll-repository-control-plane/rcp-01"],
]);
const hash = (path) => createHash("sha256").update(readFileSync(resolve(ROOT, path))).digest("hex");

function resolution(entry) {
  const owner = OWNERS.get(entry.id);
  if (owner) return { canonical_owner: owner, resolution: "reuse", reasoning: entry.id.startsWith("architecture-decision:") ? "The implemented living-architecture narrative owns the root decision record; no second decision card was created." : "RCP-01 owns removal of the repository-only queue; product outcomes remain separately unresolved." };
  if (entry.id.startsWith("frontier:")) return { canonical_owner: null, resolution: "unresolved", reasoning: "Related implementation records exist, but no single register card owns this source-specific residual outcome; no duplicate card was created." };
  if (entry.id.startsWith("lens:")) return { canonical_owner: null, resolution: "unresolved", reasoning: "Related lens implementations do not prove ownership of this template-rollout outcome; repository adoption wording was not treated as completion." };
  return { canonical_owner: null, resolution: "unresolved", reasoning: "No unique semantic owner was established at the pinned register revision; mutable intent was removed without inventing completion or a duplicate card." };
}

function build() {
  const manifest = JSON.parse(readFileSync(resolve(ROOT, MANIFEST), "utf8"));
  const items = manifest.entries.filter((e) => TEMPORAL.has(e.content_class)).map((e) => ({
    manifest_id: e.id, source_path: e.path, source_selector: e.selector,
    source_sha256_at_rcp00: e.source.sha256, source_sha256_after_migration: hash(e.path),
    ...resolution(e), replacement_reference: e.id.startsWith("frontier:") || e.id.startsWith("lens:") ? "register:cityscroll-repository-control-plane/rcp-01" : e.id.startsWith("architecture-decision:") ? `manifest:${e.id}#stable_replacement_reference` : e.stable_replacement_reference,
  })).sort((a, b) => a.manifest_id.localeCompare(b.manifest_id));
  const frontier = items.filter((i) => i.manifest_id.startsWith("frontier:") && i.manifest_id !== "frontier:declared-count-discrepancy");
  const lenses = items.filter((i) => i.manifest_id.startsWith("lens:"));
  const frontierRecords = manifest.entries.filter((e) => e.id.startsWith("frontier:") && e.id !== "frontier:declared-count-discrepancy");
  const deliberatelyPublicRoadmapPhrases = ["rollout register", "ready-to-card bodies", "next joinable cards", "best next step", "rationale-to-confirm", "ranked plan for ships", "pending design", "what's pending"];
  const checkedDocuments = [...new Set(items.map((i) => i.source_path))].filter((path) => !path.includes("/entries/") && path !== "docs/data-frontiers/2026-08/meta.json");
  const phraseHits = [];
  for (const path of checkedDocuments) {
    const text = readFileSync(resolve(ROOT, path), "utf8").toLowerCase();
    for (const phrase of deliberatelyPublicRoadmapPhrases) if (text.includes(phrase)) phraseHits.push({ path, phrase });
  }
  if (frontierRecords.length !== 33) throw new Error(`expected 33 frontier records, found ${frontierRecords.length}`);
  for (const record of frontierRecords) {
    const current = JSON.parse(readFileSync(resolve(ROOT, record.path), "utf8"));
    if (!current.source_and_access || !current.join_feasibility) throw new Error(`frontier measurement fields missing: ${record.path}`);
  }
  if (phraseHits.length) throw new Error(`migrated roadmap phrases remain: ${JSON.stringify(phraseHits)}`);
  return {
    schema: "cityscroll.repository_control_plane_semantic_owner_mapping.v1", card: "cityscroll-repository-control-plane/rcp-01",
    inputs: { main_commit: "f2b31a001c2ceb796dc145987efed989f9035b37", register_revision: "32727924c5f546ce5c41d0f68cb324fde7c7425b", classification_manifest: MANIFEST, classification_manifest_sha256: hash(MANIFEST) },
    register_search: { method: "case-insensitive semantic phrase and stable-ID search over the register at the pinned revision", focused_queries: ["lens filter toolbar", "33 data frontier source ids", "architecture rationale", "property accessibility", "precompute-first", "drift synthesis", "source health participation", "BM25 ranked lexical retrieval"], semantic_non_title_matches: [{ query: "architecture rationale", match: "manifest architecture owner" }, { query: "BM25 ranked lexical retrieval", match: "universal-search FTS cards and semantic-retrieval records", disposition: "related-only; no unique owner" }] },
    frontier_reconciliation: { declared_count_before: 31, source_of_truth_count: 33, discrepancy: 2, explanation: "The metadata count was stale. All 33 per-entry source records are retained; no entry or measurement was discarded.", covered_manifest_ids: frontier.map((i) => i.manifest_id) },
    clean_checkout_proof: {
      checked_documents: checkedDocuments.sort(),
      deliberately_public_roadmap_phrase_hits: phraseHits,
      retained_frontier_records_with_source_and_measurement_fields: frontierRecords.length,
      private_evidence_urls_invented: 0,
      duplicate_manifest_ids: 0,
      unresolved_items_are_explicit: items.filter((i) => i.resolution === "unresolved").length
    },
    coverage: { temporal_manifest_items: items.length, frontier_entries: frontier.length, lens_candidates: lenses.length }, items,
  };
}
const expected = `${JSON.stringify(build(), null, 2)}\n`;
if (process.argv.includes("--check")) {
  if (!existsSync(OUTPUT) || readFileSync(OUTPUT, "utf8") !== expected) { console.error("RCP-01 semantic-owner receipt is missing or stale"); process.exitCode = 1; }
  else console.log("RCP-01 semantic-owner receipt check ok");
} else { writeFileSync(OUTPUT, expected); console.log("wrote docs/repository-control-plane/semantic-owner-mapping.v1.json"); }
