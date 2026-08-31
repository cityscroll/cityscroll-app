// Interpretable, shadow-only land-use outcome predictor for LUP2-C6.
//
// The input boundary is deliberately explicit:
// raw evidence -> C2 temporal snapshot -> C5 normalized feature vector
// -> this calibrated logistic model -> explanation.  This module does not
// read live sources and does not promote V2 over the incumbent heuristic.

import { sha256Hex } from "./civic_time.mjs";
import {
  LAND_PREDICTION_FEATURE_VECTOR_SCHEMA,
  buildLandPredictionFeatureVector,
  validateLandPredictionFeatureVector,
} from "./land_prediction_features.mjs";
import { buildLandPredictionExplanation } from "./land_prediction_explanation.mjs";

export const LAND_PREDICTION_PREDICTOR_SCHEMA =
  "cityscroll.land_prediction_predictor.v2";
export const LAND_PREDICTION_PREDICTOR_VERSION = 2;
export const LAND_PREDICTION_MODEL_NAME = "land_use_approval_logistic";
export const LAND_PREDICTION_MODEL_VERSION = "2.0.0";
export const LAND_PREDICTION_TARGET = "approved";
export const LAND_PREDICTION_BASELINE_MODEL = Object.freeze({
  model_name: "current_land_use_heuristic",
  model_version: "1.0.0",
  contract: "land_prediction_baseline_v1",
});

const DEFAULT_OPTIONS = Object.freeze({
  learning_rate: 0.08,
  iterations: 800,
  l2: 0.1,
  max_contributors: 5,
});
const MAX_LOGIT = 35;
const MIN_PROBABILITY = 0.000001;

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

function canonicalJson(value) {
  if (Array.isArray(value)) return value.map(canonicalJson);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value).sort().map((key) => [key, canonicalJson(value[key])]),
    );
  }
  return value;
}

function stableStringify(value) {
  return JSON.stringify(canonicalJson(value));
}

function canonicalInstant(value, label) {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) {
    throw new TypeError(`${label} must be an ISO timestamp`);
  }
  return new Date(value).toISOString();
}

function round(value, places = 12) {
  return Number(Number(value).toFixed(places));
}

function clampProbability(value) {
  return Math.min(1 - MIN_PROBABILITY, Math.max(MIN_PROBABILITY, value));
}

function sigmoid(logit) {
  const bounded = Math.max(-MAX_LOGIT, Math.min(MAX_LOGIT, Number(logit)));
  return 1 / (1 + Math.exp(-bounded));
}

function logit(probability) {
  const p = Math.min(1 - MIN_PROBABILITY, Math.max(MIN_PROBABILITY, probability));
  return Math.log(p / (1 - p));
}

function featureValueToken(value) {
  if (typeof value === "string") return value.trim().toLowerCase();
  return stableStringify(value);
}

function encodedFeatureKey(featureKey, suffix) {
  return `feature:${featureKey}:${suffix}`;
}

function activeFeatureEntries(vector) {
  const entries = [];
  for (const feature of vector.features) {
    const stateKey = encodedFeatureKey(feature.key, `state=${feature.state}`);
    entries.push({
      key: stateKey,
      feature_key: feature.key,
      value: feature.value,
      state: feature.state,
      evidence_ids: [...feature.evidence_ids].map(String).sort(),
      evidence: feature.evidence,
    });
    if (feature.value !== null && feature.value !== undefined) {
      entries.push({
        key: encodedFeatureKey(feature.key, `value=${featureValueToken(feature.value)}`),
        feature_key: feature.key,
        value: feature.value,
        state: feature.state,
        evidence_ids: [...feature.evidence_ids].map(String).sort(),
        evidence: feature.evidence,
      });
    }
  }

  // C5 declares this interaction as learnable. Activating it only when the
  // corresponding stance is present preserves missingness and stage context.
  const stanceRows = vector.features.filter((feature) =>
    feature.key === "local_council_member_stance");
  for (const interaction of vector.stage_interactions) {
    const matching = stanceRows.filter((feature) => feature.state !== "unknown");
    const state = matching.length ? matching[0].state : "unknown";
    const value = matching.length ? matching.map((feature) => feature.value).join("|") : null;
    const evidenceIds = [...new Set(matching.flatMap((feature) => feature.evidence_ids))].sort();
    const evidence = matching.flatMap((feature) => feature.evidence);
    entries.push({
      key: `interaction:${interaction.interaction_key}:state=${state}`,
      feature_key: interaction.interaction_key,
      value,
      state,
      evidence_ids: evidenceIds,
      evidence,
    });
    if (value !== null) {
      entries.push({
        key: `interaction:${interaction.interaction_key}:value=${featureValueToken(value)}`,
        feature_key: interaction.interaction_key,
        value,
        state,
        evidence_ids: evidenceIds,
        evidence,
      });
    }
  }
  return entries;
}

