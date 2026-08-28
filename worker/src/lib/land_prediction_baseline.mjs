/**
 * Frozen adapter for the pre-V2 land-use predictor.
 *
 * This module deliberately exposes the existing v1 behavior without adding
 * procedural or institutional features. The fixture and report tests pin the
 * adapter's output so a later predictor cannot silently replace the baseline.
 */

import {
  APPLICANT_OUTCOME_MODEL_NAME,
  ZONING_STATISTICS_MODEL_NAME,
  ZONING_STATISTICS_MODEL_VERSION,
  attachZoningStatistics,
} from "./zoning_statistics.mjs";

export const LAND_PREDICTION_BASELINE_CONTRACT = "land_prediction_baseline_v1";
export const LAND_PREDICTION_BASELINE_VERSION = "1.0.0";

function clean(value) {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  return text || null;
}

function sourceRecord(record) {
  return { ...(record?.open_data || {}), ...(record || {}) };
}

function predictionSummary(prediction) {
  if (!prediction) return null;
  return {
    predicted_event_kind: prediction.predicted_event_kind,
    claim: prediction.claim,
    predicted_window: prediction.predicted_window,
    probability: prediction.probability,
    basis: prediction.basis,
    model_name: prediction.model_name,
    model_version: prediction.model_version,
    status: prediction.status,
  };
}

/**
 * Run the current v1 land predictor for one retained project record.
 *
 * The returned outcome field is intentionally not a per-project forecast:
 * current public behavior exposes cohort outcome rates, while its only emitted
 * project prediction is a timing interval with probability 1.
 */
export function evaluateLandPredictionBaseline(record = {}, model, opts = {}) {
  if (!model || typeof model !== "object") throw new TypeError("baseline model is required");
  if (model.model_name !== ZONING_STATISTICS_MODEL_NAME
    || model.model_version !== ZONING_STATISTICS_MODEL_VERSION) {
    throw new Error("baseline requires the frozen zap_disposition_duration 1.0.0 model");
  }

  const attached = attachZoningStatistics(record, model, {
    generatedAt: opts.generatedAt || "2026-08-27T00:00:00Z",
  });
  const source = sourceRecord(record);
  const stats = attached.zoning_statistics || null;
  const predictions = Array.isArray(attached.predictions) ? attached.predictions : [];
  const timingPrediction = predictions.find((prediction) =>
    prediction.model_name === ZONING_STATISTICS_MODEL_NAME && prediction.claim === "timing",
  );
  const applicantPrediction = predictions.find((prediction) =>
    prediction.model_name === APPLICANT_OUTCOME_MODEL_NAME,
  );

  return {
    contract: LAND_PREDICTION_BASELINE_CONTRACT,
    version: LAND_PREDICTION_BASELINE_VERSION,
    subject_ref: `project:${clean(record.project_id || source.project_id) || "unknown"}`,
    inputs: {
      actions: source.actions ?? null,
      primary_action_type: stats?.action_type || null,
      borough: source.borough ?? null,
      certified_referred: source.certified_referred ?? null,
      primary_applicant_present: Boolean(
        clean(source.primary_applicant || source.applicant || source.applicant_name),
      ),
    },
    cohort: stats
      ? {
          cohort_id: stats.cohort_id,
          level: stats.level,
          action_type: stats.action_type,
          borough: stats.borough,
          n: stats.n,
          duration_n: stats.duration_n,
          outcome_counts: stats.outcome_counts,
          outcome_rates: stats.outcome_rates,
          duration_days: stats.duration_days,
          typical_months: stats.typical_months,
          display_mode: stats.display_mode,
        }
      : null,
    outcome: {
      output_kind: "descriptive_cohort_rate",
      approval_probability: null,
      emitted_as_project_prediction: Boolean(applicantPrediction),
      applicant_conditioned_render_mode: stats?.applicant_conditioned?.render_mode || null,
      reason: applicantPrediction
        ? "Applicant-conditioned rate passed the existing backtest gate."
        : "Current public contract shows cohort outcome rates; no project-level approval probability is emitted.",
    },
    timing_prediction: predictionSummary(timingPrediction),
  };
}
