import { handleAdminMailQuota } from "../src/admin.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { providerDailyQuota } from "../src/lib/provider_quota.mjs";
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
  assert.equal(body.hold_sources, undefined);
  assert.equal(body.alert.destination, "desk-only");
  const alert = JSON.parse(store.get("ops:alert:history:v1")).items[0];
  assert.equal(alert.signature, body.alert.signature);
  assert.equal(alert.queue, null);
  assert.equal(alert.guard, "provider-mail-quota-drill");
  assert.equal(alert.notification.email, false);
});
