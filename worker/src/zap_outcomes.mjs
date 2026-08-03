// Edge read model for ZAP land outcomes (decision docs, action status, dispositions).
// Browser only hits GET /zap-outcomes?id= — never the ZAP API or DOB Socrata directly
// for this panel (precompute-first / edge-cache).

import {
  ZAP_API_BASE,
  ZAP_OUTCOMES_KV_PREFIX,
  ZAP_OUTCOMES_MAX_AGE_MS,
  ZAP_SODA_BBL,
  ZAP_SODA_PROJECTS,
  DOB_NOW_DATASET,
  joinOpenDataToZapOutcome,
  joinDobFilingsToBbls,
  joinCityRecordLandNotices,
  buildLandEventSpine,
  normProjectId,
  outcomeIsFilled,
} from "./lib/zap_outcomes.mjs";
import { extractUlurpKeys } from "./lib/ulurp_recommendations_join.mjs";
import { lookupZapFromWarehouseMaterialization } from "./lib/zap_warehouse_lookup.mjs";
import { lookupZapBblsFromWarehouseMaterialization } from "./lib/zap_bbl_warehouse_lookup.mjs";
import { attachUlurpStatutoryPredictions } from "./lib/ulurp_statutory_predictions.mjs";
import zoningStatistics from "./data/zoning_statistics.json" with { type: "json" };
import { attachZoningStatistics } from "./lib/zoning_statistics.mjs";
// Do not static-import admin.mjs here: it pulls alerts.mjs → @jimdc/sendcap, and
// test/land_event_spine.test.mjs imports buildZapOutcomeRecord from this module
// during site unit tests (before worker npm ci). Auth is loaded only on the admin path.

export {
  parseZapApiProject,
  joinProjectId,
  joinOpenDataToZapOutcome,
  joinDobFilingsToBbls,
  documentProxyUrl,
  outcomeIsFilled,
  ZAP_API_BASE,
  ZAP_OUTCOMES_KV_PREFIX,
  ZAP_OUTCOMES_MAX_AGE_MS,
} from "./lib/zap_outcomes.mjs";

const SODA = "https://data.cityofnewyork.us/resource";
const CITY_RECORD_DATASET = "dg92-zbpx";
// Body + contact + venue fields so the land action rail can extract testimony /
// join / venue steps without a second City Record fetch.
const CITY_RECORD_SELECT = [
  "request_id", "start_date", "event_date", "section_name", "agency_name",
  "type_of_notice_description", "short_title",
  "building_name", "street_address_1", "street_address_2", "city", "state", "zip_code",
  "email", "contact_name", "contact_phone",
  "additional_description_1", "additional_description_2", "additional_description_3",
  "other_info_1", "other_info_2", "other_info_3",
  "printout_1", "printout_2", "printout_3",
].join(",");

// Sell-facing land universe for daily write-ahead prewarm. Order is priority:
// public-review first (what the default Land list shows), then noticed/active/filed.
// Full corpus (~33k) is never prewarmed — compute-on-miss remains the fallback.
export const ZAP_PREWARM_STATUSES = Object.freeze([
  "In Public Review",
  "Noticed",
  "Active",
  "Filed",
]);
/** Always pin the demo-frame project so #land/2022M0258 never cold-misses. */
export const ZAP_PREWARM_DEMO_IDS = Object.freeze(["2022M0258"]);
/** Cap per cron/admin run — ~200 × multi-source build stays inside a daily cron budget. */
export const ZAP_PREWARM_MAX = 200;
/** Concurrent builds per wave (ZAP API + SODA fan-out is the cost). */
export const ZAP_PREWARM_CONCURRENCY = 4;
/** Refresh before 24h expiry so the warm window does not gap between daily crons. */
export const ZAP_PREWARM_REFRESH_AGE_MS = Math.floor(ZAP_OUTCOMES_MAX_AGE_MS * 0.75);
export const ZAP_OUTCOMES_KV_TTL_SEC = 2 * 24 * 60 * 60;

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
}

