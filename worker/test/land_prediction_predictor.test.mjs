import assert from "node:assert/strict";
import { test } from "node:test";

import {
  LAND_PREDICTION_BASELINE_MODEL,
  LAND_PREDICTION_MODEL_VERSION,
  currentLandPredictionFallback,
  fitLandPredictionModel,
  measureLandPredictionCalibration,
  predictLandPrediction,
  predictLandUse,
  validateLandPredictionModel,
} from "../src/lib/land_prediction_predictor.mjs";
import { buildLandPredictionFeatureVector } from "../src/lib/land_prediction_features.mjs";
import { buildLandPredictionSnapshot } from "../src/lib/land_prediction_snapshot.mjs";

const CUTOFF = "2024-06-01T00:00:00.000Z";

function source(id) {
  return { url: `https://example.invalid/${id}`, record_id: id };
}

function feature(key, value, id, observedAt = "2024-05-20T00:00:00.000Z") {
  return {
    key,
    value,
    evidence_type: "official_record",
    observed_at: observedAt,
    effective_at: observedAt,
    source: source(id),
    confidence: 0.9,
  };
}

function vector(applicationId, stance, stage = "council") {
  return buildLandPredictionFeatureVector({
    application_id: applicationId,
    prediction_as_of: CUTOFF,
    procedural_stage: stage,
    features: [
      feature("application_type", "zoning_map_amendment", `${applicationId}-type`),
      feature("cpc_disposition", "approved", `${applicationId}-cpc`),
      ...(stance ? [feature("local_council_member_stance", stance, `${applicationId}-stance`)] : []),
    ],
  });
}

function trainingRow(id, outcome, stance = "support") {
  return {
    id,
    feature_vector: vector(id, stance),
    outcome,
    outcome_at: "2024-07-01T00:00:00.000Z",
  };
}

test("fits a versioned additive logistic model from historical feature vectors", () => {
  const model = fitLandPredictionModel([
    trainingRow("a", "approved", "support"),
    trainingRow("b", "approved", "support"),
    trainingRow("c", "disapproved", "oppose"),
    trainingRow("d", "modified", "oppose"),
  ]);

  assert.equal(model.model_version, LAND_PREDICTION_MODEL_VERSION);
  assert.equal(model.method, "regularized_logistic_additive");
  assert.equal(model.authoritative, false);
  assert.equal(model.promotion_status, "shadow_only_until_backtest_gate");
  assert.equal(model.training.n, 4);
  assert.equal(model.training.historical_validity.includes("strictly after"), true);
  assert.equal(typeof model.calibration.brier_score, "number");
  assert.equal(typeof model.calibration.log_loss, "number");
  assert.equal(model.calibration.bins.length, 5);
  assert.doesNotThrow(() => validateLandPredictionModel(model));
});

test("rejects outcome leakage at or before the historical snapshot cutoff", () => {
  assert.throws(
    () => fitLandPredictionModel([{
      ...trainingRow("leaked", "approved"),
      outcome_at: CUTOFF,
    }]),
    /outcome_at must be after prediction_as_of/,
  );
});

test("emits a probability, timestamp, feature states, evidence contributors, and no promotion", () => {
  const model = fitLandPredictionModel([
    trainingRow("a", "approved", "support"),
    trainingRow("b", "approved", "support"),
    trainingRow("c", "disapproved", "oppose"),
    trainingRow("d", "disapproved", "oppose"),
  ]);
  const prediction = predictLandPrediction(model, vector("new", "support"));

  assert.equal(typeof prediction.probability, "number");
  assert.ok(prediction.probability > 0 && prediction.probability < 1);
  assert.equal(prediction.prediction_timestamp, CUTOFF);
  assert.equal(prediction.timestamp, CUTOFF);
  assert.equal(prediction.prediction_as_of, CUTOFF);
  assert.equal(prediction.model_version, LAND_PREDICTION_MODEL_VERSION);
  assert.equal(prediction.authoritative, false);
  assert.equal(prediction.feature_state.counts.unknown >= 1, true);
  assert.ok(prediction.major_contributors.length > 0);
  assert.ok(prediction.major_contributors.some((item) => item.evidence_ids.includes("new-stance")));
  assert.equal(prediction.explanation.basis.includes("not a causal claim"), true);
  assert.equal(prediction.explanation.schema, "cityscroll.land_prediction_explanation.v1");
  assert.equal(prediction.explanation.interpretation.causal_interpretation, "unavailable");
  assert.equal(prediction.promotion_status, "shadow_only_until_backtest_gate");
  assert.equal(prediction.fallback.used, false);
});

