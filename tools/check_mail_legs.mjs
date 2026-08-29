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
} = {}) {
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
  const lines = result.legs.map((leg) => {
    const verdict = leg.ok === true ? "pass" : leg.ok === false ? "fail" : "unprobed";
    return `${leg.id}: ${verdict} (${leg.status})`;
  });
  lines.unshift(result.ok ? "mail-legs: pass" : `mail-legs: fail (${result.findings.join("; ")})`);
  return `${lines.join("\n")}\n`;
}

async function main() {
  const live = hasFlag("--live");
  const fixturePath = arg("--fixture") || DEFAULT_FIXTURE;
  const result = await runMailLegCheck({
    mode: live ? "live" : "fixture",
    fixturePath,
    baseUrl: arg("--base-url") || DEFAULT_API_BASE,
  });
  process.stdout.write(reportLine(result));
  if (!result.ok) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error?.stack || error);
    process.exitCode = 1;
  });
}