function response(body, status = 200, maxAge = 1800) {
  return new Response(body, {
    status,
    headers: {
      ...corsHeaders(),
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": status === 200 ? `public, max-age=${maxAge}` : "no-store",
    },
  });
}

export function kvKey(projectId) {
  return `${ZAP_OUTCOMES_KV_PREFIX}${normProjectId(projectId)}`;
}

function cacheAgeMs(record, nowMs = Date.now()) {
  if (!record?.generated_at) return Number.POSITIVE_INFINITY;
  const t = new Date(record.generated_at).getTime();
  if (!Number.isFinite(t)) return Number.POSITIVE_INFINITY;
  return Math.max(0, nowMs - t);
}

export function outcomeCacheIsFresh(record, nowMs = Date.now(), maxAgeMs = ZAP_OUTCOMES_MAX_AGE_MS) {
  return cacheAgeMs(record, nowMs) < maxAgeMs;
}

/** Fresh enough that daily prewarm may skip (leaves a buffer before public max-age). */
export function outcomeCacheIsPrewarmFresh(record, nowMs = Date.now()) {
  return cacheAgeMs(record, nowMs) < ZAP_PREWARM_REFRESH_AGE_MS;
}

async function kvGetRecord(env, projectId) {
  if (!env?.ALERT_STATE) return null;
  try {
    const raw = await env.ALERT_STATE.get(kvKey(projectId));
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

async function kvPutRecord(env, record) {
  if (!env?.ALERT_STATE || !record?.project_id) return;
  await env.ALERT_STATE.put(kvKey(record.project_id), JSON.stringify(record), {
    expirationTtl: ZAP_OUTCOMES_KV_TTL_SEC,
  });
}

/**
 * List project_ids for the sell-facing land statuses (priority order, deduped, capped).
 * Pure SODA — no ZAP API. Fail-soft per status so one query outage still yields others.
 */
export async function listPrewarmProjectIds({
  fetchImpl = fetch,
  statuses = ZAP_PREWARM_STATUSES,
  max = ZAP_PREWARM_MAX,
  demoIds = ZAP_PREWARM_DEMO_IDS,
} = {}) {
  const cap = Math.max(1, Math.min(Number(max) || ZAP_PREWARM_MAX, 500));
  const ordered = [];
  const seen = new Set();

  function pushId(raw) {
    const id = String(raw || "").trim();
    if (!id || !/^[A-Za-z0-9][A-Za-z0-9_-]{2,24}$/.test(id)) return;
    const key = normProjectId(id);
    if (!key || seen.has(key)) return;
    seen.add(key);
    ordered.push(id);
  }

  for (const demo of demoIds || []) pushId(demo);

  const statusList = Array.isArray(statuses) ? statuses : ZAP_PREWARM_STATUSES;
  for (const status of statusList) {
    if (ordered.length >= cap) break;
    const remaining = cap - ordered.length;
    const where = `public_status='${String(status).replace(/'/g, "''")}'`;
    const url =
      `${SODA}/${ZAP_SODA_PROJECTS}.json?$select=project_id`
      + `&$where=${encodeURIComponent(where)}`
      + `&$order=current_milestone_date DESC`
      + `&$limit=${remaining}`;
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 12000);
    try {
      const res = await fetchImpl(url, {
        headers: { Accept: "application/json", "User-Agent": "cityscroll-zap-outcomes/1.0" },
        signal: ctl.signal,
      });
      if (!res.ok) continue;
      const rows = await res.json();
      for (const row of rows || []) {
        if (ordered.length >= cap) break;
        pushId(row?.project_id);
      }
    } catch {
      // Partial status list is fine — prewarm what we can.
    } finally {
      clearTimeout(timer);
    }
  }
  return ordered.slice(0, cap);
}

/**
 * Materialize one project into KV when missing or aging out of the prewarm window.
 * Returns a small status token for cron/admin receipts.
 */
export async function prewarmOneZapOutcome(env, projectId, {
  build = buildZapOutcomeRecord,
  nowMs = Date.now(),
  force = false,
} = {}) {
  const id = String(projectId || "").trim();
  if (!id) return { status: "failed", reason: "bad-id" };
  const cached = await kvGetRecord(env, id);
  if (!force && outcomeCacheIsPrewarmFresh(cached, nowMs)) {
    return { status: "skipped", project_id: id, generated_at: cached.generated_at };
  }
  try {
    const record = await build(id);
    if (!record || !record.project_id) {
      return { status: "failed", project_id: id, reason: "empty-record" };
    }
    await kvPutRecord(env, record);
    return {
      status: "computed",
      project_id: id,
      generated_at: record.generated_at,
      filled: !!record.filled,
      matched: !!(record.join && record.join.matched),
    };
  } catch (error) {
    return {
      status: "failed",
      project_id: id,
      reason: String(error?.message || error),
    };
  }
}

/**
 * Bounded write-ahead prewarm for Land detail outcomes.
 * Idempotent: already-fresh KV rows are skipped. Fail-soft per id.
 */
export async function prewarmZapOutcomes(env, projectIds, {
  build = buildZapOutcomeRecord,
  concurrency = ZAP_PREWARM_CONCURRENCY,
  force = false,
  nowMs = Date.now(),
} = {}) {
  const ids = Array.isArray(projectIds)
    ? [...new Set(projectIds.map((id) => String(id || "").trim()).filter(Boolean))].slice(0, ZAP_PREWARM_MAX)
    : [];
  let computed = 0;
  let skipped = 0;
  let failed = 0;
  const wave = Math.max(1, Math.min(Number(concurrency) || ZAP_PREWARM_CONCURRENCY, 8));

  for (let i = 0; i < ids.length; i += wave) {
    const chunk = ids.slice(i, i + wave);
    const results = await Promise.all(
      chunk.map((id) => prewarmOneZapOutcome(env, id, { build, nowMs, force })),
    );
    for (const r of results) {
      if (r.status === "computed") computed++;
      else if (r.status === "skipped") skipped++;
      else failed++;
    }
  }
  return { requested: ids.length, computed, skipped, failed };
}

/**
 * Daily / admin path: list sell-facing project_ids, then prewarm into KV.
 * Same shape as refreshMeetingOutcomes — skip cleanly when KV is unbound.
 */
export async function refreshZapOutcomes(env, opts = {}) {
  if (!env?.ALERT_STATE) {
    return { status: "skipped", reason: "no-kv" };
  }
  const max = opts.max ?? ZAP_PREWARM_MAX;
  const force = opts.force === true;
  let projectIds = Array.isArray(opts.projectIds) ? opts.projectIds : null;
  let listed = 0;
  if (!projectIds) {
    projectIds = await listPrewarmProjectIds({
      max,
      statuses: opts.statuses || ZAP_PREWARM_STATUSES,
      demoIds: opts.demoIds || ZAP_PREWARM_DEMO_IDS,
      fetchImpl: opts.fetchImpl || fetch,
    });
    listed = projectIds.length;
  } else {
    projectIds = projectIds.slice(0, max);
    listed = projectIds.length;
  }
  const summary = await prewarmZapOutcomes(env, projectIds, {
    build: opts.build || buildZapOutcomeRecord,
    concurrency: opts.concurrency || ZAP_PREWARM_CONCURRENCY,
    force,
    nowMs: opts.nowMs || Date.now(),
  });
  return {
    status: "ok",
    listed,
    ...summary,
    generated_at: new Date(opts.nowMs || Date.now()).toISOString(),
  };
}

function adminJson(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
  });
}

