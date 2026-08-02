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
import {
  dualWriteCheckbookContractObservations,
  dualWriteCheckbookSpendingObservations,
} from "./lib/checkbook_source_records.mjs";
import { enrichLifecycleWithPassport } from "./lib/passport_lifecycle.mjs";
import { lookupPassportForPin } from "./passport.mjs";
import { CURRENT_SOLICITATIONS_DATASET } from "./lib/current_solicitations.mjs";
import {
  joinOcpAward,
  attachOcpAward,
  OCP_DATASET_ID,
} from "./lib/ocp_awards.mjs";
import { lookupOcpFromWarehouseMaterialization } from "./lib/ocp_warehouse_lookup.mjs";
import { attachMoneyCivicEvents } from "./lib/civic_time.mjs";

const CHECKBOOK = "https://www.checkbooknyc.com/api";
const SODA_NYC = "https://data.cityofnewyork.us/resource/dg92-zbpx.json";
const SODA_CURRENT_SOLICITATIONS =
  `https://data.cityofnewyork.us/resource/${CURRENT_SOLICITATIONS_DATASET}.json`;
// Recent Contract Awards (OCP) — Open Data side-car for award date/amount corroboration.
const SODA_OCP = `https://data.cityofnewyork.us/resource/${OCP_DATASET_ID}.json`;

const PAGE_SIZE = 25;
const MAX_PAGES = 4; // 4 × 25 = 100 records cap per domain per notice
const PREWARM_MAX = 40;
const OCP_PIN_LIMIT = 10;

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

