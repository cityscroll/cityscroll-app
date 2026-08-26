// Daily City Record notice read model.
//
// D1 is the durable last-known-good snapshot. The browser and document edge use this
// endpoint for ordinary notice reads; Socrata is reserved for a cache miss or an
// unavailable/partial mirror. A stale D1 row is still preferable to paying upstream
// latency or turning a refresh failure into a blank notice.

import {
  executeNoticeGet,
  NOTICE_GET_CAPABILITY_REFERENCE,
  NOTICE_GET_PROVIDER_ID,
  NOTICE_GET_REPRESENTATIONS,
  NOTICE_GET_REQUEST_ID_PATTERN,
} from "../../capabilities/notice_get.mjs";

const CITY_RECORD_SODA = "https://data.cityofnewyork.us/resource/dg92-zbpx.json";
const NOTICE_ID_RE = NOTICE_GET_REQUEST_ID_PATTERN;
const MATERIALIZED_MAX_AGE_MS = 2 * 86400_000;
const EDGE_MAX_AGE = 86400;
const EDGE_STALE = 7 * 86400;
const CIVIC_TIME_HISTORY_SCHEMA = "cityscroll.civic_time_notice_history.v1";

export const NOTICE_GET_HTTP_ADAPTER = Object.freeze({
  id: "worker-http.notice-get@1",
  capabilityReference: NOTICE_GET_CAPABILITY_REFERENCE,
  providerId: NOTICE_GET_PROVIDER_ID,
  route: "GET /notice",
  surface: "Notice detail",
  representations: NOTICE_GET_REPRESENTATIONS,
});

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
}

function json(body, status = 200, cacheControl = "no-store") {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...corsHeaders(),
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": cacheControl,
      "X-Content-Type-Options": "nosniff",
    },
  });
}

function cacheKey(id) {
  return new Request(`https://api.cityscroll.org/notice?id=${encodeURIComponent(id)}`);
}

function rowFromD1(record) {
  if (!record) return null;
  try {
    const raw = JSON.parse(record.raw || "null");
    if (raw && typeof raw === "object" && !Array.isArray(raw)
        && raw.request_id === record.request_id) return raw;
  } catch (_error) {
    // The normalized columns below are the durable fallback if an older row predates raw.
  }
  return {
    request_id: record.request_id,
    section_name: record.section,
    agency_name: record.agency,
    type_of_notice_description: record.type_of_notice,
    category_description: record.category,
    short_title: record.short_title,
    selection_method_description: record.selection_method,
    special_case_reason_description: record.special_case_reason,
    pin: record.pin,
    vendor_name: record.vendor_name,
    additional_description_1: record.description,
    other_info_1: record.other_info,
    printout_1: record.printout,
    contract_amount: record.contract_amount,
    start_date: record.start_date,
    due_date: record.due_date,
    event_date: record.event_date,
    building_name: record.event_building,
    street_address_1: record.event_addr1,
    city: record.event_city,
    state: record.event_state,
    zip_code: record.event_zip,
  };
}

async function readCivicTimeHistory(env, requestId) {
  if (!env?.DB) return { schema: CIVIC_TIME_HISTORY_SCHEMA, subject_ref: `notice:${requestId}`, state: "unavailable", events: [] };
  try {
    const response = await env.DB.prepare(
      `SELECT event_id, subject_ref, event_kind, valid_at, valid_from, valid_to,
              published_at, observed_at, processed_at, written_at, status
         FROM civic_time_events
        WHERE subject_ref = ?
        ORDER BY COALESCE(written_at, processed_at, valid_at, published_at, event_id), event_id
        LIMIT 200`,
    ).bind(`notice:${requestId}`).all();
    const events = (response?.results || []).map((event) => ({
      event_id: event.event_id || null,
      subject_ref: event.subject_ref || null,
      event_kind: event.event_kind || null,
      valid_at: event.valid_at ?? null,
      valid_from: event.valid_from ?? null,
      valid_to: event.valid_to ?? null,
      published_at: event.published_at ?? null,
      observed_at: event.observed_at ?? null,
      processed_at: event.processed_at ?? null,
      written_at: event.written_at ?? null,
      status: event.status ?? null,
    }));
    return { schema: CIVIC_TIME_HISTORY_SCHEMA, subject_ref: `notice:${requestId}`, state: "ok", events };
  } catch (_error) {
    // A missing or not-yet-migrated ledger must not break the notice document.
    return { schema: CIVIC_TIME_HISTORY_SCHEMA, subject_ref: `notice:${requestId}`, state: "unavailable", events: [] };
  }
}

async function readMaterialized(env, id, nowMs = Date.now()) {
  if (!env?.DB) return null;
  const record = await env.DB.prepare(
    "SELECT request_id, section, agency, type_of_notice, category, short_title, selection_method, special_case_reason, pin, vendor_name, description, other_info, printout, contract_amount, start_date, due_date, event_date, event_building, event_addr1, event_city, event_state, event_zip, raw, ingested_at FROM notices WHERE request_id = ?",
  ).bind(id).first();
  if (!record) return null;
  const ingestedAt = record.ingested_at || null;
  const age = ingestedAt ? nowMs - new Date(ingestedAt).getTime() : Infinity;
  return {
    row: rowFromD1(record),
    civic_time: await readCivicTimeHistory(env, id),
    generated_at: ingestedAt,
    stale: !ingestedAt || !Number.isFinite(age) || age > MATERIALIZED_MAX_AGE_MS,
  };
}

