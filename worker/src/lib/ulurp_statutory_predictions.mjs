/**
 * Emit cityscroll.prediction.v0 assertions for ULURP statutory clocks.
 *
 * Layer-1 zoning predictions: deterministic Charter day math (no corpus).
 * Uses the shared site clock table; stores assertions via the landed prediction
 * contract only — no parallel prediction representation.
 */

import {
  ULURP_STATUTORY_MODEL_NAME,
  ULURP_STATUTORY_MODEL_VERSION,
  ULURP_STATUTORY_STATUTE_REF,
  ULURP_STATUTORY_STAGES,
  ULURP_STATUTORY_TOTAL_DAYS,
  addCalendarDays,
  buildUlurpStatutoryClockView,
  resolveCertificationDate,
} from "../../../site/ulurp_statutory_clock.mjs";
import { buildPrediction, validatePrediction } from "./prediction_contract.mjs";

export {
  ULURP_STATUTORY_MODEL_NAME,
  ULURP_STATUTORY_MODEL_VERSION,
  ULURP_STATUTORY_STATUTE_REF,
  ULURP_STATUTORY_STAGES,
  ULURP_STATUTORY_TOTAL_DAYS,
  buildUlurpStatutoryClockView,
  resolveCertificationDate,
  detectStaleOpenStatutoryClock,
  completedStatutoryPhases,
  projectIsCompleted,
} from "../../../site/ulurp_statutory_clock.mjs";

/** Per-stage model name so prediction_id is stable and distinct per phase. */
export function stageModelName(modelStage) {
  return `${ULURP_STATUTORY_MODEL_NAME}_${modelStage}`;
}

/**
 * Validate the complete assertion set for one certified project.
 *
 * The phase rows intentionally share land.zap_milestone, so model_name is the
 * phase identity. Requiring the full one-per-stage set keeps phase-aware
 * resolution deterministic and prevents a partial materialization from
 * looking complete to downstream readers.
 */
export function validateUlurpStatutoryPredictionSet(predictions, opts = {}) {
  if (!Array.isArray(predictions)) {
    throw new TypeError("ULURP statutory predictions must be an array");
  }
  const expected = new Map(
    ULURP_STATUTORY_STAGES.map((stage) => [
      stageModelName(stage.model_stage || stage.phase_id),
      "land.zap_milestone",
    ]),
  );
  expected.set(stageModelName("disposition"), "land.zap_disposition");
  if (predictions.length !== expected.size) {
    throw new TypeError(
      `ULURP statutory prediction set must contain exactly ${expected.size} rows`,
    );
  }

  const seenModels = new Set();
  const seenIds = new Set();
  let subjectRef = opts.subjectRef || null;
  let generatedAt = null;
  for (const prediction of predictions) {
    validatePrediction(prediction);
    if (seenModels.has(prediction.model_name)) {
      throw new TypeError(`duplicate ULURP statutory model: ${prediction.model_name}`);
    }
    seenModels.add(prediction.model_name);
    if (seenIds.has(prediction.prediction_id)) {
      throw new TypeError(`duplicate ULURP statutory prediction id: ${prediction.prediction_id}`);
    }
    seenIds.add(prediction.prediction_id);
    if (subjectRef == null) subjectRef = prediction.subject_ref;
    if (prediction.subject_ref !== subjectRef) {
      throw new TypeError("ULURP statutory predictions must share one subject_ref");
    }
    if (generatedAt == null) generatedAt = prediction.generated_at;
    if (prediction.generated_at !== generatedAt) {
      throw new TypeError("ULURP statutory predictions must share one generated_at");
    }
    const expectedKind = expected.get(prediction.model_name);
    if (!expectedKind) throw new TypeError(`unexpected ULURP statutory model: ${prediction.model_name}`);
    if (prediction.predicted_event_kind !== expectedKind) {
      throw new TypeError(
        `${prediction.model_name} must target ${expectedKind}`,
      );
    }
  }
  for (const modelName of expected.keys()) {
    if (!seenModels.has(modelName)) {
      throw new TypeError(`missing ULURP statutory model: ${modelName}`);
    }
  }
  return predictions;
}

function subjectRefFor(record) {
  const id = String(record?.project_id || record?.open_data?.project_id || "").trim();
  if (!id) throw new TypeError("ULURP statutory predictions require project_id");
  return `project:${id}`;
}

function pointWindow(dueDate) {
  return { p10: dueDate, p50: dueDate, p90: dueDate };
}

function statutoryBasis({ cohort, evidenceEventIds, trainTo }) {
  return {
    method: "statutory_clock",
    n: 0,
    // Statute is fixed law, not a fitted sample — anchor the train window to
    // the certification date that starts the clock for this project.
    train_from: trainTo,
    train_to: trainTo,
    cohort,
    evidence_event_ids: evidenceEventIds,
    statute_ref: ULURP_STATUTORY_STATUTE_REF,
  };
}

/**
 * Phase-aware resolution for statutory predictions.
 *
 * Cannot use generic resolvePredictions: every public-review stage shares
 * predicted_event_kind land.zap_milestone, so a single CB completion would
 * incorrectly close BP/CPC/Council assertions. Pair by model_stage instead.
 */