// POST /admin/zap-outcomes-refresh?key=… — on-demand Land outcomes prewarm (same path as cron).
// Optional JSON body: { projectIds?: string[], max?: number, force?: boolean }
export async function handleAdminZapOutcomesRefresh(req, env) {
  const { checkAdminKey } = await import("./admin.mjs");
  const auth = checkAdminKey(req, env);
  if (!auth.ok) return auth.res;
  if (req.method !== "POST") return adminJson({ error: "method" }, 405);
  let body = {};
  try {
    const text = await req.text();
    if (text && text.trim()) body = JSON.parse(text);
  } catch {
    return adminJson({ error: "bad-json" }, 400);
  }
  try {
    const result = await refreshZapOutcomes(env, {
      projectIds: Array.isArray(body.projectIds) ? body.projectIds : undefined,
      max: body.max,
      force: body.force === true,
    });
    return adminJson({ ...result, triggeredAt: new Date().toISOString() }, 200);
  } catch (e) {
    return adminJson({ status: "error", error: String(e?.message || e) }, 500);
  }
}

async function fetchJson(url, timeoutMs = 12000) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: ctl.signal,
      headers: { Accept: "application/json", "User-Agent": "cityscroll-zap-outcomes/1.0" },
    });
    if (!res.ok) {
      const err = new Error(`http-${res.status}`);
      err.status = res.status;
      throw err;
    }
    return await res.json();
  } finally {
    clearTimeout(t);
  }
}

