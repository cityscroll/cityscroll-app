// w12-13: a keyed admin trigger to run the w12-08 suggestion validation on demand, instead of
// waiting for the 13:00 UTC cron — the site owner wanted to see a rotation's result immediately.
// Authenticated identically to the pre-existing /admin/subs and /admin/feedback routes
// (checkAdminKey, admin.mjs): 404 until ADMIN_KEY is configured, 401 on a wrong/missing key.
import { test } from "node:test";
import assert from "node:assert/strict";
import { checkAdminKey } from "../src/admin.mjs";
import { handleAdminSuggestRefresh } from "../src/suggest.mjs";
import { SUGGESTIONS_KV_KEY } from "../src/suggest.mjs";

function kv(map = {}) {
  return {
    get: async (k) => (Object.prototype.hasOwnProperty.call(map, k) ? map[k] : null),
    put: async (k, v) => { map[k] = v; },
  };
}
const post = (url = "https://w/admin/suggest-refresh", headers = {}) =>
  new Request(url, { method: "POST", headers });

// ---- checkAdminKey: the shared gate reused across every /admin/* route -------------------

test("checkAdminKey: 404 (not 401) when ADMIN_KEY is unset — fails closed without revealing the route", () => {
  const r = checkAdminKey(post(), {});
  assert.equal(r.ok, false);
  assert.equal(r.res.status, 404);
});

test("checkAdminKey: 401 on a missing or wrong key", () => {
  const env = { ADMIN_KEY: "s3cr3t" };
  assert.equal(checkAdminKey(post(), env).res.status, 401);
  assert.equal(checkAdminKey(post("https://w/admin/suggest-refresh?key=wrong"), env).res.status, 401);
});

test("checkAdminKey: accepts the key via ?key= or an Authorization: Bearer header", () => {
  const env = { ADMIN_KEY: "s3cr3t" };
  assert.equal(checkAdminKey(post("https://w/admin/suggest-refresh?key=s3cr3t"), env).ok, true);
  assert.equal(checkAdminKey(post("https://w/admin/suggest-refresh", { authorization: "Bearer s3cr3t" }), env).ok, true);
});

// ---- POST /admin/suggest-refresh ----------------------------------------------------------

test("handleAdminSuggestRefresh: 404 without ADMIN_KEY configured", async () => {
  const r = await handleAdminSuggestRefresh(post(), {});
  assert.equal(r.status, 404);
});

test("handleAdminSuggestRefresh: 401 without the correct key", async () => {
  const r = await handleAdminSuggestRefresh(post(), { ADMIN_KEY: "s3cr3t" });
  assert.equal(r.status, 401);
});

test("handleAdminSuggestRefresh: 405 on a non-POST method even with a valid key", async () => {
  const r = await handleAdminSuggestRefresh(
    new Request("https://w/admin/suggest-refresh?key=s3cr3t", { method: "GET" }),
    { ADMIN_KEY: "s3cr3t" },
  );
  assert.equal(r.status, 405);
});

test("handleAdminSuggestRefresh: success returns runSuggestionValidation()'s summary JSON plus a timestamp", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    if (String(url).includes("api.anthropic.com")) {
      const input = { keywords: ["construction"], minAmount: 500000, maxAmount: null, category: null, agency: null, months: null, noticeType: null, excludeSpecial: false };
      return { ok: true, json: async () => ({ content: [{ type: "tool_use", name: "build_filter", input }] }) };
    }
    return { ok: true, json: async () => [{ n: "42" }] };
  };
  const kvStore = {};
  const env = { ADMIN_KEY: "s3cr3t", ANTHROPIC_API_KEY: "test-key", ALERT_STATE: kv(kvStore) };
  try {
    const r = await handleAdminSuggestRefresh(post("https://w/admin/suggest-refresh?key=s3cr3t"), env);
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.equal(body.status, "success");
    assert.ok(body.byLens.money.some((c) => c.count === 42));
    assert.ok(body.triggeredAt, "should carry a triggeredAt timestamp");
    assert.ok(JSON.parse(kvStore[SUGGESTIONS_KV_KEY]).byLens.money.length, "should write the validated set to KV, same as the cron path");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("handleAdminSuggestRefresh: fail-soft — an unanticipated error is reported in the response, not thrown, and the previous KV value is left untouched", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error("socrata down"); };
  const kvStore = { [SUGGESTIONS_KV_KEY]: JSON.stringify({ generatedAt: "yesterday", minResults: 3, byLens: { money: [{ idx: 0, count: 99 }] } }) };
  const env = { ADMIN_KEY: "s3cr3t", ANTHROPIC_API_KEY: "test-key", ALERT_STATE: kv(kvStore) };
  try {
    const r = await handleAdminSuggestRefresh(post("https://w/admin/suggest-refresh?key=s3cr3t"), env);
    assert.equal(r.status, 200); // every fetch failure is caught candidate-by-candidate inside runSuggestionValidation
    const body = await r.json();
    assert.equal(body.status, "skipped");
    assert.equal(body.reason, "no-fruitful-candidates");
    assert.equal(kvStore[SUGGESTIONS_KV_KEY], JSON.stringify({ generatedAt: "yesterday", minResults: 3, byLens: { money: [{ idx: 0, count: 99 }] } }), "must not overwrite the previous validated set");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("handleAdminSuggestRefresh: a genuinely unanticipated throw outside the per-candidate try/catch (e.g. a KV outage on the final write) is caught and reported as a 500, not left to crash the route", async () => {
  // Candidates resolve/count fine (fruitful), so runSuggestionValidation() reaches its own
  // uncaught ALERT_STATE.put() call — the one spot worker.mjs's scheduled handler documents as
  // needing an outer catch for something the pipeline itself didn't anticipate.
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    if (String(url).includes("api.anthropic.com")) {
      const input = { keywords: ["construction"], minAmount: 500000, maxAmount: null, category: null, agency: null, months: null, noticeType: null, excludeSpecial: false };
      return { ok: true, json: async () => ({ content: [{ type: "tool_use", name: "build_filter", input }] }) };
    }
    return { ok: true, json: async () => [{ n: "42" }] };
  };
  const env = {
    ADMIN_KEY: "s3cr3t",
    ANTHROPIC_API_KEY: "test-key",
    ALERT_STATE: { get: async () => null, put: async () => { throw new Error("KV outage"); } },
  };
  try {
    const r = await handleAdminSuggestRefresh(post("https://w/admin/suggest-refresh?key=s3cr3t"), env);
    assert.equal(r.status, 500);
    const body = await r.json();
    assert.equal(body.status, "error");
    assert.match(body.error, /KV outage/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
