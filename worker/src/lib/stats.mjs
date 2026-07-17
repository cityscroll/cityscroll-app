// Pure + KV-thin helpers for the public /stats endpoint and the count-only /r redirect.
//
// Design (round three, R·B): CROL-List measures OUTCOMES, not people. Every counter here is a
// plain per-day integer under `stats:<metric>:<YYYY-MM-DD>` in ALERT_STATE — no IPs, no IDs, no
// per-recipient anything. KV read-modify-write is eventually consistent, so concurrent bumps can
// under-count slightly; these are trend numbers, not billing. Day keys self-expire.

export const STATS_TTL = 40 * 24 * 3600; // 40 days — enough for a 30-day window with slack

// UTC YYYY-MM-DD, matching the `nl:<day>` / `sendcount:<day>` convention elsewhere.
export function dayStr(d) {
  return d.toISOString().slice(0, 10);
}

export function statsKey(metric, day) {
  return `stats:${metric}:${day}`;
}

// The last n UTC day strings, today first.
export function lastNDays(n, now) {
  const out = [];
  for (let i = 0; i < n; i++) out.push(dayStr(new Date(now.getTime() - i * 86400000)));
  return out;
}

// Parse a /r/<kind>/<id> path. kind is one of our watch/lens kinds (lowercase slug); id is a City
// Record request id (digits + letters + dashes). Anything else → null. The redirect TARGET is
// always built by us (crol-list.org/#notice/<id>) — the path never carries a URL, so /r cannot be
// an open redirect.
export function parseRedirect(pathname) {
  const m = /^\/r\/([a-z][a-z0-9-]{0,23})\/([A-Za-z0-9][A-Za-z0-9-]{0,39})$/.exec(pathname);
  if (!m) return null;
  return { kind: m[1], id: m[2] };
}

// w (w12-12): the originating watch's filter, already encoded by encodeWatchFilter()
// (lib/filter.mjs) — an opaque, already-percent-safe string the redirect just re-embeds after
// the id, same "?tab=" idiom the site's own agencyHref()/vendorHref() use for a second hash
// segment. Re-encoded here (not passed through raw) since the caller may have decoded it via
// URLSearchParams on the way in.
export function noticeUrl(id, w) {
  const base = `https://crol-list.org/#notice/${encodeURIComponent(id)}`;
  return w ? `${base}?w=${encodeURIComponent(w)}` : base;
}

// Defense in depth for the redirect: only forward a `w` value that looks like what
// encodeWatchFilter() produces (bounded length, URL-component-safe characters) — the site's own
// client-side parseWatchParam() is what actually validates the JSON shape, but the redirect
// should never blindly relay an oversized or garbled query value into a Location header.
const WATCH_PARAM_MAX = 2000;
export function validWatchParam(w) {
  return typeof w === "string" && w.length > 0 && w.length <= WATCH_PARAM_MAX && /^[\x20-\x7e]+$/.test(w) ? w : null;
}

// Bump one per-day counter. Fire-and-forget safe: swallows KV errors (a lost count must never
// break a redirect or a feed response).
export async function bumpStat(kv, metric, now) {
  if (!kv) return;
  try {
    const key = statsKey(metric, dayStr(now));
    const cur = parseInt((await kv.get(key)) || "0", 10) || 0;
    await kv.put(key, String(cur + 1), { expirationTtl: STATS_TTL });
  } catch { /* counting is best-effort */ }
}

// Sum a metric over the last n days (today inclusive).
export async function sumStat(kv, metric, days, now) {
  if (!kv) return 0;
  let total = 0;
  for (const day of lastNDays(days, now)) {
    try { total += parseInt((await kv.get(statsKey(metric, day))) || "0", 10) || 0; } catch { /* skip */ }
  }
  return total;
}

// ---- all-time + category counters (additive to the 7-day rolling ones above) -------------
//
// Same per-metric counting model, but one cumulative key with no expiry instead of a day
// key, so /stats can also publish "since launch" totals. Category counters break a metric
// out by City Record `section_name` (falling back to the watch's lens for sections that
// don't carry one, e.g. land/ZAP) — discovered dynamically via a KV prefix list, so no
// fixed category list needs to be maintained here.

