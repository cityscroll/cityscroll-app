import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

import {
  candidateDecision,
  DEFAULT_MIN_SUPPORT,
  evaluateCrossSpineGold,
  evaluateTopicNormalizationReview,
  generateRelationCandidates,
  groupedSplit,
  loadCrossSpineGold,
  wilsonInterval,
} from "../tools/cross_spine_eval.mjs";
import { buildConstellationErAccuracyReceipt } from "../tools/build_constellation_er_accuracy_receipt.mjs";
import { LAND_USE_PROCEDURE_KINDS } from "../worker/src/lib/subject_registry.mjs";

const ROOT = resolve(new URL("..", import.meta.url).pathname);
const GOLD_PATH = resolve(ROOT, "entity_resolution/eval/cross_spine_gold_v3.jsonl");
const V2_GOLD_PATH = resolve(ROOT, "entity_resolution/eval/cross_spine_gold_v2.jsonl");
const V1_GOLD_PATH = resolve(ROOT, "entity_resolution/eval/cross_spine_gold_v1.jsonl");
const HARNESS_PATH = resolve(ROOT, "tools/cross_spine_eval.mjs");
const BUILD_PATH = resolve(ROOT, "tools/build_cross_spine_gold_v3.mjs");
const BUILD_V2_PATH = resolve(ROOT, "tools/build_cross_spine_gold_v2.mjs");
const ACCURACY_RECEIPT_PATH = resolve(ROOT, "docs/evidence/ebcg-er-accuracy/receipt.json");

function fixtureRow(id, relation, label, leftGroup, rightGroup, features) {
  return {
    id,
    relation,
    label,
    tier: "inferred",
    sources: ["left_source", "right_source"],
    groups: { left: leftGroup, right: rightGroup },
    left: { source_system: "left_source", display_name: "Left record", subject_ref: leftGroup },
    right: { source_system: "right_source", display_name: "Right record", subject_ref: rightGroup },
    features,
  };
}

const CONTRACT_FEATURES = {
  agency_exact: true,
  procurement_trigger: true,
  procurement_action_exact: true,
  subject_scope_overlap: ["shelter"],
  contract_authority_exact: true,
};

test("versioned cross-spine gold loads and evaluates every relation", () => {
  const gold = loadCrossSpineGold(readFileSync(GOLD_PATH, "utf8"));
  assert.equal(gold.meta.gold_version, "cross_spine_gold_v3");
  assert.equal(gold.cases.length, 90);
  assert.equal(gold.meta.base_gold.gold_version, "cross_spine_gold_v2");
  assert.equal(gold.meta.additions.length, 1);
  const report = evaluateCrossSpineGold({ gold, groupSplit: true });
  assert.equal(report.schema, "cityscroll.cross_spine_edge_eval.v3");
  assert.equal(report.matcher_version, "cross_spine_edge_policy_v2");
  assert.deepEqual(report.target_cohort, {
    name: "constellation_cross_spine_inferred_edges",
    gold_slice: "cross_spine_gold_v3:held_out",
    relation_count: 6,
    case_count: 90,
  });
  assert.equal(report.split.group_leakage, false);
  assert.equal(report.split.held_out_rows, 90);
  assert.deepEqual(Object.keys(report.gate).sort(), [
    "mandate_contract",
    "mandate_governs_procedure",
    "mandate_land_use",
    "mandate_meeting",
    "mandate_rule",
    "project_participates_in_procedure",
  ]);
  for (const gate of Object.values(report.gate)) {
    assert.equal(gate.status, "pass");
    assert.ok(gate.precision >= 0.9);
    assert.equal(gate.support, DEFAULT_MIN_SUPPORT);
    assert.equal(gate.support_status, "sufficient");
    assert.equal(gate.label_counts.same, 12);
    assert.equal(gate.label_counts.different, 3);
    assert.equal(gate.source_cohorts.length, 3);
    assert.equal(gate.precision_interval_95.confidence, 0.95);
    assert.ok(gate.precision_interval_95.lower < gate.precision);
  }
  for (const metric of Object.values(report.held_out)) {
    assert.equal(metric.recall, metric.coverage);
    assert.equal(metric.false_merge, 0);
    assert.equal(metric.false_split, 0);
  }
  assert.equal(report.ok, true);
  assert.equal(report.topic_normalization.registry_version, "topic_normalization_v1");
  for (const relation of ["mandate_meeting", "mandate_rule"]) {
    const metric = report.topic_normalization.held_out[relation];
    assert.ok(metric.precision >= 0.9);
    assert.ok(metric.coverage > 0);
    assert.ok(metric.abstention_rate > 0);
    assert.equal(report.topic_normalization.gate[relation].status, "pass");
  }
});

