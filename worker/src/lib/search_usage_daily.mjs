/**
 * Dated daily aggregates for the published search-use measurement.
 *
 * The published summary answers "the last seven days" and "the last thirty days". Both are
 * read out of a receipt store that keeps thirty days. That is enough to publish a period and
 * nowhere near enough to hold a trend: the day a receipt leaves retention, any figure derived
 * by re-reading the receipts silently gets smaller. A chart built that way does not go stale,
 * it goes wrong.
 *
 * So each closed UTC day is folded once into its own small aggregate and kept far longer than
 * the receipts behind it. Four rules make that safe to build on.
 *
 *   A day is closed before it is written. An aggregate names its own cutoff — the instant the
 *     day ended — and is only published after that instant has passed. There is no partial
 *     day to be revised later, and a cycle that runs at 00:05 publishes yesterday, not a
 *     fragment of today.
 *
 *   One execution has one date. Repeated intakes collapse onto the earliest instant the store
 *     learned of the execution, using the same rule the windowed fold uses. A retry that
 *     crosses midnight therefore resolves to the day the execution was first received, and
 *     cannot appear on both sides of it.
 *
 *   A published day is final. Reprocessing the same day recomputes it and compares; equal
 *     content is left exactly as it stands, and different content is REPORTED rather than
 *     written over. That is what keeps retention expiry from rewriting history: a recompute
 *     made after the receipts have gone would produce a smaller number, and the stored day
 *     refuses it instead of accepting it.
 *
 *   A day nobody measured stays absent. There is no zero-filling and no interpolation. A gap
 *     is reported as a gap, and a gap older than the receipt retention horizon is reported as
 *     one nothing can now recover.
 *
 * The store is the same KV namespace and the same per-day-key, write-the-value-directly
 * pattern `snapshotHistDay` already uses for daily gauges — no second analytics platform, and
 * no read-modify-write that concurrent cycles could lose.
 *
 * Nothing dated here is public. These are the lineage the published projection is reconciled
 * against, read back only through the authenticated desk. They carry whole counts and the day
 * they cover: no query, no result, no reader, no receipt id.
 */

import { sha256Hex } from "../../../entity_resolution/hash.mjs";
import { SEARCH_ACTIVITY_RETENTION_DAYS } from "../../../capabilities/search_activity.mjs";
import {
  dedupeSearchUsageExecutions,
  measurementStartMs,
} from "./search_usage.mjs";

export const SEARCH_USAGE_DAILY_SCHEMA = "cityscroll.search_usage_daily.v1";

/** Where one day's aggregate lives. One key per day, in the established stats namespace. */
export const SEARCH_USAGE_DAILY_KEY_PREFIX = "stats:public:search-usage:day:";

/**
 * The population these aggregates count, and the version of the rule that counts it. A change
 * to either is a different measurement and must be a different version, because an aggregate
 * is only idempotent with respect to the population and version it names.
 */
export const SEARCH_USAGE_DAILY_POPULATION =
  "Accepted production search-execution receipts. One count per finished search, not per person.";
export const SEARCH_USAGE_DAILY_POPULATION_VERSION = "v1";

/**
 * How long a dated aggregate is kept: long enough to be a trend, and far longer than the
 * receipts it was folded from. Retention is what makes the aggregate worth writing at all.
 */
export const SEARCH_USAGE_DAILY_RETENTION_DAYS = 400;
export const SEARCH_USAGE_DAILY_TTL_SECONDS = SEARCH_USAGE_DAILY_RETENTION_DAYS * 24 * 3600;

/** The two measures, in published order, matching the public projection's own metric ids. */
export const SEARCH_USAGE_DAILY_METRICS = Object.freeze(["searches_run", "searches_returning_records"]);

/** Every outcome one day's publication attempt can have. */
export const SEARCH_USAGE_DAILY_ACTIONS = Object.freeze([
  "created",
  "unchanged",
  "divergent_kept_stored",
  "write_failed",
]);

