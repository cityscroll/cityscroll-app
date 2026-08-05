// POST /events — bounded first-party event intake for the static site.

import { emitUsageEvent, isProductionUsageTraffic, normalizeUsageEvent } from "./lib/analytics.mjs";
import { corsHeaders, isAllowedRequestOrigin } from "./lib/cors.mjs";
import { bumpCategoryDayStat, bumpStat } from "./lib/stats.mjs";

export const ANALYTICS_DEV_HEADER = "X-CROL-Analytics-Dev";
const DEV_TOKEN_VERSION = "v1";
const DEV_TOKEN_CONTEXT = "crol-analytics-dev-exclusion";
const DEV_TOKEN_MAX_AGE_SECONDS = 5 * 60;
const DEV_TOKEN_FUTURE_SKEW_SECONDS = 30;

function decodeBase64Url(value) {
  if (!/^[A-Za-z0-9_-]{43}$/.test(value)) return null;
  try {
    const base64 = value.replace(/-/g, "+").replace(/_/g, "/") + "=";
    const decoded = atob(base64);
    return Uint8Array.from(decoded, (character) => character.charCodeAt(0));
  } catch {
    return null;
  }
}

async function hasValidDeveloperExclusion(req, env, nowMs) {
  const secret = String(env?.ANALYTICS_DEV_KEY || "");
  const token = req.headers.get(ANALYTICS_DEV_HEADER) || "";
  if (secret.length < 32 || token.length > 160) return false;

  const [version, timestampRaw, signatureRaw, ...extra] = token.split(".");
  const timestamp = Number(timestampRaw);
  const nowSeconds = Math.floor(nowMs / 1000);
  if (
    version !== DEV_TOKEN_VERSION
    || extra.length
    || !Number.isSafeInteger(timestamp)
    || timestamp < nowSeconds - DEV_TOKEN_MAX_AGE_SECONDS
    || timestamp > nowSeconds + DEV_TOKEN_FUTURE_SKEW_SECONDS
  ) return false;

  const signature = decodeBase64Url(signatureRaw || "");
  if (!signature) return false;

  try {
    const encoder = new TextEncoder();
    const key = await crypto.subtle.importKey(
      "raw",
      encoder.encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["verify"],
    );
    return await crypto.subtle.verify(
      "HMAC",
      key,
      signature,
      encoder.encode(`${DEV_TOKEN_CONTEXT}\n${timestampRaw}`),
    );
  } catch {
    // A malformed token or unavailable secret counts normally; exclusion always fails closed.
    return false;
  }
}

export async function handleEvent(req, env, options = {}) {
  const origin = req.headers.get("Origin") || "";
  const cors = corsHeaders(origin, env, {
    headers: `Content-Type, ${ANALYTICS_DEV_HEADER}`,
    maxAge: "86400",
    cacheControl: "no-store",
  });
  if (!isAllowedRequestOrigin(origin, env)) {
    return new Response("Origin not allowed", { status: 403, headers: cors });
  }
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405, headers: cors });

  const length = Number(req.headers.get("Content-Length") || 0);
  if (length > 1024) return new Response("Event too large", { status: 413, headers: cors });

  let input;
  const now = new Date(options.nowMs ?? Date.now());
  try {
    const raw = await req.text();
    if (raw.length > 1024) return new Response("Event too large", { status: 413, headers: cors });
    input = JSON.parse(raw);
  } catch {
    return new Response("Invalid event", { status: 400, headers: cors });
  }

  const normalized = normalizeUsageEvent(input);
  if (!normalized) return new Response("Invalid event", { status: 400, headers: cors });

  // Header validity is deliberately invisible to callers: accepted events always return the
  // same 204. Invalid or missing exclusion tokens continue into the normal counting path.
  // A valid developer-exclusion token stamps traffic_class=developer so desk/ops can filter;
  // production dual-write counters and AE points stay production-only.
  let trafficClass = normalized.traffic_class;
  if (env?.ANALYTICS_ENVIRONMENT === "production") {
    const excluded = await hasValidDeveloperExclusion(
      req,
      env,
      options.nowMs ?? Date.now(),
    );
    if (excluded) trafficClass = "developer";
  } else if (env?.ANALYTICS_ENVIRONMENT && env.ANALYTICS_ENVIRONMENT !== "production") {
    trafficClass = "developer";
  }
  const stamped = { ...normalized, traffic_class: trafficClass };

  // Durable dual-write into ALERT_STATE (same namespace as digests/clicks/feeds). Analytics
  // Engine is best-effort and historically empty when ANALYTICS_ENVIRONMENT was unset; the
  // KV path is the continuous store that must survive domain/route flips. Await before the
  // 204 — fire-and-forget writes are cancelled when the isolate freezes.
  // Production counters only: developer traffic must not inflate the private operations view.
  if (env?.ALERT_STATE && isProductionUsageTraffic(stamped)) {
    try {
      const tasks = [bumpStat(env.ALERT_STATE, `usage_${stamped.event}`, now)];
      if (stamped.event === "page_view") {
        const surface = String(stamped.surface || "home");
        tasks.push(
          bumpStat(env.ALERT_STATE, "page_view", now),
          bumpCategoryDayStat(env.ALERT_STATE, "page_view", surface, now),
        );
      }
      if (stamped.event === "search_run" && stamped.lens && stamped.lens !== "none") {
        tasks.push(bumpCategoryDayStat(env.ALERT_STATE, "usage_search_run", stamped.lens, now));
      }
      if (stamped.event === "alert_confirmed") {
        tasks.push(bumpStat(env.ALERT_STATE, "alert_confirmed", now));
      }
      await Promise.all(tasks);
    } catch {
      // Counting is best-effort; a lost count must not fail intake.
    }
  }

  emitUsageEvent(env, stamped);
  return new Response(null, { status: 204, headers: cors });
}