export function allTimeKey(metric) {
  return `stats:alltime:${metric}`;
}

export function categoryKey(metric, category) {
  return `stats:cat:${metric}:${category}`;
}

export async function bumpStatAllTime(kv, metric) {
  if (!kv) return;
  try {
    const key = allTimeKey(metric);
    const cur = parseInt((await kv.get(key)) || "0", 10) || 0;
    await kv.put(key, String(cur + 1));
  } catch { /* counting is best-effort */ }
}

export async function bumpCategoryStat(kv, metric, category) {
  if (!kv || !category) return;
  try {
    const key = categoryKey(metric, category);
    const cur = parseInt((await kv.get(key)) || "0", 10) || 0;
    await kv.put(key, String(cur + 1));
  } catch { /* counting is best-effort */ }
}

export async function readStatAllTime(kv, metric) {
  if (!kv) return 0;
  try { return parseInt((await kv.get(allTimeKey(metric))) || "0", 10) || 0; } catch { return 0; }
}

// Fold recovered pre-era daily history into the live all-time accumulator. bumpStatAllTime
// only counts sends from the moment it shipped forward — but hist:<metric>:<day> may hold
// real days recovered from an older, short-lived source counter (see
// worker/scripts/backfill-history.mjs) for the period *before* that. Those recovered days are
// genuinely known-good counts, not estimates, so folding them in gives the true all-time total
// as far back as we have any trustworthy record of — not just "since this counter shipped."
// Pure and free: callers already fetch histSeries for the "over time" chart, so this costs no
// extra KV reads. Days on/after eraDay are excluded — they're the live accumulator's own
// territory already, and double-counting them would inflate the total.
export function mergeRecoveredAllTime(liveTotal, histSeries, eraDay) {
  if (!eraDay) return liveTotal; // no known boundary → nothing safe to add
  let recovered = 0;
  for (const [day, n] of Object.entries(histSeries || {})) {
    if (day < eraDay) recovered += n;
  }
  return liveTotal + recovered;
}

// ---- day+category counters (windowed breakdowns, e.g. "searches by lens, last 7 days") --
//
// stats:cat:<metric>:<category> above is all-time only, with no day dimension — fine for a
// "since we started counting" table, but a rolling-window breakdown (e.g. the last 7 days)
// needs per-day-per-category counts. Same 40-day TTL as the plain per-day counters above,
// since it serves the same kind of rolling window.

export function categoryDayKey(metric, category, day) {
  return `stats:catday:${metric}:${category}:${day}`;
}

export async function bumpCategoryDayStat(kv, metric, category, now) {
  if (!kv || !category) return;
  try {
    const key = categoryDayKey(metric, category, dayStr(now));
    const cur = parseInt((await kv.get(key)) || "0", 10) || 0;
    await kv.put(key, String(cur + 1), { expirationTtl: STATS_TTL });
  } catch { /* counting is best-effort */ }
}

// Every category's count summed over the last n days, discovered dynamically via a KV
// prefix list (same "partial beats a 500" posture as readAllCategoryStats).
export async function readAllCategoryStatsWindow(kv, metric, days, now) {
  const out = {};
  if (!kv) return out;
  const validDays = new Set(lastNDays(days, now));
  const prefix = `stats:catday:${metric}:`;
  try {
    let cursor;
    do {
      const res = await kv.list({ prefix, cursor });
      for (const k of res.keys) {
        const rest = k.name.slice(prefix.length); // "<category>:<day>"
        const day = rest.slice(-10);
        const category = rest.slice(0, -11); // strip ":<day>" (1 colon + 10 chars)
        if (!validDays.has(day)) continue;
        const n = parseInt((await kv.get(k.name)) || "0", 10) || 0;
        out[category] = (out[category] || 0) + n;
      }
      cursor = res.list_complete ? null : res.cursor;
    } while (cursor);
  } catch { /* partial beats a 500 */ }
  return out;
}

