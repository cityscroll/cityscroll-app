// GET /feed.xml | /feed.json | /feed.ics — any saved search as a standing feed.
// Query params: lens=money|people|land|property|rules|meetings, q=<keywords>, agency=<name>, min=<amount>.
// Reuses the exact compileSub() queries the alerts cron replays, so a feed shows the same
// items a digest would. No paid key anywhere near this path; results are edge-cached 15 min,
// so repeated pulls of a popular feed cost one SODA query per window.

import { sanitize } from "./lib/filter.mjs";
import { compileSub, rowsForCompiledQuery } from "./lib/compile.mjs";
import { bumpStat } from "./lib/stats.mjs";
import { emitUsageEvent } from "./lib/analytics.mjs";
import { describeFilter } from "./lib/confirm_email.mjs";
import {
  parseFeedQuery,
  unsupportedModernFeedFilterFields,
  feedItems,
  atomFeed,
  jsonFeed,
  icsFeed,
} from "./lib/feed.mjs";
import { calendarOccurrencesForRows } from "../../site/calendar_occurrence.mjs";
import { zoningHearingCalendarOccurrence } from "../../site/zoning_hearing_calendar.mjs";

const FEED_LENSES = new Set(["money", "people", "land", "property", "rules", "meetings", "entity"]);
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

  const parsed = parseFeedQuery(url.searchParams);
  const { lens, filter } = parsed;
  if (!FEED_LENSES.has(lens)) return plain(`unknown lens '${lens}' — use money|people|land|property|rules|meetings`, 400);
  if (parsed.error) return plain("invalid modern feed filter", 400);
  if (parsed.modern) {
    const unsupported = unsupportedModernFeedFilterFields(lens, filter);
    if (unsupported.length) return plain(`modern feed filter cannot be replayed: ${unsupported.join(", ")}`, 400);
  }

  const sub = { lens, filter: sanitize(lens, filter) };
  const q = compileSub(sub, new Date().toISOString().slice(0, 10));
  if (!q) return plain("lens not feedable", 400);

  // Outcome counter (R·B): feeds served from the origin, per day — aggregate only. Edge cache
  // hits never reach here, so this undercounts; that is the honest, documented behavior.
  const bumped = bumpStat(env.ALERT_STATE, "feed", new Date());
  emitUsageEvent(env, {
    event: "feed_fetch",
    detail: url.pathname.endsWith(".xml") ? "atom" : url.pathname.endsWith(".json") ? "json" : "ics",
    surface: "api",
  });
  if (ctx && ctx.waitUntil) ctx.waitUntil(bumped);

  let rows;
  try {
    rows = await rowsForCompiledQuery(q, env);
    if (q.postFilter) rows = rows.filter(q.postFilter);
  } catch {
    return plain("upstream data source unavailable — retry shortly", 502);
  }

  const title = `CityScroll — ${describeFilter(lens, sub.filter)}`;
  const items = feedItems(q.kind, rows);
  const occurrences = q.kind === "project-calendar"
    ? rows
    : q.kind === "land-hearings"
    ? rows.map((row) => zoningHearingCalendarOccurrence(row, {
      scope_ref: sub.filter.councilDistrict
        ? `council-district:${sub.filter.councilDistrict}`
        : sub.filter.communityDistrict
          ? `community-district:${sub.filter.communityDistrict}`
          : "land:hearings",
    })).filter(Boolean)
    : calendarOccurrencesForRows(rows, {
      kind: q.kind,
      legacy_uid: true,
      // Feed rows already satisfy the query's temporal bounds. The producer
      // still chooses only semantic civic dates, never publication timestamps.
      as_of: "0000-01-01",
    });
  const siteUrl = "https://cityscroll.org/";
  const updated = new Date().toISOString();

  let body;
  if (url.pathname === "/feed.xml") body = atomFeed({ title, selfUrl: url.toString(), siteUrl, updated, items });
  else if (url.pathname === "/feed.json") body = jsonFeed({ title, selfUrl: url.toString(), siteUrl, items });
  else body = icsFeed({ title, occurrences });

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
