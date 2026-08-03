// GET /stats — the public outcome counters (round three, R·B tier 2).
//
// "Open by default, closed by exception" applied to our own operations: a transparency tool
// should publish its own usage. Everything here is an aggregate count — active subscriptions
// (a number, not a list), digests sent, digest links followed, feed/batch/share activity, NL
// calls against the daily ceiling. No personal data is read, stored, or returned.
//
// Edge-cached 15 minutes (same pattern as /feed.*): the SUBS list scan is the only real work.

import {
  dayStr, sumStat, readStatAllTime, readAllCategoryStats, readAllCategoryStatsWindow,
  readHistSeries, readHistEra, mergeRecoveredAllTime,
} from "./lib/stats.mjs";
import {
  completeLensCounts,
  readUsageAnalytics,
  reconcileUsageWithDurableStores,
} from "./lib/analytics.mjs";

// Same key as alerts.mjs DIGEST_RUN_LATEST_KEY — kept local so /stats does not import the
// full alerts module (cron + Resend path) on every public read.
const DIGEST_RUN_LATEST_KEY = "digest:run:latest";
const CATCHUP_RUN_LATEST_KEY = "digest:catchup:run:latest";

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
const PAGE_VIEW_SURFACES = Object.freeze([
  "home",
  "stats",
  "about",
  "data",
  "api",
  "changelog",
  "standards",
]);

function completePageViewsBySurface(observed = {}) {
  return Object.fromEntries(PAGE_VIEW_SURFACES.map((surface) => [surface, observed[surface] || 0]));
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

export async function handleStats(req, env, ctx, options = {}) {
  if (req.method !== "GET") {
    return new Response("Method not allowed", { status: 405 });
  }

  const cache = typeof caches !== "undefined" ? caches.default : null;
  // Version the cache key when the usage reconciliation shape changes so a deploy cannot
  // keep serving a pre-flip empty usage block for the full max-age window.
  const cacheKey = new Request(new URL("/stats?edge=watch-account-v1", req.url).toString(), {
    method: "GET",
  });
  if (cache) {
    const hit = await cache.match(cacheKey).catch(() => null);
    if (hit) return hit;
  }

  const now = options.now == null ? new Date() : new Date(options.now);
  const today = dayStr(now);

  const [
    active, sentToday, sent7d, clicksToday, clicks7d, feeds7d, batch7d, shares7d, nlToday,
    rawDigestsAllTime, digestsByCategory, rawNlAllTime, nlByCategory,
    digestHist, digestEra, nlHist, nlEra,
    nl7d, nlByCategory7d, watchesHist, watchesEra, usage,
    pageViewsFallback,
    nl30d, nlByCategory30d, clicks30d, shares30d, alertsConfirmed7d, alertsConfirmed30d,
    digestLastRun,
    catchUpSentToday, catchUpAllTime, catchUpLastRun, laggingSubs,
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
    ]);

  // Store continuity: same ALERT_STATE / NL_METER namespaces used before and after the
  // cityscroll.org canonical flip. Analytics Engine may be empty or unreadable
  // (not-configured); never let the Site totals panel restart at zero while these stores
  // still hold pre-flip history. Documented latency for a fresh event is the 15-minute
  // edge cache below.
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
    growthByDay: growthFromHistories(nlHist, digestHist),
  }, { measuredSince: env?.ANALYTICS_MEASURED_SINCE || usage?.measured_since || null });
  // Replace rather than Object.assign: reconciliation may delete unavailable_reason.
  const usagePublic = usageReconciled;

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
    usage: usagePublic,
  };

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
          if (!sub || sub.paused) continue;
          const email = typeof sub.email === "string" ? sub.email.trim().toLowerCase() : "";
          if (!email) continue;
          active++;
          accounts.add(email);
        } catch { /* malformed records do not become confident public counts */ }
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
