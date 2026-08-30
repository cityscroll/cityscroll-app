import { digestDayLogKey, sentWatchKeysFromDayLog } from "./lib/digest_ops.mjs";

export const DIGEST_SHADOW_LEDGER_PREFIX = "ops:digest:shadow:";
export const DIGEST_DELIVERY_LEDGER_PREFIX = "ops:digest:delivery:";
export const SCHEDULER_HEARTBEAT_KEY = "ops:scheduler:heartbeat";
export const MAIL_INBOUND_LATEST_KEY = "ops:mail:inbound:latest";
export const MAIL_OUTBOUND_LATEST_KEY = "ops:mail:outbound:latest";
export const MAIL_CANARY_LATEST_KEY = "ops:mail:canary:latest";
export const MAIL_CANARY_SUBJECT_PREFIX = "[cityscroll-mail-canary]";
export const MAIL_CANARY_PENDING_MS = 10 * 60 * 1000;
export const MAIL_CANARY_STALE_MS = 36 * 60 * 60 * 1000;
export const DEFAULT_SUBSCRIBE_ADDRESS = "subscribe@crol-list.org";
export const MAIL_FINDINGS_HISTORY_KEY = "ops:mail:findings:history";
export const MAIL_FINDINGS_HISTORY_LIMIT = 30;
export const MAIL_CANARY_TOKEN_PREFIX_LENGTH = 8;
export const HUMAN_OPS_MAILBOXES = Object.freeze([
  "team@cityscroll.org",
  "alerts@cityscroll.org",
]);

const day = (value) => new Date(value).toISOString().slice(0, 10);
const key = (prefix, value) => `${prefix}${day(value)}`;

async function readJson(kv, name) {
  if (!kv?.get) return null;
  try { return JSON.parse(await kv.get(name) || "null"); } catch { return null; }
}

async function putJson(kv, name, value) {
  if (!kv?.put) return false;
  await kv.put(name, JSON.stringify(value));
  return true;
}

export async function recordDigestShadowReceipt(env, summary, now = new Date()) {
  const receipt = {
    schema: "cityscroll.digest-shadow-ready-receipt.v1",
    day: day(now),
    observed_at: now.toISOString(),
    status: summary?.ok === true ? "READY" : "DEGRADED",
    redlines: Number(summary?.redlines?.length) || 0,
  };
  await putJson(env?.ALERT_STATE, key(DIGEST_SHADOW_LEDGER_PREFIX, now), receipt);
  return receipt;
}

export async function recordDigestDeliveryReceipt(env, receipt, now = new Date(), error = null) {
  const enqueued = Number(receipt?.enqueued) || 0;
  const result = {
    schema: "cityscroll.digest-terminal-delivery-receipt.v1",
    day: day(now),
    observed_at: now.toISOString(),
    status: error ? "FAILED" : (receipt?.skipped_reason === "queue_pending" ? "PENDING" : "TERMINAL"),
    accepted_sends: Number(receipt?.sent) || 0,
    enqueued,
    jobs_done: 0,
    skipped_reason: receipt?.skipped_reason || null,
    error: error ? String(error?.message || error) : null,
  };
  await putJson(env?.ALERT_STATE, key(DIGEST_DELIVERY_LEDGER_PREFIX, now), result);
  return result;
}

export async function recordDigestQueueOutcome(env, result, now = new Date()) {
  const name = key(DIGEST_DELIVERY_LEDGER_PREFIX, now);
  const current = await readJson(env?.ALERT_STATE, name) || {
    schema: "cityscroll.digest-terminal-delivery-receipt.v1",
    day: day(now), observed_at: now.toISOString(), status: "PENDING", accepted_sends: 0, enqueued: 0, jobs_done: 0,
  };
  current.jobs_done = (Number(current.jobs_done) || 0) + 1;
  current.accepted_sends = (Number(current.accepted_sends) || 0) + (result?.sent ? 1 : 0);
  if (current.enqueued === 0 || current.jobs_done >= current.enqueued) current.status = "TERMINAL";
  current.observed_at = now.toISOString();
  await putJson(env?.ALERT_STATE, name, current);
  return current;
}

