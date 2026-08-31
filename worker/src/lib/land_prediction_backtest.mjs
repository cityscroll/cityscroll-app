// Time-held-out backtest for whether project-specific local-member stance
// improves land-use prediction (LUP2-C7).
//
// This module scores four cutoff-safe models and records kill-criterion
// and rival-hypothesis outcomes. It does not promote a feature, emit a
// causal claim, or replace the incumbent land_prediction_baseline_v1 path.

import { sha256Hex } from "./civic_time.mjs";
import { assertNoTemporalLeakage } from "./forecast_calibration.mjs";
import {
  INSTITUTIONAL_FEATURE_KEYS,
  LAND_PREDICTION_FEATURE_VECTOR_SCHEMA,
  buildLandPredictionFeatureVector,
  validateLandPredictionFeatureVector,
} from "./land_prediction_features.mjs";
import {
  LAND_PREDICTION_BASELINE_MODEL,
  LAND_PREDICTION_MODEL_VERSION,
  LAND_PREDICTION_PREDICTOR_SCHEMA,
  fitLandPredictionModel,
  measureLandPredictionCalibration,
  predictLandPrediction,
} from "./land_prediction_predictor.mjs";

export const LAND_PREDICTION_BACKTEST_SCHEMA =
  "cityscroll.land_prediction_backtest.v1";
export const LAND_PREDICTION_BACKTEST_VERSION = "lup2-c7-gold.v1";
export const LAND_PREDICTION_GOLD_SCHEMA =
  "cityscroll.land_prediction_backtest.gold.v1";

export const BASELINE_FEATURE_KEYS = Object.freeze([
  "application_type",
  "procedural_stage",
]);
export const FORMAL_PROCESS_FEATURE_KEYS = Object.freeze([
  "community_board_action",
  "borough_president_action",
  "cpc_recommendation",
  "cpc_disposition",
  "cpc_vote",
  "council_subcommittee_action",
  "land_use_committee_action",
  "modifications_or_conditions",
]);
export const STANCE_FEATURE_KEYS = Object.freeze([
  "local_council_member_stance",
]);

export const MODEL_IDS = Object.freeze([
  "existing_cityscroll_baseline",
  "baseline_plus_formal_signals",
  "baseline_plus_local_member_stance",
  "full_v2",
]);

export const MODEL_FEATURE_KEYS = Object.freeze({
  existing_cityscroll_baseline: BASELINE_FEATURE_KEYS,
  baseline_plus_formal_signals: Object.freeze([
    ...BASELINE_FEATURE_KEYS,
    ...FORMAL_PROCESS_FEATURE_KEYS,
  ]),
  baseline_plus_local_member_stance: Object.freeze([
    ...BASELINE_FEATURE_KEYS,
    ...STANCE_FEATURE_KEYS,
  ]),
  full_v2: INSTITUTIONAL_FEATURE_KEYS,
});

export const MEANINGFUL_BRIER_LIFT = 0.01;
export const MIN_FORECAST_LEAD_DAYS = 14;
export const LATE_STAGES = Object.freeze(["city_council", "mayoral_appeals"]);

const DAY_MS = 86_400_000;
const DEFAULT_SPLIT = Object.freeze({
  train_from: "2022-01-01",
  train_to: "2023-12-31",
  test_from: "2024-01-01",
  test_to: "2024-12-31",
});

function assertObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
}

function requiredText(value, label) {
  const text = String(value ?? "").trim();
  if (!text) throw new TypeError(`${label} is required`);
  return text;
}

function canonicalInstant(value, label) {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) {
    throw new TypeError(`${label} must be an ISO timestamp`);
  }
  return new Date(value).toISOString();
}

function calendarDay(value, label) {
  return canonicalInstant(value, label).slice(0, 10);
}

function round(value, places = 8) {
  if (value == null || !Number.isFinite(value)) return null;
  return Number(Number(value).toFixed(places));
}

function daysBetween(start, end) {
  const from = Date.parse(start);
  const to = Date.parse(end);
  if (!Number.isFinite(from) || !Number.isFinite(to)) return null;
  return Math.round((to - from) / DAY_MS);
}

function canonicalJson(value) {
  if (Array.isArray(value)) return value.map(canonicalJson);
  if (value && typeof value !== "object") return value;
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value).sort().map((key) => [key, canonicalJson(value[key])]),
    );
  }
  return value;
}

