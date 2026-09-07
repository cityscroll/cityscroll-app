/**
 * The public search-usage summary: a closed, narrow projection of the private
 * receipt-derived aggregate.
 *
 * Three rules make this publishable at all.
 *
 *   Closed serialization. The published object is assembled field by field from an
 *     allowlist, and then checked against that allowlist before it is served. A value
 *     that is not a whole count, a declared constant, or an ISO instant cannot appear,
 *     so a future field added to the private aggregate cannot ride along by accident.
 *
 *   Completeness belongs to the metric. A period is published only when the
 *     measurement behind it is established for that period: the receipt read finished,
 *     nothing in it was unclassifiable, and counting had already begun when the period
 *     opened. Anything else publishes the shorter span measurement can defend, or an
 *     explicit unavailable state — never a zero that reads as "nobody searched".
 *
 *   Public reads consume a snapshot. The scheduled refresh does the receipt read and
 *     stores the last verified projection; a public request reads that stored value.
 *     A public page load therefore never scans the receipt store, and a failed refresh
 *     leaves the last verified snapshot standing with the failure recorded beside it.
 *
 * Nothing identifying crosses this boundary: no query text, no result trace, no
 * account label, browser identity, subscriber identity or receipt id, no recognized-
 * account count, no private route, and no scan diagnostics. Only whole counts, the
 * days they cover, and the state of the measurement itself.
 */

import {
  SEARCH_USAGE_WINDOW_DAYS,
  foldSearchUsage,
  readSearchUsageObservations,
  unavailableSearchUsage,
} from "./search_usage.mjs";
import { publishSearchUsageDailyAggregates } from "./search_usage_daily.mjs";

export const PUBLIC_SEARCH_USAGE_SCHEMA = "cityscroll.public_search_usage.v1";

/** Where the scheduled refresh leaves the last verified projection. */
export const PUBLIC_SEARCH_USAGE_KEY = "stats:public:search-usage:latest";

/**
 * A snapshot older than this is reported as stale but still published: it names the
 * exact days it covers, so age makes it less current, not untrue.
 */
export const PUBLIC_SEARCH_USAGE_STALE_AFTER_MS = 26 * 3600 * 1000;

/**
 * Past this, the snapshot stops being published at all. The receipts behind it have
 * left retention, so nothing could re-establish it, and a reader deserves the honest
 * unavailable state rather than a period nobody can check any more.
 */
export const PUBLIC_SEARCH_USAGE_EXPIRES_AFTER_MS = 7 * 24 * 3600 * 1000;

/** Plain-English population statement for a JSON consumer with no translation catalog. */
export const PUBLIC_SEARCH_USAGE_POPULATION =
  "Accepted production search-execution receipts. One count per finished search, not per person.";

export const PUBLIC_SEARCH_USAGE_SUBSET_RULE =
  "Searches returning records is a subset of searches run. The two are never added.";

/** The two published measures, in published order. */
export const PUBLIC_SEARCH_USAGE_METRICS = Object.freeze([
  Object.freeze({
    metric_id: "searches_run",
    label_key: "stats_search_use_run_label",
    definition_key: "stats_search_use_run_desc",
    read: (cut) => cut.completed,
  }),
  Object.freeze({
    metric_id: "searches_returning_records",
    label_key: "stats_search_use_returning_label",
    definition_key: "stats_search_use_returning_desc",
    read: (cut) => cut.returned_records,
  }),
]);

/** Every reason this contract may publish. A reason outside this set is a defect. */
export const PUBLIC_SEARCH_USAGE_REASONS = Object.freeze([
  "measurement_unavailable",
  "measurement_incomplete",
  "measurement_start_unknown",
  "measurement_not_started",
  "no_verified_snapshot",
  "snapshot_rejected",
  "snapshot_expired",
]);

const PERIOD_STATES = Object.freeze(["measured", "unavailable"]);
const PERIOD_COVERAGE = Object.freeze(["complete", "partial", "unavailable"]);
const MEASUREMENT_STATES = Object.freeze(["complete", "incomplete", "unavailable"]);
const REFRESH_STATES = Object.freeze(["fresh", "stale", "failed", "never_verified"]);