test("constellation accuracy receipt records improvements and provisional cohorts", () => {
  const gold = loadCrossSpineGold(readFileSync(GOLD_PATH, "utf8"));
  const receipt = buildConstellationErAccuracyReceipt({
    gold,
    shadowCensus: JSON.parse(readFileSync(resolve(ROOT, "site/data/cross_spine_shadow_census.json"), "utf8")),
    mandates: JSON.parse(readFileSync(resolve(ROOT, "site/data/agency_obligations_lookup.json"), "utf8")),
  });
  assert.deepEqual(receipt, JSON.parse(readFileSync(ACCURACY_RECEIPT_PATH, "utf8")));
  assert.equal(receipt.matcher.version, "cross_spine_edge_policy_v2");
  assert.equal(receipt.held_out_metrics.relation_coverage, 1);
  assert.equal(receipt.held_out_metrics.false_merge, 0);
  assert.equal(receipt.held_out_metrics.false_split, 0);
  assert.ok(receipt.public_total_contract.agency_mandates.provisional_rows_excluded > 0);
  assert.ok(receipt.publication_gate.provisional_cross_spine_candidates.evidence_only > 0);
});

test("topic normalization review reports precision, coverage, and adversarial abstention", () => {
  const report = evaluateTopicNormalizationReview();
  assert.equal(report.ok, true);
  assert.deepEqual(Object.keys(report.held_out), ["mandate_meeting", "mandate_rule"]);
  assert.equal(report.held_out.mandate_meeting.precision, 1);
  assert.equal(report.held_out.mandate_rule.precision, 1);
  assert.equal(report.held_out.mandate_meeting.false_positive, 0);
  assert.equal(report.held_out.mandate_rule.false_positive, 0);
  assert.ok(report.held_out.mandate_meeting.abstentions >= 3);
  assert.ok(report.held_out.mandate_rule.abstentions >= 2);
});

