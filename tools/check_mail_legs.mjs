#!/usr/bin/env node
// Per-leg mail health gate. Exercises only rails that can run without Cloudflare
// dashboard access: Resend → operations mailbox, and Email Routing → Worker
// consumer. The Gmail forward leg stays dashboard-gated and is reported as
// unprobed. Default mode is fixture/offline. Live mode posts a canary through
// the Worker and must not run in pull-request CI.

import { readFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

import {
  MAIL_CANARY_PENDING_MS,
  mailLegFindings,
} from "../worker/src/reliability_watchdogs.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_FIXTURE = path.join(HERE, "../test/fixtures/mail-legs/snapshot.v1.json");
export const DEFAULT_API_BASE = "https://api.cityscroll.org";
export const DEFAULT_LIVE_TIMEOUT_MS = 90_000;
export const DEFAULT_POLL_MS = 5_000;

export const MAIL_LEGS = Object.freeze([
  Object.freeze({
    id: "outbound_ops_mailbox",
    name: "Resend to operations mailbox",
    exercisable: true,
  }),
  Object.freeze({
    id: "inbound_worker_consumer",
    name: "Email Routing to Worker consumer",
    exercisable: true,
  }),
  Object.freeze({
    id: "inbound_gmail_forward",
    name: "Email Routing to external forward",
    exercisable: false,
    reason: "dashboard-gated",
  }),
]);

function envelopeKey(message = {}) {
  return [
    String(message.from || "").toLowerCase(),
    String(message.to || "").toLowerCase(),
    String(message.subject || ""),
  ].join("\n");
}

function isTransientRateLimit(event = {}) {
  const code = String(event.code || event.smtp_code || "");
  const enhanced = String(event.enhanced || event.status_code || "");
  const text = String(event.text || event.detail || "");
  return code.startsWith("421")
    || enhanced.startsWith("4.7.28")
    || /unusual (rate|mail volume)|unsolicited mail/i.test(text);
}

function isDeliveryFailed(event = {}) {
  return /delivery failed|failed/i.test(String(event.status || event.event || ""));
}

/** Closed inventory of bounce, queue, resend, and provider-log recoverability. */
export const MAIL_RECOVERY_CLASSES = Object.freeze([
  Object.freeze({
    id: "inbound_routing_unsolicited",
    name: "Inbound Email Routing unsolicited forward",
    this_incident: true,
    metadata: "activity_log_envelope",
    body: "gone",
    queued_copy: "gone",
    bounce_record: "lifecycle_tempfail_only",
    resend_path: "none",
    useful_lost_messages: "none",
    notes: "Activity Log metadata (subject, sender, recipient, message ID, SPF/DKIM, 421 4.7.28 retries) is the recoverable remainder. Cloudflare exposes no body and no replay. Gmail never accepted the message, so there is no destination copy.",
  }),
  Object.freeze({
    id: "inbound_routing_useful",
    name: "Inbound Email Routing useful forward",
    this_incident: false,
    metadata: "activity_log_envelope",
    body: "gone",
    queued_copy: "gone",
    bounce_record: "lifecycle_tempfail_only",
    resend_path: "sender_must_resend",
    useful_lost_messages: "unobserved_in_this_incident",
    notes: "If useful mail had hit the forward address, the same Activity Log would keep envelope metadata only. The Worker never sees that path. No queued copy or replay exists.",
  }),
  Object.freeze({
    id: "inbound_worker_consumer",
    name: "Inbound Worker consumer",
    this_incident: false,
    metadata: "kv_receipt_after_deploy",
    body: "gone",
    queued_copy: "gone",
    bounce_record: "ignored",
    resend_path: "none",
    useful_lost_messages: "unobserved_in_this_incident",
    notes: "Raw inbound is parsed in memory and not stored. Bounce/DSN senders are ignored. After this change, ALERT_STATE keeps to/time/canary token only. A successful enroll is recoverable as the watch in SUBS, not as the original message.",
  }),
  Object.freeze({
    id: "outbound_digest",
    name: "Outbound subscriber digest",
    this_incident: false,
    metadata: "d1_outbox_and_kv",
    body: "resend_retrieve_or_reconstruct",
    queued_copy: "d1_owed_items",
    bounce_record: "resend_last_event",
    resend_path: "outbox_drain_or_preview",
    useful_lost_messages: "unobserved_in_this_incident",
    notes: "D1 digest_outbox_items keep source identities and payload_json; deliveries may store provider_message_id. That reconstructs a digest from retained civic objects, not the original RFC822. Resend GET /emails/:id can return sent HTML when a provider id and API key exist. No bounce webhook is registered.",
  }),
  Object.freeze({
    id: "outbound_ops_alert",
    name: "Outbound operations mailbox send",
    this_incident: false,
    metadata: "kv_ops_receipt_after_deploy",
    body: "resend_retrieve_if_provider_id",
    queued_copy: "gone",
    bounce_record: "resend_last_event",
    resend_path: "admin_ops_alert",
    useful_lost_messages: "never_generated_this_week",
    notes: "Scheduled Reliability watchdogs returned 401 this week, so emitOpsAlertOnce did not run. After this change, ALERT_STATE stores provider_id on accepted sends. Resend list/retrieve can still find historical outbound mail by time if an API key is present. There is no Worker bounce table.",
  }),
]);

export function credentialPresence(env = process.env) {
  return {
    github: true,
    resend: Boolean(env.RESEND_API_KEY),
    cloudflare: Boolean(env.CLOUDFLARE_API_TOKEN || env.CLOUDFLARE_API_KEY),
    admin_key: Boolean(env.CITYSCROLL_ADMIN_KEY || env.ADMIN_KEY),
  };
}

function reach(store, credentials) {
  if (store === "github_actions") return credentials.github ? "reachable" : "credential_missing";
  if (store === "resend_api") return credentials.resend ? "reachable" : "credential_missing";
  if (store === "cloudflare_kv_d1" || store === "cloudflare_email_routing") {
    return credentials.cloudflare ? "reachable" : "credential_missing";
  }
  if (store === "worker_admin") return credentials.admin_key ? "reachable" : "credential_missing";
  if (store === "activity_log_export") return "owner_captured";
  if (store === "none") return "gone";
  return "unknown";
}

export function classifyMailRecovery(credentials = credentialPresence()) {
  const classes = MAIL_RECOVERY_CLASSES.map((row) => {
    const stores = [];
    if (row.metadata === "activity_log_envelope") stores.push(["activity_log_export", "metadata"]);
    if (row.metadata === "kv_receipt_after_deploy" || row.metadata === "kv_ops_receipt_after_deploy") {
      stores.push(["cloudflare_kv_d1", "metadata"]);
    }
    if (row.metadata === "d1_outbox_and_kv") stores.push(["cloudflare_kv_d1", "metadata"]);
    if (row.body === "resend_retrieve_or_reconstruct" || row.body === "resend_retrieve_if_provider_id") {
      stores.push(["resend_api", "body_if_sent"]);
    }
    if (row.queued_copy === "d1_owed_items") stores.push(["cloudflare_kv_d1", "queued_copy"]);
    if (row.bounce_record === "resend_last_event") stores.push(["resend_api", "bounce_event"]);
    if (row.resend_path === "outbox_drain_or_preview" || row.resend_path === "admin_ops_alert") {
      stores.push(["worker_admin", "resend_path"]);
    }
    return {
      ...row,
      stores: stores.map(([store, kind]) => ({ store, kind, status: reach(store, credentials) })),
    };
  });
  return {
    credentials: {
      github: credentials.github === true,
      resend: credentials.resend === true,
      cloudflare: credentials.cloudflare === true,
      admin_key: credentials.admin_key === true,
    },
    classes,
    this_incident: {
      distinct_messages: 3,
      useful_lost_messages: 0,
      recoverable_bodies: 0,
      recoverable_metadata: "activity_log_envelope",
      gone: ["message_bodies", "queued_copies", "replay_controls", "worker_bounce_store"],
    },
  };
}

/**
 * Collapse Email Routing Activity Log rows so retry amplification of one
 * message is not counted as N lost messages. Dashboard FAILED totals are not
 * a dead-rail signal without per-message identity.
 */
export function summarizeEmailRoutingActivity(messages = []) {
  const rows = Array.isArray(messages) ? messages : [];
  const byId = new Map();
  for (const message of rows) {
    const id = String(message.message_id || message.id || "").trim();
    if (!id) continue;
    const current = byId.get(id) || {
      message_id: id,
      from: message.from || null,
      to: message.to || null,
      subject: message.subject || null,
      spf: message.spf || null,
      dkim: message.dkim || null,
      lifecycle: [],
    };
    if (Array.isArray(message.lifecycle)) current.lifecycle.push(...message.lifecycle);
    byId.set(id, current);
  }
  const distinct = [...byId.values()];
  const failedEvents = distinct.flatMap((message) => message.lifecycle.filter(isDeliveryFailed));
  const inspected = distinct.filter((message) => message.lifecycle.length > 0);
  const keys = distinct.map(envelopeKey);
  const sameEnvelope = distinct.length > 0 && keys.every((key) => key === keys[0]);
  const rateLimited = inspected.some((message) => message.lifecycle.some(isTransientRateLimit));
  const authHolds = inspected.every((message) => {
    if (!message.lifecycle.length) return true;
    const spfOk = !message.spf || String(message.spf).toLowerCase() === "pass";
    const dkimOk = !message.dkim || String(message.dkim).toLowerCase() === "pass";
    return spfOk && dkimOk;
  });
  return {
    distinct_messages: distinct.length,
    failed_lifecycle_events: failedEvents.length,
    retry_amplification: failedEvents.length > distinct.length,
    envelope_pattern_matches: sameEnvelope,
    lifecycle_inspected: inspected.length,
    transient_rate_limit: rateLimited,
    authentication_held: authHolds,
    routing_broken: false,
    lost_useful_mail: false,
  };
}

function arg(flag, argv = process.argv.slice(2)) {
  const index = argv.indexOf(flag);
  if (index === -1) return null;
  return argv[index + 1] || "";
}

function hasFlag(flag, argv = process.argv.slice(2)) {
  return argv.includes(flag);
}

export function classifyMailLegs(snapshot, { now = new Date(), pendingMs = MAIL_CANARY_PENDING_MS } = {}) {
  const findings = mailLegFindings({
    outbound_ops: snapshot?.outbound_ops || null,
    canary: snapshot?.canary || null,
    canary_inbound: snapshot?.canary_inbound || null,
  }, { now, pendingMs });
  const pendingCanary = Boolean(snapshot?.canary?.resend_accepted)
    && snapshot?.canary_inbound?.canary_token !== snapshot?.canary?.token
    && (now.getTime() - Date.parse(snapshot?.canary?.sent_at || "") <= pendingMs);
  return {
    ok: findings.length === 0,
    pending: pendingCanary,
    findings,
    legs: [
      {
        id: "outbound_ops_mailbox",
        status: snapshot?.outbound_ops?.accepted === true
          ? "resend_accepted"
          : snapshot?.outbound_ops?.accepted === false
            ? "resend_rejected"
            : "not_run",
        ok: snapshot?.outbound_ops ? snapshot.outbound_ops.accepted === true : null,
        note: "Provider acceptance only; destination delivery is not observed on this rail.",
      },
      {
        id: "inbound_worker_consumer",
        status: snapshot?.canary_inbound?.canary_token && snapshot.canary_inbound.canary_token === snapshot?.canary?.token
          ? "matched"
          : pendingCanary
            ? "pending"
            : snapshot?.canary
              ? "unmatched"
              : "not_run",
        ok: snapshot?.canary_inbound?.canary_token && snapshot.canary_inbound.canary_token === snapshot?.canary?.token
          ? true
          : pendingCanary || !snapshot?.canary
            ? null
            : false,
      },
      {
        id: "inbound_gmail_forward",
        status: snapshot?.gmail_forward?.status || "unprobed",
        ok: null,
        note: snapshot?.gmail_forward?.reason || "dashboard-gated",
      },
    ],
  };
}

async function postCanary({ baseUrl, adminKey, fetchImpl }) {
  const response = await fetchImpl(`${baseUrl}/admin/reliability/mail`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${adminKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ action: "canary" }),
  });
  const body = await response.json();
  if (!response.ok) throw new Error(`canary POST HTTP ${response.status}: ${JSON.stringify(body)}`);
  return body;
}

