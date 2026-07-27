// POST /events — bounded first-party event intake for the static site.

import { emitUsageEvent, normalizeUsageEvent } from "./lib/analytics.mjs";

export const ANALYTICS_DEV_HEADER = "X-CROL-Analytics-Dev";
const DEV_TOKEN_VERSION = "v1";
const DEV_TOKEN_CONTEXT = "crol-analytics-dev-exclusion";
const DEV_TOKEN_MAX_AGE_SECONDS = 5 * 60;
const DEV_TOKEN_FUTURE_SKEW_SECONDS = 30;

const ALLOWED_ORIGINS = new Set([
  "https://crol-list.org",
  "https://www.crol-list.org",
  "https://crol-list.jimdc.com",
  "https://jimdc.github.io",
  "http://localhost:8000",
  "http://localhost:8787",
  "http://localhost:8888",
]);

function corsHeaders(origin) {
  return {
    "Access-Control-Allow-Origin": ALLOWED_ORIGINS.has(origin) ? origin : "https://crol-list.org",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": `Content-Type, ${ANALYTICS_DEV_HEADER}`,
    "Access-Control-Max-Age": "86400",
    "Cache-Control": "no-store",
    "Vary": "Origin",
  };
}

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
  const cors = corsHeaders(origin);
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405, headers: cors });
  if (!ALLOWED_ORIGINS.has(origin)) return new Response("Origin not allowed", { status: 403, headers: cors });

  const length = Number(req.headers.get("Content-Length") || 0);
  if (length > 1024) return new Response("Event too large", { status: 413, headers: cors });

  let input;
  try {
    const raw = await req.text();
    if (raw.length > 1024) return new Response("Event too large", { status: 413, headers: cors });
    input = JSON.parse(raw);
  } catch {
    return new Response("Invalid event", { status: 400, headers: cors });
  }
  if (!normalizeUsageEvent(input)) return new Response("Invalid event", { status: 400, headers: cors });

  // Header validity is deliberately invisible to callers: accepted events always return the
  // same 204. Invalid or missing exclusion tokens continue into the normal counting path.
  if (env?.ANALYTICS_ENVIRONMENT === "production") {
    const excluded = await hasValidDeveloperExclusion(
      req,
      env,
      options.nowMs ?? Date.now(),
    );
    if (excluded) return new Response(null, { status: 204, headers: cors });
  }

  emitUsageEvent(env, input);
  return new Response(null, { status: 204, headers: cors });
}
