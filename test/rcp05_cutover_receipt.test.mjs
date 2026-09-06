import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { aggregateArchitectureEvidence } from "../tools/architecture_evidence_shards.mjs";
import {
  CARD,
  CONSTANT_KEYS,
  EXPECTED_KEYS,
  FORBIDDEN_AGGREGATE_RELATIVE,
  MIGRATION_KEYS,
  SHARD_SCHEMA,
  buildReceipt,
  commitReachable,
  evaluateMeasurement,
  migrationKeyForEntry,
  ownerResolution,
  partitionEntries,
  privateAccessFindings,
  readShards,
  reconcileOwners,
  resolveMappingOwner,
  retainedShardFindings,
  servedDeltaPaths,
  shardPathForId,
  trackedAggregateFindings,
} from "../tools/rcp05_cutover_receipt.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const classification = JSON.parse(readFileSync(join(ROOT, "docs/repository-control-plane/classification.v1.json"), "utf8"));
const mapping = JSON.parse(readFileSync(join(ROOT, "docs/repository-control-plane/semantic-owner-mapping.v1.json"), "utf8"));
const architecture = aggregateArchitectureEvidence({ root: ROOT });
const inventoryIds = new Set(architecture.sourceCards.cards.map((card) => card.id));

const built = buildReceipt({ root: ROOT });

test("the cutover proof passes on the current tree", () => {
  assert.deepEqual(built.findings, []);
  assert.equal(built.receipt.status, "PASS");
  assert.equal(built.receipt.schema, "cityscroll.repository_governance_cutover.v1");
  assert.equal(built.receipt.card, CARD);
});

test("reviewed inputs are source-owned, complete, and never a tracked aggregate", () => {
  const { shards, findings } = readShards(ROOT);
  assert.deepEqual(findings, []);
  assert.deepEqual([...shards.keys()].sort(), [...EXPECTED_KEYS].sort());
  for (const [id, shard] of shards) {
    assert.equal(shard.schema, SHARD_SCHEMA, id);
    assert.equal(shard.owner, shard.id, id);
    assert.equal(shard.card, CARD, id);
  }
  for (const key of MIGRATION_KEYS) assert.equal(shards.get(key).kind, "migration", key);
  for (const key of CONSTANT_KEYS) assert.equal(shards.get(key).kind, "constant", key);
  assert.deepEqual(trackedAggregateFindings(ROOT), []);
  assert.ok(FORBIDDEN_AGGREGATE_RELATIVE.endsWith("cutover.v1.json"));
});

test("every classification entry is claimed by exactly one bounded migration", () => {
  const { groups, findings } = partitionEntries(classification.entries);
  assert.deepEqual(findings, []);
  const claimed = [...groups.values()].reduce((sum, rows) => sum + rows.length, 0);
  assert.equal(claimed, classification.entries.length);
  const ids = [...groups.values()].flat().map((entry) => entry.id);
  assert.equal(new Set(ids).size, ids.length, "no entry may be claimed twice");
});

test("a double-claimed entry is a hard failure rather than a silent merge", () => {
  const duplicated = [...classification.entries, classification.entries[0]];
  const { findings } = partitionEntries(duplicated);
  assert.ok(findings.some((row) => row.includes("duplicate classification entry id")));
});

test("every entry ends with exactly one disposition owner and no entry has zero", () => {
  const { rows, findings } = reconcileOwners({ entries: classification.entries, mappingItems: mapping.items, inventoryIds });
  assert.deepEqual(findings, []);
  assert.equal(rows.length, classification.entries.length);
  for (const row of rows) assert.ok(row.disposition_owner, `${row.manifest_id} has no owner`);
  assert.equal(rows.filter((row) => !row.disposition_owner).length, 0);
});

test("an entry with no owner reference at all is reported, not defaulted", () => {
  const orphan = { ...classification.entries.find((entry) => entry.canonical_owner === "unresolved"), id: "orphan:example", stable_replacement_reference: "unresolved" };
  const { findings } = reconcileOwners({ entries: [orphan], mappingItems: [], inventoryIds });
  assert.ok(findings.some((row) => row.includes("no owner reference")));
});

test("two conflicting owner references for one entry are reported", () => {
  const conflicted = {
    ...classification.entries.find((entry) => entry.canonical_owner === "unresolved"),
    id: "conflict:example",
    stable_replacement_reference: "register:cityscroll-engineering/not-a-registered-record#elsewhere",
  };
  conflicted.canonical_owner = "unresolved";
  conflicted.register_id = "cityscroll-engineering/semantic-owner-migration";
  const { findings } = reconcileOwners({ entries: [conflicted], mappingItems: [], inventoryIds });
  assert.ok(findings.some((row) => row.includes("conflicting owner references")));
});

