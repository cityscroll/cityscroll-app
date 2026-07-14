// Queue-mode digest bookkeeping: a real send must advance lastsent:<key> (the
// heartbeat clock and the "since <date>" line depend on it). Characterization
// added 2026-07-14 while investigating a suspected lastsent bug that proved a
// false alarm — pinned so a real regression fails CI instead of needing inbox
// archaeology.
import { test } from "node:test";
import assert from "node:assert/strict";
import { consumeDigestJob } from "../src/alerts.mjs";

class MockKV {
  constructor() { this.store = new Map(); }
  async get(k) { return this.store.has(k) ? this.store.get(k) : null; }
  async put(k, v, o) { this.store.set(k, String(v)); }
  async delete(k) { this.store.delete(k); }
  async list({ prefix = "" } = {}) {
    return { keys: [...this.store.keys()].filter(k => k.startsWith(prefix)).map(name => ({ name })), list_complete: true };
  }
}

test("consumeDigestJob: send advances lastsent + sendcount", async () => {
  const SUBS = new MockKV(), ALERT_STATE = new MockKV();
  const key = "sub:test@example.com:abcd1234";
  await SUBS.put(key, JSON.stringify({ email: "test@example.com", lens: "money", filter: { minAmount: 500000, keywords: ["construction"] }, freq: "daily", channel: "email", createdAt: "2026-07-01T00:00:00.000Z", lang: "en" }));
  const env = { SUBS, ALERT_STATE, ALERTS_LIVE: "true", RESEND_API_KEY: "rk", TOKEN_SECRET: "s".repeat(32) };

  const sent = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    const u = String(url);
    if (u.includes("data.cityofnewyork.us")) {
      return Response.json([{ request_id: "20260714001", start_date: "2026-07-14T00:00:00.000", agency_name: "DDC", short_title: "Construction thing", contract_amount: "900000", section_name: "Procurement" }]);
    }
    if (u.includes("api.resend.com")) { sent.push(JSON.parse(opts.body)); return Response.json({ id: "email_1" }); }
    throw new Error("unexpected fetch: " + u);
  };
  try {
    const r = await consumeDigestJob(env, key);
    assert.equal(r.sent, true, "digest should send: " + JSON.stringify(r));
    assert.equal(sent.length, 1, "exactly one email");
    const day = new Date().toISOString().slice(0, 10);
    assert.equal(await ALERT_STATE.get("sendcount:" + day), "1", "sendcount advances");
    assert.equal(await ALERT_STATE.get("lastsent:" + key), day, "lastsent must advance to today");
  } finally { globalThis.fetch = realFetch; }
});
