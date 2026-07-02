// /usage — read-only JSON report of crol-worker's Anthropic (Claude Haiku) spend, for an
// external caller (James's daily briefing) to fetch. Reads the NL_METER KV day-counters
// that /nl increments; it never writes and never calls the model.
//
// Auth: a shared secret in the USAGE_KEY secret binding (set via `wrangler secret put USAGE_KEY`).
//   - Present it as  ?key=<SECRET>,  `Authorization: Bearer <SECRET>`,  or  `X-Usage-Key: <SECRET>`.
//   - Missing/wrong → 401.
//   - USAGE_KEY unset on the worker → 404 (fail closed: the endpoint is inert until James sets it).
//
// Defensive: any KV error → zeros + { degraded: true }, never throws.

import { lastNDays, meterKey, buildUsageBody } from "./lib/usage.mjs";

const ALLOW = new Set([
  "https://crol-list.org",
  "https://www.crol-list.org",
  "https://crol-list.jimdc.com",
  "https://jimdc.github.io",
  "http://localhost:8888",
  "http://localhost:8000",
  "http://localhost:8787", // wrangler dev
]);

export async function handleUsage(req, env) {
  const origin = req.headers.get("origin") || "";
  const cors = corsHeaders(origin);

  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });

  // Fail closed: with no secret configured the endpoint doesn't exist.
  const secret = env.USAGE_KEY;
  if (!secret) return json({ error: "not found" }, 404, cors);

  if (req.method !== "GET") return json({ error: "GET only" }, 405, cors);
  if (presentedKey(req) !== secret) return json({ error: "unauthorized" }, 401, cors);

  const now = new Date();

  // Read NL_METER for today + the trailing 7 days. Any failure → degraded zeros, never throw.
  try {
    const store = env.NL_METER;
    if (!store) {
      return json(buildUsageBody({ todayCalls: 0, last7dCalls: 0, now, degraded: true }), 200, cors);
    }
    const days = lastNDays(now, 7); // [today, …, 6 days ago]
    const raw = await Promise.all(days.map((d) => store.get(meterKey(d))));
    const counts = raw.map((c) => parseInt(c || "0", 10) || 0);
    const todayCalls = counts[0];
    const last7dCalls = counts.reduce((a, b) => a + b, 0);
    return json(buildUsageBody({ todayCalls, last7dCalls, now }), 200, cors);
  } catch {
    return json(buildUsageBody({ todayCalls: 0, last7dCalls: 0, now, degraded: true }), 200, cors);
  }
}

// The presented secret, from ?key=, Authorization: Bearer, or X-Usage-Key (first found).
function presentedKey(req) {
  const q = new URL(req.url).searchParams.get("key");
  if (q) return q;
  const m = /^Bearer\s+(.+)$/i.exec(req.headers.get("authorization") || "");
  if (m) return m[1].trim();
  return req.headers.get("x-usage-key") || "";
}

function corsHeaders(origin) {
  const o = ALLOW.has(origin) ? origin : "https://crol-list.jimdc.com";
  return {
    "Access-Control-Allow-Origin": o,
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Usage-Key",
    "Vary": "Origin",
  };
}

function json(obj, status, cors) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { ...cors, "Content-Type": "application/json" },
  });
}
