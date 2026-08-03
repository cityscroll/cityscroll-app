// Desk hub / ops daylog is send-level (not email item HTML). After the email
// time+action upgrade it must still: (a) stamp noticeIds + noticeLinks for
// every match send, (b) describeSendOutcome / correctness without inventing
// item fields. Characterizes the operator surface fed by digest_ops.

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  toDayLogEntry,
  buildDayLog,
  noticeDeepLink,
  correctnessCheck,
} from "../src/lib/digest_ops.mjs";
import { processOneSub } from "../src/alerts.mjs";
import { itemAwarenessHtml } from "../src/lib/digest_item_awareness.mjs";

class MockKV {
  constructor(seed = {}) {
    this.store = new Map(Object.entries(seed));
  }
  async get(key) { return this.store.get(key) ?? null; }
  async put(key, value) { this.store.set(key, String(value)); }
  async list({ prefix = "" } = {}) {
    return {
      keys: [...this.store.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name })),
      list_complete: true,
    };
  }
}

const TODAY = "2026-08-02";
const SUB_KEY = "sub:ops-continuity-01";
const NOTICE = {
  request_id: "FIX-OPS-SOL-1",
  start_date: "2026-08-01T00:00:00.000",
  agency_name: "Department of Transportation",
  short_title: "Fixture resurfacing solicitation",
  type_of_notice_description: "Solicitation",
  due_date: "2026-08-10",
  pin: "DOT-OPS-1",
  contract_amount: "",
  additional_description_1:
    "Vendors must download the solicitation documents at https://example.com/rfps before submitting.",
};

test("daylog entry from a match send carries noticeIds + deep links (desk drill-down)", () => {
  const result = {
    sub: SUB_KEY,
    kind: "subscription",
    lens: "money",
    queryLabel: "contract money — construction",
    emailRedacted: "u***@example.com",
    found: 1,
    new: 1,
    noticeIds: [NOTICE.request_id],
    action: "match",
    sent: true,
    dryRun: false,
    forecasts: 0,
  };
  const e = toDayLogEntry(result, { day: TODAY });
  assert.equal(e.noticeCount, 1);
  assert.deepEqual(e.noticeIds, [NOTICE.request_id]);
  assert.equal(e.noticeLinks.length, 1);
  assert.equal(e.noticeLinks[0], noticeDeepLink(NOTICE.request_id));
  assert.match(e.noticeLinks[0], /#notice\/FIX-OPS-SOL-1/);
  // Daylog stays send-level: no item HTML, phase, or next-action payload (desk uses deep links).
  assert.equal(e.itemHtml, undefined);
  assert.equal(e.awareness, undefined);
});

test("buildDayLog totals and correctness stay stable after email awareness upgrade", () => {
  const log = buildDayLog({
    day: TODAY,
    ranAt: `${TODAY}T13:00:00.000Z`,
    live: true,
    mode: "inline",
    results: [{
      sub: SUB_KEY,
      kind: "subscription",
      lens: "money",
      queryLabel: "money",
      emailRedacted: "u***@example.com",
      found: 1,
      new: 1,
      noticeIds: [NOTICE.request_id],
      action: "match",
      sent: true,
    }],
  });
  assert.equal(log.sentCount, 1);
  assert.equal(log.totalNotices, 1);
  const check = correctnessCheck({
    day: TODAY,
    dayLog: log,
    recounts: {
      [SUB_KEY]: { found: 1, fresh: 1, noticeIds: [NOTICE.request_id] },
    },
  });
  assert.equal(check.ok, true, JSON.stringify(check));
});

test("e2e: processOneSub match populates daylog-shaped noticeIds while email HTML has awareness", async () => {
  const ALERT_STATE = new MockKV();
  const SUBS = new MockKV({
    [SUB_KEY]: JSON.stringify({
      key: SUB_KEY,
      email: ["ops", "example.test"].join("@"),
      lens: "money",
      filter: { keywords: ["resurfacing"], noticeType: "solicitation" },
      freq: "daily",
      channel: "email",
      createdAt: "2026-07-01T00:00:00.000Z",
      lang: "en",
    }),
  });
  const env = {
    ALERT_STATE,
    SUBS,
    RESEND_API_KEY: "test-key",
    TOKEN_SECRET: "s".repeat(32),
    CONFIRM_BASE: "https://api.cityscroll.org",
  };
  const sent = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    const value = String(url);
    if (value.includes("data.cityofnewyork.us")) return Response.json([NOTICE]);
    if (value.includes("api.resend.com/emails")) {
      sent.push(JSON.parse(options.body));
      return Response.json({ id: "email-1" });
    }
    throw new Error(`unexpected fetch: ${value}`);
  };
  try {
    const r = await processOneSub(env, {
      key: SUB_KEY,
      email: ["ops", "example.test"].join("@"),
      lens: "money",
      filter: { keywords: ["resurfacing"], noticeType: "solicitation" },
      freq: "daily",
      channel: "email",
      createdAt: "2026-07-01T00:00:00.000Z",
      lang: "en",
    }, {
      FROM: "CityScroll",
      LIVE: true,
      heartbeatDays: 14,
      today: TODAY,
      isMonday: false,
      counts: () => ({ "per-run": 0, daily: 0 }),
      caps: { "per-run": 25, daily: 50 },
      onSent: async () => {},
    });
    assert.equal(r.error, undefined, JSON.stringify(r));
    assert.equal(r.sent, true);
    assert.equal(r.new, 1);
    assert.deepEqual(r.noticeIds, [NOTICE.request_id]);

    // Daylog shape operators consume:
    const entry = toDayLogEntry(r, { day: TODAY });
    assert.deepEqual(entry.noticeIds, [NOTICE.request_id]);
    assert.ok(entry.noticeLinks[0].includes("#notice/FIX-OPS-SOL-1"));

    // Email body still has time + action awareness (product surface for subscribers).
    assert.equal(sent.length, 1);
    assert.match(sent[0].html, /Closing soon|Next step|example\.com\/rfps|Solicitation/i);

    // Pure awareness still renders for the same row (site preview path).
    const esc = (s) => String(s).replace(/[<>&]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" }[c]));
    const preview = itemAwarenessHtml(NOTICE, esc, "en", { kind: "rfp", today: TODAY });
    assert.match(preview, /Next step:|Closing soon|example\.com\/rfps/i);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
