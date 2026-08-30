import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import {
  MAIL_LEGS,
  MAIL_RECOVERY_CLASSES,
  classifyMailLegs,
  classifyMailRecovery,
  runMailLegCheck,
  summarizeEmailRoutingActivity,
} from "../tools/check_mail_legs.mjs";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const FIXTURE = path.join(ROOT, "test/fixtures/mail-legs/snapshot.v1.json");
const NOW = new Date("2026-08-29T14:10:30.000Z");

test("mail-leg catalog keeps the Gmail forward dashboard-gated", () => {
  assert.deepEqual(MAIL_LEGS.map((leg) => leg.id), [
    "outbound_ops_mailbox",
    "inbound_worker_consumer",
    "inbound_gmail_forward",
  ]);
  const gmail = MAIL_LEGS.find((leg) => leg.id === "inbound_gmail_forward");
  assert.equal(gmail.exercisable, false);
  assert.equal(gmail.reason, "dashboard-gated");
});

test("fixture snapshot classifies outbound and worker-consumer as passing", async () => {
  const result = await runMailLegCheck({ mode: "fixture", fixturePath: FIXTURE, now: NOW });
  assert.equal(result.ok, true);
  assert.deepEqual(result.findings, []);
  const byId = Object.fromEntries(result.legs.map((leg) => [leg.id, leg]));
  assert.equal(byId.outbound_ops_mailbox.status, "resend_accepted");
  assert.equal(byId.outbound_ops_mailbox.ok, true);
  assert.equal(byId.inbound_worker_consumer.status, "matched");
  assert.equal(byId.inbound_worker_consumer.ok, true);
  assert.equal(byId.inbound_gmail_forward.status, "unprobed");
  assert.equal(byId.inbound_gmail_forward.ok, null);
});

test("unmatched canary after the pending window fails the worker-consumer leg", () => {
  const snapshot = JSON.parse(readFileSync(FIXTURE, "utf8"));
  snapshot.canary_inbound = null;
  const result = classifyMailLegs(snapshot, { now: new Date("2026-08-29T14:25:00.000Z") });
  assert.equal(result.ok, false);
  assert.match(result.findings.join("; "), /inbound-worker canary was not received/);
  const worker = result.legs.find((leg) => leg.id === "inbound_worker_consumer");
  assert.equal(worker.status, "unmatched");
  assert.equal(worker.ok, false);
});

test("rejected operations send fails the outbound mailbox leg", () => {
  const snapshot = JSON.parse(readFileSync(FIXTURE, "utf8"));
  snapshot.outbound_ops.accepted = false;
  snapshot.outbound_ops.reason = "resend-rejected";
  const result = classifyMailLegs(snapshot, { now: NOW });
  assert.equal(result.ok, false);
  assert.match(result.findings.join("; "), /ops mailbox send was not accepted/);
  const outbound = result.legs.find((leg) => leg.id === "outbound_ops_mailbox");
  assert.equal(outbound.status, "resend_rejected");
  assert.equal(outbound.ok, false);
});

test("live mode requires an operator key and does not default-send", async () => {
  await assert.rejects(
    () => runMailLegCheck({ mode: "live", adminKey: "", fetchImpl: async () => { throw new Error("network"); } }),
    /CITYSCROLL_ADMIN_KEY is required/,
  );
});

test("recovery inventory lists this incident's bodies as gone and useful lost mail as none", async () => {
  const result = await runMailLegCheck({
    mode: "recovery",
    credentials: { github: true, resend: false, cloudflare: false, admin_key: false },
  });
  assert.equal(result.this_incident.useful_lost_messages, 0);
  assert.equal(result.this_incident.recoverable_bodies, 0);
  assert.ok(result.this_incident.gone.includes("message_bodies"));
  assert.ok(result.this_incident.gone.includes("queued_copies"));
  assert.ok(result.this_incident.gone.includes("worker_bounce_store"));
  const unsolicited = result.classes.find((row) => row.id === "inbound_routing_unsolicited");
  assert.equal(unsolicited.body, "gone");
  assert.equal(unsolicited.queued_copy, "gone");
  assert.equal(unsolicited.resend_path, "none");
  assert.equal(unsolicited.useful_lost_messages, "none");
  assert.equal(result.credentials.resend, false);
  assert.equal(result.credentials.cloudflare, false);
  const digest = result.classes.find((row) => row.id === "outbound_digest");
  assert.equal(digest.stores.find((store) => store.store === "resend_api").status, "credential_missing");
  assert.deepEqual(MAIL_RECOVERY_CLASSES.map((row) => row.id), result.classes.map((row) => row.id));
});

test("Resend retrieve becomes reachable only when that credential is present", () => {
  const withKey = classifyMailRecovery({ github: true, resend: true, cloudflare: false, admin_key: false });
  const digest = withKey.classes.find((row) => row.id === "outbound_digest");
  assert.equal(digest.stores.find((store) => store.store === "resend_api").status, "reachable");
});

test("public data-health renderer does not carry mail-canary ops state", () => {
  const page = readFileSync(path.join(ROOT, "site/data_health_page.mjs"), "utf8");
  assert.doesNotMatch(page, /cityscroll-mail-canary/);
  assert.doesNotMatch(page, /ops:mail:canary/);
  assert.doesNotMatch(page, /findings_history/);
  assert.doesNotMatch(page, /SUBSCRIBE_ADDRESS/);
});

test("Email Routing FAILED counts collapse retries of one spam envelope", () => {
  const envelope = {
    from: "searchregisgter@aireg.pro",
    to: "alerts@example.test",
    subject: "Submit cityscroll.org to Search Engines",
    spf: "pass",
    dkim: "pass",
  };
  const retry = { status: "Delivery failed", code: "421", enhanced: "4.7.28", text: "unusual mail volume from DKIM domain" };
  const summary = summarizeEmailRoutingActivity([
    { message_id: "msg-1", ...envelope, lifecycle: Array(15).fill(retry) },
    { message_id: "msg-2", ...envelope, lifecycle: [] },
    { message_id: "msg-3", ...envelope, lifecycle: [] },
  ]);
  assert.equal(summary.distinct_messages, 3);
  assert.equal(summary.failed_lifecycle_events, 15);
  assert.equal(summary.retry_amplification, true);
  assert.equal(summary.envelope_pattern_matches, true);
  assert.equal(summary.lifecycle_inspected, 1);
  assert.equal(summary.transient_rate_limit, true);
  assert.equal(summary.authentication_held, true);
  assert.equal(summary.routing_broken, false);
  assert.equal(summary.lost_useful_mail, false);
});
