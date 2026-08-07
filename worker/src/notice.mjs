// Daily City Record notice read model.
//
// D1 is the durable last-known-good snapshot. The browser and document edge use this
// endpoint for ordinary notice reads; Socrata is reserved for a cache miss or an
// unavailable/partial mirror. A stale D1 row is still preferable to paying upstream
// latency or turning a refresh failure into a blank notice.

const CITY_RECORD_SODA = "https://data.cityofnewyork.us/resource/dg92-zbpx.json";
const NOTICE_ID_RE = /^[A-Za-z0-9_-]{1,80}$/;
const MATERIALIZED_MAX_AGE_MS = 2 * 86400_000;
const EDGE_MAX_AGE = 86400;
const EDGE_STALE = 7 * 86400;

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
    if (raw && typeof raw === "object" && !Array.isArray(raw)) return raw;
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

async function readMaterialized(env, id) {
  if (!env?.DB) return null;
  const record = await env.DB.prepare(
    "SELECT request_id, section, agency, type_of_notice, category, short_title, selection_method, special_case_reason, pin, vendor_name, description, other_info, printout, contract_amount, start_date, due_date, event_date, event_building, event_addr1, event_city, event_state, event_zip, raw, ingested_at FROM notices WHERE request_id = ?",
  ).bind(id).first();
  if (!record) return null;
  const ingestedAt = record.ingested_at || null;
  const age = ingestedAt ? Date.now() - new Date(ingestedAt).getTime() : Infinity;
  return {
    row: rowFromD1(record),
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

export async function handleNotice(request, env, { skipCache = false } = {}) {
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

  try {
    const materialized = await readMaterialized(env, id);
    if (materialized?.row) {
      const response = json({
        ok: true,
        row: materialized.row,
        source: "materialized",
        generated_at: materialized.generated_at,
        stale: materialized.stale,
      }, 200, `public, max-age=60, s-maxage=${EDGE_MAX_AGE}, stale-while-revalidate=${EDGE_STALE}, stale-if-error=${EDGE_STALE}`);
      await putEdgeCache(key, response);
      return response;
    }
  } catch (_error) {
    // A D1 read failure is an exceptional upstream-style miss; try the public source below.
  }

  try {
    const row = await readUpstream(id);
    if (!row) return json({ ok: false, reason: "not-found", source: "public-source" }, 404);
    const response = json({ ok: true, row, source: "public-source-fallback", generated_at: null, stale: false }, 200,
      "public, max-age=30, s-maxage=300, stale-while-revalidate=3600, stale-if-error=86400");
    await putEdgeCache(key, response);
    return response;
  } catch (error) {
    return json({ ok: false, reason: "unavailable", source: "public-source", detail: String(error?.message || error) }, 503);
  }
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
