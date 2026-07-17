// Awards published outside the City Record — precompute + cache + endpoint (crol-list).
//
// Public authorities post solicitations in the City Record but file their awards elsewhere as
// open data. AWARD_SOURCE_REGISTRY (lib/external_award.mjs) records, per agency, whether an open
// dataset publishes its awards and how precisely they join. This module turns that registry into
// a served result, moving the two live browser fetches the client used to fire off the client:
//
//   - ABO sources (fuzzy, vendor+date+amount): a WEEKLY cron pulls each registry authority's
//     recent awards from data.ny.gov in bulk and caches them per source in KV (award:<dataset>:
//     <authority>), with the dataset's own refresh date. The source updates ~annually, so weekly
//     polling is plenty. GET /externalaward serves the cached set.
//   - NYCHA (exact, PIN): resolved per notice against Checkbook NYC's Contracts_NYCHA domain —
//     ONE Checkbook request per notice (the WAF blocks per-PIN fan-out, so never a bulk backfill),
//     ranked with rankNychaAwardCandidates(), cached in D1 (external_award_matches), compute-on-
//     miss + bounded cron pre-warm of freshly-ingested NYCHA solicitations.
//
// Fail-soft throughout, matching the other worker modules: no binding → skip the cache but still
// answer; an upstream hiccup → an honest "ok:false" so the client says nothing rather than a
// wrong "no awards found". A failed compute is never cached.

import {
  awardSourceFor, aboSources, awardKvKey,
  normalizeRecentAuthorityAwards, rankNychaAwardCandidates,
} from "./lib/external_award.mjs";

const SODA_NYC = "https://data.cityofnewyork.us/resource/dg92-zbpx.json";
const NY_RESOURCE = "https://data.ny.gov/resource/";
const NY_VIEW = "https://data.ny.gov/api/views/";
const CHECKBOOK = "https://www.checkbooknyc.com/api";

const ABO_RECENT_LIMIT = 8;         // recent awards cached per source (matches the client's old $limit:8)
const ABO_REFRESH_DAYS = 7;         // weekly gate — the sources refresh ~annually, daily buys nothing
const NYCHA_PAGE = 25, NYCHA_MAX_PAGES = 8; // one notice's paginated Checkbook lookup (mirrors index.html)
const PREWARM_MAX = 40;             // cron pre-warm cap per run — bounded, never a full-corpus backfill
const JUNK_PINS = new Set(["NOPINFOUND", "SEE BELOW", "LINE 17 BELOW", "TBD", "N/A", "NONE", "VARIOUS", "SEE ATTACHED", "123456"]);
const JUNK_PIN_TEXT_RE = /\bsee\b|\bbelow\b|\bline\s*17\b|\bn\/?a\b|\btbd\b|\bvarious\b|\bpending\b|\battached\b/i;

function usablePin(p) {
  const s = String(p || "").trim();
  if (!s || s.length < 4 || JUNK_PINS.has(s.toUpperCase()) || JUNK_PIN_TEXT_RE.test(s)) return false;
  return true;
}

