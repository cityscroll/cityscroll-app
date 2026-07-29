// Contract lifecycle precompute + cache + endpoint (PROC-001).
//
// Joins a City Record solicitation/award notice to Checkbook NYC's pending, registered,
// and spending records, assembling a bounded procurement timeline with explicit
// unmatched/ambiguous states. The lifecycle is computed once per notice, cached in D1
// (contract_lifecycle), and served by GET /contract-lifecycle?id=<request_id>.
//
// Architecture (mirrors prior_cycle.mjs and external_award.mjs):
//   - compute-on-miss: first request computes the lifecycle from Checkbook, caches it
//   - bounded daily prewarm: cron pre-warms freshly-ingested Award notices (≤40/run)
//   - edge cache: 5-minute Cache-Control on successful responses
//   - fail-soft: a Checkbook/proxy error → ok:false, no-store, not cached
//
// The Checkbook lookups use the same XML API pattern as checkbook.mjs and
// external_award.mjs: POST application/xml to checkbooknyc.com/api with a search
// criteria block. One logical lookup per domain per notice (paginated, capped).

import {
  parseContractTransactions,
  parseSpendingTransactions,
  assembleLifecycle,
  pinMatchStrategy,
  usablePin,
  checkbookSuccess,
} from "./lib/checkbook_lifecycle.mjs";

const CHECKBOOK = "https://www.checkbooknyc.com/api";
const SODA_NYC = "https://data.cityofnewyork.us/resource/dg92-zbpx.json";

const PAGE_SIZE = 25;
const MAX_PAGES = 4; // 4 × 25 = 100 records cap per domain per notice
const PREWARM_MAX = 40;

