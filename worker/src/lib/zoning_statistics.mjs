/**
 * Transparent layer-2 zoning statistics over materialized ZAP project rows.
 *
 * Cohorts are deliberately unconditioned: action type + borough, then a
 * deterministic n>=20 back-off. Applicant identity is neither read nor emitted.
 */

import { buildPrediction } from "./prediction_contract.mjs";

export const MIN_ZONING_COHORT = 20;
export const MAX_ZONING_DURATION_DAYS = 730;
export const ZONING_STATISTICS_SCHEMA_VERSION = 1;
export const ZONING_STATISTICS_MODEL_NAME = "zap_disposition_duration";
export const ZONING_STATISTICS_MODEL_VERSION = "1.0.0";

const DAY_MS = 86_400_000;
const TERMINAL_APPROVED = "approved";
const TERMINAL_DISAPPROVED = "disapproved";
const OUTCOMES = Object.freeze(["approved", "modified", "disapproved"]);
const ACTION_LABELS = Object.freeze({
  HA: "urban development action area",
  HG: "urban renewal designation",
  MM: "city map change",
  PC: "site acquisition",
  PQ: "property acquisition",
  ZA: "zoning authorization",
  ZC: "zoning certification",
  ZM: "zoning map amendment",
  ZR: "zoning text amendment",
  ZS: "zoning special permit",
});

