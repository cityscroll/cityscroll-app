import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_SUBSCRIBE_ADDRESS,
  digestWatchdogSnapshot,
  evaluateWatermarkStaleness,
  isHumanOpsMailbox,
  mailCanaryTokenFromSubject,
  mailWatchdogHasMailFindings,
  mailWatchdogSnapshot,
  recordDigestDeliveryReceipt,
  recordDigestShadowReceipt,
  digestShadowFinding,
  recordInboundEmailReceipt,
  recordOutboundOpsSendReceipt,
  recordSchedulerHeartbeat,
  canonicalOpsFailureSignature,
  emitOpsAlertOnce,
  resolveMailCanaryTarget,
  schedulerWatchdogSnapshot,
  sendInboundWorkerCanary,
} from "../src/reliability_watchdogs.mjs";
import { digestDayLogKey } from "../src/lib/digest_ops.mjs";
import { OPS_ALERT_TO, sendOpsAlert } from "../src/alerts.mjs";
import { handleAdminDigestWatchdog, handleAdminMailWatchdog, handleAdminOpsAlert, handleAdminOpsHealth } from "../src/admin.mjs";

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

// The alert the site owner received said only "shadow receipt is DEGRADED".
// The rehearsal knew the reason, the receipt dropped it, and the reader was
// left with a count of one redline and nowhere to go.
test("a DEGRADED shadow receipt carries the reason that degraded it", async () => {
  const ALERT_STATE = kv();
  const now = new Date("2026-09-05T10:03:13.657Z");
  const receipt = await recordDigestShadowReceipt({ ALERT_STATE }, {
    ok: false,
    digest_count: 0,
    evaluated_count: 8,
    total_items: 0,
    redlines: [{
      code: "aggregate_count_collapse",
      digest_id: "run",
      reason: "Aggregate digest items collapsed against the trailing average.",
      evidence: { current_item_count: 0, trailing_average: 46.857142857142854, ratio: 0 },
    }],
  }, now);

  assert.equal(receipt.status, "DEGRADED");
  assert.equal(receipt.redlines, 1);
  assert.deepEqual(receipt.redline_codes, ["aggregate_count_collapse"]);
  assert.equal(receipt.reason, "Aggregate digest items collapsed against the trailing average.");
  // A rehearsal that built nothing reads as a healthy quiet day in a redline
  // count alone, so the build shape is part of the receipt. evaluated_count
  // separates "nothing was new for anyone" from "nobody was selected at all".
  assert.equal(receipt.digest_count, 0);
  assert.equal(receipt.total_items, 0);
  assert.equal(receipt.evaluated_count, 8);

  const result = await digestWatchdogSnapshot({ ALERT_STATE }, { now: new Date("2026-09-05T13:27:03.304Z") });
  assert.equal(result.ok, false);
  assert.match(result.findings.join("; "), /shadow receipt is DEGRADED \(aggregate_count_collapse: Aggregate digest items collapsed against the trailing average\.\)/);
});

// The finding text is the alert's dedupe signature. A reason that carried the
// day's counts would produce a new signature every day and re-alert forever.
test("the shadow finding names the fault without embedding the day's counts", () => {
  const monday = digestShadowFinding({
    status: "DEGRADED",
    redline_codes: ["aggregate_count_collapse"],
    reason: "Aggregate digest items collapsed against the trailing average.",
    digest_count: 0,
    total_items: 0,
  });
  const tuesday = digestShadowFinding({
    status: "DEGRADED",
    redline_codes: ["aggregate_count_collapse"],
    reason: "Aggregate digest items collapsed against the trailing average.",
    digest_count: 3,
    total_items: 2,
  });
  assert.equal(monday, tuesday);
  assert.equal(/\d/.test(monday), false);
  // A receipt written before the reason was recorded still reads cleanly.
  assert.equal(digestShadowFinding({ status: "DEGRADED", redlines: 1 }), "shadow receipt is DEGRADED");
});

// Zero accepted sends is shared by a broken delivery leg and a quiet day. The
// receipt already recorded which; the finding used to drop it.
test("zero accepted sends names the recorded skip reason", async () => {
  const ALERT_STATE = kv();
  const now = new Date("2026-09-05T13:04:59.651Z");
  await recordDigestShadowReceipt({ ALERT_STATE }, { ok: true }, now);
  await recordDigestDeliveryReceipt({ ALERT_STATE }, { sent: 0, enqueued: 8, skipped_reason: "skipped" }, now);
  const result = await digestWatchdogSnapshot({ ALERT_STATE }, { now: new Date("2026-09-05T14:08:00.000Z") });
  assert.equal(result.ok, false);
  assert.match(result.findings.join("; "), /enqueued digest has zero accepted sends \(skipped\)/);
});