async function readUpstream(id) {
  const url = new URL(CITY_RECORD_SODA);
  url.searchParams.set("$where", `request_id='${id.replaceAll("'", "''")}'`);
  url.searchParams.set("$limit", "1");
  const response = await fetch(url, {
    headers: { Accept: "application/json" },
    cf: { cacheTtl: 300, cacheEverything: true },
  });
  if (!response.ok) throw new Error(`City Record HTTP ${response.status}`);
  const rows = await response.json();
  return Array.isArray(rows) ? rows[0] || null : null;
}

async function putEdgeCache(request, response) {
  const cache = typeof caches !== "undefined" ? caches.default : null;
  if (!cache || !response.ok) return;
  try { await cache.put(request, response.clone()); } catch (_error) { /* edge cache is best effort */ }
}

/** Explicit provider for the transport-neutral notice.get@1 contract. */
export function workerNoticeGet(env, { nowMs = Date.now() } = {}) {
  return Object.freeze({
    capabilityReference: NOTICE_GET_CAPABILITY_REFERENCE,
    providerId: NOTICE_GET_PROVIDER_ID,
    async execute({ requestId }) {
      try {
        const materialized = await readMaterialized(env, requestId, nowMs);
        if (materialized?.row) {
          return {
            capability_reference: NOTICE_GET_CAPABILITY_REFERENCE,
            availability: "available",
            notice: materialized.row,
            source: "materialized",
            generated_at: materialized.generated_at,
            stale: materialized.stale,
            error: null,
          };
        }
      } catch (_error) {
        // A D1 read failure is an exceptional upstream-style miss; try the public source below.
      }

      try {
        const notice = await readUpstream(requestId);
        if (!notice) {
          return {
            capability_reference: NOTICE_GET_CAPABILITY_REFERENCE,
            availability: "not_yet_public",
            notice: null,
            source: "public-source",
            generated_at: null,
            stale: null,
            error: "not-found",
          };
        }
        return {
          capability_reference: NOTICE_GET_CAPABILITY_REFERENCE,
          availability: "available",
          notice,
          source: "public-source-fallback",
          generated_at: null,
          stale: false,
          error: null,
        };
      } catch (_error) {
        return {
          capability_reference: NOTICE_GET_CAPABILITY_REFERENCE,
          availability: "unavailable",
          notice: null,
          source: "public-source",
          generated_at: null,
          stale: null,
          error: "unavailable",
        };
      }
    },
  });
}

export async function handleNotice(request, env, { skipCache = false, nowMs = Date.now() } = {}) {
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders() });
  if (request.method !== "GET") return json({ ok: false, reason: "method" }, 405);

  const id = new URL(request.url).searchParams.get("id") || "";
  if (!NOTICE_ID_RE.test(id)) return json({ ok: false, reason: "bad-id" }, 400);

  const key = cacheKey(id);
  const cache = typeof caches !== "undefined" ? caches.default : null;
  if (cache && !skipCache) {
    try {
      const hit = await cache.match(key);
      if (hit) return hit;
    } catch (_error) { /* continue to the durable read model */ }
  }

  const result = await executeNoticeGet(workerNoticeGet(env, { nowMs }), { requestId: id });
  if (result.availability === "not_yet_public") return json({ ok: false, reason: "not-found", source: result.source }, 404);
  if (result.availability === "unavailable") return json({ ok: false, reason: "unavailable", source: result.source }, 503);
  const isMaterialized = result.source === "materialized";
  const response = json({
    ok: true,
    row: result.notice,
    ...(isMaterialized ? { civic_time: await readCivicTimeHistory(env, id) } : {}),
    source: result.source,
    generated_at: result.generated_at,
    stale: result.stale,
  }, 200, isMaterialized
    ? `public, max-age=60, s-maxage=${EDGE_MAX_AGE}, stale-while-revalidate=${EDGE_STALE}, stale-if-error=${EDGE_STALE}`
    : "public, max-age=30, s-maxage=300, stale-while-revalidate=3600, stale-if-error=86400");
  await putEdgeCache(key, response);
  return response;
}

export async function prewarmNotices(env, requestIds) {
  const ids = [...new Set((Array.isArray(requestIds) ? requestIds : [])
    .map((id) => String(id || "").trim()).filter((id) => NOTICE_ID_RE.test(id)))].slice(0, 200);
  if (!ids.length) return { requested: 0, warmed: 0, skipped: "empty" };
  if (!env?.DB || typeof caches === "undefined" || !caches.default) {
    return { requested: ids.length, warmed: 0, skipped: !env?.DB ? "no-d1-binding" : "no-edge-cache" };
  }
  let warmed = 0;
  let failed = 0;
  for (const id of ids) {
    try {
      const response = await handleNotice(cacheKey(id), env, { skipCache: true });
      if (response.ok) {
        const body = await response.clone().json();
        if (body.source === "materialized") warmed += 1;
        else failed += 1;
      } else failed += 1;
    } catch (_error) {
      failed += 1;
    }
  }
  return { requested: ids.length, warmed, failed };
}
