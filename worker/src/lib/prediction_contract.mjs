// Prediction assertion contract for batch-computed civic timelines.
//
// Predictions refer to registered civic event kinds, but are derived claims in
// their own store. They are never civic event envelopes and never pass through
// mapCivicEvent. See docs/adr/evidence-assertion-layer.md.

import { isRegisteredEventKind, sha256Hex } from "./civic_time.mjs";
import { derivedConclusionClaim } from "./claim_layer.mjs";

export const PREDICTION_SCHEMA = "cityscroll.prediction.v0";
export const PREDICTION_SCHEMA_VERSION = 1;

export const PREDICTION_CLAIMS = Object.freeze(["timing", "occurrence"]);
export const PREDICTION_STATUSES = Object.freeze([
  "open",
  "resolved_hit",
  "resolved_miss",
  "expired",
  "withdrawn",
]);
export const PREDICTION_METHODS = Object.freeze([
  "statutory_clock",
  "term_arithmetic",
  "phase_duration_ecdf",
  "base_rate",
  "cadence",
]);
export const PREDICTION_BANDS = Object.freeze(["far", "approaching", "imminent", "overdue"]);

// Predictions own only generated_at. Keep every civic-time source/processing
// clock on this deny-list so a future assertion cannot become an event-shaped
// row by adding a range or processing timestamp in a nested object.
const SOURCE_CLOCK_FIELDS = new Set([
  "valid_at",
  "valid_from",
  "valid_to",
  "published_at",
  "observed_at",
  "processed_at",
]);
const TOP_LEVEL_FIELDS = new Set([
  "schema_version",
  "prediction_id",
  "subject_ref",
  "predicted_event_kind",
  "claim",
  "predicted_window",
  "probability",
  "basis",
  "model_name",
  "model_version",
  "generated_at",
  "supersedes_prediction_id",
  "status",
  "resolved_by_event_id",
]);
const WINDOW_FIELDS = new Set(["p10", "p50", "p90"]);
const BASIS_FIELDS = new Set([
  "method",
  "n",
  "train_from",
  "train_to",
  "cohort",
  "evidence_event_ids",
  "statute_ref",
]);
const PREDICTION_ID_PATTERN = /^pred:[a-f0-9]{24}$/;

function assertPlainObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
}

function assertExactFields(value, fields, label) {
  for (const key of Object.keys(value)) {
    if (!fields.has(key)) throw new TypeError(`${label} has unknown field ${key}`);
  }
  const missing = [...fields].filter((key) => !Object.hasOwn(value, key));
  if (missing.length) throw new TypeError(`${label} missing: ${missing.join(", ")}`);
}

function assertNoSourceClocks(value, seen = new WeakSet()) {
  if (!value || typeof value !== "object") return;
  if (seen.has(value)) return;
  seen.add(value);
  for (const [key, child] of Object.entries(value)) {
    if (SOURCE_CLOCK_FIELDS.has(key)) {
      throw new TypeError(`prediction must not carry source clock ${key}`);
    }
    assertNoSourceClocks(child, seen);
  }
}

function isIsoDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value || ""))) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function assertIsoDate(value, label) {
  if (!isIsoDate(value)) throw new TypeError(`${label} must be an ISO date`);
}

function assertInstant(value, label) {
  if (typeof value !== "string" || !value.includes("T") || !Number.isFinite(Date.parse(value))) {
    throw new TypeError(`${label} must be an ISO timestamp`);
  }
}

function cleanRequired(value, label) {
  const cleaned = String(value ?? "").trim();
  if (!cleaned) throw new TypeError(`${label} is required`);
  return cleaned;
}

/** Stable content id; run time and updated predicted windows do not change identity. */
export function makePredictionId(input = {}) {
  const subjectRef = cleanRequired(input.subject_ref, "subject_ref");
  const eventKind = cleanRequired(input.predicted_event_kind, "predicted_event_kind");
  const modelName = cleanRequired(input.model_name, "model_name");
  const modelVersion = cleanRequired(input.model_version, "model_version");
  const trainTo = cleanRequired(input.basis?.train_to, "basis.train_to");
  return `pred:${sha256Hex(`${subjectRef}|${eventKind}|${modelName}|${modelVersion}|${trainTo}`).slice(0, 24)}`;
}

