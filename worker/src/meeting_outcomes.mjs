import { applyApiLimits, buildMeetingOutcomesView, MAX_AGE_MS, MEETING_OUTCOMES_KV_KEY } from "./lib/meeting_outcomes.mjs";

export { refreshMeetingOutcomes } from "./lib/meeting_outcomes.mjs";

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

export async function handleMeetingOutcomes(request, env, ctx) {
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders() });
  if (request.method !== "GET") return response(JSON.stringify({ ok: false, reason: "method" }), 405);
  if (!env?.ALERT_STATE) return response(JSON.stringify({ ok: false, reason: "not-configured" }), 503);

  const { searchParams } = new URL(request.url);
  const requestOffset = searchParams.get("offset");
  const requestLimit = searchParams.get("limit");

  let raw = await env.ALERT_STATE.get(MEETING_OUTCOMES_KV_KEY);
  let parsed = null;
  try { parsed = raw ? JSON.parse(raw) : null; } catch { parsed = null; }
  const stale = !parsed || (Date.now() - new Date(parsed.generated_at).getTime()) > MAX_AGE_MS;

  if (!parsed || stale) {
    try {
      const view = await buildMeetingOutcomesView(fetch, new Date());
      raw = JSON.stringify(view);
      const write = env.ALERT_STATE.put(MEETING_OUTCOMES_KV_KEY, raw, {
        expirationTtl: 3 * 24 * 60 * 60,
      });
      if (ctx?.waitUntil) ctx.waitUntil(write); else await write;
      parsed = view;
    } catch (error) {
      if (!parsed) {
        return response(JSON.stringify({ ok: false, reason: "upstream", detail: String(error?.message || error) }), 502);
      }
    }
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
