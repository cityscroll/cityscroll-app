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