function vectorFromInput(input, label = "feature vector") {
  assertObject(input, label);
  const candidate = input.feature_vector || input.vector || input;
  if (candidate.schema === LAND_PREDICTION_FEATURE_VECTOR_SCHEMA) {
    return validateLandPredictionFeatureVector(candidate);
  }
  if (input.snapshot || input.temporal_snapshot || input.land_prediction_snapshot) {
    return buildLandPredictionFeatureVector(input);
  }
  const rawEvidence = input.raw_evidence ?? input.rawEvidence;
  if (rawEvidence !== undefined) {
    const rows = Array.isArray(rawEvidence)
      ? rawEvidence
      : Object.entries(rawEvidence || {}).flatMap(([key, value]) =>
        (Array.isArray(value) ? value : [value]).map((row) => ({
          ...(row && typeof row === "object" ? row : { value: row }),
          key: row?.key || row?.feature_key || key,
        })));
    return buildLandPredictionFeatureVector({ ...input, features: rows });
  }
  return buildLandPredictionFeatureVector(input);
}

function outcomeLabel(row, index) {
  const raw = row.outcome ?? row.target ?? row.label;
  if (typeof raw === "number" || typeof raw === "boolean") {
    if (raw === 1 || raw === true) return "approved";
    if (raw === 0 || raw === false) return "disapproved";
  }
  const value = typeof raw === "object" && raw !== null
    ? raw.outcome ?? raw.label ?? raw.value
    : raw;
  const normalized = String(value ?? "").trim().toLowerCase();
  if (["approved", "approval", "approve", "yes", "1", "true"].includes(normalized)) {
    return "approved";
  }
  if (["disapproved", "disapproval", "denied", "deny", "modified", "no", "0", "false"].includes(normalized)) {
    return normalized === "modified" ? "modified" : "disapproved";
  }
  throw new TypeError(`training row ${index} has unsupported outcome`);
}

function outcomeTimestamp(row, index) {
  const value = row.outcome_at
    ?? row.outcome_date
    ?? row.disposition_at
    ?? row.disposition_date
    ?? row.resolved_at;
  return canonicalInstant(value, `training row ${index}.outcome_at`);
}

function trainingExample(row, index) {
  assertObject(row, `training row ${index}`);
  const vector = vectorFromInput(row, `training row ${index}`);
  const outcome = outcomeLabel(row, index);
  const outcomeAt = outcomeTimestamp(row, index);
  if (Date.parse(outcomeAt) <= Date.parse(vector.prediction_as_of)) {
    throw new TypeError(
      `training row ${index} outcome_at must be after prediction_as_of; historical leakage is not permitted`,
    );
  }
  return {
    id: String(row.id ?? row.application_id ?? vector.application_id),
    vector,
    outcome,
    target: outcome === LAND_PREDICTION_TARGET ? 1 : 0,
    outcome_at: outcomeAt,
  };
}

function trainingFeatureMap(vector, featureKeys) {
  const active = new Map();
  for (const entry of activeFeatureEntries(vector)) {
    if (featureKeys.has(entry.key)) active.set(entry.key, (active.get(entry.key) || 0) + 1);
  }
  return active;
}

function validateTrainingOptions(options) {
  const merged = { ...DEFAULT_OPTIONS, ...options };
  for (const key of ["learning_rate", "l2"]) {
    if (!Number.isFinite(merged[key]) || merged[key] <= 0) {
      throw new TypeError(`${key} must be a positive number`);
    }
  }
  if (!Number.isSafeInteger(merged.iterations) || merged.iterations < 1) {
    throw new TypeError("iterations must be a positive integer");
  }
  return merged;
}

function calibrationBins(scored) {
  const bins = Array.from({ length: 5 }, (_, index) => ({
    quintile: index + 1,
    min: index / 5,
    max: (index + 1) / 5,
    rows: [],
  }));
  for (const row of scored) {
    const index = Math.min(4, Math.floor(row.probability * 5));
    bins[index].rows.push(row);
  }
  return bins.map((bin) => {
    const meanProbability = bin.rows.length
      ? bin.rows.reduce((sum, row) => sum + row.probability, 0) / bin.rows.length
      : null;
    const observedRate = bin.rows.length
      ? bin.rows.reduce((sum, row) => sum + row.target, 0) / bin.rows.length
      : null;
    return {
      quintile: bin.quintile,
      probability_min: bin.min,
      probability_max: bin.max,
      upper_inclusive: bin.quintile === 5,
      count: bin.rows.length,
      predicted_probability_mean: meanProbability == null ? null : round(meanProbability, 6),
      observed_rate: observedRate == null ? null : round(observedRate, 6),
    };
  });
}

