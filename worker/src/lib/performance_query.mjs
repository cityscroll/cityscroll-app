// Bounded, transport-neutral read adapter for the separate RUM Analytics Engine dataset.
// Desk consumes a future authenticated Worker read model; it never imports this module or
// receives Analytics Engine credentials or SQL.

import performanceAllowlist from "../data/performance-validation-allowlist.v1.json" with { type: "json" };
import { RUM_HEALTH_REASONS, RUM_OBSERVATION_SCHEMA } from "../performance_events.mjs";
import { lastNDays, statsKey } from "./stats.mjs";

export const DEFAULT_RUM_ANALYTICS_DATASET = "crol_rum_observations_v1";
export const PERFORMANCE_RETENTION_DAYS = 90;
export const DEFAULT_PERFORMANCE_SAMPLE_FLOOR = 30;
export const MAX_PERFORMANCE_GROUPS = 64;
export const MAX_PERFORMANCE_TREND_DAYS = 91;
export const PERFORMANCE_HEALTH_WINDOW_DAYS = 7;

export function performanceReadConfiguration(env = {}) {
  const accountId = String(env.ANALYTICS_ACCOUNT_ID || "").trim();
  const token = String(env.ANALYTICS_READ_TOKEN || "").trim();
  if (!accountId) return { configured: false, reason: "missing-account-id" };
  if (!/^[a-f0-9]{32}$/.test(accountId)) return { configured: false, reason: "invalid-account-id" };
  if (!token) return { configured: false, reason: "missing-read-token" };
  return { configured: true };
}

export const PERFORMANCE_WINDOWS = Object.freeze({
  "24h": 24 * 60 * 60 * 1000,
  "7d": 7 * 24 * 60 * 60 * 1000,
  "30d": 30 * 24 * 60 * 60 * 1000,
  "90d": 90 * 24 * 60 * 60 * 1000,
});

// Cloudflare adaptive sampling assigns a potentially different _sample_interval to every
// retained row. The sampled row count is the evidence floor for a distribution; the weighted
// count estimates the population size but cannot turn one heavily weighted row into a precise
// distribution. Percentiles therefore use the provider's weighted exact aggregate directly.
export const PERFORMANCE_SAMPLING_SEMANTICS = Object.freeze({
  method: "cloudflare_weighted_adaptive_sampling",
  sampled_count: "count() of retained rows selected by Analytics Engine; this count is used for the sufficiency floor",
  estimated_count: "sum(_sample_interval), an estimate of underlying observations represented by the retained rows",
  percentiles: "quantileExactWeighted(q)(double1, _sample_interval) for q=0.50, 0.75, and 0.95",
  sufficiency: "estimated_count is never used to satisfy the sample floor because distribution accuracy depends on retained sample size and variance",
});

const FILTER_COLUMNS = Object.freeze({
  metric_id: "blob2",
  surface_id: "blob3",
  component_id: "blob4",
  device_class: "blob6",
  navigation_type: "blob7",
  delivery_class: "blob8",
  result_state: "blob9",
  release_id: "blob13",
});

const GROUPABLE_DIMENSIONS = new Set([
  "metric_id",
  "surface_id",
  "component_id",
  "device_class",
  "navigation_type",
  "delivery_class",
  "result_state",
]);

const metricIds = new Set(performanceAllowlist.metric_ids || []);
const surfaceIds = new Set(Object.keys(performanceAllowlist.surfaces || {}));
// Page-level observations use the canonical sentinel rather than a component record.
const componentIds = new Set(["none", ...Object.keys(performanceAllowlist.components || {})]);
const deviceClasses = new Set(performanceAllowlist.collector?.device_classes || []);
const navigationTypes = new Set(performanceAllowlist.collector?.navigation_types || []);
const deliveryClasses = new Set(performanceAllowlist.delivery_classes || []);
const resultStates = new Set(performanceAllowlist.result_states || []);
const RELEASE_ID = /^[a-f0-9]{40}$/;

