import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  DEFAULT_CROSS_SPINE_EDGE_POLICY,
  CROSS_SPINE_EDGE_TIERS,
  checkCrossSpineEdgePolicy,
  routeCrossSpineEdge,
  routeCrossSpineEdges,
} from "../entity_resolution/cross_domain/edge_policy.mjs";
import {
  evaluateCrossSpineGold,
  loadCrossSpineGold,
} from "../tools/cross_spine_eval.mjs";

const GOLD_PATH = new URL("../entity_resolution/eval/cross_spine_gold_v1.jsonl", import.meta.url);

const inferredFeatures = {
  agency_exact: true,
  expected_event_match: true,
  topic_overlap: ["commercial", "waste"],
  rule_body_overlap: ["commercial", "waste"],
  citation_law_match: true,
  temporal_compatible: true,
  negative_evidence_free: true,
};

test("routes exact publisher keys to deterministic regardless of inferred features", () => {
  const route = routeCrossSpineEdge({
    relation: "mandate_rule",
    tier: "deterministic_exact_key",
    provenance: { join_key: "ulurp_number", join_value: "2022M0258", match: "exact" },
  });
  assert.equal(route.tier, "deterministic");
  assert.equal(route.public, true);
  assert.equal(route.reason, "exact_publisher_key");
});

test("publishes only relation candidates behind the held-out gate", () => {
  const route = routeCrossSpineEdge({ relation: "mandate_rule", features: inferredFeatures });
  assert.equal(route.tier, "public_inferred");
  assert.equal(route.public, true);
  assert.equal(route.gate.relation, "mandate_rule");
  assert.equal(route.gate.min_precision, 0.9);
});

test("uncertain candidates become shadow evidence and never a public edge", () => {
  const route = routeCrossSpineEdge({
    relation: "mandate_rule",
    id: "candidate-uncertain",
    features: { agency_exact: true, topic_overlap: ["rule"] },
    provenance: { source_system: "city_record", source_record_id: "rule-1" },
  });
  assert.equal(route.tier, "evidence_only");
  assert.equal(route.public, false);
  assert.equal(route.shadow.candidate.id, "candidate-uncertain");
});

test("contradictions and unsupported relations route to no_edge without review work", () => {
  const conflict = routeCrossSpineEdge({
    relation: "mandate_rule",
    features: { conflict: true },
    decision: "different",
  });
  const unknown = routeCrossSpineEdge({ relation: "mandate_vendor", features: { agency_exact: true } });
  assert.equal(conflict.tier, "no_edge");
  assert.equal(unknown.tier, "no_edge");
  assert.equal(conflict.review, undefined);
  assert.equal(unknown.review, undefined);
});

test("batch routing partitions every candidate into exactly one tier", () => {
  const result = routeCrossSpineEdges([
    { tier: "deterministic", provenance: { join_key: "bbl", join_value: "1006440001" } },
    { relation: "mandate_rule", features: inferredFeatures },
    { relation: "mandate_rule", features: { agency_exact: true }, provenance: { source_system: "cr", source_record_id: "2" } },
    { relation: "unsupported", features: { anything: true } },
  ]);
  assert.equal(result.routes.length, 4);
  assert.equal(Object.values(result.counts).reduce((sum, count) => sum + count, 0), 4);
  assert.deepEqual(Object.keys(result.counts).sort(), [...CROSS_SPINE_EDGE_TIERS].sort());
  assert.equal(result.public_edges.length, 2);
  assert.equal(result.shadow_edges.length, 1);
  assert.equal(result.no_edge.length, 1);
});

test("policy check binds the router to the immutable grouped holdout", () => {
  const gold = loadCrossSpineGold(readFileSync(GOLD_PATH, "utf8"));
  const report = evaluateCrossSpineGold({ gold, groupSplit: true });
  const check = checkCrossSpineEdgePolicy(report);
  assert.equal(check.ok, true);
  assert.equal(check.policy.min_held_out_precision, DEFAULT_CROSS_SPINE_EDGE_POLICY.min_held_out_precision);
  assert.equal(check.policy.gold_version, DEFAULT_CROSS_SPINE_EDGE_POLICY.gold_version);
});