export function resolveStatutoryPrediction(prediction, phaseOrDisposition, opts = {}) {
  if (!prediction || prediction.status !== "open") return prediction;
  const graceDays = opts.graceDays ?? 14;
  const status = phaseOrDisposition?.status;
  if (status !== "completed") return prediction;

  const evidenceId =
    phaseOrDisposition.evidence_id
    || (phaseOrDisposition.phase_id
      ? `ulurp-phase-closed:${phaseOrDisposition.phase_id}:terminal`
      : `ulurp-disposition-closed:terminal`);

  const realizedDay = phaseOrDisposition.completed_at
    ? String(phaseOrDisposition.completed_at).slice(0, 10)
    : null;
  if (!realizedDay) {
    // Terminal project status closed the stage without a dated milestone.
    return validatePrediction({
      ...prediction,
      status: "resolved_hit",
      resolved_by_event_id: evidenceId,
    });
  }

  const p10 = prediction.predicted_window?.p10;
  const p90 = prediction.predicted_window?.p90;
  if (!p10 || !p90) {
    return validatePrediction({
      ...prediction,
      status: "resolved_hit",
      resolved_by_event_id: evidenceId,
    });
  }

  // Calendar grace around the point statutory deadline.
  const lowerMs = Date.parse(`${p10}T00:00:00Z`) - graceDays * 86_400_000;
  const upperMs = Date.parse(`${p90}T00:00:00Z`) + graceDays * 86_400_000;
  const realizedMs = Date.parse(`${realizedDay}T00:00:00Z`);
  const hit = Number.isFinite(realizedMs) && realizedMs >= lowerMs && realizedMs <= upperMs;
  return validatePrediction({
    ...prediction,
    status: hit ? "resolved_hit" : "resolved_miss",
    resolved_by_event_id: evidenceId,
  });
}

/**
 * Emit timing predictions for each statutory stage plus the final
 * land.zap_disposition. Returns [] when the project is not certified.
 *
 * Intermediate stages target land.zap_milestone (phase conclusion on the ZAP
 * rail). The final prediction targets land.zap_disposition.
 *
 * Completed phases resolve phase-by-stage (hit/miss vs the statutory due date).
 * Withdrawn projects keep status withdrawn. Open phases stay open.
 */
export function emitUlurpStatutoryPredictions(record = {}, opts = {}) {
  const clock = buildUlurpStatutoryClockView(record, {
    generatedAt: opts.generatedAt || record.generated_at || new Date().toISOString(),
  });
  if (!clock || clock.status === "ineligible" || !clock.certified_date) return [];

  const generatedAt = clock.generated_at || opts.generatedAt || new Date().toISOString();
  const subjectRef = subjectRefFor(record);
  const trainTo = clock.certified_date;
  const evidence = clock.evidence_event_ids?.length
    ? clock.evidence_event_ids
    : [`ulurp-certification:${record.project_id}:${trainTo}`];
  const withdrawn = clock.status === "withdrawn";
  const graceDays = opts.graceDays ?? 14;
  const out = []; // cityscroll.prediction.v0 timing rows (Charter §197-c stages)

  for (const phase of clock.phases || []) {
    if (!phase.due_date) continue;
    let prediction = buildPrediction({
      subject_ref: subjectRef,
      predicted_event_kind: "land.zap_milestone",
      claim: "timing",
      predicted_window: pointWindow(phase.due_date),
      // Point statutory deadline — not a probability of approval.
      probability: 1,
      basis: statutoryBasis({
        cohort: `ulurp.statutory · ${phase.phase_id}`,
        evidenceEventIds: evidence,
        trainTo,
      }),
      model_name: stageModelName(phase.model_stage || phase.phase_id),
      model_version: ULURP_STATUTORY_MODEL_VERSION,
      generated_at: generatedAt,
      supersedes_prediction_id: null,
      status: withdrawn ? "withdrawn" : "open",
      resolved_by_event_id: null,
    });
    if (!withdrawn) {
      prediction = resolveStatutoryPrediction(prediction, phase, { graceDays });
    }
    out.push(validatePrediction(prediction));
  }

  if (clock.disposition?.due_date) {
    let prediction = buildPrediction({
      subject_ref: subjectRef,
      predicted_event_kind: "land.zap_disposition",
      claim: "timing",
      predicted_window: pointWindow(clock.disposition.due_date),
      probability: 1,
      basis: statutoryBasis({
        cohort: "ulurp.statutory · final_disposition",
        evidenceEventIds: evidence,
        trainTo,
      }),
      model_name: stageModelName("disposition"),
      model_version: ULURP_STATUTORY_MODEL_VERSION,
      generated_at: generatedAt,
      supersedes_prediction_id: null,
      status: withdrawn ? "withdrawn" : "open",
      resolved_by_event_id: null,
    });
    if (!withdrawn) {
      prediction = resolveStatutoryPrediction(prediction, clock.disposition, { graceDays });
    }
    out.push(validatePrediction(prediction));
  }

  return validateUlurpStatutoryPredictionSet(out, { subjectRef });
}

/**
 * Attach precomputed statutory clock + prediction assertions to a land outcome
 * record (batch / materialization path only).
 */
export function attachUlurpStatutoryPredictions(record, opts = {}) {
  if (!record || typeof record !== "object") return record;
  const generatedAt = opts.generatedAt || record.generated_at || new Date().toISOString();
  const statutory_clock = buildUlurpStatutoryClockView(record, { generatedAt });
  const predictions = emitUlurpStatutoryPredictions(record, { generatedAt });
  return {
    ...record,
    statutory_clock,
    predictions,
  };
}

/** Fixture helper: deadlines for a pure certification date D. */
export function statutoryDeadlinesFromCertification(certifiedDate) {
  const d = String(certifiedDate || "").slice(0, 10);
  return {
    community_board: addCalendarDays(d, 60),
    borough_president: addCalendarDays(d, 90),
    cpc: addCalendarDays(d, 150),
    city_council: addCalendarDays(d, 200),
    mayoral_appeals: addCalendarDays(d, 205),
    disposition: addCalendarDays(d, ULURP_STATUTORY_TOTAL_DAYS),
  };
}
