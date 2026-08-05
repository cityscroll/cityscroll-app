// Characterization for deterministic pair features + conventional matcher v1.
//
// VI-03: expanded gold_v1 adds typo/truncation/abbreviation/DBA/alias/successor
// strata. Matcher-only and pipeline (matcher + policy + alias registry) metrics
// are both characterized.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  FEATURES_VERSION,
  extractDba,
  extractFeatures,
} from "../../entity_resolution/features/index.mjs";
import {
  MATCHERS_VERSION,
  scorePair,
} from "../../entity_resolution/matchers/index.mjs";
import {
  POLICIES_VERSION,
  lookupAlias,
  routeDecision,
} from "../../entity_resolution/policies/index.mjs";
import {
  computeMetrics,
  loadGold,
  predictWithMatcher,
  predictWithPipeline,
  runBlocker,
} from "../../entity_resolution/eval/run_metrics.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const GOLD = join(ROOT, "entity_resolution/eval/gold_v1.jsonl");
const { cases } = loadGold(readFileSync(GOLD, "utf8"));
const goldCase = (id) => cases.find((row) => row.id === id);

function scoreGold(id) {
  const row = goldCase(id);
  const features = extractFeatures(row.left, row.right, {
    entityType: row.entity_type,
  });
  return { features, score: scorePair(row.left, row.right, features) };
}

test("feature and matcher versions identify scoped authority-key scoring", () => {
  assert.equal(FEATURES_VERSION, "pair_features_v2");
  assert.equal(MATCHERS_VERSION, "conventional_v2");
  assert.equal(POLICIES_VERSION, "conservative_v1");
});

test("HNTB truncation is same through shared PIN hard evidence", () => {
  const { features, score } = scoreGold("gv0-001");
  assert.equal(features.pin_epin_equal, true);
  assert.ok(features.token_jaccard > 0);
  assert.ok(features.length_ratio > 0 && features.length_ratio <= 1);
  assert.equal(score.decision, "same");
  assert.equal(score.method, "scoped_authority_key_equal_v1");
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
  // Matcher-only: no false merges ever.
  assert.equal(metrics.precision, 1);
  assert.equal(metrics.false_merge, 0);
  assert.equal(metrics.candidate_recall, 1);
  // Matcher-only leaves alias/DBA/successor cases unresolved (false splits).
  // The pipeline (policy + alias registry) resolves those.
  assert.ok(metrics.false_split > 0, "matcher-only should leave alias cases unresolved");
  assert.ok(metrics.recall < 1, "matcher-only recall should be below 1 for alias strata");
});

test("pipeline (matcher + policy + alias registry) closes all false splits", () => {
  const blocker = runBlocker("token_v0", cases);
  const predictions = predictWithPipeline(cases, blocker.candidateIds);
  const metrics = computeMetrics(cases, predictions, blocker.candidateIds);
  assert.equal(metrics.precision, 1);
  assert.equal(metrics.false_merge, 0);
  // Agency rename residual closed: DoITT→OTI, DA county↔borough, Business→SBS.
  assert.equal(metrics.false_split, 0);
  assert.equal(metrics.recall, 1);
  assert.equal(metrics.candidate_recall, 1);
});

test("agency rename pairs resolve same without merging distinct DA offices", () => {
  for (const id of ["gv0-026", "gv0-030", "gv0-032"]) {
    const { features, score } = scoreGold(id);
    assert.equal(features.stem_equal, true, `${id} must share agency canonical stem`);
    assert.equal(score.decision, "same", `${id} must score same`);
  }
  const boroughTrap = scoreGold("gv0-031");
  assert.equal(boroughTrap.features.stem_equal, false);
  assert.equal(boroughTrap.score.decision, "different");
});

// --- VI-03 feature and policy tests ---

test("typo proximity catches single-character spelling variants", () => {
  const { features, score } = scoreGold("gv1-037");
  assert.equal(features.typo_proximity.close, true);
  assert.equal(score.decision, "same");
  assert.equal(score.method, "vendor_typo_proximity_v1");
});