export function stableStringify(value) {
  return `${JSON.stringify(canonicalJson(value), null, 2)}\n`;
}

function unknownFeature(key) {
  return {
    key,
    value: null,
    state: "unknown",
    evidence_type: "not_available_at_cutoff",
    observed_at: null,
    effective_at: null,
    source: null,
    confidence: null,
    evidence: [],
    evidence_ids: [],
  };
}

function compactFeatureList(row) {
  const supplied = row.features;
  const items = [];
  if (row.application_type != null && row.application_type !== "") {
    items.push({
      key: "application_type",
      value: row.application_type,
      observed_at: row.application_type_observed_at || null,
    });
  }
  if (Array.isArray(supplied)) {
    items.push(...supplied);
    return items;
  }
  assertObject(supplied || {}, `${row.id || "case"}.features`);
  for (const [key, spec] of Object.entries(supplied || {})) {
    if (spec == null || spec === "unknown") continue;
    if (typeof spec === "string" || typeof spec === "number" || typeof spec === "boolean") {
      items.push({ key, value: spec });
    } else {
      items.push({ key, ...spec });
    }
  }
  return items;
}

function featureInput(row, feature, index) {
  const key = requiredText(feature.key, `${row.id} features[${index}].key`);
  const cutoff = canonicalInstant(row.prediction_as_of, `${row.id}.prediction_as_of`);
  const observed = feature.observed_at
    || feature.effective_at
    || new Date(Date.parse(cutoff) - 14 * DAY_MS).toISOString();
  return {
    key,
    value: feature.value,
    evidence_type: feature.evidence_type || "official_record",
    observed_at: observed,
    effective_at: feature.effective_at || observed,
    source: feature.source || {
      url: `https://example.invalid/${row.application_id}/${key}`,
      record_id: `${row.application_id}-${key}`,
    },
    confidence: feature.confidence == null ? 0.9 : feature.confidence,
  };
}

function latestFeatureClock(features, cutoff) {
  const clocks = features
    .flatMap((feature) => [feature.observed_at, feature.effective_at])
    .filter(Boolean)
    .map((value) => canonicalInstant(value, "feature clock"));
  return clocks.sort().at(-1) || cutoff;
}

/** Fail closed on outcome-before-cutoff or feature-after-cutoff leakage. */
export function assertCutoffSafety(row, label = "case") {
  assertObject(row, label);
  const id = requiredText(row.id || row.application_id, `${label}.id`);
  const cutoff = canonicalInstant(row.prediction_as_of, `${id}.prediction_as_of`);
  const outcomeAt = canonicalInstant(row.outcome_at, `${id}.outcome_at`);
  if (Date.parse(outcomeAt) <= Date.parse(cutoff)) {
    throw new TypeError(`outcome leakage in ${id}: outcome_at must be after prediction_as_of`);
  }
  const features = compactFeatureList(row).map((feature, index) => featureInput(row, feature, index));
  const featureObservedAt = latestFeatureClock(features, cutoff);
  assertNoTemporalLeakage({
    id,
    cutoff,
    feature_observed_at: featureObservedAt,
  });
  return { id, cutoff, outcome_at: outcomeAt, feature_observed_at: featureObservedAt, features };
}

/** Rebuild the C5 vector using only evidence available at the case cutoff. */
export function reconstructAtCutoff(row) {
  const safe = assertCutoffSafety(row);
  return buildLandPredictionFeatureVector({
    application_id: requiredText(row.application_id, `${safe.id}.application_id`),
    prediction_as_of: safe.cutoff,
    procedural_stage: requiredText(row.procedural_stage, `${safe.id}.procedural_stage`),
    features: safe.features,
  });
}

/** Hide model-disallowed signals as explicit unknowns without dropping keys. */
export function maskFeatureVectorForModel(vector, modelId) {
  const allowed = MODEL_FEATURE_KEYS[modelId];
  if (!allowed) throw new TypeError(`unknown backtest model: ${modelId}`);
  const allowedSet = new Set(allowed);
  const validated = vector.schema === LAND_PREDICTION_FEATURE_VECTOR_SCHEMA
    ? validateLandPredictionFeatureVector(vector)
    : reconstructAtCutoff(vector);
  return validateLandPredictionFeatureVector({
    ...validated,
    features: validated.features.map((feature) => (
      allowedSet.has(feature.key) ? feature : unknownFeature(feature.key)
    )),
  });
}

