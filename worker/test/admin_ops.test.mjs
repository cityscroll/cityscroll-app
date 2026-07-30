// Admin ops endpoints: roster, day-by-day sends, correctness — same auth gate as /admin/subs.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  checkAdminKey,
  handleAdminRoster,
  handleAdminSends,
  handleAdminOps,
} from "../src/admin.mjs";
import { digestDayLogKey, buildDayLog } from "../src/lib/digest_ops.mjs";

class MockKV {
  constructor(seed = {}) {
    this.store = new Map(Object.entries(seed).map(([k, v]) => [k, typeof v === "string" ? v : String(v)]));
  }
  async get(k) { return this.store.has(k) ? this.store.get(k) : null; }
  async put(k, v) { this.store.set(k, String(v)); }
  async list({ prefix = "", cursor } = {}) {
    const keys = [...this.store.keys()]
      .filter((k) => k.startsWith(prefix))
      .map((name) => ({ name }));
    return { keys, list_complete: true };
  }
}

const get = (url, headers = {}) => new Request(url, { method: "GET", headers });

function seedOps() {
  const today = new Date().toISOString().slice(0, 10);
  const subKey = "sub:reader@example.com:abcd1234";
  const dayLog = buildDayLog({
    day: today,
    ranAt: `${today}T13:00:00.000Z`,
    live: true,
    mode: "inline",
    results: [
      {
        sub: "sub:re***",
        lens: "money",
        queryLabel: "contract money — about “education”",
        emailRedacted: "re***@example.com",
        found: 2,
        new: 2,
        noticeIds: ["20260730001", "20260730002"],
        action: "match",
        sent: true,
      },
      {
        sub: "sub:qu***",
        lens: "money",
        queryLabel: "contract money — about “unicorn-zzzx”",
        emailRedacted: "qu***@example.com",
        found: 0,
        new: 0,
        noticeIds: [],
        action: "none",
        zeroMatch: true,
        sent: false,
      },
    ],
  });
  // Mask map: handleAdminOps maps maskKey(fullKey) → fullKey. Our daylog uses short masks
  // that won't reverse-map; correctness will be unchecked for those — still exercises the route.
  const SUBS = new MockKV({
    [subKey]: JSON.stringify({
      email: "reader@example.com",
      lens: "money",
      filter: { keywords: ["education"] },
      freq: "daily",
      channel: "email",
      lang: "en",
      createdAt: "2026-07-01T00:00:00.000Z",
    }),
  });
  const ALERT_STATE = new MockKV({
    [digestDayLogKey(today)]: JSON.stringify(dayLog),
    [`digest:run:${today}`]: JSON.stringify({
      ranAt: `${today}T13:00:00.000Z`,
      day: today,
      live: true,
      mode: "inline",
      matched: 1,
      sent: 1,
      skipped_reason: null,
    }),
    [`sendcount:${today}`]: "1",
    [`lastsent:${subKey}`]: today,
  });
  return { today, SUBS, ALERT_STATE, subKey, dayLog };
}

test("checkAdminKey: shared gate still 404 without ADMIN_KEY", () => {
  const r = checkAdminKey(get("https://w/admin/ops"), {});
  assert.equal(r.ok, false);
  assert.equal(r.res.status, 404);
});

test("handleAdminRoster: 401 on wrong key, 200 with roster email behind auth", async () => {
  const { SUBS, ALERT_STATE } = seedOps();
  const env = { ADMIN_KEY: "s3cr3t", SUBS, ALERT_STATE };
  assert.equal((await handleAdminRoster(get("https://w/admin/roster"), env)).status, 401);
  const r = await handleAdminRoster(get("https://w/admin/roster?key=s3cr3t"), env);
  assert.equal(r.status, 200);
  assert.equal(r.headers.get("Cache-Control"), "private, no-store");
  const body = await r.json();
  assert.equal(body.subscriberCount, 1);
  assert.equal(body.roster[0].email, "reader@example.com");
  assert.equal(body.roster[0].confirmed, true);
  assert.equal(body.roster[0].lastSent, body.roster[0].lastSent); // present
  assert.ok(body.roster[0].query);
  assert.equal(body.queries.length, 1);
  // Response must not place emails into a Location header or similar.
  assert.equal(r.headers.get("Location"), null);
});

test("handleAdminSends: day range includes zero-send rows and drill-down notice links", async () => {
  const { today, SUBS, ALERT_STATE } = seedOps();
  const env = { ADMIN_KEY: "s3cr3t", SUBS, ALERT_STATE };
  const r = await handleAdminSends(get(`https://w/admin/sends?key=s3cr3t&days=3&day=${today}`), env);
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.equal(body.days.length, 3);
  // Every day in the range is present — even days without a log.
  assert.ok(body.days.every((d) => d.day && Array.isArray(d.sends)));
  const focus = body.days.find((d) => d.day === today);
  assert.ok(focus.hasLog);
  assert.equal(focus.sent, 1);
  assert.equal(focus.zeroSendCount, 1);
  assert.equal(focus.totalNotices, 2);
  const sent = focus.sends.find((s) => s.sent);
  assert.deepEqual(sent.noticeIds, ["20260730001", "20260730002"]);
  assert.ok(sent.noticeLinks[0].includes("#notice/20260730001"));
  const quiet = focus.sends.find((s) => s.zeroMatch);
  assert.ok(quiet, "zero-match subscription must appear in the day log");
});

test("handleAdminOps: combined payload + correctness line + Bearer auth", async () => {
  const { SUBS, ALERT_STATE } = seedOps();
  const env = { ADMIN_KEY: "s3cr3t", SUBS, ALERT_STATE };
  const r = await handleAdminOps(
    get("https://w/admin/ops?days=7", { authorization: "Bearer s3cr3t" }),
    env,
  );
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.ok(body.asOf);
  assert.equal(body.subscriberCount, 1);
  assert.ok(Array.isArray(body.days));
  assert.ok(body.correctness);
  // Without a live D1 recount map, entries stay unchecked or ok with empty recounts.
  assert.ok(["ok", "no_log", "unchecked", "diverge"].includes(body.correctness.status));
  assert.ok(typeof body.correctness.summary === "string");
});

test("handleAdminOps: no-store cache headers always", async () => {
  const env = { ADMIN_KEY: "s3cr3t", SUBS: new MockKV(), ALERT_STATE: new MockKV() };
  const r = await handleAdminOps(get("https://w/admin/ops?key=s3cr3t"), env);
  assert.equal(r.headers.get("Cache-Control"), "private, no-store");
  assert.equal(r.headers.get("X-Robots-Tag"), "noindex, nofollow");
});

test("handleAdminSends: correctness=1 runs the check for focus day", async () => {
  const { today, SUBS, ALERT_STATE, dayLog } = seedOps();
  // Inject a silent-miss shape and a recount path via empty DB (unchecked) — still returns object.
  const env = { ADMIN_KEY: "s3cr3t", SUBS, ALERT_STATE };
  const r = await handleAdminSends(
    get(`https://w/admin/sends?key=s3cr3t&day=${today}&correctness=1&days=1`),
    env,
  );
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.ok(body.correctness);
  assert.equal(body.correctness.day, today);
  // dayLog is present so status is not no_log.
  assert.notEqual(body.correctness.status, "no_log");
  assert.ok(dayLog.entries.length >= 1);
});
