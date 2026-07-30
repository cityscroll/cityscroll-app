// Digest sender identity: From is the CityScroll sending domain; Reply-To stays on the
// still-routable crol-list.org address because cityscroll.org has no apex MX. Also covers
// ALERTS_LIVE dry-run rendering (full HTML logged, Resend never called).
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
  request_id: "20260730001",
  agency_name: "Department of Education",
  short_title: "Classroom technology services",
  additional_description_1: "Education technology support.",
  pin: "04026E0001",
  due_date: "2026-09-01T00:00:00.000",
  start_date: "2026-07-30",
  section_name: "Procurement",
};

async function runMoneySub({ live, replyTo }) {
  const sentEmails = [];
  const dryLogs = [];
  const today = new Date().toISOString().slice(0, 10);
  const subKey = "sub:reply-to-test@example.com:aabbccdd";
  const env = {
    ALERT_STATE: kv({}),
    SUBS: kv({
      [subKey]: JSON.stringify({
        key: subKey, email: "reply-to-test@example.com", freq: "daily", channel: "email",
        lens: "money", filter: { keywords: ["education"] }, createdAt: today,
      }),
    }),
    ALERTS_LIVE: live,
    ALERTS_FROM: "CityScroll <alerts@cityscroll.org>",
    ALERTS_REPLY_TO: replyTo,
    RESEND_API_KEY: "re-test-key",
    TOKEN_SECRET: "secret-key-for-tests-32b!!!!",
    CONFIRM_BASE: "https://api.cityscroll.org",
    MAX_PER_RUN: "25",
    MAX_SENDS_PER_DAY: "50",
    HEARTBEAT_DAYS: "14",
  };
  const originalFetch = globalThis.fetch;
  const originalLog = console.log;
  globalThis.fetch = async (url, options) => {
    if (String(url).includes("api.resend.com/emails")) {
      sentEmails.push(JSON.parse(options.body));
      return { ok: true, json: async () => ({ id: "resend-id" }) };
    }
    return { ok: true, json: async () => [freshRow] };
  };
  console.log = (...args) => {
    const s = args.map(String).join(" ");
    if (s.startsWith("alerts dry-run (no send):")) {
      dryLogs.push(JSON.parse(s.slice("alerts dry-run (no send):".length).trim()));
    }
  };
  try {
    await runAlerts(env, []);
  } finally {
    globalThis.fetch = originalFetch;
    console.log = originalLog;
  }
  return { sentEmails, dryLogs };
}

test("live digest carries From alerts@cityscroll.org and Reply-To alerts@crol-list.org", async () => {
  const { sentEmails } = await runMoneySub({ live: "true", replyTo: "alerts@crol-list.org" });
  assert.equal(sentEmails.length, 1);
  assert.equal(sentEmails[0].from, "CityScroll <alerts@cityscroll.org>");
  assert.equal(sentEmails[0].reply_to, "alerts@crol-list.org");
  assert.match(sentEmails[0].html, /api\.cityscroll\.org\/r\//);
  assert.doesNotMatch(sentEmails[0].html, /crol-list\.org/);
  assert.match(sentEmails[0].headers["List-Unsubscribe"], /api\.cityscroll\.org\/unsubscribe/);
  assert.doesNotMatch(sentEmails[0].headers["List-Unsubscribe"], /crol-list\.org/);
});

test("ALERTS_LIVE dry-run still renders today's digest HTML without calling Resend", async () => {
  const { sentEmails, dryLogs } = await runMoneySub({ live: "false", replyTo: "alerts@crol-list.org" });
  assert.equal(sentEmails.length, 0, "Resend must not be called in dry-run");
  assert.equal(dryLogs.length, 1);
  assert.equal(dryLogs[0].from, "CityScroll <alerts@cityscroll.org>");
  assert.equal(dryLogs[0].reply_to, "alerts@crol-list.org");
  assert.match(dryLogs[0].html, /Classroom technology services/);
  assert.match(dryLogs[0].html, /api\.cityscroll\.org\/r\//);
  assert.doesNotMatch(dryLogs[0].html, /crol-list\.org/);
});
