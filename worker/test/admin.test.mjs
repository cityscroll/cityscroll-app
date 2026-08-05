// w12-13: a keyed admin trigger to run the w12-08 suggestion validation on demand, instead of
// waiting for the 13:00 UTC cron — the site owner wanted to see a rotation's result immediately.
// Authenticated identically to the pre-existing /admin/subs and /admin/feedback routes
// (checkAdminKey, admin.mjs): 404 until ADMIN_KEY is configured, 401 on a wrong/missing key.
import { test } from "node:test";
import assert from "node:assert/strict";
import { checkAdminKey, checkOperatorProbeKey, checkDigestShadowAuth, handleAdminDigestSendTest } from "../src/admin.mjs";
import { handleAdminSuggestRefresh } from "../src/suggest.mjs";
import { SUGGESTIONS_KV_KEY } from "../src/suggest.mjs";
import { handleAdminMeetingOutcomesRefresh } from "../src/meeting_outcomes.mjs";
import { handleAdminZapOutcomesRefresh } from "../src/zap_outcomes.mjs";
import worker from "../src/worker.mjs";

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

test("checkOperatorProbeKey: accepts either ADMIN_KEY or ANALYTICS_DEV_KEY", () => {
  const env = { ADMIN_KEY: "admin", ANALYTICS_DEV_KEY: "analytics" };
  assert.equal(checkOperatorProbeKey(post("https://w/admin/digest-send-test?key=admin"), env).ok, true);
  assert.equal(checkOperatorProbeKey(post("https://w/admin/digest-send-test?key=analytics"), env).ok, true);
  assert.equal(checkOperatorProbeKey(post("https://w/admin/digest-send-test", { authorization: "Bearer analytics" }), env).ok, true);
  assert.equal(checkOperatorProbeKey(post("https://w/admin/digest-send-test?key=wrong"), env).res.status, 401);
  assert.equal(checkOperatorProbeKey(post(), {}).res.status, 404);
});

// ---- checkDigestShadowAuth: scoped SHADOW_STATUS_KEY for GET /admin/digest-shadow only ---------

function get(url = "https://w/admin/digest-shadow", headers = {}) {
  return new Request(url, { method: "GET", headers });
}
function postShadow(url = "https://w/admin/digest-shadow", headers = {}) {
  return new Request(url, { method: "POST", headers });
}

test("checkDigestShadowAuth: GET accepts ADMIN_KEY or the read-only SHADOW_STATUS_KEY", () => {
  const env = { ADMIN_KEY: "admin-key", SHADOW_STATUS_KEY: "shadow-key" };
  assert.equal(checkDigestShadowAuth(get("https://w/admin/digest-shadow?key=admin-key"), env).ok, true);
  assert.equal(checkDigestShadowAuth(get("https://w/admin/digest-shadow?key=shadow-key"), env).ok, true);
  assert.equal(checkDigestShadowAuth(get("https://w/admin/digest-shadow", { authorization: "Bearer shadow-key" }), env).ok, true);
  assert.equal(checkDigestShadowAuth(get("https://w/admin/digest-shadow?key=wrong"), env).res.status, 401);
  assert.equal(checkDigestShadowAuth(get("https://w/admin/subs?key=shadow-key"), env).res.status, 401);
});

test("checkDigestShadowAuth: POST accepts ADMIN_KEY but rejects SHADOW_STATUS_KEY (401)", () => {
  const env = { ADMIN_KEY: "admin-key", SHADOW_STATUS_KEY: "shadow-key" };
  assert.equal(checkDigestShadowAuth(postShadow("https://w/admin/digest-shadow?key=admin-key"), env).ok, true);
  assert.equal(checkDigestShadowAuth(postShadow("https://w/admin/digest-shadow?key=shadow-key"), env).res.status, 401);
  assert.equal(checkDigestShadowAuth(postShadow("https://w/admin/digest-shadow", { authorization: "Bearer shadow-key" }), env).res.status, 401);
});

