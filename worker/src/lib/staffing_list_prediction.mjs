// Build-time civil-service list-establishment lag model.
//
// Privacy floor: inputs and outputs are exam-level aggregates only. This module
// never accepts or emits applicant rows, names, scores, or list ranks.

import {
  buildListAggregateIndex,
  examNumberKeys,
  joinExamToListAggregate,
} from "./civil_service_list_join.mjs";
import { evaluatePredictionBacktest } from "./prediction_calibration.mjs";
import { buildPrediction } from "./prediction_contract.mjs";

export const STAFFING_LIST_MODEL_NAME = "staffing_list_establishment_lag";
export const STAFFING_LIST_MODEL_VERSION = "1.0.0";
export const STAFFING_LIST_METHOD = "phase_duration_ecdf";
export const STAFFING_LIST_TARGET_KIND = "staffing.list_established";
export const STAFFING_LIST_COHORT_FLOOR = 20;
export const STAFFING_LIST_BACKTEST_SPLIT = "2025-01-01";
export const STAFFING_LIST_SINCE_YEAR = 2018;

const DAY_MS = 86_400_000;
const FORBIDDEN_AGGREGATE_FIELD = /first_name|last_name|middle_name|full_name|ssn|address|phone|email|list_rank|score/i;

function day(value) {
  const raw = String(value || "").slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) return null;
  const parsed = Date.parse(`${raw}T00:00:00Z`);
  return Number.isFinite(parsed) ? raw : null;
}

function addDays(value, days) {
  return new Date(Date.parse(`${value}T00:00:00Z`) + days * DAY_MS)
    .toISOString().slice(0, 10);
}

function gapDays(from, to) {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS);
}

function normalizedExamNumber(value) {
  return examNumberKeys(value).find((key) => /^\d{4}$/.test(key))
    || examNumberKeys(value)[0]
    || null;
}

export function staffingExamType(row = {}) {
  const raw = String(row.exam_type || row.eligibility || row.open_competitive_promotion || "");
  return /promotion/i.test(raw) ? "promotion" : "open_competitive";
}

function scheduleRevisionOrder(row) {
  return [
    day(row.data_current_as_of) || "0000-00-00",
    day(row.application_period_end_date || row.application_end || row.application_close) || "0000-00-00",
    day(row.application_period_start || row.application_start) || "0000-00-00",
    String(row.exam_title || row.title || ""),
  ].join("|");
}

/** Keep the latest published schedule revision for each exact normalized exam number. */
export function canonicalHistoricalSchedule(rows = []) {
  const byExam = new Map();
  for (const row of rows) {
    if (!row || typeof row !== "object" || Array.isArray(row)) continue;
    const examNumber = normalizedExamNumber(row.exam_number);
    if (!examNumber) continue;
    const candidate = {
      exam_number: examNumber,
      application_start: day(row.application_period_start || row.application_start),
      application_close: day(row.application_period_end_date || row.application_end || row.application_close),
      exam_type: staffingExamType(row),
      data_current_as_of: day(row.data_current_as_of),
    };
    const existing = byExam.get(examNumber);
    if (!existing || scheduleRevisionOrder(row) >= existing.order) {
      byExam.set(examNumber, { order: scheduleRevisionOrder(row), row: candidate });
    }
  }
  return [...byExam.values()].map((entry) => entry.row)
    .sort((left, right) => left.exam_number.localeCompare(right.exam_number));
}

function assertAggregatePrivacy(records) {
  for (const row of records || []) {
    for (const key of Object.keys(row || {})) {
      if (FORBIDDEN_AGGREGATE_FIELD.test(key)) {
        throw new Error(`staffing prediction input must not include applicant field: ${key}`);
      }
    }
  }
}