const CYCLE = Object.freeze({
  workflow: "com.cityscroll.external-schedules",
  run_id: "2026-08-25T13-30:runner-7:4821",
  source_revision: "dd4b708b6fe39bf8b2ea635ef3d4f493c4751ace",
  result: "succeeded",
});

test("scheduler watchdog stays quiet for a recent empty-outbox heartbeat", async () => {
  const ALERT_STATE = kv();
  const now = new Date("2026-08-25T14:00:00Z");
  const write = await recordSchedulerHeartbeat({ ALERT_STATE }, { ...CYCLE, pending_outbox: 0 }, new Date("2026-08-25T13:30:00Z"));
  assert.equal(write.accepted, true);
  const result = await schedulerWatchdogSnapshot({ ALERT_STATE }, { now });
  assert.equal(result.ok, true);
  assert.equal(result.scheduler_ok, true);
  assert.equal(result.heartbeat.workflow, CYCLE.workflow);
  assert.equal(result.heartbeat.run_id, CYCLE.run_id);
});

test("scheduler watchdog fires on expired heartbeat and pending outbox", async () => {
  const ALERT_STATE = kv();
  const now = new Date("2026-08-25T14:00:00Z");
  await recordSchedulerHeartbeat({ ALERT_STATE }, { ...CYCLE, pending_outbox: 3 }, new Date("2026-08-25T11:00:00Z"));
  const result = await schedulerWatchdogSnapshot({ ALERT_STATE }, { now });
  assert.equal(result.ok, false);
  assert.match(result.findings.join("; "), /heartbeat expired/);
  assert.match(result.findings.join("; "), /3 pending/);
});