// All categories seen for a metric, as { category: count }. A partial result (fewer
// categories than actually exist) beats a 500 if the KV list call fails partway.
export async function readAllCategoryStats(kv, metric) {
  const out = {};
  if (!kv) return out;
  const prefix = `stats:cat:${metric}:`;
  try {
    let cursor;
    do {
      const res = await kv.list({ prefix, cursor });
      for (const k of res.keys) {
        const category = k.name.slice(prefix.length);
        out[category] = parseInt((await kv.get(k.name)) || "0", 10) || 0;
      }
      cursor = res.list_complete ? null : res.cursor;
    } while (cursor);
  } catch { /* partial beats a 500 */ }
  return out;
}

// ---- permanent daily history (additive to the 40-day-TTL rolling counters above) --------
//
// `stats:<metric>:<day>` above self-expires after 40 days — fine for the 7-day window /stats
// was built to serve, but the "over time" chart needs day-level counts that outlive that. A
// `hist:<metric>:<day>` key never expires and is bumped at the same call sites as
// bumpStatAllTime, so it's exactly the same event stream, just also kept per day forever.
// A one-time backfill (worker/scripts/backfill-history.mjs) seeded the days that were still
// recoverable from the short-lived counters when this shipped; `hist:era:<metric>` records
// the first day counted this way (the boundary between recovered and continuously-counted
// history) so the UI can say so honestly instead of implying every number was always live.

export function histDayKey(metric, day) {
  return `hist:${metric}:${day}`;
}

export function histEraKey(metric) {
  return `hist:era:${metric}`;
}

export async function bumpHistDay(kv, metric, now) {
  if (!kv) return;
  try {
    const key = histDayKey(metric, dayStr(now));
    const cur = parseInt((await kv.get(key)) || "0", 10) || 0;
    await kv.put(key, String(cur + 1)); // no TTL — permanent
  } catch { /* counting is best-effort */ }
}

// Every recorded hist:<metric>:<day> count, as { day: count }. Discovered via KV list, so
// coverage grows on its own as more days accrue — nothing here assumes a fixed start date.
export async function readHistSeries(kv, metric) {
  const out = {};
  if (!kv) return out;
  const prefix = `hist:${metric}:`;
  try {
    let cursor;
    do {
      const res = await kv.list({ prefix, cursor });
      for (const k of res.keys) {
        const day = k.name.slice(prefix.length);
        out[day] = parseInt((await kv.get(k.name)) || "0", 10) || 0;
      }
      cursor = res.list_complete ? null : res.cursor;
    } while (cursor);
  } catch { /* partial beats a 500 */ }
  return out;
}

export async function readHistEra(kv, metric) {
  if (!kv) return null;
  try { return (await kv.get(histEraKey(metric))) || null; } catch { return null; }
}

// ---- daily gauge snapshots (a hist:<metric>:<day> variant for values that aren't events) --
//
// bumpHistDay counts EVENTS (one call = one real thing that happened). Some numbers worth
// charting aren't events at all — "active watches" is a live gauge (a KV list count at read
// time), not something with a discrete moment to bump on. snapshotHistDay writes that day's
// gauge reading directly (not an increment) into the same hist:<metric>:<day> key shape, so
// it reuses readHistSeries/renderHistory for free. Meant to be called once per day from the
// cron job — calling it twice the same day just overwrites with the latest reading, which is
// fine (idempotent, and the gauge can only have one true value "as of today" anyway).
export async function snapshotHistDay(kv, metric, now, value) {
  if (!kv) return;
  try {
    await kv.put(histDayKey(metric, dayStr(now)), String(value)); // no TTL — permanent
  } catch { /* counting is best-effort */ }
}

// Sets hist:era:<metric> to today, but only if it isn't already set — so a metric that has
// no manual backfill script (like the gauge snapshots above) still gets an honest "counted
// from here on" boundary the first time it's ever written, with no risk of overwriting a
// pre-existing era set by an actual backfill (see worker/scripts/backfill-history.mjs).
export async function ensureHistEra(kv, metric, now) {
  if (!kv) return;
  try {
    const key = histEraKey(metric);
    if ((await kv.get(key)) == null) await kv.put(key, dayStr(now));
  } catch { /* best-effort */ }
}