/**
 * ZAP Open Data project row: warehouse materialization first (WH-05), then live SODA.
 * Returns the SODA-shaped row (always includes project_id). Attaches lookup_path when known.
 */
export async function fetchOpenDataRow(projectId) {
  const id = String(projectId || "").trim();
  // WH-05: instant hit from warehouse materialization index (no network).
  const wh = lookupZapFromWarehouseMaterialization(id);
  if (wh.hit && wh.row) {
    return { ...wh.row, lookup_path: "warehouse" };
  }

  // Live SODA fallback when the materialization lacks this project_id.
  const where = `project_id='${id.replace(/'/g, "''")}'`;
  const url =
    `${SODA}/hgx4-8ukb.json?$select=project_id,project_name,public_status,project_status,`
    + `approval_date,completed_date,ulurp_numbers,borough,community_district,actions,current_milestone,current_milestone_date`
    + `&$where=${encodeURIComponent(where)}&$limit=1`;
  try {
    const rows = await fetchJson(url);
    if (Array.isArray(rows) && rows[0]) {
      return { ...rows[0], lookup_path: "soda" };
    }
  } catch {
    // Fail-soft: empty shell so spine/join can still proceed with project_id.
  }
  return { project_id: id, lookup_path: "soda" };
}

async function fetchCityRecordCandidates(openData, projectName) {
  const keys = [...extractUlurpKeys(openData?.ulurp_numbers)];
  const spacedKeys = keys.map((key) => {
    const match = key.match(/^([A-Z]?)(\d{6})([A-Z]+)$/);
    return match ? [match[1], match[2], match[3]].filter(Boolean).join(" ") : key;
  });
  // City Record prose commonly prints `C 240046 HAM`, while ZAP stores
  // `C240046HAM`; query both forms, then retain only strict parsed-token hits.
  const terms = [
    String(projectName || openData?.project_name || "").trim(),
    ...keys,
    ...spacedKeys,
  ].filter((term, index, all) => term.length >= 4 && all.indexOf(term) === index).slice(0, 12);
  if (!terms.length) return { rows: [], status: "ok" };

  let successful = 0;
  const rows = [];
  const seen = new Set();
  await Promise.all(terms.map(async (term) => {
    const url = `${SODA}/${CITY_RECORD_DATASET}.json?$select=${CITY_RECORD_SELECT}`
      + `&$q=${encodeURIComponent(term)}&$order=start_date DESC&$limit=40`;
    try {
      const found = await fetchJson(url, 10000);
      successful++;
      for (const row of found || []) {
        const id = String(row?.request_id || "");
        if (!id || seen.has(id)) continue;
        seen.add(id);
        rows.push(row);
      }
    } catch {
      // A partial query failure must not erase successful strict-token candidates.
    }
  }));
  return { rows, status: successful ? "ok" : "unavailable" };
}