export async function recordDigestQueueFailure(env, now = new Date()) {
  const name = `digest:dlq:${day(now)}`;
  const current = Number(await env?.ALERT_STATE?.get?.(name)) || 0;
  await env?.ALERT_STATE?.put?.(name, String(current + 1));
  return current + 1;
}

export async function recordSchedulerHeartbeat(env, heartbeat = {}, now = new Date()) {
  const result = {
    schema: "cityscroll.external-scheduler-heartbeat.v1",
    observed_at: now.toISOString(),
    pending_outbox: Number(heartbeat.pending_outbox) || 0,
    due_jobs: Array.isArray(heartbeat.due_jobs) ? heartbeat.due_jobs.slice(0, 30) : [],
    run_key: heartbeat.run_key || null,
  };
  await putJson(env?.ALERT_STATE, SCHEDULER_HEARTBEAT_KEY, result);
  return result;
}

function priorUtcDay(value) {
  const stamp = day(value);
  const ms = Date.parse(`${stamp}T00:00:00Z`);
  if (!Number.isFinite(ms)) return null;
  return new Date(ms - 86400000).toISOString().slice(0, 10);
}

/**
 * Consecutive deliveries that still report an older lastsent.
 * A delivery receipt for day N plus lastsent before day N-1 means two sends
 * shared a watermark. Missing receipts skip this check; other findings cover those.
 */
export function evaluateWatermarkStaleness({
  day: today,
  priorDay,
  delivery = null,
  lastsentByWatch = {},
  sentWatchKeysToday = [],
  sentWatchKeysYesterday = [],
} = {}) {
  const findings = [];
  const stuck = [];
  if (!today || !priorDay || !delivery) return { ok: true, findings, stuck };
  if (delivery.status === "FAILED") return { ok: true, findings, stuck };
  const accepted = Number(delivery.accepted_sends) || 0;
  if (accepted <= 0) return { ok: true, findings, stuck };

  const yesterday = new Set((sentWatchKeysYesterday || []).map(String));
  for (const key of sentWatchKeysToday || []) {
    if (!yesterday.has(String(key))) continue;
    const lastsent = lastsentByWatch?.[key];
    const stamp = lastsent == null || lastsent === "" ? "" : String(lastsent).slice(0, 10);
    if (!stamp || stamp < priorDay) {
      stuck.push({ lastsent: stamp || null });
    }
  }
  if (stuck.length) {
    const oldest = stuck.map((row) => row.lastsent).filter(Boolean).sort()[0] || "missing";
    findings.push(
      `${stuck.length} delivered watch watermark(s) stuck after consecutive sends (oldest ${oldest})`,
    );
  }
  return { ok: findings.length === 0, findings, stuck };
}

async function watermarkStalenessFromStore(env, today, priorDay, delivery) {
  const todayLog = await readJson(env?.ALERT_STATE, digestDayLogKey(today));
  const yesterdayLog = await readJson(env?.ALERT_STATE, digestDayLogKey(priorDay));
  const sentWatchKeysToday = sentWatchKeysFromDayLog(todayLog);
  const sentWatchKeysYesterday = sentWatchKeysFromDayLog(yesterdayLog);
  const lastsentByWatch = {};
  for (const key of sentWatchKeysToday) {
    if (!sentWatchKeysYesterday.includes(key)) continue;
    try { lastsentByWatch[key] = (await env?.ALERT_STATE?.get?.(`lastsent:${key}`)) || null; }
    catch { lastsentByWatch[key] = null; }
  }
  return evaluateWatermarkStaleness({
    day: today,
    priorDay,
    delivery,
    lastsentByWatch,
    sentWatchKeysToday,
    sentWatchKeysYesterday,
  });
}

