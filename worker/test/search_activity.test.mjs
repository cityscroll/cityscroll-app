/**
 * Private search-activity intake and its authenticated read model.
 *
 * Covers the Worker-owned half of the receipt: the first-party visitor cookie and
 * its security attributes, recognized-account resolution, developer traffic
 * classification, bounded validation, retention, the authenticated read, and the
 * fail-soft posture that keeps Search unaffected by any of it.
 *
 * verify: node --test worker/test/search_activity.test.mjs
 */
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { test } from "node:test";

import { signToken } from "optin-token";

import {
  SEARCH_ACTIVITY_FAMILIES,
  SEARCH_ACTIVITY_MAX_REQUEST_BYTES,
  SEARCH_EXECUTION_RECEIPT_SCHEMA,
} from "../../capabilities/search_activity.mjs";
import { handleAdminSearchActivity } from "../src/admin.mjs";
import { handleEvent } from "../src/events.mjs";
import { handleSearchActivity } from "../src/search_activity.mjs";
import {
  SEARCH_ACTIVITY_DEVELOPER_KEY_PREFIX,
  SEARCH_ACTIVITY_KEY_PREFIX,
  SEARCH_ACTIVITY_RETENTION_SECONDS,
  VISITOR_COOKIE_NAME,
  classifyUserAgent,
  isWellFormedVisitorId,
  newVisitorId,
  readVisitorCookie,
  redactedAccountLabel,
  searchActivityKey,
  visitorCookieHeader,
} from "../src/lib/search_activity.mjs";
import { deriveSubscriberId } from "../src/lib/subscriptions.mjs";
import { sessionPayload } from "../src/lib/session.mjs";

const INTAKE_URL = "https://api.cityscroll.org/search-activity";
const ORIGIN = "https://cityscroll.org";
const ADMIN_KEY = "admin-secret";
const DEV_SECRET = "developer-exclusion-secret-at-least-32-chars";
const TOKEN_SECRET = "token-secret-for-session-cookies-0123456789";

function kv() {
  const store = new Map();
  const ttls = new Map();
  return {
    store,
    ttls,
    get: async (key) => (store.has(key) ? store.get(key) : null),
    put: async (key, value, options = {}) => {
      store.set(key, value);
      if (options.expirationTtl) ttls.set(key, options.expirationTtl);
    },
    list: async ({ prefix = "", limit = 1000 } = {}) => {
      const keys = [...store.keys()].filter((key) => key.startsWith(prefix)).sort();
      return { keys: keys.slice(0, limit).map((name) => ({ name })), list_complete: true };
    },
  };
}

function productionEnv(overrides = {}) {
  return {
    ANALYTICS_ENVIRONMENT: "production",
    ANALYTICS_DEV_KEY: DEV_SECRET,
    ADMIN_KEY,
    TOKEN_SECRET,
    ALERT_STATE: kv(),
    ...overrides,
  };
}

function submission(overrides = {}) {
  return {
    schema: SEARCH_EXECUTION_RECEIPT_SCHEMA,
    occurred_at: "2026-09-01T12:00:00.000Z",
    query: { raw: "rats", normalized: "rats" },
    search_path: "/search/",
    scope: {},
    outcome: "matched",
    rendered_count: 2,
    family_counts: { contracts: 1, meetings: 1 },
    incomplete_families: [],
    results: [
      {
        reference: "procurement:rats-abatement-2026",
        entity_type: "procurement",
        family: "contracts",
        kind: "keyword",
        rank: 1,
        title: "Rodent (rats) abatement services",
        canonical_href: "/contracts/rats-abatement-2026",
      },
      {
        reference: "meeting:cb3-rats-hearing",
        entity_type: "meeting",
        family: "meetings",
        kind: "keyword",
        rank: 2,
        title: "Public hearing on rats and refuse",
        canonical_href: "/meetings/cb3-rats-hearing",
      },
    ],
    producers: { search_method: "keyword", search_schema: "cityscroll.keyword_search_response.v1" },
    ...overrides,
  };
}

