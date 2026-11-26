import { handleAdminMailQuota } from "../src/admin.mjs";
import { deliverWelcomeOnce } from "../src/subscribe.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { providerDailyQuota, readProviderDailyQuota } from "../src/lib/provider_quota.mjs";
import { deliveryHoldForSend } from "../src/lib/recipient_suppression.mjs";

test("provider quota includes every email charged to the day", () => {
  const report = (used, limit = 100) => providerDailyQuota({ emails: { daily: {
    used, limit, resets_at: "2026-12-01T00:00:00Z",
  } } });
  assert.equal(report(79).status, "ok");
  assert.equal(report(80).status, "warning");
  assert.equal(report(100).status, "exhausted");
  assert.equal(report(101, null).status, "uncapped");
  assert.throws(() => report(null));
  assert.throws(() => providerDailyQuota({}));
});

test("a failed production hold read prevents dispatch and remains retryable", async () => {
  const env = { WRANGLER_ENV: "production", DB: {
    prepare(sql) { return { bind() { return { async first() {
      if (sql.includes("operator_recipient_holds")) throw Error("busy");
      return null;
    } }; } }; },
  } };
  await assert.rejects(deliveryHoldForSend(env, "synthetic-recipient"), /hold lookup unavailable/);
  await assert.rejects(deliveryHoldForSend({ WRANGLER_ENV: "production" }, "synthetic-recipient"), /hold lookup unavailable/);
});


test("the authenticated drill writes a labeled Desk alert without enqueuing repairs or sending mail", async () => {
  const store = new Map();
  const env = { ADMIN_KEY: "test", WRANGLER_ENV: "production", DB: {
    prepare(sql) { return { bind() { return { async first() {
      return sql.includes("operator_recipient_holds") ? { reason: "test", provenance: "test" } : null;
    } }; } }; },
  }, ALERT_STATE: { async get(k) { return store.get(k); }, async put(k, v) { store.set(k, v); } } };
  const url = "https://api.example.invalid/admin/reliability/mail-quota";
  const denied = await handleAdminMailQuota(new Request(url, { method: "POST" }), env);
  assert.equal(denied.status, 401);
  assert.equal(store.size, 0);
  const request = new Request(url, { method: "POST", headers: { authorization: "Bearer test" }, body: "{}" });
  const res = await handleAdminMailQuota(request, env);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.welcome, undefined);
  assert.equal(body.alert.destination, "desk-only");
  const alert = JSON.parse(store.get("ops:alert:history:v1")).items[0];
  assert.equal(alert.signature, body.alert.signature);
  assert.equal(alert.queue, null);
  assert.equal(alert.guard, "provider-mail-quota-drill");
  assert.equal(alert.notification.email, false);
});

test("welcome preview distinguishes each hold, both lifts, and never claims a send", async () => {
  let operatorActive = true;
  let providerActive = false;
  const env = { WRANGLER_ENV: "production", DB: {
    prepare(sql) {
      assert.match(sql, /^SELECT/);
      assert.match(sql, /FROM (operator_recipient_holds|recipient_suppressions) WHERE/);
      const active = sql.includes("operator_recipient_holds") ? operatorActive : providerActive;
      return { bind() { return { async first() {
        return active ? { reason: "test", provenance: "test", lifted_at: null } : null;
      } }; } };
    },
  } };
  const check = () => deliverWelcomeOnce(env, "synthetic-recipient", null, { previewOnly: true });
  assert.deepEqual(await check(), { status: "suppressed", holds: ["operator-quarantine"] });
  providerActive = true;
  assert.deepEqual((await check()).holds, ["operator-quarantine", "provider-suppression"]);
  operatorActive = false;
  assert.deepEqual((await check()).holds, ["provider-suppression"]);
  providerActive = false;
  assert.deepEqual(await check(), { status: "hold-clear", holds: [] });
});

test("quota transport refuses redirects before following them with the provider credential", async (t) => {
  let calls = 0;
  t.mock.method(globalThis, "fetch", async (url, init) => {
    calls++;
    assert.equal(url, "https://api.resend.com/usage");
    assert.equal(init.redirect, "manual");
    return new Response(null, { status: 302, headers: { location: "https://redirect.invalid/" } });
  });
  await assert.rejects(readProviderDailyQuota({ RESEND_API_KEY: "test" }), /HTTP 302/);
  assert.equal(calls, 1);
});
