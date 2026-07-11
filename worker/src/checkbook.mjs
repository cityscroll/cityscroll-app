// /checkbook — CORS proxy and data pipeline to the Checkbook NYC API.
//
// checkbooknyc.com/api returns no Access-Control-Allow-Origin header, so a browser
// fetch() from crol-list is blocked by CORS. This makes the request server-side and
// re-emits it with CORS headers the browser accepts. No API key — pure CORS shim.
//
// Request shape (POST JSON): { "xml": "<request>...</request>" }
// Build the XML in the browser to keep this proxy schema-agnostic; it just relays.

import { vendorStem } from "./lib/compile.mjs";
import { scoreForecastAccuracy } from "./lib/forecast_score.mjs";

const CHECKBOOK = "https://www.checkbooknyc.com/api";

const ALLOW = new Set([
  "https://crol-list.org",
  "https://www.crol-list.org",
  "https://crol-list.jimdc.com",
  "https://jimdc.github.io",
  "http://localhost:8888",
  "http://localhost:8000",
  "http://localhost:8787", // wrangler dev
]);

export async function handleCheckbook(req) {
  const origin = req.headers.get("origin") || "";
  const cors = corsHeaders(origin);

  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  if (req.method !== "POST") return text("POST only", 405, cors, "text/plain");

  let body = {};
  try { body = await req.json(); } catch { /* ignore */ }
  const xml = typeof body.xml === "string" ? body.xml : "";
  if (!xml) return text("Provide { xml } — the Checkbook request body.", 400, cors, "text/plain");

  try {
    const r = await fetch(CHECKBOOK, {
      method: "POST",
      headers: { "Content-Type": "application/xml" },
      body: xml,
    });
    const out = await r.text();
    return text(out, r.status, cors, "application/xml");
  } catch (e) {
    return text(`Upstream error: ${String(e?.message || e)}`, 502, cors, "text/plain");
  }
}

function corsHeaders(origin) {
  const o = ALLOW.has(origin) ? origin : "https://crol-list.jimdc.com";
  return {
    "Access-Control-Allow-Origin": o,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Vary": "Origin",
  };
}

function text(s, status, cors, type) {
  return new Response(s, { status, headers: { ...cors, "Content-Type": type } });
}

// ============================================================================
// PIPELINE & UTILITIES (Wave 5: Forecasting)
// ============================================================================

export function parseCheckbookTransactions(xml) {
  const transactions = [];
  const matches = xml.matchAll(/<transaction>([\s\S]*?)<\/transaction>/g);
  for (const m of matches) {
    const txXml = m[1];
    const g = (tag) => {
      const match = txXml.match(new RegExp(`<${tag}>([^<]*)</${tag}>`));
      return match ? match[1].trim() : "";
    };
    transactions.push({
      id: g("prime_contract_id"),
      vendor: g("prime_vendor"),
      current: parseFloat(g("prime_contract_current_amount")) || 0,
      original: parseFloat(g("prime_contract_original_amount")) || 0,
      spent: parseFloat(g("prime_vendor_spent_to_date")) || 0,
      start: g("prime_contract_start_date"),
      end: g("prime_contract_end_date"),
      registered: g("prime_contract_registration_date"),
      mwbe: g("prime_vendor_mwbe_category"),
      subs: g("contract_includes_sub_vendors"),
      duration: g("prime_contract_duration") || g("prime_contract_term")
    });
  }
  return transactions;
}

export function addDuration(dateStr, durationStr) {
  const date = new Date(dateStr);
  if (isNaN(date.getTime())) return null;
  const num = parseInt(durationStr);
  if (isNaN(num)) return null;
  if (/year/i.test(durationStr)) {
    date.setUTCFullYear(date.getUTCFullYear() + num);
  } else if (/month/i.test(durationStr)) {
    date.setUTCMonth(date.getUTCMonth() + num);
  } else {
    // Default to years if no unit specified
    date.setUTCFullYear(date.getUTCFullYear() + num);
  }
  return date.toISOString().slice(0, 10);
}

export function calculateWarningDate(expirationDateStr) {
  const date = new Date(expirationDateStr);
  if (isNaN(date.getTime())) return null;
  date.setUTCDate(date.getUTCDate() - 180);
  return date.toISOString().slice(0, 10);
}

