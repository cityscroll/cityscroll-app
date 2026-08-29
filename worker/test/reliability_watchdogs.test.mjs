import assert from "node:assert/strict";
import test from "node:test";
import {
  digestWatchdogSnapshot,
  evaluateWatermarkStaleness,
  recordDigestDeliveryReceipt,
  recordDigestShadowReceipt,
  recordSchedulerHeartbeat,
  schedulerWatchdogSnapshot,
} from "../src/reliability_watchdogs.mjs";
import { digestDayLogKey } from "../src/lib/digest_ops.mjs";
import { OPS_ALERT_TO, sendOpsAlert } from "../src/alerts.mjs";

function kv(seed = {}) {
  const store = new Map(Object.entries(seed));
  return {
    store,
    async get(key) { return store.get(key) || null; },
    async put(key, value) { store.set(key, String(value)); },
  };
}

test("digest watchdog stays quiet with READY and terminal receipts", async () => {
  const ALERT_STATE = kv();
  const now = new Date("2026-08-25T14:10:00Z");
  await recordDigestShadowReceipt({ ALERT_STATE }, { ok: true }, now);
  await recordDigestDeliveryReceipt({ ALERT_STATE }, { sent: 2, enqueued: 0 }, now);
  const result = await digestWatchdogSnapshot({ ALERT_STATE }, { now });
  assert.equal(result.ok, true);
  assert.deepEqual(result.findings, []);
});

test("digest watchdog fires when the expected receipt is missing", async () => {
  const result = await digestWatchdogSnapshot({ ALERT_STATE: kv() }, { now: new Date("2026-08-25T14:10:00Z") });
  assert.equal(result.ok, false);
  assert.match(result.findings.join("; "), /shadow READY receipt missing/);
  assert.match(result.findings.join("; "), /terminal delivery receipt missing/);
});

test("scheduler watchdog stays quiet for a recent empty-outbox heartbeat", async () => {
  const ALERT_STATE = kv();
  const now = new Date("2026-08-25T14:00:00Z");
  await recordSchedulerHeartbeat({ ALERT_STATE }, { pending_outbox: 0 }, new Date("2026-08-25T13:30:00Z"));
  const result = await schedulerWatchdogSnapshot({ ALERT_STATE }, { now });
  assert.equal(result.ok, true);
});

test("scheduler watchdog fires on expired heartbeat and pending outbox", async () => {
  const ALERT_STATE = kv();
  const now = new Date("2026-08-25T14:00:00Z");
  await recordSchedulerHeartbeat({ ALERT_STATE }, { pending_outbox: 3 }, new Date("2026-08-25T11:00:00Z"));
  const result = await schedulerWatchdogSnapshot({ ALERT_STATE }, { now });
  assert.equal(result.ok, false);
  assert.match(result.findings.join("; "), /heartbeat expired/);
  assert.match(result.findings.join("; "), /3 pending/);
});

test("watermark staleness stays quiet when consecutive sends advanced lastsent", () => {
  const result = evaluateWatermarkStaleness({
    day: "2026-08-29",
    priorDay: "2026-08-28",
    delivery: { status: "TERMINAL", accepted_sends: 1 },
    lastsentByWatch: { "sub:a": "2026-08-29" },
    sentWatchKeysToday: ["sub:a"],
    sentWatchKeysYesterday: ["sub:a"],
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.findings, []);
});

test("watermark staleness fires when two consecutive deliveries share an older lastsent", () => {
  const result = evaluateWatermarkStaleness({
    day: "2026-08-29",
    priorDay: "2026-08-28",
    delivery: { status: "TERMINAL", accepted_sends: 1 },
    lastsentByWatch: { "sub:a": "2026-08-25" },
    sentWatchKeysToday: ["sub:a"],
    sentWatchKeysYesterday: ["sub:a"],
  });
  assert.equal(result.ok, false);
  assert.match(result.findings.join("; "), /stuck after consecutive sends/);
  assert.match(result.findings.join("; "), /2026-08-25/);
});

test("digest watchdog fires watermark staleness after the delivery deadline", async () => {
  const ALERT_STATE = kv();
  const now = new Date("2026-08-29T14:10:00Z");
  await recordDigestShadowReceipt({ ALERT_STATE }, { ok: true }, now);
  await recordDigestDeliveryReceipt({ ALERT_STATE }, { sent: 1, enqueued: 0 }, now);
  await ALERT_STATE.put(digestDayLogKey("2026-08-28"), JSON.stringify({
    day: "2026-08-28",
    entries: [{ kind: "subscription", sent: true, id: "sub:a" }],
  }));
  await ALERT_STATE.put(digestDayLogKey("2026-08-29"), JSON.stringify({
    day: "2026-08-29",
    entries: [{ kind: "subscription", sent: true, id: "sub:a" }],
  }));
  await ALERT_STATE.put("lastsent:sub:a", "2026-08-25");
  const result = await digestWatchdogSnapshot({ ALERT_STATE }, { now });
  assert.equal(result.ok, false);
  assert.match(result.findings.join("; "), /stuck after consecutive sends/);
  assert.equal(result.watermark_stuck, 1);
});

test("digest watchdog stays quiet for consecutive sends whose lastsent reached today", async () => {
  const ALERT_STATE = kv();
  const now = new Date("2026-08-29T14:10:00Z");
  await recordDigestShadowReceipt({ ALERT_STATE }, { ok: true }, now);
  await recordDigestDeliveryReceipt({ ALERT_STATE }, { sent: 1, enqueued: 0 }, now);
  await ALERT_STATE.put(digestDayLogKey("2026-08-28"), JSON.stringify({
    day: "2026-08-28",
    entries: [{ kind: "subscription", sent: true, id: "sub:a" }],
  }));
  await ALERT_STATE.put(digestDayLogKey("2026-08-29"), JSON.stringify({
    day: "2026-08-29",
    entries: [{ kind: "subscription", sent: true, id: "sub:a" }],
  }));
  await ALERT_STATE.put("lastsent:sub:a", "2026-08-29");
  const result = await digestWatchdogSnapshot({ ALERT_STATE }, { now });
  assert.equal(result.ok, true);
  assert.deepEqual(result.findings, []);
});

test("runtime alarms use the existing Resend path and the ops mailbox", async () => {
  const previous = globalThis.fetch;
  let request;
  globalThis.fetch = async (url, options) => {
    request = { url, options };
    return { ok: true, json: async () => ({ id: "ops-message" }) };
  };
  try {
    const result = await sendOpsAlert({ RESEND_API_KEY: "test-key", ALERTS_FROM: "CityScroll <alerts@cityscroll.org>" }, {
      guard: "test-guard", subject: "Test reliability alarm", text: "bad condition",
    });
    assert.equal(result.accepted, true);
    assert.equal(request.url, "https://api.resend.com/emails");
    const payload = JSON.parse(request.options.body);
    assert.equal(payload.to, OPS_ALERT_TO);
    assert.equal(payload.to, "team@cityscroll.org");
  } finally {
    globalThis.fetch = previous;
  }
});
