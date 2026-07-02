// Tests for the read-only /usage endpoint — drives handleUsage() with a fake env + KV
// (no network, no model calls), plus pure-helper checks. `npm test`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { handleUsage } from "../src/usage.mjs";
import { estCostUsd, lastNDays, PRICING, MODEL } from "../src/lib/usage.mjs";

const SECRET = "shh-secret-123";

// Fake Workers KV seeded from a { key: "count" } map. `fail` makes .get() throw.
function kv(map = {}, { fail = false } = {}) {
  return {
    get: async (k) => {
      if (fail) throw new Error("kv down");
      return Object.prototype.hasOwnProperty.call(map, k) ? map[k] : null;
    },
  };
}

const get = (url, headers = {}) => new Request(url, { method: "GET", headers });

test("disabled (404) when USAGE_KEY unset — fail closed", async () => {
  const r = await handleUsage(get("https://w/usage?key=anything"), { NL_METER: kv() });
  assert.equal(r.status, 404);
});

test("401 with no key", async () => {
  const r = await handleUsage(get("https://w/usage"), { USAGE_KEY: SECRET, NL_METER: kv() });
  assert.equal(r.status, 401);
});

test("401 with wrong key", async () => {
  const r = await handleUsage(get("https://w/usage?key=nope"), { USAGE_KEY: SECRET, NL_METER: kv() });
  assert.equal(r.status, 401);
});

test("correct counts + estimate with a seeded NL_METER (?key=)", async () => {
  const now = new Date();
  const [today, yday] = lastNDays(now, 2);
  const env = {
    USAGE_KEY: SECRET,
    NL_METER: kv({ [`nl:${today}`]: "10", [`nl:${yday}`]: "5" }),
  };
  const r = await handleUsage(get(`https://w/usage?key=${SECRET}`), env);
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.equal(j.today.calls, 10);
  assert.equal(j.last_7d.calls, 15); // 10 today + 5 yesterday, rest absent → 0
  assert.equal(j.model, MODEL);
  assert.equal(j.today.est_cost_usd, estCostUsd(10));
  assert.equal(j.last_7d.est_cost_usd, estCostUsd(15));
  assert.equal(typeof j.asof, "string");
  assert.match(j.pricing_note, /ESTIMATE/);
  assert.equal(j.degraded, undefined);
});

test("accepts the secret via Authorization: Bearer and X-Usage-Key", async () => {
  const env = { USAGE_KEY: SECRET, NL_METER: kv() };
  const bearer = await handleUsage(get("https://w/usage", { authorization: `Bearer ${SECRET}` }), env);
  assert.equal(bearer.status, 200);
  const hdr = await handleUsage(get("https://w/usage", { "x-usage-key": SECRET }), env);
  assert.equal(hdr.status, 200);
});

test("degraded path on KV failure → zeros + degraded:true, never throws (still 200)", async () => {
  const env = { USAGE_KEY: SECRET, NL_METER: kv({}, { fail: true }) };
  const r = await handleUsage(get(`https://w/usage?key=${SECRET}`), env);
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.equal(j.degraded, true);
  assert.equal(j.today.calls, 0);
  assert.equal(j.last_7d.calls, 0);
  assert.equal(j.today.est_cost_usd, 0);
});

test("degraded when the NL_METER binding is missing entirely", async () => {
  const r = await handleUsage(get(`https://w/usage?key=${SECRET}`), { USAGE_KEY: SECRET });
  assert.equal(r.status, 200);
  assert.equal((await r.json()).degraded, true);
});

test("OPTIONS preflight → 204 with CORS, no auth needed", async () => {
  const r = await handleUsage(new Request("https://w/usage", { method: "OPTIONS" }), {});
  assert.equal(r.status, 204);
  assert.equal(r.headers.get("access-control-allow-methods"), "GET, OPTIONS");
});

test("non-GET → 405 (when enabled)", async () => {
  const r = await handleUsage(new Request("https://w/usage", { method: "POST" }), { USAGE_KEY: SECRET });
  assert.equal(r.status, 405);
});

// ── pure helpers ────────────────────────────────────────────────────────────

test("estCostUsd: calls × (~600 in + ~200 out) × Haiku price ($1/$5 per MTok)", () => {
  // 600/1e6*1 + 200/1e6*5 = 0.0006 + 0.001 = 0.0016 per call
  assert.equal(estCostUsd(1), 0.0016);
  assert.equal(estCostUsd(1000), 1.6);
  assert.equal(estCostUsd(0), 0);
  assert.equal(estCostUsd(-5), 0);
  assert.equal(estCostUsd("nope"), 0);
});

test("pricing constants match the Haiku list price checked 2026-06-26", () => {
  assert.equal(PRICING.inputPerMTokUsd, 1.0);
  assert.equal(PRICING.outputPerMTokUsd, 5.0);
  assert.equal(PRICING.estInputTokensPerCall, 600);
  assert.equal(PRICING.estOutputTokensPerCall, 200);
  assert.equal(PRICING.checked, "2026-06-26");
});

test("lastNDays returns N UTC day strings, today first", () => {
  const now = new Date("2026-06-26T12:00:00Z");
  const days = lastNDays(now, 7);
  assert.equal(days.length, 7);
  assert.equal(days[0], "2026-06-26");
  assert.equal(days[6], "2026-06-20");
});
