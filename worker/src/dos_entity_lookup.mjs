// GET /org-register/dos — bounded on-demand lookup against NYS DOS active entities (n9v6-gdp6).
// Read-only. Failures are never cached. Per-IP daily limit via NL_METER.

import { fetchSodaRowsWithRetry } from "./alerts.mjs";
import { corsHeaders as sharedCorsHeaders, isAllowedRequestOrigin } from "./lib/cors.mjs";
import { overActorLimit } from "./lib/meter.mjs";
import {
  DOS_LIMITS,
  buildIdQuery,
  buildNameQuery,
  lookupDosById,
  lookupDosByName,
} from "../../entity_resolution/registers/dos_entities.mjs";

const MAX_LOOKUPS_PER_IP_DAY = 200;
const METER_KEY = "org-register-dos";

function corsHeaders(origin) {
  return sharedCorsHeaders(origin || "", {}, {
    methods: "GET, OPTIONS",
    headers: "Content-Type",
  });
}

function json(obj, status, cors) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { ...cors, "Content-Type": "application/json" },
  });
}

function disabled(env) {
  const v = String(env?.ORG_REGISTER_DOS_DISABLED || "").trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes";
}

function cacheAdapter(cacheApi, requestUrl) {
  if (!cacheApi?.default) return null;
  const keyUrl = new URL(requestUrl);
  keyUrl.searchParams.set("_org_register_dos_cache", "v1");
  const key = new Request(keyUrl.toString(), { method: "GET" });
  return {
    async get() {
      const hit = await cacheApi.default.match(key);
      if (!hit) return null;
      try {
        return await hit.json();
      } catch {
        return null;
      }
    },
    async put(_ignored, value, seconds) {
      const body = JSON.stringify(value);
      const res = new Response(body, {
        status: 200,
        headers: {
          "Content-Type": "application/json",
          "Cache-Control": `public, max-age=${seconds}`,
        },
      });
      await cacheApi.default.put(key, res, { expirationTtl: seconds });
    },
  };
}

function httpStatusFor(result) {
  switch (result?.status) {
    case "refused":
      return 400;
    case "source_unavailable":
      return 502;
    case "query_rejected":
      return 500;
    default:
      return 200;
  }
}

function envelope(result) {
  return {
    ok: result.status !== "refused" && result.status !== "source_unavailable" && result.status !== "query_rejected",
    status: result.status,
    records: Array.isArray(result.records) ? result.records : [],
    truncated: Boolean(result.truncated),
    returned: result.returned ?? (Array.isArray(result.records) ? result.records.length : 0),
    query_stem: result.query_stem ?? null,
    verdict: result.verdict ?? null,
    link_policy: result.link_policy || "candidate_only",
    queried_at: result.queried_at ?? null,
    cache: result.cache ?? "miss",
    requests: result.requests ?? 0,
    reason: result.reason ?? null,
    http_status: result.http_status ?? null,
  };
}

export async function handleDosEntityLookup(request, env, ctx = null, deps = {}) {
  const cors = corsHeaders(request.headers.get("origin") || "");
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  if (request.method !== "GET") return json({ ok: false, reason: "method" }, 405, cors);

  if (disabled(env)) {
    return json(envelope({
      status: "source_unavailable",
      reason: "disabled",
      records: [],
      requests: 0,
      link_policy: "candidate_only",
    }), 503, cors);
  }

  const url = new URL(request.url);
  const name = url.searchParams.has("name") ? url.searchParams.get("name") : null;
  const dosId = url.searchParams.has("dos_id") ? url.searchParams.get("dos_id") : null;
  if ((name == null && dosId == null) || (name != null && dosId != null)) {
    return json(envelope({
      status: "refused",
      reason: "provide_exactly_one_of_name_or_dos_id",
      records: [],
      requests: 0,
      link_policy: "candidate_only",
    }), 400, cors);
  }

  // Refuse before metering when the pure builder rejects the input.
  if (name != null) {
    const q = buildNameQuery(name);
    if (!q.ok) {
      return json(envelope({
        status: "refused",
        reason: q.reason,
        records: [],
        requests: 0,
        link_policy: "candidate_only",
      }), 400, cors);
    }
  } else {
    const q = buildIdQuery(dosId);
    if (!q.ok) {
      return json(envelope({
        status: "refused",
        reason: q.reason,
        records: [],
        requests: 0,
        link_policy: "candidate_only",
      }), 400, cors);
    }
  }

  const ip = request.headers.get("CF-Connecting-IP") || "";
  const limitFn = deps.overActorLimit || overActorLimit;
  if (ip && await limitFn(env.NL_METER, METER_KEY, ip, MAX_LOOKUPS_PER_IP_DAY)) {
    return json({ ok: false, reason: "rate-limited" }, 429, cors);
  }

  const cacheApi = deps.caches || globalThis.caches;
  const cache = cacheAdapter(cacheApi, request.url);
  const sodaFetch = deps.fetchSodaRowsWithRetry || fetchSodaRowsWithRetry;
  const sodaOpts = {
    budgetMs: DOS_LIMITS.timeout_ms,
    delaysMs: [...DOS_LIMITS.retry_delays_ms],
  };
  if (deps.onSodaOpts) deps.onSodaOpts(sodaOpts);
  const readRows = (sodaUrl) => sodaFetch(sodaUrl, sodaOpts);

  const result = name != null
    ? await lookupDosByName(name, { readRows, cache })
    : await lookupDosById(dosId, { readRows, cache });

  // Never leave failures in cache: lookupDosByName already skips put on failure.
  const body = envelope({ ...result, link_policy: "candidate_only" });
  return json(body, httpStatusFor(result), cors);
}

export { isAllowedRequestOrigin as dosOriginAllowed };
export const DOS_ENTITY_LOOKUP_MAX_PER_IP_DAY = MAX_LOOKUPS_PER_IP_DAY;
