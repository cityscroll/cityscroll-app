// w12-13: a keyed admin trigger to run the w12-08 suggestion validation on demand, instead of
// waiting for the 13:00 UTC cron — the site owner wanted to see a rotation's result immediately.
// Authenticated identically to the pre-existing /admin/subs and /admin/feedback routes
// (checkAdminKey, admin.mjs): 404 until ADMIN_KEY is configured, 401 on a wrong/missing key.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  checkAdminKey,
  checkOperatorProbeKey,
  checkDigestShadowAuth,
  handleAdminDigestSendTest,
  handleAdminFeedback,
  handleAdminReportAdjudication,
  handleAdminStats,
  renderAdminStatsPage,
} from "../src/admin.mjs";
import { deskItemLeaksPrivateFields } from "../src/lib/feedback_desk.mjs";
import { buildContractReportTarget } from "../../site/report_issue.mjs";
import { handleAdminSuggestRefresh } from "../src/suggest.mjs";
import { SUGGESTIONS_KV_KEY } from "../src/suggest.mjs";
import { SUGGESTION_LENSES } from "../src/lib/preset_fallback_kv.mjs";
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
    ["GET", "/admin/performance"],
    ["GET", "/admin/stats"],
    ["GET", "/admin/owed-backlog"],
    ["GET", "/admin/next-digest-preview"],
    ["GET", "/admin/digest-rollup"],
    ["POST", "/admin/digest-shadow"],
    ["POST", "/admin/digest-send-test"],
    ["POST", "/admin/ops-alert"],
    ["GET", "/admin/reliability/digest"],
    ["GET", "/admin/reliability/scheduler"],
    ["GET", "/admin/reliability/mail"],
    ["POST", "/admin/reliability/mail"],
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

