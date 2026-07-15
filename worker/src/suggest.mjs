// suggest.mjs — daily suggestion-chip validation pipeline + its read route (GET /suggestions).
//
// runSuggestionValidation(env): called from the 13:00 UTC scheduled handler, after the D1
// ingest step (see worker.mjs). For each SUGGESTION_POOL candidate it resolves the candidate's
// text into a filter the EXACT same way a real chip click would (parseLensFilter — the same
// NL→filter core /nl itself calls), then counts today's live matches via
// suggestionCountParams(). Candidates clearing MIN_SUGGESTION_RESULTS are stored, grouped by
// lens, in ALERT_STATE KV alongside the other cron products (fc:/plan:) under
// SUGGESTIONS_KV_KEY, so index.html's suggestion chips only ever render a query proven to
// return real results today.
//
// Fail-soft, two layers: one candidate's resolve/count failure is caught and skipped (logged),
// not fatal to the run; and if the WHOLE run comes back with nothing validated at all (Socrata
// or the Anthropic API down, say), the previous KV value is left untouched rather than
// overwritten with an empty set — a transient outage must never blank out yesterday's good
// chips (see the field-evidence comment on SUGGESTION_POOL in lib/suggestions.mjs).
//
// w12-17: a fruitful candidate is additionally enriched with two discoverability signals — see
// enrichCandidate() below — computed here, once a day, so the client never issues an extra
// request to learn them (the acceptance criterion is "all computed at validation time").
import { SUGGESTION_POOL, suggestionCountParams, suggestionSampleParams, MIN_SUGGESTION_RESULTS } from "./lib/suggestions.mjs";
import { computeLineageSignal, lineageChainKey, lineageDedupeKey, lineageBatchClauses } from "./lib/lineage.mjs";
import { vendorStem } from "./lib/compile.mjs";
import { parseLensFilter } from "./nl.mjs";
import { checkAdminKey } from "./admin.mjs";

export const SUGGESTIONS_KV_KEY = "suggestions:validated";

// How many of a fruitful candidate's own live rows to sample when judging lineage/forecast —
// the same 25-row cap compileSub()'s money branch already applies to a real search, so this
// asks nothing Socrata wouldn't already return for one click of the chip.
const ENRICH_SAMPLE_LIMIT = 25;

// Money/alerts-only candidate-level lineage-richness (PIN award-chain history) + forecast-
// bearing (Checkbook/MOCS agency forecast) signal. Never throws: any failure at any step
// (sample fetch, batch fetch, KV read) is swallowed and the signal for that step reports
// "uncertain" (false) rather than a guess — the base validated/count result for the candidate
// is unaffected either way, since enrichment is a bonus label, not a fruitfulness gate.
async function enrichCandidate(env, lens, filter, todayISO) {
  const none = { lineageRich: false, forecastBearing: false };
  const sampleQ = suggestionSampleParams(lens, filter, todayISO);
  if (!sampleQ) return none; // land/property/rules/meetings/people, or a rezone alert
  let sample;
  try {
    const r = await fetch(`${sampleQ.url}?${new URLSearchParams(sampleQ.params)}`);
    if (!r.ok) return none;
    sample = (await r.json()).slice(0, ENRICH_SAMPLE_LIMIT);
  } catch (e) { return none; }
  if (!sample.length) return none;

  // Lineage: batch every sampled row's chain key into one $where, same shape
  // loadLineageBadges() builds client-side for on-screen rows (lib/lineage.mjs).
  let lineageRich = false;
  const keys = [], seen = new Set();
  for (const r of sample) {
    const k = lineageChainKey(r);
    if (!k) continue;
    const dk = lineageDedupeKey(k);
    if (seen.has(dk)) continue;
    seen.add(dk); keys.push(k);
  }
  if (keys.length) {
    try {
      const where = `(${lineageBatchClauses(keys).join(" OR ")}) AND (type_of_notice_description='Award' OR type_of_notice_description='Intent to Award')`;
      const r = await fetch(`${sampleQ.url}?${new URLSearchParams({ "$select": "pin,agency_name,type_of_notice_description", "$where": where, "$limit": "2000" })}`);
      if (r.ok) {
        const batch = await r.json();
        lineageRich = computeLineageSignal(sample, batch).lineageRich;
      }
    } catch (e) { /* stays false — uncertain, not a guess */ }
  }

  // Forecast: any distinct sampled agency with a cached fc:<stem>/plan:<stem> record.
  let forecastBearing = false;
  if (env.ALERT_STATE) {
    const agencies = [...new Set(sample.map((r) => r.agency_name).filter(Boolean))];
    for (const name of agencies) {
      const stem = vendorStem(name);
      if (stem.length < 3) continue;
      try {
        const [fc, plan] = await Promise.all([env.ALERT_STATE.get(`fc:${stem}`), env.ALERT_STATE.get(`plan:${stem}`)]);
        if (fc || plan) { forecastBearing = true; break; }
      } catch (e) { /* keep checking other agencies */ }
    }
  }

  return { lineageRich, forecastBearing };
}

