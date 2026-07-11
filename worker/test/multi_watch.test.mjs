// Characterization + regression tests: MULTIPLE WATCHES PER EMAIL ADDRESS.
// Dev reported multi-subscription behavior "not working" vs his crol-alert; these tests
// pin what the worker layer must guarantee before/after the crol-alert integration:
//   1. one address can hold several distinct watches (different lens or filter)
//   2. re-confirming the same watch is idempotent (no duplicates)
//   3. re-confirming with a new freq UPDATES the watch in place (freq is not in the id hash)
//   4. unsubscribing one watch never touches the address's other watches
//   5. the digest cron's KV listing sees every watch, not one-per-address
//   6. (sharp edge, by design) /subscribe rate-limiting counts ATTEMPTS, not successes —
//      failed Turnstile posts consume the per-address daily quota (MAX_SUB_PER_ADDR_DAY=5)

import { test } from "node:test";
import assert from "node:assert/strict";
import { signToken } from "optin-token";
import { handleConfirm } from "../src/confirm.mjs";
import { handleUnsubscribe } from "../src/unsubscribe.mjs";
import { handleSubscribe } from "../src/subscribe.mjs";

const SECRET = "test-secret-0123456789abcdef0123456789abcdef";

class MockKV {
  constructor() { this.store = new Map(); }
  async get(k) { return this.store.has(k) ? this.store.get(k) : null; }
  async put(k, v) { this.store.set(k, String(v)); }
  async delete(k) { this.store.delete(k); }
  async list({ prefix = "", cursor } = {}) {
    const keys = [...this.store.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name }));
    return { keys, list_complete: true, cursor: undefined };
  }
}

function confirmReq(token) {
  return new Request(`https://api.crol-list.org/confirm?token=${encodeURIComponent(token)}`);
}

async function confirmWatch(env, { email, lens, filter, freq = "daily", lang = "en" }) {
  const token = await signToken(env.TOKEN_SECRET, { e: email, l: lens, f: filter, c: "email", q: freq, lng: lang }, { ttlSeconds: 3600 });
  const res = await handleConfirm(confirmReq(token), env);
  assert.equal(res.status, 200, "confirm should succeed");
}

function subKeys(env) {
  return [...env.SUBS.store.keys()].filter((k) => k.startsWith("sub:"));
}

test("one email can hold multiple distinct watches", async () => {
  const env = { TOKEN_SECRET: SECRET, SUBS: new MockKV() };
  await confirmWatch(env, { email: "anna@example.com", lens: "money", filter: { q: "affordable housing" } });
  await confirmWatch(env, { email: "anna@example.com", lens: "land", filter: { borough: "Brooklyn" } });
  await confirmWatch(env, { email: "anna@example.com", lens: "money", filter: { q: "snow removal" } });

  const keys = subKeys(env);
  assert.equal(keys.length, 3, `expected 3 distinct watches for one email, got ${keys.length}: ${keys.join(", ")}`);
  for (const k of keys) assert.ok(k.startsWith("sub:anna@example.com:"), k);
});

test("re-confirming the same watch is idempotent (no duplicates)", async () => {
  const env = { TOKEN_SECRET: SECRET, SUBS: new MockKV() };
  const watch = { email: "anna@example.com", lens: "money", filter: { q: "affordable housing" } };
  await confirmWatch(env, watch);
  await confirmWatch(env, watch);
  assert.equal(subKeys(env).length, 1, "same (email, lens, filter) must map to one stored watch");
});

test("re-confirming with a new freq updates in place (freq excluded from id hash)", async () => {
  const env = { TOKEN_SECRET: SECRET, SUBS: new MockKV() };
  await confirmWatch(env, { email: "anna@example.com", lens: "money", filter: { q: "hvac" }, freq: "daily" });
  await confirmWatch(env, { email: "anna@example.com", lens: "money", filter: { q: "hvac" }, freq: "weekly" });
  const keys = subKeys(env);
  assert.equal(keys.length, 1, "freq change must not create a second watch");
  const stored = JSON.parse(env.SUBS.store.get(keys[0]));
  assert.equal(stored.freq, "weekly", "the newer freq wins");
});