const DAY_MS = 24 * 3600 * 1000;
const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export function searchUsageDayKey(day) {
  return `${SEARCH_USAGE_DAILY_KEY_PREFIX}${day}`;
}

/** The UTC day an instant falls in. */
export function utcDay(ms) {
  return new Date(Math.floor(ms / DAY_MS) * DAY_MS).toISOString().slice(0, 10);
}

export function dayStartMs(day) {
  return Date.parse(`${day}T00:00:00.000Z`);
}

/** The instant a day ends, which is also the cutoff its aggregate is computed at. */
export function dayCutoff(day) {
  return new Date(dayStartMs(day) + DAY_MS).toISOString();
}

/**
 * Fold observations into per-day counts.
 *
 * Bucketed by the instant the store received the execution, never by the clock the fold runs
 * on, so the same receipts always land on the same dates however late they are reprocessed.
 * Executions dated in the future, and executions before measurement began, are excluded and
 * counted separately rather than dropped into a day.
 */
export function foldSearchUsageDays(observations = [], { now = new Date(), measuredSince = null } = {}) {
  const nowMs = new Date(now).getTime();
  const measuredSinceMs = measurementStartMs(measuredSince);
  const { byExecution, duplicateIntakes } = dedupeSearchUsageExecutions(observations);
  const days = new Map();
  let futureDated = 0;
  let beforeMeasurement = 0;

  for (const execution of byExecution.values()) {
    if (execution.receivedAtMs > nowMs) { futureDated += 1; continue; }
    if (measuredSinceMs !== null && execution.receivedAtMs < measuredSinceMs) {
      beforeMeasurement += 1;
      continue;
    }
    const day = utcDay(execution.receivedAtMs);
    const bucket = days.get(day) || { searches_run: 0, searches_returning_records: 0 };
    bucket.searches_run += 1;
    if (execution.returnedRecords) bucket.searches_returning_records += 1;
    days.set(day, bucket);
  }

  return {
    days: Object.fromEntries([...days.entries()].sort(([a], [b]) => (a < b ? -1 : 1))),
    executions_observed: byExecution.size,
    duplicate_intakes: duplicateIntakes,
    future_dated_executions: futureDated,
    executions_before_measurement: beforeMeasurement,
  };
}

/**
 * One day's aggregate, as bytes.
 *
 * Deliberately free of any clock: no generated_at, no observer, no run id. Two runs over the
 * same receipts produce the same object and the same digest, which is what makes reprocessing
 * a no-op instead of a rewrite.
 */
export function buildSearchUsageDailyAggregate({ day, counts = {}, measuredSince = null }) {
  if (!DAY_PATTERN.test(String(day || ""))) throw new Error("a dated aggregate needs a UTC day");
  const measuredSinceMs = measurementStartMs(measuredSince);
  const startMs = dayStartMs(day);
  const body = {
    schema: SEARCH_USAGE_DAILY_SCHEMA,
    day,
    cutoff: dayCutoff(day),
    population: SEARCH_USAGE_DAILY_POPULATION,
    population_version: SEARCH_USAGE_DAILY_POPULATION_VERSION,
    // complete: measurement covered the whole day. partial: counting began inside it, so the
    // figure is real but is not a whole day and must never be charted as one.
    coverage: measuredSinceMs !== null && measuredSinceMs > startMs ? "partial" : "complete",
    measured_since: measuredSinceMs === null ? null : new Date(measuredSinceMs).toISOString(),
    receipt_retention_days: SEARCH_ACTIVITY_RETENTION_DAYS,
    metrics: Object.fromEntries(SEARCH_USAGE_DAILY_METRICS.map((metric) => [metric, Number(counts[metric]) || 0])),
  };
  return { ...body, content_hash: sha256Hex(JSON.stringify(body)) };
}

/** Recompute the digest of a stored aggregate, so a stored row can be checked rather than trusted. */
export function searchUsageDailyContentHash(aggregate) {
  if (!aggregate || typeof aggregate !== "object") return null;
  const { content_hash: _ignored, ...body } = aggregate;
  return sha256Hex(JSON.stringify(body));
}

