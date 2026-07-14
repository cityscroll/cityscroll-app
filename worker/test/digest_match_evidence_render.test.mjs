// End-to-end characterization of the emailed digest's match-evidence rendering (matchEvidence()
// in lib/digest.mjs is unit-tested in digest.test.mjs; this proves it's actually wired into the
// sent HTML). Real observed failure: a subscriber's "education" keyword alert once surfaced
// "NOS - Equity Index Investment Management Products" (an Office of the Comptroller
// pension-fund notice) with nothing in the sent email explaining the match — the hit was in
// the description (naming the Board of Education Retirement System), which the digest never
// rendered at all before this fix.
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

const comptrollerRow = {
  request_id: "20260701099",
  agency_name: "Office of the Comptroller",
  short_title: "NOS - Equity Index Investment Management Products",
  additional_description_1:
    "The New York City Office of the Comptroller, Bureau of Asset Management, is soliciting " +
    "proposals on behalf of the Boards of Trustees of the New York City Employees' Retirement " +
    "System, Teachers' Retirement System, and the Board of Education Retirement System for " +
    "equity index investment management products.",
  pin: "826202SOL0001P",
  due_date: "2099-01-01T00:00:00.000",
  start_date: "2026-07-01",
};

async function runOneMoneySub(filter) {
  const sentEmails = [];
  const today = new Date().toISOString().slice(0, 10);
  const subKey = "sub:edu-test";
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
    return { ok: true, json: async () => [comptrollerRow] }; // mock SODA
  };
  try {
    await runAlerts(env, []);
  } finally {
    globalThis.fetch = originalFetch;
  }
  return sentEmails;
}

test("before: the title alone gives no reason 'education' would match this notice", () => {
  assert.equal(comptrollerRow.short_title.toLowerCase().includes("education"), false);
});

test("after: a keyword match buried in the description renders a <mark>-highlighted snippet, not silence", async () => {
  const sentEmails = await runOneMoneySub({ keywords: ["education"] });
  assert.equal(sentEmails.length, 1);
  const html = sentEmails[0].html;
  assert.match(html, /Equity Index Investment Management Products/);
  assert.match(html, /Matched: /, "the 'why this matched' line is present");
  assert.match(html, /<mark[^>]*>Education<\/mark>/, "the exact-case hit is highlighted, not a lowercased rewrite");
  assert.match(html, /Board of <mark[^>]*>Education<\/mark> Retirement System/, "the snippet gives real context, not just the bare word");
});

test("a keyword that's in the title highlights the title itself, with no separate snippet line", async () => {
  const sentEmails = await runOneMoneySub({ keywords: ["equity"] });
  assert.equal(sentEmails.length, 1);
  const html = sentEmails[0].html;
  assert.match(html, /<mark[^>]*>Equity<\/mark> Index Investment Management Products/);
  assert.doesNotMatch(html, /Matched: /, "no redundant evidence line when the title itself already shows the hit");
});

test("an amount-only watch (no keywords) renders the notice with no evidence chrome at all — unchanged behavior", async () => {
  const sentEmails = await runOneMoneySub({ minAmount: 1 });
  assert.equal(sentEmails.length, 1);
  const html = sentEmails[0].html;
  assert.doesNotMatch(html, /<mark/);
  assert.doesNotMatch(html, /Matched: /);
});