export function getWatchedStems(watches, subs) {
  const stems = new Set();
  for (const w of watches || []) {
    if (w.agency) stems.add(vendorStem(w.agency));
    if (w.vendor) stems.add(vendorStem(w.vendor));
    if (w.label) {
      const match = w.label.match(/^([A-Z]{3,})/i);
      if (match) stems.add(vendorStem(match[1]));
    }
  }
  for (const s of subs || []) {
    if (s.lens === "entity" && s.filter) {
      if (s.filter.name) stems.add(vendorStem(s.filter.name));
    }
    if (s.lens === "money" && s.filter) {
      if (s.filter.agency) stems.add(vendorStem(s.filter.agency));
    }
  }
  return [...stems].filter((s) => s.length >= 3);
}

export async function runCheckbookPipeline(env, watches, subs) {
  const watchedStems = getWatchedStems(watches, subs);
  if (watchedStems.length === 0) return { status: "no-watches" };

  const ninetyDaysAgo = new Date();
  ninetyDaysAgo.setDate(ninetyDaysAgo.getDate() - 180);
  const dateStr = ninetyDaysAgo.toISOString().slice(0, 10);

  const params = new URLSearchParams({
    "$select": "request_id,start_date,agency_name,vendor_name,pin,contract_amount",
    "$where": `type_of_notice_description='Award' AND start_date >= '${dateStr}' AND pin IS NOT NULL`,
    "$order": "start_date DESC",
    "$limit": "500"
  });

  const SODA = "https://data.cityofnewyork.us/resource/dg92-zbpx.json";
  const r = await fetch(`${SODA}?${params.toString()}`);
  if (!r.ok) {
    return { error: `SODA status ${r.status}` };
  }

  const awards = await r.json();
  const stemsMap = new Map();
  for (const a of awards) {
    if (!a.pin || !a.agency_name) continue;
    const agencyStem = vendorStem(a.agency_name);
    if (watchedStems.includes(agencyStem)) {
      if (!stemsMap.has(agencyStem)) {
        stemsMap.set(agencyStem, new Set());
      }
      stemsMap.get(agencyStem).add(a.pin);
    }
  }

  const results = {};
  for (const [stem, pins] of stemsMap.entries()) {
    const forecasts = [];
    for (const pin of pins) {
      try {
        const cleanPin = pin.replace(/[<>&'"]/g, "");
        const xml = `<request><type_of_data>Contracts</type_of_data><records_from>1</records_from><max_records>10</max_records><search_criteria>`
          + `<criteria><name>status</name><type>value</type><value>registered</value></criteria>`
          + `<criteria><name>category</name><type>value</type><value>expense</value></criteria>`
          + `<criteria><name>pin</name><type>value</type><value>${cleanPin}</value></criteria>`
          + `</search_criteria></request>`;

        const res = await fetch(CHECKBOOK, {
          method: "POST",
          headers: { "Content-Type": "application/xml" },
          body: xml
        });

        if (!res.ok) continue;
        const out = await res.text();
        const txs = parseCheckbookTransactions(out);
        
        for (const tx of txs) {
          if (!tx.registered) continue;
          
          let expirationDate = tx.end;
          if (!expirationDate) {
            const duration = tx.duration || "3 Years";
            expirationDate = addDuration(tx.registered, duration);
          }

          if (!expirationDate) continue;
          const warningDate = calculateWarningDate(expirationDate);
          
          forecasts.push({
            contract_id: tx.id,
            vendor_name: tx.vendor,
            agency_name: tx.agency || stem, 
            amount: tx.current || tx.original,
            registration_date: tx.registered,
            expiration_date: expirationDate,
            warning_date: warningDate,
            source: "checkbook"
          });
        }
      } catch (e) {
        // ignore individual pin failures
      }
    }

    if (forecasts.length > 0) {
      forecasts.sort((a, b) => a.expiration_date.localeCompare(b.expiration_date));
      if (env.ALERT_STATE) {
        await env.ALERT_STATE.put(`fc:${stem}`, JSON.stringify(forecasts));
      }
      results[stem] = forecasts.length;
    }
  }

  return { status: "success", updated: results };
}

export async function handleForecast(req, env) {
  const origin = req.headers.get("origin") || "";
  const cors = {
    "Access-Control-Allow-Origin": ALLOW.has(origin) ? origin : "https://crol-list.org",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Vary": "Origin"
  };

  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  if (req.method !== "GET") return new Response("GET only", { status: 405, headers: cors });

  const { searchParams } = new URL(req.url);
  const q = searchParams.get("q") || "";
  const stem = vendorStem(q);

  const forecasts = [];
  if (env.ALERT_STATE && stem.length >= 3) {
    const fcRaw = await env.ALERT_STATE.get(`fc:${stem}`);
    const planRaw = await env.ALERT_STATE.get(`plan:${stem}`);
    if (fcRaw) forecasts.push(...JSON.parse(fcRaw));
    if (planRaw) forecasts.push(...JSON.parse(planRaw));

    try {
      const fcList = await env.ALERT_STATE.list({ prefix: `fc:${stem}` });
      for (const key of fcList.keys) {
        if (key.name === `fc:${stem}`) continue;
        const raw = await env.ALERT_STATE.get(key.name);
        if (raw) forecasts.push(...JSON.parse(raw));
      }
      const planList = await env.ALERT_STATE.list({ prefix: `plan:${stem}` });
      for (const key of planList.keys) {
        if (key.name === `plan:${stem}`) continue;
        const raw = await env.ALERT_STATE.get(key.name);
        if (raw) forecasts.push(...JSON.parse(raw));
      }
    } catch (e) {
      // ignore list errors
    }
  }

  // Sort forecasts chronologically by predicted expiration/warning/quarter
  forecasts.sort((a, b) => {
    const dateA = a.expiration_date || a.release_quarter || "";
    const dateB = b.expiration_date || b.release_quarter || "";
    return dateA.localeCompare(dateB);
  });

  return new Response(JSON.stringify(forecasts), {
    status: 200,
    headers: { ...cors, "Content-Type": "application/json" }
  });
}

// ============================================================================
// GET /forecast/accuracy  (w6-07 — forecast accuracy scoring)
//
// Public, no secrets. Scores how often fc:* / plan:* predictions from ALERT_STATE
// matched an actual Solicitation in the D1 mirror within ±30 days.
// Cached in KV for ~6 hours to avoid hammering D1 on every request.
// Requires both env.DB (D1) and env.ALERT_STATE (KV) to be bound; returns a
// scored=0 result with a note when either is absent.
// ============================================================================
const ACCURACY_CACHE_KEY = "forecast_accuracy_cache";
const ACCURACY_CACHE_TTL = 6 * 3600; // 6 hours

export async function handleForecastAccuracy(req, env) {
  const origin = req.headers.get("origin") || "";
  const cors = {
    "Access-Control-Allow-Origin": ALLOW.has(origin) ? origin : "https://crol-list.org",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Vary": "Origin",
  };

  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  if (req.method !== "GET") return new Response("GET only", { status: 405, headers: cors });

  // Try the KV cache first (6-hour TTL avoids hammering D1 on every request)
  if (env.ALERT_STATE) {
    try {
      const cached = await env.ALERT_STATE.get(ACCURACY_CACHE_KEY);
      if (cached) {
        return new Response(cached, {
          status: 200,
          headers: { ...cors, "Content-Type": "application/json", "X-Cache": "HIT" },
        });
      }
    } catch { /* cache miss → compute fresh */ }
  }

  // Missing bindings → honest empty result, never an error
  if (!env.DB || !env.ALERT_STATE) {
    const empty = { scored: 0, hits: 0, hit_rate: null, window_days: 30, note: "D1 or KV not bound" };
    return new Response(JSON.stringify(empty), {
      status: 200,
      headers: { ...cors, "Content-Type": "application/json" },
    });
  }

  const todayISO = new Date().toISOString().slice(0, 10);
  const result = await scoreForecastAccuracy(env, env.DB, todayISO);

  const body = JSON.stringify(result);
  // Write back to cache (fail-soft: a cache write failure must never break the response)
  try {
    await env.ALERT_STATE.put(ACCURACY_CACHE_KEY, body, { expirationTtl: ACCURACY_CACHE_TTL });
  } catch { /* ignore */ }

  return new Response(body, {
    status: 200,
    headers: { ...cors, "Content-Type": "application/json", "X-Cache": "MISS" },
  });
}
