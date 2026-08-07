import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { extractFeatures, FEATURES_VERSION } from "../entity_resolution/features/index.mjs";
import { loadGold, runBlocker } from "../entity_resolution/eval/run_metrics.mjs";
import {
  buildBakeoffReport,
  evaluateScorer,
  scoreGoldWithScorer,
} from "../entity_resolution/evaluation/bakeoff.mjs";
import {
  createScorer,
  conventionalV2Scorer,
  scoreCandidatePairs,
} from "../entity_resolution/index.mjs";
import { scorePair } from "../entity_resolution/matchers/index.mjs";

const gold = loadGold(readFileSync("entity_resolution/eval/gold_v1.jsonl", "utf8"));
const blocked = runBlocker("token_v0", gold.cases);

test("conventional_v2 remains available through the compatibility matcher path", () => {
  const left = { display_name: "Acme Widgets Inc", entity_type: "vendor" };
  const right = { display_name: "ACME WIDGETS INCORPORATED", entity_type: "vendor" };
  const features = extractFeatures(left, right, { entityType: "vendor" });
  const legacy = scorePair(left, right, features);
  const scored = scoreCandidatePairs({
    features_version: FEATURES_VERSION,
    candidate_pairs: [{ pair_id: "compat", left, right, entity_type: "vendor", features }],
  }, conventionalV2Scorer)[0];
  assert.equal(scored.probability, legacy.confidence);
  assert.equal(scored.evidence.decision, legacy.decision);
  assert.equal(scored.evidence.method, legacy.method);
});

test("a removable scorer only needs versioned features in and probability/evidence out", () => {
  let received = null;
  const scorer = createScorer({
    name: "test_scorer",
    version: "test_scorer_v1",
    scoreBatch(input) {
      received = input;
      return input.candidate_pairs.map((pair) => ({
        pair_id: pair.pair_id,
        probability: pair.features.stem_equal ? 0.99 : 0.01,
        evidence: { reason: "test", features_version: input.features_version },
      }));
    },
  });
  const left = { display_name: "Alpha LLC", entity_type: "vendor" };
  const right = { display_name: "Alpha LLC", entity_type: "vendor" };
  const features = extractFeatures(left, right, { entityType: "vendor" });
  const output = scoreCandidatePairs({
    features_version: FEATURES_VERSION,
    candidate_pairs: [{ left, right, features }],
  }, scorer);
  assert.equal(received.features_version, FEATURES_VERSION);
  assert.equal(output[0].probability, 0.99);
  assert.equal(output[0].evidence.reason, "test");
  assert.equal(output[0].scorer.name, "test_scorer");
  assert.throws(() => scoreCandidatePairs({
    features_version: "wrong_features_v0",
    candidate_pairs: [{ left, right, features }],
  }, scorer), /feature version mismatch/);
});

test("bake-off measures policy-routed baseline and exposes calibration", () => {
  const scores = scoreGoldWithScorer(gold.cases, blocked.candidateIds, conventionalV2Scorer);
  const evaluated = evaluateScorer({
    cases: gold.cases,
    candidateIds: blocked.candidateIds,
    scores,
    scorer: conventionalV2Scorer,
  });
  assert.equal(evaluated.metrics.candidate_recall, 1);
  assert.equal(evaluated.metrics.precision, 1);
  assert.equal(evaluated.metrics.recall, 1);
  assert.equal(evaluated.metrics.false_merge, 0);
  assert.equal(evaluated.metrics.false_split, 0);
  assert.equal(evaluated.clusters.cluster_fragmentation_rate, 0);
  assert.equal(evaluated.clusters.constraint_violations, 0);
  const band = evaluated.calibration.find((row) => row.band === "0.95-0.99");
  assert.equal(band.n, 27);
  assert.equal(band.correct_matches, 25);
  assert.ok(band.empirical_match_rate < 1);
});

test("report refuses to declare a winner when baseline pair metrics saturate", () => {
  const scores = scoreGoldWithScorer(gold.cases, blocked.candidateIds, conventionalV2Scorer);
  const baseline = evaluateScorer({
    cases: gold.cases,
    candidateIds: blocked.candidateIds,
    scores,
    scorer: conventionalV2Scorer,
  });
  const report = buildBakeoffReport({
    gold,
    contentHash: gold.contentHash,
    candidateIds: blocked.candidateIds,
    contenders: [baseline],
  });
  assert.equal(report.honesty.baseline_pair_metrics_saturated, true);
  assert.equal(report.recommendation.decision, "insufficient_evidence");
  assert.match(report.recommendation.text, /unresolved clerical-review stratum/);
});