const REJECTION_REASONS = RUM_HEALTH_REASONS.filter((reason) => ![
  "accepted",
  "developer",
  "disabled",
  "non_production",
  "storage_configured",
  "storage_unavailable",
].includes(reason));

export class PerformanceQueryError extends Error {
  constructor(message) {
    super(message);
    this.name = "PerformanceQueryError";
  }
}

class PerformanceSqlError extends Error {
  constructor(reason) {
    super(reason);
    this.reason = reason;
  }
}

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value, allowed, label) {
  if (!isRecord(value)) throw new PerformanceQueryError(`${label} must be an object`);
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (unknown.length) throw new PerformanceQueryError(`Unsupported ${label} key: ${unknown[0]}`);
}

function canonicalSurfaceId(value) {
  return performanceAllowlist.surface_aliases?.[value] || value;
}

function canonicalComponentId(value) {
  return performanceAllowlist.component_aliases?.[value] || value;
}

function checkedFilterValue(key, rawValue) {
  if (typeof rawValue !== "string" || !rawValue) {
    throw new PerformanceQueryError(`${key} must be a non-empty string`);
  }
  const value = key === "surface_id"
    ? canonicalSurfaceId(rawValue)
    : key === "component_id"
      ? canonicalComponentId(rawValue)
      : rawValue;
  const allowed = ({
    metric_id: metricIds,
    surface_id: surfaceIds,
    component_id: componentIds,
    device_class: deviceClasses,
    navigation_type: navigationTypes,
    delivery_class: deliveryClasses,
    result_state: resultStates,
  })[key];
  if (key === "release_id" ? !RELEASE_ID.test(value) : !allowed?.has(value)) {
    throw new PerformanceQueryError(`Unsupported ${key}`);
  }
  return value;
}

export function normalizePerformanceQuery(input = {}) {
  exactKeys(input, new Set(["filters", "group_by", "window"]), "query");
  const window = input.window || "7d";
  if (!Object.hasOwn(PERFORMANCE_WINDOWS, window)) {
    throw new PerformanceQueryError("Unsupported performance window");
  }

  const rawFilters = input.filters ?? {};
  exactKeys(rawFilters, new Set(Object.keys(FILTER_COLUMNS)), "filter");
  const filters = Object.fromEntries(
    Object.entries(rawFilters).map(([key, value]) => [key, checkedFilterValue(key, value)]),
  );

  const groupBy = input.group_by ?? null;
  if (groupBy !== null && (!GROUPABLE_DIMENSIONS.has(groupBy) || filters[groupBy])) {
    throw new PerformanceQueryError("Unsupported or redundant grouping dimension");
  }
  if (!filters.metric_id && groupBy !== "metric_id") {
    throw new PerformanceQueryError("A metric_id filter or metric_id grouping is required");
  }
  return Object.freeze({ window, filters: Object.freeze(filters), group_by: groupBy });
}

function checkedDataset(value) {
  const dataset = String(value || DEFAULT_RUM_ANALYTICS_DATASET);
  if (!/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(dataset)) {
    throw new PerformanceQueryError("Invalid Analytics Engine dataset name");
  }
  return dataset;
}

function checkedSampleFloor(value) {
  const floor = value == null || value === "" ? DEFAULT_PERFORMANCE_SAMPLE_FLOOR : Number(value);
  if (!Number.isSafeInteger(floor) || floor < 1 || floor > 10_000) {
    throw new PerformanceQueryError("Invalid performance sample floor");
  }
  return floor;
}

function checkedDate(value, label) {
  if (value == null || value === "") return null;
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new PerformanceQueryError(`Invalid ${label}`);
  return date;
}

function dateTimeSql(ms) {
  return `toDateTime(${Math.floor(ms / 1000)})`;
}

