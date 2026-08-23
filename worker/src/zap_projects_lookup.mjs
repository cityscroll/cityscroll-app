// GET /zap-projects-lookup — sell-facing WH-05 table from ALERT_STATE, committed floor fallback.

import {
  loadZapProjectsLookup,
  zapProjectsLookupStale,
} from "./lib/zap_projects_lookup_kv.mjs";

export {
  ZAP_PROJECTS_LOOKUP_KV_KEY,
  refreshZapProjectsLookup,
} from "./lib/zap_projects_lookup_kv.mjs";

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
}

function response(body, status = 200) {
  return new Response(body, {
    status,
    headers: {
      ...corsHeaders(),
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": status === 200 ? "public, max-age=1800" : "no-store",
    },
  });
}

export async function handleZapProjectsLookup(request, env) {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders() });
  }
  if (request.method !== "GET") {
    return response(JSON.stringify({ ok: false, reason: "method" }), 405);
  }
  const loaded = await loadZapProjectsLookup(env);
  return response(JSON.stringify({
    ...loaded.record,
    stale: zapProjectsLookupStale(loaded.record),
  }));
}