test("ops failures have lossless stable signatures and restart-stable daily rollups", async () => {
  const ALERT_STATE = kv();
  const sent = [];
  const previous = globalThis.fetch;
  globalThis.fetch = async (_url, options) => {
    sent.push(JSON.parse(options.body));
    return { ok: true, json: async () => ({ id: `mail-${sent.length}` }) };
  };
  const base = {
    guard: "served-artifact-freshness",
    stage: "served_artifact_freshness",
    findings: ["artifact hash mismatch at 2026-08-31T12:00:00Z", "source commit mismatch"],
    first_seen: "2026-08-31T12:00:00Z",
    last_seen: "2026-08-31T12:00:00Z",
    workflow: "Served artifact freshness",
    source_revision: "dd4b708b6fe39bf8b2ea635ef3d4f493c4751ace",
    workflow_run_url: "https://github.com/cityscroll/cityscroll-app/actions/runs/123",
    receipt_url: "https://github.com/cityscroll/cityscroll-app/actions/runs/123#artifacts",
  };
  try {
    const signature = await canonicalOpsFailureSignature(base);
    assert.equal(signature, await canonicalOpsFailureSignature({ ...base, findings: [...base.findings].reverse() }));
    assert.notEqual(signature, await canonicalOpsFailureSignature({ ...base, stage: "generation_output" }));
    assert.equal((await emitOpsAlertOnce({ ALERT_STATE, RESEND_API_KEY: "rk" }, { ...base, now: new Date(base.last_seen) })).sent, true);
    assert.equal((await emitOpsAlertOnce({ ALERT_STATE, RESEND_API_KEY: "rk" }, { ...base, last_seen: "2026-08-31T12:05:00Z", now: new Date("2026-08-31T12:05:00Z") })).sent, false);
    assert.equal(sent.length, 1);
    assert.equal((await emitOpsAlertOnce({ ALERT_STATE, RESEND_API_KEY: "rk" }, { ...base, last_seen: "2026-09-01T12:05:00Z", now: new Date("2026-09-01T12:05:00Z") })).sent, true);
    assert.equal((await emitOpsAlertOnce({ ALERT_STATE, RESEND_API_KEY: "rk" }, { ...base, last_seen: "2026-09-01T12:06:00Z", now: new Date("2026-09-01T12:06:00Z") })).sent, false);
    assert.equal(sent.length, 2);
    assert.match(sent[0].html, /broke: artifact hash mismatch/);
    assert.match(sent[0].html, /actions\/runs\/123/);
    assert.equal((sent[0].html.match(/<p>/g) || []).length, 1);
    assert.doesNotMatch(sent[0].html, /<h1>/);
    assert.doesNotMatch(sent[0].html, /\{\s*&quot;guard&quot;/);
  } finally { globalThis.fetch = previous; }
});

test("admin ops alert rejects unstructured or untrusted links", async () => {
  const env = { ADMIN_KEY: "secret", ALERT_STATE: kv() };
  const observedAt = "2026-08-31T12:00:00.000Z";
  const malformed = await handleAdminOpsAlert(new Request("https://w/admin/ops-alert", {
    method: "POST", headers: { authorization: "Bearer secret", "content-type": "application/json" },
    body: JSON.stringify({ guard: "g", text: "raw caller text" }),
  }), env);
  assert.equal(malformed.status, 400);
  const badLink = await handleAdminOpsAlert(new Request("https://w/admin/ops-alert", {
    method: "POST", headers: { authorization: "Bearer secret", "content-type": "application/json" },
    body: JSON.stringify({ guard: "g", stage: "s", findings: ["failed"], first_seen: observedAt, last_seen: observedAt, workflow_run_url: "https://evil.invalid/run", receipt_url: "https://evil.invalid/raw" }),
  }), env);
  assert.equal(badLink.status, 400);
});

test("private ops-health endpoint emits a sanitized no-store envelope with unavailable states", async () => {
  const response = await handleAdminOpsHealth(
    new Request("https://w/admin/reliability/ops-health", { headers: { authorization: "Bearer secret" } }),
    { ADMIN_KEY: "secret", ALERT_STATE: kv() },
    { now: new Date("2026-08-31T12:00:00Z") },
  );
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "private, no-store");
  const body = await response.json();
  assert.equal(body.schema, "cityscroll.ops-health-sanitized.v1");
  assert.equal(body.freshness.status, "unavailable");
  assert.deepEqual(body.alerts.items, []);
  assert.doesNotMatch(JSON.stringify(body), /recipient|authorization|token|@[a-z0-9.-]+/i);
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
    assert.equal(payload.to, "james@cityscroll.org");
    assert.notEqual(payload.to, "team@cityscroll.org");
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
  assert.equal(
    mailCanaryTokenFromSubject("[cityscroll-mail-canary] 0123456789ABCDEF0123456789ABCDEF"),
    "0123456789abcdef0123456789abcdef",
  );
  assert.equal(mailCanaryTokenFromSubject("[CITYSCROLL-MAIL-CANARY] 0123456789abcdef0123456789abcdef"), null);
  assert.equal(mailCanaryTokenFromSubject("construction awards over $500k"), null);
});

test("mail canary target refuses human operations mailboxes", () => {
  const refused = resolveMailCanaryTarget({ SUBSCRIBE_ADDRESS: "james@cityscroll.org" });
  assert.equal(refused.ok, false);
  assert.equal(refused.reason, "human-ops-mailbox-refused");
  assert.equal(isHumanOpsMailbox("alerts@cityscroll.org"), true);
  assert.equal(isHumanOpsMailbox(`alerts@${DEFAULT_SUBSCRIBE_ADDRESS.split("@")[1]}`), true);
  const allowed = resolveMailCanaryTarget({ SUBSCRIBE_ADDRESS: DEFAULT_SUBSCRIBE_ADDRESS });
  assert.equal(allowed.ok, true);
  assert.deepEqual(allowed.envelope, { to: [DEFAULT_SUBSCRIBE_ADDRESS], cc: [] });
});

