// Regression: digest silently skipped after event dual-write (2026-07-30).
//
// PR #166 dual-writes accepted /events into ALERT_STATE under stats:usage_* /
// stats:page_view / stats:catday:* / stats:alert_confirmed. Digest operational
// state (sendcount, seen, lastsent, receipt) shares that namespace. This fixture
// seeds a realistic post-166 key set and asserts a matching subscription still
// sends — a key-prefix collision or spend-guard inflation would silently skip.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  runAlerts,
  processOneSub,
  summarizeDigestRun,
  DIGEST_RUN_LATEST_KEY,
  digestRunDayKey,
} from "../src/alerts.mjs";
import { handlePrivateStats } from "../src/stats.mjs";
import { statsKey, categoryDayKey, dayStr } from "../src/lib/stats.mjs";

class MockKV {
  constructor(seed = {}) {
    this.store = new Map(Object.entries(seed).map(([k, v]) => [k, typeof v === "string" ? v : String(v)]));
  }
  async get(k) { return this.store.has(k) ? this.store.get(k) : null; }
  async put(k, v) { this.store.set(k, String(v)); }
  async delete(k) { this.store.delete(k); }
  async list({ prefix = "" } = {}) {
    return {
      keys: [...this.store.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name })),
      list_complete: true,
    };
  }
}

/** Keys written by events.mjs dual-write after PR #166 (accepted page_view / search_run / alert_confirmed). */
function seedPost166UsageDualWrite(kv, now = new Date()) {
  const day = dayStr(now);
  // High counters — if any digest path mistakenly summed stats:* or usage_* into the
  // daily send cap, these would push MAX_SENDS_PER_DAY and silently skip.
  const puts = {
    [statsKey("usage_page_view", day)]: "9001",
    [statsKey("page_view", day)]: "9001",
    [statsKey("usage_search_run", day)]: "420",
    [statsKey("usage_alert_confirmed", day)]: "12",
    [statsKey("alert_confirmed", day)]: "12",
    [statsKey("usage_digest_sent", day)]: "3",
    [statsKey("usage_lens_open", day)]: "88",
    [categoryDayKey("page_view", "home", day)]: "5000",
    [categoryDayKey("page_view", "stats", day)]: "200",
    [categoryDayKey("usage_search_run", "money", day)]: "100",
    [categoryDayKey("usage_search_run", "land", day)]: "50",
    // Neighboring digest stats (legitimate) must also not pollute sendcount.
    "stats:alltime:digest": "27",
    "stats:cat:digest:Procurement": "15",
    [`hist:digest:${day}`]: "0",
  };
  for (const [k, v] of Object.entries(puts)) kv.store.set(k, v);
  return { day, puts };
}

const freshRow = {
  request_id: "20260730099",
  agency_name: "Department of Education",
  short_title: "Classroom technology services for education",
  additional_description_1: "Education technology support and training.",
  pin: "04026E0099",
  due_date: "2026-09-01T00:00:00.000",
  start_date: "2026-07-30",
  section_name: "Procurement",
  contract_amount: "250000",
};

