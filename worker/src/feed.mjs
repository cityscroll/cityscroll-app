// GET /feed.xml | /feed.json | /feed.ics — any saved search as a standing feed.
// Query params: lens=money|land|property|rules|meetings, q=<keywords>, agency=<name>, min=<amount>.
// Reuses the exact compileSub() queries the alerts cron replays, so a feed shows the same
// items a digest would. No paid key anywhere near this path; results are edge-cached 15 min,
// so repeated pulls of a popular feed cost one SODA query per window.

import { sanitize } from "./lib/filter.mjs";
import { compileSub } from "./lib/compile.mjs";
import { bumpStat } from "./lib/stats.mjs";
import { describeFilter } from "./lib/confirm_email.mjs";
import { parseFeedQuery, feedItems, atomFeed, jsonFeed, icsFeed } from "./lib/feed.mjs";

const FEED_LENSES = new Set(["money", "land", "property", "rules", "meetings", "entity"]);
const TYPES = {
  "/feed.xml": "application/atom+xml; charset=utf-8",
  "/feed.json": "application/feed+json; charset=utf-8",
  "/feed.ics": "text/calendar; charset=utf-8",
};

export async function handleFeed(request, env, ctx) {
  if (request.method !== "GET") return plain("method not allowed", 405);
  const url = new URL(request.url);

  const cache = typeof caches !== "undefined" ? caches.default : null;
  if (cache) {
    const hit = await cache.match(request);
    if (hit) return hit;
  }

  const { lens, filter } = parseFeedQuery(url.searchParams);
  if (!FEED_LENSES.has(lens)) return plain(`unknown lens '${lens}' — use money|land|property|rules|meetings`, 400);

  const sub = { lens, filter: sanitize(lens, filter) };
  const q = compileSub(sub, new Date().toISOString().slice(0, 10));
  if (!q) return plain("lens not feedable", 400);

  // Outcome counter (R·B): feeds served from the origin, per day — aggregate only. Edge cache
  // hits never reach here, so this undercounts; that is the honest, documented behavior.
  const bumped = bumpStat(env.ALERT_STATE, "feed", new Date());
  if (ctx && ctx.waitUntil) ctx.waitUntil(bumped);

  let rows;
  try {
    const r = await fetch(`${q.url}?${new URLSearchParams(q.params).toString()}`);
    if (!r.ok) throw new Error(`open-data ${r.status}`);
    rows = await r.json();
    if (q.postFilter) rows = rows.filter(q.postFilter);
  } catch {
    return plain("upstream data source unavailable — retry shortly", 502);
  }

  const title = `CROL-List — ${describeFilter(lens, sub.filter)}`;
  const items = feedItems(q.kind, rows);
  const siteUrl = "https://crol-list.org/";
  const updated = new Date().toISOString();

  let body;
  if (url.pathname === "/feed.xml") body = atomFeed({ title, selfUrl: url.toString(), siteUrl, updated, items });
  else if (url.pathname === "/feed.json") body = jsonFeed({ title, selfUrl: url.toString(), siteUrl, items });
  else body = icsFeed({ title, items });

  const res = new Response(body, {
    status: 200,
    headers: {
      "Content-Type": TYPES[url.pathname],
      "Cache-Control": "public, max-age=900",
      "Access-Control-Allow-Origin": "*",
    },
  });
  if (cache) {
    const put = cache.put(request, res.clone());
    if (ctx && ctx.waitUntil) ctx.waitUntil(put); else await put.catch(() => {});
  }
  return res;
}

function plain(msg, status) {
  return new Response(msg, { status, headers: { "Content-Type": "text/plain", "Access-Control-Allow-Origin": "*" } });
}