/** Exact exam_number join from schedule application-close dates to list aggregates. */
export function buildScheduleListPairs(scheduleRows = [], listAggregateRows = []) {
  assertAggregatePrivacy(listAggregateRows);
  const schedule = canonicalHistoricalSchedule(scheduleRows);
  const listIndex = buildListAggregateIndex(listAggregateRows);
  const pairs = [];
  const misses = {
    no_list_aggregate: 0,
    missing_application_close: 0,
    missing_established_date: 0,
    established_before_application_close: 0,
  };

  for (const exam of schedule) {
    const aggregate = joinExamToListAggregate(exam.exam_number, listIndex);
    if (!aggregate) {
      misses.no_list_aggregate += 1;
      continue;
    }
    if (!exam.application_close) {
      misses.missing_application_close += 1;
      continue;
    }
    const establishedDate = day(aggregate.established_date);
    if (!establishedDate) {
      misses.missing_established_date += 1;
      continue;
    }
    const lag = gapDays(exam.application_close, establishedDate);
    if (lag < 0) {
      misses.established_before_application_close += 1;
      continue;
    }
    pairs.push({
      exam_number: exam.exam_number,
      exam_type: exam.exam_type,
      application_close: exam.application_close,
      established_date: establishedDate,
      lag_days: lag,
      evidence_event_id: `cte:staffing-list-established:${exam.exam_number}:${establishedDate}`,
    });
  }

  const listDistinct = new Set(
    listAggregateRows.flatMap((row) => examNumberKeys(row.exam_number || row.exam_no || row.exam_no_raw)[0] || []),
  ).size;
  return {
    pairs: pairs.sort((left, right) => left.established_date.localeCompare(right.established_date)
      || left.exam_number.localeCompare(right.exam_number)),
    join: {
      method: "exact_exam_number_zero_pad",
      schedule_rows: scheduleRows.length,
      distinct_schedule_exams: schedule.length,
      distinct_list_aggregate_exams: listDistinct,
      matched_pairs: pairs.length,
      misses,
      privacy: "Exam-level aggregates only; no applicant rows, names, scores, or ranks.",
    },
  };
}

/** Nearest-rank empirical quantile, the inverse ECDF for an observed day sample. */
export function empiricalQuantile(values = [], probability) {
  if (!values.length) return null;
  if (!(probability >= 0 && probability <= 1)) throw new TypeError("probability must be in [0,1]");
  const sorted = [...values].sort((left, right) => left - right);
  const rank = Math.max(1, Math.ceil(probability * sorted.length));
  return sorted[Math.min(sorted.length - 1, rank - 1)];
}

function cohortSummary(key, members, floor) {
  const lags = members.map((pair) => pair.lag_days);
  return {
    key,
    label: key === "citywide" ? "citywide" : key.replaceAll("_", " "),
    n: members.length,
    eligible: key === "citywide" || members.length >= floor,
    p10_days: empiricalQuantile(lags, 0.1),
    p50_days: empiricalQuantile(lags, 0.5),
    p90_days: empiricalQuantile(lags, 0.9),
    median_months: Math.round((empiricalQuantile(lags, 0.5) || 0) / 30.4375),
    train_from: members.map((pair) => pair.established_date).sort()[0] || null,
    train_to: members.map((pair) => pair.established_date).sort().at(-1) || null,
  };
}

export function buildStaffingLagModel(pairs = [], options = {}) {
  const floor = options.cohortFloor ?? STAFFING_LIST_COHORT_FLOOR;
  const citywide = [...pairs];
  const byType = new Map();
  for (const pair of pairs) {
    if (!byType.has(pair.exam_type)) byType.set(pair.exam_type, []);
    byType.get(pair.exam_type).push(pair);
  }
  const members = { citywide };
  for (const [key, rows] of byType) members[key] = rows;
  const cohorts = Object.fromEntries(
    Object.entries(members).map(([key, rows]) => [key, cohortSummary(key, rows, floor)]),
  );
  return { floor, pairs: [...pairs], members, cohorts };
}

export function staffingCohortFor(exam, model) {
  const key = staffingExamType(exam);
  return model.cohorts[key]?.eligible ? key : "citywide";
}

function predictionFor(exam, model, cohortKey, generatedAt, basisWindow = null) {
  const cohort = model.cohorts[cohortKey];
  const applicationClose = day(exam.application_end || exam.application_close);
  if (!cohort || !applicationClose) return null;
  return buildPrediction({
    subject_ref: `exam:${normalizedExamNumber(exam.exam_number)}`,
    predicted_event_kind: STAFFING_LIST_TARGET_KIND,
    claim: "timing",
    predicted_window: {
      p10: addDays(applicationClose, cohort.p10_days),
      p50: addDays(applicationClose, cohort.p50_days),
      p90: addDays(applicationClose, cohort.p90_days),
    },
    probability: 0.8,
    basis: {
      method: STAFFING_LIST_METHOD,
      n: cohort.n,
      train_from: basisWindow?.train_from || cohort.train_from,
      train_to: basisWindow?.train_to || cohort.train_to,
      cohort: `staffing:${cohortKey} · application_close→list_established`,
      evidence_event_ids: model.members[cohortKey].map((pair) => pair.evidence_event_id),
      statute_ref: null,
    },
    model_name: STAFFING_LIST_MODEL_NAME,
    model_version: STAFFING_LIST_MODEL_VERSION,
    generated_at: generatedAt,
    supersedes_prediction_id: null,
    status: "open",
    resolved_by_event_id: null,
  });
}