test("inbound receipts record ignored loop mail and canary tokens", async () => {
  const ALERT_STATE = kv();
  const now = new Date("2026-08-29T14:10:20Z");
  const token = "0123456789abcdef0123456789abcdef";
  await recordInboundEmailReceipt({ ALERT_STATE }, {
    from: "alerts@cityscroll.org",
    to: DEFAULT_SUBSCRIBE_ADDRESS,
    headers: headers(`[cityscroll-mail-canary] ${token}`),
  }, now);
  const snapshot = await mailWatchdogSnapshot({ ALERT_STATE }, { now });
  assert.equal(snapshot.inbound.to, DEFAULT_SUBSCRIBE_ADDRESS);
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
    SUBSCRIBE_ADDRESS: DEFAULT_SUBSCRIBE_ADDRESS,
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
        SUBSCRIBE_ADDRESS: DEFAULT_SUBSCRIBE_ADDRESS,
      },
      { now, fetchImpl: globalThis.fetch },
    );
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.inbound_worker.target, DEFAULT_SUBSCRIBE_ADDRESS);
    assert.match(body.inbound_worker.token, /^[0-9a-f]{32}$/);
    assert.equal(body.inbound_worker.token_prefix, body.inbound_worker.token.slice(0, 8));
    assert.deepEqual(body.inbound_worker.envelope, { to: [DEFAULT_SUBSCRIBE_ADDRESS], cc: [] });
    assert.equal(body.outbound_ops.sent, false);
    assert.equal(body.outbound_ops.reason, "healthy-canary-silent");
    assert.equal(sent.length, 1);
    assert.equal(sent[0].body.to, DEFAULT_SUBSCRIBE_ADDRESS);
    assert.deepEqual(sent[0].body.cc, []);
    assert.match(sent[0].body.subject, /^\[cityscroll-mail-canary\] [0-9a-f]{32}$/);
    assert.ok(sent.every((row) => row.body.to !== OPS_ALERT_TO));
    assert.ok(sent.every((row) => !/enroll|watch/i.test(row.body.subject || "")));
  } finally {
    globalThis.fetch = previous;
  }
});

test("mail canary round trip records the inbound token receipt", async () => {
  const ALERT_STATE = kv();
  const now = new Date("2026-08-29T14:10:00Z");
  const token = "0123456789abcdef0123456789abcdef";
  await sendInboundWorkerCanary({
    ALERT_STATE,
    RESEND_API_KEY: "test-key",
    SUBSCRIBE_ADDRESS: DEFAULT_SUBSCRIBE_ADDRESS,
  }, {
    now,
    token,
    fetchImpl: async () => ({ ok: true, json: async () => ({ id: "canary" }) }),
  });
  await recordInboundEmailReceipt({ ALERT_STATE }, {
    from: "alerts@cityscroll.org",
    to: DEFAULT_SUBSCRIBE_ADDRESS,
    headers: headers(`[cityscroll-mail-canary] ${token}`),
  }, new Date("2026-08-29T14:10:20Z"));
  const snapshot = await mailWatchdogSnapshot({ ALERT_STATE }, { now: new Date("2026-08-29T14:10:30Z") });
  assert.equal(snapshot.ok, true);
  assert.equal(snapshot.canary_state, "healthy");
  assert.equal(snapshot.canary_inbound.canary_token, token);
  assert.equal(ALERT_STATE.store.has(`ops:mail:canary:inbound:${token}`), true);
});

test("healthy mail watchdog GET does not email the operations mailbox", async () => {
  const ALERT_STATE = kv();
  const now = new Date("2026-08-29T14:10:30Z");
  const token = "0123456789abcdef0123456789abcdef";
  await sendInboundWorkerCanary({
    ALERT_STATE,
    RESEND_API_KEY: "rk",
  }, {
    now: new Date("2026-08-29T14:10:00Z"),
    token,
    fetchImpl: async () => ({ ok: true, json: async () => ({ id: "canary" }) }),
  });
  await recordInboundEmailReceipt({ ALERT_STATE }, {
    to: DEFAULT_SUBSCRIBE_ADDRESS,
    headers: headers(`[cityscroll-mail-canary] ${token}`),
  }, now);
  let sent = 0;
  const previous = globalThis.fetch;
  globalThis.fetch = async () => {
    sent += 1;
    return { ok: true, json: async () => ({ id: "should-not-send" }) };
  };
  try {
    const response = await handleAdminMailWatchdog(
      new Request("https://w/admin/reliability/mail?key=s3cr3t"),
      { ADMIN_KEY: "s3cr3t", ALERT_STATE, RESEND_API_KEY: "rk" },
      { now },
    );
    assert.equal(response.status, 200);
    assert.equal(sent, 0);
  } finally {
    globalThis.fetch = previous;
  }
});

