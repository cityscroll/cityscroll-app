// NYCIDA/Build NYC subsidy lifecycle precompute + cache + endpoint.
//
// Joins City Record notices to a public Build NYC project feed. The lifecycle is
// assembled on demand, cached in D1 (`subsidy_lifecycle`) and cached at the edge
// for 5 minutes on successful responses. One-time feed failures are explicit (`ok:false`)
// and not cached.

import {
  parseNYCIDAProjects,
  assembleSubsidyLifecycle,
} from "./lib/subsidy_lifecycle.mjs";

const CITY_RECORD_NOTICE_SODA = "https://data.cityofnewyork.us/resource/dg92-zbpx.json";
const SUBSIDY_SOURCE = "https://edc.nyc/about-nycedc/financial-public-documents-recordings";
const PREWARM_MAX = 40;

function sq(s) {
  return String(s || "").replace(/'/g, "''");
}

function asTextBody(value) {
  return String(value == null ? "" : value);
}

function parseJsonishText(raw) {
  const text = asTextBody(raw).trim();
  if (!text) return [];
  try {
    const parsed = JSON.parse(text);
    if (Array.isArray(parsed)) return parsed;
    if (Array.isArray(parsed?.projects)) return parsed.projects;
    if (Array.isArray(parsed?.items)) return parsed.items;
    if (Array.isArray(parsed?.data)) return parsed.data;
    return [];
  } catch {
    return [];
  }
}

function parseEmbeddedProjectJson(text) {
  const candidates = [...String(text || "").matchAll(
    /<script[^>]*type=["']application\/json["'][^>]*>([\s\S]*?)<\/script>/gi,
  )];
  for (const match of candidates) {
    const parsed = parseJsonishText(match[1]);
    if (parsed.length) return parsed;
  }
  return [];
}

async function fetchSubsidyProjects() {
  let text;
  try {
    const r = await fetch(SUBSIDY_SOURCE, { headers: { Accept: "application/json, text/html" } });
    if (!r.ok) return { projects: [], ok: false, sourceError: `Feed returned ${r.status}` };
    text = await r.text();
  } catch (error) {
    return { projects: [], ok: false, sourceError: String(error?.message || error) };
  }

  const jsonRows = parseJsonishText(text);
  const scriptRows = jsonRows.length ? jsonRows : parseEmbeddedProjectJson(text);
  const projects = parseNYCIDAProjects(Array.isArray(scriptRows) ? scriptRows : []);
  return { projects, ok: true };
}

export async function fetchNoticeRow(env, requestId) {
  if (env.DB) {
    try {
      const row = await env.DB.prepare(
        `SELECT request_id, start_date, agency AS agency_name, type_of_notice_description, short_title,
                additional_description_1, additional_description_2, additional_description_3, other_info_1, other_info_2, other_info_3,
                pin, vendor_name, contract_amount
           FROM notices WHERE request_id = ?`,
      ).bind(requestId).first();
      if (row) return row;
    } catch { /* fall through */ }
  }
  try {
    const rows = await fetch(`${CITY_RECORD_NOTICE_SODA}?$select=request_id,start_date,agency_name,type_of_notice_description,short_title,additional_description_1,additional_description_2,additional_description_3,other_info_1,other_info_2,other_info_3,pin,vendor_name,contract_amount&$where=request_id='${sq(requestId)}'&$limit=1`).then((r) => r.json());
    return Array.isArray(rows) && rows.length ? rows[0] : null;
  } catch {
    return null;
  }
}

async function cacheGet(env, requestId) {
  if (!env.DB) return null;
  try {
    const row = await env.DB.prepare(
      "SELECT lifecycle FROM subsidy_lifecycle WHERE request_id = ?",
    ).bind(requestId).first();
    if (row && row.lifecycle) {
      const lifecycle = JSON.parse(row.lifecycle);
      if (lifecycle && Array.isArray(lifecycle.timeline)) return lifecycle;
    }
  } catch { /* miss */ }
  return null;
}

async function cachePut(env, requestId, agency, lifecycle) {
  if (!env.DB) return;
  try {
    await env.DB.prepare(
      `INSERT OR REPLACE INTO subsidy_lifecycle (request_id, agency, lifecycle, computed_at)
         VALUES (?, ?, ?, ?)`,
    ).bind(requestId, agency || null, JSON.stringify(lifecycle), new Date().toISOString()).run();
  } catch { /* do not block */ }
}

export async function computeLifecycle(env, requestId, noticeRow) {
  const notice = noticeRow === undefined ? await fetchNoticeRow(env, requestId) : noticeRow;
  if (!notice) return { lifecycle: null, ok: false, sourceUnavailable: false };
  const { projects, ok } = await fetchSubsidyProjects();
  if (!ok) {
    const fallback = assembleSubsidyLifecycle([notice], [])[0] ?? null;
    if (fallback) fallback.source_status = "unavailable";
    return { lifecycle: fallback, ok: false, sourceUnavailable: true };
  }
  const [lifecycle] = assembleSubsidyLifecycle([notice], projects);
  return { lifecycle, ok: true, sourceUnavailable: false };
}

export async function getOrCompute(env, requestId) {
  const cached = await cacheGet(env, requestId);
  if (cached) return { lifecycle: cached, ok: true, sourceUnavailable: cached.source_status === "unavailable" };

  const { lifecycle, ok, sourceUnavailable } = await computeLifecycle(env, requestId);
  // Cache matched and explicit-gap rows so the notice detail always gets a structured
  // lifecycle (join.matched false, source_status unavailable, etc.) — never a blank.
  if (lifecycle) {
    const row = await fetchNoticeRow(env, requestId).catch(() => null);
    await cachePut(env, requestId, row && row.agency_name, lifecycle);
  }
  return { lifecycle, ok, sourceUnavailable: !!sourceUnavailable };
}

export async function prewarmSubsidyLifecycle(env, requestIds) {
  const ids = Array.isArray(requestIds) ? [...new Set(requestIds.filter(Boolean))].slice(0, PREWARM_MAX) : [];
  let computed = 0;
  let skipped = 0;
  let failed = 0;
  for (const requestId of ids) {
    try {
      if (await cacheGet(env, requestId)) {
        skipped++;
        continue;
      }
      const { lifecycle, ok } = await computeLifecycle(env, requestId);
      if (!ok || !lifecycle) {
        failed++;
        continue;
      }
      const row = await fetchNoticeRow(env, requestId).catch(() => null);
      await cachePut(env, requestId, row && row.agency_name, lifecycle);
      computed++;
    } catch {
      failed++;
    }
  }
  return { requested: ids.length, computed, skipped, failed };
}

const ALLOW = new Set([
  "https://cityscroll.org",
  "https://www.cityscroll.org",
  "https://crol-list.org",
  "https://www.crol-list.org",
  "https://cityscroll.pages.dev",
  "https://crol-list.jimdc.com",
  "https://jimdc.github.io",
  "http://localhost:8000",
  "http://localhost:8787",
]);

function corsHeaders(origin) {
  const o = ALLOW.has(origin) ? origin : "https://cityscroll.org";
  return {
    "Access-Control-Allow-Origin": o,
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Vary": "Origin",
  };
}

function withCors(res, cors) {
  const headers = new Headers(res.headers);
  headers.set("Access-Control-Allow-Origin", cors["Access-Control-Allow-Origin"]);
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}

export async function handleSubsidyLifecycle(req, env, ctx) {
  const cors = corsHeaders(req.headers.get("origin") || "");
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  if (req.method !== "GET") {
    return new Response(JSON.stringify({ id: null, ok: false, reason: "method" }), {
      status: 405,
      headers: { ...cors, "Content-Type": "application/json" },
    });
  }

  const id = new URL(req.url).searchParams.get("id");
  if (!id) return new Response(JSON.stringify({ ok: false, reason: "missing-id" }), {
    status: 400, headers: { ...cors, "Content-Type": "application/json" },
  });
  if (!/^[A-Za-z0-9_-]{4,40}$/.test(id)) {
    return new Response(JSON.stringify({ ok: false, reason: "bad-id" }), {
      status: 400, headers: { ...cors, "Content-Type": "application/json" },
    });
  }

  const cache = typeof caches !== "undefined" ? caches.default : null;
  if (cache) {
    const hit = await cache.match(req).catch(() => null);
    if (hit) return withCors(hit, cors);
  }

  const computed = await getOrCompute(env, id);
  // Only "notice not found" is unresolved. Matched joins, unmatched joins, and
  // source-unavailable fallbacks all return the structured lifecycle so the detail
  // view can render specific per-slot gaps instead of a blank.
  if (!computed.lifecycle) {
    const failureResponse = new Response(JSON.stringify({ id, ok: false, reason: "unresolved" }), {
      status: 200,
      headers: { ...cors, "Content-Type": "application/json", "Cache-Control": "no-store" },
    });
    if (cache) {
      const clone = failureResponse.clone();
      if (ctx?.waitUntil) ctx.waitUntil(cache.delete(req.url).catch(() => {}));
      return clone;
    }
    return failureResponse;
  }

  const body = JSON.stringify({
    id,
    ...computed.lifecycle,
    ok: true,
    source_status: computed.lifecycle.source_status
      || (computed.sourceUnavailable ? "unavailable" : "ok"),
  });
  // Cache successful structured responses (including unmatched gaps) briefly; do not
  // edge-cache only when source is unavailable so a later recovery can rejoin quickly.
  const cacheable = computed.lifecycle.source_status !== "unavailable" && !computed.sourceUnavailable;
  const response = new Response(body, {
    status: 200,
    headers: {
      ...cors,
      "Content-Type": "application/json",
      "Cache-Control": cacheable ? "public, max-age=300" : "no-store",
    },
  });
  if (cache && cacheable) {
    const put = cache.put(req, response.clone());
    if (ctx?.waitUntil) ctx.waitUntil(put);
    else await put.catch(() => {});
  }
  return response;
}
