// NYCIDA/Build NYC subsidy lifecycle precompute + cache + endpoint.
//
// Joins City Record notices to a public Build NYC project feed. The lifecycle is
// assembled on demand, cached in D1 (`subsidy_lifecycle`) and cached at the edge
// for 5 minutes on successful responses. One-time feed failures are explicit (`ok:false`)
// and not cached.

import {
  parseNYCIDAProjects,
  assembleSubsidyLifecycle,
  stampSubsidyFeedUnavailable,
} from "./lib/subsidy_lifecycle.mjs";

const CITY_RECORD_NOTICE_SODA = "https://data.cityofnewyork.us/resource/dg92-zbpx.json";
const SUBSIDY_SOURCE = "https://edc.nyc/about-nycedc/financial-public-documents-recordings";
const PREWARM_MAX = 40;

/**
 * Bump when hearing-money / place / gap-kind parse logic changes so D1 rows
 * assembled under the old parser recompute instead of serving forever.
 * Missing or mismatched parser_version on a cached row is a cache miss.
 */
export const SUBSIDY_PARSER_VERSION = 2;

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

// Cloudflare challenge HTML is not a project feed — treat as source failure so callers can
// fall back to City Record notice derivation instead of caching an empty "ok" feed forever.
function looksLikeBotChallenge(text) {
  return /just a moment|cf-browser-verification|challenge-platform|_cf_chl|cdn-cgi\/challenge/i
    .test(String(text || ""));
}

async function fetchSubsidyProjects() {
  let text;
  try {
    const r = await fetch(SUBSIDY_SOURCE, {
      headers: {
        Accept: "application/json, text/html",
        "User-Agent": "CityScrollBot/1.0 (+https://cityscroll.org; subsidy-lifecycle)",
      },
    });
    if (!r.ok) return { projects: [], ok: false, sourceError: `Feed returned ${r.status}` };
    text = await r.text();
  } catch (error) {
    return { projects: [], ok: false, sourceError: String(error?.message || error) };
  }

  if (looksLikeBotChallenge(text)) {
    return { projects: [], ok: false, sourceError: "Feed blocked by bot challenge" };
  }

  const jsonRows = parseJsonishText(text);
  const scriptRows = jsonRows.length ? jsonRows : parseEmbeddedProjectJson(text);
  const projects = parseNYCIDAProjects(Array.isArray(scriptRows) ? scriptRows : []);
  // Empty body with no project JSON is a soft failure when the page is the docs landing
  // shell rather than a machine-readable feed (common when the host changes markup).
  if (!projects.length && !jsonRows.length && !scriptRows.length) {
    return { projects: [], ok: false, sourceError: "Feed returned no project records" };
  }
  return { projects, ok: true };
}

// Runtime safety net if migration 0005 was not applied (same posture as PASSPort D1).
export async function ensureSubsidySchema(env) {
  if (!env?.DB) return;
  try {
    await env.DB.prepare(`
      CREATE TABLE IF NOT EXISTS subsidy_lifecycle (
        request_id  TEXT PRIMARY KEY,
        agency      TEXT,
        lifecycle   TEXT,
        computed_at TEXT
      )
    `).run();
    await env.DB.prepare(
      "CREATE INDEX IF NOT EXISTS idx_subsidy_lifecycle_agency ON subsidy_lifecycle(agency)",
    ).run();
  } catch { /* non-fatal */ }
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

/** True when a cached lifecycle was assembled by the current parser. */
export function subsidyCacheIsCurrent(lifecycle, parserVersion = SUBSIDY_PARSER_VERSION) {
  if (!lifecycle || !Array.isArray(lifecycle.timeline)) return false;
  // Never serve a permanently cached feed-unavailable row — recompute so City Record
  // derivation or a recovered feed can replace the operational error.
  if (lifecycle.source_status === "unavailable") return false;
  // Pre-version rows (and any older parser) must recompute after parse logic ships.
  if (lifecycle.parser_version !== parserVersion) return false;
  return true;
}

async function cacheGet(env, requestId) {
  if (!env.DB) return null;
  try {
    await ensureSubsidySchema(env);
    const row = await env.DB.prepare(
      "SELECT lifecycle FROM subsidy_lifecycle WHERE request_id = ?",
    ).bind(requestId).first();
    if (row && row.lifecycle) {
      const lifecycle = JSON.parse(row.lifecycle);
      if (subsidyCacheIsCurrent(lifecycle)) return lifecycle;
    }
  } catch { /* miss */ }
  return null;
}

async function cachePut(env, requestId, agency, lifecycle) {
  if (!env.DB || !lifecycle) return;
  // Do not materialize unavailable — genuine transient failures must not stick forever.
  if (lifecycle.source_status === "unavailable") return;
  try {
    await ensureSubsidySchema(env);
    const stamped = { ...lifecycle, parser_version: SUBSIDY_PARSER_VERSION };
    await env.DB.prepare(
      `INSERT OR REPLACE INTO subsidy_lifecycle (request_id, agency, lifecycle, computed_at)
         VALUES (?, ?, ?, ?)`,
    ).bind(requestId, agency || null, JSON.stringify(stamped), new Date().toISOString()).run();
  } catch { /* do not block */ }
}

export async function computeLifecycle(env, requestId, noticeRow) {
  const notice = noticeRow === undefined ? await fetchNoticeRow(env, requestId) : noticeRow;
  if (!notice) return { lifecycle: null, ok: false, sourceUnavailable: false };
  const { projects, ok } = await fetchSubsidyProjects();
  // assembleSubsidyLifecycle derives a City Record hearing project for IDA notices when
  // the Build NYC feed is empty or blocked — that is a real public join, not "unavailable".
  let [lifecycle] = assembleSubsidyLifecycle([notice], ok ? projects : []);
  if (!lifecycle) return { lifecycle: null, ok: false, sourceUnavailable: !ok };
  if (!ok && !lifecycle.join?.matched) {
    // Feed down and no notice-derived hearing row → honest operational unavailable.
    lifecycle.source_status = "unavailable";
    return { lifecycle, ok: false, sourceUnavailable: true };
  }
  // Feed down but City Record hearing matched: partial source, not a blank failure.
  // Remap later-stage not_published → not_yet_ingested so UI never says the city
  // withholds board/closing/compliance when we never fetched the project feed.
  if (!ok && lifecycle.join?.matched) {
    lifecycle = stampSubsidyFeedUnavailable(lifecycle);
  }
  return { lifecycle, ok: true, sourceUnavailable: false };
}

export async function getOrCompute(env, requestId) {
  const cached = await cacheGet(env, requestId);
  if (cached) return { lifecycle: cached, ok: true, sourceUnavailable: cached.source_status === "unavailable" };

  const { lifecycle, ok, sourceUnavailable } = await computeLifecycle(env, requestId);
  // Cache matched and explicit taxonomy-gap rows; never unavailable (see cachePut).
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
