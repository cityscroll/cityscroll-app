// Daily materialized hearing read model.
// City Record stays authoritative. The materialized view joins its two hearing-bearing sections,
// extracts affected geography separately from venue, and resolves address signals through the
// same NYC GeoSearch service used by the Land lens.

import { applyGeocode, normalizeHearing } from "./lib/hearings.mjs";
import { withDistricts } from "./lib/council_district.mjs";
import { hearingCalendarICS } from "../../site/hearing_attend_pack.mjs";
import { sourceSignalsFromHtml } from "../../site/hearing_logistics.mjs";

export const HEARINGS_KV_KEY = "hearings:location:v1";
const SODA = "https://data.cityofnewyork.us/resource/dg92-zbpx.json";
const GEOSEARCH = "https://geosearch.planninglabs.nyc/v2/search";
const MAX_AGE_MS = 36 * 60 * 60 * 1000;
const SELECT = [
  "request_id", "start_date", "agency_name", "type_of_notice_description", "section_name",
  "short_title", "event_date", "building_name", "street_address_1", "street_address_2",
  "city", "state", "zip_code", "additional_description_1", "additional_description_2",
  "additional_description_3", "other_info_1", "other_info_2", "other_info_3",
  "printout_1", "printout_2", "printout_3",
].join(",");

function todayISO(now = new Date()) {
  return now.toISOString().slice(0, 10);
}

async function fetchRows(fetchImpl, now) {
  const params = new URLSearchParams({
    "$select": SELECT,
    "$where": `(section_name='Public Hearings and Meetings' OR (section_name='Agency Rules' AND event_date IS NOT NULL)) AND event_date >= '${todayISO(now)}T00:00:00'`,
    "$order": "event_date ASC",
    "$limit": "500",
  });
  const response = await fetchImpl(`${SODA}?${params}`);
  if (!response.ok) throw new Error(`hearing SODA ${response.status}`);
  const rows = await response.json();
  if (!Array.isArray(rows)) throw new Error("hearing SODA returned a non-array response");
  return rows;
}

async function enrichRuleSource(fetchImpl, row) {
  const bodyPresent = [
    row.additional_description_1, row.additional_description_2, row.additional_description_3,
    row.other_info_1, row.other_info_2, row.other_info_3,
    row.printout_1, row.printout_2, row.printout_3,
  ].some(Boolean);
  if (row.section_name !== "Agency Rules" || !row.event_date || bodyPresent) return row;
  try {
    const url = `https://a856-cityrecord.nyc.gov/RequestDetail/${encodeURIComponent(row.request_id || "")}`;
    const response = await fetchImpl(url, { headers: { Accept: "text/html" } });
    if (!response.ok) return row;
    const signals = sourceSignalsFromHtml(await response.text());
    return { ...row, source_body: signals.body || null, source_links: signals.sourceLinks };
  } catch {
    return row;
  }
}

async function geocodeAddress(fetchImpl, address) {
  try {
    const response = await fetchImpl(`${GEOSEARCH}?size=1&text=${encodeURIComponent(`${address} New York NY`)}`);
    if (!response.ok) return null;
    const payload = await response.json();
    const feature = payload?.features?.[0];
    const properties = feature?.properties || {};
    const pad = properties?.addendum?.pad || {};
    const coordinates = feature?.geometry?.coordinates || [];
    if (!feature) return null;
    return withDistricts({
      borough: properties.borough || null,
      neighborhood: properties.neighbourhood || null,
      latitude: Number.isFinite(coordinates[1]) ? coordinates[1] : null,
      longitude: Number.isFinite(coordinates[0]) ? coordinates[0] : null,
      bbl: /^\d{10}$/.test(pad.bbl || "") ? pad.bbl : null,
    });
  } catch {
    return null;
  }
}

async function geocodeAll(fetchImpl, addresses) {
  const queue = [...new Set(addresses.filter(Boolean))];
  const output = {};
  let cursor = 0;
  async function worker() {
    while (cursor < queue.length) {
      const address = queue[cursor++];
      const result = await geocodeAddress(fetchImpl, address);
      if (result) output[address] = result;
    }
  }
  await Promise.all(Array.from({ length: Math.min(5, queue.length) }, () => worker()));
  return output;
}

