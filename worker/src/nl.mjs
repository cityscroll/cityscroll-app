// /nl — translate a user's plain-English search into structured City Record filters
// for a given lens (money | people | land | property | rules | meetings), via Claude
// Haiku (forced tool-call). Calls the Anthropic REST API directly with fetch — no SDK,
// so the Worker bundle stays tiny and needs no Node polyfills.
//
// Defenses against denial-of-wallet abuse (public endpoint, key held here):
//   1. Input length cap (a paragraph, not a novel).
//   2. Hard daily call ceiling (Workers KV counter) → over cap returns { degraded:true },
//      and the browser falls back to its on-device heuristic.
//   3. Tiny max_tokens (the answer is a small JSON object).
// Worst case ≈ MAX_CALLS_PER_DAY × (~600 in + ~200 out tokens) on Haiku ≈ tens of cents/day.

import { sanitize, MAX_INPUT, MAX_CALLS_PER_DAY, LENSES } from "./lib/filter.mjs";

const MODEL = "claude-haiku-4-5";

const ALLOW = new Set([
  "https://crol-list.org",
  "https://www.crol-list.org",
  "https://crol-list.jimdc.com",
  "https://jimdc.github.io",
  "http://localhost:8888",
  "http://localhost:8000",
  "http://localhost:8787", // wrangler dev
]);

// Field catalogue — the schema for each lens is assembled from its LENSES[] field list.
const FIELD_DEFS = {
  keywords: { type: "array", items: { type: "string" }, description: "1–4 short lowercase topic/trade keywords for full-text search (e.g. 'electrical', 'affordable housing', 'landmark'). Short terms a keyword search matches — not whole sentences. Empty if none implied." },
  agency: { type: ["string", "null"], description: "A specific NYC agency name if one is named (e.g. 'Department of Transportation'), else null." },
  minAmount: { type: ["number", "null"], description: "Minimum contract dollar value if a floor is stated ('over $1M' → 1000000), else null." },
  maxAmount: { type: ["number", "null"], description: "Maximum contract dollar value if a ceiling is stated ('under $500k' → 500000), else null." },
  category: { type: ["string", "null"], enum: ["Goods", "Goods and Services", "Services (other than human services)", "Human Services/Client Services", "Construction/Construction Services", "Construction Related Services", null], description: "Procurement category, exactly one of the allowed values if clearly implied (e.g. a construction company → 'Construction/Construction Services'), else null." },
  months: { type: ["number", "null"], description: "If they want results due within N months/weeks, the number of MONTHS (round weeks up), else null." },
  excludeSpecial: { type: "boolean", description: "true only if they want to avoid special/restricted selection methods ('standard requirements only')." },
  boro: { type: ["string", "null"], description: "NYC borough if named or clearly implied by a neighborhood: Manhattan, Brooklyn, Queens, Bronx, or Staten Island; else null." },
  status: { type: ["string", "null"], description: "'active' for in-review/active items; 'all' if they want everything incl. closed/approved; else null." },
  when: { type: ["string", "null"], description: "'upcoming' for future meetings; 'all' for recent and all; else null." },
  lookupType: { type: ["string", "null"], description: "'role' if searching a job title/role; 'person' if looking up a named individual; else null." },
  watchType: { type: ["string", "null"], description: "The kind of saved alert: 'bigaward' (contract awards over a dollar threshold), 'rfpkw' (open RFPs matching a keyword), or 'rezone' (rezonings near a place); else null." },
  threshold: { type: ["number", "null"], description: "For a 'bigaward' alert, the minimum award dollar amount ('over $1M' → 1000000); else null." },
  keyword: { type: ["string", "null"], description: "For an 'rfpkw' alert, the single trade/topic keyword (e.g. 'construction'); else null." },
  place: { type: ["string", "null"], description: "For a 'rezone' alert, the neighborhood or address to watch (e.g. '79 Rivington', 'Gowanus'); else null." },
};