/**
 * The closed UTC days a run may publish: every day that has ended and whose receipts the
 * scan could still have seen. Today is never among them, because today is not over.
 */
export function publishableSearchUsageDays({ now = new Date(), horizonDays = SEARCH_ACTIVITY_RETENTION_DAYS, measuredSince = null } = {}) {
  const nowMs = new Date(now).getTime();
  const todayStart = Math.floor(nowMs / DAY_MS) * DAY_MS;
  const measuredSinceMs = measurementStartMs(measuredSince);
  const days = [];
  for (let back = 1; back <= horizonDays; back += 1) {
    const startMs = todayStart - back * DAY_MS;
    if (measuredSinceMs !== null && startMs + DAY_MS <= measuredSinceMs) continue;
    days.push(utcDay(startMs));
  }
  return days.sort();
}

async function readStoredAggregate(env, day) {
  try {
    const raw = await env.ALERT_STATE.get(searchUsageDayKey(day));
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && parsed.schema === SEARCH_USAGE_DAILY_SCHEMA ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Publish the closed days a run can account for.
 *
 * A day already stored is never rewritten. Recomputing it and finding the same digest is the
 * cheap proof that reprocessing is a no-op; finding a different one is a fact worth reporting
 * — normally that the receipts behind it have started leaving retention — and the stored day
 * stands.
 */
export async function publishSearchUsageDailyAggregates(env, {
  now = new Date(),
  observations = [],
  measuredSince = null,
} = {}) {
  if (!env?.ALERT_STATE?.put) return { published: false, reason: "no_store", days: [] };
  const folded = foldSearchUsageDays(observations, { now, measuredSince });
  const results = [];
  for (const day of publishableSearchUsageDays({ now, measuredSince })) {
    const aggregate = buildSearchUsageDailyAggregate({ day, counts: folded.days[day], measuredSince });
    const stored = await readStoredAggregate(env, day);
    if (stored) {
      results.push({
        day,
        action: stored.content_hash === aggregate.content_hash ? "unchanged" : "divergent_kept_stored",
        stored_metrics: stored.metrics,
        recomputed_metrics: aggregate.metrics,
      });
      continue;
    }
    try {
      await env.ALERT_STATE.put(searchUsageDayKey(day), JSON.stringify(aggregate), {
        expirationTtl: SEARCH_USAGE_DAILY_TTL_SECONDS,
      });
      results.push({ day, action: "created", stored_metrics: aggregate.metrics, recomputed_metrics: aggregate.metrics });
    } catch {
      results.push({ day, action: "write_failed", stored_metrics: null, recomputed_metrics: aggregate.metrics });
    }
  }
  return {
    published: true,
    reason: null,
    measured_since: measuredSince,
    observed: {
      executions: folded.executions_observed,
      duplicate_intakes: folded.duplicate_intakes,
      future_dated_executions: folded.future_dated_executions,
      executions_before_measurement: folded.executions_before_measurement,
    },
    days: results,
  };
}

/**
 * The dated series, with its gaps named.
 *
 * A day the store does not hold is reported missing, never as zero. A missing day inside the
 * receipt retention horizon could still be recovered by a rerun; one older than it could not,
 * and saying so is the difference between a fixable gap and a permanent hole in the trend.
 */
export async function readSearchUsageDailySeries(env, { now = new Date(), days = 90 } = {}) {
  const empty = {
    schema: SEARCH_USAGE_DAILY_SCHEMA,
    available: false,
    unavailable_reason: "no_store",
    requested_days: days,
    series: [],
    missing_days: [],
    unrecoverable_days: [],
    newest_day: null,
    oldest_day: null,
  };
  if (!env?.ALERT_STATE?.list) return empty;

  const nowMs = new Date(now).getTime();
  const todayStart = Math.floor(nowMs / DAY_MS) * DAY_MS;
  const wanted = [];
  for (let back = 1; back <= days; back += 1) wanted.push(utcDay(todayStart - back * DAY_MS));
  wanted.sort();

  const held = new Map();
  try {
    let cursor;
    do {
      const listed = await env.ALERT_STATE.list({ prefix: SEARCH_USAGE_DAILY_KEY_PREFIX, cursor });
      for (const key of listed?.keys || []) {
        const day = key.name.slice(SEARCH_USAGE_DAILY_KEY_PREFIX.length);
        if (!DAY_PATTERN.test(day)) continue;
        const stored = await readStoredAggregate(env, day);
        if (stored) held.set(day, stored);
      }
      cursor = listed?.list_complete ? null : listed?.cursor;
    } while (cursor);
  } catch {
    return { ...empty, unavailable_reason: "read_failed" };
  }

  const recoverableFrom = utcDay(todayStart - SEARCH_ACTIVITY_RETENTION_DAYS * DAY_MS);
  const series = [];
  const missing = [];
  const unrecoverable = [];
  for (const day of wanted) {
    const stored = held.get(day);
    if (stored) {
      series.push({
        day,
        cutoff: stored.cutoff,
        coverage: stored.coverage,
        metrics: stored.metrics,
        content_hash: stored.content_hash,
        digest_verified: searchUsageDailyContentHash(stored) === stored.content_hash,
      });
      continue;
    }
    missing.push(day);
    if (day < recoverableFrom) unrecoverable.push(day);
  }

  const heldDays = [...held.keys()].sort();
  return {
    schema: SEARCH_USAGE_DAILY_SCHEMA,
    available: true,
    unavailable_reason: null,
    requested_days: days,
    retention_days: SEARCH_USAGE_DAILY_RETENTION_DAYS,
    receipt_retention_days: SEARCH_ACTIVITY_RETENTION_DAYS,
    series,
    missing_days: missing,
    unrecoverable_days: unrecoverable,
    newest_day: heldDays.length ? heldDays[heldDays.length - 1] : null,
    oldest_day: heldDays.length ? heldDays[0] : null,
  };
}

/**
 * Reconcile the dated aggregates against a fresh read of the receipts behind them.
 *
 * The comparison is over closed days only, and only over the days both sides can speak for:
 * a day outside the receipt retention horizon is not a mismatch, it is a day the receipts can
 * no longer answer for, and it is reported that way.
 */
export function reconcileSearchUsageDaily({ storedSeries, observedDays = {}, now = new Date() } = {}) {
  const nowMs = new Date(now).getTime();
  const todayStart = Math.floor(nowMs / DAY_MS) * DAY_MS;
  const comparableFrom = utcDay(todayStart - SEARCH_ACTIVITY_RETENTION_DAYS * DAY_MS);
  const rows = [];
  for (const entry of storedSeries?.series || []) {
    if (entry.day < comparableFrom) {
      rows.push({ day: entry.day, state: "beyond_receipt_retention" });
      continue;
    }
    const observed = observedDays[entry.day] || { searches_run: 0, searches_returning_records: 0 };
    const matched = SEARCH_USAGE_DAILY_METRICS.every((metric) => (
      Number(entry.metrics?.[metric]) === Number(observed[metric] || 0)
    ));
    rows.push({
      day: entry.day,
      state: matched ? "matched" : "divergent",
      ...(matched ? {} : { stored: entry.metrics, recomputed: observed }),
    });
  }
  const counts = rows.reduce((totals, row) => {
    totals[row.state] = (totals[row.state] || 0) + 1;
    return totals;
  }, {});
  return {
    schema: "cityscroll.search_usage_daily_reconciliation.v1",
    compared_from: comparableFrom,
    rows,
    counts,
    // A missing day is never reconciled into agreement. It stays a gap in both directions.
    missing_days: storedSeries?.missing_days || [],
    unrecoverable_days: storedSeries?.unrecoverable_days || [],
    ok: (counts.divergent || 0) === 0 && (storedSeries?.missing_days?.length || 0) === 0,
  };
}
