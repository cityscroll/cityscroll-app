import {
  applyApiLimits,
  buildMeetingOutcomesView,
  MAX_AGE_MS,
  MEETING_OUTCOMES_KV_KEY,
  MEETING_OUTCOMES_VIEW_VERSION,
  meetingOutcomesViewNeedsRefresh,
  refreshMeetingOutcomes,
} from "./lib/meeting_outcomes.mjs";
import { checkAdminKey } from "./admin.mjs";

export {
  refreshMeetingOutcomes,
  meetingOutcomesViewNeedsRefresh,
  MEETING_OUTCOMES_VIEW_VERSION,
  MAX_AGE_MS,
};

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
}

function adminJson(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
  });
}

// POST /admin/meeting-outcomes-refresh?key=… — on-demand meeting-outcomes materialization
// (same path as the 13:00 UTC cron), so Legistar source_records dual-write can run without
// waiting for the daily schedule. Fail-soft matches the cron path.
export async function handleAdminMeetingOutcomesRefresh(req, env) {
  const auth = checkAdminKey(req, env);
  if (!auth.ok) return auth.res;
  if (req.method !== "POST") return adminJson({ error: "method" }, 405);
  try {
    const result = await refreshMeetingOutcomes(env);
    return adminJson({ ...result, triggeredAt: new Date().toISOString() }, 200);
  } catch (e) {
    return adminJson({ status: "error", error: String(e?.message || e) }, 500);
  }
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

export async function handleMeetingOutcomes(request, env, ctx) {
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders() });
  if (request.method !== "GET") return response(JSON.stringify({ ok: false, reason: "method" }), 405);
  if (!env?.ALERT_STATE) return response(JSON.stringify({ ok: false, reason: "not-configured" }), 503);

  const { searchParams } = new URL(request.url);
  const requestOffset = searchParams.get("offset");
  const requestLimit = searchParams.get("limit");
  const requestId = searchParams.get("id");

  let raw = await env.ALERT_STATE.get(MEETING_OUTCOMES_KV_KEY);
  let parsed = null;
  try { parsed = raw ? JSON.parse(raw) : null; } catch { parsed = null; }

  if (meetingOutcomesViewNeedsRefresh(parsed)) {
    try {
      const token = env?.LEGISTAR_API_TOKEN || null;
      const view = await buildMeetingOutcomesView({ token, fetchImpl: fetch, now: new Date(), env });
      // dual_write is operator telemetry only — never cache it on the public read path.
      const { dual_write: _dualWrite, ...publicView } = view;
      raw = JSON.stringify(publicView);
      const write = env.ALERT_STATE.put(MEETING_OUTCOMES_KV_KEY, raw, {
        expirationTtl: 3 * 24 * 60 * 60,
      });
      if (ctx?.waitUntil) ctx.waitUntil(write); else await write;
      parsed = publicView;
    } catch (error) {
      if (!parsed) {
        return response(JSON.stringify({ ok: false, reason: "upstream", detail: String(error?.message || error) }), 502);
      }
    }
  }

  // Per-notice detail path: return one joined record (or an explicit unmatched gap)
  // so the notice view never needs the full list and never invents a blank.
  if (requestId) {
    if (!/^[A-Za-z0-9_-]{4,40}$/.test(requestId)) {
      return response(JSON.stringify({ ok: false, reason: "bad-id" }), 400);
    }
    const hit = (parsed?.records || []).find((row) => row && row.request_id === requestId) || null;
    if (hit) {
      return response(JSON.stringify({
        ok: true,
        generated_at: parsed.generated_at,
        source: parsed.source,
        record: hit,
      }));
    }
    return response(JSON.stringify({
      ok: true,
      generated_at: parsed?.generated_at || null,
      source: parsed?.source || null,
      record: {
        request_id: requestId,
        join: {
          matched: false,
          reason: "No Council meeting-outcomes record for this notice in the current join window.",
        },
        notice: { request_id: requestId },
        council_event: null,
        agenda_items: [],
      },
    }));
  }

  const limited = applyApiLimits(parsed?.records || [], { limit: requestLimit, offset: requestOffset });
  return response(JSON.stringify({
    ...parsed,
    records: limited.rows,
    pagination: {
      limit: limited.limit,
      offset: limited.offset,
      requested: limited.requested,
      returned: limited.returned,
      total: limited.total,
    },
  }));
}