function sqlString(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function coverageFor(startMs, endMs, availableSinceMs) {
  const queryStartMs = Math.max(startMs, availableSinceMs);
  const queryable = queryStartMs < endMs;
  return Object.freeze({
    status: startMs >= availableSinceMs ? "complete" : "partial",
    requested_start: new Date(startMs).toISOString(),
    requested_end: new Date(endMs).toISOString(),
    available_since: new Date(availableSinceMs).toISOString(),
    query_start: queryable ? new Date(queryStartMs).toISOString() : null,
    query_end: queryable ? new Date(endMs).toISOString() : null,
    queryable,
    query_start_ms: queryStartMs,
    query_end_ms: endMs,
  });
}

function whereSql(query, startMs, endMs) {
  const clauses = [
    `timestamp >= ${dateTimeSql(startMs)}`,
    `timestamp < ${dateTimeSql(endMs)}`,
    `blob1 = ${sqlString(RUM_OBSERVATION_SCHEMA)}`,
    "blob10 = 'production'",
  ];
  for (const [key, value] of Object.entries(query.filters)) {
    clauses.push(`${FILTER_COLUMNS[key]} = ${sqlString(value)}`);
  }
  return clauses.join("\n  AND ");
}

function summarySql(dataset, query, coverage) {
  const group = query.group_by;
  const groupSelect = group ? `  ${FILTER_COLUMNS[group]} AS ${group},\n` : "";
  const groupClause = group ? `\nGROUP BY ${group}\nORDER BY ${group} ASC` : "";
  const limit = group ? MAX_PERFORMANCE_GROUPS + 1 : 1;
  return `SELECT
${groupSelect}  count() AS sampled_count,
  sum(_sample_interval) AS estimated_count,
  quantileExactWeighted(0.50)(double1, _sample_interval) AS p50,
  quantileExactWeighted(0.75)(double1, _sample_interval) AS p75,
  quantileExactWeighted(0.95)(double1, _sample_interval) AS p95,
  formatDateTime(min(timestamp), '%Y-%m-%dT%H:%i:%SZ', 'Etc/UTC') AS first_observation_at,
  formatDateTime(max(timestamp), '%Y-%m-%dT%H:%i:%SZ', 'Etc/UTC') AS latest_observation_at
FROM ${dataset}
WHERE ${whereSql(query, coverage.query_start_ms, coverage.query_end_ms)}${groupClause}
LIMIT ${limit}`;
}

function trendSql(dataset, query, coverage) {
  const group = query.group_by;
  const groupSelect = group ? `  ${FILTER_COLUMNS[group]} AS ${group},\n` : "";
  const groupClause = group ? `, ${group}` : "";
  const orderClause = group ? `, ${group} ASC` : "";
  const limit = MAX_PERFORMANCE_GROUPS * MAX_PERFORMANCE_TREND_DAYS + 1;
  return `SELECT
  formatDateTime(timestamp, '%Y-%m-%d', 'Etc/UTC') AS day,
${groupSelect}  count() AS sampled_count,
  sum(_sample_interval) AS estimated_count,
  quantileExactWeighted(0.50)(double1, _sample_interval) AS p50,
  quantileExactWeighted(0.75)(double1, _sample_interval) AS p75,
  quantileExactWeighted(0.95)(double1, _sample_interval) AS p95,
  formatDateTime(max(timestamp), '%Y-%m-%dT%H:%i:%SZ', 'Etc/UTC') AS latest_observation_at
FROM ${dataset}
WHERE ${whereSql(query, coverage.query_start_ms, coverage.query_end_ms)}
GROUP BY day${groupClause}
ORDER BY day ASC${orderClause}
LIMIT ${limit}`;
}

export function performanceAnalyticsQueryPlan(input = {}, options = {}) {
  const query = normalizePerformanceQuery(input);
  const now = checkedDate(options.now || new Date(), "query clock");
  now.setUTCMilliseconds(0);
  const configuredSince = checkedDate(options.configuredSince, "RUM measured-since date");
  const dataset = checkedDataset(options.dataset);
  const sampleFloor = checkedSampleFloor(options.sampleFloor);
  const windowMs = PERFORMANCE_WINDOWS[query.window];
  const currentStartMs = now.getTime() - windowMs;
  const previousStartMs = currentStartMs - windowMs;
  const retentionStartMs = now.getTime() - PERFORMANCE_RETENTION_DAYS * 86400000;
  const availableSinceMs = Math.max(retentionStartMs, configuredSince?.getTime() ?? retentionStartMs);
  const current = coverageFor(currentStartMs, now.getTime(), availableSinceMs);
  const previous = coverageFor(previousStartMs, currentStartMs, availableSinceMs);

  const requests = [];
  if (current.queryable) {
    requests.push({ id: "current", sql: summarySql(dataset, query, current) });
    requests.push({ id: "trend", sql: trendSql(dataset, query, current) });
  }
  if (previous.queryable) requests.push({ id: "previous", sql: summarySql(dataset, query, previous) });

  return Object.freeze({
    query,
    dataset,
    sample_floor: sampleFloor,
    queried_at: now.toISOString(),
    current,
    previous,
    requests: Object.freeze(requests),
  });
}

function finiteNonnegative(value) {
  if (value == null || value === "" || typeof value === "boolean") return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function observedCounts(row) {
  if (!row) return null;
  const sampled = finiteNonnegative(row.sampled_count);
  const estimated = finiteNonnegative(row.estimated_count);
  if (sampled === 0 && estimated === null) return { sampled_count: 0, estimated_count: 0 };
  if (sampled === null || estimated === null || !Number.isInteger(sampled) || estimated < sampled) {
    throw new PerformanceSqlError("invalid-query-result");
  }
  return { sampled_count: sampled, estimated_count: estimated };
}

function distributionFromRow(row, coverage, sampleFloor) {
  const counts = observedCounts(row);
  if (coverage.status !== "complete") {
    if (!counts || counts.sampled_count === 0) return { status: "retention_partial" };
    if (counts.sampled_count < sampleFloor) {
      return { status: "insufficient_sample", ...counts, sample_floor: sampleFloor };
    }
    const p50 = finiteNonnegative(row.p50);
    const p75 = finiteNonnegative(row.p75);
    const p95 = finiteNonnegative(row.p95);
    if (p50 === null || p75 === null || p95 === null || p50 > p75 || p75 > p95) {
      throw new PerformanceSqlError("invalid-query-result");
    }
    return {
      status: "available",
      ...counts,
      percentiles: { p50, p75, p95 },
    };
  }
  if (!counts || counts.sampled_count === 0) return { status: "no_data" };
  if (counts.sampled_count < sampleFloor) {
    return { status: "insufficient_sample", ...counts, sample_floor: sampleFloor };
  }

  const p50 = finiteNonnegative(row.p50);
  const p75 = finiteNonnegative(row.p75);
  const p95 = finiteNonnegative(row.p95);
  if (p50 === null || p75 === null || p95 === null || p50 > p75 || p75 > p95) {
    throw new PerformanceSqlError("invalid-query-result");
  }
  return {
    status: "available",
    ...counts,
    percentiles: { p50, p75, p95 },
  };
}

function groupKey(value) {
  return value == null ? "__all__" : value;
}

function validateGroupValue(dimension, value) {
  if (!dimension) return null;
  try {
    return checkedFilterValue(dimension, value);
  } catch {
    throw new PerformanceSqlError("invalid-query-result");
  }
}

function summaryMap(rows, plan, coverage) {
  if (!Array.isArray(rows)) throw new PerformanceSqlError("invalid-query-result");
  if (rows.length > MAX_PERFORMANCE_GROUPS) throw new PerformanceSqlError("too-many-groups");
  const out = new Map();
  for (const row of rows) {
    if (!isRecord(row)) throw new PerformanceSqlError("invalid-query-result");
    const group = validateGroupValue(plan.query.group_by, row[plan.query.group_by]);
    const key = groupKey(group);
    if (out.has(key)) throw new PerformanceSqlError("invalid-query-result");
    out.set(key, {
      dimensions: group == null ? {} : { [plan.query.group_by]: group },
      distribution: distributionFromRow(row, coverage, plan.sample_floor),
      first_observation_at: validTimestamp(row.first_observation_at),
      latest_observation_at: validTimestamp(row.latest_observation_at),
    });
  }
  if (!plan.query.group_by && !out.size) {
    out.set("__all__", {
      dimensions: {},
      distribution: distributionFromRow(null, coverage, plan.sample_floor),
      first_observation_at: null,
      latest_observation_at: null,
    });
  }
  return out;
}

function validTimestamp(value) {
  if (value == null || value === "") return null;
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) throw new PerformanceSqlError("invalid-query-result");
  return parsed.toISOString();
}

function optionalHealthTimestamp(value) {
  if (value == null || value === "") return null;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : null;
}

function trendMap(rows, plan) {
  if (!Array.isArray(rows) || rows.length > MAX_PERFORMANCE_GROUPS * MAX_PERFORMANCE_TREND_DAYS) {
    throw new PerformanceSqlError(rows?.length ? "too-many-trend-rows" : "invalid-query-result");
  }
  const out = new Map();
  for (const row of rows) {
    if (!isRecord(row) || !/^\d{4}-\d{2}-\d{2}$/.test(String(row.day || ""))) {
      throw new PerformanceSqlError("invalid-query-result");
    }
    const group = validateGroupValue(plan.query.group_by, row[plan.query.group_by]);
    const key = groupKey(group);
    if (!out.has(key)) out.set(key, new Map());
    if (out.get(key).has(row.day)) throw new PerformanceSqlError("invalid-query-result");
    out.get(key).set(row.day, {
      day: row.day,
      ...distributionFromRow(row, plan.current, plan.sample_floor),
    });
  }
  return out;
}

function requestedDays(coverage) {
  const days = [];
  const cursor = new Date(coverage.requested_start.slice(0, 10) + "T00:00:00.000Z");
  const endMs = new Date(coverage.requested_end).getTime();
  while (cursor.getTime() < endMs && days.length < MAX_PERFORMANCE_TREND_DAYS) {
    days.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return days;
}

function comparisonFor(current, previous) {
  if (current.status !== "available" || previous.status !== "available") {
    const statuses = [current.status, previous.status];
    const status = statuses.includes("retention_partial")
      ? "retention_partial"
      : statuses.includes("insufficient_sample")
        ? "insufficient_sample"
        : "no_data";
    return { status };
  }
  const percentiles = {};
  for (const key of ["p50", "p75", "p95"]) {
    const currentValue = current.percentiles[key];
    const previousValue = previous.percentiles[key];
    percentiles[key] = {
      current: currentValue,
      previous: previousValue,
      delta: currentValue - previousValue,
      ...(previousValue === 0 ? {} : { relative_change: (currentValue - previousValue) / previousValue }),
    };
  }
  return { status: "available", percentiles };
}

function overallStatus(series, coverage) {
  if (coverage.status !== "complete") return "retention_partial";
  const statuses = series.map((item) => item.current.status);
  if (statuses.includes("available")) return "available";
  if (statuses.includes("insufficient_sample")) return "insufficient_sample";
  return "no_data";
}

function freshnessFor(series, queriedAt) {
  const latest = series.map((item) => item.latest_observation_at).filter(Boolean).sort().at(-1) || null;
  if (!latest) return { status: "no_data", queried_at: queriedAt };
  return {
    status: "available",
    queried_at: queriedAt,
    latest_observation_at: latest,
    age_seconds: Math.max(0, Math.floor((Date.parse(queriedAt) - Date.parse(latest)) / 1000)),
  };
}

export function buildPerformanceSnapshot(results, plan, options = {}) {
  if (!plan?.query || !Array.isArray(plan.requests)) throw new PerformanceQueryError("Invalid query plan");
  const currentRows = results?.current ?? [];
  const previousRows = results?.previous ?? [];
  const trendRows = results?.trend ?? [];
  const current = summaryMap(currentRows, plan, plan.current);
  const previous = summaryMap(previousRows, plan, plan.previous);
  const trends = trendMap(trendRows, plan);
  const keys = new Set([...current.keys(), ...previous.keys(), ...trends.keys()]);
  if (!plan.query.group_by) keys.add("__all__");
  const days = requestedDays(plan.current);
  const series = [];

  for (const key of [...keys].sort()) {
    const currentEntry = current.get(key) || {
      dimensions: previous.get(key)?.dimensions || {},
      distribution: distributionFromRow(null, plan.current, plan.sample_floor),
      first_observation_at: null,
      latest_observation_at: null,
    };
    const previousEntry = previous.get(key) || {
      dimensions: currentEntry.dimensions,
      distribution: distributionFromRow(null, plan.previous, plan.sample_floor),
    };
    const byDay = trends.get(key) || new Map();
    series.push({
      dimensions: currentEntry.dimensions,
      current: currentEntry.distribution,
      previous: previousEntry.distribution,
      comparison: comparisonFor(currentEntry.distribution, previousEntry.distribution),
      trend: days.map((day) => byDay.get(day) || {
        day,
        status: plan.current.status === "complete" ? "no_data" : "retention_partial",
      }),
      first_observation_at: currentEntry.first_observation_at,
      latest_observation_at: currentEntry.latest_observation_at,
    });
  }

  return {
    schema: "cityscroll.performance.query_result.v1",
    status: overallStatus(series, plan.current),
    query: plan.query,
    sample_floor: plan.sample_floor,
    sampling: PERFORMANCE_SAMPLING_SEMANTICS,
    retention: {
      retention_days: PERFORMANCE_RETENTION_DAYS,
      current: withoutInternalCoverage(plan.current),
      previous: withoutInternalCoverage(plan.previous),
    },
    series,
    freshness: freshnessFor(series, plan.queried_at),
    data_health: options.dataHealth || { status: "unavailable", reason: "not-read" },
  };
}

function withoutInternalCoverage(coverage) {
  const { query_start_ms, query_end_ms, queryable, ...publicCoverage } = coverage;
  return publicCoverage;
}

async function readHealthValue(kv, key) {
  try {
    return await kv.get(key);
  } catch {
    return null;
  }
}

async function readHealthCounter(kv, metric, days, now) {
  let count = 0;
  let complete = true;
  for (const day of lastNDays(days, now)) {
    try {
      const raw = await kv.get(statsKey(metric, day));
      if (raw == null || raw === "") continue;
      const parsed = Number(raw);
      if (!Number.isSafeInteger(parsed) || parsed < 0) complete = false;
      else count += parsed;
    } catch {
      complete = false;
    }
  }
  return { count, complete };
}

export async function readPerformanceDataHealth(env, now = new Date(), days = PERFORMANCE_HEALTH_WINDOW_DAYS) {
  if (!env?.ALERT_STATE) return { status: "unavailable", reason: "not-configured" };
  const boundedDays = Number.isSafeInteger(days) && days >= 1 && days <= 30
    ? days
    : PERFORMANCE_HEALTH_WINDOW_DAYS;
  const entries = await Promise.all(RUM_HEALTH_REASONS.map(async (reason) => [
    reason,
    await readHealthCounter(env.ALERT_STATE, `rum_health.${reason}`, boundedDays, now),
  ]));
  const healthReads = Object.fromEntries(entries);
  const counts = Object.fromEntries(entries.map(([reason, result]) => [reason, result.count]));
  const [latestAcceptedRaw, latestQueryRaw] = await Promise.all([
    readHealthValue(env.ALERT_STATE, "rum:health:latest-accepted"),
    readHealthValue(env.ALERT_STATE, "rum:health:latest-query"),
  ]);
  const latestAccepted = optionalHealthTimestamp(latestAcceptedRaw);
  const latestQuery = optionalHealthTimestamp(latestQueryRaw);
  const rejectedByReason = Object.fromEntries(REJECTION_REASONS.map((reason) => [reason, counts[reason]]));
  const configured = counts.storage_configured;
  const unavailable = counts.storage_unavailable;
  return {
    status: Object.values(healthReads).every(({ complete }) => complete) ? "available" : "partial",
    window_days: boundedDays,
    accepted: counts.accepted,
    rejected: Object.values(rejectedByReason).reduce((sum, count) => sum + count, 0),
    rejected_by_reason: rejectedByReason,
    unsupported: counts.unsupported_schema,
    excluded: {
      developer: counts.developer,
      disabled: counts.disabled,
      non_production: counts.non_production,
    },
    storage: {
      status: unavailable > 0 ? "degraded" : configured > 0 ? "configured" : "not_observed",
      configured_checks: configured,
      unavailable_checks: unavailable,
    },
    latest_accepted_at: latestAccepted,
    latest_query_at: latestQuery,
    ...(latestAccepted ? {
      ingestion_delay_seconds: Math.max(0, Math.floor((now.getTime() - Date.parse(latestAccepted)) / 1000)),
    } : {}),
  };
}

async function recordLatestQuery(env, now) {
  if (!env?.ALERT_STATE) return;
  try {
    await env.ALERT_STATE.put("rum:health:latest-query", now.toISOString());
  } catch {
    // Query health is best-effort and never changes the distribution result.
  }
}

function unavailableSnapshot(plan, reason, dataHealth) {
  return {
    schema: "cityscroll.performance.query_result.v1",
    status: "unavailable",
    unavailable_reason: reason,
    query: plan?.query || null,
    sample_floor: plan?.sample_floor || null,
    sampling: PERFORMANCE_SAMPLING_SEMANTICS,
    retention: plan ? {
      retention_days: PERFORMANCE_RETENTION_DAYS,
      current: withoutInternalCoverage(plan.current),
      previous: withoutInternalCoverage(plan.previous),
    } : null,
    series: [],
    freshness: { status: "unavailable", queried_at: plan?.queried_at || null },
    data_health: dataHealth,
    read_path: { status: "unavailable", reason },
  };
}

export async function readPerformanceAnalytics(env, input = {}, options = {}) {
  let plan;
  try {
    plan = performanceAnalyticsQueryPlan(input, {
      now: options.now || new Date(),
      configuredSince: env?.RUM_MEASURED_SINCE,
      dataset: env?.RUM_ANALYTICS_DATASET,
      sampleFloor: options.sampleFloor ?? env?.RUM_MIN_SAMPLED_ROWS,
    });
  } catch (error) {
    if (error instanceof PerformanceQueryError) throw error;
    throw error;
  }

  const now = new Date(plan.queried_at);
  const health = () => readPerformanceDataHealth(env, now, options.healthWindowDays);
  const readConfiguration = performanceReadConfiguration(env);
  if (!readConfiguration.configured) {
    return unavailableSnapshot(plan, readConfiguration.reason, await health());
  }

  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const endpoint = `https://api.cloudflare.com/client/v4/accounts/${env.ANALYTICS_ACCOUNT_ID}/analytics_engine/sql`;
  try {
    const responses = await Promise.all(plan.requests.map(async (request) => {
      const response = await fetchImpl(endpoint, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${env.ANALYTICS_READ_TOKEN}`,
          "Content-Type": "text/plain",
        },
        body: request.sql,
      });
      if (!response?.ok) throw new PerformanceSqlError(`sql-${response?.status || "unreachable"}`);
      const body = await response.json();
      if (!Array.isArray(body?.data)) throw new PerformanceSqlError("invalid-query-result");
      return [request.id, body.data];
    }));
    await recordLatestQuery(env, now);
    return buildPerformanceSnapshot(Object.fromEntries(responses), plan, { dataHealth: await health() });
  } catch (error) {
    const reason = error instanceof PerformanceSqlError ? error.reason : "sql-unreachable";
    return unavailableSnapshot(plan, reason, await health());
  }
}