function intake(body = submission(), headers = {}, url = INTAKE_URL) {
  return new Request(url, {
    method: "POST",
    headers: { Origin: ORIGIN, "Content-Type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

function devToken(secret = DEV_SECRET, nowMs = Date.now()) {
  const timestamp = Math.floor(nowMs / 1000);
  const signature = createHmac("sha256", secret)
    .update(`crol-analytics-dev-exclusion\n${timestamp}`)
    .digest("base64url");
  return `v1.${timestamp}.${signature}`;
}

function setCookieValues(response) {
  return response.headers.getSetCookie?.() || [response.headers.get("set-cookie")].filter(Boolean);
}

function visitorCookieFrom(response) {
  const header = setCookieValues(response).find((value) => value.startsWith(`${VISITOR_COOKIE_NAME}=`));
  return header ? header.slice(`${VISITOR_COOKIE_NAME}=`.length).split(";")[0] : null;
}

function storedReceipts(env, prefix = SEARCH_ACTIVITY_KEY_PREFIX) {
  return [...env.ALERT_STATE.store.entries()]
    .filter(([key]) => key.startsWith(prefix))
    .map(([, value]) => JSON.parse(value));
}

// ---- what a completed Search stores ----

test("one completed search stores exactly one receipt with the rendered rows", async () => {
  const env = productionEnv();
  const response = await handleSearchActivity(intake(), env);
  assert.equal(response.status, 202);

  const receipts = storedReceipts(env);
  assert.equal(receipts.length, 1);
  const [receipt] = receipts;
  assert.equal(receipt.schema, SEARCH_EXECUTION_RECEIPT_SCHEMA);
  assert.equal(receipt.query.raw, "rats");
  assert.equal(receipt.outcome, "matched");
  assert.deepEqual(receipt.results.map((row) => row.reference), [
    "procurement:rats-abatement-2026",
    "meeting:cb3-rats-hearing",
  ]);
  assert.deepEqual(receipt.results.map((row) => row.rank), [1, 2]);
  assert.equal(receipt.traffic_class, "production");
  assert.ok(receipt.receipt_id.startsWith("rcpt_"));
  assert.ok(receipt.execution_id.startsWith("exec_"));
  assert.ok(receipt.received_at);
});

test("distinct outcomes survive the authenticated read path", async () => {
  const env = productionEnv();
  const cases = [
    ["matched", submission()],
    ["empty", submission({ outcome: "empty", rendered_count: 0, results: [], family_counts: {} })],
    ["partial", submission({ outcome: "partial", incomplete_families: ["meetings"] })],
    ["unavailable", submission({
      outcome: "unavailable", rendered_count: 0, results: [], family_counts: {},
      incomplete_families: [...SEARCH_ACTIVITY_FAMILIES],
    })],
  ];
  for (const [, body] of cases) {
    assert.equal((await handleSearchActivity(intake(body), env)).status, 202);
  }

  const read = await handleAdminSearchActivity(
    new Request(`https://api.cityscroll.org/admin/search-activity?key=${ADMIN_KEY}`),
    env,
  );
  assert.equal(read.status, 200);
  const payload = await read.json();
  assert.equal(payload.count, 4);
  assert.deepEqual(
    [...payload.items.map((item) => item.outcome)].sort(),
    ["empty", "matched", "partial", "unavailable"],
  );
  const unavailable = payload.items.find((item) => item.outcome === "unavailable");
  assert.deepEqual(unavailable.incomplete_families, [...SEARCH_ACTIVITY_FAMILIES]);
});

test("the read model returns newest executions first and honors its bound", async () => {
  const env = productionEnv();
  for (const query of ["one", "two", "three"]) {
    await handleSearchActivity(intake(submission({ query: { raw: query, normalized: query } })), env);
  }
  const read = await handleAdminSearchActivity(
    new Request(`https://api.cityscroll.org/admin/search-activity?key=${ADMIN_KEY}&limit=2`),
    env,
  );
  const payload = await read.json();
  assert.equal(payload.limit, 2);
  assert.equal(payload.count, 2);
  const times = payload.items.map((item) => item.received_at);
  assert.deepEqual([...times].sort().reverse(), times, "newest first");
});

// ---- browser identity vs account identity ----

test("two searches from one browser share one visitor id", async () => {
  const env = productionEnv();
  const first = await handleSearchActivity(intake(), env);
  const visitorId = visitorCookieFrom(first);
  assert.ok(isWellFormedVisitorId(visitorId));

  await handleSearchActivity(intake(submission(), { Cookie: `${VISITOR_COOKIE_NAME}=${visitorId}` }), env);
  const receipts = storedReceipts(env);
  assert.equal(receipts.length, 2);
  assert.equal(receipts[0].visitor_id, receipts[1].visitor_id);
  assert.equal(receipts[0].visitor_id, visitorId);
});

test("two browser profiles with the same User-Agent get different visitor ids", async () => {
  const env = productionEnv();
  const sameUserAgent = { "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Chrome/141.0.0.0 Safari/537.36" };
  const one = visitorCookieFrom(await handleSearchActivity(intake(submission(), sameUserAgent), env));
  const two = visitorCookieFrom(await handleSearchActivity(intake(submission(), sameUserAgent), env));
  assert.ok(one && two);
  assert.notEqual(one, two, "a visitor id is random, never derived from the browser");
});

test("a recognized session records visitor, subscriber, and a redacted label", async () => {
  const env = productionEnv();
  const email = "resident@example.org";
  const sessionToken = await signToken(TOKEN_SECRET, sessionPayload(email), { ttlSeconds: 3600 });
  const response = await handleSearchActivity(
    intake(submission(), { Cookie: `cs_session=${sessionToken}` }),
    env,
  );
  assert.equal(response.status, 202);

  const [receipt] = storedReceipts(env);
  assert.equal(receipt.recognition, "recognized");
  assert.ok(isWellFormedVisitorId(receipt.visitor_id));
  assert.equal(receipt.subscriber_id, await deriveSubscriberId(email));
  assert.equal(receipt.account_label, "r…@example.org");
  assert.notEqual(receipt.visitor_id, receipt.subscriber_id);
  assert.ok(!JSON.stringify(receipt).includes(email), "the raw address never reaches the receipt");
});

test("an unrecognized search stays anonymous without losing its browser identity", async () => {
  const env = productionEnv();
  await handleSearchActivity(intake(), env);
  const [receipt] = storedReceipts(env);
  assert.equal(receipt.recognition, "anonymous");
  assert.equal(receipt.subscriber_id, null);
  assert.equal(receipt.account_label, null);
  assert.ok(isWellFormedVisitorId(receipt.visitor_id));
});

// ---- cookie and identity boundaries ----

test("the visitor cookie is first-party, HttpOnly, Secure, SameSite=Lax, and ~1 year", async () => {
  const env = productionEnv();
  const header = setCookieValues(await handleSearchActivity(intake(), env))
    .find((value) => value.startsWith(`${VISITOR_COOKIE_NAME}=`));
  assert.ok(header, "a first search issues the cookie");
  assert.match(header, /HttpOnly/);
  assert.match(header, /Secure/);
  assert.match(header, /SameSite=Lax/);
  assert.match(header, /Domain=cityscroll\.org/);
  assert.match(header, /Path=\//);
  const maxAge = Number(header.match(/Max-Age=(\d+)/)[1]);
  assert.equal(maxAge, 365 * 24 * 3600);
});

test("a visitor id carries at least 128 bits of randomness and is not a credential", async () => {
  const ids = new Set(Array.from({ length: 200 }, () => newVisitorId()));
  assert.equal(ids.size, 200, "ids are unique across a large sample");
  const [sample] = ids;
  // base64url over 32 random bytes = 43 characters = 256 bits, well past the 128-bit floor.
  assert.equal(sample.length, "v1_".length + 43);
  assert.ok(isWellFormedVisitorId(sample));

  // A visitor id must never be accepted as proof of an account.
  const env = productionEnv();
  await handleSearchActivity(intake(submission(), { Cookie: `${VISITOR_COOKIE_NAME}=${sample}` }), env);
  const [receipt] = storedReceipts(env);
  assert.equal(receipt.visitor_id, sample);
  assert.equal(receipt.recognition, "anonymous");
  assert.equal(receipt.subscriber_id, null);
});

test("a forged or malformed visitor cookie is replaced, not trusted", async () => {
  const env = productionEnv();
  const response = await handleSearchActivity(
    intake(submission(), { Cookie: `${VISITOR_COOKIE_NAME}=../../etc/passwd` }),
    env,
  );
  const issued = visitorCookieFrom(response);
  assert.ok(isWellFormedVisitorId(issued));
  assert.equal(storedReceipts(env)[0].visitor_id, issued);
  assert.equal(readVisitorCookie("cs_visitor=not-a-valid-id"), null);
  assert.equal(readVisitorCookie(`cs_visitor=${issued}`), issued);
});

test("visitor, network, and subscriber observations stay in separate fields", async () => {
  const env = productionEnv();
  await handleSearchActivity(
    intake(submission(), { "CF-Connecting-IP": "203.0.113.10", "CF-IPCountry": "US" }),
    env,
  );
  const [receipt] = storedReceipts(env);
  assert.equal(receipt.network.request_ip, "203.0.113.10");
  assert.equal(receipt.network.country, "US");
  assert.notEqual(receipt.visitor_id, receipt.network.request_ip);
  assert.equal(receipt.network.retention_days, receipt.retention_days);
});

test("the cookie is only issued from the host that can share it with the site", () => {
  assert.match(visitorCookieHeader("v1_abc"), /Domain=cityscroll\.org/);
  // A compatibility or preview host must not mint a cookie the site cannot read.
  assert.equal(readVisitorCookie(""), null);
});

// ---- bounds, malformed input, and developer classification ----

test("unknown fields, malformed references, and bad JSON are rejected", async () => {
  const env = productionEnv();
  const cases = [
    [submission({ visitor_id: "v1_forged" }), "unknown_field"],
    [submission({ traffic_class: "production" }), "unknown_field"],
    [submission({ results: [{ ...submission().results[0], canonical_href: "https://evil.example/x" }],
      rendered_count: 1, family_counts: { contracts: 1 } }), "result_reference"],
    [submission({ rendered_count: 99 }), "rendered_count"],
    [submission({ search_path: "/browse/" }), "search_path"],
  ];
  for (const [body, reason] of cases) {
    const response = await handleSearchActivity(intake(body), env);
    assert.equal(response.status, 400);
    assert.equal((await response.json()).reason, reason);
  }
  const badJson = await handleSearchActivity(intake("{not json"), env);
  assert.equal(badJson.status, 400);
  assert.equal((await badJson.json()).reason, "bad-json");
  assert.equal(storedReceipts(env).length, 0, "nothing malformed is ever stored");
});

test("oversized requests are refused by declared length and by actual body", async () => {
  const env = productionEnv();
  const declared = await handleSearchActivity(
    intake(submission(), { "Content-Length": String(SEARCH_ACTIVITY_MAX_REQUEST_BYTES + 1) }),
    env,
  );
  assert.equal(declared.status, 413);

  const huge = JSON.stringify({ padding: "x".repeat(SEARCH_ACTIVITY_MAX_REQUEST_BYTES + 100) });
  assert.equal((await handleSearchActivity(intake(huge), env)).status, 413);
  assert.equal(storedReceipts(env).length, 0);
});

test("a malformed body never mints a visitor cookie", async () => {
  const env = productionEnv();
  const response = await handleSearchActivity(intake(submission({ search_path: "/browse/" })), env);
  assert.equal(response.status, 400);
  assert.equal(visitorCookieFrom(response), null, "identity is resolved only after validation");
});

test("developer activity is classified and kept out of the production cut", async () => {
  const env = productionEnv();
  await handleSearchActivity(intake(), env);
  await handleSearchActivity(intake(submission(), { "X-CROL-Analytics-Dev": devToken() }), env);

  const production = storedReceipts(env, SEARCH_ACTIVITY_KEY_PREFIX);
  const developer = storedReceipts(env, SEARCH_ACTIVITY_DEVELOPER_KEY_PREFIX);
  assert.equal(production.length, 1);
  assert.equal(developer.length, 1);
  assert.equal(production[0].traffic_class, "production");
  assert.equal(developer[0].traffic_class, "developer");

  const productionRead = await (await handleAdminSearchActivity(
    new Request(`https://api.cityscroll.org/admin/search-activity?key=${ADMIN_KEY}`), env,
  )).json();
  assert.equal(productionRead.count, 1, "developer receipts never inflate the production total");
  assert.equal(productionRead.traffic_class, "production");

  const developerRead = await (await handleAdminSearchActivity(
    new Request(`https://api.cityscroll.org/admin/search-activity?key=${ADMIN_KEY}&traffic_class=developer`), env,
  )).json();
  assert.equal(developerRead.count, 1);
});

test("an invalid developer token counts as ordinary production traffic", async () => {
  const env = productionEnv();
  await handleSearchActivity(intake(submission(), { "X-CROL-Analytics-Dev": devToken("wrong-secret-but-long-enough-here") }), env);
  assert.equal(storedReceipts(env, SEARCH_ACTIVITY_KEY_PREFIX).length, 1);
  assert.equal(storedReceipts(env, SEARCH_ACTIVITY_DEVELOPER_KEY_PREFIX).length, 0);
});

test("a non-production runtime never writes into the production cut", async () => {
  const env = productionEnv({ ANALYTICS_ENVIRONMENT: undefined });
  await handleSearchActivity(intake(), env);
  assert.equal(storedReceipts(env, SEARCH_ACTIVITY_KEY_PREFIX).length, 0);
  assert.equal(storedReceipts(env, SEARCH_ACTIVITY_DEVELOPER_KEY_PREFIX).length, 1);
});

test("retention is enforced by the store, not by a sweep", async () => {
  const env = productionEnv();
  await handleSearchActivity(intake(), env);
  const [key] = [...env.ALERT_STATE.store.keys()];
  assert.equal(env.ALERT_STATE.ttls.get(key), SEARCH_ACTIVITY_RETENTION_SECONDS);
  assert.equal(storedReceipts(env)[0].retention_days, 30);
});

test("receipt keys sort newest-first within their traffic class", () => {
  const older = searchActivityKey({ receivedAtMs: 1_000, receiptId: "rcpt_a", trafficClass: "production" });
  const newer = searchActivityKey({ receivedAtMs: 2_000, receiptId: "rcpt_b", trafficClass: "production" });
  assert.ok(newer < older, "a later receipt sorts first");
  assert.ok(older.startsWith(SEARCH_ACTIVITY_KEY_PREFIX));
  assert.ok(
    searchActivityKey({ receivedAtMs: 1, receiptId: "r", trafficClass: "developer" })
      .startsWith(SEARCH_ACTIVITY_DEVELOPER_KEY_PREFIX),
  );
  assert.ok(!searchActivityKey({ receivedAtMs: 1, receiptId: "r", trafficClass: "developer" })
    .startsWith(SEARCH_ACTIVITY_KEY_PREFIX), "the two prefixes are disjoint");
});

// ---- boundaries and fail-soft behavior ----

test("the read route fails closed and stays private", async () => {
  const unset = await handleAdminSearchActivity(
    new Request("https://api.cityscroll.org/admin/search-activity"), { ALERT_STATE: kv() },
  );
  assert.equal(unset.status, 404, "404 until ADMIN_KEY is configured");

  const env = productionEnv();
  const wrongKey = await handleAdminSearchActivity(
    new Request("https://api.cityscroll.org/admin/search-activity?key=nope"), env,
  );
  assert.equal(wrongKey.status, 401);

  await handleSearchActivity(intake(), env);
  const ok = await handleAdminSearchActivity(
    new Request(`https://api.cityscroll.org/admin/search-activity?key=${ADMIN_KEY}`), env,
  );
  assert.equal(ok.headers.get("Cache-Control"), "private, no-store");

  const write = await handleAdminSearchActivity(
    new Request(`https://api.cityscroll.org/admin/search-activity?key=${ADMIN_KEY}`, { method: "POST" }), env,
  );
  assert.equal(write.status, 405, "the read model is read-only");
});

test("intake never fails hard when private storage is missing or broken", async () => {
  const missing = await handleSearchActivity(intake(), productionEnv({ ALERT_STATE: undefined }));
  assert.equal(missing.status, 202);
  assert.equal((await missing.json()).reason, "not-configured");
  assert.ok(visitorCookieFrom(missing), "browser identity stays stable even without a store");

  const broken = productionEnv({
    ALERT_STATE: { put: async () => { throw new Error("kv down"); }, get: async () => null, list: async () => ({ keys: [] }) },
  });
  const response = await handleSearchActivity(intake(), broken);
  assert.equal(response.status, 202);
  assert.equal((await response.json()).reason, "store-failed");
});

test("intake rejects foreign origins and non-POST methods", async () => {
  const env = productionEnv();
  const foreign = await handleSearchActivity(
    new Request(INTAKE_URL, { method: "POST", headers: { Origin: "https://evil.example" }, body: "{}" }),
    env,
  );
  assert.equal(foreign.status, 403);

  const preflight = await handleSearchActivity(
    new Request(INTAKE_URL, { method: "OPTIONS", headers: { Origin: ORIGIN } }), env,
  );
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get("Access-Control-Allow-Credentials"), "true");
  assert.equal(preflight.headers.get("Access-Control-Allow-Origin"), ORIGIN);

  const getRequest = await handleSearchActivity(
    new Request(INTAKE_URL, { method: "GET", headers: { Origin: ORIGIN } }), env,
  );
  assert.equal(getRequest.status, 405);
  assert.equal(storedReceipts(env).length, 0);
});

test("/events keeps working and never gains a visitor cookie", async () => {
  const env = productionEnv();
  const response = await handleEvent(
    new Request("https://api.cityscroll.org/events", {
      method: "POST",
      headers: { Origin: ORIGIN, "Content-Type": "application/json" },
      body: JSON.stringify({ event: "page_view", surface: "home" }),
    }),
    env,
  );
  assert.equal(response.status, 204, "aggregate usage intake is unchanged");
  assert.equal(setCookieValues(response).length, 0, "the aggregate stream never carries browser identity");
  assert.equal(storedReceipts(env).length, 0, "usage counters never land in the receipt prefix");
});

// ---- pure helpers ----

test("account labels are redacted, and never reversible to the local part", () => {
  assert.equal(redactedAccountLabel("resident@example.org"), "r…@example.org");
  assert.equal(redactedAccountLabel("A.Long.Name@mail.example"), "a…@mail.example");
  assert.equal(redactedAccountLabel("not-an-email"), null);
  assert.equal(redactedAccountLabel(""), null);
});

test("user-agent classification is coarse and bounded", () => {
  const chrome = classifyUserAgent(
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36",
  );
  assert.equal(chrome.browser_family, "chrome");
  assert.equal(chrome.browser_major_version, 141);
  assert.equal(chrome.os_family, "macos");
  assert.equal(chrome.device_class, "desktop");

  const iphone = classifyUserAgent(
    "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1",
  );
  assert.equal(iphone.browser_family, "safari");
  assert.equal(iphone.os_family, "ios");
  assert.equal(iphone.device_class, "mobile");

  const empty = classifyUserAgent("");
  assert.equal(empty.user_agent, null);
  assert.equal(empty.browser_family, null);
  assert.equal(empty.device_class, null);

  assert.ok(classifyUserAgent("x".repeat(5_000)).user_agent.length <= 300);
});
