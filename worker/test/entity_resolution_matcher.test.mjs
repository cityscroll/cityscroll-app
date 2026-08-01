// Characterization for deterministic pair features + conventional matcher v0.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  FEATURES_VERSION,
  extractFeatures,
} from "../../entity_resolution/features/index.mjs";
import {
  MATCHERS_VERSION,
  scorePair,
} from "../../entity_resolution/matchers/index.mjs";
import {
  computeMetrics,
  loadGold,
  predictWithMatcher,
  runBlocker,
} from "../../entity_resolution/eval/run_metrics.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const GOLD = join(ROOT, "entity_resolution/eval/gold_v0.jsonl");
const { cases } = loadGold(readFileSync(GOLD, "utf8"));
const goldCase = (id) => cases.find((row) => row.id === id);

function scoreGold(id) {
  const row = goldCase(id);
  const features = extractFeatures(row.left, row.right, {
    entityType: row.entity_type,
  });
  return { features, score: scorePair(row.left, row.right, features) };
}

test("feature and matcher versions identify v0 conventional scoring", () => {
  assert.equal(FEATURES_VERSION, "pair_features_v0");
  assert.equal(MATCHERS_VERSION, "conventional_v0");
});

test("HNTB truncation is same through shared PIN hard evidence", () => {
  const { features, score } = scoreGold("gv0-001");
  assert.equal(features.pin_epin_equal, true);
  assert.ok(features.token_jaccard > 0);
  assert.ok(features.length_ratio > 0 && features.length_ratio <= 1);
  assert.equal(score.decision, "same");
  assert.equal(score.method, "pin_epin_equal_v0");
  assert.equal(score.confidence, 0.995);
});

test("PIN and EPIN share one identifier family", () => {
  const row = goldCase("gv0-035");
  const { features, score } = scoreGold("gv0-035");
  assert.deepEqual(features.shared_pin_epin, [row.left.attrs.pin]);
  assert.equal(features.pin_epin_equal, true);
  assert.equal(score.decision, "same");
});

test("CAMBA legal suffix variants are same through vendor stem", () => {
  const { features, score } = scoreGold("gv0-003");
  assert.equal(features.stem_equal, true);
  assert.equal(features.left_stem, "CAMBA");
  assert.equal(score.decision, "same");
  assert.equal(score.method, "vendor_stem_equal_v0");
});

test("different-entity traps do not auto-same", () => {
  const legalFormTrap = scoreGold("gv0-017");
  assert.equal(legalFormTrap.features.legal_form_conflict, true);
  assert.equal(legalFormTrap.score.decision, "different");

  const procurementTrap = scoreGold("gv0-036");
  assert.equal(procurementTrap.features.pin_epin_conflict, true);
  assert.equal(procurementTrap.score.decision, "different");

  const overlapTrap = scoreGold("gv0-007");
  assert.equal(overlapTrap.score.decision, "unresolved");
});

test("built-in matcher yields numeric metrics while preserving candidate recall", () => {
  const blocker = runBlocker("token_v0", cases);
  const predictions = predictWithMatcher(cases, blocker.candidateIds);
  const metrics = computeMetrics(cases, predictions, blocker.candidateIds);
  for (const key of ["precision", "recall", "unresolved_rate", "false_merge", "false_split"]) {
    assert.equal(typeof metrics[key], "number", `${key} must be numeric`);
  }
  assert.equal(metrics.precision, 1);
  assert.equal(metrics.false_merge, 0);
  assert.ok(metrics.recall > 0.85);
  assert.ok(metrics.false_split > 0, "unresolved true matches remain visible as false splits");
  assert.ok(metrics.candidate_recall > 0.93);
});