/** Validate without mapping the assertion into the civic event stream. */
export function validatePrediction(value) {
  assertPlainObject(value, "prediction");
  assertNoSourceClocks(value);
  assertExactFields(value, TOP_LEVEL_FIELDS, "prediction");

  if (value.schema_version !== PREDICTION_SCHEMA_VERSION) {
    throw new TypeError(`unsupported prediction schema_version: ${value.schema_version}`);
  }
  if (!PREDICTION_ID_PATTERN.test(String(value.prediction_id || ""))) {
    throw new TypeError("prediction_id must be pred: plus 24 lowercase sha256 hex characters");
  }
  const subjectRef = cleanRequired(value.subject_ref, "subject_ref");
  if (!/^[A-Za-z][A-Za-z0-9-]*:.+/.test(subjectRef)) {
    throw new TypeError("subject_ref must use the kind:id form");
  }
  if (!isRegisteredEventKind(value.predicted_event_kind)) {
    throw new TypeError(`unknown predicted_event_kind: ${value.predicted_event_kind}`);
  }
  if (!PREDICTION_CLAIMS.includes(value.claim)) {
    throw new TypeError(`unknown prediction claim: ${value.claim}`);
  }

  assertPlainObject(value.predicted_window, "predicted_window");
  assertExactFields(value.predicted_window, WINDOW_FIELDS, "predicted_window");
  for (const quantile of WINDOW_FIELDS) {
    assertIsoDate(value.predicted_window[quantile], `predicted_window.${quantile}`);
  }
  const { p10, p50, p90 } = value.predicted_window;
  if (!(p10 <= p50 && p50 <= p90)) {
    throw new TypeError("predicted_window must satisfy p10 <= p50 <= p90");
  }

  if (typeof value.probability !== "number" || !Number.isFinite(value.probability)
      || value.probability < 0 || value.probability > 1) {
    throw new TypeError("probability must be between 0 and 1");
  }

  assertPlainObject(value.basis, "basis");
  assertExactFields(value.basis, BASIS_FIELDS, "basis");
  if (!PREDICTION_METHODS.includes(value.basis.method)) {
    throw new TypeError(`unknown prediction basis method: ${value.basis.method}`);
  }
  if (!Number.isSafeInteger(value.basis.n) || value.basis.n < 0) {
    throw new TypeError("basis.n must be a non-negative integer");
  }
  assertIsoDate(value.basis.train_from, "basis.train_from");
  assertIsoDate(value.basis.train_to, "basis.train_to");
  if (value.basis.train_from > value.basis.train_to) {
    throw new TypeError("basis train window must satisfy train_from <= train_to");
  }
  cleanRequired(value.basis.cohort, "basis.cohort");
  if (!Array.isArray(value.basis.evidence_event_ids)
      || !value.basis.evidence_event_ids.every((id) => typeof id === "string" && id.trim())) {
    throw new TypeError("basis.evidence_event_ids must be an array of ids");
  }
  if (value.basis.statute_ref !== null
      && (typeof value.basis.statute_ref !== "string" || !value.basis.statute_ref.trim())) {
    throw new TypeError("basis.statute_ref must be a non-empty string or null");
  }

  cleanRequired(value.model_name, "model_name");
  cleanRequired(value.model_version, "model_version");
  assertInstant(value.generated_at, "generated_at");
  if (!PREDICTION_STATUSES.includes(value.status)) {
    throw new TypeError(`unknown prediction status: ${value.status}`);
  }
  if (value.supersedes_prediction_id !== null
      && !PREDICTION_ID_PATTERN.test(String(value.supersedes_prediction_id || ""))) {
    throw new TypeError("supersedes_prediction_id must be a prediction id or null");
  }
  if (value.supersedes_prediction_id === value.prediction_id) {
    throw new TypeError("prediction cannot supersede itself");
  }
  const isResolved = value.status === "resolved_hit" || value.status === "resolved_miss";
  if (isResolved && (typeof value.resolved_by_event_id !== "string" || !value.resolved_by_event_id.trim())) {
    throw new TypeError(`${value.status} requires resolved_by_event_id`);
  }
  if (!isResolved && value.resolved_by_event_id !== null) {
    throw new TypeError(`${value.status} prediction must have null resolved_by_event_id`);
  }

  const expectedId = makePredictionId(value);
  if (value.prediction_id !== expectedId) {
    throw new TypeError(`prediction_id does not match assertion content; expected ${expectedId}`);
  }
  return value;
}

/** Build the exact v0 shape and derive its stable prediction_id. */
export function buildPrediction(input = {}) {
  assertPlainObject(input, "prediction input");
  const value = {
    ...input,
    schema_version: input.schema_version ?? PREDICTION_SCHEMA_VERSION,
    prediction_id: input.prediction_id ?? makePredictionId(input),
  };
  return validatePrediction(value);
}

/** Claim-layer adapter: prediction remains a derived conclusion, not a fourth register. */
export function predictionClaimLayer(prediction) {
  validatePrediction(prediction);
  return derivedConclusionClaim({
    fact: "prediction",
    label: "Prediction",
    value: {
      claim: prediction.claim,
      predicted_event_kind: prediction.predicted_event_kind,
      predicted_window: { ...prediction.predicted_window },
      probability: prediction.probability,
    },
    summary: "Civic timeline prediction derived from cited evidence.",
    evidence_assertion_ids: prediction.basis.evidence_event_ids,
  });
}

function dayValue(value, label) {
  const raw = String(value || "");
  const day = raw.slice(0, 10);
  assertIsoDate(day, label);
  return Date.parse(`${day}T00:00:00Z`);
}

function addDays(value, days) {
  return new Date(dayValue(value, "date") + days * 86_400_000).toISOString().slice(0, 10);
}

