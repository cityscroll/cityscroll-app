import test from "node:test";
import assert from "node:assert/strict";
import {
  verifySignupTurnstile,
  isDocumentedTurnstileTestingSecret,
  isProductionTurnstileSurface,
  TURNSTILE_TESTING_PASS_SECRET,
  TURNSTILE_TESTING_FAIL_SECRET,
} from "../src/lib/signup_turnstile.mjs";
import { handleSubscribe } from "../src/subscribe.mjs";
import { handleMonitorPackSubscribe } from "../src/monitor_packs.mjs";
import { handleFollowing } from "../src/following.mjs";
import worker from "../src/worker.mjs";

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

test("documented Turnstile testing secrets accept Cloudflare's dummy siteverify shape", async () => {
  assert.equal(isDocumentedTurnstileTestingSecret(TURNSTILE_TESTING_PASS_SECRET), true);
  assert.equal(isDocumentedTurnstileTestingSecret("production-looking-secret"), false);
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return Response.json({
      success: true,
      hostname: "example.com",
      // Cloudflare test secrets omit action/cdata per their testing docs.
    });
  };
  try {
    // Non-production marker required: production API hosts fail closed for testing secrets.
    assert.deepEqual(
      await verifySignupTurnstile(request, {
        TURNSTILE_SECRET: TURNSTILE_TESTING_PASS_SECRET,
        ANALYTICS_ENVIRONMENT: "preview",
      }, {
        turnstileToken: "XXXX.DUMMY.TOKEN.XXXX",
      }),
      { ok: true },
    );
    assert.equal(calls, 1);
    // A production secret still requires action + approved hostname even on success.
    assert.equal(
      (await verifySignupTurnstile(request, {
        TURNSTILE_SECRET: "real-production-secret",
        ANALYTICS_ENVIRONMENT: "preview",
      }, {
        turnstileToken: "XXXX.DUMMY.TOKEN.XXXX",
      })).status,
      403,
    );
  } finally {
    globalThis.fetch = original;
  }
});

test("documented Turnstile always-fail testing secret stays rejected", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => Response.json({
    success: false,
    "error-codes": ["invalid-input-response"],
  });
  try {
    assert.equal(
      (await verifySignupTurnstile(request, {
        TURNSTILE_SECRET: TURNSTILE_TESTING_FAIL_SECRET,
        ANALYTICS_ENVIRONMENT: "preview",
      }, {
        turnstileToken: "XXXX.DUMMY.TOKEN.XXXX",
      })).status,
      403,
    );
  } finally {
    globalThis.fetch = original;
  }
});

test("a documented Turnstile testing secret fails closed on a production surface", async () => {
  assert.equal(isProductionTurnstileSurface(request, { ANALYTICS_ENVIRONMENT: "production" }), true);
  assert.equal(isProductionTurnstileSurface(request, { ANALYTICS_ENVIRONMENT: "preview" }), false);
  assert.equal(isProductionTurnstileSurface(request, {}), true, "api.cityscroll.org fallback");
  assert.equal(
    isProductionTurnstileSurface(new Request("http://localhost:8787/subscribe"), {}),
    false,
  );

  const original = globalThis.fetch;
  let calls = 0;
  const logs = [];
  const originalError = console.error;
  console.error = (...args) => { logs.push(args.map(String).join(" ")); };
  globalThis.fetch = async () => {
    calls += 1;
    return Response.json({ success: true, hostname: "example.com" });
  };
  try {
    const byMarker = await verifySignupTurnstile(request, {
      TURNSTILE_SECRET: TURNSTILE_TESTING_PASS_SECRET,
      ANALYTICS_ENVIRONMENT: "production",
    }, { turnstileToken: "XXXX.DUMMY.TOKEN.XXXX" });
    assert.equal(byMarker.ok, false);
    assert.equal(byMarker.status, 403);
    assert.equal(byMarker.reason, "bot-check");
    assert.equal(calls, 0, "must not call siteverify when production+testing-secret");
    assert.match(logs.join("\n"), /testing secret.*production|production surface/i);

    logs.length = 0;
    const byHost = await verifySignupTurnstile(request, {
      TURNSTILE_SECRET: TURNSTILE_TESTING_PASS_SECRET,
    }, { turnstileToken: "XXXX.DUMMY.TOKEN.XXXX" });
    assert.equal(byHost.status, 403);
    assert.equal(calls, 0);
    assert.match(logs.join("\n"), /failing closed/i);
  } finally {
    globalThis.fetch = original;
    console.error = originalError;
  }
});

