// Prior-cycle / near-match precompute + cache (crol-list Phase 1a).
//
// Moves the two live SODA calls that index.html's priorCycleAwards()/nearMatchCandidates() fired
// from the browser off the client and into the worker. For a given notice we run the SAME two
// SODA queries the client did, rank both tiers with the ported lib/prior_cycle.mjs (kept in sync
// by hand with index.html — see that file's header), cache the {strict, near, eligibleCount}
// result in the D1 prior_cycle_matches table, and serve it from GET /priorcycle/<request_id>
// (worker.mjs). eligibleCount is the pre-0.5-bar candidate pool over the strict-tier rows; the
// Phase 1b client reads it to pick 67's no_candidates-vs-low_confidence empty-state message
// without re-fetching the strict query itself.
//
// The daily cron pre-warms freshly-ingested Award notices (bounded, NOT a full backfill); any
// other notice is filled lazily on its first request. Fail-soft throughout, matching the other
// worker modules: no D1 binding → skip the cache but still compute; a SODA hiccup → return empty
// rather than throw, so a notice-detail view never breaks on a transient upstream error. A
// failed or unresolvable compute is never cached — the next request recomputes (the client's
// old retry-on-next-open behavior), and an id that resolves to no notice writes no D1 row at
// all (read-only on miss, like /inv and /forecast).

import {
  rankPriorCycleCandidates, rankNearMatchCandidates, priorCycleTitleWords,
  priorCycleEligibleCount, NEAR_MATCH_QUERY_WORDS,
} from "./lib/prior_cycle.mjs";

const SODA = "https://data.cityofnewyork.us/resource/dg92-zbpx.json";

// The field set index.html's SELECT pulls for these two panels (request_id..other_info_1). Kept
// verbatim so a cached row carries exactly what the client rendered from a live row before.
const SELECT = "request_id,start_date,agency_name,type_of_notice_description,category_description,short_title,pin,contract_amount,vendor_name,due_date,address_to_request,contact_name,contact_phone,email,selection_method_description,additional_description_1,other_info_1";

const PRIOR_CYCLE_QUERY_WORDS = 6; // strict tier widens $q to the notice's top 6 significant title words (index.html:1306)
const PREWARM_MAX = 40;            // cron pre-warm cap per run — bounded, never a full-corpus backfill

async function soda(params) {
  const r = await fetch(`${SODA}?${new URLSearchParams(params).toString()}`);
  if (!r.ok) throw new Error(`SODA ${r.status}`);
  return r.json();
}

function sq(s) { return String(s || "").replace(/'/g, "''"); } // SODA single-quote escape

// Fetch the notice's own row: from the D1 mirror when present, else a live SODA $where lookup.
// Returns null if it can't be resolved (fail-soft — the caller returns an empty match set).
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
    const rows = await soda({ "$select": SELECT, "$where": `request_id='${sq(requestId)}'`, "$limit": "1" });
    return Array.isArray(rows) && rows.length ? rows[0] : null;
  } catch {
    return null;
  }
}

// Run the two live SODA queries (strict, then near) exactly as index.html did and rank both
// tiers. Returns { strict, near, eligibleCount, ok }: ok is false when the notice couldn't be
// resolved or a tier query errored, so callers know the (empty) result is not a confirmed answer
// and must not cache it. eligibleCount is priorCycleEligibleCount() over the strict-tier query
// rows — the pre-0.5-bar pool size the Phase 1b client uses to pick 67's
// no_candidates-vs-low_confidence empty-state message, which it can no longer recompute locally
// (it doesn't fetch the strict rows anymore). Pass the already-resolved notice row (or null) as
// noticeRow to skip the lookup here; only an omitted (undefined) noticeRow triggers a fetch.
// Fail-soft: a query that errors contributes an empty tier rather than throwing.
export async function computeMatches(env, requestId, noticeRow) {
  const r = noticeRow === undefined ? await fetchNoticeRow(env, requestId) : noticeRow;
  if (!r) return { strict: [], near: [], eligibleCount: 0, ok: false };
  if (!r.agency_name || !r.short_title) return { strict: [], near: [], eligibleCount: 0, ok: true };

  const myWords = priorCycleTitleWords(r.short_title);
  if (myWords.length < 2) return { strict: [], near: [], eligibleCount: 0, ok: true }; // too generic a title to search on (matches index.html's guard)

  // --- strict tier (priorCycleAwards): agency + top-6-title-word $q, no date bound, limit 50 ---
  let strict = [];
  let eligibleCount = 0;
  let ok = true;
  const strictWords = myWords.slice(0, PRIOR_CYCLE_QUERY_WORDS);
  try {
    const rows = await soda({
      "$select": SELECT,
      "$where": `agency_name='${sq(r.agency_name)}' AND type_of_notice_description='Award'`,
      "$q": strictWords.join(" "),
      "$order": "start_date DESC",
      "$limit": "50",
    });
    strict = rankPriorCycleCandidates(r, rows, {});
    eligibleCount = priorCycleEligibleCount(r, rows); // pre-0.5-bar pool, from the same strict rows
  } catch { ok = false; /* leave strict empty — same posture as the client's silent catch */ }

  // --- near tier (nearMatchCandidates): agency + top-2-title-word $q + start_date < notice's,
  //     limit 50; excludes the strict matches it was handed ---
  let near = [];
  if (r.start_date) {
    const nearWords = myWords.slice(0, NEAR_MATCH_QUERY_WORDS);
    try {
      const rows = await soda({
        "$select": SELECT,
        "$where": `agency_name='${sq(r.agency_name)}' AND type_of_notice_description='Award' AND start_date < '${sq(r.start_date)}'`,
        "$q": nearWords.join(" "),
        "$order": "start_date DESC",
        "$limit": "50",
      });
      near = rankNearMatchCandidates(r, rows, strict, {});
    } catch { ok = false; /* leave near empty */ }
  }

  return { strict, near, eligibleCount, ok };
}

