import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

import {
  candidateDecision,
  evaluateCrossSpineGold,
  generateRelationCandidates,
  groupedSplit,
  loadCrossSpineGold,
} from "../tools/cross_spine_eval.mjs";

const ROOT = resolve(new URL("..", import.meta.url).pathname);
const GOLD_PATH = resolve(ROOT, "entity_resolution/eval/cross_spine_gold_v1.jsonl");
const HARNESS_PATH = resolve(ROOT, "tools/cross_spine_eval.mjs");

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
  assert.equal(gold.meta.gold_version, "cross_spine_gold_v1");
  assert.equal(gold.cases.length, 20);
  const report = evaluateCrossSpineGold({ gold, groupSplit: true });
  assert.equal(report.schema, "cityscroll.cross_spine_edge_eval.v1");
  assert.equal(report.split.group_leakage, false);
  assert.deepEqual(Object.keys(report.gate).sort(), [
    "mandate_contract",
    "mandate_land_use",
    "mandate_meeting",
    "mandate_rule",
  ]);
  for (const gate of Object.values(report.gate)) {
    assert.equal(gate.status, "pass");
    assert.ok(gate.precision >= 0.9);
  }
  assert.equal(report.ok, true);
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

test("CLI check reports relation precision, coverage, abstention, and leakage status", () => {
  const result = spawnSync(process.execPath, [HARNESS_PATH, "--gold", GOLD_PATH, "--group-split", "--check"], {
    cwd: ROOT,
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /relation=mandate_contract/);
  assert.match(result.stdout, /precision=1/);
  assert.match(result.stdout, /coverage=1/);
  assert.match(result.stdout, /abstention=/);
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
