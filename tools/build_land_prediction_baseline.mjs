#!/usr/bin/env node

/** Materialize the frozen CARD 1 baseline replay report. */

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import model from "../site/data/zoning_statistics.json" with { type: "json" };
import fixture from "../test/fixtures/land_prediction_baseline/v1.json" with { type: "json" };
import { evaluateLandPredictionBaseline } from "../worker/src/lib/land_prediction_baseline.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "warehouse/receipts/proof/land-prediction-baseline-v1.json");
const GENERATED_AT = "2026-08-27T00:00:00Z";

function day(value) {
  const match = String(value ?? "").match(/^(\d{4}-\d{2}-\d{2})/);
  return match ? match[1] : null;
}

function dayNumber(value) {
  return Date.parse(`${value}T00:00:00Z`) / 86_400_000;
}

function replayCase(item) {
  const output = evaluateLandPredictionBaseline(item.record, model, { generatedAt: GENERATED_AT });
  const timing = output.timing_prediction;
  const actualDate = day(item.record.approval_date || item.record.completed_date);
  const intervalHit = Boolean(
    timing && actualDate
    && actualDate >= timing.predicted_window.p10
    && actualDate <= timing.predicted_window.p90,
  );
  const p50Error = timing && actualDate
    ? Math.abs(dayNumber(actualDate) - dayNumber(timing.predicted_window.p50))
    : null;
  return {
    id: item.id,
    project_id: item.project_id,
    cohort: output.cohort
      ? {
          cohort_id: output.cohort.cohort_id,
          level: output.cohort.level,
          n: output.cohort.n,
          duration_n: output.cohort.duration_n,
          approved_rate: output.cohort.outcome_rates.approved,
        }
      : null,
    timing_prediction: timing
      ? {
          p10: timing.predicted_window.p10,
          p50: timing.predicted_window.p50,
          p90: timing.predicted_window.p90,
          probability: timing.probability,
          status: timing.status,
        }
      : null,
    actual_date: actualDate,
    interval_hit: actualDate ? intervalHit : null,
    p50_absolute_error_days: p50Error,
    outcome_output_kind: output.outcome.output_kind,
    approval_probability: output.outcome.approval_probability,
    applicant_prediction_emitted: output.outcome.emitted_as_project_prediction,
  };
}

function buildReport() {
  const replay = fixture.cases.map(replayCase);
  const scoredTiming = replay.filter((item) => item.actual_date && item.timing_prediction);
  const intervalHits = scoredTiming.filter((item) => item.interval_hit).length;
  const errors = scoredTiming
    .map((item) => item.p50_absolute_error_days)
    .sort((left, right) => left - right);
  const medianError = errors.length
    ? (errors.length % 2 ? errors[(errors.length - 1) / 2] : (errors[errors.length / 2 - 1] + errors[errors.length / 2]) / 2)
    : null;
  const outcomePredictions = replay.filter((item) => item.approval_probability != null);

  return {
    schema_version: 1,
    contract: "land_prediction_baseline_v1",
    version: "1.0.0",
    observed_at: GENERATED_AT,
    purpose: "CARD 1 freeze and benchmark of the existing land-use predictor",
    model: {
      name: model.model_name,
      version: model.model_version,
      materialization: "site/data/zoning_statistics.json",
      source_receipt: "warehouse/receipts/proof/zap-zoning-statistics_latest.json",
    },
    fixture_set: {
      path: "test/fixtures/land_prediction_baseline/v1.json",
      case_count: fixture.cases.length,
      retained_application_cases: fixture.cases.length,
      includes_elurp: fixture.cases.some((item) => item.id.includes("elurp")),
      note: "Cases are replay specimens assembled from committed retained application fixtures; individual modified and disapproved project records are not present in this retained set.",
    },
    metrics: {
      existing_materialization_backtest: {
        target: "land.zap_disposition timing",
        prediction_form: "p10/p50/p90 empirical duration window; probability=1",
        split_date: model.backtest.split_date,
        train_window: model.backtest.train_window,
        prediction_count: model.backtest.prediction_count,
        resolved_prediction_count: model.backtest.resolved_backtest_predictions,
        resolution_rate: model.backtest.resolution_rate,
        interval_nominal: model.backtest.interval_nominal,
        interval_coverage: model.backtest.interval_coverage,
        interval_coverage_hits: model.backtest.interval_coverage_hits,
        interval_coverage_count: model.backtest.interval_coverage_count,
        median_absolute_error_p50_days: model.backtest.median_absolute_error_p50_days,
        ship_bar: model.backtest.ship_bar,
      },
      representative_replay: {
        target: "land.zap_disposition timing",
        scored_cases: scoredTiming.length,
        interval_coverage: scoredTiming.length ? intervalHits / scoredTiming.length : null,
        interval_coverage_hits: intervalHits,
        interval_coverage_count: scoredTiming.length,
        median_absolute_error_p50_days: medianError,
        note: "Descriptive replay of the current materialized model, not a second out-of-time training split.",
      },
      outcome: {
        target: "land-use approval",
        project_probability_predictions: outcomePredictions.length,
        accuracy: null,
        brier_score: null,
        log_loss: null,
        calibration: null,
        status: "not_available",
        reason: "The current public contract emits cohort outcome rates and, because applicant conditioning did not beat the existing base rate, descriptive applicant history rather than a project-level approval probability.",
      },
      status: {
        target: "public_status and procedural stage",
        output_kind: "categorical observed/current status",
        accuracy: null,
        calibration: null,
        status: "not_applicable",
        reason: "Status and stage classifiers describe observed process position; they do not forecast a terminal outcome.",
      },
    },
    replay,
  };
}

function main() {
  const check = process.argv.includes("--check");
  const report = buildReport();
  if (check) {
    const existing = JSON.parse(readFileSync(OUT, "utf8"));
    if (JSON.stringify(existing) !== JSON.stringify(report)) {
      throw new Error(`${OUT} is stale; rerun node tools/build_land_prediction_baseline.mjs`);
    }
    console.log(`land-prediction-baseline --check OK cases=${report.fixture_set.case_count}`);
    return;
  }
  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  console.log(`wrote ${OUT}`);
}

main();
