import assert from "node:assert/strict";
import { readJson } from "./lib/wave4-build.mjs";

const bundle = readJson("test/fixtures/wave4/generated/forecast_bundle.json");
assert.equal(bundle.split.kind, "monthly_temporal");
assert.equal(bundle.split.future_information_allowed, false);
assert.ok(bundle.model_version);
assert.ok(Object.keys(bundle.source_snapshot_hashes).length >= 4);
assert.ok(bundle.metrics.denominator > bundle.metrics.abstained);
assert.ok(bundle.metrics.calibration.length >= 3);
assert.ok(bundle.metrics.baselines.time_naive_brier != null);
for (const forecast of bundle.forecasts) {
  if (forecast.display_status === "promote") assert.equal(typeof forecast.probability, "number");
  else assert.equal(forecast.probability, null);
}
console.log(`forecast calibration gate: ${bundle.calibration_gate.status}; scored ${bundle.metrics.scored}/${bundle.metrics.denominator}`);