export function mailCanaryInboundKey(token) {
  return `ops:mail:canary:inbound:${String(token || "").toLowerCase()}`;
}

export function mailCanaryTokenPrefix(token) {
  const hex = String(token || "").toLowerCase();
  if (!/^[0-9a-f]{32}$/.test(hex)) return null;
  return hex.slice(0, MAIL_CANARY_TOKEN_PREFIX_LENGTH);
}

export function mailCanaryTokenFromSubject(subject) {
  const text = String(subject || "");
  const index = text.indexOf(MAIL_CANARY_SUBJECT_PREFIX);
  if (index < 0) return null;
  const rest = text.slice(index + MAIL_CANARY_SUBJECT_PREFIX.length);
  const match = rest.match(/^\s*([0-9a-fA-F]{32})\b/);
  return match ? match[1].toLowerCase() : null;
}

export function normalizeMailbox(value) {
  return String(value || "").trim().toLowerCase();
}

export function isHumanOpsMailbox(value) {
  const address = normalizeMailbox(value);
  if (!address) return false;
  if (HUMAN_OPS_MAILBOXES.includes(address)) return true;
  const domain = DEFAULT_SUBSCRIBE_ADDRESS.split("@")[1];
  return Boolean(domain) && address === `alerts@${domain}`;
}

export function mailCanaryEnvelope(to, cc = []) {
  const recipients = Array.isArray(to) ? to : [to];
  const copies = Array.isArray(cc) ? cc : [cc];
  return {
    to: recipients.map(normalizeMailbox).filter(Boolean),
    cc: copies.map(normalizeMailbox).filter(Boolean),
  };
}

export function resolveMailCanaryTarget(env = {}) {
  const target = normalizeMailbox(env?.SUBSCRIBE_ADDRESS) || DEFAULT_SUBSCRIBE_ADDRESS;
  const envelope = mailCanaryEnvelope(target, []);
  if (isHumanOpsMailbox(target) || envelope.cc.some(isHumanOpsMailbox) || envelope.to.some(isHumanOpsMailbox)) {
    return { ok: false, target, envelope, reason: "human-ops-mailbox-refused" };
  }
  return { ok: true, target, envelope, reason: null };
}

export function mailFindingKind(text) {
  const value = String(text || "");
  if (/human operations mailbox/i.test(value)) return "human-target";
  if (/canary send was not accepted/i.test(value)) return "canary-send-rejected";
  if (/was not received/i.test(value)) return "canary-missing";
  if (/canary is stale/i.test(value)) return "canary-stale";
  if (/ops mailbox send was not accepted/i.test(value)) return "ops-send-rejected";
  return "mail-finding";
}

export function mailFindingShouldAlert(kind) {
  return kind !== "ops-send-rejected";
}

function envelopeTargetsHuman(envelope) {
  const to = Array.isArray(envelope?.to) ? envelope.to : [];
  const cc = Array.isArray(envelope?.cc) ? envelope.cc : [];
  return [...to, ...cc].some(isHumanOpsMailbox);
}

export function classifyMailCanaryState(state = {}, { now = new Date(), pendingMs = MAIL_CANARY_PENDING_MS, staleMs = MAIL_CANARY_STALE_MS } = {}) {
  const canary = state.canary || null;
  const inboundMatch = state.canary_inbound || null;
  if (!canary) return "unknown";
  const sentAt = Date.parse(canary.sent_at || "");
  const ageMs = Number.isFinite(sentAt) ? now.getTime() - sentAt : Number.POSITIVE_INFINITY;
  if (canary.resend_accepted === false || envelopeTargetsHuman(canary.envelope)) return "failed";
  if (!inboundMatch?.canary_token || inboundMatch.canary_token !== canary.token) {
    return ageMs > pendingMs ? "failed" : "pending";
  }
  if (Number.isFinite(sentAt) && ageMs > staleMs) return "stale";
  return "healthy";
}

