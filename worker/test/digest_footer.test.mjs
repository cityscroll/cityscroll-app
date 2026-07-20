// Characterization for the digest email footer: before, every digest footer carried a
// recurring explainer line about the /r click-through redirect ("Notice links go via a
// count-only redirect ... so we can tell digests are useful ... Aggregates: crol-list.org/stats");
// after, the footer omits it. The redirect mechanism itself, and the public stats page it
// pointed to, are unchanged — only the per-email explainer text is gone (aggregate click
// stats stay documented at crol-list.org/stats, so restating that in every email was
// redundant clutter).
import { test } from "node:test";
import assert from "node:assert/strict";
import { runAlerts } from "../src/alerts.mjs";

function kv(map = {}) {
  return {
    get: async (k) => (Object.prototype.hasOwnProperty.call(map, k) ? map[k] : null),
    put: async (k, v) => { map[k] = v; },
    list: async (options = {}) => {
      const prefix = options.prefix || "";
      const keys = Object.keys(map).filter((k) => k.startsWith(prefix)).map((k) => ({ name: k }));
      return { keys, list_complete: true };
    },
  };
}

const freshRow = {
  request_id: "20260701200",
  agency_name: "Department of Buildings",
  short_title: "Elevator Inspection Services",
  additional_description_1: "Citywide elevator inspection and testing services.",
  pin: "81026P0002001",
  due_date: "2099-01-01T00:00:00.000",
  start_date: "2026-07-01",
};

async function runOneMoneySub(filter) {
  const sentEmails = [];
  const today = new Date().toISOString().slice(0, 10);
  const subKey = "sub:footer-test";
  const subsStore = {
    [subKey]: JSON.stringify({
      key: subKey, email: "test@example.com", freq: "daily", channel: "email",
      lens: "money", filter, createdAt: today,
    }),
  };
  const env = {
    ALERT_STATE: kv({}),
    SUBS: kv(subsStore),
    ALERTS_LIVE: "true",
    RESEND_API_KEY: "re-1234",
    TOKEN_SECRET: "secret-key",
    CONFIRM_BASE: "https://api.crol-list.org",
    MAX_PER_RUN: "25",
    MAX_SENDS_PER_DAY: "50",
    HEARTBEAT_DAYS: "14",
  };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    if (String(url).includes("api.resend.com/emails")) {
      sentEmails.push(JSON.parse(options.body));
      return { ok: true, json: async () => ({ id: "resend-id" }) };
    }
    return { ok: true, json: async () => [freshRow] }; // mock SODA
  };
  try {
    await runAlerts(env, []);
  } finally {
    globalThis.fetch = originalFetch;
  }
  return sentEmails;
}

test("after: the digest footer no longer explains the count-only redirect", async () => {
  const sentEmails = await runOneMoneySub({ keywords: ["elevator"] });
  assert.equal(sentEmails.length, 1);
  const html = sentEmails[0].html;
  assert.doesNotMatch(html, /count-only redirect/, "the redirect-mechanics explainer is gone");
  assert.doesNotMatch(html, /so we can tell digests are useful/, "the recurring clutter line is gone");
  assert.doesNotMatch(html, /never who clicked/, "the redirect-mechanics explainer is gone");
});

test("after: the notice link still routes through the count-only /r redirect — only the explainer text is gone", async () => {
  const sentEmails = await runOneMoneySub({ keywords: ["elevator"] });
  const html = sentEmails[0].html;
  assert.match(html, /https:\/\/api\.crol-list\.org\/r\/[^/"]+\/20260701200/, "redirect behavior is unchanged");
});

test("after: the unsubscribe line still renders", async () => {
  const sentEmails = await runOneMoneySub({ keywords: ["elevator"] });
  const html = sentEmails[0].html;
  assert.match(html, /one-click/);
});
