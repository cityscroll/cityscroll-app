// Homepage general-interest CTA: posts lens=money, filter={}, freq=weekly through the
// real /subscribe double-opt-in path (confirm email, nothing stored until click).
import test from "node:test";
import assert from "node:assert/strict";
import { handleSubscribe } from "../src/subscribe.mjs";
import { describeFilter } from "../src/lib/confirm_email.mjs";

class MockKV {
  constructor() { this.store = new Map(); }
  async get(k) { return this.store.has(k) ? this.store.get(k) : null; }
  async put(k, v) { this.store.set(k, v); }
  async delete(k) { this.store.delete(k); }
  async list() { return { keys: [...this.store.keys()].map((name) => ({ name })) }; }
}

function configured() {
  return {
    TURNSTILE_SECRET: "ts",
    TOKEN_SECRET: "tok-secret-for-tests-32bytes-min!!",
    RESEND_API_KEY: "rk",
    SUBS: new MockKV(),
    CONFIRM_BASE: "https://api.cityscroll.org",
    ALERTS_FROM: "CityScroll <alerts@cityscroll.org>",
  };
}

test("describeFilter for empty money filter reads as general contract updates", () => {
  assert.match(describeFilter("money", {}), /all notices/i);
});

test("homepage CTA payload: empty money + weekly → confirm email, nothing stored yet", async () => {
  const env = configured();
  const sent = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    const u = String(url);
    if (u.includes("challenges.cloudflare.com")) {
      return new Response(JSON.stringify({ success: true }), { status: 200 });
    }
    if (u.includes("api.resend.com")) {
      sent.push(JSON.parse(opts.body));
      return new Response(JSON.stringify({ id: "msg_test" }), { status: 200 });
    }
    throw new Error("unexpected fetch: " + u);
  };
  try {
    const res = await handleSubscribe(
      new Request("https://api.cityscroll.org/subscribe", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: "https://cityscroll.org",
          "CF-Connecting-IP": "198.51.100.10",
        },
        body: JSON.stringify({
          email: "reader@example.com",
          lens: "money",
          filter: {},
          freq: "weekly",
          lang: "en",
          turnstileToken: "ok",
        }),
      }),
      env,
    );
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
    // Double opt-in: no subscription keys until /confirm
    const subKeys = [...env.SUBS.store.keys()].filter((k) => k.startsWith("sub:"));
    assert.equal(subKeys.length, 0, "nothing stored until confirm click");
    assert.equal(sent.length, 1);
    assert.match(sent[0].html, /confirm/i);
    assert.match(sent[0].html, /all notices|contract money/i);
    assert.match(sent[0].html, /weekly/i);
    assert.equal(sent[0].to, "reader@example.com");
  } finally {
    globalThis.fetch = realFetch;
  }
});