export function assignSplit(predictionAsOf, split = DEFAULT_SPLIT) {
  const day = calendarDay(predictionAsOf, "prediction_as_of");
  if (day <= split.train_to && day >= split.train_from) return "train";
  if (day >= split.test_from && day <= split.test_to) return "test";
  return "excluded";
}

function stanceState(vector) {
  const feature = vector.features.find((item) => item.key === "local_council_member_stance");
  return feature || unknownFeature("local_council_member_stance");
}

function stanceTiming(vector, outcomeAt) {
  const feature = stanceState(vector);
  const available = feature.state !== "unknown" && feature.state !== "no_known_position";
  if (!available) {
    return {
      available: false,
      state: feature.state,
      observed_at: null,
      lead_days: null,
      late: null,
      late_reason: null,
    };
  }
  const observedAt = feature.observed_at || feature.effective_at;
  const leadDays = daysBetween(observedAt, outcomeAt);
  const lateByStage = LATE_STAGES.includes(vector.procedural_stage);
  const lateByLead = leadDays != null && leadDays < MIN_FORECAST_LEAD_DAYS;
  return {
    available: true,
    state: feature.state,
    value: feature.value,
    observed_at: observedAt,
    lead_days: leadDays,
    late: lateByStage || lateByLead,
    late_reason: lateByLead ? "lead_below_forecast_floor" : lateByStage ? "stage_after_useful_forecast" : null,
  };
}

function coverageForModel(vector, modelId) {
  const allowed = MODEL_FEATURE_KEYS[modelId];
  const rows = vector.features.filter((feature) => allowed.includes(feature.key));
  const known = rows.filter((feature) => feature.state !== "unknown").length;
  return {
    allowed: rows.length,
    known,
    unknown: rows.length - known,
    ratio: rows.length ? round(known / rows.length, 4) : null,
  };
}

function cohortList(row) {
  return [...new Set((row.cohorts || []).map((item) => String(item)))].sort();
}

function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[mid]
    : round((sorted[mid - 1] + sorted[mid]) / 2, 4);
}

function prepareEligible(dataset) {
  assertObject(dataset, "backtest dataset");
  if (dataset.schema !== LAND_PREDICTION_GOLD_SCHEMA) {
    throw new TypeError("unsupported land prediction backtest gold schema");
  }
  const split = { ...DEFAULT_SPLIT, ...(dataset.split || {}) };
  const exclusions = [];
  const prepared = [];
  for (const row of dataset.eligible || []) {
    try {
      const vector = reconstructAtCutoff(row);
      const bucket = assignSplit(vector.prediction_as_of, split);
      if (bucket === "excluded") {
        exclusions.push({ id: row.id, reason: "cutoff_outside_train_test_windows" });
        continue;
      }
      prepared.push({
        id: row.id,
        application_id: vector.application_id,
        prediction_as_of: vector.prediction_as_of,
        procedural_stage: vector.procedural_stage,
        outcome: row.outcome,
        outcome_at: canonicalInstant(row.outcome_at, `${row.id}.outcome_at`),
        split: bucket,
        cohorts: cohortList(row),
        vector,
        snapshot_timestamp: vector.prediction_as_of,
        stance: stanceTiming(vector, row.outcome_at),
        feature_availability: Object.fromEntries(
          vector.features.map((feature) => [feature.key, {
            state: feature.state,
            observed_at: feature.observed_at,
            effective_at: feature.effective_at,
          }]),
        ),
      });
    } catch (error) {
      exclusions.push({ id: row.id, reason: error.message });
    }
  }
  return { split, prepared, exclusions };
}

function scorePrepared(model, rows, modelId) {
  return rows.map((row) => {
    const masked = maskFeatureVectorForModel(row.vector, modelId);
    const prediction = predictLandPrediction(model, masked);
    const target = row.outcome === "approved" ? 1 : 0;
    return {
      id: row.id,
      application_id: row.application_id,
      prediction_as_of: row.prediction_as_of,
      procedural_stage: row.procedural_stage,
      outcome: row.outcome,
      outcome_at: row.outcome_at,
      probability: prediction.probability,
      target,
      cohorts: row.cohorts,
      stance: row.stance,
      coverage: coverageForModel(masked, modelId),
      feature_availability: row.feature_availability,
      snapshot_timestamp: row.snapshot_timestamp,
    };
  });
}