export async function buildHearingView(fetchImpl = fetch, now = new Date()) {
  const rows = await fetchRows(fetchImpl, now);
  const enriched = await Promise.all(rows.map((row) => enrichRuleSource(fetchImpl, row)));
  const normalized = enriched.map(normalizeHearing);
  const addresses = normalized.flatMap((record) => [
    record.venue.address,
    ...record.affected_area.addresses.map((address) => address.label),
  ]);
  const geocodes = await geocodeAll(fetchImpl, addresses);
  const hearings = normalized.map((record) => applyGeocode(record, geocodes));
  return {
    schema_version: 1,
    generated_at: now.toISOString(),
    source: {
      name: "City Record Online",
      dataset: "dg92-zbpx",
      url: "https://data.cityofnewyork.us/City-Government/City-Record-Online/dg92-zbpx",
    },
    counts: {
      total: hearings.length,
      local: hearings.filter((record) => record.affected_area.scope === "local").length,
      citywide: hearings.filter((record) => record.affected_area.scope === "citywide").length,
      unlocated: hearings.filter((record) => record.affected_area.scope === "unlocated").length,
    },
    hearings,
  };
}

export async function refreshHearings(env, fetchImpl = fetch, now = new Date()) {
  if (!env.ALERT_STATE) return { status: "skipped", reason: "no-kv" };
  const view = await buildHearingView(fetchImpl, now);
  await env.ALERT_STATE.put(HEARINGS_KV_KEY, JSON.stringify(view), {
    expirationTtl: 3 * 24 * 60 * 60,
  });
  return { status: "success", ...view.counts };
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

export async function handleHearings(request, env, ctx) {
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders() });
  if (request.method !== "GET") return response(JSON.stringify({ ok: false, reason: "method" }), 405);
  if (!env.ALERT_STATE) return response(JSON.stringify({ ok: false, reason: "not-configured" }), 503);

  let raw = await env.ALERT_STATE.get(HEARINGS_KV_KEY);
  let parsed = null;
  try { parsed = raw ? JSON.parse(raw) : null; } catch { parsed = null; }
  const age = parsed?.generated_at ? Date.now() - new Date(parsed.generated_at).getTime() : Infinity;
  const requestedId = new URL(request.url).searchParams.get("id") || null;

  const requestedMissing = requestedId && !parsed?.hearings?.some((hearing) => hearing?.request_id === requestedId);
  if (!parsed || age > MAX_AGE_MS || requestedMissing) {
    try {
      const view = await buildHearingView(fetch, new Date());
      raw = JSON.stringify(view);
      const write = env.ALERT_STATE.put(HEARINGS_KV_KEY, raw, { expirationTtl: 3 * 24 * 60 * 60 });
      if (ctx?.waitUntil) ctx.waitUntil(write); else await write;
    } catch (error) {
      if (!parsed) {
        return response(JSON.stringify({ ok: false, reason: "upstream", detail: String(error?.message || error) }), 502);
      }
      raw = JSON.stringify(parsed);
    }
  }
  return response(raw);
}

/**
 * GET /meeting.ics?id=… — one meeting event from the daily hearing materialization.
 * This is intentionally a read-model route: it never performs a per-notice
 * City Record lookup, and a stale cached view remains usable while refresh is attempted.
 */
export async function handleMeetingICS(request, env) {
  if (request.method !== "GET") {
    return new Response("method not allowed", { status: 405, headers: { "Content-Type": "text/plain" } });
  }
  if (!env?.ALERT_STATE) return new Response("not configured", { status: 503 });
  const id = new URL(request.url).searchParams.get("id") || "";
  if (!/^[A-Za-z0-9_-]{4,40}$/.test(id)) return new Response("invalid meeting id", { status: 400 });

  let parsed = null;
  try {
    const raw = await env.ALERT_STATE.get(HEARINGS_KV_KEY);
    parsed = raw ? JSON.parse(raw) : null;
  } catch { parsed = null; }
  if (!parsed) {
    try { parsed = await buildHearingView(fetch, new Date()); } catch { parsed = null; }
  }
  let record = (parsed?.hearings || []).find((hearing) => hearing?.request_id === id);
  // A daily view can be fresh by age while missing a notice published after its
  // refresh. Rebuild on an id miss so a dated rule hearing does not degrade to
  // the misleading "meeting not found" response.
  if (!record) {
    try {
      const refreshed = await buildHearingView(fetch, new Date());
      record = (refreshed?.hearings || []).find((hearing) => hearing?.request_id === id);
    } catch { /* preserve the honest not-found below */ }
  }
  if (!record) return new Response("meeting not found", { status: 404 });
  const ics = hearingCalendarICS({
    ...record,
    short_title: record.title,
    agency_name: record.agency,
    source_url: record.source_url,
  });
  if (!ics) return new Response("meeting has no event time", { status: 404 });
  return new Response(ics, {
    status: 200,
    headers: {
      "Content-Type": "text/calendar; charset=utf-8",
      "Content-Disposition": `attachment; filename="meeting-${id}.ics"`,
      "Cache-Control": "public, max-age=900",
      "Access-Control-Allow-Origin": "*",
    },
  });
}
