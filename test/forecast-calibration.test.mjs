import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  assertNoTemporalLeakage,
  calibrationGate,
  coverageDecision,
  evaluateForecasts
} from "../worker/src/lib/forecast_calibration.mjs";

const fixtures = JSON.parse(readFileSync(new URL("../data/wave4/forecast-fixtures.json", import.meta.url)));
const bundle = JSON.parse(readFileSync(new URL("../data/forecast_bundle.json", import.meta.url)));
const valid = fixtures.predictions.filter((prediction) => !prediction.leakage_fixture);

test("historical cutoffs reject features observed in the future", () => {
  const leakage = fixtures.predictions.find((prediction) => prediction.leakage_fixture);
  assert.throws(() => assertNoTemporalLeakage(leakage), /temporal leakage/);
  for (const prediction of valid) assertNoTemporalLeakage(prediction);
});

test("out-of-time metrics reconcile to the pinned bundle", () => {
  const metrics = evaluateForecasts(valid);
  assert.deepEqual(metrics, bundle.metrics);
  assert.equal(metrics.denominator, valid.length);
  assert.ok(metrics.precision != null);
  assert.ok(metrics.recall != null);
  assert.ok(metrics.mean_lead_days > 0);
  assert.ok(metrics.brier_score < metrics.baselines.time_naive_brier);
});

test("confidence display is controlled by the calibration gate", () => {
  assert.deepEqual(calibrationGate(bundle.metrics), bundle.calibration_gate);
  for (const forecast of bundle.forecasts) {
    assert.equal(forecast.display_status, bundle.calibration_gate.status);
    assert.equal(typeof forecast.probability, bundle.calibration_gate.status === "promote" ? "number" : "object");
  }
});

test("low coverage abstains instead of receiving spurious precision", () => {
  const lowCoverage = valid.find((prediction) => prediction.coverage_ratio < 0.7);
  assert.equal(coverageDecision(lowCoverage).status, "abstain");
  assert.ok(bundle.metrics.abstentions.some((row) => row.id === lowCoverage.id));
  assert.equal(bundle.metrics.scored + bundle.metrics.abstained, bundle.metrics.denominator);
});

test("bundle pins model and source versions and reports baselines", () => {
  assert.equal(bundle.model_version, fixtures.model_version);
  assert.deepEqual(bundle.source_snapshot_hashes, fixtures.source_snapshot_hashes);
  assert.ok(bundle.metrics.baselines.shuffled_brier != null);
  assert.ok(bundle.metrics.calibration.every((bin) => bin.count > 0));
});