function groupMetrics(model, scored, vectorsById) {
  if (!scored.length) {
    return { n: 0, brier_score: null, log_loss: null, bins: [] };
  }
  return measureLandPredictionCalibration(model, scored.map((row) => ({
    id: row.id,
    feature_vector: vectorsById.get(row.id),
    outcome: row.outcome,
    outcome_at: row.outcome_at,
  })));
}

function byStage(model, scored, vectorsById) {
  const stages = [...new Set(scored.map((row) => row.procedural_stage))].sort();
  return Object.fromEntries(stages.map((stage) => {
    const rows = scored.filter((row) => row.procedural_stage === stage);
    return [stage, groupMetrics(model, rows, vectorsById)];
  }));
}

function byCohort(model, scored, vectorsById) {
  const names = [...new Set(scored.flatMap((row) => row.cohorts))].sort();
  return Object.fromEntries(names.map((name) => {
    const rows = scored.filter((row) => row.cohorts.includes(name));
    return [name, groupMetrics(model, rows, vectorsById)];
  }));
}

function byStanceCoverage(model, scored, vectorsById) {
  const known = scored.filter((row) => row.stance.available);
  const unknown = scored.filter((row) => !row.stance.available);
  const late = known.filter((row) => row.stance.late);
  const early = known.filter((row) => !row.stance.late);
  return {
    stance_known: groupMetrics(model, known, vectorsById),
    stance_unknown: groupMetrics(model, unknown, vectorsById),
    early_stance: groupMetrics(model, early, vectorsById),
    late_stance: groupMetrics(model, late, vectorsById),
  };
}

function ablationDeltas(models) {
  const brier = (id) => models[id].held_out.brier_score;
  const loss = (id) => models[id].held_out.log_loss;
  return {
    formal_minus_baseline_brier: round(brier("existing_cityscroll_baseline") - brier("baseline_plus_formal_signals")),
    stance_minus_baseline_brier: round(brier("existing_cityscroll_baseline") - brier("baseline_plus_local_member_stance")),
    full_minus_formal_brier: round(brier("baseline_plus_formal_signals") - brier("full_v2")),
    full_minus_stance_brier: round(brier("baseline_plus_local_member_stance") - brier("full_v2")),
    formal_minus_baseline_log_loss: round(loss("existing_cityscroll_baseline") - loss("baseline_plus_formal_signals")),
    stance_minus_baseline_log_loss: round(loss("existing_cityscroll_baseline") - loss("baseline_plus_local_member_stance")),
    full_minus_formal_log_loss: round(loss("baseline_plus_formal_signals") - loss("full_v2")),
    full_minus_stance_log_loss: round(loss("baseline_plus_local_member_stance") - loss("full_v2")),
    note: "Positive Brier/log-loss deltas mean the second model has lower error. They are predictive associations, not causal effects.",
  };
}

export function evaluateKillCriterion(models, timing) {
  const baseline = models.existing_cityscroll_baseline.held_out.brier_score;
  const formal = models.baseline_plus_formal_signals.held_out.brier_score;
  const stance = models.baseline_plus_local_member_stance.held_out.brier_score;
  const full = models.full_v2.held_out.brier_score;
  const liftVsBaseline = round((baseline ?? 0) - (stance ?? 0));
  const liftAfterFormal = round((formal ?? 0) - (full ?? 0));
  const lateShare = timing.stance_known
    ? round(timing.late_count / timing.stance_known, 4)
    : null;
  const noLiftAfterFormal = liftAfterFormal == null || liftAfterFormal < MEANINGFUL_BRIER_LIFT;
  const tooLate = Boolean(
    timing.stance_known
    && (
      (lateShare != null && lateShare >= 0.5)
      || (timing.median_lead_days != null && timing.median_lead_days < MIN_FORECAST_LEAD_DAYS)
    ),
  );
  const reasons = [];
  if (noLiftAfterFormal) {
    reasons.push("no_meaningful_held_out_brier_lift_after_formal_signals");
  }
  if (tooLate) reasons.push("stance_arrives_too_late_for_forecasting");
  const met = reasons.length > 0;
  return {
    met,
    meaningful_brier_lift: MEANINGFUL_BRIER_LIFT,
    minimum_forecast_lead_days: MIN_FORECAST_LEAD_DAYS,
    late_stages: [...LATE_STAGES],
    stance_lift_vs_baseline_brier: liftVsBaseline,
    stance_lift_after_formal_brier: liftAfterFormal,
    late_stance_share: lateShare,
    median_lead_days: timing.median_lead_days ?? null,
    reasons,
    stance_promoted_as_major_feature: false,
    null_result_recorded_as_success: met,
    interpretation: met
      ? "Kill criterion met. Local-member stance is not promoted as a major feature. Recording that null or late result is success for this evaluation."
      : "Held-out stance lift after formal signals is above the recorded threshold and is not dominated by late evidence. That measurement still does not authorize a causal deference claim or production promotion.",
  };
}

