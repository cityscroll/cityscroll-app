import assert from "node:assert/strict";
import test from "node:test";
import {
  digestWatchdogSnapshot,
  evaluateWatermarkStaleness,
  mailCanaryTokenFromSubject,
  mailWatchdogHasMailFindings,
  mailWatchdogSnapshot,
  recordDigestDeliveryReceipt,
  recordDigestShadowReceipt,
  recordInboundEmailReceipt,
  recordOutboundOpsSendReceipt,
  recordSchedulerHeartbeat,
  schedulerWatchdogSnapshot,
  sendInboundWorkerCanary,
} from "../src/reliability_watchdogs.mjs";
import { digestDayLogKey } from "../src/lib/digest_ops.mjs";
import { OPS_ALERT_TO, sendOpsAlert } from "../src/alerts.mjs";
import { handleAdminDigestWatchdog, handleAdminMailWatchdog } from "../src/admin.mjs";

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

function headers(subject) {
  return { get(name) { return String(name).toLowerCase() === "subject" ? subject : null; } };
}

test("mail canary token is parsed only from the exact subject prefix", () => {
  assert.equal(
    mailCanaryTokenFromSubject("[cityscroll-mail-canary] 0123456789abcdef0123456789abcdef"),
    "0123456789abcdef0123456789abcdef",
  );
  assert.equal(mailCanaryTokenFromSubject("construction awards over $500k"), null);
});

test("inbound receipts record ignored loop mail and canary tokens", async () => {
  const ALERT_STATE = kv();
  const now = new Date("2026-08-29T14:10:20Z");
  const token = "0123456789abcdef0123456789abcdef";
  await recordInboundEmailReceipt({ ALERT_STATE }, {
    from: "alerts@cityscroll.org",
    to: "subscribe@crol-list.org",
    headers: headers(`[cityscroll-mail-canary] ${token}`),
  }, now);
  const snapshot = await mailWatchdogSnapshot({ ALERT_STATE }, { now });
  assert.equal(snapshot.inbound.to, "subscribe@crol-list.org");
  assert.equal(snapshot.inbound.canary_token, token);
  assert.equal(snapshot.ok, true);
});

test("mail watchdog fails when the inbound canary is not received", async () => {
  const ALERT_STATE = kv();
  const sent = new Date("2026-08-29T14:10:00Z");
  const now = new Date("2026-08-29T14:25:00Z");
  await sendInboundWorkerCanary({
    ALERT_STATE,
    RESEND_API_KEY: "test-key",
    SUBSCRIBE_ADDRESS: "subscribe@crol-list.org",
    ALERTS_FROM: "CityScroll <alerts@cityscroll.org>",
  }, {
    now: sent,
    token: "0123456789abcdef0123456789abcdef",
    fetchImpl: async () => ({ ok: true, json: async () => ({ id: "canary" }) }),
  });
  const snapshot = await mailWatchdogSnapshot({ ALERT_STATE }, { now });
  assert.equal(snapshot.ok, false);
  assert.match(snapshot.findings.join("; "), /inbound-worker canary was not received/);
  assert.equal(snapshot.gmail_forward.status, "unprobed");
});

test("mail watchdog stays pending inside the receive window", async () => {
  const ALERT_STATE = kv();
  const sent = new Date("2026-08-29T14:10:00Z");
  await sendInboundWorkerCanary({
    ALERT_STATE,
    RESEND_API_KEY: "test-key",
  }, {
    now: sent,
    token: "0123456789abcdef0123456789abcdef",
    fetchImpl: async () => ({ ok: true, json: async () => ({ id: "canary" }) }),
  });
  const snapshot = await mailWatchdogSnapshot({ ALERT_STATE }, { now: new Date("2026-08-29T14:12:00Z") });
  assert.equal(snapshot.ok, true);
  assert.deepEqual(snapshot.findings, []);
});

test("digest watchdog folds mail findings and skips emailing a dead mail rail", async () => {
  const ALERT_STATE = kv();
  const now = new Date("2026-08-25T14:10:00Z");
  await recordDigestShadowReceipt({ ALERT_STATE }, { ok: true }, now);
  await recordDigestDeliveryReceipt({ ALERT_STATE }, { sent: 2, enqueued: 0 }, now);
  await recordOutboundOpsSendReceipt({ ALERT_STATE }, { accepted: false, reason: "resend-rejected" }, now);
  const snapshot = await digestWatchdogSnapshot({ ALERT_STATE }, { now });
  assert.equal(snapshot.ok, false);
  assert.match(snapshot.findings.join("; "), /mail: ops mailbox send was not accepted/);
  assert.equal(mailWatchdogHasMailFindings(snapshot.findings), true);

  let sent = 0;
  const previous = globalThis.fetch;
  globalThis.fetch = async () => {
    sent += 1;
    return { ok: true, json: async () => ({ id: "should-not-send" }) };
  };
  try {
    const response = await handleAdminDigestWatchdog(
      new Request("https://w/admin/reliability/digest?key=s3cr3t"),
      { ADMIN_KEY: "s3cr3t", ALERT_STATE, RESEND_API_KEY: "rk" },
      { now },
    );
    assert.equal(response.status, 503);
    assert.equal(sent, 0);
  } finally {
    globalThis.fetch = previous;
  }
});

test("mail watchdog POST canary records the worker-consumer probe without enrolling", async () => {
  const ALERT_STATE = kv();
  const now = new Date("2026-08-29T14:10:00Z");
  const previous = globalThis.fetch;
  const sent = [];
  globalThis.fetch = async (url, options) => {
    sent.push({ url, body: JSON.parse(options.body) });
    return { ok: true, json: async () => ({ id: "message" }) };
  };
  try {
    const response = await handleAdminMailWatchdog(
      new Request("https://w/admin/reliability/mail?key=s3cr3t", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "canary" }),
      }),
      {
        ADMIN_KEY: "s3cr3t",
        ALERT_STATE,
        RESEND_API_KEY: "rk",
        ALERTS_FROM: "CityScroll <alerts@cityscroll.org>",
        SUBSCRIBE_ADDRESS: "subscribe@crol-list.org",
      },
      { now, fetchImpl: globalThis.fetch },
    );
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.inbound_worker.target, "subscribe@crol-list.org");
    assert.match(body.inbound_worker.token, /^[0-9a-f]{32}$/);
    assert.ok(sent.some((row) => row.body.to === "subscribe@crol-list.org"));
    assert.ok(sent.some((row) => row.body.to === OPS_ALERT_TO));
    assert.ok(sent.every((row) => !/enroll|watch/i.test(row.body.subject || "")));
  } finally {
    globalThis.fetch = previous;
  }
});
