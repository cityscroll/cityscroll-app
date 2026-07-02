// Pure, dependency-free helpers for the read-only /usage endpoint — unit-testable
// and runtime-agnostic (identical under Node tests and the Cloudflare Workers runtime).
//
// /usage reports crol-worker's Anthropic (Claude Haiku) spend by reading the NL_METER
// KV day-counters that /nl already increments — key format `nl:<YYYY-MM-DD>`, see
// overDailyCap() in ../nl.mjs. Cost is an ESTIMATE: call count × a fixed per-call token
// estimate × current Haiku per-token prices. It is NOT billed usage.

// The model /nl calls. Mirrors MODEL in ../nl.mjs — keep in sync.
export const MODEL = "claude-haiku-4-5";

// ── Pricing: the ONE place to update ────────────────────────────────────────
// Claude Haiku 4.5 list price, per million tokens. Checked 2026-06-26 against
// https://platform.claude.com/docs/en/about-claude/models/overview  ($1 in / $5 out per MTok).
export const PRICING = {
  model: MODEL,
  checked: "2026-06-26",
  inputPerMTokUsd: 1.0,
  outputPerMTokUsd: 5.0,
  // Per-/nl-call token estimate documented in ../nl.mjs (~600 input + ~200 output on Haiku).
  estInputTokensPerCall: 600,
  estOutputTokensPerCall: 200,
};

export const PRICING_NOTE =
  `ESTIMATE only (count-based, not billed): calls × ~${PRICING.estInputTokensPerCall} in + ` +
  `~${PRICING.estOutputTokensPerCall} out tokens/call × Claude Haiku ` +
  `$${PRICING.inputPerMTokUsd}/$${PRICING.outputPerMTokUsd} per MTok (prices checked ${PRICING.checked}).`;

// USD cost of one /nl call, by the token estimate above.
function costPerCallUsd() {
  return (
    (PRICING.estInputTokensPerCall / 1e6) * PRICING.inputPerMTokUsd +
    (PRICING.estOutputTokensPerCall / 1e6) * PRICING.outputPerMTokUsd
  );
}

// Estimated USD for N calls, rounded to 4 decimals (sub-cent). Non-positive/garbage → 0.
export function estCostUsd(calls) {
  const n = Number.isFinite(calls) && calls > 0 ? calls : 0;
  return Math.round(n * costPerCallUsd() * 1e4) / 1e4;
}

// UTC YYYY-MM-DD for a Date — matches /nl's day key (new Date().toISOString().slice(0,10)).
function dayStr(d) {
  return d.toISOString().slice(0, 10);
}

// The NL_METER key for a UTC day string.
export function meterKey(day) {
  return `nl:${day}`;
}

// The N most-recent UTC day strings ending at `now` (index 0 = today).
export function lastNDays(now, n) {
  const days = [];
  for (let i = 0; i < n; i++) {
    days.push(dayStr(new Date(now.getTime() - i * 86400000)));
  }
  return days;
}

// Shape the /usage response body from already-summed counts (pure).
export function buildUsageBody({ todayCalls, last7dCalls, now, degraded = false }) {
  const body = {
    today: { calls: todayCalls, est_cost_usd: estCostUsd(todayCalls) },
    last_7d: { calls: last7dCalls, est_cost_usd: estCostUsd(last7dCalls) },
    model: MODEL,
    asof: now.toISOString(),
    pricing_note: PRICING_NOTE,
  };
  if (degraded) body.degraded = true;
  return body;
}
