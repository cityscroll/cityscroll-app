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
import { SUGGESTION_POOL, suggestionCountParams, MIN_SUGGESTION_RESULTS } from "./lib/suggestions.mjs";
import { parseLensFilter } from "./nl.mjs";

export const SUGGESTIONS_KV_KEY = "suggestions:validated";

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
  return { lens: candidate.lens, idx: candidate.idx, count: n };
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
    byLens[result.lens].push({ idx: result.idx, count: result.count });
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