test("stale canary GET exception-alerts the operations mailbox once", async () => {
  const ALERT_STATE = kv();
  const sentAt = new Date("2026-08-27T14:10:00Z");
  const now = new Date("2026-08-29T14:10:00Z");
  const token = "0123456789abcdef0123456789abcdef";
  await sendInboundWorkerCanary({
    ALERT_STATE,
    RESEND_API_KEY: "rk",
  }, {
    now: sentAt,
    token,
    fetchImpl: async () => ({ ok: true, json: async () => ({ id: "canary" }) }),
  });
  await recordInboundEmailReceipt({ ALERT_STATE }, {
    to: DEFAULT_SUBSCRIBE_ADDRESS,
    headers: headers(`[cityscroll-mail-canary] ${token}`),
  }, sentAt);
  const sent = [];
  const previous = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    sent.push(JSON.parse(options.body));
    return { ok: true, json: async () => ({ id: "exception" }) };
  };
  try {
    const first = await handleAdminMailWatchdog(
      new Request("https://w/admin/reliability/mail?key=s3cr3t"),
      { ADMIN_KEY: "s3cr3t", ALERT_STATE, RESEND_API_KEY: "rk", ALERTS_FROM: "CityScroll <alerts@cityscroll.org>" },
      { now },
    );
    const second = await handleAdminMailWatchdog(
      new Request("https://w/admin/reliability/mail?key=s3cr3t"),
      { ADMIN_KEY: "s3cr3t", ALERT_STATE, RESEND_API_KEY: "rk", ALERTS_FROM: "CityScroll <alerts@cityscroll.org>" },
      { now },
    );
    assert.equal(first.status, 503);
    assert.equal(second.status, 503);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].to, OPS_ALERT_TO);
    const body = await second.json();
    assert.match(body.findings.join("; "), /stale/);
    assert.equal(body.findings_history[0].delivery_status, "sent");
    assert.equal(body.findings_history[0].type, "canary-stale");
  } finally {
    globalThis.fetch = previous;
  }
});

test("rejected exception alert stays red without retrying the dead mail rail", async () => {
  const ALERT_STATE = kv();
  const now = new Date("2026-08-29T14:25:00Z");
  await sendInboundWorkerCanary({
    ALERT_STATE,
    RESEND_API_KEY: "rk",
  }, {
    now: new Date("2026-08-29T14:10:00Z"),
    token: "0123456789abcdef0123456789abcdef",
    fetchImpl: async () => ({ ok: true, json: async () => ({ id: "canary" }) }),
  });
  let sent = 0;
  const previous = globalThis.fetch;
  globalThis.fetch = async () => {
    sent += 1;
    return { ok: false, status: 500, text: async () => "resend-rejected", json: async () => ({}) };
  };
  try {
    const first = await handleAdminMailWatchdog(
      new Request("https://w/admin/reliability/mail?key=s3cr3t"),
      { ADMIN_KEY: "s3cr3t", ALERT_STATE, RESEND_API_KEY: "rk", ALERTS_FROM: "CityScroll <alerts@cityscroll.org>" },
      { now },
    );
    const second = await handleAdminMailWatchdog(
      new Request("https://w/admin/reliability/mail?key=s3cr3t"),
      { ADMIN_KEY: "s3cr3t", ALERT_STATE, RESEND_API_KEY: "rk", ALERTS_FROM: "CityScroll <alerts@cityscroll.org>" },
      { now },
    );
    assert.equal(first.status, 503);
    assert.equal(second.status, 503);
    assert.equal(sent, 1);
    const body = await second.json();
    assert.match(body.findings.join("; "), /not received|not accepted/);
    assert.ok(body.findings_history.some((row) => row.delivery_status === "rejected" || row.delivery_status === "http-fallback"));
  } finally {
    globalThis.fetch = previous;
  }
});

test("mail canary POST refuses a human operations target before send", async () => {
  const ALERT_STATE = kv();
  const sent = [];
  const previous = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    sent.push(JSON.parse(options.body));
    return { ok: true, json: async () => ({ id: "should-not-send" }) };
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
        SUBSCRIBE_ADDRESS: "james@cityscroll.org",
        ALERTS_FROM: "CityScroll <alerts@cityscroll.org>",
      },
      { now: new Date("2026-08-29T14:10:00Z"), fetchImpl: globalThis.fetch },
    );
    assert.equal(response.status, 503);
    const body = await response.json();
    assert.equal(body.inbound_worker.reason, "human-ops-mailbox-refused");
    assert.equal(sent.length, 1);
    assert.equal(sent[0].to, OPS_ALERT_TO);
    assert.equal(body.inbound_worker.envelope.to[0], "james@cityscroll.org");
  } finally {
    globalThis.fetch = previous;
  }
});