function headerValue(headers, name) {
  if (!headers) return "";
  if (typeof headers.get === "function") {
    return headers.get(name) || headers.get(String(name).toLowerCase()) || headers.get(String(name).toUpperCase()) || "";
  }
  return headers[name] || headers[String(name).toLowerCase()] || "";
}

function newMailCanaryToken() {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function mailLegFindings(state = {}, { now = new Date(), pendingMs = MAIL_CANARY_PENDING_MS, staleMs = MAIL_CANARY_STALE_MS } = {}) {
  const findings = [];
  const outbound = state.outbound_ops || null;
  const canary = state.canary || null;
  const inboundMatch = state.canary_inbound || null;
  if (outbound && outbound.accepted === false) {
    findings.push("ops mailbox send was not accepted");
  }
  if (canary) {
    const sentAt = Date.parse(canary.sent_at || "");
    const ageMs = Number.isFinite(sentAt) ? now.getTime() - sentAt : Number.POSITIVE_INFINITY;
    if (envelopeTargetsHuman(canary.envelope) || canary.reason === "human-ops-mailbox-refused") {
      findings.push("inbound-worker canary targeted a human operations mailbox");
    } else if (canary.resend_accepted === false) {
      findings.push("inbound-worker canary send was not accepted");
    } else if (!inboundMatch?.canary_token || inboundMatch.canary_token !== canary.token) {
      if (ageMs > pendingMs) findings.push("inbound-worker canary was not received");
    } else if (Number.isFinite(sentAt) && ageMs > staleMs) {
      findings.push("inbound-worker canary is stale");
    }
  }
  return findings;
}

export function mailWatchdogHasMailFindings(findings = []) {
  return findings.some((item) => String(item).startsWith("mail: ") || /canary|ops mailbox send|mail-leg/i.test(item));
}

export async function recordInboundEmailReceipt(env, message, now = new Date()) {
  const subject = headerValue(message?.headers, "subject");
  const token = mailCanaryTokenFromSubject(subject);
  const receipt = {
    schema: "cityscroll.mail-inbound-receipt.v1",
    observed_at: now.toISOString(),
    to: String(message?.to || "").toLowerCase(),
    canary_token: token,
  };
  await putJson(env?.ALERT_STATE, MAIL_INBOUND_LATEST_KEY, receipt);
  if (token) await putJson(env?.ALERT_STATE, mailCanaryInboundKey(token), receipt);
  return receipt;
}

export async function recordOutboundOpsSendReceipt(env, result = {}, now = new Date()) {
  const receipt = {
    schema: "cityscroll.mail-outbound-ops-receipt.v1",
    observed_at: now.toISOString(),
    accepted: result.accepted === true,
    reason: result.reason || null,
    provider_id: result.provider?.id || null,
  };
  await putJson(env?.ALERT_STATE, MAIL_OUTBOUND_LATEST_KEY, receipt);
  return receipt;
}

export async function sendInboundWorkerCanary(env, { now = new Date(), token, fetchImpl = globalThis.fetch } = {}) {
  const canaryToken = token || newMailCanaryToken();
  const resolved = resolveMailCanaryTarget(env);
  const target = resolved.target;
  const envelope = resolved.envelope;
  const from = env?.ALERTS_FROM || "CityScroll <alerts@cityscroll.org>";
  let resendAccepted = false;
  let reason = resolved.ok ? null : resolved.reason;
  let providerId = null;
  if (!resolved.ok) {
    reason = resolved.reason;
  } else if (!env?.RESEND_API_KEY) {
    reason = "resend-not-configured";
  } else {
    const payload = {
      from,
      to: target,
      cc: [],
      subject: `${MAIL_CANARY_SUBJECT_PREFIX} ${canaryToken}`,
      text: "CityScroll mail-leg health probe. This message is not a watch request.",
    };
    const response = await fetchImpl("https://api.resend.com/emails", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${env.RESEND_API_KEY}` },
      body: JSON.stringify(payload),
    });
    resendAccepted = response.ok === true;
    reason = resendAccepted ? null : `resend-${response.status}`;
    if (resendAccepted && typeof response.json === "function") {
      try { providerId = (await response.json())?.id || null; } catch { providerId = null; }
    }
  }
  const receipt = {
    schema: "cityscroll.mail-canary.v1",
    token: canaryToken,
    token_prefix: mailCanaryTokenPrefix(canaryToken),
    sent_at: now.toISOString(),
    target,
    envelope,
    resend_accepted: resendAccepted,
    reason,
    provider_id: providerId,
  };
  await putJson(env?.ALERT_STATE, MAIL_CANARY_LATEST_KEY, receipt);
  return receipt;
}

export async function mailWatchdogSnapshot(env, { now = new Date(), pendingMs = MAIL_CANARY_PENDING_MS, staleMs = MAIL_CANARY_STALE_MS } = {}) {
  const canary = await readJson(env?.ALERT_STATE, MAIL_CANARY_LATEST_KEY);
  const inbound = await readJson(env?.ALERT_STATE, MAIL_INBOUND_LATEST_KEY);
  const outboundOps = await readJson(env?.ALERT_STATE, MAIL_OUTBOUND_LATEST_KEY);
  const history = await readJson(env?.ALERT_STATE, MAIL_FINDINGS_HISTORY_KEY);
  const canaryInbound = canary?.token ? await readJson(env?.ALERT_STATE, mailCanaryInboundKey(canary.token)) : null;
  const findings = mailLegFindings(
    { outbound_ops: outboundOps, canary, canary_inbound: canaryInbound },
    { now, pendingMs, staleMs },
  );
  const sentAt = Date.parse(canary?.sent_at || "");
  return {
    ok: findings.length === 0,
    findings,
    as_of: now.toISOString(),
    thresholds: { pending_ms: pendingMs, stale_ms: staleMs },
    canary_state: classifyMailCanaryState(
      { canary, canary_inbound: canaryInbound },
      { now, pendingMs, staleMs },
    ),
    canary_age_ms: Number.isFinite(sentAt) ? Math.max(0, now.getTime() - sentAt) : null,
    inbound,
    outbound_ops: outboundOps,
    canary,
    canary_inbound: canaryInbound,
    findings_history: Array.isArray(history?.items) ? history.items : [],
    gmail_forward: { status: "unprobed", reason: "dashboard-gated" },
  };
}

export async function digestWatchdogSnapshot(env, { now = new Date(), deadlineHour = 14 } = {}) {
  const today = day(now);
  const shadow = await readJson(env?.ALERT_STATE, `${DIGEST_SHADOW_LEDGER_PREFIX}${today}`);
  const delivery = await readJson(env?.ALERT_STATE, `${DIGEST_DELIVERY_LEDGER_PREFIX}${today}`);
  const dlq = Number(await env?.ALERT_STATE?.get?.(`digest:dlq:${today}`)) || 0;
  const mail = await mailWatchdogSnapshot(env, { now });
  const findings = [];
  let watermark = { ok: true, findings: [], stuck: [] };
  if (!shadow) findings.push("shadow READY receipt missing");
  else if (shadow.status !== "READY") findings.push(`shadow receipt is ${shadow.status}`);
  if (now.getUTCHours() >= deadlineHour) {
    if (!delivery) findings.push("terminal delivery receipt missing");
    else if (delivery.status !== "TERMINAL") findings.push(`delivery receipt is ${delivery.status}`);
    else if (delivery.enqueued > 0 && delivery.accepted_sends === 0) findings.push("enqueued digest has zero accepted sends");
    const priorDay = priorUtcDay(now);
    if (priorDay) {
      watermark = await watermarkStalenessFromStore(env, today, priorDay, delivery);
      findings.push(...watermark.findings);
    }
  }
  if (dlq > 0) findings.push(`digest DLQ is non-empty (${dlq})`);
  for (const item of mail.findings) findings.push(`mail: ${item}`);
  return {
    ok: findings.length === 0,
    day: today,
    findings,
    shadow,
    delivery,
    dlq,
    watermark_stuck: watermark.stuck?.length || 0,
    mail,
  };
}

export async function schedulerWatchdogSnapshot(env, { now = new Date(), maxAgeMs = 90 * 60 * 1000 } = {}) {
  const heartbeat = await readJson(env?.ALERT_STATE, SCHEDULER_HEARTBEAT_KEY);
  const mail = await mailWatchdogSnapshot(env, { now });
  const findings = [];
  const observed = Date.parse(heartbeat?.observed_at || "");
  if (!heartbeat || !Number.isFinite(observed)) findings.push("scheduler heartbeat missing");
  else if (now.getTime() - observed > maxAgeMs) findings.push("scheduler heartbeat expired");
  if (heartbeat?.pending_outbox > 0) findings.push(`scheduler outbox has ${heartbeat.pending_outbox} pending item(s)`);
  for (const item of mail.findings) findings.push(`mail: ${item}`);
  return { ok: findings.length === 0, findings, heartbeat, mail };
}

export async function emitOpsAlertOnce(env, { guard, fingerprint, subject, text, persistAttempt = false } = {}) {
  const alertKey = `ops:alert:${guard}:${fingerprint || new Date().toISOString().slice(0, 13)}`;
  if (await env?.ALERT_STATE?.get?.(alertKey)) return { sent: false, reason: "already-alerted" };
  const { sendOpsAlert } = await import("./alerts.mjs");
  let result;
  try {
    result = await sendOpsAlert(env, { guard, subject, text });
  } catch (error) {
    result = { accepted: false, reason: "resend-rejected", error: String(error?.message || error) };
  }
  if (result.accepted || persistAttempt) await env?.ALERT_STATE?.put?.(alertKey, new Date().toISOString());
  return { sent: !!result.accepted, result, reason: result.accepted ? null : (result.reason || "rejected") };
}

async function appendMailFindingsHistory(env, records, now = new Date()) {
  const rows = Array.isArray(records) ? records.filter(Boolean) : [];
  if (!rows.length) return [];
  const current = await readJson(env?.ALERT_STATE, MAIL_FINDINGS_HISTORY_KEY);
  const items = [...rows, ...(Array.isArray(current?.items) ? current.items : [])]
    .slice(0, MAIL_FINDINGS_HISTORY_LIMIT);
  await putJson(env?.ALERT_STATE, MAIL_FINDINGS_HISTORY_KEY, {
    schema: "cityscroll.mail-findings-history.v1",
    observed_at: now.toISOString(),
    items,
  });
  return items;
}

export async function emitMailExceptionAlerts(env, snapshot, { now = new Date() } = {}) {
  const findings = Array.isArray(snapshot?.findings) ? snapshot.findings : [];
  const records = [];
  for (const text of findings) {
    const kind = mailFindingKind(text);
    const fingerprint = `${kind}:${day(now)}`;
    let deliveryStatus = "http-fallback";
    let reason = "skipped-dead-rail";
    if (mailFindingShouldAlert(kind)) {
      const alert = await emitOpsAlertOnce(env, {
        guard: "mail-leg-exception",
        fingerprint,
        subject: `CityScroll mail-leg exception: ${kind}`,
        text,
        persistAttempt: true,
      });
      reason = alert.reason || (alert.sent ? null : "rejected");
      deliveryStatus = alert.sent ? "sent" : (alert.reason === "already-alerted" ? "deduped" : "rejected");
    }
    if (deliveryStatus === "deduped") continue;
    records.push({
      observed_at: now.toISOString(),
      type: kind,
      fingerprint,
      text,
      delivery_status: deliveryStatus,
      reason,
      source_receipt: MAIL_CANARY_LATEST_KEY,
    });
  }
  if (records.length) await appendMailFindingsHistory(env, records, now);
  return records;
}