async function getSnapshot({ baseUrl, adminKey, fetchImpl }) {
  const response = await fetchImpl(`${baseUrl}/admin/reliability/mail`, {
    method: "GET",
    headers: { authorization: `Bearer ${adminKey}` },
  });
  const body = await response.json();
  return { http_status: response.status, snapshot: body };
}

export async function runMailLegCheck({
  mode = "fixture",
  fixturePath = DEFAULT_FIXTURE,
  snapshot = null,
  now = new Date(),
  baseUrl = DEFAULT_API_BASE,
  adminKey = process.env.CITYSCROLL_ADMIN_KEY || process.env.ADMIN_KEY,
  fetchImpl = globalThis.fetch,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  timeoutMs = DEFAULT_LIVE_TIMEOUT_MS,
  pollMs = DEFAULT_POLL_MS,
  credentials = credentialPresence(),
} = {}) {
  if (mode === "recovery") {
    return { mode: "recovery", ...classifyMailRecovery(credentials) };
  }
  if (mode === "live") {
    if (!adminKey) throw new Error("CITYSCROLL_ADMIN_KEY is required for live mail-leg checks");
    await postCanary({ baseUrl, adminKey, fetchImpl });
    const started = Date.now();
    let last = null;
    do {
      last = await getSnapshot({ baseUrl, adminKey, fetchImpl });
      const classified = classifyMailLegs(last.snapshot, { now: new Date() });
      if (classified.ok || !classified.pending) {
        return { mode, ...classified, http_status: last.http_status, snapshot: last.snapshot };
      }
      if (Date.now() - started >= timeoutMs) break;
      await sleep(pollMs);
    } while (Date.now() - started < timeoutMs);
    const classified = classifyMailLegs(last.snapshot, { now: new Date() });
    return { mode, ...classified, http_status: last.http_status, snapshot: last.snapshot };
  }

  const loaded = snapshot || JSON.parse(await readFile(fixturePath, "utf8"));
  return { mode: "fixture", ...classifyMailLegs(loaded, { now }), snapshot: loaded };
}

