// GET /stats — served-product coverage facts, plus a narrow verified search-usage summary.
//
// Product-use telemetry belongs behind the authenticated desk boundary. Two counts are the
// deliberate exception: how many searches finished, and how many of them returned records,
// each for an explicitly named period. They are projected from the same accepted execution
// receipts the desk reads, through a closed allowlist that carries no query, result, identity,
// receipt id or private route — see lib/public_search_usage.mjs. Everything else about product
// use, delivery and subscribers stays on GET /admin/stats.
//
// The response is assembled from a build-time artifact. It was once assembled from a live
// publisher aggregate, which meant a public page load reached an upstream API and reported an
// upstream population as if it were CityScroll coverage. Both are gone: the snapshot is
// produced by tools/build_served_coverage_snapshot.mjs, and this route only projects it.

import {
  REJECTED_EVENT_METRIC,
  dayStr, sumStat, readStatAllTime, readAllCategoryStats, readAllCategoryStatsWindow,
  readHistSeries, readHistEra, mergeRecoveredAllTime,
} from "./lib/stats.mjs";
import {
  ANALYTICS_RETENTION_DAYS,
  completeLensCounts,
  readUsageAnalytics,
  reconcileUsageWithDurableStores,
} from "./lib/analytics.mjs";
import { ANALYTICS_COLLECTOR_SURFACES } from "../../site/analytics_surface_taxonomy.mjs";
import { foldSearchUsage, readSearchUsageObservations, unavailableSearchUsage } from "./lib/search_usage.mjs";
import {
  SEARCH_USAGE_DAILY_POPULATION,
  SEARCH_USAGE_DAILY_POPULATION_VERSION,
  SEARCH_USAGE_DAILY_RETENTION_DAYS,
  foldSearchUsageDays,
  readSearchUsageDailySeries,
  reconcileSearchUsageDaily,
} from "./lib/search_usage_daily.mjs";
import {
  readPublicSearchUsage,
  resolveSearchMeasurementStart,
  unavailablePublicSearchUsage,
} from "./lib/public_search_usage.mjs";
import { isTestSubscriber } from "./lib/subscriptions.mjs";
import servedCoverage from "../../site/data/served_coverage_snapshot.json" with { type: "json" };

// Same key as alerts.mjs DIGEST_RUN_LATEST_KEY — kept local so /stats does not import the
// full alerts module (cron + Resend path) on every public read.
const DIGEST_RUN_LATEST_KEY = "digest:run:latest";
const CATCHUP_RUN_LATEST_KEY = "digest:catchup:run:latest";

const SITE_LANGUAGE_COUNT = 11;
const NOTICE_TRANSLATION_LANGUAGE_COUNT = 10;
export const PUBLIC_STATS_SCHEMA = "public-stats.v4";
export const SERVED_COVERAGE_SCHEMA = "cityscroll.served_coverage_snapshot.v1";

/**
 * Project the materialised coverage snapshot into the public response. The projection is a
 * closed selection: it names the metrics, the per-unit counts and their evidence dates, and
 * nothing else the snapshot happens to carry. Labels stay as translation keys, so the page and
 * this response describe the same measurement in whatever language a reader asked for.
 */
export function buildPublicStatsBody(coverage = servedCoverage, now = new Date(), searchUsage = null) {
  const usable = coverage && coverage.schema === SERVED_COVERAGE_SCHEMA ? coverage : null;
  return {
    schema: PUBLIC_STATS_SCHEMA,
    generated_at: new Date(now).toISOString(),
    scope: "Served-product coverage aggregates, and verified counts of searches run and searches returning records for named periods. Search queries, results, readers, subscribers and delivery operations are private.",
    coverage: usable
      ? {
        available: true,
        measurement: usable.measurement,
        metrics: usable.metrics,
        evidence_vintage: usable.evidence_vintage,
        domains: usable.domains,
      }
      : {
        available: false,
        unavailable_reason: "coverage_snapshot_unavailable",
        measurement: null,
        metrics: [],
        evidence_vintage: { oldest: null, newest: null },
        domains: [],
      },
    language_coverage: {
      site_languages: SITE_LANGUAGE_COUNT,
      translated_interface_languages: NOTICE_TRANSLATION_LANGUAGE_COUNT,
      notice_translation_languages: NOTICE_TRANSLATION_LANGUAGE_COUNT,
      notice_translation_mode: "on_demand",
      official_notice_language: "English",
    },
    // The projection is produced and closed-checked in lib/public_search_usage.mjs; this
    // route only places it. A caller with no snapshot to hand gets the honest empty answer
    // rather than an omitted key, so the shape of the response never depends on the store.
    search_usage: searchUsage || unavailablePublicSearchUsage("no_verified_snapshot", now),
  };
}

