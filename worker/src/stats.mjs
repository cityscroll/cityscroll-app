// GET /stats — the public outcome counters (round three, R·B tier 2).
//
// "Open by default, closed by exception" applied to our own operations: a transparency tool
// should publish its own usage. Everything here is an aggregate count — active subscriptions
// (a number, not a list), digests sent, digest links followed, feed/batch/share activity, NL
// calls against the daily ceiling. No personal data is read, stored, or returned.
//
// Edge-cached 15 minutes (same pattern as /feed.*): the SUBS list scan is the only real work.

import { dayStr, sumStat, readStatAllTime, readAllCategoryStats, readHistSeries, readHistEra } from "./lib/stats.mjs";

const WINDOW_DAYS = 7;

export async function handleStats(req, env, ctx) {
  if (req.method !== "GET") {
    return new Response("Method not allowed", { status: 405 });
  }

  const cache = typeof caches !== "undefined" ? caches.default : null;
  const cacheKey = new Request(new URL("/stats", req.url).toString(), { method: "GET" });
  if (cache) {
    const hit = await cache.match(cacheKey).catch(() => null);
    if (hit) return hit;
  }

  const now = new Date();
  const today = dayStr(now);

  const [
    active, sentToday, sent7d, clicksToday, clicks7d, feeds7d, batch7d, shares7d, nlToday,
    digestsAllTime, digestsByCategory, nlAllTime, nlByCategory,
    digestHist, digestEra, nlHist, nlEra,
  ] = await Promise.all([
      countActiveSubs(env),
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
    ]);

  const body = {
    generated: now.toISOString(),
    window_days: WINDOW_DAYS,
    note: "Aggregate counts only — CROL-List has no accounts, no cookies, and tracks no individuals. Feed/batch counts are as observed at the origin (edge cache hits are not counted).",
    subscriptions: { active },
    digests: { sent_today: sentToday, sent_last7d: sent7d, sent_all_time: digestsAllTime, by_category: digestsByCategory },
    digest_clicks: { today: clicksToday, last7d: clicks7d },
    feeds: { fetches_last7d: feeds7d },
    batch: { calls_last7d: batch7d },
    shared_investigations: { created_last7d: shares7d },
    nl_search: { calls_today: nlToday, calls_all_time: nlAllTime, by_category: nlByCategory },
    history: {
      note: "Daily totals. Days before the recovered/live split were rebuilt from short-term logs that were already being kept for other reasons; days on or after it were counted as they happened.",
      digests: { by_day: digestHist, live_from: digestEra },
      nl_search: { by_day: nlHist, live_from: nlEra },
    },
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

// Count confirmed subscriptions — a cursor walk that never reads the values, so no addresses
// pass through here.
async function countActiveSubs(env) {
  if (!env.SUBS) return 0;
  let n = 0, cursor = undefined;
  try {
    do {
      const res = await env.SUBS.list({ prefix: "sub:", cursor });
      n += res.keys.length;
      cursor = res.list_complete ? null : res.cursor;
    } while (cursor);
  } catch { /* partial count beats a 500 */ }
  return n;
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