function calibrationMetrics(scored) {
  if (!scored.length) {
    return { n: 0, brier_score: null, log_loss: null, bins: [] };
  }
  const brier = scored.reduce((sum, row) => sum + (row.probability - row.target) ** 2, 0) / scored.length;
  const loss = scored.reduce((sum, row) => {
    const p = clampProbability(row.probability);
    return sum - (row.target * Math.log(p) + (1 - row.target) * Math.log(1 - p));
  }, 0) / scored.length;
  return {
    n: scored.length,
    brier_score: round(brier, 8),
    log_loss: round(loss, 8),
    bins: calibrationBins(scored),
  };
}

function modelFeatureMetadata(vector, key) {
  const entry = activeFeatureEntries(vector).find((candidate) => candidate.key === key);
  return entry || {
    feature_key: key,
    value: null,
    state: "not_active",
    evidence_ids: [],
    evidence: [],
  };
}

function sortContributors(contributors) {
  return [...contributors].sort((left, right) =>
    Math.abs(right.contribution) - Math.abs(left.contribution)
      || left.feature_key.localeCompare(right.feature_key)
      || left.key.localeCompare(right.key));
}

function assertModel(model) {
  assertObject(model, "land prediction model");
  if (model.schema !== LAND_PREDICTION_PREDICTOR_SCHEMA
      || model.schema_version !== LAND_PREDICTION_PREDICTOR_VERSION) {
    throw new TypeError("unsupported land prediction model schema");
  }
  if (model.method !== "regularized_logistic_additive") {
    throw new TypeError("unsupported land prediction model method");
  }
  requiredText(model.model_name, "model_name");
  requiredText(model.model_version, "model_version");
  if (!Number.isFinite(model.intercept)) throw new TypeError("model intercept is required");
  if (!Array.isArray(model.coefficients)) throw new TypeError("model coefficients must be an array");
  for (const coefficient of model.coefficients) {
    requiredText(coefficient.key, "model coefficient.key");
    if (!Number.isFinite(coefficient.value)) throw new TypeError("model coefficient.value must be finite");
  }
  return model;
}

/**
 * Fit a deterministic additive logistic model. Every row must provide a
 * feature vector whose evidence is available at its cutoff and an outcome
 * observed strictly after that cutoff.
 */
