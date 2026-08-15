// Daily materialized Property view. City Record remains authoritative; this projection
// extracts property-site evidence and resolves one representative site address per notice.
// Also stamps multi-notice disposition process spines (hearing → auction/RFP → award)
// joined by BBL or borough+block/lot — separate from the list filter "lifecycle rail".
// Default GET serves a slim list view (drops body-dump fields) for first-paint speed;
// ?full=1 returns the complete materialization.

import {
  applyPropertyGeocodes,
  propertyLocationFromRow,
} from "../../site/property_location.mjs";
import {
  DCAS_VEHICLE_AUCTION_DATASET,
  DCAS_VEHICLE_AUCTION_MAX_ROWS,
  buildDcasVehicleAuctionSnapshot,
} from "../../site/dcas_vehicle_auctions.mjs";
import { attachDispositionSpines } from "./lib/property_disposition_spine.mjs";
import { attachPropertyCommercial } from "./lib/property_commercial.mjs";
import { slimPropertyListView } from "./lib/property_list.mjs";

export const PROPERTY_KV_KEY = "property:location:v1";
const SODA = "https://data.cityofnewyork.us/resource/dg92-zbpx.json";
const GEOSEARCH = "https://geosearch.planninglabs.nyc/v2/search";
const DCAS_SODA = `https://data.cityofnewyork.us/resource/${DCAS_VEHICLE_AUCTION_DATASET}.json`;
const MAX_AGE_MS = 36 * 60 * 60 * 1000;
const SELECT = [
  "request_id", "start_date", "end_date", "agency_name", "type_of_notice_description", "section_name",
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

async function fetchDcasVehicleAuctionSnapshot(fetchImpl, now) {
  const params = new URLSearchParams({
    "$select": "auction_close_date,year,make,model,vin",
    "$order": "auction_close_date DESC,make,model,vin",
    "$limit": String(DCAS_VEHICLE_AUCTION_MAX_ROWS),
  });
  const response = await fetchImpl(`${DCAS_SODA}?${params}`);
  if (!response.ok) throw new Error(`DCAS vehicle auction SODA ${response.status}`);
  const rows = await response.json();
  if (!Array.isArray(rows)) throw new Error("DCAS vehicle auction SODA returned a non-array response");
  let sourceUpdatedAt = null;
  try {
    const metadataResponse = await fetchImpl(`https://data.cityofnewyork.us/api/views/${DCAS_VEHICLE_AUCTION_DATASET}`);
    if (metadataResponse.ok) {
      const metadata = await metadataResponse.json();
      const epochSeconds = Number(metadata?.rowsUpdatedAt || metadata?.publicationDate);
      if (Number.isFinite(epochSeconds)) sourceUpdatedAt = new Date(epochSeconds * 1000).toISOString();
    }
  } catch {
    // The row snapshot remains useful when the catalog metadata endpoint is unavailable.
  }
  const asOf = now.toISOString().slice(0, 10);
  return buildDcasVehicleAuctionSnapshot(rows, {
    asOf,
    observedAt: now.toISOString(),
    sourceUpdatedAt,
    sourceTotal: rows.length,
    query: {
      select: "auction_close_date,year,make,model,vin",
      order: "auction_close_date DESC,make,model,vin",
      limit: DCAS_VEHICLE_AUCTION_MAX_ROWS,
    },
    pages: 1,
    limit: DCAS_VEHICLE_AUCTION_MAX_ROWS,
    truncated: rows.length >= DCAS_VEHICLE_AUCTION_MAX_ROWS,
  });
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
  const [rows, dcasVehicleAuctions] = await Promise.all([
    fetchRows(fetchImpl),
    fetchDcasVehicleAuctionSnapshot(fetchImpl, now).catch(() => null),
  ]);
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
  const view = {
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
    // Goods-surplus sidecar: refreshed with Property, but never a City Record
    // property row or parcel object.
    dcas_vehicle_auctions: dcasVehicleAuctions,
    properties,
  };
  // Disposition spines first (join keys), then commercial payload for surplus-buyer glance.
  return attachPropertyCommercial(attachDispositionSpines(view));
}

export async function refreshProperties(env, fetchImpl = fetch, now = new Date()) {
  if (!env.ALERT_STATE) return { status: "skipped", reason: "no-kv" };
  const view = await buildPropertyView(fetchImpl, now);
  await env.ALERT_STATE.put(PROPERTY_KV_KEY, JSON.stringify(view));
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

export async function handleProperties(request, env, _ctx) {
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders() });
  if (request.method !== "GET") return response(JSON.stringify({ ok: false, reason: "method" }), 405);
  if (!env.ALERT_STATE) return response(JSON.stringify({ ok: false, reason: "not-configured" }), 503);
  const url = new URL(request.url);
  const wantFull = url.searchParams.get("full") === "1" || url.searchParams.get("view") === "full";
  let raw = await env.ALERT_STATE.get(PROPERTY_KV_KEY);
  let parsed = null;
  try { parsed = raw ? JSON.parse(raw) : null; } catch { parsed = null; }
  const age = parsed?.generated_at ? Date.now() - new Date(parsed.generated_at).getTime() : Infinity;
  if (!parsed) return response(JSON.stringify({ ok: false, reason: "snapshot-unavailable" }), 503);
  parsed = { ...parsed, stale: age > MAX_AGE_MS };
  raw = JSON.stringify(parsed);
  if (wantFull) return response(raw);
  // First-paint list: drop body-dump fields (printouts / extra description slots) while keeping
  // additional_description_1 for asset badges and list excerpts.
  const full = parsed || (() => { try { return JSON.parse(raw); } catch { return null; } })();
  if (!full) return response(JSON.stringify({ ok: false, reason: "snapshot-unavailable" }), 503);
  return response(JSON.stringify(slimPropertyListView(full)));
}
