import { test } from "node:test";
import assert from "node:assert/strict";
import { runAlerts } from "../src/alerts.mjs";

function kv(map = {}) {
  return {
    get: async (k) => (Object.prototype.hasOwnProperty.call(map, k) ? map[k] : null),
    put: async (k, v) => { map[k] = v; },
    list: async (options = {}) => {
      const prefix = options.prefix || "";
      const keys = Object.keys(map)
        .filter((k) => k.startsWith(prefix))
        .map((k) => ({ name: k }));
      return { keys, list_complete: true };
    }
  };
}

test("runAlerts matches checkbook warning_date and sends email containing forecast", async () => {
  const sentEmails = [];
  
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    // mock resend email API
    if (url.includes("api.resend.com")) {
      return {
        ok: true,
        json: async () => ({ id: "email-id" })
      };
    }
    // mock empty open data notices fetch
    return {
      ok: true,
      json: async () => []
    };
  };

  const today = new Date().toISOString().slice(0, 10);
  const subKey = "sub:test-key";

  const alertStateStore = {
    [`fc:DESIGN AND CONSTRUCTION`]: JSON.stringify([
      {
        contract_id: "CTA123",
        vendor_name: "SINERGIA INC",
        agency_name: "Design and Construction",
        amount: "1000000",
        expiration_date: "2029-07-01",
        warning_date: today,
        source: "checkbook"
      }
    ])
  };

  const subsStore = {
    [subKey]: JSON.stringify({
      key: subKey,
      email: "test@example.com",
      freq: "daily",
      channel: "email",
      lens: "entity",
      filter: { name: "Design and Construction" },
      createdAt: today
    }),
    "last-sent:test-key": "2026-07-01",
    "seen:test-key": JSON.stringify([])
  };

  const env = {
    ALERT_STATE: kv(alertStateStore),
    SUBS: kv(subsStore),
    ALERTS_LIVE: "true",
    RESEND_API_KEY: "re-1234",
    TOKEN_SECRET: "secret-key",
    CONFIRM_BASE: "https://api.crol-list.org",
    MAX_PER_RUN: "25",
    MAX_SENDS_PER_DAY: "50",
    HEARTBEAT_DAYS: "14",
    // Intercept outbound email calls
    __sendEmailForTest: (emailPayload) => {
      sentEmails.push(emailPayload);
    }
  };

  // Temporarily patch globalThis.fetch to send email interceptor if needed
  // But wait! sendEmail in alerts.mjs uses fetch to "https://api.resend.com/emails".
  // Let's intercept that inside fetch!
  const originalFetchWithResend = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    if (url.includes("api.resend.com/emails")) {
      const payload = JSON.parse(options.body);
      sentEmails.push(payload);
      return {
        ok: true,
        json: async () => ({ id: "resend-id" })
      };
    }
    // mock SODA / ZAP endpoints
    return {
      ok: true,
      json: async () => []
    };
  };

  // Run alerts cron
  const results = await runAlerts(env, []);
  
  globalThis.fetch = originalFetchWithResend; // restore

  // Assert email was sent
  assert.equal(sentEmails.length, 1);
  assert.equal(sentEmails[0].to, "test@example.com");
  assert.match(sentEmails[0].subject, /1 forecast\(s\)/);
  assert.match(sentEmails[0].html, /Upcoming Procurement Forecasts/);
  assert.match(sentEmails[0].html, /SINERGIA INC/);
  assert.match(sentEmails[0].html, /1,000,000/);

  // Assert de-duplication was stored in ALERT_STATE
  const sentKey = `sent:fc:CTA123:${subKey}`;
  const sentMarker = await env.ALERT_STATE.get(sentKey);
  assert.equal(sentMarker, "1");

  // Re-running runAlerts should NOT send it again because it is de-duplicated
  sentEmails.length = 0; // clear
  
  globalThis.fetch = async (url, options) => {
    if (url.includes("api.resend.com/emails")) {
      const payload = JSON.parse(options.body);
      sentEmails.push(payload);
      return { ok: true, json: async () => ({}) };
    }
    return { ok: true, json: async () => [] };
  };

  await runAlerts(env, []);
  
  globalThis.fetch = originalFetch; // restore

  assert.equal(sentEmails.length, 0); // No email sent!
});