test("digest silently skipped after event dual-write: matching sub still sends with post-166 KV keys present", async () => {
  const today = new Date().toISOString().slice(0, 10);
  const subKey = "sub:owner@example.com:dualwrite01";
  const ALERT_STATE = new MockKV();
  const seeded = seedPost166UsageDualWrite(ALERT_STATE);
  // Operational digest keys — distinct prefixes from usage dual-write.
  assert.equal(await ALERT_STATE.get(`sendcount:${today}`), null, "sendcount starts empty");
  assert.ok(await ALERT_STATE.get(statsKey("usage_page_view", seeded.day)));

  const SUBS = new MockKV({
    [subKey]: JSON.stringify({
      key: subKey,
      email: "owner@example.com",
      freq: "daily",
      channel: "email",
      lens: "money",
      filter: { keywords: ["education"] },
      createdAt: "2026-07-01T00:00:00.000Z",
      lang: "en",
    }),
  });

  const sentEmails = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    const u = String(url);
    if (u.includes("api.resend.com/emails")) {
      sentEmails.push(JSON.parse(options.body));
      return { ok: true, json: async () => ({ id: "resend-id" }) };
    }
    // SODA / ZAP / Checkbook — return the matching notice for money lens keyword search.
    if (u.includes("data.cityofnewyork.us") || u.includes("zap")) {
      return { ok: true, json: async () => [freshRow] };
    }
    if (u.includes("checkbooknyc.com")) {
      return { ok: true, text: async () => "<response></response>" };
    }
    return { ok: true, json: async () => [] };
  };

  try {
    const env = {
      ALERT_STATE,
      SUBS,
      ALERTS_LIVE: "true",
      RESEND_API_KEY: "re-test",
      TOKEN_SECRET: "secret-key-for-tests-32bytes!!",
      CONFIRM_BASE: "https://api.cityscroll.org",
      MAX_PER_RUN: "25",
      MAX_SENDS_PER_DAY: "50",
      HEARTBEAT_DAYS: "14",
      // Force inline path so the send is observed in this process (queue would only enqueue).
      QUEUE_DIGESTS: "false",
    };

    const summary = await runAlerts(env, []);
    assert.equal(sentEmails.length, 1, "exactly one digest email must send: " + JSON.stringify(summary.receipt));
    assert.equal(sentEmails[0].to, "owner@example.com");
    assert.match(sentEmails[0].subject, /1 new|education/i);
    assert.equal(await ALERT_STATE.get(`sendcount:${today}`), "1", "sendcount advances — not inflated by usage_* keys");
    assert.equal(await ALERT_STATE.get(`lastsent:${subKey}`), today);

    // Usage dual-write keys must be untouched by the digest path (no clobber, no re-key).
    assert.equal(await ALERT_STATE.get(statsKey("usage_page_view", seeded.day)), "9001");
    assert.equal(await ALERT_STATE.get(statsKey("page_view", seeded.day)), "9001");

    // Durable receipt: silent skip must be impossible — we sent, so skipped_reason is null.
    const receiptRaw = await ALERT_STATE.get(DIGEST_RUN_LATEST_KEY);
    assert.ok(receiptRaw, "cron must write digest:run:latest");
    const receipt = JSON.parse(receiptRaw);
    assert.equal(receipt.sent, 1);
    assert.ok(receipt.matched >= 1, "matched count records the hit");
    assert.equal(receipt.skipped_reason, null);
    assert.equal(receipt.day, today);
    assert.equal(await ALERT_STATE.get(digestRunDayKey(today)), receiptRaw);
    assert.equal(summary.receipt.sent, 1);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("digest silently skipped after event dual-write: inflated usage counters must not trip MAX_SENDS_PER_DAY", async () => {
  const today = new Date().toISOString().slice(0, 10);
  const subKey = "sub:cap-check@example.com:dualwrite02";
  const ALERT_STATE = new MockKV();
  seedPost166UsageDualWrite(ALERT_STATE);
  // Explicit: if spend guard ever read stats:page_view as sendcount, daily=9001 >= 50.
  assert.notEqual(await ALERT_STATE.get(statsKey("page_view", today)), await ALERT_STATE.get(`sendcount:${today}`));

  const SUBS = new MockKV({
    [subKey]: JSON.stringify({
      email: "cap-check@example.com",
      freq: "daily",
      channel: "email",
      lens: "money",
      filter: { keywords: ["education"] },
      createdAt: "2026-07-01T00:00:00.000Z",
    }),
  });

  let sent = 0;
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    const u = String(url);
    if (u.includes("api.resend.com")) { sent++; return { ok: true, json: async () => ({ id: "x" }) }; }
    if (u.includes("data.cityofnewyork.us")) return { ok: true, json: async () => [freshRow] };
    return { ok: true, json: async () => [] };
  };
  try {
    const r = await processOneSub(
      { SUBS, ALERT_STATE, RESEND_API_KEY: "rk", TOKEN_SECRET: "s".repeat(32), CONFIRM_BASE: "https://api.cityscroll.org" },
      { key: subKey, email: "cap-check@example.com", lens: "money", filter: { keywords: ["education"] }, freq: "daily", channel: "email", createdAt: "2026-07-01T00:00:00.000Z" },
      {
        FROM: "CityScroll <alerts@cityscroll.org>",
        LIVE: true,
        heartbeatDays: 14,
        today,
        isMonday: true,
        // Caps use the real send counters (0), not usage dual-write magnitudes.
        counts: () => ({ "per-run": 0, daily: 0 }),
        caps: { "per-run": 25, daily: 50 },
        onSent: async () => {},
      },
    );
    assert.equal(r.error, undefined, JSON.stringify(r));
    assert.equal(r.sent, true, "must not be capped by dual-write counters: " + JSON.stringify(r));
    assert.ok(!r.capped, "must not be capped by dual-write counters: " + JSON.stringify(r));
    assert.equal(sent, 1);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("summarizeDigestRun + private desk stats expose skipped_reason when nothing sent", async () => {
  const receipt = summarizeDigestRun({
    ranAt: "2026-07-30T13:00:00.000Z",
    day: "2026-07-30",
    live: true,
    mode: "inline",
    sentThisRun: 0,
    sentToday: 0,
    results: [
      { sub: "ab…cd", lens: "money", found: 0, new: 0, forecasts: 0, action: "none", sent: false, capped: false },
      { sub: "ef…gh", lens: "land", found: 0, new: 0, forecasts: 0, action: "none", sent: false, capped: false },
    ],
  });
  assert.equal(receipt.sent, 0);
  assert.equal(receipt.matched, 0);
  assert.equal(receipt.skipped_reason, "all_quiet");

  const ALERT_STATE = new MockKV({ [DIGEST_RUN_LATEST_KEY]: JSON.stringify(receipt) });
  const env = { ALERT_STATE, NL_METER: new MockKV(), SUBS: new MockKV() };
  const res = await handlePrivateStats(new Request("https://api.cityscroll.org/admin/stats"), env);
  const body = await res.json();
  assert.ok(body.digests.last_run, "last_run must appear on digests block");
  assert.equal(body.digests.last_run.skipped_reason, "all_quiet");
  assert.equal(body.digests.last_run.sent, 0);
  assert.equal(body.digests.last_run.matched, 0);
  assert.equal(body.digests.last_run.ranAt, "2026-07-30T13:00:00.000Z");
});

test("summarizeDigestRun: queue fan-out without consumer outcomes is queue_pending, not a silent empty", () => {
  const receipt = summarizeDigestRun({
    ranAt: "2026-07-30T13:00:00.000Z",
    day: "2026-07-30",
    live: true,
    mode: "queue",
    sentThisRun: 0,
    sentToday: 0,
    enqueued: 5,
    results: [{ mode: "queue", enqueued: 5 }],
  });
  assert.equal(receipt.skipped_reason, "queue_pending");
  assert.equal(receipt.enqueued, 5);
  assert.equal(receipt.sent, 0);
});