const LENS_HINT = {
  money: "NYC City Record procurement notices — RFPs and contract awards",
  people: "NYC civil-service job titles/roles, or a named person's appointment history",
  land: "NYC rezoning / land-use (ZAP) applications, by borough and location",
  property: "NYC property being sold, auctioned, or disposed (Property Disposition notices)",
  rules: "proposed and adopted NYC agency rules",
  meetings: "NYC public meetings and hearings",
  alerts: "a saved alert — contract awards over a dollar threshold, open RFPs by keyword, or rezonings near a place",
};

function buildTool(lens) {
  const properties = {};
  for (const f of LENSES[lens]) properties[f] = FIELD_DEFS[f];
  return {
    name: "build_filter",
    description: `Translate a user's plain-English search over ${LENS_HINT[lens]} into structured filters. Only fill a field the text actually implies; otherwise use null / an empty array.`,
    input_schema: { type: "object", properties, required: LENSES[lens], additionalProperties: false },
  };
}

const buildSystem = (lens) =>
  `You convert a user's plain-English description into structured search filters for ${LENS_HINT[lens]}. Be conservative: only set a field when the text clearly implies it. Keywords are short topic terms a full-text search would match, not whole phrases. Call build_filter exactly once.`;

// Core NL→filter parse, shared by /nl, /mcp, and the inbound-email handler. Each
// caller meters itself BEFORE calling (this function spends Anthropic tokens).
// Returns { filter, lens, model } or { degraded: true, reason }.
export async function parseLensFilter(env, lens, rawText) {
  const text = String(rawText || "").slice(0, MAX_INPUT).trim();
  if (!text) return { degraded: true, reason: "empty" };
  if (!LENSES[lens]) return { degraded: true, reason: "bad-lens" };
  const apiKey = env.ANTHROPIC_API_KEY;
  if (!apiKey) return { degraded: true, reason: "no-key" };

  try {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 400,
        system: buildSystem(lens),
        tools: [buildTool(lens)],
        tool_choice: { type: "tool", name: "build_filter" },
        messages: [{ role: "user", content: text }],
      }),
    });
    if (!r.ok) return { degraded: true, reason: `api-${r.status}` };
    const data = await r.json();
    const block = (data.content || []).find((b) => b.type === "tool_use");
    if (!block) return { degraded: true, reason: "no-tool" };
    return { filter: sanitize(lens, block.input), lens, model: MODEL };
  } catch (e) {
    return { degraded: true, reason: "error", message: String(e?.message || e) };
  }
}

export async function handleNl(req, env) {
  const origin = req.headers.get("origin") || "";
  const cors = corsHeaders(origin);

  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  if (req.method !== "POST") return json({ error: "POST only" }, 405, cors);

  let body = {};
  try { body = await req.json(); } catch { /* ignore bad body */ }
  const text = String(body.text || "").slice(0, MAX_INPUT).trim();
  const lens = LENSES[body.lens] ? body.lens : "money"; // unknown/missing → money (back-compat)
  if (!text) return json({ error: "empty" }, 400, cors);

  // Denial-of-wallet ceiling. Over cap → client uses its on-device heuristic.
  if (await overDailyCap(env)) return json({ degraded: true, reason: "daily-cap" }, 200, cors);

  const res = await parseLensFilter(env, lens, text);
  // Graceful degradation either way: the browser falls back to its on-device parser.
  return json(res, 200, cors);
}

// Daily call ceiling via Workers KV. Eventual consistency means concurrent calls could
// slightly under-count near the cap — fine for a soft denial-of-wallet stop. Day keys
// auto-expire after 2 days so the namespace never grows.
async function overDailyCap(env) {
  try {
    const store = env.NL_METER;
    if (!store) return false;
    const day = new Date().toISOString().slice(0, 10);
    const key = `nl:${day}`;
    const cur = parseInt((await store.get(key)) || "0", 10) || 0;
    if (cur >= MAX_CALLS_PER_DAY) return true;
    await store.put(key, String(cur + 1), { expirationTtl: 172800 });
    return false;
  } catch {
    return false;
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

function json(obj, status, cors) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { ...cors, "Content-Type": "application/json" },
  });
}