export function attachStaffingListForecast(exam, model, options = {}) {
  const applicationClose = day(exam?.application_end || exam?.application_close);
  if (!applicationClose || exam?.list_aggregate?.established_date
      || Number(exam?.list_aggregate?.list_count || 0) > 0
      || ["canceled", "postponed"].includes(exam?.schedule_status)) {
    return { ...exam, list_establishment_forecast: null };
  }
  const cohortKey = staffingCohortFor(exam, model);
  const cohort = model.cohorts[cohortKey];
  if (!cohort?.eligible) return { ...exam, list_establishment_forecast: null };
  const allowDate = options.publicProjection === "per_matter_projection";
  return {
    ...exam,
    list_establishment_forecast: {
      method: STAFFING_LIST_METHOD,
      target_event_kind: STAFFING_LIST_TARGET_KIND,
      cohort: cohortKey,
      n: cohort.n,
      since_year: STAFFING_LIST_SINCE_YEAR,
      p10_days: cohort.p10_days,
      p50_days: cohort.p50_days,
      p90_days: cohort.p90_days,
      median_months: cohort.median_months,
      public_projection: options.publicProjection || "cohort_statistic_only",
      prediction: allowDate
        ? predictionFor(exam, model, cohortKey, options.generatedAt)
        : null,
    },
  };
}

/** Strict split: training establishment events end in 2024; subjects must be open at T. */
export function buildStaffingListBacktest(pairs = []) {
  const splitDate = STAFFING_LIST_BACKTEST_SPLIT;
  const training = pairs.filter((pair) => pair.established_date < splitDate);
  const scoring = pairs.filter((pair) => pair.application_close < splitDate
    && pair.established_date >= splitDate);
  if (!training.length || !scoring.length) {
    return {
      backtest: null,
      scorecard: {
        metric: "prediction_calibration",
        domain: "staffing",
        split_date: splitDate,
        resolved_backtest_predictions: 0,
        interval_coverage: null,
        occurrence_quintiles_monotone: null,
        ship_bar: {
          status: "fail",
          checks: {
            minimum_resolved: false,
            interval_coverage: false,
            occurrence_quintiles_monotone: true,
          },
        },
        public_projection: "cohort_statistic_only",
        note: "The fixture does not contain both pre-split training pairs and post-split resolutions.",
      },
      training_pairs: training.length,
      scoring_pairs: scoring.length,
    };
  }
  const model = buildStaffingLagModel(training);
  const events = [
    ...training.map((pair) => ({
      event_id: pair.evidence_event_id,
      subject_ref: `exam:${pair.exam_number}`,
      event_kind: STAFFING_LIST_TARGET_KIND,
      valid_at: pair.established_date,
    })),
    ...scoring.flatMap((pair) => ([
      {
        event_id: `cte:staffing-application-close:${pair.exam_number}:${pair.application_close}`,
        subject_ref: `exam:${pair.exam_number}`,
        event_kind: "staffing.application_window",
        valid_at: pair.application_close,
      },
      {
        event_id: pair.evidence_event_id,
        subject_ref: `exam:${pair.exam_number}`,
        event_kind: STAFFING_LIST_TARGET_KIND,
        valid_at: pair.established_date,
      },
    ])),
  ];
  const generatedAt = `${splitDate}T00:00:00Z`;
  const basisWindow = {
    train_from: model.cohorts.citywide.train_from,
    train_to: model.cohorts.citywide.train_to,
  };
  const predictions = scoring.map((pair) => {
    const cohortKey = staffingCohortFor({ exam_type: pair.exam_type }, model);
    return predictionFor(
      { exam_number: pair.exam_number, application_close: pair.application_close },
      model,
      cohortKey,
      generatedAt,
      basisWindow,
    );
  });
  const backtest = {
    domain: "staffing",
    split_date: splitDate,
    grace_days: 0,
    open_event_kinds: ["staffing.application_window"],
    terminal_event_kinds: [STAFFING_LIST_TARGET_KIND],
    predictions,
    events,
  };
  return {
    backtest,
    scorecard: evaluatePredictionBacktest(backtest),
    training_pairs: training.length,
    scoring_pairs: scoring.length,
  };
}

export function publicStaffingModelReport(model) {
  return {
    method: STAFFING_LIST_METHOD,
    target_event_kind: STAFFING_LIST_TARGET_KIND,
    cohort_floor: model.floor,
    cohorts: model.cohorts,
  };
}
