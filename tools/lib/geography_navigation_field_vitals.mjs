/**
 * Geography-navigation field-vitals helpers.
 *
 * earliest_floor_date projections use the queried retention window as the
 * rate denominator (sampled_count / window_days). The first-to-latest sample
 * span may be retained separately and never feeds the projection.
 */

export const GEOGRAPHY_NAVIGATION_FIELD_VITALS_SCHEMA =
  "cityscroll.geography_navigation_field_vitals_observation.v1";

/** Analytics Engine raw-row retention (days). */
export const FIELD_VITALS_DATASET_RETENTION_DAYS = 90;

/**
 * Default calendar ceiling for emitting an earliest_date. Callers that want the
 * strict dataset-retention ceiling pass FIELD_VITALS_DATASET_RETENTION_DAYS.
 */
export const FIELD_VITALS_DEFAULT_PROJECTION_HORIZON_DAYS = 365;

const MS_PER_DAY = 86_400_000;

/**
 * @param {string | null | undefined} iso
 * @returns {number | null}
 */
export function parseIsoMs(iso) {
  if (typeof iso !== "string" || iso.length === 0) return null;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * @param {number} ms
 * @returns {string} YYYY-MM-DD in UTC
 */
export function utcDateString(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

/**
 * Duration of the queried window in days (query_end - query_start).
 * @param {{ query_start?: string, query_end?: string } | null | undefined} retention
 * @returns {number | null}
 */
export function queriedWindowDays(retention) {
  const start = parseIsoMs(retention?.query_start);
  const end = parseIsoMs(retention?.query_end);
  if (start == null || end == null || end <= start) return null;
  return (end - start) / MS_PER_DAY;
}

/**
 * First-to-latest sample span in days. Zero when timestamps match.
 * @param {string | null | undefined} firstIso
 * @param {string | null | undefined} latestIso
 * @returns {number | null}
 */
export function observationSpanDays(firstIso, latestIso) {
  const first = parseIsoMs(firstIso);
  const latest = parseIsoMs(latestIso);
  if (first == null || latest == null) return null;
  return Math.max(0, (latest - first) / MS_PER_DAY);
}

/**
 * Project the earliest calendar date a cell can reach sample_floor.
 *
 * Rate input is always sampled_count / queried_window_days. A zero-sample
 * cell records basis `no_positive_sample_rate`. A zero observation span, or a
 * projection that needs more samples than the window rate can supply inside
 * retentionHorizonDays, records basis `insufficient_rate_to_project` with a
 * null date.
 *
 * @param {object} args
 * @param {number} args.sampledCount
 * @param {number} [args.sampleFloor=30]
 * @param {string | null | undefined} args.queryStart
 * @param {string | null | undefined} args.queryEnd
 * @param {string | null | undefined} args.queriedAt
 * @param {string | null | undefined} [args.firstObservationAt]
 * @param {string | null | undefined} [args.latestObservationAt]
 * @param {number} [args.retentionHorizonDays=FIELD_VITALS_DEFAULT_PROJECTION_HORIZON_DAYS]
 * @returns {object | null}
 */
export function projectEarliestFloorDate({
  sampledCount,
  sampleFloor = 30,
  queryStart,
  queryEnd,
  queriedAt,
  firstObservationAt = null,
  latestObservationAt = null,
  retentionHorizonDays = FIELD_VITALS_DEFAULT_PROJECTION_HORIZON_DAYS,
}) {
  const n = Number(sampledCount);
  const floor = Number(sampleFloor);
  if (!Number.isFinite(n) || n < 0 || !Number.isFinite(floor) || floor <= 0) {
    throw new Error("sampledCount and sampleFloor must be finite non-negative numbers with floor > 0");
  }

  if (n >= floor) {
    return null;
  }

  const windowDays = queriedWindowDays({ query_start: queryStart, query_end: queryEnd });
  if (windowDays == null) {
    throw new Error("queryStart/queryEnd must form a positive queried window");
  }

  const queriedAtMs = parseIsoMs(queriedAt) ?? parseIsoMs(queryEnd);
  if (queriedAtMs == null) {
    throw new Error("queriedAt or queryEnd is required");
  }

  if (!Number.isFinite(retentionHorizonDays) || retentionHorizonDays <= 0) {
    throw new Error("retentionHorizonDays must be a positive finite number");
  }

  if (n <= 0) {
    return {
      earliest_date: null,
      basis: "no_positive_sample_rate",
      observed_rate_per_day: 0,
      samples_needed: floor,
      queried_window_days: round(windowDays, 6),
      span_observed_rate_per_day: null,
      rate_clamp_per_day: null,
      retention_horizon_days: retentionHorizonDays,
      dataset_retention_days: FIELD_VITALS_DATASET_RETENTION_DAYS,
      note: "No retained rows in the queried window from which to project a floor date.",
    };
  }

  const spanDays = observationSpanDays(firstObservationAt, latestObservationAt);
  const spanRate = spanDays != null && spanDays > 0 ? n / spanDays : null;
  const windowRate = n / windowDays;
  const samplesNeeded = floor - n;
  const latestMs = parseIsoMs(latestObservationAt);
  const lagDays =
    latestMs == null ? null : Math.max(0, (queriedAtMs - latestMs) / MS_PER_DAY);

  const base = {
    observed_rate_per_day: round(windowRate, 3),
    samples_needed: samplesNeeded,
    queried_window_days: round(windowDays, 6),
    span_observed_rate_per_day: spanRate == null ? null : round(spanRate, 3),
    rate_clamp_per_day: null,
    retention_horizon_days: retentionHorizonDays,
    dataset_retention_days: FIELD_VITALS_DATASET_RETENTION_DAYS,
    latest_observation_lag_days: lagDays == null ? null : round(lagDays, 2),
  };

  if (spanDays != null && spanDays === 0) {
    return {
      earliest_date: null,
      basis: "insufficient_rate_to_project",
      ...base,
      note:
        "Observation span is zero (first_observation_at equals latest_observation_at); " +
        "refusing a projected floor date rather than inventing a span-derived rate.",
    };
  }

  if (!(windowRate > 0)) {
    return {
      earliest_date: null,
      basis: "no_positive_sample_rate",
      ...base,
      note: "Window-basis sample rate is not positive.",
    };
  }

  const supplyInsideHorizon = windowRate * retentionHorizonDays;
  if (samplesNeeded > supplyInsideHorizon) {
    return {
      earliest_date: null,
      basis: "insufficient_rate_to_project",
      ...base,
      note:
        "Window-basis rate cannot supply the remaining samples inside the " +
        `${retentionHorizonDays}-day retention horizon.`,
    };
  }

  const daysNeeded = samplesNeeded / windowRate;
  const earliestMs = queriedAtMs + daysNeeded * MS_PER_DAY;

  return {
    earliest_date: utcDateString(earliestMs),
    basis: "linear_extrapolation_from_observed_window",
    ...base,
    note:
      "Optimistic bound from sampled_count / queried_window_days; a stall since the " +
      "latest observation pushes the date later. Span-derived rate is recorded separately " +
      "and is not the projection input.",
  };
}

/**
 * Recompute earliest_floor_date for every observation row in a retained document.
 * @param {object} observation
 * @param {{ retentionHorizonDays?: number }} [options]
 * @returns {object}
 */
export function recomputeObservationEarliestFloorDates(observation, options = {}) {
  const sampleFloor = Number(observation.sample_floor) || 30;
  const queriedAt = observation.queried_at;
  const retentionHorizonDays =
    options.retentionHorizonDays ?? FIELD_VITALS_DEFAULT_PROJECTION_HORIZON_DAYS;
  const observations = (observation.observations || []).map((row) => {
    const projection = projectEarliestFloorDate({
      sampledCount: row.sampled_count,
      sampleFloor,
      queryStart: row.retention?.query_start,
      queryEnd: row.retention?.query_end,
      queriedAt,
      firstObservationAt: row.first_observation_at,
      latestObservationAt: row.latest_observation_at,
      retentionHorizonDays,
    });
    return { ...row, earliest_floor_date: projection };
  });
  return { ...observation, observations };
}

function round(value, digits) {
  const f = 10 ** digits;
  return Math.round(value * f) / f;
}