test("unresolved outcome ownership stays explicit instead of becoming an implied pass", () => {
  const unresolved = built.receipt.ownership.explicitly_unresolved_outcome_ids;
  assert.equal(built.receipt.ownership.explicitly_unresolved_outcome_owners, unresolved.length);
  assert.equal(unresolved.length, mapping.items.filter((item) => item.resolution === "unresolved").length);
  for (const id of unresolved) {
    const row = built.receipt.ownership.rows.find((entry) => entry.manifest_id === id);
    assert.equal(row.outcome_owner, null, id);
    assert.ok(row.disposition_owner, `${id} still needs one disposition owner`);
  }
});

test("a mapping that claims an unresolved outcome while naming an owner is contradictory", () => {
  const entry = classification.entries.find((row) => row.content_class === "repo-only-rollout-register");
  const contradictory = [{ manifest_id: entry.id, canonical_owner: "cityscroll-engineering/semantic-owner-migration", resolution: "unresolved" }];
  const { findings } = reconcileOwners({ entries: [entry], mappingItems: contradictory, inventoryIds });
  assert.ok(findings.some((row) => row.includes("unresolved outcome owner but also names")));
});

test("owner references are classified by how the repository can check them", () => {
  assert.equal(ownerResolution("unresolved", inventoryIds), "unresolved");
  assert.equal(ownerResolution(null, inventoryIds), "unresolved");
  assert.equal(ownerResolution("repository", inventoryIds), "repository");
  assert.equal(ownerResolution("cityscroll-engineering/private-generated-evidence-placement", inventoryIds), "card-inventory");
  assert.equal(ownerResolution("cityscroll-living-architecture", inventoryIds), "register-asserted");
  const counts = built.receipt.ownership.disposition_owner_resolution_counts;
  assert.equal(Object.values(counts).reduce((sum, value) => sum + value, 0), classification.entries.length);
});

test("mapping indirection resolves back to the manifest instead of duplicating a record", () => {
  const entries = new Map(classification.entries.map((entry) => [entry.id, entry]));
  const id = "architecture-decision:home-wire-budget-rationale";
  assert.equal(resolveMappingOwner(`manifest:${id}#register_id`, entries), entries.get(id).register_id);
  assert.equal(resolveMappingOwner("manifest:does-not-exist#register_id", entries), null);
  assert.equal(resolveMappingOwner("cityscroll-engineering/semantic-owner-migration", entries), "cityscroll-engineering/semantic-owner-migration");
  assert.equal(resolveMappingOwner(null, entries), null);
});

test("entries route to the migration that executed them", () => {
  assert.equal(migrationKeyForEntry({ path: "AGENTS.md", content_class: "implementation-history-scrapbook" }), "rcp-02-root-router");
  assert.equal(migrationKeyForEntry({ path: "docs/lens-filter-template.md", content_class: "repo-only-rollout-register" }), "rcp-01-shadow-planning");
  assert.equal(migrationKeyForEntry({ path: "docs/api-parity-b2.md", content_class: "private-evidence-reference" }), "rcp-03-private-evidence");
  assert.equal(migrationKeyForEntry({ path: "test/**", content_class: "tests" }), "retained-in-place");
});

test("a reviewed before or after value that no longer matches the commit fails", () => {
  const migration = built.receipt.migrations.find((row) => row.id === "rcp-03-private-evidence");
  const commit = migration.migration_commit;
  const measurement = { id: "scrim-rows", kind: "pattern-count", path: "docs/repository-scrim-review.md", pattern: "^\\| PB-[0-9]{4} \\|", before: 1144, after: 0, tip_relation: "equal-to-after" };
  assert.deepEqual(evaluateMeasurement(measurement, { commit, root: ROOT, routerCeiling: 12000 }).findings, []);
  const drifted = evaluateMeasurement({ ...measurement, before: 1143 }, { commit, root: ROOT, routerCeiling: 12000 });
  assert.ok(drifted.findings.some((row) => row.includes("reviewed before 1143")));
});

test("migrated control-plane content returning at the tip fails the tip relation", () => {
  const commit = built.receipt.migrations.find((row) => row.id === "rcp-03-private-evidence").migration_commit;
  const impossible = { id: "scrim-rows", kind: "pattern-count", path: "docs/repository-scrim-review.md", pattern: "^\\| PB-[0-9]{4} \\|", before: 1144, after: 1, tip_relation: "equal-to-after" };
  const result = evaluateMeasurement(impossible, { commit, root: ROOT, routerCeiling: 12000 });
  assert.ok(result.findings.some((row) => row.includes("reviewed after 1")));
  const ceiling = evaluateMeasurement({ id: "router", kind: "blob-bytes", path: "AGENTS.md", before: 322384, after: 6115, tip_relation: "at-most-router-ceiling" }, { commit: built.receipt.migrations.find((row) => row.id === "rcp-02-root-router").migration_commit, root: ROOT, routerCeiling: 10 });
  assert.ok(ceiling.findings.some((row) => row.includes("exceeds the router ceiling")));
});

