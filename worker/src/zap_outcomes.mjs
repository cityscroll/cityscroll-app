// Edge read model for ZAP land outcomes (decision docs, action status, dispositions).
// Browser only hits GET /zap-outcomes?id= — never the ZAP API or DOB Socrata directly
// for this panel (precompute-first / edge-cache).

import {
  ZAP_API_BASE,
  ZAP_OUTCOMES_KV_PREFIX,
  ZAP_OUTCOMES_MAX_AGE_MS,
  ZAP_SODA_BBL,
  DOB_NOW_DATASET,
  joinOpenDataToZapOutcome,
  joinDobFilingsToBbls,
  normProjectId,
  outcomeIsFilled,
} from "./lib/zap_outcomes.mjs";

export {
  parseZapApiProject,
  joinProjectId,
  joinOpenDataToZapOutcome,
  joinDobFilingsToBbls,
  documentProxyUrl,
  outcomeIsFilled,
  ZAP_API_BASE,
} from "./lib/zap_outcomes.mjs";

const SODA = "https://data.cityofnewyork.us/resource";

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

function kvKey(projectId) {
  return `${ZAP_OUTCOMES_KV_PREFIX}${normProjectId(projectId)}`;
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

async function fetchOpenDataRow(projectId) {
  const where = `project_id='${String(projectId).replace(/'/g, "''")}'`;
  const url =
    `${SODA}/hgx4-8ukb.json?$select=project_id,project_name,public_status,project_status,`
    + `approval_date,completed_date,ulurp_numbers,borough,community_district,actions,current_milestone`
    + `&$where=${encodeURIComponent(where)}&$limit=1`;
  const rows = await fetchJson(url);
  return Array.isArray(rows) && rows[0] ? rows[0] : { project_id: projectId };
}

async function fetchBbls(projectId) {
  const where = `project_id='${String(projectId).replace(/'/g, "''")}'`;
  const url =
    `${SODA}/${ZAP_SODA_BBL}.json?$select=bbl&$where=${encodeURIComponent(where)}&$limit=40`;
  try {
    const rows = await fetchJson(url, 8000);
    return [...new Set((rows || []).map((r) => r.bbl).filter(Boolean))].slice(0, 25);
  } catch {
    return [];
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

  return {
    ...record,
    dob,
    filled: outcomeIsFilled(record),
    generated_at: new Date().toISOString(),
  };
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

  const key = kvKey(projectId);
  let cached = null;
  if (env?.ALERT_STATE) {
    try {
      const raw = await env.ALERT_STATE.get(key);
      cached = raw ? JSON.parse(raw) : null;
    } catch {
      cached = null;
    }
  }

  const fresh =
    cached
    && cached.generated_at
    && (Date.now() - new Date(cached.generated_at).getTime()) < ZAP_OUTCOMES_MAX_AGE_MS;

  if (fresh) {
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
      const write = env.ALERT_STATE.put(key, JSON.stringify(record), {
        expirationTtl: 2 * 24 * 60 * 60,
      });
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