function rivalHypotheses(kill) {
  return {
    H1: {
      id: "institutional_mechanism",
      claim: "The local member's position independently predicts Council disposition because other members routinely defer to that member on local land-use matters.",
    },
    H2: {
      id: "information_sensor_mechanism",
      claim: "The member's position predicts outcomes mainly because the member already observes negotiations, constituency response, applicant concessions, and project viability that CityScroll otherwise lacks.",
    },
    adjudication: "not_identified_by_this_backtest",
    causal_claim: false,
    literature_weight_assigned: false,
    kill_criterion_met: kill.met,
    interpretation: "Either mechanism may justify using stance as a predictive feature. This backtest does not distinguish H1 from H2 and does not assign a strong weight because institutional literature or domain theory predicts one.",
  };
}

function evaluateNegatives(rows = []) {
  return (rows || []).map((row) => {
    try {
      reconstructAtCutoff(row);
      return {
        id: row.id,
        kind: row.kind || "negative",
        rejected: false,
        error: null,
      };
    } catch (error) {
      return {
        id: row.id,
        kind: row.kind || "negative",
        rejected: true,
        error: error.message,
      };
    }
  });
}

function fitMaskedModel(trainRows, modelId) {
  const rows = trainRows.map((row) => ({
    id: row.id,
    feature_vector: maskFeatureVectorForModel(row.vector, modelId),
    outcome: row.outcome,
    outcome_at: row.outcome_at,
  }));
  return fitLandPredictionModel(rows);
}

function summarizeModel(model, trainRows, testRows, modelId) {
  const trainVectors = new Map(trainRows.map((row) => [
    row.id,
    maskFeatureVectorForModel(row.vector, modelId),
  ]));
  const testVectors = new Map(testRows.map((row) => [
    row.id,
    maskFeatureVectorForModel(row.vector, modelId),
  ]));
  const trainScored = scorePrepared(model, trainRows, modelId);
  const testScored = scorePrepared(model, testRows, modelId);
  return {
    model_id: modelId,
    feature_keys: [...MODEL_FEATURE_KEYS[modelId]],
    model_name: model.model_name,
    model_version: model.model_version,
    method: model.method,
    authoritative: false,
    promotion_status: model.promotion_status,
    training_fingerprint: model.training.training_fingerprint,
    intercept: model.intercept,
    coefficient_count: model.coefficients.length,
    in_sample: groupMetrics(model, trainScored, trainVectors),
    held_out: groupMetrics(model, testScored, testVectors),
    by_stage: byStage(model, testScored, testVectors),
    by_cohort: byCohort(model, testScored, testVectors),
    by_coverage: byStanceCoverage(model, testScored, testVectors),
    cases: testScored.map((row) => ({
      id: row.id,
      probability: row.probability,
      outcome: row.outcome,
      procedural_stage: row.procedural_stage,
      cohorts: row.cohorts,
      stance_available: row.stance.available,
      stance_late: row.stance.late,
      coverage_ratio: row.coverage.ratio,
      snapshot_timestamp: row.snapshot_timestamp,
      feature_availability: row.feature_availability,
    })),
  };
}

function timingSummary(testRows) {
  const known = testRows.filter((row) => row.stance.available);
  const late = known.filter((row) => row.stance.late);
  const leads = known.map((row) => row.stance.lead_days).filter((value) => Number.isFinite(value));
  return {
    held_out: testRows.length,
    stance_known: known.length,
    stance_unknown: testRows.length - known.length,
    late_count: late.length,
    late_share: testRows.length && known.length ? round(late.length / known.length, 4) : null,
    median_lead_days: median(leads),
    min_lead_days: leads.length ? Math.min(...leads) : null,
    max_lead_days: leads.length ? Math.max(...leads) : null,
  };
}