export function fitLandPredictionModel(rows = [], options = {}) {
  if (!Array.isArray(rows) || !rows.length) {
    throw new TypeError("at least one historically valid training row is required");
  }
  const opts = validateTrainingOptions(options);
  const examples = rows.map(trainingExample);
  const featureKeySet = new Set(examples.flatMap((example) =>
    activeFeatureEntries(example.vector).map((entry) => entry.key)));
  const featureKeys = [...featureKeySet].sort();
  const vectors = examples.map((example) => trainingFeatureMap(example.vector, featureKeySet));
  const weights = new Array(featureKeys.length).fill(0);
  const positiveRate = examples.reduce((sum, example) => sum + example.target, 0) / examples.length;
  let intercept = logit((examples.filter((example) => example.target === 1).length + 0.5)
    / (examples.length + 1));

  // Batch gradient descent is intentionally plain: no random initialization,
  // shuffling, or opaque optimizer state can change a replay.
  for (let iteration = 0; iteration < opts.iterations; iteration += 1) {
    const gradients = new Array(featureKeys.length).fill(0);
    let interceptGradient = 0;
    for (let rowIndex = 0; rowIndex < examples.length; rowIndex += 1) {
      let linear = intercept;
      for (let featureIndex = 0; featureIndex < featureKeys.length; featureIndex += 1) {
        linear += weights[featureIndex] * (vectors[rowIndex].get(featureKeys[featureIndex]) || 0);
      }
      const residual = sigmoid(linear) - examples[rowIndex].target;
      interceptGradient += residual;
      for (let featureIndex = 0; featureIndex < featureKeys.length; featureIndex += 1) {
        gradients[featureIndex] += residual * (vectors[rowIndex].get(featureKeys[featureIndex]) || 0);
      }
    }
    intercept -= opts.learning_rate * interceptGradient / examples.length;
    for (let featureIndex = 0; featureIndex < featureKeys.length; featureIndex += 1) {
      gradients[featureIndex] = gradients[featureIndex] / examples.length
        + opts.l2 * weights[featureIndex];
      weights[featureIndex] -= opts.learning_rate * gradients[featureIndex];
    }
  }

  const coefficients = featureKeys.map((key, index) => ({
    key,
    value: round(weights[index]),
  }));
  const trainFrom = examples.map((example) => example.vector.prediction_as_of).sort()[0].slice(0, 10);
  const trainTo = examples.map((example) => example.vector.prediction_as_of).sort().at(-1).slice(0, 10);
  const trainingFingerprint = sha256Hex(stableStringify(examples.map((example) => ({
    id: example.id,
    outcome: example.outcome,
    outcome_at: example.outcome_at,
    vector: example.vector,
  })).sort((left, right) => left.id.localeCompare(right.id) || stableStringify(left).localeCompare(stableStringify(right)))));
  const model = {
    schema: LAND_PREDICTION_PREDICTOR_SCHEMA,
    schema_version: LAND_PREDICTION_PREDICTOR_VERSION,
    model_name: LAND_PREDICTION_MODEL_NAME,
    model_version: LAND_PREDICTION_MODEL_VERSION,
    method: "regularized_logistic_additive",
    target: {
      name: LAND_PREDICTION_TARGET,
      positive_outcome: "approved",
      negative_outcomes: ["disapproved", "modified"],
    },
    intercept: round(intercept),
    coefficients,
    training: {
      n: examples.length,
      positive_rate: round(positiveRate, 8),
      train_from: trainFrom,
      train_to: trainTo,
      historical_validity: "outcome_at strictly after each snapshot prediction_as_of; feature evidence at or before cutoff",
      training_fingerprint: trainingFingerprint,
      optimizer: {
        learning_rate: opts.learning_rate,
        iterations: opts.iterations,
        l2: opts.l2,
      },
    },
    feature_schema: LAND_PREDICTION_FEATURE_VECTOR_SCHEMA,
    calibration: { status: "measured_on_training_data", ...calibrationMetrics([]) },
    authoritative: false,
    promotion_status: "shadow_only_until_backtest_gate",
    fallback: LAND_PREDICTION_BASELINE_MODEL,
  };
  const scored = examples.map((example) => {
    const featureMap = trainingFeatureMap(example.vector, featureKeySet);
    const linear = model.intercept + model.coefficients.reduce((sum, coefficient) =>
      sum + coefficient.value * (featureMap.get(coefficient.key) || 0), 0);
    return { probability: round(clampProbability(sigmoid(linear)), 8), target: example.target };
  });
  model.calibration = { status: "measured_on_training_data", ...calibrationMetrics(scored) };
  return assertModel(model);
}

/** Measure Brier score, log loss, and fixed probability-bin calibration. */
export function measureLandPredictionCalibration(model, rows = []) {
  assertModel(model);
  if (!Array.isArray(rows)) throw new TypeError("calibration rows must be an array");
  const scored = rows.map(trainingExample).map((example) => {
    const prediction = predictLandPrediction(model, example.vector);
    return { probability: prediction.probability, target: example.target };
  });
  return { status: "measured", ...calibrationMetrics(scored) };
}

function featureState(vector) {
  const counts = Object.fromEntries([
    "known", "unknown", "no_known_position", "neutral_mixed",
  ].map((state) => [state, vector.features.filter((feature) => feature.state === state).length]));
  return {
    prediction_as_of: vector.prediction_as_of,
    procedural_stage: vector.procedural_stage,
    counts,
    features: vector.features.map((feature) => ({
      key: feature.key,
      value: feature.value,
      state: feature.state,
      observed_at: feature.observed_at,
      effective_at: feature.effective_at,
      evidence_ids: [...feature.evidence_ids].map(String).sort(),
    })),
    interactions: vector.stage_interactions.map((interaction) => ({ ...interaction })),
  };
}