test("checkDigestShadowAuth: fails closed (404) when no accepted secret is configured", () => {
  assert.equal(checkDigestShadowAuth(get(), {}).res.status, 404);
  // GET reveals the route only when SHADOW_STATUS_KEY is configured even without ADMIN_KEY.
  assert.equal(checkDigestShadowAuth(get("https://w/admin/digest-shadow?key=shadow-key"), { SHADOW_STATUS_KEY: "shadow-key" }).ok, true);
  // POST still requires ADMIN_KEY; SHADOW_STATUS_KEY alone is not enough for the write path.
  assert.equal(checkDigestShadowAuth(postShadow("https://w/admin/digest-shadow?key=shadow-key"), { SHADOW_STATUS_KEY: "shadow-key" }).res.status, 404);
});

test("SHADOW_STATUS_KEY is rejected by the shared admin gates", () => {
  const env = { ADMIN_KEY: "admin-key", SHADOW_STATUS_KEY: "shadow-key" };
  assert.equal(checkAdminKey(post("https://w/admin/suggest-refresh?key=shadow-key"), env).res.status, 401);
  assert.equal(checkAdminKey(post("https://w/admin/digest-catchup?key=shadow-key"), env).res.status, 401);
  assert.equal(checkAdminKey(get("https://w/admin/subs?key=shadow-key"), env).res.status, 401);
  assert.equal(checkAdminKey(get("https://w/admin/ops-contract?key=shadow-key"), env).res.status, 401);
  // ADMIN_KEY continues to work everywhere as today.
  assert.equal(checkAdminKey(post("https://w/admin/suggest-refresh?key=admin-key"), env).ok, true);
});

test("SHADOW_STATUS_KEY gets 401 from every other registered /admin/* route", async () => {
  const routes = [
    ["GET", "/admin/subs"],
    ["GET", "/admin/watch-log"],
    ["POST", "/admin/watch-log/enrich"],
    ["GET", "/admin/feedback"],
    ["GET", "/admin/possibly-same"],
    ["POST", "/admin/possibly-same"],
    ["GET", "/admin/ops-contract"],
    ["GET", "/admin/digest-rollup"],
    ["POST", "/admin/digest-shadow"],
    ["POST", "/admin/digest-send-test"],
    ["POST", "/admin/suggest-refresh"],
    ["POST", "/admin/meeting-outcomes-refresh"],
    ["POST", "/admin/zap-outcomes-refresh"],
    ["POST", "/admin/digest-catchup"],
    ["POST", "/admin/passport-ingest"],
    ["POST", "/admin/attachment-metadata"],
  ];
  const env = {
    ADMIN_KEY: "admin-key",
    ANALYTICS_DEV_KEY: "analytics-key",
    SHADOW_STATUS_KEY: "shadow-key",
  };

  for (const [method, path] of routes) {
    const response = await worker.fetch(new Request(`https://w${path}`, {
      method,
      headers: { authorization: "Bearer shadow-key" },
    }), env, {});
    assert.equal(response.status, 401, `${method} ${path}`);
    assert.deepEqual(await response.json(), { error: "unauthorized" }, `${method} ${path}`);
  }
});

test("checkDigestShadowAuth: 401 response shape matches the shared admin gate", async () => {
  const env = { ADMIN_KEY: "admin-key", SHADOW_STATUS_KEY: "shadow-key" };
  const scoped = checkDigestShadowAuth(get("https://w/admin/digest-shadow?key=wrong"), env).res;
  const shared = checkAdminKey(post("https://w/admin/suggest-refresh?key=wrong"), env).res;
  assert.equal(scoped.status, shared.status);
  assert.deepEqual(await scoped.json(), await shared.json());
});

