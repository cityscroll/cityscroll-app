import test from "node:test";
import assert from "node:assert/strict";
import { verifySignupTurnstile } from "../src/lib/signup_turnstile.mjs";
import { handleSubscribe } from "../src/subscribe.mjs";
import { handleMonitorPackSubscribe } from "../src/monitor_packs.mjs";
import { handleFollowing } from "../src/following.mjs";

const request = new Request("https://api.cityscroll.org/subscribe", {
  method: "POST",
  headers: { origin: "https://cityscroll.org", "CF-Connecting-IP": "198.51.100.1" },
});

test("signup proof fails closed without a configured secret or token", async () => {
  assert.deepEqual(await verifySignupTurnstile(request, {}, { turnstileToken: "token" }),
    { ok: false, reason: "not-configured", status: 503 });
  assert.deepEqual(await verifySignupTurnstile(request, { TURNSTILE_SECRET: "secret" }, {}),
    { ok: false, reason: "bot-check", status: 403 });
});

test("siteverify requires success, signup action, and an approved production hostname", async () => {
  const original = globalThis.fetch;
  let verification = { success: true, action: "signup", hostname: "cityscroll.org" };
  let calls = 0;
  globalThis.fetch = async (url, options) => {
    assert.equal(String(url), "https://challenges.cloudflare.com/turnstile/v0/siteverify");
    assert.equal(options.method, "POST");
    assert.equal(new URLSearchParams(options.body).get("response"), "fresh-token");
    calls += 1;
    return Response.json(verification);
  };
  try {
    const env = { TURNSTILE_SECRET: "secret" };
    assert.deepEqual(await verifySignupTurnstile(request, env, { turnstileToken: "fresh-token" }), { ok: true });
    for (verification of [
      { success: false, action: "signup", hostname: "cityscroll.org" },
      { success: true, action: "other", hostname: "cityscroll.org" },
      { success: true, action: "signup", hostname: "localhost" },
      { success: true, action: "signup", hostname: "attacker.example" },
    ]) {
      assert.equal((await verifySignupTurnstile(request, env, { turnstileToken: "fresh-token" })).status, 403);
    }
    assert.equal(calls, 5);
  } finally {
    globalThis.fetch = original;
  }
});

test("both browser enrollment routes reject a missing proof before storage or mail", async () => {
  let writes = 0;
  const env = {
    TOKEN_SECRET: "test-token-secret",
    RESEND_API_KEY: "test-resend-key",
    TURNSTILE_SECRET: "test-turnstile-secret",
    SUBS: { async get() { return null; }, async put(key) { if (key.startsWith("sub:") || key.startsWith("monitor-pack:")) writes += 1; } },
  };
  const single = await handleSubscribe(new Request("https://api.cityscroll.org/subscribe", {
    method: "POST",
    headers: { origin: "https://cityscroll.org", "content-type": "application/json" },
    body: JSON.stringify({ email: "reader@example.com", lens: "money", filter: {} }),
  }), env);
  assert.equal(single.status, 403);
  assert.equal((await single.json()).reason, "bot-check");
  const pack = await handleMonitorPackSubscribe(new Request("https://api.cityscroll.org/subscribe-pack", {
    method: "POST",
    headers: { origin: "https://cityscroll.org", "content-type": "application/json" },
    body: JSON.stringify({
      email: "reader@example.com", pack_id: "sample", children: [
        { label: "Money", lens: "money", filter: {} },
      ],
    }),
  }), env);
  assert.equal(pack.status, 403);
  assert.equal((await pack.json()).reason, "bot-check");
  assert.equal(writes, 0);
});

test("the public Following document permits the managed challenge assets", async () => {
  const response = await handleFollowing(new Request("https://cityscroll.org/following/"), {});
  const policy = response.headers.get("content-security-policy");
  assert.equal(response.status, 200);
  assert.match(policy, /script-src[^;]*https:\/\/challenges\.cloudflare\.com/);
  assert.match(policy, /connect-src[^;]*https:\/\/challenges\.cloudflare\.com/);
  assert.match(policy, /frame-src https:\/\/challenges\.cloudflare\.com/);
});
