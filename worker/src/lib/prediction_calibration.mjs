// Domain-generic, out-of-time evaluation for cityscroll.prediction.v0.
//
// Contract renewal fc:* rows are retrofitted via contract_forecast_predictions.mjs;
// forecast_score.mjs keeps the product fuzzy Solicitation hit_rate and also
// exposes resolveForecastPredictions → resolvePredictions for status lifecycle.

import { isRegisteredEventKind } from "./civic_time.mjs";
import { validatePrediction } from "./prediction_contract.mjs";

export const PREDICTION_CALIBRATION_VERSION = "prediction_calibration_v1";
export const INTERVAL_NOMINAL = 0.8;
export const INTERVAL_TOLERANCE = 0.1;
export const MINIMUM_RESOLVED = 50;

const DAY_MS = 86_400_000;

function round4(value) {
  return value == null ? null : Math.round(Number(value) * 10_000) / 10_000;
}

function isIsoDate(value) {
  const raw = String(value || "");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) return false;
  const parsed = new Date(`${raw}T00:00:00Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === raw;
}

function requireIsoDate(value, label) {
  if (!isIsoDate(value)) throw new TypeError(`${label} must be an ISO date`);
  return value;
}

function eventDay(value, label) {
  const raw = String(value || "");
  const day = requireIsoDate(raw.slice(0, 10), label);
  if (raw.length > 10 && !Number.isFinite(Date.parse(raw))) {
    throw new TypeError(`${label} must be an ISO date or timestamp`);
  }
  return day;
}

function dayNumber(value, label) {
  return Date.parse(`${requireIsoDate(String(value || "").slice(0, 10), label)}T00:00:00Z`) / DAY_MS;
}

function addDays(value, days) {
  return new Date((dayNumber(value, "date") + days) * DAY_MS).toISOString().slice(0, 10);
}

function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
}

export function probabilityQuintile(probability) {
  if (typeof probability !== "number" || !Number.isFinite(probability)
      || probability < 0 || probability > 1) {
    throw new TypeError("probability must be between 0 and 1");
  }
  return Math.min(5, Math.floor(probability * 5) + 1);
}

function validateEvent(event, index) {
  if (!event || typeof event !== "object" || Array.isArray(event)) {
    throw new TypeError(`events[${index}] must be an object`);
  }
  if (typeof event.event_id !== "string" || !event.event_id.trim()) {
    throw new TypeError(`events[${index}].event_id is required`);
  }
  if (typeof event.subject_ref !== "string" || !event.subject_ref.trim()) {
    throw new TypeError(`events[${index}].subject_ref is required`);
  }
  if (!isRegisteredEventKind(event.event_kind)) {
    throw new TypeError(`unknown event_kind: ${event.event_kind}`);
  }
  return {
    ...event,
    valid_at: eventDay(event.valid_at, `events[${index}].valid_at`),
  };
}

function eventOrder(left, right) {
  return left.valid_at.localeCompare(right.valid_at)
    || left.event_id.localeCompare(right.event_id);
}

function occurrenceCalibration(rows) {
  const bins = Array.from({ length: 5 }, (_, index) => ({
    quintile: index + 1,
    probability_min: index / 5,
    probability_max: (index + 1) / 5,
    upper_inclusive: index === 4,
    rows: [],
  }));
  for (const row of rows) bins[probabilityQuintile(row.probability) - 1].rows.push(row);

  return bins.map((bin) => {
    const predictedTotal = bin.rows.reduce((sum, row) => sum + row.probability, 0);
    const realized = bin.rows.filter((row) => row.realized).length;
    return {
      quintile: bin.quintile,
      probability_min: bin.probability_min,
      probability_max: bin.probability_max,
      upper_inclusive: bin.upper_inclusive,
      count: bin.rows.length,
      predicted_probability_mean: bin.rows.length
        ? round4(predictedTotal / bin.rows.length)
        : null,
      realized,
      realized_frequency: bin.rows.length ? round4(realized / bin.rows.length) : null,
    };
  });
}

function quintilesAreMonotone(bins) {
  if (bins.some((bin) => bin.realized_frequency == null)) return false;
  return bins.every((bin, index) => index === 0
    || bin.realized_frequency >= bins[index - 1].realized_frequency);
}

function assertBacktestShape(backtest) {
  if (!backtest || typeof backtest !== "object" || Array.isArray(backtest)) {
    throw new TypeError("backtest must be an object");
  }
  const domain = String(backtest.domain || "").trim();
  if (!domain) throw new TypeError("domain is required");
  const splitDate = requireIsoDate(backtest.split_date, "split_date");
  if (!Number.isSafeInteger(backtest.grace_days) || backtest.grace_days < 0) {
    throw new TypeError("grace_days must be a non-negative integer");
  }
  if (!Array.isArray(backtest.open_event_kinds) || !backtest.open_event_kinds.length) {
    throw new TypeError("open_event_kinds must be a non-empty array");
  }
  for (const kind of backtest.open_event_kinds) {
    if (!isRegisteredEventKind(kind)) throw new TypeError(`unknown open_event_kind: ${kind}`);
  }
  if (!Array.isArray(backtest.terminal_event_kinds) || !backtest.terminal_event_kinds.length) {
    throw new TypeError("terminal_event_kinds must be a non-empty array");
  }
  for (const kind of backtest.terminal_event_kinds) {
    if (!isRegisteredEventKind(kind)) throw new TypeError(`unknown terminal_event_kind: ${kind}`);
  }
  if (!Array.isArray(backtest.predictions) || !backtest.predictions.length) {
    throw new TypeError("predictions must be a non-empty array");
  }
  if (!Array.isArray(backtest.events)) throw new TypeError("events must be an array");
  return { domain, splitDate };
}

/**
 * Evaluate one model/domain at a historical split date.
 *
 * Training evidence must be strictly before T. Predictions are the assertions
 * emitted at T for subjects whose opening event has happened and whose terminal
 * event has not. Resolution considers only events at or after T and uses exact
 * subject_ref + predicted_event_kind joins. Alternative configured terminal
 * events resolve occurrence claims as misses and expose corpus resolution health.
 */
export function evaluatePredictionBacktest(backtest) {
  const { domain, splitDate } = assertBacktestShape(backtest);
  const events = backtest.events.map(validateEvent);
  const eventIds = new Map();
  for (const event of events) {
    if (eventIds.has(event.event_id)) throw new TypeError(`duplicate event_id: ${event.event_id}`);
    eventIds.set(event.event_id, event);
  }

  const predictions = backtest.predictions.map((prediction) => validatePrediction(prediction));
  const modelName = predictions[0].model_name;
  const modelVersion = predictions[0].model_version;
  const trainFrom = predictions[0].basis.train_from;
  const trainTo = predictions[0].basis.train_to;
  const openKinds = new Set(backtest.open_event_kinds);
  const terminalKinds = new Set(backtest.terminal_event_kinds);

  for (const prediction of predictions) {
    if (prediction.status !== "open") {
      throw new TypeError(`backtest prediction ${prediction.prediction_id} must be emitted open`);
    }
    if (prediction.model_name !== modelName || prediction.model_version !== modelVersion) {
      throw new TypeError("one backtest must contain exactly one model name and version");
    }
    if (prediction.basis.train_from !== trainFrom || prediction.basis.train_to !== trainTo) {
      throw new TypeError("one backtest must contain exactly one basis train window");
    }
    if (!(prediction.basis.train_to < splitDate)) {
      throw new TypeError(`basis.train_to must be before split_date for ${prediction.prediction_id}`);
    }
    if (new Date(prediction.generated_at).toISOString().slice(0, 10) !== splitDate) {
      throw new TypeError(`prediction ${prediction.prediction_id} must be generated at split_date`);
    }
    if (!prediction.predicted_event_kind.startsWith(`${domain}.`)) {
      throw new TypeError(`prediction ${prediction.prediction_id} is outside domain ${domain}`);
    }
    if (!terminalKinds.has(prediction.predicted_event_kind)) {
      throw new TypeError(`terminal_event_kinds must include ${prediction.predicted_event_kind}`);
    }

    for (const evidenceId of prediction.basis.evidence_event_ids) {
      const evidence = eventIds.get(evidenceId);
      if (!evidence) throw new TypeError(`training evidence ${evidenceId} is missing`);
      if (!(evidence.valid_at < splitDate)) {
        throw new TypeError(
          `training evidence ${evidenceId} must have valid_at before split_date`,
        );
      }
      if (evidence.valid_at < prediction.basis.train_from
          || evidence.valid_at > prediction.basis.train_to) {
        throw new TypeError(`training evidence ${evidenceId} is outside the basis train window`);
      }
    }

    const opened = events.some((event) => event.subject_ref === prediction.subject_ref
      && openKinds.has(event.event_kind)
      && event.valid_at < splitDate);
    const terminalBeforeSplit = events.some((event) => event.subject_ref === prediction.subject_ref
      && terminalKinds.has(event.event_kind)
      && event.valid_at < splitDate);
    if (!opened || terminalBeforeSplit) {
      throw new TypeError(
        `prediction ${prediction.prediction_id} subject ${prediction.subject_ref} was not open at split_date`,
      );
    }
  }

  const eventsAfterSplit = events.filter((event) => event.valid_at >= splitDate);
  const evaluated = predictions.map((prediction) => {
    const exact = eventsAfterSplit
      .filter((event) => event.subject_ref === prediction.subject_ref
        && event.event_kind === prediction.predicted_event_kind)
      .sort(eventOrder)[0] || null;
    const terminal = exact || eventsAfterSplit
      .filter((event) => event.subject_ref === prediction.subject_ref
        && terminalKinds.has(event.event_kind))
      .sort(eventOrder)[0] || null;
    if (!terminal) return { prediction, resolution_status: "open", exact: null, terminal: null };
    if (!exact) {
      return { prediction, resolution_status: "resolved_miss", exact: null, terminal };
    }
    if (prediction.claim === "occurrence") {
      return { prediction, resolution_status: "resolved_hit", exact, terminal };
    }
    const lower = addDays(prediction.predicted_window.p10, -backtest.grace_days);
    const upper = addDays(prediction.predicted_window.p90, backtest.grace_days);
    const hit = exact.valid_at >= lower && exact.valid_at <= upper;
    return {
      prediction,
      resolution_status: hit ? "resolved_hit" : "resolved_miss",
      exact,
      terminal,
    };
  });

  const resolved = evaluated.filter((row) => row.resolution_status !== "open");
  const timing = evaluated.filter((row) => row.prediction.claim === "timing");
  const realizedTiming = timing.filter((row) => row.exact);
  const strictIntervalHits = realizedTiming.filter((row) => row.exact.valid_at
    >= row.prediction.predicted_window.p10
    && row.exact.valid_at <= row.prediction.predicted_window.p90);
  const absoluteMedianErrors = realizedTiming.map((row) => Math.abs(
    dayNumber(row.exact.valid_at, "realized event valid_at")
      - dayNumber(row.prediction.predicted_window.p50, "predicted_window.p50"),
  ));
  const occurrence = evaluated.filter((row) => row.prediction.claim === "occurrence");
  const resolvedOccurrence = occurrence.filter((row) => row.resolution_status !== "open");
  const occurrenceRows = resolvedOccurrence.map((row) => ({
    probability: row.prediction.probability,
    realized: Boolean(row.exact),
  }));
  const calibration = occurrenceCalibration(occurrenceRows);
  // Timing-only domains have no occurrence calibration to order. Treat that
  // check as not applicable (passing) instead of making every timing model
  // fail a probability metric it does not emit.
  const monotone = occurrence.length ? quintilesAreMonotone(calibration) : null;
  const intervalCoverage = realizedTiming.length
    ? strictIntervalHits.length / realizedTiming.length
    : null;
  const resolutionRate = resolved.length / predictions.length;
  const checks = {
    minimum_resolved: resolved.length >= MINIMUM_RESOLVED,
    interval_coverage: intervalCoverage != null
      && Math.abs(intervalCoverage - INTERVAL_NOMINAL) <= INTERVAL_TOLERANCE + Number.EPSILON,
    occurrence_quintiles_monotone: occurrence.length ? monotone : true,
  };
  const passed = Object.values(checks).every(Boolean);

  return {
    metric: "prediction_calibration",
    version: PREDICTION_CALIBRATION_VERSION,
    domain,
    model_name: modelName,
    model_version: modelVersion,
    split_date: splitDate,
    grace_days: backtest.grace_days,
    train_window: { from: trainFrom, to: trainTo },
    prediction_count: predictions.length,
    resolved_backtest_predictions: resolved.length,
    resolution_rate: round4(resolutionRate),
    resolution_counts: {
      resolved_hit: evaluated.filter((row) => row.resolution_status === "resolved_hit").length,
      resolved_miss: evaluated.filter((row) => row.resolution_status === "resolved_miss").length,
      open: evaluated.filter((row) => row.resolution_status === "open").length,
    },
    timing_prediction_count: timing.length,
    timing_realized_count: realizedTiming.length,
    timing_resolution_hits: timing.filter((row) => row.resolution_status === "resolved_hit").length,
    interval_nominal: INTERVAL_NOMINAL,
    interval_coverage: round4(intervalCoverage),
    interval_coverage_hits: strictIntervalHits.length,
    interval_coverage_count: realizedTiming.length,
    median_absolute_error_p50_days: round4(median(absoluteMedianErrors)),
    occurrence_prediction_count: occurrence.length,
    occurrence_resolved_count: resolvedOccurrence.length,
    occurrence_calibration: calibration,
    occurrence_quintiles_monotone: monotone,
    ship_bar: {
      status: passed ? "pass" : "fail",
      checks,
      thresholds: {
        minimum_resolved: MINIMUM_RESOLVED,
        interval_nominal: INTERVAL_NOMINAL,
        interval_tolerance: INTERVAL_TOLERANCE,
        occurrence_quintiles_monotone: true,
      },
    },
    public_projection: passed ? "per_matter_projection" : "cohort_statistic_only",
  };
}
