// POST /inv + GET /inv/<id> — share an investigation (pin list) as a read-only link.
// The snapshot is structured, clamped, byte-capped (lib/inv.mjs), TTL'd, and rate-limited,
// so this can't become arbitrary file hosting. Stored in the SUBS KV under the inv: prefix.

import { validInvPayload, INV_TTL } from "./lib/inv.mjs";
import { bumpStat } from "./lib/stats.mjs";

const MAX_SHARES_PER_IP_DAY = 10;

const ALLOW = new Set([
  "https://crol-list.org", "https://www.crol-list.org",
  "https://crol-list.jimdc.com", "https://jimdc.github.io",
  "http://localhost:8000", "http://localhost:8787",
]);

export async function handleInv(req, env, pathname) {
  const cors = corsHeaders(req.headers.get("origin") || "");
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });

  // GET /inv/<id> — public read of a shared snapshot
  const m = pathname.match(/^\/inv\/([a-z0-9]{8,20})$/);
  if (req.method === "GET" && m) {
    if (!env.SUBS) return json({ ok: false, reason: "not-configured" }, 503, cors);
    const raw = await env.SUBS.get(`inv:${m[1]}`);
    if (!raw) return json({ ok: false, reason: "not-found" }, 404, cors);
    return new Response(raw, { status: 200, headers: { ...cors, "Content-Type": "application/json", "Cache-Control": "public, max-age=300" } });
  }

  if (req.method !== "POST" || pathname !== "/inv") return json({ ok: false, reason: "method" }, 405, cors);
  if (!env.SUBS) return json({ ok: false, reason: "not-configured" }, 503, cors);

  const ip = req.headers.get("CF-Connecting-IP") || "";
  if (ip) {
    const key = `rl:inv:${ip}:${new Date().toISOString().slice(0, 10)}`;
    const n = (Number(await env.SUBS.get(key)) || 0) + 1;
    await env.SUBS.put(key, String(n), { expirationTtl: 172800 });
    if (n > MAX_SHARES_PER_IP_DAY) return json({ ok: false, reason: "rate-limited" }, 429, cors);
  }

  let body;
  try { body = await req.json(); } catch { return json({ ok: false, reason: "bad-json" }, 400, cors); }
  const snap = validInvPayload(body);
  if (!snap) return json({ ok: false, reason: "bad-payload" }, 400, cors);

  const id = [...crypto.getRandomValues(new Uint8Array(8))].map(b => (b % 36).toString(36)).join("");
  await env.SUBS.put(`inv:${id}`, JSON.stringify(snap), { expirationTtl: INV_TTL });
  await bumpStat(env.ALERT_STATE, "share", new Date()); // outcome counter (R·B) — aggregate only
  return json({ ok: true, id, ttlDays: Math.round(INV_TTL / 86400) }, 200, cors);
}

function corsHeaders(origin) {
  const o = ALLOW.has(origin) ? origin : "https://crol-list.org";
  return {
    "Access-Control-Allow-Origin": o,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Vary": "Origin",
  };
}
function json(obj, status, cors) {
  return new Response(JSON.stringify(obj), { status, headers: { ...cors, "Content-Type": "application/json" } });
}
