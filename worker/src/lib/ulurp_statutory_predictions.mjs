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
} from "../../../site/ulurp_statutory_clock.mjs";

/** Per-stage model name so prediction_id is stable and distinct per phase. */
export function stageModelName(modelStage) {
  return `${ULURP_STATUTORY_MODEL_NAME}_${modelStage}`;
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
 * Emit open (or withdrawn) timing predictions for each statutory stage plus
 * the final land.zap_disposition. Returns [] when the project is not certified.
 *
 * Intermediate stages target land.zap_milestone (phase conclusion on the ZAP
 * rail). The final prediction targets land.zap_disposition.
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
  const status = clock.status === "withdrawn" ? "withdrawn" : "open";
  // cityscroll.prediction.v0 timing rows for statutory stages (Charter §197-c).
  const out = [];

  for (const phase of clock.phases || []) {
    if (!phase.due_date) continue;
    out.push(
      buildPrediction({
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
        status,
        resolved_by_event_id: null,
      }),
    );
  }

  if (clock.disposition?.due_date) {
    out.push(
      buildPrediction({
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
        status,
        resolved_by_event_id: null,
      }),
    );
  }

  return out.map(validatePrediction);
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