/**
 * ZAP BBL tax lots: warehouse materialization first (WH-06), then live SODA.
 * Returns BBL strings (max 25). Attaches lookup_path via array property when useful
 * for tests — callers that only need ids can ignore it.
 */
export async function fetchBbls(projectId) {
  const id = String(projectId || "").trim();
  // WH-06: instant hit from warehouse materialization index (no network).
  const wh = lookupZapBblsFromWarehouseMaterialization(id);
  if (wh.hit) {
    // Hit with empty list is still a warehouse answer (project known, no lots).
    const bbls = (wh.bbls || []).slice(0, 25);
    bbls.lookup_path = "warehouse";
    return bbls;
  }

  // Live SODA fallback when the materialization lacks this project_id.
  const where = `project_id='${id.replace(/'/g, "''")}'`;
  const url =
    `${SODA}/${ZAP_SODA_BBL}.json?$select=bbl&$where=${encodeURIComponent(where)}&$limit=40`;
  try {
    const rows = await fetchJson(url, 8000);
    const bbls = [...new Set((rows || []).map((r) => {
      let s = String(r?.bbl ?? "").trim().replace(/\.0$/, "");
      if (s && /^\d+$/.test(s) && s.length < 10) s = s.padStart(10, "0");
      return /^\d{10}$/.test(s) ? s : null;
    }).filter(Boolean))].slice(0, 25);
    bbls.lookup_path = "soda";
    return bbls;
  } catch {
    const empty = [];
    empty.lookup_path = "soda";
    return empty;
  }
}

async function fetchDobForBbls(bbls) {
  if (!bbls?.length) return [];
  // Query up to 3 BBLs to stay inside URL limits; enough for the side-car.
  const sample = bbls.slice(0, 3);
  const clauses = sample.map((b) => `bbl='${String(b).replace(/'/g, "''")}'`).join(" OR ");
  const url =
    `${SODA}/${DOB_NOW_DATASET}.json?$select=job_filing_number,filing_status,job_type,filing_date,`
    + `house_no,street_name,bbl,bin`
    + `&$where=${encodeURIComponent(clauses)}&$order=filing_date DESC&$limit=20`;
  try {
    return await fetchJson(url, 8000);
  } catch {
    return [];
  }
}

/**
 * Build one outcome record for a project_id (Open Data + ZAP API + optional DOB).
 */
export async function buildZapOutcomeRecord(projectId, { fetchBbl = true } = {}) {
  const id = String(projectId || "").trim();
  if (!id) {
    return {
      project_id: null,
      join: { matched: false, method: null, reason: "Missing project_id." },
      useful: false,
      filled: false,
    };
  }

  const openData = await fetchOpenDataRow(id);
  let apiPayload = null;
  try {
    apiPayload = await fetchJson(
      `${ZAP_API_BASE}/projects/${encodeURIComponent(id)}`,
      15000,
    );
  } catch (e) {
    return {
      project_id: id,
      open_data: openData,
      join: {
        matched: false,
        method: null,
        reason: e?.status === 404
          ? "No ZAP API project detail for this project_id."
          : "Could not reach the ZAP project API for decision documents.",
      },
      useful: false,
      filled: false,
      dob: { matched: false, filings: [], reason: "Skipped while ZAP API was unavailable." },
    };
  }

  const record = joinOpenDataToZapOutcome(openData, apiPayload);

  let dob = {
    matched: false,
    method: null,
    filings: [],
    reason: "Tax-lot / DOB side-car not requested.",
  };
  if (fetchBbl) {
    const bbls = await fetchBbls(id);
    if (!bbls.length) {
      dob = {
        matched: false,
        method: null,
        filings: [],
        reason: "No tax lots published for this project in ZAP BBL data.",
      };
    } else {
      const filings = await fetchDobForBbls(bbls);
      dob = joinDobFilingsToBbls(filings, bbls);
      dob.bbls_checked = bbls.length;
    }
  }

  const withDob = {
    ...record,
    dob,
    filled: outcomeIsFilled(record),
    generated_at: new Date().toISOString(),
  };
  const candidateResult = await fetchCityRecordCandidates(openData, record.project_name);
  const cityRecordNotices = joinCityRecordLandNotices(
    candidateResult.rows,
    openData?.ulurp_numbers,
  );
  const assembled = {
    ...withDob,
    // Slim public notice rows for land-detail action rail (participation extraction).
    // Same SODA fields already used for the ULURP spine join — not a new publisher.
    city_record_notices: slimCityRecordNoticesForActionRail(cityRecordNotices),
    spine: buildLandEventSpine(withDob, {
      cityRecordNotices,
      noticeLookupStatus: candidateResult.status,
    }),
  };
  // Batch-side ULURP statutory clocks (cityscroll.prediction.v0) — precompute-first;
  // the browser only renders the stamped view (no per-request day math).
  const withStatutoryClock = attachUlurpStatutoryPredictions(assembled, {
    generatedAt: assembled.generated_at,
  });
  // Charter deadlines remain authoritative; this warehouse layer adds
  // historical context only after its out-of-time scorecard clears the bar.
  return attachZoningStatistics(withStatutoryClock, zoningStatistics, {
    generatedAt: assembled.generated_at,
  });
}

