import assert from "node:assert/strict";
import test from "node:test";
import {
  digestWatchdogSnapshot,
  evaluateWatermarkStaleness,
  mailWatchdogHasMailFindings,
  mailWatchdogSnapshot,
  recordDigestDeliveryReceipt,
  recordDigestShadowReceipt,
  digestShadowFinding,
  recordInboundEmailReceipt,
  recordOutboundOpsSendReceipt,
  recordSchedulerHeartbeat,
  recordDeskPublicationHeartbeat,
  canonicalOpsFailureSignature,
  emitOpsAlertOnce,
  schedulerWatchdogSnapshot,
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

const PUBLICATION = Object.freeze({
  workflow: "Deploy Cloudflare Pages",
  run_id: "33968898164",
  source_revision: "dd4b708b6fe39bf8b2ea635ef3d4f493c4751ace",
  result: "succeeded",
  destination: "https://desk.cityscroll.org/data-sources",
  evidence_revision: "rev-current",
});

test("scheduler watchdog stays quiet for a recent empty-outbox heartbeat", async () => {
  const ALERT_STATE = kv();
  const now = new Date("2026-08-25T14:00:00Z");
  const write = await recordSchedulerHeartbeat({ ALERT_STATE }, { ...CYCLE, pending_outbox: 0 }, new Date("2026-08-25T13:30:00Z"));
  assert.equal(write.accepted, true);
  assert.equal((await recordDeskPublicationHeartbeat({ ALERT_STATE }, PUBLICATION, new Date("2026-08-25T10:15:00Z"))).accepted, true);
  const result = await schedulerWatchdogSnapshot({ ALERT_STATE }, { now });
  assert.equal(result.ok, true);
  assert.equal(result.scheduler_ok, true);
  assert.equal(result.publication_ok, true);
  assert.equal(result.heartbeat.workflow, CYCLE.workflow);
  assert.equal(result.heartbeat.run_id, CYCLE.run_id);
});

test("desk publication watchdog names frozen-publication and keeps last success after a rejected write", async () => {
  const ALERT_STATE = kv();
  const written = await recordDeskPublicationHeartbeat({ ALERT_STATE }, PUBLICATION, new Date("2026-08-07T15:11:15Z"));
  assert.equal(written.accepted, true);
  const rejected = await recordDeskPublicationHeartbeat({ ALERT_STATE }, { run_id: "generic" }, new Date("2026-09-06T12:00:00Z"));
  assert.equal(rejected.accepted, false);
  const now = new Date("2026-09-06T12:00:00Z");
  const result = await schedulerWatchdogSnapshot({ ALERT_STATE }, { now });
  assert.equal(result.publication_ok, false);
  assert.equal(result.failing_stage, "missing-trigger");
  assert.match(result.publication_findings.join("; "), /missed|missing/);
  assert.equal(result.publication_heartbeat.last_successful_publication_at, "2026-08-07T15:11:15.000Z");
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

test("a pending outbox with no usable delivery identity names the variable to repair", async () => {
  // A cycle without a usable delivery token used to report the same pending
  // count as a cycle whose delivery failed, so the configuration gap read as a
  // flaky API. The reason travels with it, redacted to a variable and a class.
  const ALERT_STATE = kv();
  const now = new Date("2026-08-25T13:35:00Z");
  const write = await recordSchedulerHeartbeat(
    { ALERT_STATE },
    { ...CYCLE, pending_outbox: 2, outbox_delivery: "offline", outbox_delivery_reason: "GH_TOKEN_FILE:insecure-permissions" },
    new Date("2026-08-25T13:30:00Z"),
  );
  assert.equal(write.heartbeat.outbox_delivery, "offline");
  assert.equal(write.heartbeat.outbox_delivery_reason, "GH_TOKEN_FILE:insecure-permissions");
  const result = await schedulerWatchdogSnapshot({ ALERT_STATE }, { now });
  assert.match(
    result.findings.join("; "),
    /2 pending item\(s\) and delivery is offline for lack of a usable token \(GH_TOKEN_FILE:insecure-permissions\)/,
  );
});

test("the heartbeat records that a credential was loaded, never that delivery works", async () => {
  // "credentialed" is the strongest claim a cycle may make from configuration
  // alone: whether the identity is the intended account, and whether GitHub
  // accepts it, is only ever proven by a delivery attempt.
  const ALERT_STATE = kv();
  const credentialed = await recordSchedulerHeartbeat(
    { ALERT_STATE },
    { ...CYCLE, outbox_delivery: "credentialed" },
    new Date("2026-08-25T13:30:00Z"),
  );
  assert.equal(credentialed.heartbeat.outbox_delivery, "credentialed");
  assert.equal(credentialed.heartbeat.outbox_delivery_reason, null);
  // A cycle that claims anything else is recorded as having claimed nothing.
  for (const claim of ["online", "operational", "installed", true, 1]) {
    const write = await recordSchedulerHeartbeat(
      { ALERT_STATE },
      { ...CYCLE, outbox_delivery: claim },
      new Date("2026-08-25T13:30:00Z"),
    );
    assert.equal(write.heartbeat.outbox_delivery, null, `${claim} was accepted as a delivery state`);
  }
});

test("the heartbeat distinguishes the two delivery identities and records the token expiry", async () => {
  // Both identities report "credentialed" when they load, so the kind is the
  // only thing that says which authority a cycle actually wrote under. The
  // expiry is what shows an App cycle still refreshing rather than riding a
  // token it minted an hour ago.
  const ALERT_STATE = kv();
  const app = await recordSchedulerHeartbeat(
    { ALERT_STATE },
    {
      ...CYCLE,
      outbox_delivery: "credentialed",
      outbox_delivery_identity: "app",
      outbox_delivery_token_expires_at: "2026-08-25T14:30:00.000Z",
    },
    new Date("2026-08-25T13:30:00Z"),
  );
  assert.equal(app.heartbeat.outbox_delivery_identity, "app");
  assert.equal(app.heartbeat.outbox_delivery_token_expires_at, "2026-08-25T14:30:00.000Z");

  const file = await recordSchedulerHeartbeat(
    { ALERT_STATE },
    { ...CYCLE, outbox_delivery: "credentialed", outbox_delivery_identity: "file" },
    new Date("2026-08-25T13:30:00Z"),
  );
  assert.equal(file.heartbeat.outbox_delivery_identity, "file");
  assert.equal(file.heartbeat.outbox_delivery_token_expires_at, null);

  // An identity the endpoint does not recognize is recorded as none claimed,
  // the same way an unrecognized delivery state is.
  for (const claim of ["machine-user", "installed", true, 1]) {
    const write = await recordSchedulerHeartbeat(
      { ALERT_STATE },
      { ...CYCLE, outbox_delivery: "credentialed", outbox_delivery_identity: claim },
      new Date("2026-08-25T13:30:00Z"),
    );
    assert.equal(write.heartbeat.outbox_delivery_identity, null, `${claim} was accepted as a delivery identity`);
  }
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

test("retired inbound canaries never fail mail health or send alerts", async () => {
  for (const canary of [null, { token: "old", sent_at: "2026-01-01", resend_accepted: true }, { resend_accepted: false }]) {
    const ALERT_STATE = kv({ "ops:mail:canary:latest": JSON.stringify(canary) });
    const previous = globalThis.fetch;
    globalThis.fetch = async () => { assert.fail("retired canary must not send"); };
    try {
      const response = await handleAdminMailWatchdog(
        new Request("https://w/admin/reliability/mail?key=secret"),
        { ADMIN_KEY: "secret", ALERT_STATE, RESEND_API_KEY: "test-key" },
      );
      assert.equal(response.status, 200);
      const snapshot = await response.json();
      assert.equal(snapshot.inbound_status, "retired");
      assert.deepEqual(snapshot.findings, []);
      assert.equal(snapshot.canary, undefined);
    } finally { globalThis.fetch = previous; }
  }
});

test("mail watchdog no longer accepts canary POST and retains authentication", async () => {
  const env = { ADMIN_KEY: "secret", ALERT_STATE: kv() };
  const response = await handleAdminMailWatchdog(new Request("https://w/admin/reliability/mail?key=secret", {
    method: "POST", body: JSON.stringify({ action: "canary" }),
  }), env);
  assert.equal(response.status, 405);
  const unauthenticated = await handleAdminMailWatchdog(new Request("https://w/admin/reliability/mail"), env);
  assert.equal(unauthenticated.status, 401);
});

test("residual inbound receipt keeps destination and time without subject or body", async () => {
  const ALERT_STATE = kv();
  const now = new Date("2026-09-08T12:00:00Z");
  await recordInboundEmailReceipt({ ALERT_STATE }, {
    to: "subscribe@example.org",
    get headers() { assert.fail("retired receipt must not parse headers"); },
    get raw() { assert.fail("retired receipt must not parse body"); },
  }, now);
  assert.deepEqual((await mailWatchdogSnapshot({ ALERT_STATE }, { now })).inbound, {
    schema: "cityscroll.mail-inbound-receipt.v1", observed_at: now.toISOString(),
    to: "subscribe@example.org", disposition: "retired",
  });
  assert.equal(ALERT_STATE.store.size, 1);
});
