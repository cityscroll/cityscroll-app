// GET /agencies — public City Record agency-name crosswalk.
//
// One row is published for every distinct agency_name string in the live source. Each row
// keeps that raw spelling and connects it to a stable site id, preferred display name, and
// the complete variant group. The source query, not a checked-in count, sets row_count.

import { buildAgencyCrosswalk, crosswalkCSV } from "./lib/agencies.mjs";

const SODA = "https://data.cityofnewyork.us/resource/dg92-zbpx.json";
const CACHE_SECONDS = 86400;
const DATA_DICTIONARY = "https://cityscroll.org/api.html#agency-crosswalk";

export async function handleAgencies(req, env, ctx) {
  const cors = corsHeaders();
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  if (req.method !== "GET") return text("Method not allowed", 405, cors);

  const url = new URL(req.url);
  const format = url.searchParams.get("format") || "json";
  if (format !== "json" && format !== "csv") {
    return text("format must be json or csv", 400, cors);
  }

  const cache = typeof caches !== "undefined" ? caches.default : null;
  const cacheUrl = new URL("/agencies", req.url);
  if (format === "csv") cacheUrl.searchParams.set("format", "csv");
  const cacheKey = new Request(cacheUrl.toString(), { method: "GET" });
  if (cache) {
    const hit = await cache.match(cacheKey).catch(() => null);
    if (hit) return hit;
  }

  let sourceRows;
  try {
    const params = new URLSearchParams({
      "$select": "agency_name,count(1) as n",
      "$where": "agency_name IS NOT NULL",
      "$group": "agency_name",
      "$order": "agency_name",
      "$limit": "1000",
    });
    const upstream = await fetch(`${SODA}?${params}`);
    if (!upstream.ok) throw new Error(`SODA ${upstream.status}`);
    sourceRows = await upstream.json();
    if (!Array.isArray(sourceRows)) throw new Error("SODA returned a non-array response");
  } catch {
    return text("Agency crosswalk is temporarily unavailable", 502, cors);
  }

  const crosswalk = buildAgencyCrosswalk(sourceRows);
  let res;
  if (format === "csv") {
    res = new Response(crosswalkCSV(crosswalk.rows), {
      status: 200,
      headers: {
        ...cors,
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": 'inline; filename="agency-crosswalk.csv"',
        "Cache-Control": `public, max-age=${CACHE_SECONDS}`,
      },
    });
  } else {
    const body = {
      generated: new Date().toISOString(),
      source: {
        name: "City Record Online",
        dataset: "dg92-zbpx",
        field: "agency_name",
        url: "https://data.cityofnewyork.us/City-Government/City-Record-Online/dg92-zbpx",
      },
      data_dictionary: DATA_DICTIONARY,
      ...crosswalk,
    };
    res = new Response(JSON.stringify(body, null, 2), {
      status: 200,
      headers: {
        ...cors,
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": `public, max-age=${CACHE_SECONDS}`,
      },
    });
  }

  if (cache) {
    const put = cache.put(cacheKey, res.clone());
    if (ctx?.waitUntil) ctx.waitUntil(put); else await put.catch(() => {});
  }
  return res;
}

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
}

function text(body, status, headers) {
  return new Response(body, {
    status,
    headers: { ...headers, "Content-Type": "text/plain; charset=utf-8" },
  });
}