async function validateCandidate(env, candidate, todayISO) {
  const resolved = await parseLensFilter(env, candidate.lens, candidate.text);
  if (resolved.degraded) return null;
  const q = suggestionCountParams(candidate.lens, resolved.filter, todayISO);
  if (!q) return null;
  const url = `${q.url}?${new URLSearchParams(q.params)}`;
  const r = await fetch(url);
  if (!r.ok) return null;
  const rows = await r.json();
  const n = Number(rows && rows[0] && rows[0].n) || 0;
  if (n < MIN_SUGGESTION_RESULTS) return { lens: candidate.lens, idx: candidate.idx, count: n };
  let enrichment = { lineageRich: false, forecastBearing: false };
  try {
    enrichment = await enrichCandidate(env, candidate.lens, resolved.filter, todayISO);
  } catch (e) { /* base count result still stands — enrichment is a bonus label */ }
  return { lens: candidate.lens, idx: candidate.idx, count: n, ...enrichment };
}

export async function runSuggestionValidation(env) {
  const todayISO = new Date().toISOString().slice(0, 10);
  const byLens = {};

  for (const candidate of SUGGESTION_POOL) {
    let result;
    try {
      result = await validateCandidate(env, candidate, todayISO);
    } catch (e) {
      console.error("suggestion validation error:", candidate.lens, candidate.idx, String(e?.message || e));
      continue;
    }
    if (!result || result.count < MIN_SUGGESTION_RESULTS) continue;
    if (!byLens[result.lens]) byLens[result.lens] = [];
    byLens[result.lens].push({ idx: result.idx, count: result.count, lineageRich: !!result.lineageRich, forecastBearing: !!result.forecastBearing });
  }

  if (!Object.keys(byLens).length) {
    return { status: "skipped", reason: "no-fruitful-candidates" };
  }

  const record = { generatedAt: new Date().toISOString(), minResults: MIN_SUGGESTION_RESULTS, byLens };
  if (env.ALERT_STATE) await env.ALERT_STATE.put(SUGGESTIONS_KV_KEY, JSON.stringify(record));
  return { status: "success", byLens };
}

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
function json(obj, status, cors) {
  return new Response(JSON.stringify(obj), { status, headers: { ...cors, "Content-Type": "application/json" } });
}

// GET /suggestions — the client's validated-set read. 404 (not just an empty body) when the
// cron hasn't populated KV yet (a fresh deploy) so index.html's fetch-failure fallback path
// treats "never validated" the same as "worker absent": static suggestions either way.
export async function handleSuggestions(req, env) {
  const cors = corsHeaders(req.headers.get("origin") || "");
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  if (req.method !== "GET") return json({ ok: false, reason: "method" }, 405, cors);
  if (!env.ALERT_STATE) return json({ ok: false, reason: "not-configured" }, 503, cors);
  const raw = await env.ALERT_STATE.get(SUGGESTIONS_KV_KEY);
  if (!raw) return json({ ok: false, reason: "not-found" }, 404, cors);
  return new Response(raw, { status: 200, headers: { ...cors, "Content-Type": "application/json", "Cache-Control": "public, max-age=1800" } });
}

// POST /admin/suggest-refresh?key=… — operator trigger to run the exact same suggestion
// validation the 13:00 UTC cron runs, on demand (w12-13: the owner wanted to see the result of
// a rotation immediately rather than waiting for the daily run). Authenticated identically to
// the other /admin/* routes (checkAdminKey, admin.mjs) — 404 until ADMIN_KEY is configured, 401
// on a wrong/missing key. Idempotent: it only ever recomputes and overwrites the same KV record
// runSuggestionValidation() already owns, so firing it twice in a row is safe. Fail-soft matches
// the cron path exactly — runSuggestionValidation() itself never writes an empty set over a good
// one (see the comment on that function), and this route's own try/catch (for something the
// pipeline didn't anticipate, e.g. a KV outage) reports the error in the response instead of
// throwing, leaving whatever was already in KV untouched either way.
export async function handleAdminSuggestRefresh(req, env) {
  const auth = checkAdminKey(req, env);
  if (!auth.ok) return auth.res;
  if (req.method !== "POST") return json({ error: "method" }, 405);
  try {
    const result = await runSuggestionValidation(env);
    return json({ ...result, triggeredAt: new Date().toISOString() }, 200);
  } catch (e) {
    return json({ status: "error", error: String(e?.message || e) }, 500);
  }
}
