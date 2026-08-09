/**
 * Warehouse entity-intelligence edge index (join layer).
 *
 * verify:
 *   node --test test/warehouse_entity_intelligence_index.test.mjs test/cross_domain_object_links.test.mjs
 *   node warehouse/lib/entity_intelligence_index.mjs --from-fixture --limit 200
 *   node warehouse/lib/entity_intelligence_index.mjs --check
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

import {
  buildEntityIntelligenceIndex,
  flattenIndexToEdges,
  flattenIndexToRoots,
  collectFixtureObservations,
  writeIndexProof,
  ENTITY_INTELLIGENCE_INDEX_VERSION,
  lookupFromIndex,
} from "../warehouse/lib/entity_intelligence_index.mjs";
import { indexObservationsByRoot } from "../entity_resolution/cross_domain/index.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
describe("warehouse entity intelligence index", () => {
  it("indexes roots and join-key edges from fixture observations", () => {
    const observations = collectFixtureObservations(ROOT, { limit: 400 });
    assert.ok(observations.length > 10);
    const index = indexObservationsByRoot(observations);
    const edges = flattenIndexToEdges(index, { max_edges: 5000 });
    const roots = flattenIndexToRoots(index, { max_roots: 100 });
    assert.ok(edges.length > 0);
    assert.ok(roots.length > 0);
    assert.ok(edges.every((e) => e.source_system && e.source_record_id));
    const types = new Set(edges.map((e) => e.link_type));
    // Identity + at least one join-key family from fixtures
    assert.ok(types.has("published_by_agency") || types.has("named_vendor"));
    assert.ok(
      types.has("sited_on_parcel")
        || types.has("shares_authority_key")
        || types.has("references_contract")
        || types.has("paid_to_vendor"),
      `expected join-key type, got ${[...types].join(",")}`,
    );
  });

  it("retains every relation shape before filling a capped edge index", () => {
    const link = (type, root) => ({
      type,
      from: root,
      to: `${root}:${type}`,
      domain: "money",
      provenance: { source_system: "fixture", source_record_id: `${root}:${type}` },
    });
    const index = new Map([
      ["agency:a", { root: { kind: "agency" }, links: [link("named_vendor", "agency:a"), link("references_contract", "agency:a")] }],
      ["vendor:z", { root: { kind: "vendor" }, links: [link("paid_to_vendor", "vendor:z")] }],
    ]);
    const edges = flattenIndexToEdges(index, { max_edges: 3 });
    assert.deepEqual(
      [...new Set(edges.map((edge) => edge.link_type))].sort(),
      ["named_vendor", "paid_to_vendor", "references_contract"],
    );
  });

  it("buildEntityIntelligenceIndex is self-consistent for Parks demo", () => {
    const observations = collectFixtureObservations(ROOT, { limit: 400 });
    const doc = buildEntityIntelligenceIndex(observations, {
      max_entities: 40,
      max_per_domain: 6,
    });
    assert.equal(doc.version, ENTITY_INTELLIGENCE_INDEX_VERSION);
    assert.ok(doc.join_key_edge_count >= 1);
    assert.ok(doc.multi_domain_count >= 1);
    const parks = lookupFromIndex(doc, {
      kind: "agency",
      name: "Parks and Recreation",
    });
    assert.equal(parks.ok, true);
    assert.equal(parks.root.ref, "agency:id:parks-and-recreation");
    assert.ok(parks.metrics.domains_matched >= 3);
  });

  it("proof receipt exists after materialize (or can be written)", () => {
    const generated = join(ROOT, ".generated");
    mkdirSync(generated, { recursive: true });
    const proofPath = join(mkdtempSync(join(generated, "warehouse-ei-proof-test-")), "proof.json");
    const observations = collectFixtureObservations(ROOT, { limit: 400 });
    const doc = buildEntityIntelligenceIndex(observations, {
      max_entities: 40,
      max_per_domain: 6,
    });
    const proof = writeIndexProof(doc, proofPath);
    assert.ok(existsSync(proofPath));
    assert.equal(proof.version, ENTITY_INTELLIGENCE_INDEX_VERSION);
    assert.ok(proof.edge_count > 0);
    assert.ok(proof.join_key_edge_count > 0);
    const disk = JSON.parse(readFileSync(proofPath, "utf8"));
    assert.equal(disk.root_count, proof.root_count);
  });
});