function sq(s) { return String(s || "").replace(/'/g, "''"); }
function escXml(s) { return String(s).replace(/[<>&'"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", '"': "&quot;" }[c])); }

async function soda(base, params) {
  const r = await fetch(`${base}?${new URLSearchParams(params).toString()}`);
  if (!r.ok) throw new Error(`SODA ${r.status}`);
  return r.json();
}

// ---------------------------------------------------------------------------
// Weekly ABO refresh (cron). Bounded per source; fail-soft per source so one bad
// dataset never aborts the batch. Leaves a good previous cache untouched on failure.
// ---------------------------------------------------------------------------

// A dataset's own "last updated" timestamp (the source refresh date surfaced in provenance).
async function datasetRefreshedISO(dataset) {
  try {
    const r = await fetch(`${NY_VIEW}${dataset}.json`);
    if (!r.ok) return null;
    const meta = await r.json();
    if (meta && typeof meta.rowsUpdatedAt === "number") {
      return new Date(meta.rowsUpdatedAt * 1000).toISOString().slice(0, 10);
    }
  } catch { /* provenance is best-effort */ }
  return null;
}

export async function refreshAboAwards(env, nowISO) {
  const now = typeof nowISO === "string" ? nowISO : new Date().toISOString();
  if (!env.ALERT_STATE) return { skipped: "no-kv-binding" };

  // Weekly gate: skip if the last successful refresh was under ABO_REFRESH_DAYS ago.
  try {
    const last = await env.ALERT_STATE.get("award:meta:last_refresh");
    if (last) {
      const ageDays = (Date.parse(now) - Date.parse(last)) / 86400000;
      if (Number.isFinite(ageDays) && ageDays >= 0 && ageDays < ABO_REFRESH_DAYS) {
        return { skipped: "fresh", ageDays: Math.round(ageDays) };
      }
    }
  } catch { /* treat a gate read failure as "due" */ }

  const asOf = now.slice(0, 10);
  const refreshedCache = new Map(); // dataset -> refresh date (one metadata fetch per dataset)
  let updated = 0, failed = 0;
  for (const src of aboSources()) {
    try {
      if (!refreshedCache.has(src.dataset)) refreshedCache.set(src.dataset, await datasetRefreshedISO(src.dataset));
      const rows = await soda(`${NY_RESOURCE}${src.dataset}.json`, {
        "$select": "authority_name,vendor_name,procurement_description,award_process,award_date,contract_amount",
        "$where": `authority_name='${sq(src.authority)}' AND award_date IS NOT NULL AND award_date <= '${asOf}T23:59:59.999'`,
        "$order": "award_date DESC",
        "$limit": String(ABO_RECENT_LIMIT),
      });
      const awards = normalizeRecentAuthorityAwards(rows, asOf);
      await env.ALERT_STATE.put(awardKvKey(src), JSON.stringify({
        dataset: src.dataset, authority: src.authority,
        refreshed: refreshedCache.get(src.dataset), awards,
      }));
      updated++;
    } catch {
      failed++; // leave the previous KV value in place — a transient outage must not blank a source
    }
  }
  // Only stamp the gate once at least one source refreshed, so a fully-failed run retries next cron.
  if (updated > 0) {
    try { await env.ALERT_STATE.put("award:meta:last_refresh", now); } catch { /* ignore */ }
  }
  return { updated, failed, sources: aboSources().length };
}

export async function readAboCache(env, entry) {
  if (!env.ALERT_STATE) return null;
  try {
    const raw = await env.ALERT_STATE.get(awardKvKey(entry));
    if (raw) return JSON.parse(raw);
  } catch { /* miss */ }
  return null;
}

// ---------------------------------------------------------------------------
// NYCHA per-notice exact-PIN match against Checkbook NYC, cached in D1.
// ---------------------------------------------------------------------------

// Parse Checkbook NYCHA <transaction> rows — the Contracts_NYCHA field set (distinct from the
// prime_* shape parseCheckbookTransactions() reads), matching index.html's checkbookNychaByPin().
function parseNychaContracts(xml) {
  const out = [];
  for (const m of String(xml || "").matchAll(/<transaction>([\s\S]*?)<\/transaction>/g)) {
    const tx = m[1];
    const g = (tag) => { const mm = tx.match(new RegExp(`<${tag}>([^<]*)</${tag}>`)); return mm ? mm[1].trim() : ""; };
    out.push({
      id: g("contract_id"), pin: g("pin"), vendor: g("vendor"),
      amount: Number(g("contract_current_amount")) || Number(g("contract_original_amount")) || 0,
      invoiced: Number(g("contract_invoiced_amount")) || 0,
      start: g("start_date"), end: g("end_date"), approved: g("approved_date"),
      method: g("award_method"), purpose: g("purpose"), recordType: g("record_type"),
    });
  }
  return out;
}

// Fetch one PIN's Contracts_NYCHA agreements — a single logical lookup (paginated), never a
// per-PIN fan-out. Returns null on any non-success page (proxy/WAF failure → say nothing).
async function checkbookNychaByPin(pin) {
  const agreements = [];
  for (let page = 0; page < NYCHA_MAX_PAGES; page++) {
    const from = page * NYCHA_PAGE + 1;
    const xml = `<request><type_of_data>Contracts_NYCHA</type_of_data><records_from>${from}</records_from><max_records>${NYCHA_PAGE}</max_records><search_criteria>`
      + `<criteria><name>pin</name><type>value</type><value>${escXml(pin)}</value></criteria>`
      + `</search_criteria></request>`;
    let text;
    try {
      const r = await fetch(CHECKBOOK, { method: "POST", headers: { "Content-Type": "application/xml" }, body: xml });
      if (!r.ok) return null;
      text = await r.text();
    } catch { return null; }
    const status = text.match(/<status>[\s\S]*?<result>([^<]*)<\/result>/);
    if (!status || status[1].trim() !== "success") return null;
    const txs = parseNychaContracts(text);
    agreements.push(...txs.filter((c) => c.recordType === "Agreement"));
    if (txs.length < NYCHA_PAGE) return agreements;
  }
  return null; // bounded page limit exhausted — fail closed
}

// Resolve the notice's own row (D1 mirror first, then a live SODA lookup). Null if unresolvable.
async function fetchNoticeRow(env, requestId) {
  if (env.DB) {
    try {
      const row = await env.DB.prepare(
        `SELECT request_id, start_date, agency AS agency_name, type_of_notice AS type_of_notice_description, pin
           FROM notices WHERE request_id = ?`,
      ).bind(requestId).first();
      if (row) return row;
    } catch { /* fall through */ }
  }
  try {
    const rows = await soda(SODA_NYC, {
      "$select": "request_id,start_date,agency_name,type_of_notice_description,pin",
      "$where": `request_id='${sq(requestId)}'`, "$limit": "1",
    });
    return Array.isArray(rows) && rows.length ? rows[0] : null;
  } catch { return null; }
}

// Compute a NYCHA notice's exact-PIN matches. ok:false means the lookup couldn't complete (never
// cached), distinct from a completed lookup that found nothing (ok:true, empty matches, cached).
async function computeNychaMatches(env, noticeRow) {
  const r = noticeRow;
  if (!r || r.agency_name !== "Housing Authority" || r.type_of_notice_description !== "Solicitation" || !usablePin(r.pin)) {
    return { matches: [], ok: true }; // not an eligible notice — a confirmed empty answer
  }
  const rows = await checkbookNychaByPin(String(r.pin).trim());
  if (rows === null) return { matches: [], ok: false }; // proxy/WAF failure — not a real "none"
  return { matches: rankNychaAwardCandidates(r, rows), ok: true };
}

async function nychaCacheGet(env, requestId) {
  if (!env.DB) return null;
  try {
    const row = await env.DB.prepare(
      "SELECT matches FROM external_award_matches WHERE request_id = ?",
    ).bind(requestId).first();
    if (row && row.matches) {
      const m = JSON.parse(row.matches);
      if (m && Array.isArray(m.matches)) return m;
    }
  } catch { /* miss */ }
  return null;
}

async function nychaCachePut(env, requestId, agency, matches) {
  if (!env.DB) return;
  try {
    await env.DB.prepare(
      `INSERT OR REPLACE INTO external_award_matches (request_id, agency, matches, computed_at)
         VALUES (?, ?, ?, ?)`,
    ).bind(requestId, agency || null, JSON.stringify({ matches }), new Date().toISOString()).run();
  } catch { /* a cache-write failure must never break the compute */ }
}

export async function getOrComputeNycha(env, requestId, noticeRow) {
  const cached = await nychaCacheGet(env, requestId);
  if (cached) return { matches: cached.matches, ok: true };
  const row = noticeRow === undefined ? await fetchNoticeRow(env, requestId) : noticeRow;
  const { matches, ok } = await computeNychaMatches(env, row);
  if (ok) await nychaCachePut(env, requestId, row && row.agency_name, matches);
  return { matches, ok };
}

// Bounded cron pre-warm of freshly-ingested NYCHA solicitations (compute-on-miss otherwise).
export async function prewarmNycha(env, requestIds) {
  const ids = Array.isArray(requestIds) ? [...new Set(requestIds.filter(Boolean))].slice(0, PREWARM_MAX) : [];
  let computed = 0, skipped = 0, failed = 0;
  for (const id of ids) {
    try {
      if (await nychaCacheGet(env, id)) { skipped++; continue; }
      const row = await fetchNoticeRow(env, id);
      const { matches, ok } = await computeNychaMatches(env, row);
      if (!ok) { failed++; continue; }
      await nychaCachePut(env, id, row && row.agency_name, matches);
      computed++;
    } catch { failed++; }
  }
  return { requested: ids.length, computed, skipped, failed };
}

// ---------------------------------------------------------------------------
// Award-arrival alerts: one notice's current award candidates, fingerprinted so a caller can
// diff against what it already notified about. Reuses the exact same precomputed state (the
// D1 NYCHA cache, the KV ABO cache) the notice page itself reads via /externalaward — never a
// second, divergent notion of "does this notice have an award yet."
//
// key is a stable content fingerprint, not a display id: NYCHA rows carry a real contract_id;
// ABO rows carry none, so their key is built from the fields that make one row distinguishable
// from another (vendor+date+amount), same fingerprinting posture as digest.mjs's
// dedupeFreshByContent(). ok:false only ever means "couldn't determine the current state" (a
// Checkbook/proxy hiccup) — never conflate with a confirmed empty answer, which is ok:true with
// an empty candidates array and safe to treat as "nothing new."
export async function currentAwardCandidates(env, requestId, agency) {
  const entry = awardSourceFor(agency);
  if (!entry || entry.kind === "absent") return { ok: true, candidates: [] };

  if (entry.kind === "checkbook-nycha") {
    const { matches, ok } = await getOrComputeNycha(env, requestId, undefined);
    if (!ok) return { ok: false, candidates: [] };
    return {
      ok: true,
      candidates: matches.map((m) => ({
        key: `nycha:${m.id}`, kind: "exact",
        vendor: m.vendor || "", amount: m.amount || 0, date: m.approved || m.start || "",
      })),
    };
  }

  // ABO fuzzy — the same cached per-authority award set the notice page's "possible awards"
  // timeline already shows (unscoped by notice date, matching that existing display convention;
  // see AGENTS.md's award-arrival-alerts note for why no date window is needed here).
  const cached = await readAboCache(env, entry);
  const awards = cached ? cached.awards : [];
  return {
    ok: true,
    candidates: awards.map((a) => ({
      key: `abo:${entry.dataset}:${entry.authority}:${a.vendor}:${a.date}:${a.amount}`,
      kind: "fuzzy",
      vendor: a.vendor || "", amount: a.amount || 0, date: a.date || "",
    })),
  };
}

// ---------------------------------------------------------------------------
// GET /externalaward?id=<request_id>  OR  ?agency=<agency_name>
// One coverage-shaped response drives the client's award surface AND its empty state.
// ---------------------------------------------------------------------------

const ALLOW = new Set([
  "https://crol-list.org", "https://www.crol-list.org",
  "https://crol-list.jimdc.com", "https://jimdc.github.io",
  "http://localhost:8000", "http://localhost:8787",
]);

function corsHeaders(origin) {
  const o = ALLOW.has(origin) ? origin : "https://crol-list.org";
  return {
    "Access-Control-Allow-Origin": o,
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Vary": "Origin",
  };
}
function json(obj, status, cors, cache) {
  return new Response(JSON.stringify(obj), {
    status, headers: { ...cors, "Content-Type": "application/json", "Cache-Control": cache || "no-store" },
  });
}

export async function handleExternalAward(req, env) {
  const cors = corsHeaders(req.headers.get("origin") || "");
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  if (req.method !== "GET") return json({ ok: false, reason: "method" }, 405, cors);

  const url = new URL(req.url);
  const rawId = url.searchParams.get("id");
  let agency = url.searchParams.get("agency");
  let noticeRow;

  if (rawId != null) {
    if (!/^[A-Za-z0-9_-]{4,40}$/.test(rawId)) return json({ ok: false, reason: "bad-id" }, 400, cors);
    noticeRow = await fetchNoticeRow(env, rawId);
    if (!noticeRow) return json({ id: rawId, coverage: "unknown", ok: false }, 200, cors);
    agency = noticeRow.agency_name;
  } else if (!agency) {
    return json({ ok: false, reason: "missing-id-or-agency" }, 400, cors);
  }

  const entry = awardSourceFor(agency);

  // Absent / unknown — no data to fetch; the client renders the coverage claim from its own
  // registry copy, this just confirms the verdict (and is safe to edge-cache).
  if (!entry) return json({ agency, coverage: "unknown", ok: true }, 200, cors, "public, max-age=3600");
  if (entry.kind === "absent") return json({ agency, coverage: "absent", ok: true }, 200, cors, "public, max-age=3600");

  if (entry.kind === "checkbook-nycha") {
    // Per-notice exact join. Agency-only lookups (no id) carry no PIN to join — return the
    // coverage verdict with an empty match set (the agency profile just shows the claim).
    if (rawId == null) return json({ agency, coverage: "exact", matches: [], source: { kind: "checkbook-nycha" }, ok: true }, 200, cors);
    const { matches, ok } = await getOrComputeNycha(env, rawId, noticeRow);
    return json({
      id: rawId, agency, coverage: "exact", matches,
      source: { kind: "checkbook-nycha" }, ok,
    }, 200, cors, ok ? "public, max-age=300" : "no-store");
  }

  // ABO fuzzy — serve the cached per-source award set + provenance.
  const cached = await readAboCache(env, entry);
  return json({
    id: rawId || undefined, agency, coverage: "fuzzy",
    agencyAwards: cached ? cached.awards : [],
    source: { kind: "abo", dataset: entry.dataset, authority: entry.authority, refreshed: cached ? cached.refreshed : null },
    ok: true,
  }, 200, cors, "public, max-age=300");
}