async function readDigestRunReceipt(env) {
  if (!env?.ALERT_STATE) return null;
  try {
    const raw = await env.ALERT_STATE.get(DIGEST_RUN_LATEST_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

async function readCatchUpReceipt(env) {
  if (!env?.ALERT_STATE) return null;
  try {
    const raw = await env.ALERT_STATE.get(CATCHUP_RUN_LATEST_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

// Count subscriptions whose delivery watermark (lastsent) lags behind today by >= threshold
// days. No PII — a count only. Best-effort: a partial scan beats a 500.
async function countLaggingSubs(env, thresholdDays = 2, now = new Date()) {
  if (!env?.SUBS || !env?.ALERT_STATE) return 0;
  const today = new Date(now).toISOString().slice(0, 10);
  const todayMs = new Date(today + "T00:00:00Z").getTime();
  let n = 0, cursor;
  try {
    do {
      const res = await env.SUBS.list({ prefix: "sub:", cursor });
      for (const k of res.keys) {
        try {
          const lastsent = await env.ALERT_STATE.get(`lastsent:${k.name}`);
          if (!lastsent) { n++; continue; } // never sent = lagging
          const sentMs = new Date(lastsent + "T00:00:00Z").getTime();
          if (!Number.isFinite(sentMs) || (todayMs - sentMs) >= thresholdDays * 86400000) n++;
        } catch { /* skip */ }
      }
      cursor = res.list_complete ? null : res.cursor;
    } while (cursor);
  } catch { /* partial beats 500 */ }
  return n;
}

const WINDOW_DAYS = 7;

/**
 * How each search figure on this response is produced, stated once and beside the figures
 * rather than inside them, so an operator reading them side by side cannot take one for the
 * other and so the fields themselves keep the bytes they had.
 *
 * `usage.searches` counts intent: someone asked. It comes from Analytics Engine, whose rows
 * are SAMPLED and re-expanded by each row's own sample interval, so it is an estimate.
 * `search_executions` counts outcome: a search finished and the reader saw what it returned.
 * It comes from stored execution receipts and is exact. The two answer different questions
 * over different populations by different methods, and are never added together.
 */
const MEASUREMENT_BASIS = Object.freeze({
  note: "Two different questions, two different methods. Never summed with each other.",
  "usage.searches": Object.freeze({
    question: "How often did someone start a search?",
    method: "sampled",
    exactness: "estimated",
    source: "Workers Analytics Engine, expanded by each row's own sample interval.",
  }),
  search_executions: Object.freeze({
    question: "How often did a search finish and render its result?",
    method: "receipt-count",
    exactness: "exact",
    source: "Stored accepted production search-execution receipts.",
  }),
});

/**
 * One receipt scan, two readings: the rolling windows the desk reports and the dated
 * aggregates the trend is kept in. The reconciliation between them is computed here rather
 * than trusted, so a stored day that no longer matches the receipts is visible as a row.
 */
async function readSearchUsageLineage(env, now) {
  const measuredSince = await resolveSearchMeasurementStart(env);
  const read = await readSearchUsageObservations(env, { now });
  const usage = read.ok
    ? foldSearchUsage(read.observations, { now, measuredSince, scan: read.scan })
    : unavailableSearchUsage(read.reason, now);
  const series = await readSearchUsageDailySeries(env, { now, measuredSince });
  const observed = read.ok ? foldSearchUsageDays(read.observations, { now, measuredSince }) : { days: {} };
  return {
    usage,
    daily: {
      population: SEARCH_USAGE_DAILY_POPULATION,
      population_version: SEARCH_USAGE_DAILY_POPULATION_VERSION,
      aggregate_retention_days: SEARCH_USAGE_DAILY_RETENTION_DAYS,
      measured_since: measuredSince,
      series,
      reconciliation: reconcileSearchUsageDaily({ storedSeries: series, observedDays: observed.days, now }),
    },
  };
}

/**
 * The durable page-view fallback is shaped by the same collector-surface list the intake
 * validator uses, so the KV breakdown and the Analytics Engine breakdown answer for the same
 * set of pages. A surface written under an older spelling is kept beside them rather than
 * dropped, because an older row is history.
 */
function completePageViewsBySurface(observed = {}) {
  const extras = Object.keys(observed)
    .filter((surface) => surface && !ANALYTICS_COLLECTOR_SURFACES.includes(surface))
    .sort();
  return Object.fromEntries(
    [...ANALYTICS_COLLECTOR_SURFACES, ...extras].map((surface) => [surface, observed[surface] || 0]),
  );
}

async function readFallbackActionOutcomes(env, now = new Date()) {
  if (!env?.ALERT_STATE) return {};
  const events = {
    opened: "action_opened",
    prompted: "outcome_prompted",
    dismissed: "outcome_dismissed",
    recorded: "outcome_recorded",
  };
  const entries = await Promise.all(Object.entries(events).flatMap(([label, event]) => [
    sumStat(env.ALERT_STATE, `usage_${event}`, 7, now).then((count) => [`${label}_last7d`, count]),
    sumStat(env.ALERT_STATE, `usage_${event}`, 30, now).then((count) => [`${label}_last30d`, count]),
  ]));
  return Object.fromEntries(entries);
}

async function readFallbackPageViews(env, now = new Date()) {
  if (!env?.ALERT_STATE) return null;
  const [last7d, last30d, bySurfaceRaw] = await Promise.all([
    sumStat(env.ALERT_STATE, "page_view", 7, now),
    sumStat(env.ALERT_STATE, "page_view", 30, now),
    readAllCategoryStatsWindow(env.ALERT_STATE, "page_view", 30, now),
  ]);
  return {
    last7d,
    last30d,
    bySurfaceLast30d: completePageViewsBySurface(bySurfaceRaw),
  };
}

/** Fold day histories into growth rows without inventing missing days. */
function growthFromHistories(nlHist = {}, digestHist = {}, pageViewHist = {}) {
  const days = new Set([
    ...Object.keys(nlHist || {}),
    ...Object.keys(digestHist || {}),
    ...Object.keys(pageViewHist || {}),
  ]);
  const byDay = {};
  for (const day of days) {
    byDay[day] = {
      page_views: Number(pageViewHist[day]) || 0,
      interactions: (Number(nlHist[day]) || 0) + (Number(digestHist[day]) || 0),
    };
  }
  return byDay;
}

/** Cache key for the public /stats edge snapshot (shared by handleStats + cron prewarm). */
export function statsEdgeCacheKey(baseUrl = "https://api.cityscroll.org") {
  // Versioned away from the former usage response so a deploy cannot serve private fields
  // from a warm pre-change cache entry.
  return new Request(new URL("/stats?edge=search-usage-v4", baseUrl).toString(), {
    method: "GET",
  });
}

/**
 * Write-ahead prewarm for public /stats. This primes the coverage projection after the daily
 * scheduled run; later cache expiries refresh it on demand. Called from daily cron.
 * Fail-soft: returns { warmed:false, reason } on missing caches API.
 */
export async function prewarmStats(env, options = {}) {
  const cache = typeof caches !== "undefined" ? caches.default : null;
  if (!cache) return { warmed: false, reason: "no_cache_api" };
  const baseUrl = options.baseUrl || "https://api.cityscroll.org";
  const req = new Request(new URL("/stats", baseUrl).toString(), { method: "GET" });
  // Force rebuild (skip cache hit) so cron always refreshes the snapshot.
  const res = await handleStats(req, env, null, {
    ...options,
    skipCacheRead: true,
  });
  if (!res || !res.ok) {
    return { warmed: false, status: res?.status || 0 };
  }
  const cacheKey = statsEdgeCacheKey(baseUrl);
  await cache.put(cacheKey, res.clone()).catch(() => {});
  return { warmed: true, status: res.status, bytes: Number(res.headers.get("content-length") || 0) };
}

export async function handleStats(req, env, ctx, options = {}) {
  if (req.method !== "GET") {
    return new Response("Method not allowed", { status: 405 });
  }

  const cache = typeof caches !== "undefined" ? caches.default : null;
  const cacheKey = statsEdgeCacheKey(req.url);
  if (cache && !options.skipCacheRead) {
    const hit = await cache.match(cacheKey).catch(() => null);
    if (hit) return hit;
  }

  const now = options.now == null ? new Date() : new Date(options.now);
  // One key read, never a receipt scan: the scheduled refresh already did that work.
  const searchUsage = options.searchUsage || await readPublicSearchUsage(env, { now });
  const body = buildPublicStatsBody(options.coverage || servedCoverage, now, searchUsage);
  const res = new Response(JSON.stringify(body, null, 2), {
    status: 200,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "public, max-age=900",
      "Access-Control-Allow-Origin": "*",
    },
  });
  if (cache) {
    const put = cache.put(cacheKey, res.clone());
    if (ctx && ctx.waitUntil) ctx.waitUntil(put); else await put.catch(() => {});
  }
  return res;
}

/** Build the former public operational response for the authenticated desk route. */
export async function handlePrivateStats(req, env, options = {}) {
  if (req.method !== "GET") {
    return new Response("Method not allowed", { status: 405 });
  }

  const now = options.now == null ? new Date() : new Date(options.now);
  const today = dayStr(now);

  const [
    active, sentToday, sent7d, clicksToday, clicks7d, feeds7d, batch7d, shares7d, nlToday,
    rawDigestsAllTime, digestsByCategory, rawNlAllTime, nlByCategory,
    digestHist, digestEra, nlHist, nlEra,
    nl7d, nlByCategory7d, watchesHist, watchesEra, usage,
    pageViewsFallback,
    actionOutcomesFallback,
    nl30d, nlByCategory30d, clicks30d, shares30d, alertsConfirmed7d, alertsConfirmed30d,
    digestLastRun,
    catchUpSentToday, catchUpAllTime, catchUpLastRun, laggingSubs,
    searchUsageLineage, rejectedEvents7d, rejectedEvents30d,
  ] = await Promise.all([
      countSubscriptionMetrics(env),
      readInt(env.ALERT_STATE, `sendcount:${today}`),
      sumSendCounts(env, now),
      sumStat(env.ALERT_STATE, "click", 1, now),
      sumStat(env.ALERT_STATE, "click", WINDOW_DAYS, now),
      sumStat(env.ALERT_STATE, "feed", WINDOW_DAYS, now),
      sumStat(env.ALERT_STATE, "batch", WINDOW_DAYS, now),
      sumStat(env.ALERT_STATE, "share", WINDOW_DAYS, now),
      readInt(env.NL_METER, `nl:${today}`),
      readStatAllTime(env.ALERT_STATE, "digest"),
      readAllCategoryStats(env.ALERT_STATE, "digest"),
      readStatAllTime(env.NL_METER, "nl_search"),
      readAllCategoryStats(env.NL_METER, "nl_search"),
      readHistSeries(env.ALERT_STATE, "digest"),
      readHistEra(env.ALERT_STATE, "digest"),
      readHistSeries(env.NL_METER, "nl_search"),
      readHistEra(env.NL_METER, "nl_search"),
      sumStat(env.NL_METER, "nl_search", WINDOW_DAYS, now),
      readAllCategoryStatsWindow(env.NL_METER, "nl_search", WINDOW_DAYS, now),
      readHistSeries(env.ALERT_STATE, "watches_active"),
      readHistEra(env.ALERT_STATE, "watches_active"),
      readUsageAnalytics(env, { fetchImpl: options.fetchImpl, now }),
      readFallbackPageViews(env, now),
      readFallbackActionOutcomes(env, now),
      sumStat(env.NL_METER, "nl_search", 30, now),
      readAllCategoryStatsWindow(env.NL_METER, "nl_search", 30, now),
      sumStat(env.ALERT_STATE, "click", 30, now),
      sumStat(env.ALERT_STATE, "share", 30, now),
      sumStat(env.ALERT_STATE, "alert_confirmed", WINDOW_DAYS, now),
      sumStat(env.ALERT_STATE, "alert_confirmed", 30, now),
      readDigestRunReceipt(env),
      sumStat(env.ALERT_STATE, "digest_catchup", 1, now),
      readStatAllTime(env.ALERT_STATE, "digest_catchup"),
      readCatchUpReceipt(env),
      countLaggingSubs(env, 2, now),
      // Same measurement start the public projection uses, so the two surfaces can be
      // reconciled against each other at one cutoff instead of two.
      readSearchUsageLineage(env, now),
      sumStat(env.ALERT_STATE, REJECTED_EVENT_METRIC, WINDOW_DAYS, now),
      sumStat(env.ALERT_STATE, REJECTED_EVENT_METRIC, 30, now),
    ]);

  // Store continuity: same ALERT_STATE / NL_METER namespaces used before and after the
  // cityscroll.org canonical flip. Analytics Engine may be empty or unreadable
  // (not-configured); never let the private desk totals restart at zero while these stores
  // still hold pre-flip history.
  const usageReconciled = reconcileUsageWithDurableStores(usage, {
    pageViewsLast7d: pageViewsFallback?.last7d || 0,
    pageViewsLast30d: pageViewsFallback?.last30d || 0,
    pageViewsBySurfaceLast30d: pageViewsFallback?.bySurfaceLast30d || {},
    searchesLast7d: nl7d,
    searchesLast30d: nl30d,
    searchesByLensLast7d: nlByCategory7d,
    searchesByLensLast30d: nlByCategory30d,
    deepLinksLast7d: clicks7d,
    deepLinksLast30d: clicks30d,
    sharesLast7d: shares7d,
    sharesLast30d: shares30d,
    alertsConfirmedLast7d: alertsConfirmed7d,
    alertsConfirmedLast30d: alertsConfirmed30d,
    actionOutcomes: actionOutcomesFallback,
    growthByDay: growthFromHistories(nlHist, digestHist),
  }, { measuredSince: env?.ANALYTICS_MEASURED_SINCE || usage?.measured_since || null });
  // Replace rather than Object.assign: reconciliation may delete unavailable_reason.
  const usageForOperations = usageReconciled;

  // w12-14: the live all-time accumulators only count sends/searches from the moment they
  // shipped (digestEra/nlEra) forward. Recovered pre-era days (backfilled from an older,
  // short-lived source counter — see worker/scripts/backfill-history.mjs) are folded in here
  // so "all time" means everything we can honestly account for, not just the counter's own
  // lifetime. See history.*.live_from below for the boundary the UI should disclose.
  const digestsAllTime = mergeRecoveredAllTime(rawDigestsAllTime, digestHist, digestEra);
  const nlAllTime = mergeRecoveredAllTime(rawNlAllTime, nlHist, nlEra);

  const body = {
    generated: now.toISOString(),
    window_days: WINDOW_DAYS,
    note: "Aggregate counts only, grouped by day and category. Feed/batch counts are as observed at the origin (edge cache hits are not counted).",
    subscriptions: { active: active.active, accounts: active.accounts },
    digests: {
      sent_today: sentToday,
      sent_last7d: sent7d,
      sent_all_time: digestsAllTime,
      by_category: digestsByCategory,
      // Durable cron receipt: timestamp, matched, sent, skipped_reason. A silent skip must
      // leave an explicit reason so sent_today=0 is never unexplained.
      last_run: digestLastRun || null,
      // Watermark recovery: catch-up digests are tracked separately so recovery volume is
      // honest and does not inflate the normal daily-send trend.
      catch_up_sent_today: catchUpSentToday,
      catch_up_sent_all_time: catchUpAllTime,
      catch_up_last_run: catchUpLastRun || null,
      // Subs whose delivery watermark lags >= 2 days — a recovery candidate count, no PII.
      lagging_subs: laggingSubs,
    },
    digest_clicks: { today: clicksToday, last7d: clicks7d },
    feeds: { fetches_last7d: feeds7d },
    batch: { calls_last7d: batch7d },
    shared_investigations: { created_last7d: shares7d },
    nl_search: {
      calls_today: nlToday, calls_last7d: nl7d, calls_all_time: nlAllTime,
      by_category: completeLensCounts(nlByCategory),
      by_category_last7d: completeLensCounts(nlByCategory7d),
    },
    history: {
      note: "Daily totals. Days before the recovered/live split were rebuilt from short-term logs that were already being kept for other reasons; days on or after it were counted as they happened.",
      digests: { by_day: digestHist, live_from: digestEra },
      nl_search: { by_day: nlHist, live_from: nlEra },
      watches_active: { by_day: watchesHist, live_from: watchesEra },
    },
    usage: usageForOperations,
    // Additive. Completed searches come from accepted execution receipts and
    // are reported beside — never folded into — the input counters above, which answer
    // a different question. Every field before this one keeps its meaning.
    search_executions: searchUsageLineage.usage,
    measurement_basis: MEASUREMENT_BASIS,
    // The dated lineage behind the published summary: which days were folded, whether the
    // stored days still match the receipts, and which days are gaps rather than zeroes.
    search_usage_lineage: searchUsageLineage.daily,
    // Submissions the taxonomy refused, counted and nothing else. A rising number means a
    // producer is naming a dimension nobody registered.
    measurement_diagnostics: {
      note: "Refused submissions are counted, never measured. Production traffic only.",
      rejected_events_last7d: rejectedEvents7d,
      rejected_events_last30d: rejectedEvents30d,
      analytics_retention_days: ANALYTICS_RETENTION_DAYS,
    },
  };

  const res = new Response(JSON.stringify(body, null, 2), {
    status: 200,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "private, no-store",
    },
  });
  return res;
}

// Count confirmed subscriptions and the distinct accounts behind them. Values are read only
// inside this aggregate operation; neither addresses nor subscription records leave the worker.
export async function countSubscriptionMetrics(env) {
  if (!env?.SUBS) return { active: 0, accounts: 0 };
  let active = 0;
  const accounts = new Set();
  let cursor = undefined;
  try {
    do {
      const res = await env.SUBS.list({ prefix: "sub:", cursor });
      for (const key of res.keys || []) {
        try {
          const raw = await env.SUBS.get(key.name);
          const sub = raw ? JSON.parse(raw) : null;
          if (!sub || sub.paused || isTestSubscriber(sub)) continue;
          const email = typeof sub.email === "string" ? sub.email.trim().toLowerCase() : "";
          if (!email) continue;
          active++;
          accounts.add(email);
        } catch { /* malformed records do not become confident operational counts */ }
      }
      cursor = res.list_complete ? null : res.cursor;
    } while (cursor);
  } catch { /* partial count beats a 500 */ }
  return { active, accounts: accounts.size };
}

// Exported so the cron job can snapshot this same gauge daily (see worker.mjs's scheduled()
// + lib/stats.mjs's snapshotHistDay).
export async function countActiveSubs(env) {
  return (await countSubscriptionMetrics(env)).active;
}

async function readInt(kv, key) {
  if (!kv) return 0;
  try { return parseInt((await kv.get(key)) || "0", 10) || 0; } catch { return 0; }
}

// sendcount:<day> keys (written by the alerts cron) summed over the window.
async function sumSendCounts(env, now) {
  let total = 0;
  for (let i = 0; i < WINDOW_DAYS; i++) {
    const day = dayStr(new Date(now.getTime() - i * 86400000));
    total += await readInt(env.ALERT_STATE, `sendcount:${day}`);
  }
  return total;
}