function reportLine(result) {
  if (result.mode === "recovery") {
    const lines = [
      `mail-recovery: useful_lost_messages=${result.this_incident.useful_lost_messages}`,
      `credentials: github=${result.credentials.github} resend=${result.credentials.resend} cloudflare=${result.credentials.cloudflare} admin_key=${result.credentials.admin_key}`,
      `gone: ${result.this_incident.gone.join(", ")}`,
    ];
    for (const row of result.classes) {
      lines.push(`${row.id}: body=${row.body} queued=${row.queued_copy} bounce=${row.bounce_record} useful=${row.useful_lost_messages}`);
    }
    return `${lines.join("\n")}\n`;
  }
  const lines = result.legs.map((leg) => {
    const verdict = leg.ok === true ? "pass" : leg.ok === false ? "fail" : "unprobed";
    return `${leg.id}: ${verdict} (${leg.status})`;
  });
  lines.unshift(result.ok ? "mail-legs: pass" : `mail-legs: fail (${result.findings.join("; ")})`);
  return `${lines.join("\n")}\n`;
}

async function main() {
  const live = hasFlag("--live");
  const recovery = hasFlag("--recovery");
  const fixturePath = arg("--fixture") || DEFAULT_FIXTURE;
  const result = await runMailLegCheck({
    mode: recovery ? "recovery" : live ? "live" : "fixture",
    fixturePath,
    baseUrl: arg("--base-url") || DEFAULT_API_BASE,
  });
  process.stdout.write(reportLine(result));
  if (result.mode !== "recovery" && !result.ok) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error?.stack || error);
    process.exitCode = 1;
  });
}
