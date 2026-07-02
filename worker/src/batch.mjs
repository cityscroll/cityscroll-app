// POST /batch — watchlist cross-reference (Datashare's move): submit a list of names, get a
// hit matrix across the City Record. No paid key anywhere; caps + per-IP rate limit are the
// denial-of-wallet posture (each name costs 2 SODA count queries).
//
// Request:  { "names": ["Acme Corp", ...] }        (≤ MAX_NAMES, each ≥3 chars)
// Response: { ok, results: { "<name>": { awards, mentions, entity } } }
//   awards   = award/intent notices naming the vendor (exact name-stem, all years)
//   mentions = full-text hits in recent editions (trailing ~2 years)
//   entity   = site permalink to the vendor profile when awards exist

import { parseNames, MAX_NAMES } from "./lib/batch.mjs";
import { bumpStat } from "./lib/stats.mjs";
import { vendorStem } from "./lib/compile.mjs";

const SODA = "https://data.cityofnewyork.us/resource/dg92-zbpx.json";
const MAX_BATCH_PER_IP_DAY = 30;

const ALLOW = new Set([
  "https://crol-list.org", "https://www.crol-list.org",
  "https://crol-list.jimdc.com", "https://jimdc.github.io",
  "http://localhost:8000", "http://localhost:8787",
]);

export async function handleBatch(req, env) {
  const cors = corsHeaders(req.headers.get("origin") || "");
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  if (req.method !== "POST") return json({ ok: false, reason: "method" }, 405, cors);

  let body;
  try { body = await req.json(); } catch { return json({ ok: false, reason: "bad-json" }, 400, cors); }
  const names = parseNames(body.names);
  if (!names.length) return json({ ok: false, reason: "no-names", max: MAX_NAMES }, 400, cors);

  const ip = req.headers.get("CF-Connecting-IP") || "";
  if (env.NL_METER && ip) {
    const key = `batch:${ip}:${new Date().toISOString().slice(0, 10)}`;
    const n = (Number(await env.NL_METER.get(key)) || 0) + 1;
    await env.NL_METER.put(key, String(n), { expirationTtl: 172800 });
    if (n > MAX_BATCH_PER_IP_DAY) return json({ ok: false, reason: "rate-limited" }, 429, cors);
  }

  await bumpStat(env.ALERT_STATE, "batch", new Date()); // outcome counter (R·B) — aggregate only

  const cut = new Date(Date.now() - 730 * 86400000).toISOString().slice(0, 10) + "T00:00:00";
  const results = {};
  await Promise.all(names.map(async (name) => {
    const stem = vendorStem(name);
    let awards = 0, mentions = 0;
    try {
      // Grouped by exact vendor_name so we can refine the stem-prefix overmatch precisely.
      const variants = await soda({
        "$select": "vendor_name, count(1) as n",
        "$where": `upper(vendor_name) like '${stem.replace(/'/g, "''")}%'`,
        "$group": "vendor_name", "$limit": "100",
      });
      awards = variants.filter(v => vendorStem(v.vendor_name) === stem).reduce((s, v) => s + (+v.n || 0), 0);
    } catch { /* leave 0 */ }
    try {
      const [c] = await soda({ "$select": "count(1) as n", "$where": `start_date > '${cut}'`, "$q": stem });
      mentions = +((c || {}).n) || 0;
    } catch { /* leave 0 */ }
    results[name] = {
      awards, mentions,
      entity: awards > 0 ? `https://crol-list.org/#vendor/${encodeURIComponent(name)}` : null,
    };
  }));

  return json({ ok: true, results }, 200, cors);
}

async function soda(params) {
  const r = await fetch(`${SODA}?${new URLSearchParams(params).toString()}`);
  if (!r.ok) throw new Error(`SODA ${r.status}`);
  return r.json();
}

function corsHeaders(origin) {
  const o = ALLOW.has(origin) ? origin : "https://crol-list.org";
  return {
    "Access-Control-Allow-Origin": o,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Vary": "Origin",
  };
}
function json(obj, status, cors) {
  return new Response(JSON.stringify(obj), { status, headers: { ...cors, "Content-Type": "application/json" } });
}
