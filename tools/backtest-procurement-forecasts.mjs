import { calibrationGate, evaluateForecasts } from "../worker/src/lib/forecast_calibration.mjs";
import { readJson, sha256, writeOrCheck } from "./lib/wave4-build.mjs";

if (!process.argv.includes("--temporal-split")) throw new Error("--temporal-split is required");
const check = process.argv.includes("--check");
const source = readJson("test/fixtures/wave4/forecast-fixtures.json");
const valid = source.predictions.filter((prediction) => !prediction.leakage_fixture);
const metrics = evaluateForecasts(valid);
const gate = calibrationGate(metrics);
const eligibleForecasts = valid
  .filter((prediction) => prediction.outcome_observed_at > prediction.cutoff)
  .map((prediction) => ({
    id: prediction.id,
    cutoff: prediction.cutoff,
    probability: gate.status === "promote" ? prediction.probability : null,
    display_status: gate.status,
    coverage: prediction.coverage_ratio
  }));

writeOrCheck("test/fixtures/wave4/generated/forecast_bundle.json", {
  schema_version: "1.0.0",
  snapshot_date: source.snapshot_date,
  model_version: source.model_version,
  source_snapshot_hashes: source.source_snapshot_hashes,
  fixture_snapshot_hash: sha256(source),
  coverage: {
    scope: "Historical-cutoff methodology fixtures",
    full_corpus: false,
    notice: source.fixture_notice
  },
  split: {
    kind: "monthly_temporal",
    future_information_allowed: false
  },
  metrics,
  calibration_gate: gate,
  forecasts: eligibleForecasts
}, check);
