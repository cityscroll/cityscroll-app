export const DIGEST_SHADOW_LEDGER_PREFIX = "ops:digest:shadow:";
export const DIGEST_DELIVERY_LEDGER_PREFIX = "ops:digest:delivery:";
export const SCHEDULER_HEARTBEAT_KEY = "ops:scheduler:heartbeat";

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

export async function digestWatchdogSnapshot(env, { now = new Date(), deadlineHour = 14 } = {}) {
  const today = day(now);
  const shadow = await readJson(env?.ALERT_STATE, `${DIGEST_SHADOW_LEDGER_PREFIX}${today}`);
  const delivery = await readJson(env?.ALERT_STATE, `${DIGEST_DELIVERY_LEDGER_PREFIX}${today}`);
  const dlq = Number(await env?.ALERT_STATE?.get?.(`digest:dlq:${today}`)) || 0;
  const findings = [];
  if (!shadow) findings.push("shadow READY receipt missing");
  else if (shadow.status !== "READY") findings.push(`shadow receipt is ${shadow.status}`);
  if (now.getUTCHours() >= deadlineHour) {
    if (!delivery) findings.push("terminal delivery receipt missing");
    else if (delivery.status !== "TERMINAL") findings.push(`delivery receipt is ${delivery.status}`);
    else if (delivery.enqueued > 0 && delivery.accepted_sends === 0) findings.push("enqueued digest has zero accepted sends");
  }
  if (dlq > 0) findings.push(`digest DLQ is non-empty (${dlq})`);
  return { ok: findings.length === 0, day: today, findings, shadow, delivery, dlq };
}

export async function schedulerWatchdogSnapshot(env, { now = new Date(), maxAgeMs = 90 * 60 * 1000 } = {}) {
  const heartbeat = await readJson(env?.ALERT_STATE, SCHEDULER_HEARTBEAT_KEY);
  const findings = [];
  const observed = Date.parse(heartbeat?.observed_at || "");
  if (!heartbeat || !Number.isFinite(observed)) findings.push("scheduler heartbeat missing");
  else if (now.getTime() - observed > maxAgeMs) findings.push("scheduler heartbeat expired");
  if (heartbeat?.pending_outbox > 0) findings.push(`scheduler outbox has ${heartbeat.pending_outbox} pending item(s)`);
  return { ok: findings.length === 0, findings, heartbeat };
}

export async function emitOpsAlertOnce(env, { guard, fingerprint, subject, text } = {}) {
  const alertKey = `ops:alert:${guard}:${fingerprint || new Date().toISOString().slice(0, 13)}`;
  if (await env?.ALERT_STATE?.get?.(alertKey)) return { sent: false, reason: "already-alerted" };
  const { sendOpsAlert } = await import("./alerts.mjs");
  const result = await sendOpsAlert(env, { guard, subject, text });
  if (result.accepted) await env.ALERT_STATE.put(alertKey, new Date().toISOString());
  return { sent: !!result.accepted, result };
}
