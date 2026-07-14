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

export function noticeUrl(id) {
  return `https://crol-list.org/#notice/${encodeURIComponent(id)}`;
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