test("unsubscribing one watch leaves the email's other watches intact", async () => {
  const env = { TOKEN_SECRET: SECRET, SUBS: new MockKV() };
  await confirmWatch(env, { email: "anna@example.com", lens: "money", filter: { q: "affordable housing" } });
  await confirmWatch(env, { email: "anna@example.com", lens: "rules", filter: {} });
  const [first, second] = subKeys(env).sort();

  const unsubToken = await signToken(SECRET, { k: first }, { ttlSeconds: 3600 });
  const res = await handleUnsubscribe(new Request(`https://api.crol-list.org/unsubscribe?token=${encodeURIComponent(unsubToken)}`), env);
  assert.equal(res.status, 200);

  const remaining = subKeys(env);
  assert.deepEqual(remaining, [second], "exactly the unsubscribed watch is gone, the other survives");
});

test("digest listing (prefix sub:) sees every watch for an address", async () => {
  const env = { TOKEN_SECRET: SECRET, SUBS: new MockKV() };
  await confirmWatch(env, { email: "anna@example.com", lens: "money", filter: { q: "a" } });
  await confirmWatch(env, { email: "anna@example.com", lens: "money", filter: { q: "b" } });
  await confirmWatch(env, { email: "someone-else@example.com", lens: "land", filter: {} });
  // Same listing shape the alerts cron uses (SUBS.list({ prefix: "sub:" })).
  const res = await env.SUBS.list({ prefix: "sub:" });
  assert.equal(res.keys.length, 3);
  assert.equal(res.keys.filter((k) => k.name.startsWith("sub:anna@example.com:")).length, 2);
});

test("changing language does NOT create a duplicate watch (lang excluded from id hash)", async () => {
  const env = { TOKEN_SECRET: SECRET, SUBS: new MockKV() };
  const watch = { email: "anna@example.com", lens: "money", filter: { q: "affordable housing" } };
  await confirmWatch(env, { ...watch, lang: "en" });
  await confirmWatch(env, { ...watch, lang: "es" });
  const keys = subKeys(env);
  assert.equal(keys.length, 1, "en→es lang switch must not duplicate the watch; got: " + keys.join(", "));
  const stored = JSON.parse(env.SUBS.store.get(keys[0]));
  assert.equal(stored.lang, "es", "the newer lang wins on re-confirm");
});

test("sharp edge (by design): failed subscribe ATTEMPTS consume the per-address daily quota", async () => {
  const env = {
    TOKEN_SECRET: SECRET,
    TURNSTILE_SECRET: "ts",
    RESEND_API_KEY: "rk",
    SUBS: new MockKV(),
  };
  // Turnstile verify always FAILS; Resend never reached.
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    if (String(url).includes("challenges.cloudflare.com")) {
      return new Response(JSON.stringify({ success: false }), { status: 200 });
    }
    throw new Error("unexpected network call: " + url);
  };
  try {
    const post = () =>
      handleSubscribe(
        new Request("https://api.crol-list.org/subscribe", {
          method: "POST",
          headers: { "Content-Type": "application/json", "CF-Connecting-IP": "203.0.113.7" },
          body: JSON.stringify({ email: "anna@example.com", lens: "money", filter: {}, turnstileToken: "bad" }),
        }),
        env,
      );
    // 5 failed attempts (MAX_SUB_PER_ADDR_DAY) → each 403, each consuming quota…
    for (let i = 0; i < 5; i++) assert.equal((await post()).status, 403);
    // …so the 6th attempt is rate-limited BEFORE Turnstile, even though zero
    // subscriptions succeeded. Deliberate (spend guard runs first) — but it means a
    // user fumbling the widget can lock themselves out for a day while setting up
    // multiple watches. If Dev's multi-subscription repro was over HTTP, this is the
    // likeliest culprit. Pinned here so any future change is a conscious one.
    assert.equal((await post()).status, 429);
  } finally {
    globalThis.fetch = realFetch;
  }
});