function clean(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function day(value) {
  const match = clean(value).match(/^(\d{4}-\d{2}-\d{2})/);
  if (!match) return null;
  const parsed = new Date(`${match[1]}T00:00:00Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === match[1]
    ? match[1]
    : null;
}

function dayNumber(value) {
  return Date.parse(`${value}T00:00:00Z`) / DAY_MS;
}

function addDays(value, days) {
  return new Date((dayNumber(value) + days) * DAY_MS).toISOString().slice(0, 10);
}

function round4(value) {
  return Math.round(Number(value) * 10_000) / 10_000;
}

function round1(value) {
  return Math.round(Number(value) * 10) / 10;
}

function quantile(sorted, probability) {
  if (!sorted.length) return null;
  const index = Math.max(0, Math.ceil(probability * sorted.length) - 1);
  return sorted[Math.min(index, sorted.length - 1)];
}

export function actionTypes(value) {
  const raw = Array.isArray(value) ? value : clean(value).split(/[;,|]/);
  return [...new Set(raw.map((item) => clean(item).toUpperCase()).filter(Boolean))];
}

export function primaryActionType(value) {
  return actionTypes(value)[0] || "ALL";
}

function normalizeBorough(value) {
  const borough = clean(value);
  return borough || "Citywide";
}

/**
 * Project-level outcome from ZAP project-action dispositions.
 *
 * A mix of approved and non-approved terminal actions is "modified". Pure
 * withdrawals and administrative terminations are excluded rather than being
 * mislabeled as a government disapproval.
 */
export function classifyProjectOutcome(row = {}) {
  const explicit = clean(row.outcome).toLowerCase();
  if (OUTCOMES.includes(explicit)) return explicit;

  const statuses = (Array.isArray(row.action_statuses)
    ? row.action_statuses
    : Array.isArray(row.actions_detailed)
      ? row.actions_detailed.map((action) => action?.status)
      : [])
    .map((status) => clean(status).toLowerCase())
    .filter(Boolean);
  const approved = statuses.includes(TERMINAL_APPROVED);
  const disapproved = statuses.includes(TERMINAL_DISAPPROVED);
  const otherTerminal = statuses.some((status) => status === "withdrawn" || status === "terminated");
  if (approved && (disapproved || otherTerminal)) return "modified";
  if (approved) return "approved";
  if (disapproved) return "disapproved";
  return null;
}

function dispositionDate(row, outcome) {
  const explicit = day(row.disposition_date);
  if (explicit) return explicit;
  const approval = day(row.approval_date);
  if (approval) return approval;
  if (outcome === "modified" || outcome === "disapproved") {
    return day(row.completed_date) || day(row.current_milestone_date);
  }
  return null;
}

function normalizeObservation(row) {
  const certified = day(row.certified_referred || row.certified_date);
  const outcome = classifyProjectOutcome(row);
  const disposed = dispositionDate(row, outcome);
  const durationDays = certified && disposed ? dayNumber(disposed) - dayNumber(certified) : null;
  return {
    project_id: clean(row.project_id),
    action_type: primaryActionType(row.actions || row.action_types),
    borough: normalizeBorough(row.borough),
    certified_date: certified,
    disposition_date: disposed,
    duration_days: Number.isSafeInteger(durationDays)
      && durationDays >= 0
      && durationDays <= MAX_ZONING_DURATION_DAYS
      ? durationDays
      : null,
    outcome,
  };
}

function cohortId(level, actionType, borough) {
  return [level, actionType || "all", borough || "citywide"]
    .join(":")
    .toLowerCase()
    .replace(/[^a-z0-9:]+/g, "-");
}

function summarizeCohort(rows, { level, actionType = null, borough = null }) {
  const outcomes = rows.filter((row) => OUTCOMES.includes(row.outcome));
  const durations = rows
    .map((row) => row.duration_days)
    .filter((value) => Number.isSafeInteger(value) && value >= 0)
    .sort((left, right) => left - right);
  const outcomeCounts = Object.fromEntries(
    OUTCOMES.map((outcome) => [outcome, outcomes.filter((row) => row.outcome === outcome).length]),
  );
  const n = outcomes.length;
  const dates = rows.flatMap((row) => [row.certified_date, row.disposition_date]).filter(Boolean).sort();
  const durationDays = {
    p10: quantile(durations, 0.1),
    p25: quantile(durations, 0.25),
    p50: quantile(durations, 0.5),
    p75: quantile(durations, 0.75),
    p90: quantile(durations, 0.9),
  };
  return {
    cohort_id: cohortId(level, actionType, borough),
    level,
    action_type: actionType,
    action_label: actionType ? (ACTION_LABELS[actionType] || actionType) : "land-use",
    borough,
    n,
    duration_n: durations.length,
    train_from: dates[0] || null,
    train_to: dates.at(-1) || null,
    outcome_counts: outcomeCounts,
    outcome_rates: Object.fromEntries(
      OUTCOMES.map((outcome) => [outcome, n ? round4(outcomeCounts[outcome] / n) : null]),
    ),
    duration_days: durationDays,
    typical_months: {
      low: durationDays.p25 == null ? null : round1(durationDays.p25 / 30.4375),
      high: durationDays.p75 == null ? null : round1(durationDays.p75 / 30.4375),
    },
  };
}

function group(rows, key) {
  const groups = new Map();
  for (const row of rows) {
    const value = key(row);
    if (!groups.has(value)) groups.set(value, []);
    groups.get(value).push(row);
  }
  return groups;
}

/**
 * Build reusable cohort tables. Additional dimensions can be layered later;
 * v1 intentionally emits only public-record action and borough aggregates.
 */
export function buildZoningCohortModel(inputRows = [], opts = {}) {
  const minN = opts.minN ?? MIN_ZONING_COHORT;
  if (!Number.isSafeInteger(minN) || minN < 1) throw new TypeError("minN must be positive");
  const rows = (Array.isArray(inputRows) ? inputRows : []).map(normalizeObservation)
    .filter((row) => row.project_id && (row.outcome || row.duration_days != null));
  const cohorts = [];

  for (const [key, members] of group(rows, (row) => `${row.action_type}\u0000${row.borough}`)) {
    const [actionType, borough] = key.split("\u0000");
    cohorts.push(summarizeCohort(members, {
      level: "action_type_borough",
      actionType,
      borough,
    }));
  }
  for (const [actionType, members] of group(rows, (row) => row.action_type)) {
    cohorts.push(summarizeCohort(members, {
      level: "action_type_citywide",
      actionType,
    }));
  }
  for (const [borough, members] of group(rows, (row) => row.borough)) {
    cohorts.push(summarizeCohort(members, {
      level: "all_actions_borough",
      borough,
    }));
  }
  cohorts.push(summarizeCohort(rows, { level: "citywide" }));

  const eligible = cohorts.filter((cohort) => cohort.n >= minN && cohort.duration_n >= minN);
  const dates = rows.flatMap((row) => [row.certified_date, row.disposition_date]).filter(Boolean).sort();
  return {
    schema_version: ZONING_STATISTICS_SCHEMA_VERSION,
    model_name: ZONING_STATISTICS_MODEL_NAME,
    model_version: ZONING_STATISTICS_MODEL_VERSION,
    minimum_cohort_n: minN,
    train_from: opts.trainFrom || dates[0] || null,
    train_to: opts.trainTo || dates.at(-1) || null,
    source_row_count: rows.length,
    dimensions: ["action_type", "borough"],
    conditioned_on_applicant: false,
    cohorts: eligible.sort((left, right) => left.cohort_id.localeCompare(right.cohort_id)),
  };
}

/** n>=20 back-off: action+borough → action citywide → borough → citywide. */
export function chooseZoningCohort(model, subject = {}) {
  if (!model || !Array.isArray(model.cohorts)) return null;
  const actionType = primaryActionType(subject.actions || subject.action_types);
  const borough = normalizeBorough(subject.borough);
  const candidates = [
    ["action_type_borough", actionType, borough],
    ["action_type_citywide", actionType, null],
    ["all_actions_borough", null, borough],
    ["citywide", null, null],
  ];
  for (const [level, candidateAction, candidateBorough] of candidates) {
    const match = model.cohorts.find((cohort) => cohort.level === level
      && cohort.action_type === candidateAction
      && cohort.borough === candidateBorough);
    if (match) return match;
  }
  return null;
}

export function zoningStatisticCopy(cohort) {
  if (!cohort || !cohort.n || cohort.outcome_rates?.approved == null) return "";
  const year = String(cohort.train_from || "").slice(0, 4) || "—";
  const approved = Math.round(cohort.outcome_rates.approved * 100);
  const low = cohort.typical_months?.low;
  const high = cohort.typical_months?.high;
  return `Based on ${cohort.n} past ${cohort.action_label} cases since ${year}. `
    + `${approved}% were approved. Final action usually came ${low}–${high} months after certification.`;
}

export function emitZoningStatisticalPrediction(record = {}, cohort, opts = {}) {
  if (!cohort || cohort.duration_n < MIN_ZONING_COHORT) return null;
  const source = record.open_data || record;
  const projectId = clean(record.project_id || source.project_id);
  const certified = day(record.certified_referred || source.certified_referred);
  if (!projectId || !certified) return null;
  const duration = cohort.duration_days || {};
  if (![duration.p10, duration.p50, duration.p90].every(Number.isSafeInteger)) return null;
  const generatedAt = opts.generatedAt || record.generated_at || new Date().toISOString();
  const evidenceEventIds = Array.isArray(opts.evidenceEventIds) && opts.evidenceEventIds.length
    ? opts.evidenceEventIds
    : [`zap-zoning-cohort:${cohort.cohort_id}:${cohort.train_to}`];
  return buildPrediction({
    subject_ref: `project:${projectId}`,
    predicted_event_kind: "land.zap_disposition",
    claim: "timing",
    predicted_window: {
      p10: addDays(certified, duration.p10),
      p50: addDays(certified, duration.p50),
      p90: addDays(certified, duration.p90),
    },
    probability: 1,
    basis: {
      method: "phase_duration_ecdf",
      n: cohort.duration_n,
      train_from: opts.trainFrom || cohort.train_from,
      train_to: opts.trainTo || cohort.train_to,
      cohort: cohort.cohort_id,
      evidence_event_ids: evidenceEventIds,
      statute_ref: null,
    },
    model_name: ZONING_STATISTICS_MODEL_NAME,
    model_version: ZONING_STATISTICS_MODEL_VERSION,
    generated_at: generatedAt,
    supersedes_prediction_id: null,
    status: "open",
    resolved_by_event_id: null,
  });
}

/** Attach cohort context and, only after a passing backtest, its timing assertion. */
export function attachZoningStatistics(record, model, opts = {}) {
  if (!record || typeof record !== "object") return record;
  const source = { ...(record.open_data || {}), ...record };
  const cohort = chooseZoningCohort(model, source);
  if (!cohort) return { ...record, zoning_statistics: null };
  const shipBarPassed = model?.backtest?.ship_bar?.status === "pass"
    || opts.requirePassingBacktest === false;
  const prediction = shipBarPassed
    ? emitZoningStatisticalPrediction(record, cohort, opts)
    : null;
  return {
    ...record,
    zoning_statistics: {
      ...cohort,
      copy: zoningStatisticCopy(cohort),
      display_mode: shipBarPassed && prediction
        ? "cohort_statistic_and_timing"
        : "cohort_statistic_only",
      formula_url: "about.html#zoning-base-rates",
    },
    predictions: prediction
      ? [...(Array.isArray(record.predictions) ? record.predictions : []), prediction]
      : (Array.isArray(record.predictions) ? record.predictions : []),
  };
}