test("handleAdminStats fails closed and serves private JSON or the responsive desk view", async () => {
  assert.equal((await handleAdminStats(new Request("https://w/admin/stats"), {})).status, 404);
  const env = { ADMIN_KEY: "secret" };
  const jsonResponse = await handleAdminStats(new Request("https://w/admin/stats?key=secret"), env, {
    now: "2026-08-05T18:00:00Z",
  });
  assert.equal(jsonResponse.status, 200);
  assert.equal(jsonResponse.headers.get("Cache-Control"), "no-store");
  const body = await jsonResponse.json();
  assert.deepEqual(body.subscriptions, { active: 0, accounts: 0 });
  assert.ok(body.usage);

  const htmlResponse = await handleAdminStats(new Request("https://w/admin/stats?key=secret&view=html"), env, {
    now: "2026-08-05T18:00:00Z",
  });
  assert.match(htmlResponse.headers.get("Content-Type"), /text\/html/);
  const html = await htmlResponse.text();
  assert.match(html, /Authenticated desk · private operations/);
  assert.match(html, /Product activity/);
  assert.match(html, /@media\(max-width:430px\)/);
  assert.match(renderAdminStatsPage(body), /Delivery operations/);
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

function mockSuggestionFetch(filter) {
  return async (url) => {
    if (String(url).includes("api.anthropic.com")) {
      return { ok: true, json: async () => ({ content: [{ type: "tool_use", name: "build_filter", input: filter }] }) };
    }
    return { ok: true, json: async () => [{ n: "42" }] };
  };
}

test("handleAdminSuggestRefresh: success returns runSuggestionValidation()'s summary JSON plus a timestamp", async () => {
  const originalFetch = globalThis.fetch;
  // Award-shaped construction is resident-snapshot fruitful without depending on
  // today's open-RFP clock (the field case that dropped money from byLens).
  globalThis.fetch = mockSuggestionFetch({
    keywords: ["construction"], minAmount: 500000, maxAmount: null, category: null,
    agency: null, months: null, noticeType: null, excludeSpecial: false,
  });
  const kvStore = {};
  const env = { ADMIN_KEY: "s3cr3t", ANTHROPIC_API_KEY: "test-key", ALERT_STATE: kv(kvStore) };
  try {
    const r = await handleAdminSuggestRefresh(post("https://w/admin/suggest-refresh?key=s3cr3t"), env);
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.equal(body.status, "success");
    for (const lens of SUGGESTION_LENSES) {
      assert.ok(Array.isArray(body.byLens[lens]), `${lens} must be present as an array even when empty`);
    }
    const money = body.byLens.money.find((candidate) => candidate.count >= 3);
    assert.ok(money);
    assert.equal(money.destination.schema, "cityscroll.money_suggestion_destination.v1");
    assert.equal(money.destination.finalCount, money.count);
    assert.match(money.destination.route, /^\/browse\/contracts\//);
    assert.ok(body.triggeredAt, "should carry a triggeredAt timestamp");
    const written = JSON.parse(kvStore[SUGGESTIONS_KV_KEY]);
    assert.ok(written.byLens.money.length, "should write the validated set to KV, same as the cron path");
    assert.ok(Array.isArray(written.byLens.money));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("handleAdminSuggestRefresh: an empty money lens is [] not missing, and the route does not throw", async () => {
  const originalFetch = globalThis.fetch;
  // A keyword with no resident-snapshot hits keeps money empty while SODA n=42
  // still fruits the other lenses — the shape that used to omit byLens.money.
  globalThis.fetch = mockSuggestionFetch({
    keywords: ["zzzxnotarealtopiczzzz"], minAmount: null, maxAmount: null, category: null,
    agency: null, months: null, noticeType: null, excludeSpecial: false,
  });
  const kvStore = {};
  const env = { ADMIN_KEY: "s3cr3t", ANTHROPIC_API_KEY: "test-key", ALERT_STATE: kv(kvStore) };
  try {
    const r = await handleAdminSuggestRefresh(post("https://w/admin/suggest-refresh?key=s3cr3t"), env);
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.equal(body.status, "success");
    for (const lens of SUGGESTION_LENSES) {
      assert.ok(Array.isArray(body.byLens[lens]), `${lens} must stay an array`);
    }
    const money = body.byLens.money.find((candidate) => candidate.count >= 3);
    assert.equal(money, undefined);
    assert.ok(SUGGESTION_LENSES.some((lens) => body.byLens[lens].length), "other lenses still write");
    assert.deepEqual(JSON.parse(kvStore[SUGGESTIONS_KV_KEY]).byLens.money, []);
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
      const input = { keywords: ["maintenance"], minAmount: null, maxAmount: null, category: null, agency: null, months: null, noticeType: null, excludeSpecial: false };
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

function feedbackKv(map = {}) {
  return {
    get: async (k) => (Object.prototype.hasOwnProperty.call(map, k) ? map[k] : null),
    put: async (k, v) => { map[k] = v; },
    list: async ({ prefix = "" } = {}) => ({
      keys: Object.keys(map).filter((name) => name.startsWith(prefix)).map((name) => ({ name })),
      list_complete: true,
    }),
  };
}

test("handleAdminFeedback: 404 without ADMIN_KEY, 401 with the wrong key", async () => {
  const store = feedbackKv({
    "fb:1": JSON.stringify({ category: "bug", message: "Something broke on the money tab.", at: "2026-08-29T00:00:00.000Z" }),
  });
  assert.equal((await handleAdminFeedback(new Request("https://w/admin/feedback?key=s3cr3t"), { FEEDBACK: store })).status, 404);
  assert.equal((await handleAdminFeedback(new Request("https://w/admin/feedback"), { ADMIN_KEY: "s3cr3t", FEEDBACK: store })).status, 401);
  assert.equal((await handleAdminFeedback(new Request("https://w/admin/feedback?key=nope"), { ADMIN_KEY: "s3cr3t", FEEDBACK: store })).status, 401);
});

test("handleAdminFeedback: contextual report fields round-trip; private metadata stays off the wire", async () => {
  const target = buildContractReportTarget({
    procurement_id: "procurement:contract:CT123",
    canonical_href: "/procurements/procurement%3Acontract%3ACT123",
    short_title: "Street repair contract",
    vendor_name: "Acme Works",
    source_observation_refs: ["passport_public_contracts:row-1"],
  });
  const store = feedbackKv({
    "fb:100:one": JSON.stringify({
      category: "report",
      message: "The published vendor name does not match the source record.",
      evidence: "Public contract source row",
      report_target: target,
      report: {
        category: "information_wrong",
        explanation: "The published vendor name does not match the source record.",
        evidence: "Public contract source row",
      },
      at: "2026-08-29T18:00:00.000Z",
      email: "reporter@example.com",
      ip: "203.0.113.88",
      ua: "CityScrollTest/1.0",
      adjudication: { verdict: "confirmed", notes: "keep this adjudication private" },
    }),
    "fb:90:generic": JSON.stringify({
      category: "general",
      message: "The about page feedback form is hard to find.",
      at: "2026-08-29T17:00:00.000Z",
      email: "reporter@example.com",
      ip: "203.0.113.88",
      ua: "CityScrollTest/1.0",
    }),
    "rl:ip:ignored": JSON.stringify({ n: 3 }),
  });
  const response = await handleAdminFeedback(
    new Request("https://w/admin/feedback?key=s3cr3t"),
    { ADMIN_KEY: "s3cr3t", FEEDBACK: store },
  );
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.feedbackCount, 2);
  assert.equal(body.totalFbKeys, 2);
  assert.deepEqual(body.items.map((item) => item.id), ["fb:100:one", "fb:90:generic"]);
  assert.equal(body.items[0].target_id, target.target_id);
  assert.equal(body.items[0].canonical_url, target.canonical_url);
  assert.equal(body.items[0].report.category, "information_wrong");
  assert.equal(body.items[1].target_status, "missing");
  assert.equal(body.items[1].report_target, null);
  const serialized = JSON.stringify(body);
  assert.equal(serialized.includes("reporter@example.com"), false);
  assert.equal(serialized.includes("203.0.113.88"), false);
  assert.equal(serialized.includes("CityScrollTest/1.0"), false);
  assert.equal(serialized.includes("keep this adjudication private"), false);
  for (const item of body.items) {
    assert.equal(deskItemLeaksPrivateFields(item, [
      "reporter@example.com", "203.0.113.88", "CityScrollTest/1.0", "keep this adjudication private",
    ]), false);
  }
});

test("handleAdminFeedback refuses writes so listing cannot become an accidental write surface", async () => {
  const store = feedbackKv({
    "fb:1": JSON.stringify({ category: "bug", message: "Something broke on the money tab.", at: "2026-08-29T00:00:00.000Z" }),
  });
  const response = await handleAdminFeedback(
    new Request("https://w/admin/feedback?key=s3cr3t", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ verdict: "confirmed", actor: "someone" }),
    }),
    { ADMIN_KEY: "s3cr3t", FEEDBACK: store },
  );
  assert.equal(response.status, 405);
});

test("handleAdminReportAdjudication records a bounded private verdict and keeps it off the public desk listing", async () => {
  const target = buildContractReportTarget({
    procurement_id: "procurement:contract:CT123",
    canonical_href: "/procurements/procurement%3Acontract%3ACT123",
    short_title: "Street repair contract",
    vendor_name: "Acme Works",
    source_observation_refs: ["passport_public_contracts:row-1"],
  });
  const sourceIds = target.provenance?.source_record_ids?.length
    ? target.provenance.source_record_ids
    : ["passport_public_contracts:row-1"];
  const map = {
    "fb:100:one": JSON.stringify({
      category: "report",
      message: "The published vendor name does not match the source record.",
      evidence: "Public contract source row",
      report_target: target,
      report: {
        category: "information_wrong",
        explanation: "The published vendor name does not match the source record.",
        evidence: "Public contract source row",
      },
      at: "2026-08-29T18:00:00.000Z",
      email: "reporter@example.com",
    }),
  };
  const store = feedbackKv(map);
  const posted = await handleAdminReportAdjudication(
    new Request("https://w/admin/report-adjudication?key=s3cr3t", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        report_id: "fb:100:one",
        command_id: "cmd-admin-1",
        actor: "maintainer:desk",
        at: "2026-08-31T18:00:00.000Z",
        verdict: "correct-as-displayed",
        evidence: sourceIds,
        scope: { source_record_ids: sourceIds },
        reporter_resolution: true,
      }),
    }),
    { ADMIN_KEY: "s3cr3t", FEEDBACK: store },
  );
  assert.equal(posted.status, 201);
  const recorded = await posted.json();
  assert.equal(recorded.item.verdict, "correct-as-displayed");
  assert.equal(recorded.item.actor, "maintainer:desk");
  assert.equal(recorded.item.civic_result_changed, false);

  const missingActor = await handleAdminReportAdjudication(
    new Request("https://w/admin/report-adjudication?key=s3cr3t", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        report_id: "fb:100:one",
        verdict: "confirmed",
        evidence: ["src-1"],
      }),
    }),
    { ADMIN_KEY: "s3cr3t", FEEDBACK: store },
  );
  assert.equal(missingActor.status, 400);

  const listing = await handleAdminFeedback(
    new Request("https://w/admin/feedback?key=s3cr3t"),
    { ADMIN_KEY: "s3cr3t", FEEDBACK: store },
  );
  const body = await listing.json();
  assert.equal(body.items.length, 1);
  assert.equal(JSON.stringify(body).includes("maintainer:desk"), false);
  assert.equal(JSON.stringify(body).includes("correct-as-displayed"), false);
});
