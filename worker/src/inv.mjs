// POST /inv + GET /inv/<id> — share an investigation (pin list) as a read-only link.
// The snapshot is structured, clamped, byte-capped (lib/inv.mjs), TTL'd, and rate-limited,
// so this can't become arbitrary file hosting. Stored in the SUBS KV under the inv: prefix.

import { validInvPayload, INV_TTL } from "./lib/inv.mjs";
import { bumpStat } from "./lib/stats.mjs";
import { emitUsageEvent } from "./lib/analytics.mjs";
import { vendorStem } from "./lib/compile.mjs";
import { overActorLimit } from "./lib/meter.mjs";

const MAX_SHARES_PER_IP_DAY = 10;

const ALLOW = new Set([
  "https://cityscroll.org", "https://www.cityscroll.org",
  "https://crol-list.org", "https://www.crol-list.org",
  "https://cityscroll.pages.dev",
  "https://crol-list.jimdc.com", "https://jimdc.github.io",
  "http://localhost:8000", "http://localhost:8787",
]);

export async function handleInv(req, env, pathname, ctx) {
  const cors = corsHeaders(req.headers.get("origin") || "");
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });

  // GET /inv/<id> — public read of a shared snapshot or agency/vendor forecast
  if (req.method === "GET" && pathname.startsWith("/inv/")) {
    const id = pathname.slice(5); // strip "/inv/"
    const cache = typeof caches !== "undefined" ? caches.default : null;
    if (cache) {
      const hit = await cache.match(req).catch(() => null);
      if (hit) return withCors(hit, cors);
    }
    
    // 1. Try to fetch as share snapshot first
    if (env.SUBS) {
      const raw = await env.SUBS.get(`inv:${id}`);
      if (raw) {
        const res = new Response(raw, { status: 200, headers: { ...cors, "Content-Type": "application/json", "Cache-Control": "public, max-age=300" } });
        if (cache) {
          const put = cache.put(req, res.clone());
          if (ctx?.waitUntil) ctx.waitUntil(put); else await put.catch(() => {});
        }
        return res;
      }
    }

    // 2. If not found in SUBS as a share snapshot, treat as agency/vendor entity stem!
    const stem = vendorStem(decodeURIComponent(id));
    if (stem.length >= 3 && env.ALERT_STATE) {
      const fcRaw = await env.ALERT_STATE.get(`fc:${stem}`);
      const forecasts = [];
      if (fcRaw) forecasts.push(...JSON.parse(fcRaw));
      
      forecasts.sort((a, b) => {
        const dateA = a.expiration_date || a.warning_date || "";
        const dateB = b.expiration_date || b.warning_date || "";
        return dateA.localeCompare(dateB);
      });

      return json({ id: stem, forecasts }, 200, cors);
    }

    return json({ ok: false, reason: "not-found" }, 404, cors);
  }

  if (req.method !== "POST" || pathname !== "/inv") return json({ ok: false, reason: "method" }, 405, cors);
  if (!env.SUBS) return json({ ok: false, reason: "not-configured" }, 503, cors);

  const ip = req.headers.get("CF-Connecting-IP") || "";
  if (ip && await overActorLimit(env.SUBS, "inv", ip, MAX_SHARES_PER_IP_DAY)) {
    return json({ ok: false, reason: "rate-limited" }, 429, cors);
  }

  let body;
  try { body = await req.json(); } catch { return json({ ok: false, reason: "bad-json" }, 400, cors); }
  const snap = validInvPayload(body);
  if (!snap) return json({ ok: false, reason: "bad-payload" }, 400, cors);

  const id = [...crypto.getRandomValues(new Uint8Array(8))].map(b => (b % 36).toString(36)).join("");
  await env.SUBS.put(`inv:${id}`, JSON.stringify(snap), { expirationTtl: INV_TTL });
  await bumpStat(env.ALERT_STATE, "share", new Date()); // outcome counter (R·B) — aggregate only
  emitUsageEvent(env, { event: "investigation_share", detail: "create", surface: "api" });
  return json({ ok: true, id, ttlDays: Math.round(INV_TTL / 86400) }, 200, cors);
}

function corsHeaders(origin) {
  const o = ALLOW.has(origin) ? origin : "https://cityscroll.org";
  return {
    "Access-Control-Allow-Origin": o,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Vary": "Origin",
  };
}
function withCors(res, cors) {
  const headers = new Headers(res.headers);
  headers.set("Access-Control-Allow-Origin", cors["Access-Control-Allow-Origin"]);
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}
function json(obj, status, cors) {
  return new Response(JSON.stringify(obj), { status, headers: { ...cors, "Content-Type": "application/json" } });
}