function escXml(s) {
  return String(s).replace(/[<>&'"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", '"': "&quot;" }[c]));
}

function sq(s) { return String(s || "").replace(/'/g, "''"); }

// ---------------------------------------------------------------------------
// Checkbook XML requests (paginated, capped)
// ---------------------------------------------------------------------------

function contractsRequestXml(pin, status, from) {
  return `<request><type_of_data>Contracts</type_of_data><records_from>${from}</records_from><max_records>${PAGE_SIZE}</max_records><search_criteria>`
    + `<criteria><name>status</name><type>value</type><value>${status}</value></criteria>`
    + `<criteria><name>category</name><type>value</type><value>expense</value></criteria>`
    + `<criteria><name>pin</name><type>value</type><value>${escXml(pin)}</value></criteria>`
    + `</search_criteria></request>`;
}

function spendingRequestXml(pin, from) {
  return `<request><type_of_data>Spending</type_of_data><records_from>${from}</records_from><max_records>${PAGE_SIZE}</max_records><search_criteria>`
    + `<criteria><name>pin</name><type>value</type><value>${escXml(pin)}</value></criteria>`
    + `</search_criteria></request>`;
}

// Fetch all pages for a Checkbook domain query (capped at MAX_PAGES).
// Returns { records, ok }: ok=false means the lookup failed (proxy/WAF error).
async function fetchCheckbookDomain(requestFn) {
  const records = [];
  for (let page = 0; page < MAX_PAGES; page++) {
    const from = page * PAGE_SIZE + 1;
    let text;
    try {
      const r = await fetch(CHECKBOOK, {
        method: "POST",
        headers: { "Content-Type": "application/xml" },
        body: requestFn(from),
      });
      if (!r.ok) return { records: [], ok: false };
      text = await r.text();
    } catch {
      return { records: [], ok: false };
    }
    if (!checkbookSuccess(text)) return { records: [], ok: false };
    const txs = parseContractTransactions(text);
    records.push(...txs);
    if (txs.length < PAGE_SIZE) return { records, ok: true };
  }
  return { records, ok: true, capped: true }; // hit the page cap
}

// Fetch all spending pages (same pattern, different parser).
async function fetchCheckbookSpending(pin) {
  const records = [];
  for (let page = 0; page < MAX_PAGES; page++) {
    const from = page * PAGE_SIZE + 1;
    let text;
    try {
      const r = await fetch(CHECKBOOK, {
        method: "POST",
        headers: { "Content-Type": "application/xml" },
        body: spendingRequestXml(pin, from),
      });
      if (!r.ok) return { records: [], ok: false };
      text = await r.text();
    } catch {
      return { records: [], ok: false };
    }
    if (!checkbookSuccess(text)) return { records: [], ok: false };
    const txs = parseSpendingTransactions(text);
    records.push(...txs);
    if (txs.length < PAGE_SIZE) return { records, ok: true };
  }
  return { records, ok: true, capped: true };
}

// ---------------------------------------------------------------------------
// Notice resolution (D1 mirror → SODA fallback)
// ---------------------------------------------------------------------------

export async function fetchNoticeRow(env, requestId) {
  if (env.DB) {
    try {
      const row = await env.DB.prepare(
        `SELECT request_id, start_date, agency AS agency_name, type_of_notice AS type_of_notice_description,
                short_title, pin, contract_amount, vendor_name
           FROM notices WHERE request_id = ?`,
      ).bind(requestId).first();
      if (row) return row;
    } catch { /* fall through to SODA */ }
  }
  try {
    const params = new URLSearchParams({
      "$select": "request_id,start_date,agency_name,type_of_notice_description,short_title,pin,contract_amount,vendor_name",
      "$where": `request_id='${sq(requestId)}'`,
      "$limit": "1",
    });
    const r = await fetch(`${SODA_NYC}?${params}`);
    if (!r.ok) return null;
    const rows = await r.json();
    return Array.isArray(rows) && rows.length ? rows[0] : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Lifecycle computation
// ---------------------------------------------------------------------------

// Compute the full procurement lifecycle for one notice.
// Returns { lifecycle, ok }: ok=false when the notice is unresolvable or all Checkbook
// lookups fail. A notice without a usable PIN returns a lifecycle with all Checkbook
// stages marked "unknown" — the reader sees an explicit statement, not a blank.
export async function computeLifecycle(env, requestId, noticeRow) {
  const r = noticeRow === undefined ? await fetchNoticeRow(env, requestId) : noticeRow;
  if (!r) return { lifecycle: null, ok: false };

  const { pins, strategy } = pinMatchStrategy(r.pin);
  if (pins.length === 0) {
    return {
      lifecycle: assembleLifecycle(r, [], [], [], {
        pinStrategy: "none",
        lookupStatus: { pending: "error", registered: "error", spending: "error" },
      }),
      ok: true,
    };
  }

  // Try each PIN (exact first, then legacy base). Use the first PIN that returns results.
  let pin = pins[0];
  let pinStrategyUsed = strategy;
  let pending = { records: [], ok: false };
  let registered = { records: [], ok: false };
  let spending = { records: [], ok: false };

  for (const candidatePin of pins) {
    const [p, reg, spend] = await Promise.all([
      fetchCheckbookDomain((from) => contractsRequestXml(candidatePin, "pending", from)),
      fetchCheckbookDomain((from) => contractsRequestXml(candidatePin, "registered", from)),
      fetchCheckbookSpending(candidatePin),
    ]);

    // If exact PIN has any results, use them. If exact fails but base has results, use base.
    const hasResults = p.records.length > 0 || reg.records.length > 0 || spend.records.length > 0;
    if (hasResults || candidatePin === pins[pins.length - 1]) {
      pending = p;
      registered = reg;
      spending = spend;
      pin = candidatePin;
      pinStrategyUsed = candidatePin === pins[0] ? "exact" : "legacy-base";
      break;
    }
  }

  const lookupStatus = {
    pending: pending.ok ? "ok" : "error",
    registered: registered.ok ? "ok" : "error",
    spending: spending.ok ? "ok" : "error",
  };

  const lifecycle = assembleLifecycle(r, pending.records, registered.records, spending.records, {
    pinStrategy: pinStrategyUsed,
    lookupStatus,
  });

  return { lifecycle, ok: true };
}

// ---------------------------------------------------------------------------
// D1 cache (contract_lifecycle table)
// ---------------------------------------------------------------------------

async function cacheGet(env, requestId) {
  if (!env.DB) return null;
  try {
    const row = await env.DB.prepare(
      "SELECT lifecycle FROM contract_lifecycle WHERE request_id = ?",
    ).bind(requestId).first();
    if (row && row.lifecycle) {
      const m = JSON.parse(row.lifecycle);
      if (m && Array.isArray(m.timeline)) return m;
    }
  } catch { /* miss */ }
  return null;
}

async function cachePut(env, requestId, agency, lifecycle) {
  if (!env.DB) return;
  try {
    await env.DB.prepare(
      `INSERT OR REPLACE INTO contract_lifecycle (request_id, agency, lifecycle, computed_at)
         VALUES (?, ?, ?, ?)`,
    ).bind(requestId, agency || null, JSON.stringify(lifecycle), new Date().toISOString()).run();
  } catch { /* a cache-write failure must never break the compute */ }
}

// Read the D1 cache; on a miss, compute, upsert, and return. Only a fully-successful
// compute for a resolvable notice is cached. Fail-soft: never throws.
export async function getOrCompute(env, requestId) {
  const cached = await cacheGet(env, requestId);
  if (cached) return { lifecycle: cached, ok: true };

  const { lifecycle, ok } = await computeLifecycle(env, requestId);
  if (ok && lifecycle) {
    // Only cache when all Checkbook lookups completed (ok flag on the lifecycle itself)
    if (lifecycle.ok) {
      const row = await fetchNoticeRow(env, requestId).catch(() => null);
      await cachePut(env, requestId, row && row.agency_name, lifecycle);
    }
  }
  return { lifecycle, ok };
}

// ---------------------------------------------------------------------------
// Bounded daily prewarm
// ---------------------------------------------------------------------------

export async function prewarmContractLifecycle(env, requestIds) {
  const ids = Array.isArray(requestIds) ? [...new Set(requestIds.filter(Boolean))].slice(0, PREWARM_MAX) : [];
  let computed = 0, skipped = 0, failed = 0;
  for (const id of ids) {
    try {
      if (await cacheGet(env, id)) { skipped++; continue; }
      const { lifecycle, ok } = await computeLifecycle(env, id);
      if (!ok || !lifecycle) { failed++; continue; }
      if (lifecycle.ok) {
        const row = await fetchNoticeRow(env, id).catch(() => null);
        await cachePut(env, id, row && row.agency_name, lifecycle);
      }
      computed++;
    } catch {
      failed++;
    }
  }
  return { requested: ids.length, computed, skipped, failed };
}

// ---------------------------------------------------------------------------
// GET /contract-lifecycle?id=<request_id>
// ---------------------------------------------------------------------------

const ALLOW = new Set([
  "https://cityscroll.org", "https://www.cityscroll.org",
  "https://crol-list.org", "https://www.crol-list.org",
  "https://crol-list.jimdc.com", "https://jimdc.github.io",
  "http://localhost:8000", "http://localhost:8787",
]);

function corsHeaders(origin) {
  const o = ALLOW.has(origin) ? origin : "https://cityscroll.org";
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

export async function handleContractLifecycle(req, env, ctx) {
  const cors = corsHeaders(req.headers.get("origin") || "");
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  if (req.method !== "GET") {
    return new Response(JSON.stringify({ ok: false, reason: "method" }), {
      status: 405, headers: { ...cors, "Content-Type": "application/json" },
    });
  }

  const url = new URL(req.url);
  const rawId = url.searchParams.get("id");
  if (!rawId) {
    return new Response(JSON.stringify({ ok: false, reason: "missing-id" }), {
      status: 400, headers: { ...cors, "Content-Type": "application/json" },
    });
  }
  if (!/^[A-Za-z0-9_-]{4,40}$/.test(rawId)) {
    return new Response(JSON.stringify({ ok: false, reason: "bad-id" }), {
      status: 400, headers: { ...cors, "Content-Type": "application/json" },
    });
  }

  // Edge cache (5-minute TTL on success)
  const cache = typeof caches !== "undefined" ? caches.default : null;
  if (cache) {
    const hit = await cache.match(req).catch(() => null);
    if (hit) return withCors(hit, cors);
  }

  const { lifecycle, ok } = await getOrCompute(env, rawId);

  if (!ok || !lifecycle) {
    return new Response(JSON.stringify({ id: rawId, ok: false }), {
      status: 200,
      headers: { ...cors, "Content-Type": "application/json", "Cache-Control": "no-store" },
    });
  }

  const body = JSON.stringify({ id: rawId, ...lifecycle });
  const res = new Response(body, {
    status: 200,
    headers: {
      ...cors, "Content-Type": "application/json",
      "Cache-Control": lifecycle.ok ? "public, max-age=300" : "no-store",
    },
  });

  if (cache && lifecycle.ok) {
    const put = cache.put(req, res.clone());
    if (ctx?.waitUntil) ctx.waitUntil(put);
    else await put.catch(() => {});
  }

  return res;
}