async function cacheGet(env, requestId) {
  if (!env.DB) return null;
  try {
    const row = await env.DB.prepare(
      "SELECT matches FROM prior_cycle_matches WHERE request_id = ?",
    ).bind(requestId).first();
    if (row && row.matches) {
      const m = JSON.parse(row.matches);
      // A cached row from before Phase 1b lacks eligibleCount; treat it as a miss so the next
      // request recomputes rather than serving an empty-state message the client can't resolve.
      if (m && Array.isArray(m.strict) && Array.isArray(m.near) && typeof m.eligibleCount === "number") return m;
    }
  } catch { /* treat any cache error as a miss */ }
  return null;
}

async function cachePut(env, requestId, agency, matches) {
  if (!env.DB) return;
  try {
    await env.DB.prepare(
      `INSERT OR REPLACE INTO prior_cycle_matches (request_id, agency, matches, computed_at)
         VALUES (?, ?, ?, ?)`,
    ).bind(requestId, agency || null, JSON.stringify(matches), new Date().toISOString()).run();
  } catch { /* a cache-write failure must never break the compute path */ }
}

// Read the D1 cache; on a miss, compute, upsert, and return. Only a fully-successful compute
// for a resolvable notice is cached — a transient failure or an unknown id stays uncached so
// the next request recomputes. With no D1 binding it always computes fresh (no cache layer).
// Fail-soft: never throws.
export async function getOrCompute(env, requestId) {
  const cached = await cacheGet(env, requestId);
  if (cached) return { ...cached, ok: true };
  const row = await fetchNoticeRow(env, requestId);
  const { strict, near, eligibleCount, ok } = await computeMatches(env, requestId, row);
  if (ok) await cachePut(env, requestId, row && row.agency_name, { strict, near, eligibleCount });
  return { strict, near, eligibleCount, ok };
}

// Bounded batch pre-warm, used by the daily cron for freshly-ingested Award notices. Skips
// entries already cached (idempotent — a re-run costs nothing), caps at PREWARM_MAX, and is
// fail-soft per notice so one bad row never aborts the batch. Returns a small summary.
export async function prewarm(env, requestIds) {
  const ids = Array.isArray(requestIds) ? [...new Set(requestIds.filter(Boolean))].slice(0, PREWARM_MAX) : [];
  let computed = 0, skipped = 0, failed = 0;
  for (const id of ids) {
    try {
      if (await cacheGet(env, id)) { skipped++; continue; }
      const row = await fetchNoticeRow(env, id);
      const { strict, near, eligibleCount, ok } = await computeMatches(env, id, row);
      if (!ok) { failed++; continue; }
      await cachePut(env, id, row && row.agency_name, { strict, near, eligibleCount });
      computed++;
    } catch {
      failed++;
    }
  }
  return { requested: ids.length, computed, skipped, failed };
}

// GET /priorcycle/<request_id> — thin read of the precomputed match set (compute-on-miss).
// Mirrors /inv and /forecast: public, edge-cached, validated/sanitized id.
const ALLOW = new Set([
  "https://crol-list.org", "https://www.crol-list.org",
  "https://crol-list.jimdc.com", "https://jimdc.github.io",
  "http://localhost:8000", "http://localhost:8787",
]);

export async function handlePriorCycle(req, env, pathname) {
  const cors = corsHeaders(req.headers.get("origin") || "");
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  if (req.method !== "GET") return json({ ok: false, reason: "method" }, 405, cors);

  let rawId;
  try {
    rawId = decodeURIComponent(pathname.slice("/priorcycle/".length));
  } catch {
    return json({ ok: false, reason: "bad-id" }, 400, cors); // malformed percent-encoding
  }
  // request_ids are digit strings (e.g. "20260625017"); accept a conservative alnum set only.
  if (!/^[A-Za-z0-9_-]{4,40}$/.test(rawId)) return json({ ok: false, reason: "bad-id" }, 400, cors);

  const matches = await getOrCompute(env, rawId);
  const ok = matches.ok !== false;
  return new Response(JSON.stringify({
    id: rawId, strict: matches.strict, near: matches.near,
    eligibleCount: typeof matches.eligibleCount === "number" ? matches.eligibleCount : 0,
    ok,
  }), {
    status: 200,
    headers: {
      ...cors, "Content-Type": "application/json",
      "Cache-Control": ok ? "public, max-age=300" : "no-store",
    },
  });
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
function json(obj, status, cors) {
  return new Response(JSON.stringify(obj), { status, headers: { ...cors, "Content-Type": "application/json" } });
}
