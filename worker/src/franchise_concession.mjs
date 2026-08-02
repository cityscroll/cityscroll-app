// Daily materialized Franchise / Concession Review (FCRC) view.
// City Record remains authoritative; this materialization stamps multi-notice
// process spines (solicitation → public hearing → committee meeting → award)
// joined by counterparty stem, annual plan year, or FCRC rules subject.

import {
  attachFranchiseConcessionSpines,
  isFranchiseConcessionEligible,
} from "./lib/franchise_concession_spine.mjs";

export const FRANCHISE_CONCESSION_KV_KEY = "franchise-concession:spines:v1";
const SODA = "https://data.cityofnewyork.us/resource/dg92-zbpx.json";
const MAX_AGE_MS = 36 * 60 * 60 * 1000;
const SELECT = [
  "request_id",
  "start_date",
  "agency_name",
  "type_of_notice_description",
  "section_name",
  "short_title",
  "event_date",
  "vendor_name",
  "additional_description_1",
  "additional_description_2",
  "additional_description_3",
  "other_info_1",
  "other_info_2",
  "other_info_3",
].join(",");

// Socrata SoQL: FCRC agency rows + titles that name the committee / FCRC.
// Client-side isFranchiseConcessionEligible still excludes Council zoning-franchises.
const SODA_WHERE = [
  "agency_name='Franchise and Concession Review Committee'",
  "agency_name='Mayor\\'s Office of Contract Services'",
  "upper(short_title) like '%FCRC%'",
  "upper(short_title) like '%FRANCHISE AND CONCESSION%'",
  "upper(short_title) like '%PROPOSED FRANCHISE%'",
].join(" OR ");

async function fetchRows(fetchImpl) {
  const params = new URLSearchParams({
    $select: SELECT,
    $where: SODA_WHERE,
    $order: "start_date DESC",
    $limit: "300",
  });
  const response = await fetchImpl(`${SODA}?${params}`);
  if (!response.ok) throw new Error(`Franchise/concession SODA ${response.status}`);
  const rows = await response.json();
  if (!Array.isArray(rows)) {
    throw new Error("Franchise/concession SODA returned a non-array response");
  }
  return rows.filter((row) => isFranchiseConcessionEligible(row));
}

export async function buildFranchiseConcessionView(fetchImpl = fetch, now = new Date()) {
  const notices = await fetchRows(fetchImpl);
  const view = {
    schema_version: 1,
    generated_at: now.toISOString(),
    source: {
      name: "City Record Online",
      dataset: "dg92-zbpx",
      url: "https://data.cityofnewyork.us/City-Government/City-Record-Online/dg92-zbpx",
      mocs_url:
        "https://www.nyc.gov/site/mocs/opportunities/franchises-concessions.page",
    },
    counts: {
      total: notices.length,
    },
    notices,
  };
  return attachFranchiseConcessionSpines(view);
}

export async function refreshFranchiseConcessions(env, fetchImpl = fetch, now = new Date()) {
  if (!env.ALERT_STATE) return { status: "skipped", reason: "no-kv" };
  const view = await buildFranchiseConcessionView(fetchImpl, now);
  await env.ALERT_STATE.put(FRANCHISE_CONCESSION_KV_KEY, JSON.stringify(view), {
    expirationTtl: 3 * 24 * 60 * 60,
  });
  return {
    status: "success",
    total: view.counts?.total ?? 0,
    spine_count: view.franchise_metrics?.spine_count ?? 0,
  };
}

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

export async function handleFranchiseConcessions(request, env, ctx) {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders() });
  }
  if (request.method !== "GET") {
    return response(JSON.stringify({ ok: false, reason: "method" }), 405);
  }
  if (!env.ALERT_STATE) {
    return response(JSON.stringify({ ok: false, reason: "not-configured" }), 503);
  }

  let raw = await env.ALERT_STATE.get(FRANCHISE_CONCESSION_KV_KEY);
  let parsed = null;
  try {
    parsed = raw ? JSON.parse(raw) : null;
  } catch {
    parsed = null;
  }
  const age = parsed?.generated_at
    ? Date.now() - new Date(parsed.generated_at).getTime()
    : Infinity;

  if (!parsed || age > MAX_AGE_MS) {
    try {
      const view = await buildFranchiseConcessionView(fetch, new Date());
      raw = JSON.stringify(view);
      parsed = view;
      const write = env.ALERT_STATE.put(FRANCHISE_CONCESSION_KV_KEY, raw, {
        expirationTtl: 3 * 24 * 60 * 60,
      });
      if (ctx?.waitUntil) ctx.waitUntil(write);
      else await write;
    } catch (error) {
      if (!parsed) {
        return response(
          JSON.stringify({
            ok: false,
            reason: "upstream",
            detail: String(error?.message || error),
          }),
          502,
        );
      }
      raw = JSON.stringify(parsed);
    }
  }

  return response(typeof raw === "string" ? raw : JSON.stringify(parsed));
}