// Spending domain rejects `pin` (Checkbook code 1101). Valid filters include contract_id,
// payee_name, fiscal_year, … — join payments by the registered/pending contract id.
function spendingRequestXml(contractId, from) {
  return `<request><type_of_data>Spending</type_of_data><records_from>${from}</records_from><max_records>${PAGE_SIZE}</max_records><search_criteria>`
    + `<criteria><name>contract_id</name><type>value</type><value>${escXml(contractId)}</value></criteria>`
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

// Fetch all spending pages for one contract id (same pattern, different parser).
async function fetchCheckbookSpendingForContract(contractId) {
  const records = [];
  for (let page = 0; page < MAX_PAGES; page++) {
    const from = page * PAGE_SIZE + 1;
    let text;
    try {
      const r = await fetch(CHECKBOOK, {
        method: "POST",
        headers: { "Content-Type": "application/xml" },
        body: spendingRequestXml(contractId, from),
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

// Spending is keyed by contract_id (not PIN). Pull each known id (bounded) and merge.
// No contract ids yet → empty success (nothing to query; not a feed error).
const MAX_SPENDING_CONTRACTS = 5;
async function fetchCheckbookSpendingByContractIds(contractIds) {
  const ids = [...new Set((contractIds || []).filter(Boolean))].slice(0, MAX_SPENDING_CONTRACTS);
  if (!ids.length) return { records: [], ok: true };
  const records = [];
  let anyOk = false;
  for (const id of ids) {
    const page = await fetchCheckbookSpendingForContract(id);
    if (page.ok) {
      anyOk = true;
      records.push(...page.records);
    }
  }
  // Partial success counts as ok so one bad id does not mask the rest; total failure → error.
  return { records, ok: anyOk };
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

// City Record procurement notice types that map onto the money-chain stages
// (solicitation → intermediates → award). Used when gathering PIN-siblings.
const PROCUREMENT_NOTICE_TYPES = [
  "Solicitation",
  "Intent to Negotiate",
  "Vendor List",
  "Intent to Award",
  "Award",
];

const RELATED_NOTICE_SELECT =
  "request_id,start_date,agency_name,type_of_notice_description,short_title,pin,contract_amount,vendor_name";
const RELATED_NOTICE_LIMIT = 25;

/**
 * Fetch City Record notices that share this notice's PIN so intermediate stages
 * (Intent to Award, Vendor List, Intent to Negotiate) can reconstruct on the
 * money chain. Fail-soft: empty array on miss / error (timeline still uses the
 * focal notice alone).
 *
 * @returns {Promise<object[]>}
 */
export async function fetchRelatedProcurementNotices(env, noticeRow) {
  const r = noticeRow || {};
  const pin = String(r.pin || "").trim();
  if (!usablePin(pin)) return [];
  const focalId = r.request_id != null ? String(r.request_id) : null;
  const typeList = PROCUREMENT_NOTICE_TYPES.map((t) => `'${sq(t)}'`).join(",");

  // D1 mirror first (same path as fetchNoticeRow).
  if (env?.DB) {
    try {
      const rows = await env.DB.prepare(
        `SELECT request_id, start_date, agency AS agency_name, type_of_notice AS type_of_notice_description,
                short_title, pin, contract_amount, vendor_name
           FROM notices
          WHERE pin = ?
            AND type_of_notice IN (${PROCUREMENT_NOTICE_TYPES.map(() => "?").join(",")})
          ORDER BY start_date ASC
          LIMIT ?`,
      ).bind(pin, ...PROCUREMENT_NOTICE_TYPES, RELATED_NOTICE_LIMIT).all();
      const list = (rows && rows.results) || rows || [];
      if (Array.isArray(list) && list.length) {
        return list.filter((row) => !focalId || String(row.request_id) !== focalId);
      }
    } catch { /* fall through to SODA */ }
  }

  try {
    const params = new URLSearchParams({
      $select: RELATED_NOTICE_SELECT,
      $where: `pin='${sq(pin)}' AND type_of_notice_description IN (${typeList})`,
      $order: "start_date",
      $limit: String(RELATED_NOTICE_LIMIT),
    });
    const res = await fetch(`${SODA_NYC}?${params}`);
    if (!res.ok) return [];
    const rows = await res.json();
    if (!Array.isArray(rows)) return [];
    return rows.filter((row) => !focalId || String(row.request_id) !== focalId);
  } catch {
    return [];
  }
}


// ---------------------------------------------------------------------------
// OCP Recent Contract Awards (qyyg-4tf5) side-car fetch
// ---------------------------------------------------------------------------

// Fetch OCP award rows for a notice: warehouse materialization first (WH-03),
// then live SODA on miss. Bounded, fail-soft.
// Returns { ok, rows, lookup_path?: "warehouse"|"soda" }.
export async function fetchOcpAwardRows(noticeRow) {
  const r = noticeRow || {};

  // WH-03: instant hit from warehouse materialization index (no network).
  const wh = lookupOcpFromWarehouseMaterialization(r);
  if (wh.hit) {
    return { ok: true, rows: wh.rows, lookup_path: "warehouse" };
  }

  // Live SODA fallback when the materialization lacks this request_id/pin.
  const rows = [];
  const seen = new Set();

  async function pull(where, limit) {
    try {
      const params = new URLSearchParams({
        $select: "request_id,start_date,agency_name,type_of_notice_description,short_title,pin,contract_amount,vendor_name",
        $where: where,
        $limit: String(limit),
      });
      const resp = await fetch(`${SODA_OCP}?${params}`);
      if (!resp.ok) return { ok: false, rows: [] };
      const data = await resp.json();
      if (!Array.isArray(data)) return { ok: false, rows: [] };
      return { ok: true, rows: data };
    } catch {
      return { ok: false, rows: [] };
    }
  }

  let anyOk = false;
  if (r.request_id) {
    const byId = await pull(`request_id='${sq(r.request_id)}'`, 5);
    if (byId.ok) anyOk = true;
    else return { ok: false, rows: [], lookup_path: "soda" };
    for (const row of byId.rows) {
      const key = row.request_id || JSON.stringify(row);
      if (!seen.has(key)) { seen.add(key); rows.push(row); }
    }
  }

  if (!rows.length && r.pin) {
    const byPin = await pull(`pin='${sq(r.pin)}'`, OCP_PIN_LIMIT);
    if (byPin.ok) anyOk = true;
    else return { ok: false, rows: [], lookup_path: "soda" };
    for (const row of byPin.rows) {
      const key = row.request_id || JSON.stringify(row);
      if (!seen.has(key)) { seen.add(key); rows.push(row); }
    }
  } else if (!r.request_id && !r.pin) {
    return { ok: true, rows: [], lookup_path: "warehouse" };
  }

  return {
    ok: anyOk || (!r.request_id && !r.pin),
    rows,
    lookup_path: "soda",
  };
}

// ---------------------------------------------------------------------------
// Current Solicitations (3khw-qi8f) — package enrichment lookup
// ---------------------------------------------------------------------------

// Bounded SODA fetch for rows that may join this notice (request_id first, then pin).
// Fail-soft: network/HTTP errors → { status: "error", rows: [] } so the timeline keeps
// City Record + Checkbook stages and marks the documents sub-slot unknown.
const CS_SELECT = [
  "request_id", "start_date", "agency_name", "type_of_notice_description",
  "short_title", "selection_method_description", "pin", "due_date",
  "contact_name", "contact_phone", "email", "address_to_request", "document_links",
].join(",");

export async function fetchCurrentSolicitationRows(noticeRow) {
  const r = noticeRow || {};
  const rows = [];
  const seen = new Set();

  async function pull(where, limit = 10) {
    const params = new URLSearchParams({
      "$select": CS_SELECT,
      "$where": where,
      "$limit": String(limit),
    });
    const res = await fetch(`${SODA_CURRENT_SOLICITATIONS}?${params}`);
    if (!res.ok) throw new Error(`current-solicitations SODA ${res.status}`);
    const data = await res.json();
    if (!Array.isArray(data)) throw new Error("current-solicitations SODA non-array");
    for (const row of data) {
      const key = row && row.request_id != null ? String(row.request_id) : JSON.stringify(row);
      if (seen.has(key)) continue;
      seen.add(key);
      rows.push(row);
    }
  }

  try {
    if (r.request_id) {
      await pull(`request_id='${sq(r.request_id)}'`, 5);
    }
    // Also gather pin-siblings when a usable PIN is present (award → prior solicitation).
    if (usablePin(r.pin) && rows.length === 0) {
      await pull(`pin='${sq(r.pin)}'`, 15);
    }
    return { status: "ok", rows };
  } catch {
    return { status: "error", rows: [] };
  }
}

// ---------------------------------------------------------------------------
// Lifecycle computation
// ---------------------------------------------------------------------------

// Compute the full procurement lifecycle for one notice.
// Returns { lifecycle, ok }: ok=false when the notice is unresolvable or all Checkbook
// lookups fail. A notice without a usable PIN returns a lifecycle with all Checkbook
// stages marked "unknown" — the reader sees an explicit statement, not a blank.
// Current Solicitations enrichment is fail-soft and does not flip lifecycle.ok.
// Always attaches an OCP award side-car (matched / unmatched / unknown / ambiguous).
export async function computeLifecycle(env, requestId, noticeRow) {
  const r = noticeRow === undefined ? await fetchNoticeRow(env, requestId) : noticeRow;
  if (!r) return { lifecycle: null, ok: false };

  // Kick off Open Data enrichments + PIN-sibling City Record notices in parallel
  // with Checkbook work. Related notices fill intermediate stages (Intent to Award…).
  const csPromise = fetchCurrentSolicitationRows(r);
  const ocpPromise = fetchOcpAwardRows(r);
  const relatedPromise = fetchRelatedProcurementNotices(env, r);

  const { pins, strategy } = pinMatchStrategy(r.pin);
  if (pins.length === 0) {
    // No PIN → not a transient Checkbook failure. Stages are not_applicable; the
    // renderer collapses them into the single class-(b) no-PIN note.
    // Current Solicitations / OCP may still join by request_id.
    // No PIN → no related PIN-siblings (relatedPromise still resolves empty).
    const [currentSolicitation, ocpFetch, relatedNotices] = await Promise.all([
      csPromise, ocpPromise, relatedPromise,
    ]);
    const ocpAward = joinOcpAward(r, ocpFetch.rows, {
      lookupStatus: ocpFetch.ok ? "ok" : "error",
    });
    if (ocpFetch.lookup_path) ocpAward.lookup_path = ocpFetch.lookup_path;
    let noPinLifecycle = attachOcpAward(
      assembleLifecycle(r, [], [], [], {
        pinStrategy: "none",
        lookupStatus: { pending: "skip", registered: "skip", spending: "skip" },
        currentSolicitation,
        relatedNotices,
      }),
      ocpAward,
    );
    noPinLifecycle = attachMoneyCivicEvents(noPinLifecycle, r, {
      processed_at: new Date().toISOString(),
      run_id: `contract-lifecycle:${requestId}`,
    });
    return { lifecycle: noPinLifecycle, ok: true };
  }

  // Try each PIN (exact first, then legacy base). Use the first PIN that returns results.
  // Spending is fetched second: Checkbook Spending rejects PIN filters (code 1101) and only
  // accepts contract_id / payee / etc. — so we need contract ids from the Contracts domain first.
  let pin = pins[0];
  let pinStrategyUsed = strategy;
  let pending = { records: [], ok: false };
  let registered = { records: [], ok: false };
  let spending = { records: [], ok: false };

  for (const candidatePin of pins) {
    const [p, reg] = await Promise.all([
      fetchCheckbookDomain((from) => contractsRequestXml(candidatePin, "pending", from)),
      fetchCheckbookDomain((from) => contractsRequestXml(candidatePin, "registered", from)),
    ]);

    // If exact PIN has any contract results, use them. If exact fails but base has results, use base.
    const hasResults = p.records.length > 0 || reg.records.length > 0;
    if (hasResults || candidatePin === pins[pins.length - 1]) {
      pending = p;
      registered = reg;
      pin = candidatePin;
      pinStrategyUsed = candidatePin === pins[0] ? "exact" : "legacy-base";
      const contractIds = [
        ...reg.records.map((r) => r.id).filter(Boolean),
        ...p.records.map((r) => r.id).filter(Boolean),
      ];
      // Contracts failed with no ids → spending cannot be queried honestly (not "empty paid").
      if (!contractIds.length && (!p.ok || !reg.ok)) {
        spending = { records: [], ok: false };
      } else {
        spending = await fetchCheckbookSpendingByContractIds(contractIds);
      }
      break;
    }
  }

  const lookupStatus = {
    pending: pending.ok ? "ok" : "error",
    registered: registered.ok ? "ok" : "error",
    spending: spending.ok ? "ok" : "error",
  };

  // Shadow dual-write: retain publisher Contracts rows (Prime + Sub slices) and
  // Spending payment rows as immutable observations. Fail-soft and independent
  // of lifecycle assembly (summaries still drive the public payment stage).
  const observedAt = new Date().toISOString();
  if (pending.ok || registered.ok) {
    const contractRows = [];
    if (pending.ok) {
      for (const row of pending.records) {
        contractRows.push(row?.status ? row : { ...row, status: "pending" });
      }
    }
    if (registered.ok) {
      for (const row of registered.records) {
        contractRows.push(row?.status ? row : { ...row, status: "registered" });
      }
    }
    await dualWriteCheckbookContractObservations(env, contractRows, observedAt);
  }
  if (spending.ok && Array.isArray(spending.records) && spending.records.length) {
    await dualWriteCheckbookSpendingObservations(env, spending.records, observedAt);
  }

  const [currentSolicitation, ocpFetch, relatedNotices] = await Promise.all([
    csPromise, ocpPromise, relatedPromise,
  ]);
  let lifecycle = assembleLifecycle(r, pending.records, registered.records, spending.records, {
    pinStrategy: pinStrategyUsed,
    lookupStatus,
    currentSolicitation,
    relatedNotices,
  });

  // PASSPort Public edge materialization: fill pending/registered gaps and enrich RFx.
  // Fail-soft — a PASSPort D1 miss never fails the Checkbook lifecycle.
  try {
    const pp = await lookupPassportForPin(env, r.pin || pin);
    lifecycle = enrichLifecycleWithPassport(lifecycle, r, {
      contracts: pp.contracts,
      rfx: pp.rfx,
      lookupStatus: pp.lookupStatus,
    });
  } catch {
    /* leave Checkbook-only lifecycle */
  }

  // OCP Recent Contract Awards side-car (date/amount corroboration).
  // WH-03: warehouse materialization first; live SODA only on miss.
  const ocpAward = joinOcpAward(r, ocpFetch.rows, {
    lookupStatus: ocpFetch.ok ? "ok" : "error",
  });
  if (ocpFetch.lookup_path) ocpAward.lookup_path = ocpFetch.lookup_path;
  lifecycle = attachOcpAward(lifecycle, ocpAward);

  // Money civic-time events: map matched lifecycle stages into the shared envelope
  // so /contract-lifecycle emits real procurement events (not fixture-only seams).
  lifecycle = attachMoneyCivicEvents(lifecycle, r, {
    processed_at: new Date().toISOString(),
    run_id: `contract-lifecycle:${requestId}`,
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
      // Require ocp_award + civic_events so older cache rows recompute with the
      // OCP side-car and Money civic-time production adapter.
      if (
        m
        && Array.isArray(m.timeline)
        && m.ocp_award
        && Array.isArray(m.civic_events)
      ) {
        return m;
      }
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
  "https://cityscroll.pages.dev",
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