test("the migration exhibits show control-plane content leaving and never returning", () => {
  const byId = Object.fromEntries(built.receipt.migrations.map((row) => [row.id, row]));
  const planning = byId["rcp-01-shadow-planning"];
  for (const rule of ["rollout-register", "temporal-intent", "owner-confirmation", "repo-only-card-heading"]) {
    assert.ok(planning.control_plane_findings_before[rule] > 0, `${rule} should exist before the migration`);
    assert.equal(planning.control_plane_findings_after[rule], undefined, `${rule} should be gone after the migration`);
  }
  const evidence = byId["rcp-03-private-evidence"];
  assert.equal(evidence.control_plane_findings_before["private-evidence-scheme"], 50);
  assert.equal(evidence.control_plane_findings_before["internal-research-id"], 1);
  assert.deepEqual(evidence.control_plane_findings_after, {});
  assert.deepEqual(built.receipt.tip_control_plane_findings, {});
});

test("no bounded migration changed a served artifact", () => {
  assert.equal(built.receipt.served_artifacts.total_changed_paths, 0);
  assert.deepEqual(built.receipt.served_artifacts.authorized_changes, []);
  for (const migration of built.receipt.migrations) {
    assert.deepEqual(servedDeltaPaths(migration.migration_commit, { root: ROOT }), [], migration.id);
  }
});

test("retained architecture-evidence projections resolve at the tip", () => {
  assert.deepEqual(built.receipt.retained_evidence.unresolved_projections, []);
  assert.ok(built.receipt.retained_evidence.projection_count > 0);
  const missing = retainedShardFindings({ root: ROOT, projections: [{ card: "example/card", path: "docs/does-not-exist.json" }] });
  assert.ok(missing.findings.some((row) => row.includes("does not resolve")));
});

test("every privatized disposition names one authorized-maintainer resolution", () => {
  assert.equal(built.receipt.private_access.public_url_resolutions, 0);
  assert.equal(built.receipt.private_access.payload_published, false);
  assert.deepEqual(built.receipt.private_access.resolutions, ["register:cityscroll-engineering/private-generated-evidence-placement#authorized-maintainer-access"]);
  const expected = { resolution_scheme: "register", expected_resolution: "register:cityscroll-engineering/private-generated-evidence-placement#authorized-maintainer-access", expected_disposition_count: 1 };
  const invented = privateAccessFindings({
    placement: {
      private_inventory: {
        private_reference_documents: [],
        scrim_review: { source_path_at_inspected_commit: "docs/repository-scrim-review.md", maintainer_resolution: "https://example.org/private-evidence" },
      },
      public_result: { private_reference_occurrences_retained_in_public_content: 0 },
    },
    expected,
  });
  assert.ok(invented.findings.some((row) => row.includes("must not resolve through a public URL")));
});

test("history is immutable and every migration commit is still reachable", () => {
  assert.equal(built.receipt.history.decision, "no-rewrite");
  assert.equal(built.receipt.history.security_or_legal_exception, null);
  assert.equal(built.receipt.history.migration_commits_reachable_from_head, MIGRATION_KEYS.length);
  assert.match(built.receipt.history.public_history_statement, /does not make earlier public history private/);
  for (const migration of built.receipt.migrations) {
    assert.equal(commitReachable(migration.migration_commit, { root: ROOT }), true, migration.id);
  }
  assert.equal(commitReachable("0000000000000000000000000000000000000000", { root: ROOT }), false);
});

test("coverage deltas between the manifest and the migrations stay reconciled and lossless", () => {
  const coverage = built.receipt.coverage_reconciliation;
  assert.equal(coverage.classification_entry_count, classification.entries.length);
  assert.ok(coverage.deltas.length > 0);
  for (const delta of coverage.deltas) {
    assert.equal(delta.state, "reconciled", delta.id);
    assert.equal(delta.loss, "none", delta.id);
    assert.ok(MIGRATION_KEYS.includes(delta.executing_migration), delta.id);
  }
  assert.deepEqual(coverage.stopped_or_deferred, []);
});

test("the derived receipt names the inputs it aggregated and stays credential free", () => {
  assert.equal(built.receipt.materialization.mode, "derived-at-check-time");
  assert.equal(built.receipt.materialization.tracked_aggregate, false);
  assert.deepEqual(built.receipt.materialization.shards, [...EXPECTED_KEYS].sort());
  assert.equal(built.receipt.inputs.credential_free, true);
  assert.equal(built.receipt.inputs.source_card_inventory_schema, "cityscroll.card-inventory.v1");
  assert.ok(shardPathForId("history-decision").endsWith("cutover.d/history-decision.json"));
});
