// POST /events — bounded first-party event intake for the static site.

import { emitUsageEvent, normalizeUsageEvent } from "./lib/analytics.mjs";

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
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
    "Cache-Control": "no-store",
    "Vary": "Origin",
  };
}

export async function handleEvent(req, env) {
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

  emitUsageEvent(env, input);
  return new Response(null, { status: 204, headers: cors });
}