const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

/**
 * Every string literal the published artifact is allowed to contain. Anything else is
 * free text, and free text is how a query, a label or an address escapes.
 */
const ALLOWED_STRINGS = new Set([
  PUBLIC_SEARCH_USAGE_SCHEMA,
  PUBLIC_SEARCH_USAGE_POPULATION,
  PUBLIC_SEARCH_USAGE_SUBSET_RULE,
  "search_usage",
  ...PUBLIC_SEARCH_USAGE_METRICS.flatMap((metric) => [metric.metric_id, metric.label_key, metric.definition_key]),
  ...PUBLIC_SEARCH_USAGE_REASONS,
  ...PERIOD_STATES,
  ...PERIOD_COVERAGE,
  ...MEASUREMENT_STATES,
  ...REFRESH_STATES,
]);

const TOP_LEVEL_KEYS = Object.freeze([
  "schema", "available", "unavailable_reason", "generated_at", "measurement", "refresh", "periods",
]);
const MEASUREMENT_KEYS = Object.freeze([
  "family", "population", "population_key", "subset_rule", "state", "measured_since",
]);
const REFRESH_KEYS = Object.freeze(["state", "verified_at", "attempted_at", "failure_reason"]);
const PERIOD_KEYS = Object.freeze([
  "period_id", "requested_days", "state", "coverage", "unavailable_reason",
  "starts_at", "ends_at", "metrics",
]);
const METRIC_KEYS = Object.freeze([
  "metric_id", "label_key", "definition_key", "state", "value",
]);

function isInstantOrNull(value) {
  return value === null || (typeof value === "string" && INSTANT.test(value));
}

