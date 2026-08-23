// GET /staffing-exams — civil-service exams JSON from ALERT_STATE, committed floor fallback.

import {
  loadStaffingExams,
  staffingExamsStale,
} from "./lib/staffing_exams_kv.mjs";

export {
  STAFFING_EXAMS_KV_KEY,
  refreshStaffingExams,
} from "./lib/staffing_exams_kv.mjs";

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

export async function handleStaffingExams(request, env) {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders() });
  }
  if (request.method !== "GET") {
    return response(JSON.stringify({ ok: false, reason: "method" }), 405);
  }
  const loaded = await loadStaffingExams(env);
  return response(JSON.stringify({
    ...loaded.record,
    stale: staffingExamsStale(loaded.record),
  }));
}
