import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import {
  MAIL_LEGS,
  classifyMailLegs,
  runMailLegCheck,
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