function missingness(testRows) {
  const keys = [...INSTITUTIONAL_FEATURE_KEYS];
  return Object.fromEntries(keys.map((key) => {
    const unknown = testRows.filter((row) => row.feature_availability[key]?.state === "unknown").length;
    return [key, {
      unknown,
      known: testRows.length - unknown,
      unknown_share: testRows.length ? round(unknown / testRows.length, 4) : null,
    }];
  }));
}

/**
 * Run the four-model, time-held-out stance backtest on a frozen gold pack.
 * Eligible rows train only on evidence at their cutoff. Negative controls
 * must fail closed and never enter training or scoring.
 */
export function runLandPredictionBacktest(dataset, options = {}) {
  const { split, prepared, exclusions } = prepareEligible(dataset);
  const trainRows = prepared.filter((row) => row.split === "train");
  const testRows = prepared.filter((row) => row.split === "test");
  if (!trainRows.length || !testRows.length) {
    throw new TypeError("backtest requires historically valid train and test rows");
  }
  const negatives = evaluateNegatives(dataset.negatives);
  if (negatives.some((row) => !row.rejected)) {
    throw new TypeError("negative controls must fail closed and not reconstruct");
  }

  const fitted = Object.fromEntries(MODEL_IDS.map((modelId) => [
    modelId,
    fitMaskedModel(trainRows, modelId),
  ]));
  const models = Object.fromEntries(MODEL_IDS.map((modelId) => [
    modelId,
    summarizeModel(fitted[modelId], trainRows, testRows, modelId),
  ]));
  const timing = timingSummary(testRows);
  const kill = evaluateKillCriterion(models, timing);
  const ablations = ablationDeltas(models);
  const generatedAt = options.generated_at || "2026-08-31T00:00:00.000Z";

  return {
    schema: LAND_PREDICTION_BACKTEST_SCHEMA,
    version: LAND_PREDICTION_BACKTEST_VERSION,
    generated_at: generatedAt,
    dataset: {
      schema: dataset.schema,
      version: dataset.version,
      frozen: true,
      purpose: dataset.purpose,
      fingerprint: sha256Hex(stableStringify({
        version: dataset.version,
        split,
        eligible: (dataset.eligible || []).map((row) => row.id).sort(),
        negatives: (dataset.negatives || []).map((row) => row.id).sort(),
      })),
      predictor_schema: LAND_PREDICTION_PREDICTOR_SCHEMA,
      predictor_model_version: LAND_PREDICTION_MODEL_VERSION,
      feature_schema: LAND_PREDICTION_FEATURE_VECTOR_SCHEMA,
    },
    split: {
      ...split,
      train_n: trainRows.length,
      test_n: testRows.length,
      excluded_n: exclusions.length,
    },
    cohort_counts: {
      train: trainRows.length,
      test: testRows.length,
      exclusions: exclusions.length,
      negatives: negatives.length,
      by_test_cohort: Object.fromEntries(
        [...new Set(testRows.flatMap((row) => row.cohorts))].sort().map((name) => [
          name,
          testRows.filter((row) => row.cohorts.includes(name)).length,
        ]),
      ),
    },
    exclusions,
    negatives,
    missingness: missingness(testRows),
    timing,
    models,
    ablations,
    kill_criterion: kill,
    rival_hypotheses: rivalHypotheses(kill),
    promotion: {
      stance_promoted_as_major_feature: false,
      product_promotion_allowed: false,
      incumbent_authoritative: true,
      incumbent_contract: LAND_PREDICTION_BASELINE_MODEL.contract,
      v2_status: "shadow_only_until_backtest_gate",
      resident_facing_predictions_unchanged: true,
      reason: kill.met
        ? "Kill criterion met: stance is not a major feature. The incumbent heuristic remains authoritative."
        : "Measured held-out lift does not authorize production promotion or a causal institutional-deference claim. The incumbent heuristic remains authoritative until a later gate.",
    },
    protocol: {
      train_on_cutoff_available_evidence_only: true,
      outcome_after_cutoff_required: true,
      unknown_stance_not_imputed: true,
      future_council_outcomes_excluded: true,
      post_cutoff_member_statements_excluded: true,
      four_models: [...MODEL_IDS],
      existing_baseline_note: "The production baseline emits cohort rates, not a project-level approval probability. This backtest reconstructs a comparable process-only logistic over application_type and procedural_stage so Brier and log loss can be compared without replacing the incumbent contract.",
    },
  };
}