test("accepts raw evidence through the snapshot and feature-vector pipeline", () => {
  const model = fitLandPredictionModel([
    {
      id: "raw-train",
      raw_evidence: [feature("application_type", "zoning_map_amendment", "raw-type")],
      application_id: "raw-train",
      prediction_as_of: CUTOFF,
      procedural_stage: "cpc",
      outcome: "approved",
      outcome_at: "2024-07-01T00:00:00.000Z",
    },
  ]);
  const prediction = predictLandPrediction(model, {
    raw_evidence: [feature("application_type", "zoning_map_amendment", "raw-new")],
    application_id: "raw-new",
    prediction_as_of: CUTOFF,
    procedural_stage: "cpc",
  });
  assert.equal(prediction.application_id, "raw-new");
  assert.equal(prediction.prediction_as_of, CUTOFF);
});

test("missing features produce a valid probability and explicit unknown state", () => {
  const model = fitLandPredictionModel([
    trainingRow("a", "approved", "support"),
    trainingRow("b", "disapproved", "oppose"),
  ]);
  const prediction = predictLandPrediction(model, vector("sparse", null));

  assert.equal(typeof prediction.probability, "number");
  assert.equal(prediction.feature_state.counts.unknown > 0, true);
  assert.equal(prediction.feature_state.features.find((item) => item.key === "local_council_member_stance").state, "unknown");
});

test("same snapshot and model version replay byte-identically", () => {
  const rows = [trainingRow("a", "approved"), trainingRow("b", "disapproved", "oppose")];
  const firstModel = fitLandPredictionModel(rows);
  const secondModel = fitLandPredictionModel(rows);
  const first = predictLandPrediction(firstModel, vector("replay", "support"));
  const second = predictLandPrediction(secondModel, vector("replay", "support"));
  assert.equal(JSON.stringify(firstModel), JSON.stringify(secondModel));
  assert.equal(JSON.stringify(first), JSON.stringify(second));
});

test("calibration exposes measured Brier score, log loss, and bins", () => {
  const model = fitLandPredictionModel([
    trainingRow("a", "approved"),
    trainingRow("b", "disapproved", "oppose"),
  ]);
  const measured = measureLandPredictionCalibration(model, [
    trainingRow("score-a", "approved"),
    trainingRow("score-b", "disapproved", "oppose"),
  ]);
  assert.equal(measured.status, "measured");
  assert.equal(measured.n, 2);
  assert.equal(typeof measured.brier_score, "number");
  assert.equal(typeof measured.log_loss, "number");
  assert.equal(measured.bins.length, 5);
});

test("incumbent fallback remains available when V2 cannot run", () => {
  const featureVector = vector("fallback", null);
  const fallback = currentLandPredictionFallback(featureVector, "v2_failed:TypeError");
  assert.equal(fallback.fallback.contract, LAND_PREDICTION_BASELINE_MODEL.contract);
  assert.equal(fallback.fallback.model_version, LAND_PREDICTION_BASELINE_MODEL.model_version);
  assert.equal(fallback.model_name, LAND_PREDICTION_BASELINE_MODEL.model_name);
  assert.equal(fallback.model_version, LAND_PREDICTION_BASELINE_MODEL.model_version);
  assert.equal(fallback.fallback.used, true);
  assert.equal(fallback.fallback.probability, null);
  assert.equal(fallback.authoritative, true);

  const wrapped = predictLandUse({ not: "a model" }, featureVector);
  assert.equal(wrapped.fallback.used, true);
  assert.equal(wrapped.fallback.contract, "land_prediction_baseline_v1");
});
