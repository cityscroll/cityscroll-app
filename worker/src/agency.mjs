// GET /agency?name=<City Record agency string> — the agency-identity join.
//
// Every City Record notice carries a free-text agency string. This endpoint resolves it, in
// process, against a static crosswalk bundled with the Worker (worker/src/data/
// agency_crosswalk.json, built by tools/build_agency_crosswalk.mjs) and returns the agency's
// canonical identity card — website, principal officer, organization type, budget code, and
// adopted budget — all sourced from the City's own open data. No live third-party call on the
// request path: the join is an O(1) lookup, so it is safe to edge-cache for a day.
//
// A string the crosswalk never resolved returns matched:false with the provenance intact, so the
// client degrades gracefully (it shows the City Record name with no identity card).

import crosswalk from "./data/agency_crosswalk.json" with { type: "json" };
import { enrichAgency } from "./lib/agency_identity.mjs";

const ALLOW = new Set([
  "https://crol-list.org", "https://www.crol-list.org",
  "https://cityscroll.org", "https://www.cityscroll.org",
  "https://crol-list.jimdc.com", "https://jimdc.github.io",
  "http://localhost:8000", "http://localhost:8787",
]);

// The provenance block, minus the (large) entries map — small enough to return on every response.
const PROVENANCE = crosswalk._provenance || null;

export async function handleAgency(req, env, ctx) {
  const cors = corsHeaders(req.headers.get("origin") || "");
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  if (req.method !== "GET") return json({ ok: false, reason: "method" }, 405, cors);

  const name = new URL(req.url).searchParams.get("name");
  if (!name) return json({ ok: false, reason: "missing-name" }, 400, cors);

  const cache = typeof caches !== "undefined" ? caches.default : null;
  if (cache) {
    const hit = await cache.match(req).catch(() => null);
    if (hit) return withCors(hit, cors);
  }

  const identity = enrichAgency(crosswalk.entries, name);
  // Static join → safe to cache hard at the edge (a day); the bundle only changes on redeploy.
  const res = json(
    { ok: true, agency: name, matched: !!identity, identity: identity || null, provenance: PROVENANCE },
    200, cors, "public, max-age=86400"
  );
  if (cache) {
    const put = cache.put(req, res.clone());
    if (ctx?.waitUntil) ctx.waitUntil(put); else await put.catch(() => {});
  }
  return res;
}

function corsHeaders(origin) {
  const o = ALLOW.has(origin) ? origin : "https://crol-list.org";
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
function json(obj, status, cors, cache) {
  const headers = { ...cors, "Content-Type": "application/json" };
  if (cache) headers["Cache-Control"] = cache;
  return new Response(JSON.stringify(obj), { status, headers });
}