export function renderBacktestMarkdown(receipt) {
  const kill = receipt.kill_criterion;
  const models = receipt.models;
  const line = (id, label) => {
    const held = models[id].held_out;
    return `| ${label} | ${held.n} | ${held.brier_score} | ${held.log_loss} |`;
  };
  const cohortLines = Object.entries(models.full_v2.by_cohort).map(([name, metrics]) =>
    `| ${name} | ${metrics.n} | ${metrics.brier_score} | ${metrics.log_loss} |`).join("\n");
  const stageLines = Object.entries(models.full_v2.by_stage).map(([name, metrics]) =>
    `| ${name} | ${metrics.n} | ${metrics.brier_score} | ${metrics.log_loss} |`).join("\n");
  return `# Land-use prediction stance backtest

As of ${receipt.generated_at.slice(0, 10)}. Frozen control pack \`${receipt.dataset.version}\`, not a recurrent population estimate.

Train window ${receipt.split.train_from}–${receipt.split.train_to} (${receipt.split.train_n} applications). Test window ${receipt.split.test_from}–${receipt.split.test_to} (${receipt.split.test_n} applications). Outcomes are observed strictly after each cutoff. Feature evidence is reconstructed at that cutoff.

## Kill criterion and promotion

**${kill.met ? "Met" : "Not met"}.** Stance is not promoted as a major feature. Product promotion remains withheld. The incumbent \`${receipt.promotion.incumbent_contract}\` path stays authoritative.

${kill.interpretation}

| Check | Value |
| --- | ---: |
| Meaningful Brier lift threshold | ${kill.meaningful_brier_lift} |
| Stance lift vs process baseline (Brier) | ${kill.stance_lift_vs_baseline_brier} |
| Stance lift after formal signals (Brier) | ${kill.stance_lift_after_formal_brier} |
| Late stance share | ${kill.late_stance_share} |
| Median stance lead days | ${kill.median_lead_days} |
| Reasons | ${kill.reasons.join(", ") || "none"} |

## Held-out probabilistic error

| Model | N | Brier | Log loss |
| --- | ---: | ---: | ---: |
${line("existing_cityscroll_baseline", "Existing process baseline")}
${line("baseline_plus_formal_signals", "Baseline + formal-process signals")}
${line("baseline_plus_local_member_stance", "Baseline + local-member stance")}
${line("full_v2", "Full V2 feature set")}

Ablation deltas (positive = lower error): formal vs baseline Brier ${receipt.ablations.formal_minus_baseline_brier}; stance vs baseline Brier ${receipt.ablations.stance_minus_baseline_brier}; full vs formal Brier ${receipt.ablations.full_minus_formal_brier}.

The existing CityScroll production baseline does not emit a project-level approval probability. The process baseline here is a cutoff-safe logistic over application type and procedural stage so the four models share one scoring contract.

## Stage, coverage, and timing

Full V2 by procedural stage:

| Stage | N | Brier | Log loss |
| --- | ---: | ---: | ---: |
${stageLines}

Full V2 by fixture cohort:

| Cohort | N | Brier | Log loss |
| --- | ---: | ---: | ---: |
${cohortLines}

Stance known in ${receipt.timing.stance_known} of ${receipt.timing.held_out} held-out applications (${receipt.timing.stance_unknown} unknown). Late stance cases: ${receipt.timing.late_count}. Median lead from first stance clock to outcome: ${receipt.timing.median_lead_days} days.

Unknown and missing stance remain explicit. Institutional power is not imputed.

## Rival hypotheses

H1 (institutional mechanism): ${receipt.rival_hypotheses.H1.claim}

H2 (information/sensor mechanism): ${receipt.rival_hypotheses.H2.claim}

${receipt.rival_hypotheses.interpretation} Causal claim: ${receipt.rival_hypotheses.causal_claim}. Literature-driven weight assigned: ${receipt.rival_hypotheses.literature_weight_assigned}.

## Leakage and exclusions

Eligible exclusions: ${receipt.exclusions.length}. Negative controls rejected: ${receipt.negatives.filter((row) => row.rejected).length}/${receipt.negatives.length}. Future Council outcomes, post-cutoff member statements, and materialized labels are not training features.

Predictor ${receipt.dataset.predictor_schema} ${receipt.dataset.predictor_model_version}; feature schema ${receipt.dataset.feature_schema}.
`;
}

export const buildLandPredictionBacktest = runLandPredictionBacktest;
export const LAND_PREDICTION_BACKTEST_MODEL_IDS = MODEL_IDS;