function isWholeCount(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function exactKeys(candidate, keys) {
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return false;
  const present = Object.keys(candidate);
  return present.length === keys.length && keys.every((key, index) => present[index] === key);
}

/**
 * Structural gate over the finished artifact. Returns the violations it found, so a
 * caller can refuse to publish rather than trusting that the projection stayed narrow.
 */
export function publicSearchUsageViolations(artifact) {
  const violations = [];
  const check = (condition, message) => { if (!condition) violations.push(message); };

  if (!exactKeys(artifact, TOP_LEVEL_KEYS)) return ["top-level keys are not the published set"];
  check(artifact.schema === PUBLIC_SEARCH_USAGE_SCHEMA, "schema");
  check(typeof artifact.available === "boolean", "available");
  check(artifact.unavailable_reason === null || PUBLIC_SEARCH_USAGE_REASONS.includes(artifact.unavailable_reason),
    "unavailable_reason");
  check(isInstantOrNull(artifact.generated_at) && artifact.generated_at !== null, "generated_at");

  if (!exactKeys(artifact.measurement, MEASUREMENT_KEYS)) violations.push("measurement keys");
  else {
    const measurement = artifact.measurement;
    check(measurement.family === "search_usage", "measurement.family");
    check(measurement.population === PUBLIC_SEARCH_USAGE_POPULATION, "measurement.population");
    check(typeof measurement.population_key === "string" && ALLOWED_STRINGS.has(measurement.population_key),
      "measurement.population_key");
    check(measurement.subset_rule === PUBLIC_SEARCH_USAGE_SUBSET_RULE, "measurement.subset_rule");
    check(MEASUREMENT_STATES.includes(measurement.state), "measurement.state");
    check(isInstantOrNull(measurement.measured_since), "measurement.measured_since");
  }

  if (!exactKeys(artifact.refresh, REFRESH_KEYS)) violations.push("refresh keys");
  else {
    const refresh = artifact.refresh;
    check(REFRESH_STATES.includes(refresh.state), "refresh.state");
    check(isInstantOrNull(refresh.verified_at), "refresh.verified_at");
    check(isInstantOrNull(refresh.attempted_at), "refresh.attempted_at");
    check(refresh.failure_reason === null || PUBLIC_SEARCH_USAGE_REASONS.includes(refresh.failure_reason),
      "refresh.failure_reason");
  }

  if (!Array.isArray(artifact.periods)) violations.push("periods");
  else {
    for (const period of artifact.periods) {
      if (!exactKeys(period, PERIOD_KEYS)) { violations.push("period keys"); continue; }
      check(typeof period.period_id === "string" && /^last\d{1,3}d$/.test(period.period_id), "period.period_id");
      check(isWholeCount(period.requested_days) && period.requested_days > 0, "period.requested_days");
      check(PERIOD_STATES.includes(period.state), "period.state");
      check(PERIOD_COVERAGE.includes(period.coverage), "period.coverage");
      check(period.unavailable_reason === null || PUBLIC_SEARCH_USAGE_REASONS.includes(period.unavailable_reason),
        "period.unavailable_reason");
      check(isInstantOrNull(period.starts_at), "period.starts_at");
      check(isInstantOrNull(period.ends_at), "period.ends_at");
      if (!Array.isArray(period.metrics)) { violations.push("period.metrics"); continue; }
      for (const metric of period.metrics) {
        if (!exactKeys(metric, METRIC_KEYS)) { violations.push("metric keys"); continue; }
        check(ALLOWED_STRINGS.has(metric.metric_id), "metric.metric_id");
        check(ALLOWED_STRINGS.has(metric.label_key), "metric.label_key");
        check(ALLOWED_STRINGS.has(metric.definition_key), "metric.definition_key");
        check(PERIOD_STATES.includes(metric.state), "metric.state");
        check(metric.value === null || isWholeCount(metric.value), "metric.value");
        check(metric.state === "measured" ? isWholeCount(metric.value) : metric.value === null,
          "metric.value must be a count exactly when the metric is measured");
      }
    }
  }
  return violations;
}

/** How well the receipt read itself held up, before any period is considered. */
export function publicMeasurementState(usage) {
  if (!usage || usage.available !== true) return "unavailable";
  if (usage.scan?.scan_complete === false) return "incomplete";
  if (Number(usage.unclassified_receipts) > 0) return "incomplete";
  return "complete";
}

function unavailablePeriod(days, reason) {
  return {
    period_id: `last${days}d`,
    requested_days: days,
    state: "unavailable",
    coverage: "unavailable",
    unavailable_reason: reason,
    starts_at: null,
    ends_at: null,
    metrics: PUBLIC_SEARCH_USAGE_METRICS.map((metric) => ({
      metric_id: metric.metric_id,
      label_key: metric.label_key,
      definition_key: metric.definition_key,
      state: "unavailable",
      value: null,
    })),
  };
}

function measuredPeriod(days, cut, coverage) {
  return {
    period_id: `last${days}d`,
    requested_days: days,
    state: "measured",
    coverage,
    unavailable_reason: null,
    // A partial period names the day counting actually began, so the published figure
    // and the days it covers can never drift apart.
    starts_at: coverage === "complete" ? cut.starts_at : cut.covered_from,
    ends_at: cut.ends_at,
    metrics: PUBLIC_SEARCH_USAGE_METRICS.map((metric) => ({
      metric_id: metric.metric_id,
      label_key: metric.label_key,
      definition_key: metric.definition_key,
      state: "measured",
      value: Number(metric.read(cut)) || 0,
    })),
  };
}

/**
 * Project the private aggregate into the published artifact. Pure: the same aggregate
 * and clock always produce the same bytes.
 */
export function projectPublicSearchUsage(usage, { now = new Date() } = {}) {
  const generatedAt = new Date(now).toISOString();
  const state = publicMeasurementState(usage);
  const measuredSince = typeof usage?.measured_since === "string" ? usage.measured_since : null;
  const measurement = {
    family: "search_usage",
    population: PUBLIC_SEARCH_USAGE_POPULATION,
    population_key: "stats_search_use_run_desc",
    subset_rule: PUBLIC_SEARCH_USAGE_SUBSET_RULE,
    state,
    measured_since: measuredSince,
  };

  const periods = SEARCH_USAGE_WINDOW_DAYS.map((days) => {
    if (state === "unavailable") return unavailablePeriod(days, "measurement_unavailable");
    if (state === "incomplete") return unavailablePeriod(days, "measurement_incomplete");
    const cut = usage.windows?.[`last${days}d`];
    if (!cut) return unavailablePeriod(days, "measurement_unavailable");
    if (cut.measurement_complete === null) return unavailablePeriod(days, "measurement_start_unknown");
    if (Date.parse(cut.covered_from) > Date.parse(cut.ends_at)) {
      return unavailablePeriod(days, "measurement_not_started");
    }
    return measuredPeriod(days, cut, cut.measurement_complete === true ? "complete" : "partial");
  });

  const available = periods.some((period) => period.state === "measured");
  return {
    schema: PUBLIC_SEARCH_USAGE_SCHEMA,
    available,
    unavailable_reason: available ? null : (periods[0]?.unavailable_reason || "measurement_unavailable"),
    generated_at: generatedAt,
    measurement,
    refresh: { state: "never_verified", verified_at: null, attempted_at: null, failure_reason: null },
    periods,
  };
}

/** The honest empty answer when no verified snapshot can be served. */
export function unavailablePublicSearchUsage(reason, now = new Date(), refresh = null) {
  return {
    schema: PUBLIC_SEARCH_USAGE_SCHEMA,
    available: false,
    unavailable_reason: reason,
    generated_at: new Date(now).toISOString(),
    measurement: {
      family: "search_usage",
      population: PUBLIC_SEARCH_USAGE_POPULATION,
      population_key: "stats_search_use_run_desc",
      subset_rule: PUBLIC_SEARCH_USAGE_SUBSET_RULE,
      state: "unavailable",
      measured_since: null,
    },
    refresh: refresh || { state: "never_verified", verified_at: null, attempted_at: null, failure_reason: null },
    periods: [],
  };
}

function utcDayStartIso(now) {
  const ms = new Date(now).getTime();
  return new Date(Math.floor(ms / 86400000) * 86400000).toISOString();
}

async function readSnapshotRecord(env) {
  if (!env?.ALERT_STATE?.get) return null;
  try {
    const raw = await env.ALERT_STATE.get(PUBLIC_SEARCH_USAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && parsed.schema === PUBLIC_SEARCH_USAGE_SCHEMA ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * When counting began, or null when nothing establishes it yet.
 *
 * A configured value wins, because an operator who knows the real start can say so.
 * Otherwise the first refresh records its own instant and every later refresh keeps
 * it: measurement is claimed from the moment this contract began verifying it, never
 * retroactively over receipts nobody was checking.
 *
 * Null is a distinct answer, not a default: the authenticated aggregate keeps
 * reporting the receipts it holds, and the public projection publishes no period,
 * because "we do not know when counting began" is not "counting began at zero".
 */
export async function resolveSearchMeasurementStart(env, { record } = {}) {
  const configured = env?.SEARCH_ACTIVITY_MEASURED_SINCE;
  if (typeof configured === "string" && Number.isFinite(Date.parse(configured))) {
    return new Date(Date.parse(configured)).toISOString();
  }
  const stored = record === undefined ? await readSnapshotRecord(env) : record;
  if (typeof stored?.measured_since === "string" && Number.isFinite(Date.parse(stored.measured_since))) {
    return stored.measured_since;
  }
  return null;
}

/**
 * Scheduled refresh. Reads the receipt store once, projects the public artifact, and
 * persists it as the last verified snapshot. A refresh that cannot establish a period
 * records the failure and leaves the previous verified snapshot in place, so an
 * incident degrades currency rather than erasing the published figures.
 */
export async function refreshPublicSearchUsageSnapshot(env, { now = new Date() } = {}) {
  if (!env?.ALERT_STATE?.put) return { verified: false, reason: "no_store" };
  const attemptedAt = new Date(now).toISOString();
  const record = await readSnapshotRecord(env);
  // The first refresh is where measurement starts being claimed, and it says so once.
  const measuredSince = (await resolveSearchMeasurementStart(env, { record })) || utcDayStartIso(now);

  // One scan of the receipt store serves both readings: the windowed projection this
  // contract publishes, and the dated aggregates the trend and the reconciliation are built
  // from. Two scans could disagree with each other; one cannot.
  const read = await readSearchUsageObservations(env, { now });
  const usage = read.ok
    ? foldSearchUsage(read.observations, { now, measuredSince, scan: read.scan })
    : unavailableSearchUsage(read.reason, now);
  const artifact = projectPublicSearchUsage(usage, { now });
  const violations = publicSearchUsageViolations(artifact);
  const verified = artifact.available && violations.length === 0;

  const next = verified
    ? {
      schema: PUBLIC_SEARCH_USAGE_SCHEMA,
      measured_since: measuredSince,
      verified_at: attemptedAt,
      attempted_at: attemptedAt,
      failure_reason: null,
      artifact,
    }
    : {
      schema: PUBLIC_SEARCH_USAGE_SCHEMA,
      measured_since: measuredSince,
      verified_at: record?.verified_at || null,
      attempted_at: attemptedAt,
      failure_reason: violations.length ? "snapshot_rejected" : (artifact.unavailable_reason || "measurement_unavailable"),
      artifact: record?.artifact || null,
    };

  try {
    await env.ALERT_STATE.put(PUBLIC_SEARCH_USAGE_KEY, JSON.stringify(next));
  } catch {
    return { verified: false, reason: "write_failed" };
  }

  // The dated lineage is published from the same read, and independently of whether the
  // public projection could be verified. A refresh that cannot publish a period still knows
  // which days it saw, and losing that would be losing the trend rather than the summary.
  const daily = read.ok
    ? await publishSearchUsageDailyAggregates(env, { now, observations: read.observations, measuredSince })
    : { published: false, reason: read.reason, days: [] };

  return {
    verified,
    reason: next.failure_reason,
    measured_since: measuredSince,
    periods_measured: artifact.periods.filter((period) => period.state === "measured").length,
    daily_aggregates: {
      published: daily.published,
      reason: daily.reason || null,
      created: daily.days.filter((row) => row.action === "created").length,
      unchanged: daily.days.filter((row) => row.action === "unchanged").length,
      divergent: daily.days.filter((row) => row.action === "divergent_kept_stored").map((row) => row.day),
      write_failed: daily.days.filter((row) => row.action === "write_failed").map((row) => row.day),
    },
  };
}

/**
 * What a public request serves: the stored snapshot, with its own freshness stated.
 * This never reads the receipt store, so a public page load costs one key read and
 * cannot be made expensive by traffic.
 */
export async function readPublicSearchUsage(env, { now = new Date() } = {}) {
  const nowMs = new Date(now).getTime();
  const record = await readSnapshotRecord(env);
  if (!record) return unavailablePublicSearchUsage("no_verified_snapshot", now);

  const refreshBase = {
    verified_at: typeof record.verified_at === "string" ? record.verified_at : null,
    attempted_at: typeof record.attempted_at === "string" ? record.attempted_at : null,
    failure_reason: PUBLIC_SEARCH_USAGE_REASONS.includes(record.failure_reason) ? record.failure_reason : null,
  };

  const verifiedMs = refreshBase.verified_at ? Date.parse(refreshBase.verified_at) : NaN;
  if (!record.artifact || !Number.isFinite(verifiedMs)) {
    return unavailablePublicSearchUsage("no_verified_snapshot", now, {
      state: refreshBase.failure_reason ? "failed" : "never_verified",
      ...refreshBase,
    });
  }
  const age = nowMs - verifiedMs;
  if (age > PUBLIC_SEARCH_USAGE_EXPIRES_AFTER_MS) {
    return unavailablePublicSearchUsage("snapshot_expired", now, { state: "failed", ...refreshBase });
  }

  const state = refreshBase.failure_reason ? "failed" : (age > PUBLIC_SEARCH_USAGE_STALE_AFTER_MS ? "stale" : "fresh");
  const published = {
    ...record.artifact,
    generated_at: new Date(nowMs).toISOString(),
    refresh: { state, ...refreshBase },
  };
  const violations = publicSearchUsageViolations(published);
  if (violations.length) return unavailablePublicSearchUsage("snapshot_rejected", now, { state: "failed", ...refreshBase });
  return published;
}
