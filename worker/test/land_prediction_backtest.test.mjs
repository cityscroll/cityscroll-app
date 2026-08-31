import assert from "node:assert/strict";
import { test } from "node:test";

import gold from "../../test/fixtures/land_prediction_backtest/gold.v1.json" with { type: "json" };
import {
  LAND_PREDICTION_BACKTEST_SCHEMA,
  LAND_PREDICTION_BACKTEST_VERSION,
  MODEL_IDS,
  assertCutoffSafety,
  evaluateKillCriterion,
  maskFeatureVectorForModel,
  reconstructAtCutoff,
  runLandPredictionBacktest,
} from "../src/lib/land_prediction_backtest.mjs";

const receipt = runLandPredictionBacktest(gold);

test("compares four cutoff-safe models on a time-held-out frozen pack", () => {
  assert.equal(receipt.schema, LAND_PREDICTION_BACKTEST_SCHEMA);
  assert.equal(receipt.version, LAND_PREDICTION_BACKTEST_VERSION);
  assert.deepEqual(Object.keys(receipt.models), [...MODEL_IDS]);
  assert.equal(receipt.split.train_n, 16);
  assert.equal(receipt.split.test_n, 16);
  assert.equal(receipt.split.train_to, "2023-12-31");
  assert.equal(receipt.split.test_from, "2024-01-01");
  assert.equal(receipt.protocol.outcome_after_cutoff_required, true);
  for (const model of Object.values(receipt.models)) {
    assert.equal(model.held_out.n, 16);
    assert.equal(typeof model.held_out.brier_score, "number");
    assert.equal(typeof model.held_out.log_loss, "number");
    assert.equal(model.authoritative, false);
    assert.equal(model.promotion_status, "shadow_only_until_backtest_gate");
  }
});

test("quantifies incremental stance lift against baseline and formal-signal alternatives", () => {
  const baseline = receipt.models.existing_cityscroll_baseline.held_out.brier_score;
  const formal = receipt.models.baseline_plus_formal_signals.held_out.brier_score;
  const stance = receipt.models.baseline_plus_local_member_stance.held_out.brier_score;
  const full = receipt.models.full_v2.held_out.brier_score;
  assert.equal(receipt.ablations.stance_minus_baseline_brier, Number((baseline - stance).toFixed(8)));
  assert.equal(receipt.ablations.full_minus_formal_brier, Number((formal - full).toFixed(8)));
  assert.ok(stance < baseline);
  assert.ok(full < formal);
  assert.ok(receipt.models.baseline_plus_local_member_stance.by_cohort.lift.brier_score
    < receipt.models.existing_cityscroll_baseline.by_cohort.lift.brier_score);
});

test("reports stage, coverage, timing, missingness, and cohort ablations", () => {
  assert.ok(receipt.models.full_v2.by_stage.community_board);
  assert.ok(receipt.models.full_v2.by_stage.city_council);
  assert.ok(receipt.models.full_v2.by_stage.cpc);
  assert.equal(receipt.timing.stance_known, 12);
  assert.equal(receipt.timing.stance_unknown, 4);
  assert.equal(receipt.timing.late_count, 3);
  assert.ok(receipt.timing.median_lead_days > 14);
  assert.equal(receipt.models.full_v2.by_coverage.late_stance.n, 3);
  assert.equal(receipt.models.full_v2.by_cohort.sparse_stance.n, 2);
  assert.equal(receipt.models.full_v2.by_cohort.missing_features.n, 2);
  assert.equal(receipt.missingness.local_council_member_stance.unknown, 4);
  assert.ok(receipt.models.full_v2.cases.every((row) => row.snapshot_timestamp && row.feature_availability));
});

test("preserves rival hypotheses and withholds causal or literature-driven weights", () => {
  assert.equal(receipt.rival_hypotheses.adjudication, "not_identified_by_this_backtest");
  assert.equal(receipt.rival_hypotheses.causal_claim, false);
  assert.equal(receipt.rival_hypotheses.literature_weight_assigned, false);
  assert.match(receipt.rival_hypotheses.H1.claim, /defer/);
  assert.match(receipt.rival_hypotheses.H2.claim, /observes negotiations/);
  assert.equal(receipt.promotion.stance_promoted_as_major_feature, false);
  assert.equal(receipt.promotion.product_promotion_allowed, false);
  assert.equal(receipt.promotion.incumbent_authoritative, true);
  assert.equal(receipt.promotion.incumbent_contract, "land_prediction_baseline_v1");
  assert.equal(receipt.promotion.resident_facing_predictions_unchanged, true);
  assert.equal(receipt.kill_criterion.stance_promoted_as_major_feature, false);
});

test("negative leakage and invalid-cutoff controls fail closed", () => {
  assert.equal(receipt.negatives.length, 3);
  assert.ok(receipt.negatives.every((row) => row.rejected));
  assert.match(receipt.negatives[0].error, /outcome leakage/);
  assert.match(receipt.negatives[1].error, /temporal leakage/);
  assert.match(receipt.negatives[2].error, /ISO timestamp/);
  assert.throws(
    () => reconstructAtCutoff(gold.negatives[1]),
    /temporal leakage/,
  );
  assert.throws(
    () => assertCutoffSafety({
      ...gold.eligible[0],
      id: "injected-future-label",
      outcome_at: "2022-01-01T00:00:00.000Z",
    }),
    /outcome leakage/,
  );
});

test("unknown stance stays explicit and is not imputed as institutional power", () => {
  const sparse = reconstructAtCutoff(
    gold.eligible.find((row) => row.id === "test-sparse-unknown-stance-01"),
  );
  const stance = sparse.features.find((feature) => feature.key === "local_council_member_stance");
  assert.equal(stance.state, "unknown");
  assert.equal(stance.value, null);
  const masked = maskFeatureVectorForModel(sparse, "existing_cityscroll_baseline");
  const formal = masked.features.find((feature) => feature.key === "community_board_action");
  assert.equal(formal.state, "unknown");
});

test("same gold pack and model versions replay byte-identically", () => {
  const second = runLandPredictionBacktest(gold);
  assert.equal(JSON.stringify(receipt), JSON.stringify(second));
});

test("kill criterion records a null result as success without promoting stance", () => {
  const kill = evaluateKillCriterion({
    existing_cityscroll_baseline: { held_out: { brier_score: 0.22 } },
    baseline_plus_formal_signals: { held_out: { brier_score: 0.11 } },
    baseline_plus_local_member_stance: { held_out: { brier_score: 0.21 } },
    full_v2: { held_out: { brier_score: 0.109 } },
  }, {
    stance_known: 8,
    late_count: 7,
    median_lead_days: 4,
  });
  assert.equal(kill.met, true);
  assert.equal(kill.null_result_recorded_as_success, true);
  assert.equal(kill.stance_promoted_as_major_feature, false);
  assert.ok(kill.reasons.includes("no_meaningful_held_out_brier_lift_after_formal_signals"));
  assert.ok(kill.reasons.includes("stance_arrives_too_late_for_forecasting"));
});