/** Cap notice payload size while keeping body + venue fields for participation steps. */
export function slimCityRecordNoticesForActionRail(notices, limit = 12) {
  return (Array.isArray(notices) ? notices : []).slice(0, limit).map((row) => ({
    request_id: row.request_id || null,
    start_date: row.start_date || null,
    event_date: row.event_date || null,
    section_name: row.section_name || null,
    agency_name: row.agency_name || null,
    type_of_notice_description: row.type_of_notice_description || null,
    short_title: row.short_title || null,
    building_name: row.building_name || null,
    street_address_1: row.street_address_1 || null,
    street_address_2: row.street_address_2 || null,
    city: row.city || null,
    state: row.state || null,
    zip_code: row.zip_code || null,
    email: row.email || null,
    contact_name: row.contact_name || null,
    contact_phone: row.contact_phone || null,
    additional_description_1: row.additional_description_1 || null,
    additional_description_2: row.additional_description_2 || null,
    additional_description_3: row.additional_description_3 || null,
    other_info_1: row.other_info_1 || null,
    other_info_2: row.other_info_2 || null,
    other_info_3: row.other_info_3 || null,
    printout_1: row.printout_1 || null,
    printout_2: row.printout_2 || null,
    printout_3: row.printout_3 || null,
    join: row.join || null,
  }));
}

export async function handleZapOutcomes(request, env, ctx) {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders() });
  }
  if (request.method !== "GET") {
    return response(JSON.stringify({ ok: false, reason: "method" }), 405);
  }

  const { searchParams } = new URL(request.url);
  const projectId = searchParams.get("id") || searchParams.get("project_id");
  if (!projectId || !/^[A-Za-z0-9][A-Za-z0-9_-]{2,24}$/.test(projectId)) {
    return response(JSON.stringify({ ok: false, reason: "bad-id" }), 400);
  }

  const cached = await kvGetRecord(env, projectId);

  if (outcomeCacheIsFresh(cached)) {
    return response(JSON.stringify({
      ok: true,
      cached: true,
      generated_at: cached.generated_at,
      record: cached,
    }));
  }

  try {
    const record = await buildZapOutcomeRecord(projectId);
    if (env?.ALERT_STATE) {
      const write = kvPutRecord(env, record);
      if (ctx?.waitUntil) ctx.waitUntil(write);
      else await write;
    }
    return response(JSON.stringify({
      ok: true,
      cached: false,
      generated_at: record.generated_at,
      record,
    }));
  } catch (error) {
    if (cached) {
      return response(JSON.stringify({
        ok: true,
        cached: true,
        stale: true,
        generated_at: cached.generated_at,
        record: cached,
      }));
    }
    return response(JSON.stringify({
      ok: false,
      reason: "upstream",
      detail: String(error?.message || error),
    }), 502);
  }
}