/** Predict from a C5 vector and expose additive evidence contributions. */
export function predictLandPrediction(model, input, options = {}) {
  assertModel(model);
  const vector = vectorFromInput(input);
  const featureKeySet = new Set(model.coefficients.map((coefficient) => coefficient.key));
  const active = trainingFeatureMap(vector, featureKeySet);
  const contributions = model.coefficients
    .filter((coefficient) => active.has(coefficient.key) && active.get(coefficient.key) !== 0)
    .map((coefficient) => {
      const metadata = modelFeatureMetadata(vector, coefficient.key);
      const contribution = coefficient.value * active.get(coefficient.key);
      return {
        key: coefficient.key,
        feature_key: metadata.feature_key,
        value: metadata.value,
        state: metadata.state,
        coefficient: coefficient.value,
        contribution: round(contribution),
        direction: contribution > 0 ? "toward_approved" : contribution < 0 ? "away_from_approved" : "neutral",
        evidence_ids: metadata.evidence_ids,
        evidence: metadata.evidence,
      };
    });
  const logOdds = model.intercept + contributions.reduce((sum, item) => sum + item.contribution, 0);
  const probability = round(clampProbability(sigmoid(logOdds)), 8);
  const maxContributors = Number.isSafeInteger(options.max_contributors) && options.max_contributors >= 0
    ? options.max_contributors
    : DEFAULT_OPTIONS.max_contributors;
  const timestamp = options.prediction_timestamp
    ? canonicalInstant(options.prediction_timestamp, "prediction_timestamp")
    : vector.prediction_as_of;
  if (Date.parse(timestamp) < Date.parse(vector.prediction_as_of)) {
    throw new TypeError("prediction_timestamp must not precede prediction_as_of");
  }
  const subjectRef = String(options.subject_ref || `project:${vector.application_id}`).trim();
  const majorContributors = sortContributors(contributions).slice(0, maxContributors);
  const prediction = {
    schema: LAND_PREDICTION_PREDICTOR_SCHEMA,
    schema_version: LAND_PREDICTION_PREDICTOR_VERSION,
    prediction_id: `landpred:${sha256Hex(`${subjectRef}|${vector.prediction_as_of}|${model.model_name}|${model.model_version}|${model.training.training_fingerprint}`).slice(0, 24)}`,
    subject_ref: subjectRef,
    application_id: vector.application_id,
    target: LAND_PREDICTION_TARGET,
    probability,
    timestamp,
    prediction_timestamp: timestamp,
    generated_at: timestamp,
    prediction_as_of: vector.prediction_as_of,
    model_name: model.model_name,
    model_version: model.model_version,
    model_method: model.method,
    authoritative: false,
    promotion_status: model.promotion_status,
    feature_state: featureState(vector),
    major_contributors: majorContributors,
    model_explanation: {
      intercept: model.intercept,
      log_odds: round(logOdds),
      active_feature_count: active.size,
      major_contributors: majorContributors,
      basis: "predictive association from a fitted logistic model; not a causal claim",
    },
    fallback: {
      ...LAND_PREDICTION_BASELINE_MODEL,
      available: true,
      used: false,
      reason: null,
    },
  };
  return {
    ...prediction,
    explanation: buildLandPredictionExplanation(prediction),
  };
}

/**
 * Keep the incumbent path available when V2 cannot run. A caller may provide
 * the existing baseline adapter; otherwise this honest descriptor preserves
 * the fallback identity without inventing a baseline approval probability.
 */
export function currentLandPredictionFallback(input, reason = "v2_unavailable", fallbackPredictor = null) {
  const vector = vectorFromInput(input);
  const base = typeof fallbackPredictor === "function"
    ? fallbackPredictor(vector)
    : {
        ...LAND_PREDICTION_BASELINE_MODEL,
        probability: null,
        probability_status: "not_available_from_incumbent_contract",
      };
  return {
    schema: LAND_PREDICTION_PREDICTOR_SCHEMA,
    schema_version: LAND_PREDICTION_PREDICTOR_VERSION,
    application_id: vector.application_id,
    target: LAND_PREDICTION_TARGET,
    probability: base.probability ?? null,
    prediction_timestamp: vector.prediction_as_of,
    timestamp: vector.prediction_as_of,
    prediction_as_of: vector.prediction_as_of,
    model_name: base.model_name || LAND_PREDICTION_BASELINE_MODEL.model_name,
    model_version: base.model_version || LAND_PREDICTION_BASELINE_MODEL.model_version,
    feature_state: featureState(vector),
    major_contributors: [],
    fallback: {
      ...base,
      used: true,
      reason: requiredText(reason, "fallback reason"),
    },
    authoritative: true,
    promotion_status: "incumbent",
  };
}

/** Run V2 while preserving an explicit incumbent fallback on model failure. */
export function predictLandUse(model, input, options = {}) {
  try {
    return predictLandPrediction(model, input, options);
  } catch (error) {
    if (options.fallback === false) throw error;
    return currentLandPredictionFallback(
      input,
      `v2_failed:${error.name || "Error"}`,
      options.fallback_predictor || null,
    );
  }
}

export const buildLandPredictionModel = fitLandPredictionModel;
export const predictLandUseOutcome = predictLandPrediction;
export const validateLandPredictionModel = assertModel;