test("handleAdminDigestSendTest: fails closed and enforces the recipient allowlist", async () => {
  const body = (email) => new Request("https://w/admin/digest-send-test?key=s3cr3t", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email }),
  });
  assert.equal((await handleAdminDigestSendTest(body("example@example.com"), {})).status, 404);
  assert.equal((await handleAdminDigestSendTest(body("example@example.com"), { ADMIN_KEY: "s3cr3t" })).status, 403);
  assert.equal((await handleAdminDigestSendTest(body("not-a-recipient"), { ANALYTICS_DEV_KEY: "s3cr3t" })).status, 403);
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

// ---- POST /admin/meeting-outcomes-refresh ----------------------------------------------

const meetingRefreshPost = (url = "https://w/admin/meeting-outcomes-refresh", headers = {}) =>
  new Request(url, { method: "POST", headers });

test("handleAdminMeetingOutcomesRefresh: 404 without ADMIN_KEY configured", async () => {
  const r = await handleAdminMeetingOutcomesRefresh(meetingRefreshPost(), {});
  assert.equal(r.status, 404);
});

test("handleAdminMeetingOutcomesRefresh: 401 without the correct key", async () => {
  const r = await handleAdminMeetingOutcomesRefresh(meetingRefreshPost(), { ADMIN_KEY: "s3cr3t" });
  assert.equal(r.status, 401);
});

test("handleAdminMeetingOutcomesRefresh: 405 on non-POST", async () => {
  const r = await handleAdminMeetingOutcomesRefresh(
    new Request("https://w/admin/meeting-outcomes-refresh?key=s3cr3t", { method: "GET" }),
    { ADMIN_KEY: "s3cr3t", ALERT_STATE: kv() },
  );
  assert.equal(r.status, 405);
});

test("handleAdminMeetingOutcomesRefresh: success returns refresh summary plus timestamp", async () => {
  const r = await handleAdminMeetingOutcomesRefresh(
    meetingRefreshPost("https://w/admin/meeting-outcomes-refresh?key=s3cr3t"),
    { ADMIN_KEY: "s3cr3t" },
  );
  assert.equal(r.status, 200);
  const body = await r.json();
  // Without ALERT_STATE the refresh is a documented no-op (same as cron path).
  assert.equal(body.status, "skipped");
  assert.equal(body.reason, "no-kv");
  assert.ok(body.triggeredAt);
});

// ---- POST /admin/zap-outcomes-refresh ---------------------------------------------------

const zapRefreshPost = (url = "https://w/admin/zap-outcomes-refresh", headers = {}) =>
  new Request(url, { method: "POST", headers });

test("handleAdminZapOutcomesRefresh: 404 without ADMIN_KEY configured", async () => {
  const r = await handleAdminZapOutcomesRefresh(zapRefreshPost(), {});
  assert.equal(r.status, 404);
});

test("handleAdminZapOutcomesRefresh: 401 without the correct key", async () => {
  const r = await handleAdminZapOutcomesRefresh(zapRefreshPost(), { ADMIN_KEY: "s3cr3t" });
  assert.equal(r.status, 401);
});

test("handleAdminZapOutcomesRefresh: 405 on non-POST", async () => {
  const r = await handleAdminZapOutcomesRefresh(
    new Request("https://w/admin/zap-outcomes-refresh?key=s3cr3t", { method: "GET" }),
    { ADMIN_KEY: "s3cr3t", ALERT_STATE: kv() },
  );
  assert.equal(r.status, 405);
});

test("handleAdminZapOutcomesRefresh: success returns refresh summary plus timestamp", async () => {
  const r = await handleAdminZapOutcomesRefresh(
    zapRefreshPost("https://w/admin/zap-outcomes-refresh?key=s3cr3t"),
    { ADMIN_KEY: "s3cr3t" },
  );
  assert.equal(r.status, 200);
  const body = await r.json();
  // Without ALERT_STATE the refresh is a documented no-op (same as cron path).
  assert.equal(body.status, "skipped");
  assert.equal(body.reason, "no-kv");
  assert.ok(body.triggeredAt);
});