/** Quantize an open prediction into the resend-safe delivery grammar. */
export function predictionBand(prediction, opts = {}) {
  validatePrediction(prediction);
  if (prediction.status !== "open") return null;
  const today = new Date(opts.now ?? Date.now()).toISOString().slice(0, 10);
  if (prediction.predicted_window.p90 < today) return "overdue";
  const daysToMedian = Math.round(
    (dayValue(prediction.predicted_window.p50, "predicted_window.p50") - dayValue(today, "now"))
      / 86_400_000,
  );
  if (daysToMedian <= 14) return "imminent";
  if (daysToMedian <= 90) return "approaching";
  return "far";
}

export function predictionDeliveryKey(prediction, opts = {}) {
  const band = predictionBand(prediction, opts);
  if (!band) return null;
  return `pred:${prediction.subject_ref}:${prediction.predicted_event_kind}:${band}`;
}

/** Return a key only when actionable band state changed; far is never delivered. */
export function predictionDeliveryTransition(previous, current, opts = {}) {
  const currentBand = predictionBand(current, opts);
  if (!currentBand || currentBand === "far") return null;
  const previousBand = previous ? predictionBand(previous, opts) : null;
  return previousBand === currentBand ? null : predictionDeliveryKey(current, opts);
}

function eventDate(event) {
  return event?.valid_at || event?.valid_from || event?.published_at || null;
}

function exactEventMatches(prediction, events) {
  return events
    .filter((event) => event.subject_ref === prediction.subject_ref
      && event.event_kind === prediction.predicted_event_kind)
    .sort((left, right) => {
      const leftDate = eventDate(left) || "9999-12-31";
      const rightDate = eventDate(right) || "9999-12-31";
      return leftDate.localeCompare(rightDate) || String(left.event_id).localeCompare(String(right.event_id));
    });
}

export function predictionHorizonAt(prediction, opts = {}) {
  validatePrediction(prediction);
  const domain = prediction.predicted_event_kind.split(".", 1)[0];
  const days = opts.horizonDaysByDomain?.[domain];
  if (!Number.isSafeInteger(days) || days < 0) return null;
  return new Date(Date.parse(prediction.generated_at) + days * 86_400_000).toISOString();
}

/**
 * Resolve open assertions against realized registered events by exact
 * (subject_ref, predicted_event_kind), or expire them at configured horizons.
 */
export function resolvePredictions(predictions = [], realizedEvents = [], opts = {}) {
  const rows = Array.isArray(predictions) ? predictions : [];
  const events = Array.isArray(realizedEvents) ? realizedEvents : [];
  const graceDays = opts.graceDays ?? 0;
  if (!Number.isSafeInteger(graceDays) || graceDays < 0) {
    throw new TypeError("graceDays must be a non-negative integer");
  }
  for (const event of events) {
    if (!event || typeof event !== "object" || !event.event_id || !event.subject_ref) {
      throw new TypeError("realized event requires event_id and subject_ref");
    }
    if (!isRegisteredEventKind(event.event_kind)) {
      throw new TypeError(`unknown realized event_kind: ${event.event_kind}`);
    }
  }
  const now = new Date(opts.now ?? Date.now()).toISOString();

  return rows.map((prediction) => {
    validatePrediction(prediction);
    if (prediction.status !== "open") return prediction;
    const [event] = exactEventMatches(prediction, events);
    if (event) {
      let hit = prediction.claim === "occurrence";
      if (prediction.claim === "timing") {
        const realizedAt = eventDate(event);
        if (!realizedAt) return prediction;
        const realizedDay = String(realizedAt).slice(0, 10);
        assertIsoDate(realizedDay, "realized event date");
        const lower = addDays(prediction.predicted_window.p10, -graceDays);
        const upper = addDays(prediction.predicted_window.p90, graceDays);
        hit = realizedDay >= lower && realizedDay <= upper;
      }
      return validatePrediction({
        ...prediction,
        status: hit ? "resolved_hit" : "resolved_miss",
        resolved_by_event_id: String(event.event_id),
      });
    }
    const horizonAt = predictionHorizonAt(prediction, opts);
    if (horizonAt && now > horizonAt) {
      return validatePrediction({ ...prediction, status: "expired", resolved_by_event_id: null });
    }
    return prediction;
  });
}

/** Preserve evaluation history unless the supersession explicitly retracts it. */
export function applyPredictionSupersession(existing = [], replacement, opts = {}) {
  validatePrediction(replacement);
  const rows = (Array.isArray(existing) ? existing : []).map((row) => validatePrediction(row));
  if (!replacement.supersedes_prediction_id) return [...rows, replacement];
  const index = rows.findIndex((row) => row.prediction_id === replacement.supersedes_prediction_id);
  if (index < 0) throw new TypeError("supersedes_prediction_id does not identify an existing prediction");
  const next = [...rows];
  if (opts.retractSuperseded === true && next[index].status === "open") {
    next[index] = validatePrediction({
      ...next[index],
      status: "withdrawn",
      resolved_by_event_id: null,
    });
  }
  next.push(replacement);
  return next;
}
