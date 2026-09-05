import { digestDayLogKey, sentWatchKeysFromDayLog } from "./lib/digest_ops.mjs";
import {
  REPAIR_QUEUE_EXCLUDED_GUARDS,
  completeRepairItem,
  leaseRepairItems,
  reconcileRepairQueue,
  repairQueueSentence,
  upsertRepairItem,
} from "./lib/repair_queue.mjs";

export const DIGEST_SHADOW_LEDGER_PREFIX = "ops:digest:shadow:";
// Bounded so one pathological rehearsal cannot grow the receipt without limit.
export const DIGEST_SHADOW_REASON_CODE_LIMIT = 3;
export const DIGEST_DELIVERY_LEDGER_PREFIX = "ops:digest:delivery:";
export const SCHEDULER_HEARTBEAT_KEY = "ops:scheduler:heartbeat";
// How long a heartbeat stands before the watchdog calls the scheduler dead.
// The trigger that runs the cycle has to publish well inside this window, so
// the producer's interval is checked against this number rather than a copy.
export const SCHEDULER_HEARTBEAT_MAX_AGE_MS = 90 * 60 * 1000;
export const SCHEDULER_HEARTBEAT_SCHEMA = "cityscroll.external-scheduler-heartbeat.v1";
// The scheduled cycle proves itself by naming these fields; the store stamps
// observed_at on acceptance. Liveness is a property of the run that wrote the
// receipt, never of a downstream digest or shadow rehearsal.
export const SCHEDULER_HEARTBEAT_EVIDENCE_FIELDS = Object.freeze([
  "workflow", "run_id", "source_revision", "result",
]);
export const SCHEDULER_HEARTBEAT_RESULTS = Object.freeze(["succeeded", "degraded", "failed"]);
const GENERIC_EVIDENCE = new Set(["", "null", "none", "unknown", "n/a", "na", "-", "scheduler", "workflow"]);
export const MAIL_INBOUND_LATEST_KEY = "ops:mail:inbound:latest";
export const MAIL_OUTBOUND_LATEST_KEY = "ops:mail:outbound:latest";
export const MAIL_CANARY_LATEST_KEY = "ops:mail:canary:latest";
export const MAIL_CANARY_SUBJECT_PREFIX = "[cityscroll-mail-canary]";
export const MAIL_CANARY_PENDING_MS = 10 * 60 * 1000;
export const MAIL_CANARY_STALE_MS = 36 * 60 * 60 * 1000;
export const DEFAULT_SUBSCRIBE_ADDRESS = "subscribe@crol-list.org";
export const MAIL_FINDINGS_HISTORY_KEY = "ops:mail:findings:history";
export const MAIL_FINDINGS_HISTORY_LIMIT = 30;
export const OPS_ALERT_HISTORY_KEY = "ops:alert:history:v1";
export const OPS_ALERT_HISTORY_LIMIT = 50;
export const MAIL_CANARY_TOKEN_PREFIX_LENGTH = 8;
export const HUMAN_OPS_MAILBOXES = Object.freeze([
  "james@cityscroll.org",
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

/**
 * A DEGRADED receipt that records only a redline count sends the reader back to
 * a rehearsal that may already have been rerun, so the receipt carries its own
 * reason. Codes and prose are the stable half of a redline; the day's counts
 * are kept out of the reason so an alert signature does not change daily.
 */
export async function recordDigestShadowReceipt(env, summary, now = new Date()) {
  const redlines = Array.isArray(summary?.redlines) ? summary.redlines : [];
  const codes = [...new Set(redlines.map((item) => trimmed(item?.code, 60)).filter(Boolean))];
  const receipt = {
    schema: "cityscroll.digest-shadow-ready-receipt.v1",
    day: day(now),
    observed_at: now.toISOString(),
    status: summary?.ok === true ? "READY" : "DEGRADED",
    redlines: redlines.length,
    redline_codes: codes.slice(0, DIGEST_SHADOW_REASON_CODE_LIMIT),
    reason: trimmed(redlines[0]?.reason, 200) || null,
    // A rehearsal that built nothing is indistinguishable from a healthy quiet
    // day in a count of redlines alone, so the build shape is recorded too.
    digest_count: Number(summary?.digest_count) || 0,
    evaluated_count: Number(summary?.evaluated_count) || 0,
    total_items: Number(summary?.total_items) || 0,
    // The narrowing step the candidates did not survive, so an operator reading the
    // reliability snapshot alone can tell an empty source from an exhausted watermark.
    // A stage name is a bounded label, not a daily count, so it stays alert-signature safe.
    collapse_stage: summary?.collapse_stage || null,
    selection_funnel: summary?.selection_funnel || null,
  };
  await putJson(env?.ALERT_STATE, key(DIGEST_SHADOW_LEDGER_PREFIX, now), receipt);
  return receipt;
}

/**
 * The watchdog finding for a shadow receipt that is not READY. It names the
 * fault, and deliberately carries no counts or timestamps: the finding text is
 * the alert's dedupe signature, so a varying number would re-alert every day.
 */
export function digestShadowFinding(shadow) {
  const base = `shadow receipt is ${shadow?.status}`;
  const codes = Array.isArray(shadow?.redline_codes)
    ? shadow.redline_codes.map((code) => trimmed(code, 60)).filter(Boolean)
    : [];
  const reason = trimmed(shadow?.reason, 200);
  // The collapsing selection stage is one of a small closed set of names, so it
  // qualifies the fault the way a code does without making the text vary daily.
  const stage = trimmed(shadow?.collapse_stage, 60);
  if (!codes.length && !reason && !stage) return base;
  const parts = [];
  if (codes.length) parts.push(codes.join(", "));
  if (stage) parts.push(`selection collapsed at ${stage}`);
  const label = parts.join("; ");
  return `${base} (${label && reason ? `${label}: ${reason}` : label || reason})`;
}

/**
 * Zero accepted sends is a symptom shared by a broken delivery leg and a
 * legitimately quiet day. The receipt already records which one, so the finding
 * names it rather than leaving the reader to guess between the two.
 */
export function digestZeroAcceptedSendsFinding(delivery) {
  const reason = trimmed(delivery?.skipped_reason, 60);
  return `enqueued digest has zero accepted sends (${reason || "no skip reason recorded"})`;
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

function trimmed(value, limit = 200) {
  const text = typeof value === "string" ? value.trim() : "";
  return text ? text.slice(0, limit) : "";
}

/**
 * A heartbeat only proves liveness when it names the cycle that wrote it.
 * Anything absent, blank, or generic is rejected rather than stored, so a
 * completed scheduled job can never leave an unattributable receipt behind.
 */
export function schedulerHeartbeatEvidenceFindings(heartbeat = {}) {
  const findings = [];
  for (const field of SCHEDULER_HEARTBEAT_EVIDENCE_FIELDS) {
    if (!trimmed(heartbeat?.[field])) findings.push(`heartbeat evidence field ${field} is missing`);
  }
  const workflow = trimmed(heartbeat?.workflow);
  if (workflow && GENERIC_EVIDENCE.has(workflow.toLowerCase())) {
    findings.push("heartbeat evidence field workflow is generic");
  }
  const runId = trimmed(heartbeat?.run_id);
  if (runId && GENERIC_EVIDENCE.has(runId.toLowerCase())) {
    findings.push("heartbeat evidence field run_id is generic");
  }
  const revision = trimmed(heartbeat?.source_revision);
  if (revision && !/^[0-9a-f]{7,40}$/i.test(revision)) {
    findings.push("heartbeat evidence field source_revision is not a source revision");
  }
  const result = trimmed(heartbeat?.result);
  if (result && !SCHEDULER_HEARTBEAT_RESULTS.includes(result)) {
    findings.push(`heartbeat result ${result} is not a recognized cycle result`);
  }
  return findings;
}

export async function recordSchedulerHeartbeat(env, heartbeat = {}, now = new Date()) {
  const rejected = schedulerHeartbeatEvidenceFindings(heartbeat);
  if (rejected.length) return { accepted: false, rejected, heartbeat: null };
  const result = {
    schema: SCHEDULER_HEARTBEAT_SCHEMA,
    workflow: trimmed(heartbeat.workflow),
    run_id: trimmed(heartbeat.run_id),
    source_revision: trimmed(heartbeat.source_revision).toLowerCase(),
    result: trimmed(heartbeat.result),
    observed_at: now.toISOString(),
    pending_outbox: Number(heartbeat.pending_outbox) || 0,
    due_jobs: Array.isArray(heartbeat.due_jobs) ? heartbeat.due_jobs.slice(0, 30) : [],
    run_key: heartbeat.run_key || null,
    // rel-12: whether this cycle can actually run a bounded repair task. A
    // cycle with no dispatcher still proves liveness, but the queue must not
    // promise a pickup time it cannot keep.
    repair_dispatch: heartbeat.repair_dispatch === true,
  };
  const stored = await putJson(env?.ALERT_STATE, SCHEDULER_HEARTBEAT_KEY, result);
  if (!stored) return { accepted: false, rejected: ["scheduler heartbeat store is unavailable"], heartbeat: null };
  return { accepted: true, rejected: [], heartbeat: result };
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
  else if (shadow.status !== "READY") findings.push(digestShadowFinding(shadow));
  if (now.getUTCHours() >= deadlineHour) {
    if (!delivery) findings.push("terminal delivery receipt missing");
    else if (delivery.status !== "TERMINAL") findings.push(`delivery receipt is ${delivery.status}`);
    else if (delivery.enqueued > 0 && delivery.accepted_sends === 0) findings.push(digestZeroAcceptedSendsFinding(delivery));
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

/**
 * Scheduler liveness reads only the heartbeat the scheduled cycle wrote.
 * Absent, unparseable, malformed, stale, or non-succeeding state all fail
 * closed, and mail findings stay a separate leg so neither can clear the other.
 */
export async function schedulerWatchdogSnapshot(env, { now = new Date(), maxAgeMs = SCHEDULER_HEARTBEAT_MAX_AGE_MS } = {}) {
  const heartbeat = await readJson(env?.ALERT_STATE, SCHEDULER_HEARTBEAT_KEY);
  const mail = await mailWatchdogSnapshot(env, { now });
  const schedulerFindings = [];
  const observed = Date.parse(heartbeat?.observed_at || "");
  if (!heartbeat) {
    schedulerFindings.push("scheduler heartbeat missing");
  } else if (heartbeat.schema !== SCHEDULER_HEARTBEAT_SCHEMA) {
    schedulerFindings.push(`scheduler heartbeat has an unrecognized schema ${heartbeat.schema || "(absent)"}`);
  } else if (!Number.isFinite(observed)) {
    schedulerFindings.push("scheduler heartbeat observed_at is missing or unparseable");
  } else {
    schedulerFindings.push(...schedulerHeartbeatEvidenceFindings(heartbeat).map((item) => `scheduler ${item}`));
    if (now.getTime() - observed > maxAgeMs) schedulerFindings.push("scheduler heartbeat expired");
    if (heartbeat.result && heartbeat.result !== "succeeded") {
      schedulerFindings.push(`scheduler cycle ${heartbeat.run_id} reported result ${heartbeat.result}`);
    }
  }
  if (heartbeat?.pending_outbox > 0) schedulerFindings.push(`scheduler outbox has ${heartbeat.pending_outbox} pending item(s)`);
  const findings = [...schedulerFindings, ...mail.findings.map((item) => `mail: ${item}`)];
  return {
    ok: findings.length === 0,
    scheduler_ok: schedulerFindings.length === 0,
    findings,
    scheduler_findings: schedulerFindings,
    heartbeat,
    mail,
  };
}

function normalizedFinding(value) {
  return String(value || "")
    .replace(/\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z\b/g, "<timestamp>")
    .replace(/\b(?:run|request|deployment)[-_ ]?id[=: ]+[A-Za-z0-9_-]+\b/gi, (match) => match.replace(/[=: ].*$/, "=<id>"))
    .replace(/\s+/g, " ").trim();
}

export async function canonicalOpsFailureSignature({ guard, stage = "unknown", findings = [], fingerprint } = {}) {
  if (fingerprint) return String(fingerprint).slice(0, 128);
  const material = JSON.stringify({
    guard: String(guard || ""),
    stage: String(stage || "unknown"),
    findings: [...new Set((Array.isArray(findings) ? findings : [findings]).map(normalizedFinding).filter(Boolean))].sort(),
  });
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(material));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function alertParagraph(record, { rollup = false, queue = null } = {}) {
  const what = record.findings[0] || `${record.guard} failed`;
  const prefix = rollup ? `${record.guard} repeated ${record.count} times` : `${record.guard} broke`;
  const workflow = record.workflow ? ` Workflow: ${record.workflow}.` : "";
  const revision = record.source_revision ? ` Source revision: ${record.source_revision}.` : "";
  return `${prefix}: ${what}. First seen ${record.first_seen}; last seen ${record.last_seen}.${workflow}${revision}`
    + ` Workflow run: ${record.latest_run_url}. Raw receipt: ${record.latest_receipt_url}.`
    + repairQueueSentence(queue);
}

/**
 * The decision the owner has to make when automatic repair could not finish.
 * It names what failed, since when, the run and receipt to look at, and what is
 * being asked — no queue mechanics and no raw payload.
 */
export function repairJudgmentParagraph(judgment) {
  const attempts = `${judgment.attempts} automatic repair attempt(s)`;
  const run = judgment.run_url ? ` Workflow run: ${judgment.run_url}.` : "";
  const receipt = judgment.receipt_url ? ` Raw receipt: ${judgment.receipt_url}.` : "";
  const detail = judgment.result_summary ? ` The attempt reported: ${judgment.result_summary}.` : "";
  return `Automatic repair needs your decision for ${judgment.guard}: ${judgment.finding}.`
    + ` Failing since ${judgment.first_seen}; last seen ${judgment.last_seen}.`
    + ` ${attempts} did not fix it: ${judgment.reason}.${detail}${run}${receipt}`
    + ` Decide whether to repair it by hand or change what the guard expects.`
    + ` The queue has parked it and will not keep retrying it today.`;
}

/**
 * One readable alert per repair that reached the judgment boundary. It is a
 * distinct signature from the finding it came from, and its own guard is
 * excluded from the queue, so a failed fix can never queue a repair for its own
 * failure notice.
 */
export async function emitRepairJudgmentAlerts(env, judgments = [], { now = new Date() } = {}) {
  const emitted = [];
  for (const judgment of judgments) {
    if (!judgment) continue;
    const alert = await emitOpsAlertOnce(env, {
      guard: REPAIR_JUDGMENT_GUARD,
      stage: judgment.stage,
      fingerprint: `repair-judgment:${judgment.signature}`,
      subject: `CityScroll automatic repair needs a decision: ${judgment.guard}`,
      findings: [`automatic repair could not fix ${judgment.guard}: ${judgment.finding}`],
      paragraph: repairJudgmentParagraph(judgment),
      workflow: judgment.workflow,
      source_revision: judgment.source_revision,
      workflow_run_url: judgment.run_url,
      receipt_url: judgment.receipt_url,
      first_seen: judgment.first_seen,
      last_seen: now.toISOString(),
      now,
    });
    emitted.push({ signature: judgment.signature, sent: alert.sent, reason: alert.reason });
  }
  return emitted;
}

// Guards whose findings are only actionable with run and receipt evidence in
// hand. A caller cannot opt out: an alert with nothing to dereference is held
// back and reported as a delivery failure rather than emailed as "null".
export const EVIDENCE_REQUIRED_GUARDS = Object.freeze(["scheduler-heartbeat", "served-artifact-freshness"]);

// The one guard that reports on the repair loop itself. rel-12 keeps it out of
// the queue so a failed fix cannot enqueue a repair for its own failure notice.
export const REPAIR_JUDGMENT_GUARD = REPAIR_QUEUE_EXCLUDED_GUARDS[0];

export function opsAlertEvidenceFindings(input = {}) {
  const findings = [];
  const concrete = (value) => {
    const text = typeof value === "string" ? value.trim() : "";
    return text && !GENERIC_EVIDENCE.has(text.toLowerCase()) ? text : "";
  };
  if (!concrete(input.workflow)) findings.push("alert evidence field workflow is missing or generic");
  if (!concrete(input.workflow_run_url)) findings.push("alert evidence field workflow_run_url is missing or generic");
  if (!concrete(input.receipt_url)) findings.push("alert evidence field receipt_url is missing or generic");
  const revision = concrete(input.source_revision);
  if (!revision) findings.push("alert evidence field source_revision is missing or generic");
  else if (!/^[0-9a-f]{7,40}$/i.test(revision)) findings.push("alert evidence field source_revision is not a source revision");
  if (!Number.isFinite(Date.parse(input.last_seen || ""))) findings.push("alert evidence field last_seen is missing or unparseable");
  return findings;
}

async function updateAlertHistory(kv, record) {
  const history = await readJson(kv, OPS_ALERT_HISTORY_KEY);
  const items = [record, ...(Array.isArray(history?.items) ? history.items : []).filter((row) => row.signature !== record.signature)]
    .slice(0, OPS_ALERT_HISTORY_LIMIT);
  await putJson(kv, OPS_ALERT_HISTORY_KEY, {
    schema: "cityscroll.ops-alert-history.v1",
    observed_at: record.last_seen,
    items,
  });
}

export async function emitOpsAlertOnce(env, input = {}) {
  const now = input.now instanceof Date ? input.now : new Date(input.last_seen || Date.now());
  const guard = String(input.guard || "reliability").slice(0, 80);
  const findings = (Array.isArray(input.findings) ? input.findings : [input.text]).map(normalizedFinding).filter(Boolean).slice(0, 20);
  const signature = await canonicalOpsFailureSignature({ ...input, guard, findings });
  const alertKey = `ops:alert:signature:${signature}`;
  const prior = await readJson(env?.ALERT_STATE, alertKey);
  const firstSeen = prior?.first_seen || input.first_seen || now.toISOString();
  const lastSeen = input.last_seen || now.toISOString();
  const record = {
    schema: "cityscroll.ops-alert-signature.v1",
    signature,
    guard,
    stage: String(input.stage || prior?.stage || "unknown").slice(0, 80),
    findings,
    first_seen: firstSeen,
    last_seen: lastSeen,
    count: (Number(prior?.count) || 0) + 1,
    workflow: trimmed(input.workflow) || prior?.workflow || null,
    source_revision: trimmed(input.source_revision).toLowerCase() || prior?.source_revision || null,
    latest_run_url: input.workflow_run_url || prior?.latest_run_url || null,
    latest_receipt_url: input.receipt_url || prior?.latest_receipt_url || null,
    sent_at: prior?.sent_at || null,
    rollup_day: prior?.rollup_day || null,
    delivery_finding: prior?.delivery_finding || null,
  };
  if (EVIDENCE_REQUIRED_GUARDS.includes(guard)) {
    const missing = opsAlertEvidenceFindings({ ...input, last_seen: lastSeen });
    if (missing.length) {
      record.delivery_finding = { observed_at: lastSeen, reason: "evidence-required", findings: missing };
      await putJson(env?.ALERT_STATE, alertKey, record);
      await updateAlertHistory(env?.ALERT_STATE, record);
      return { sent: false, reason: "evidence-required", evidence_findings: missing, signature, record };
    }
  }
  // rel-12: the repair item is written before the mail is composed, because the
  // alert has to name the pickup time the queue actually holds. A repeat lands
  // here too, so the counter advances even when the mail stays suppressed.
  const heartbeat = await readJson(env?.ALERT_STATE, SCHEDULER_HEARTBEAT_KEY);
  const queue = await upsertRepairItem(env, {
    signature,
    guard,
    stage: record.stage,
    findings,
    first_seen: firstSeen,
    last_seen: lastSeen,
    workflow: record.workflow,
    source_revision: record.source_revision,
    workflow_run_url: record.latest_run_url,
    receipt_url: record.latest_receipt_url,
  }, { now, heartbeat });
  // A queue write that did not land is a durable operational finding carried on
  // the alert record and the private projection. It never alerts through the
  // same store that just refused the write.
  record.queue = queue.skipped ? null : {
    queued: queue.ok,
    state: queue.item?.state || null,
    repeat_count: queue.item?.repeat_count || null,
    next_pickup_at: queue.item?.next_pickup_at || null,
    finding: queue.ok ? null : { observed_at: lastSeen, reason: queue.reason, detail: queue.detail || null },
  };

  const today = day(now);
  const rollup = !!prior && prior.rollup_day !== today && day(prior.last_seen) !== today;
  const shouldSend = !prior || rollup;
  if (!shouldSend) {
    await putJson(env?.ALERT_STATE, alertKey, record);
    await updateAlertHistory(env?.ALERT_STATE, record);
    return { sent: false, reason: "already-alerted", signature, record, queue };
  }
  const { sendOpsAlert } = await import("./alerts.mjs");
  let result;
  try {
    result = await sendOpsAlert(env, {
      guard,
      subject: input.subject || `CityScroll reliability alert: ${guard}`,
      // Only the repair-judgment guard composes its own paragraph, because its
      // "since when" dates would be normalized out of a finding — rel-09's
      // normalization exists to make signatures stable, not to be read. Every
      // other guard, including anything arriving over the admin relay, gets the
      // standard evidence-bearing paragraph.
      text: (guard === REPAIR_JUDGMENT_GUARD && input.paragraph) || alertParagraph(record, { rollup, queue }),
      observedAt: record.last_seen,
    });
  } catch (error) {
    result = { accepted: false, reason: "resend-rejected", error: String(error?.message || error) };
  }
  if (result.accepted) {
    record.sent_at = record.last_seen;
    if (rollup) record.rollup_day = today;
  } else {
    record.delivery_finding = { observed_at: record.last_seen, reason: result.reason || "rejected" };
  }
  await putJson(env?.ALERT_STATE, alertKey, record);
  await updateAlertHistory(env?.ALERT_STATE, record);
  return { sent: !!result.accepted, result, reason: result.accepted ? null : (result.reason || "rejected"), signature, record, queue };
}

/**
 * Pickup on the cycle's existing heartbeat: reconcile anything the queue lost to
 * a failed write, hand out bounded leases, and turn any item that reached the
 * judgment boundary into the one owner alert it is allowed to send. Pickup
 * itself is silent.
 */
export async function dispatchRepairQueue(env, { now = new Date(), runId = null, limit } = {}) {
  const heartbeat = await readJson(env?.ALERT_STATE, SCHEDULER_HEARTBEAT_KEY);
  const history = await readJson(env?.ALERT_STATE, OPS_ALERT_HISTORY_KEY);
  const recovered = await reconcileRepairQueue(env, { now, heartbeat, history });
  // A cycle that cannot dispatch does not take leases. Spending attempts on
  // work nothing will run is how a queue quietly exhausts itself into mail.
  if (heartbeat?.repair_dispatch !== true) {
    return { recovered: recovered.restored, items: [], judgment_alerts: [], dispatch: false };
  }
  const lease = await leaseRepairItems(env, { runId, now, heartbeat, ...(limit ? { limit } : {}) });
  const alerts = await emitRepairJudgmentAlerts(env, lease.judgment, { now });
  return { recovered: recovered.restored, items: lease.items, judgment_alerts: alerts, dispatch: true };
}

/**
 * The cycle reporting what its bounded repair task did. A repaired item retires
 * silently; a retryable failure returns to the queue silently; only a terminal
 * failure or an explicit request for a decision mails the owner.
 */
export async function reportRepairResults(env, reports = [], { now = new Date() } = {}) {
  const applied = [];
  const judgments = [];
  for (const report of Array.isArray(reports) ? reports.slice(0, 20) : []) {
    const outcome = await completeRepairItem(env, report, { now });
    applied.push({
      signature: report?.signature || null,
      accepted: outcome.ok,
      reason: outcome.reason,
      state: outcome.item?.state || null,
    });
    if (outcome.judgment) judgments.push(outcome.judgment);
  }
  const alerts = await emitRepairJudgmentAlerts(env, judgments, { now });
  return { applied, judgment_alerts: alerts };
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