test("v3 procedure cases deterministically extend the immutable v2 gold", () => {
  const result = spawnSync(process.execPath, [BUILD_PATH, "--check"], { cwd: ROOT, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /cross_spine_gold_v3=clean cases=90/);
  const v2 = spawnSync(process.execPath, [BUILD_V2_PATH, "--check"], { cwd: ROOT, encoding: "utf8" });
  assert.equal(v2.status, 0, v2.stderr);
  assert.match(v2.stdout, /cross_spine_gold_v2=clean cases=60/);
});

test("every cross-spine field case resolves to a committed publisher record or procedure kind", () => {
  const gold = loadCrossSpineGold(readFileSync(GOLD_PATH, "utf8"));
  const obligations = JSON.parse(readFileSync(resolve(ROOT, "site/data/agency_obligations_lookup.json"), "utf8"));
  const obligationIds = new Set(Object.values(obligations.by_agency)
    .flatMap((bucket) => bucket.obligations || [])
    .map((row) => row.obligation_id));
  const contracts = JSON.parse(readFileSync(resolve(ROOT, "site/data/procurement_spine_sources.json"), "utf8"));
  const contractIds = new Set((contracts.rows.passport_contracts || []).map((row) => row.contract_id));
  const meetingIds = new Set(JSON.parse(readFileSync(resolve(ROOT, "site/data/meetings_domain_observations.json"), "utf8"))
    .rows.map((row) => row.request_id));
  const ruleIds = new Set(JSON.parse(readFileSync(resolve(ROOT, "site/data/rules_domain_observations.json"), "utf8"))
    .rows.map((row) => row.request_id));
  const projectIds = new Set(JSON.parse(readFileSync(resolve(ROOT, "site/data/zap_projects_warehouse_lookup.json"), "utf8"))
    .rows.map((row) => row.project_id));

  for (const row of gold.cases) {
    assert.match(row.left.source_url, /^https:\/\//);
    assert.match(row.right.source_url, /^https:\/\//);
    if (row.left.source_system === "nyc_legistar") {
      assert.ok(obligationIds.has(row.left.subject_ref.replace(/^mandate:/, "")), row.id);
    }
    if (row.relation === "mandate_contract") {
      assert.ok(contractIds.has(row.right.subject_ref.replace(/^contract:/, "")), row.id);
    } else if (row.relation === "mandate_meeting") {
      assert.ok(meetingIds.has(row.right.subject_ref.replace(/^meeting:/, "")), row.id);
    } else if (row.relation === "mandate_rule") {
      assert.ok(ruleIds.has(row.right.subject_ref.replace(/^rule:/, "")), row.id);
    } else if (row.relation === "mandate_land_use") {
      assert.ok(projectIds.has(row.right.subject_ref.replace(/^project:/, "")), row.id);
    } else if (row.relation === "mandate_governs_procedure") {
      assert.ok(LAND_USE_PROCEDURE_KINDS.includes(row.right.subject_ref.replace(/^procedure:/, "")), row.id);
    } else if (row.relation === "project_participates_in_procedure") {
      assert.ok(projectIds.has(row.left.subject_ref.replace(/^project:/, "")), row.id);
      assert.ok(LAND_USE_PROCEDURE_KINDS.includes(row.right.subject_ref.replace(/^procedure:/, "")), row.id);
    }
  }
});

test("v2 remains immutable after procedure relations move to v3", () => {
  const gold = loadCrossSpineGold(readFileSync(V2_GOLD_PATH, "utf8"));
  assert.equal(gold.meta.gold_version, "cross_spine_gold_v2");
  assert.equal(gold.cases.length, 60);
  assert.equal(gold.cases.some((row) => row.relation.includes("procedure")), false);
});

test("v1 remains immutable and cannot pass the new minimum-support gate", () => {
  const gold = loadCrossSpineGold(readFileSync(V1_GOLD_PATH, "utf8"));
  const report = evaluateCrossSpineGold({ gold, groupSplit: true });
  assert.equal(gold.meta.gold_version, "cross_spine_gold_v1");
  assert.equal(gold.cases.length, 20);
  assert.equal(report.ok, false);
  assert.ok(Object.values(report.gate).every((gate) => gate.status === "insufficient"));
});

test("candidate generation is relation-specific and does not inspect labels", () => {
  const positive = fixtureRow("positive", "mandate_contract", "same", "m:1", "c:1", CONTRACT_FEATURES);
  const negativeWithSameEvidence = fixtureRow("negative", "mandate_contract", "different", "m:2", "c:2", CONTRACT_FEATURES);
  const weak = fixtureRow("weak", "mandate_contract", "same", "m:3", "c:3", { ...CONTRACT_FEATURES, contract_authority_exact: false });
  assert.equal(candidateDecision(positive).candidate, true);
  assert.equal(candidateDecision(negativeWithSameEvidence).candidate, true);
  assert.equal(candidateDecision(weak).candidate, false);
  assert.deepEqual(generateRelationCandidates([positive, negativeWithSameEvidence, weak]).map((row) => row.id), ["positive", "negative"]);
});

test("deterministic tier is reported separately from inferred candidates", () => {
  const row = fixtureRow("deterministic", "mandate_contract", "same", "m:1", "c:1", CONTRACT_FEATURES);
  row.tier = "deterministic";
  assert.equal(candidateDecision(row).tier, "deterministic");
  assert.equal(candidateDecision(row).candidate, false);
  assert.deepEqual(generateRelationCandidates([row]), []);
});

test("group split keeps shared endpoint groups on one side", () => {
  const rows = [
    fixtureRow("a", "mandate_contract", "same", "mandate:shared", "contract:a", CONTRACT_FEATURES),
    fixtureRow("b", "mandate_contract", "different", "mandate:shared", "contract:b", { ...CONTRACT_FEATURES, contract_authority_exact: false }),
    fixtureRow("c", "mandate_contract", "same", "mandate:other", "contract:c", CONTRACT_FEATURES),
  ];
  const split = groupedSplit(rows);
  const assignment = new Map(split.assignments.map((row) => [row.id, row]));
  assert.equal(assignment.get("a").split, assignment.get("b").split);
  assert.equal(split.group_leakage, undefined);
  const trainGroups = new Set(split.trainGroups);
  for (const group of split.heldOutGroups) assert.equal(trainGroups.has(group), false);
});

test("frozen split assignments still isolate an entire connected component", () => {
  const a = fixtureRow("a", "mandate_contract", "same", "mandate:shared", "contract:a", CONTRACT_FEATURES);
  const b = fixtureRow("b", "mandate_contract", "different", "mandate:shared", "contract:b", CONTRACT_FEATURES);
  a.evaluation_split = "held_out";
  b.evaluation_split = "held_out";
  const split = groupedSplit([a, b]);
  assert.deepEqual(split.assignments.map((row) => row.split), ["held_out", "held_out"]);
  b.evaluation_split = "train";
  assert.throws(() => groupedSplit([a, b]), /conflicting evaluation_split/);
});

test("precision gate fails on a held-out false positive", () => {
  const rows = [
    fixtureRow("true", "mandate_contract", "same", "m:true", "contract:true", CONTRACT_FEATURES),
    fixtureRow("false", "mandate_contract", "different", "m:false", "contract:false", CONTRACT_FEATURES),
  ];
  const report = evaluateCrossSpineGold({
    gold: { meta: { gold_version: "test" }, contentHash: "test", cases: rows },
    groupSplit: false,
  });
  assert.equal(report.gate.mandate_contract.precision, 0.5);
  assert.equal(report.ok, false);
});

test("perfect point precision below twelve held-out predictions is insufficient", () => {
  const rows = Array.from({ length: DEFAULT_MIN_SUPPORT - 1 }, (_, index) => fixtureRow(
    `support-${index}`,
    "mandate_contract",
    "same",
    `m:${index}`,
    `contract:${index}`,
    CONTRACT_FEATURES,
  ));
  const report = evaluateCrossSpineGold({
    gold: { meta: { gold_version: "test" }, contentHash: "test", cases: rows },
    groupSplit: false,
  });
  assert.equal(report.gate.mandate_contract.precision, 1);
  assert.equal(report.gate.mandate_contract.support, 11);
  assert.equal(report.gate.mandate_contract.status, "insufficient");
  assert.equal(report.ok, false);
});

test("Wilson uncertainty is reported separately from the point-precision gate", () => {
  const interval = wilsonInterval(12, 12);
  assert.equal(interval.confidence, 0.95);
  assert.equal(interval.method, "wilson_score");
  assert.ok(Math.abs(interval.lower - 0.7575059933447592) < 1e-12);
  assert.equal(interval.upper, 1);
});

test("CLI check reports relation precision, coverage, abstention, and leakage status", () => {
  const result = spawnSync(process.execPath, [HARNESS_PATH, "--gold", GOLD_PATH, "--group-split", "--check"], {
    cwd: ROOT,
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /relation=mandate_contract/);
  assert.match(result.stdout, /precision=1/);
  assert.match(result.stdout, /support=12\/12/);
  assert.match(result.stdout, /interval95=\[/);
  assert.match(result.stdout, /coverage=1/);
  assert.match(result.stdout, /abstention=/);
  assert.match(result.stdout, /topic_normalization=topic_normalization_v1 relation=mandate_meeting precision=1/);
  assert.match(result.stdout, /topic_normalization=topic_normalization_v1 relation=mandate_rule precision=1/);
  assert.match(result.stdout, /group_split=true leakage=false ok=true/);
});

test("relation-scoped CLI check does not compare against the all-relations receipt", () => {
  const result = spawnSync(process.execPath, [
    HARNESS_PATH,
    "--gold", GOLD_PATH,
    "--relation", "mandate_contract",
    "--min-precision", "0.90",
    "--check",
  ], { cwd: ROOT, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /relation=mandate_contract/);
  assert.match(result.stdout, /group_split=true leakage=false ok=true/);
});

test("malformed gold cannot silently skip relation groups", () => {
  const malformed = JSON.stringify({
    _meta: true,
    gold_version: "bad",
    schema_version: 1,
    case_count: 1,
  }) + "\n" + JSON.stringify({
    id: "missing-groups",
    relation: "mandate_contract",
    label: "same",
    sources: ["source"],
    left: { source_system: "source", display_name: "Left" },
    right: { source_system: "source", display_name: "Right" },
  });
  assert.throws(() => loadCrossSpineGold(malformed), /groups\.(left|right)/);
});
