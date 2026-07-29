// Daily materialized Property view. City Record remains authoritative; this projection
// extracts property-site evidence and resolves one representative site address per notice.

import {
  applyPropertyGeocodes,
  propertyLocationFromRow,
} from "../../property_location.mjs";

export const PROPERTY_KV_KEY = "property:location:v1";
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

async function fetchRows(fetchImpl) {
  const params = new URLSearchParams({
    "$select": SELECT,
    "$where": "section_name='Property Disposition'",
    "$order": "start_date DESC",
    "$limit": "300",
  });
  const response = await fetchImpl(`${SODA}?${params}`);
  if (!response.ok) throw new Error(`Property SODA ${response.status}`);
  const rows = await response.json();
  if (!Array.isArray(rows)) throw new Error("Property SODA returned a non-array response");
  return rows;
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
    return {
      borough: properties.borough || null,
      neighborhood: properties.neighbourhood || null,
      latitude: Number.isFinite(coordinates[1]) ? coordinates[1] : null,
      longitude: Number.isFinite(coordinates[0]) ? coordinates[0] : null,
      bbl: /^\d{10}$/.test(pad.bbl || "") ? pad.bbl : null,
    };
  } catch {
    return null;
  }
}

async function geocodeAll(fetchImpl, addresses) {
  const queue = [...new Set(addresses.filter(Boolean))];
  const output = {};
  let cursor = 0;
  async function geocoder() {
    while (cursor < queue.length) {
      const address = queue[cursor++];
      const result = await geocodeAddress(fetchImpl, address);
      if (result) output[address] = result;
    }
  }
  await Promise.all(Array.from({ length: Math.min(5, queue.length) }, () => geocoder()));
  return output;
}

export async function buildPropertyView(fetchImpl = fetch, now = new Date()) {
  const rows = await fetchRows(fetchImpl);
  const normalized = rows.map((row) => ({
    ...row,
    property_location: propertyLocationFromRow(row),
  }));
  const addresses = normalized
    .map((row) => row.property_location.addresses[0]?.label)
    .filter(Boolean);
  const geocodes = await geocodeAll(fetchImpl, addresses);
  const properties = normalized.map((row) => ({
    ...row,
    property_location: applyPropertyGeocodes(row.property_location, geocodes),
  }));
  return {
    schema_version: 1,
    generated_at: now.toISOString(),
    source: {
      name: "City Record Online",
      dataset: "dg92-zbpx",
      url: "https://data.cityofnewyork.us/City-Government/City-Record-Online/dg92-zbpx",
    },
    counts: {
      total: properties.length,
      local: properties.filter((row) => row.property_location.scope === "local").length,
      unlocated: properties.filter((row) => row.property_location.scope === "unlocated").length,
      geometry: properties.filter((row) => row.property_location.geometry).length,
    },
    properties,
  };
}

export async function refreshProperties(env, fetchImpl = fetch, now = new Date()) {
  if (!env.ALERT_STATE) return { status: "skipped", reason: "no-kv" };
  const view = await buildPropertyView(fetchImpl, now);
  await env.ALERT_STATE.put(PROPERTY_KV_KEY, JSON.stringify(view), {
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

export async function handleProperties(request, env, ctx) {
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders() });
  if (request.method !== "GET") return response(JSON.stringify({ ok: false, reason: "method" }), 405);
  if (!env.ALERT_STATE) return response(JSON.stringify({ ok: false, reason: "not-configured" }), 503);
  let raw = await env.ALERT_STATE.get(PROPERTY_KV_KEY);
  let parsed = null;
  try { parsed = raw ? JSON.parse(raw) : null; } catch { parsed = null; }
  const age = parsed?.generated_at ? Date.now() - new Date(parsed.generated_at).getTime() : Infinity;
  if (!parsed || age > MAX_AGE_MS) {
    try {
      const view = await buildPropertyView(fetch, new Date());
      raw = JSON.stringify(view);
      const write = env.ALERT_STATE.put(PROPERTY_KV_KEY, raw, { expirationTtl: 3 * 24 * 60 * 60 });
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