test("both browser enrollment routes reject a missing proof before storage or mail", async () => {
  const writes = [];
  const env = {
    TOKEN_SECRET: "test-token-secret",
    RESEND_API_KEY: "test-resend-key",
    TURNSTILE_SECRET: "test-turnstile-secret",
    SUBS: { async get() { return null; }, async put(key) { writes.push(key); } },
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
  assert.deepEqual(writes, [], "unverified requests must not consume rate limits or write enrollment state");
});

test("a no-JavaScript form gets a clear security-check response without storage", async () => {
  const writes = [];
  const response = await handleSubscribe(new Request("https://api.cityscroll.org/subscribe", {
    method: "POST",
    headers: {
      origin: "https://cityscroll.org",
      accept: "text/html",
      "content-type": "application/x-www-form-urlencoded",
    },
    body: "email=reader%40example.com&no_topic=true&source=contracts-intro",
  }), {
    TOKEN_SECRET: "test-token-secret",
    RESEND_API_KEY: "test-resend-key",
    TURNSTILE_SECRET: "test-turnstile-secret",
    SUBS: { async get() { return null; }, async put(key) { writes.push(key); } },
  });
  assert.equal(response.status, 403);
  assert.match(response.headers.get("content-type"), /text\/html/);
  assert.match(await response.text(), /Enable JavaScript and submit the form again/);
  assert.deepEqual(writes, []);
});

test("pack route permits preflight and rejects an unverified POST before storage", async () => {
  const writes = [];
  const env = {
    TOKEN_SECRET: "test-token-secret",
    RESEND_API_KEY: "test-resend-key",
    TURNSTILE_SECRET: "test-turnstile-secret",
    SUBS: { async get() { return null; }, async put(key) { writes.push(key); } },
  };
  const context = { waitUntil() {} };
  const preflight = await worker.fetch(new Request("https://api.cityscroll.org/subscribe-pack", {
    method: "OPTIONS",
    headers: {
      origin: "https://cityscroll.org",
      "access-control-request-method": "POST",
      "access-control-request-headers": "content-type",
    },
  }), env, context);
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get("access-control-allow-origin"), "https://cityscroll.org");
  assert.match(preflight.headers.get("access-control-allow-methods"), /POST/);
  assert.match(preflight.headers.get("access-control-allow-headers"), /Content-Type/i);

  const posted = await worker.fetch(new Request("https://api.cityscroll.org/subscribe-pack", {
    method: "POST",
    headers: { origin: "https://cityscroll.org", "content-type": "application/json" },
    body: JSON.stringify({
      email: "reader@example.com", pack_id: "sample", children: [
        { label: "Money", lens: "money", filter: {} },
      ],
    }),
  }), env, context);
  assert.equal(posted.status, 403);
  assert.equal((await posted.json()).reason, "bot-check");
  assert.deepEqual(writes, []);
});

test("the public Following document permits the managed challenge assets", async () => {
  const response = await handleFollowing(new Request("https://cityscroll.org/following/"), {});
  const policy = response.headers.get("content-security-policy");
  assert.equal(response.status, 200);
  assert.match(policy, /script-src[^;]*https:\/\/challenges\.cloudflare\.com/);
  assert.match(policy, /connect-src[^;]*https:\/\/challenges\.cloudflare\.com/);
  assert.match(policy, /frame-src https:\/\/challenges\.cloudflare\.com/);
});