test("typo proximity catches letter-insertion variants", () => {
  const { features, score } = scoreGold("gv1-038");
  assert.equal(features.typo_proximity.close, true);
  assert.equal(score.decision, "same");
});

test("typo proximity catches transposition variants", () => {
  const { features, score } = scoreGold("gv1-039");
  assert.equal(features.typo_proximity.close, true);
  assert.equal(score.decision, "same");
});

test("stem truncation catches checkbook field-length truncation", () => {
  for (const id of ["gv1-040", "gv1-041"]) {
    const { features, score } = scoreGold(id);
    assert.equal(features.stem_truncation, true, `${id} must detect truncation`);
    assert.equal(score.decision, "same");
    assert.equal(score.method, "vendor_truncation_v1");
  }
});

test("abbreviation expansion catches center/cntr and eng/engineering", () => {
  for (const id of ["gv1-042", "gv1-043", "gv1-044"]) {
    const { features, score } = scoreGold(id);
    assert.ok(features.abbreviation_matches > 0, `${id} must have abbreviation match`);
    assert.equal(score.decision, "same");
    assert.equal(score.method, "vendor_abbreviation_v1");
  }
});

test("unsafe-granularity different traps do not false-merge via proximity", () => {
  for (const id of ["gv1-051", "gv1-052", "gv1-053", "gv1-054", "gv1-055", "gv1-056"]) {
    const { score } = scoreGold(id);
    assert.notEqual(score.decision, "same", `${id} must not be predicted same`);
  }
});

test("DBA extraction parses DBA/FKA/AKA notation", () => {
  const dba = extractDba("Northstar Consulting DBA Northstar Partners");
  assert.equal(dba.primary, "Northstar Consulting");
  assert.equal(dba.alias, "Northstar Partners");
  assert.equal(dba.separator, "DBA");

  const none = extractDba("Plain Vendor Name LLC");
  assert.equal(none, null);
});

test("alias registry lookup resolves reviewed alias pairs", () => {
  const entry = lookupAlias("Summit Security Group LLC", "Summit Security");
  assert.ok(entry, "alias-003 should resolve");
  assert.equal(entry.label, "verified_alias");
});

test("alias registry lookup resolves successor pairs across legal-form change", () => {
  const entry = lookupAlias(
    "Metropolitan Building Services Inc.",
    "Metropolitan Building Services LLC",
  );
  assert.ok(entry, "alias-002 should resolve");
  assert.equal(entry.label, "successor");
});

test("policy routes matcher-same to auto_link", () => {
  const routed = routeDecision(
    { decision: "same", confidence: 0.985, method: "vendor_stem_equal_v0" },
    {},
  );
  assert.equal(routed.decision, "same");
  assert.equal(routed.auto_link, true);
});

test("policy routes unresolved without registry match to no auto-link", () => {
  const routed = routeDecision(
    { decision: "unresolved", confidence: 0.6, method: "vendor_similarity_v0" },
    { left: { display_name: "Unknown A" }, right: { display_name: "Unknown B" }, entityType: "vendor" },
  );
  assert.equal(routed.decision, "unresolved");
  assert.equal(routed.auto_link, false);
});

test("policy overrides legal-form-conflict different with alias registry successor", () => {
  const routed = routeDecision(
    { decision: "different", confidence: 0.97, method: "vendor_legal_form_conflict_v0" },
    {
      left: { display_name: "Metropolitan Building Services Inc." },
      right: { display_name: "Metropolitan Building Services LLC" },
      entityType: "vendor",
    },
  );
  assert.equal(routed.decision, "same");
  assert.equal(routed.auto_link, true);
  assert.equal(routed.alias_label, "successor");
});

test("policy never overrides hard-id-conflict different", () => {
  const routed = routeDecision(
    { decision: "different", confidence: 0.995, method: "hard_id_conflict_v0" },
    {
      left: { display_name: "Some Vendor" },
      right: { display_name: "Some Vendor" },
      entityType: "vendor",
    },
  );
  assert.equal(routed.decision, "different");
  assert.equal(routed.auto_link, false);
});
