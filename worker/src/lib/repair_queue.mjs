// repair_queue — the durable handoff between an owner alert and automatic repair.
//
// rel-09 gives every operational failure a canonical signature and human-grade
// mail; rel-10 routes that mail to the verified owner. Neither leaves anything a
// machine can pick up, so the owner has to retype an email into a repair task.
//
// This module keeps ONE structured repair item per canonical alert signature in
// the existing ALERT_STATE namespace. It is not a queue service and not a
// scheduler: the external-schedules cycle that already publishes the scheduler
// heartbeat leases items on that same heartbeat, runs a bounded debug/fix task,
// and reports the outcome back on its next heartbeat.
//
// MAIL POLICY lives with the caller, but the states here are what it keys on:
// queueing, pickup, retry, and a successful repair are all silent. Only
// `needs_judgment` — a repair that failed terminally or asked for a decision —
// produces the one further owner alert.
//
// SANITIZATION: records carry bounded, redacted prose and https links only.
// Credentials, tokens, raw payloads, unbounded traces, recipient addresses, and
// executable instructions never enter an item. What the dispatcher is allowed to
// do is a constant declared here, never a field a caller can widen.

export const REPAIR_QUEUE_ITEM_SCHEMA = "cityscroll.ops-repair-queue-item.v1";
export const REPAIR_QUEUE_INDEX_SCHEMA = "cityscroll.ops-repair-queue-index.v1";
export const REPAIR_QUEUE_VERSION = 1;
export const REPAIR_QUEUE_INDEX_KEY = "ops:repair:index:v1";
export const REPAIR_QUEUE_ITEM_PREFIX = "ops:repair:item:";
export const REPAIR_QUEUE_LIMIT = 50;
export const REPAIR_QUEUE_RETIRED_LIMIT = 100;
export const REPAIR_CONTEXT_FINDING_LIMIT = 5;
export const REPAIR_TEXT_LIMIT = 200;
export const REPAIR_LINK_LIMIT = 300;
export const REPAIR_REPEAT_COUNT_MAX = 9999;
export const REPAIR_LEASE_MS = 15 * 60 * 1000;
export const REPAIR_MAX_ATTEMPTS = 3;
export const REPAIR_LEASE_BATCH = 3;

// Queueing is not authorization. Pickup permits a bounded diagnosis and a
// proposed fix and nothing else: never a history rewrite, a credential
// rotation, an authentication change, a security-sensitive configuration edit,
// or any destructive action. Those stay behind the judgment boundary. The
// dispatcher reads this scope from the item; no caller and no stored record can
// widen it, and no item ever carries a command to run.
export const REPAIR_SCOPE = "diagnose-and-propose";

export const REPAIR_STATES = Object.freeze([
  "queued", "leased", "repaired", "needs_judgment",
]);

// Alerts about the repair loop itself never re-enter the repair loop, or a
// failed fix would queue a repair for its own failure notice.
export const REPAIR_QUEUE_EXCLUDED_GUARDS = Object.freeze(["ops-repair-judgment"]);

// The launchd agent in ops/launchd/com.cityscroll.external-schedules.plist.template
// runs the cycle on this interval, so this is the queue's real pickup cadence
// rather than a cadence this module invents. A test pins the two together.
export const REPAIR_PICKUP_INTERVAL_MS = 60 * 1000;
// The window schedulerWatchdogSnapshot already treats as live. Past it, the
// cycle is not demonstrably running and no pickup time can be honestly named.
export const REPAIR_PICKUP_LIVENESS_MS = 90 * 60 * 1000;

export function repairItemKey(signature) {
  return `${REPAIR_QUEUE_ITEM_PREFIX}${String(signature || "").slice(0, 128)}`;
}

const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]+/g;

function sanitizeText(value, limit = REPAIR_TEXT_LIMIT) {
  return String(value ?? "")
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[redacted-email]")
    // The credential value goes first, so a scheme keyword cannot swallow the
    // label and leave the secret standing next to it.
    .replace(/\b(?:bearer|basic)\s+\S+/gi, "[redacted-credential]")
    .replace(/\b(?:authorization|token|api[_-]?key|apikey|secret|password|credential)\b\s*[:=]\s*\S+/gi, "[redacted-credential]")
    .replace(CONTROL_CHARACTERS, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, limit);
}

/**
 * Links are evidence, not payload: https only, query string dropped (it can
 * carry an operator key), and only the artifacts fragment kept.
 */
function sanitizeLink(value) {
  const raw = typeof value === "string" ? value.trim() : "";
  if (!raw || raw.length > REPAIR_LINK_LIMIT) return null;
  let url;
  try { url = new URL(raw); } catch { return null; }
  if (url.protocol !== "https:") return null;
  const fragment = url.hash === "#artifacts" ? "#artifacts" : "";
  return `${url.origin}${url.pathname}${fragment}`.slice(0, REPAIR_LINK_LIMIT);
}

function sanitizeFindings(findings) {
  const rows = Array.isArray(findings) ? findings : [findings];
  return rows.map((row) => sanitizeText(row)).filter(Boolean).slice(0, REPAIR_CONTEXT_FINDING_LIMIT);
}

function isoOr(value, fallback) {
  return Number.isFinite(Date.parse(value || "")) ? new Date(value).toISOString() : fallback;
}

function utcDay(value) {
  return String(value || "").slice(0, 10);
}

function lastSeenOf(input, now) {
  return isoOr(input?.last_seen, now.toISOString());
}

async function readJson(kv, name) {
  if (!kv?.get) return null;
  try { return JSON.parse(await kv.get(name) || "null"); } catch { return null; }
}

async function putJson(kv, name, value) {
  if (!kv?.put) throw new Error("repair-queue-store-unavailable");
  await kv.put(name, JSON.stringify(value));
}

/**
 * A stored record is only an item when it says what it is. Anything absent,
 * unparseable, wrongly-schema'd, or missing its identity reads as absent so the
 * caller rebuilds it from the alert rather than trusting a malformed payload.
 */
export function normalizeRepairItem(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  if (raw.schema !== REPAIR_QUEUE_ITEM_SCHEMA) return null;
  const signature = typeof raw.signature === "string" ? raw.signature.slice(0, 128) : "";
  if (!signature) return null;
  const state = REPAIR_STATES.includes(raw.state) ? raw.state : "queued";
  const repeatCount = Number.isFinite(Number(raw.repeat_count)) && Number(raw.repeat_count) > 0
    ? Math.min(Math.floor(Number(raw.repeat_count)), REPAIR_REPEAT_COUNT_MAX)
    : 1;
  const firstSeen = isoOr(raw.first_seen, null);
  if (!firstSeen) return null;
  const lease = raw.lease && typeof raw.lease === "object" ? {
    lease_id: sanitizeText(raw.lease.lease_id, 64) || null,
    holder_run_id: sanitizeText(raw.lease.holder_run_id, 120) || null,
    acquired_at: isoOr(raw.lease.acquired_at, null),
    expires_at: isoOr(raw.lease.expires_at, null),
  } : null;
  const result = raw.result && typeof raw.result === "object" ? {
    outcome: ["repaired", "failed", "judgment"].includes(raw.result.outcome) ? raw.result.outcome : "failed",
    observed_at: isoOr(raw.result.observed_at, null),
    summary: sanitizeText(raw.result.summary),
    run_url: sanitizeLink(raw.result.run_url),
    receipt_url: sanitizeLink(raw.result.receipt_url),
  } : null;
  return {
    schema: REPAIR_QUEUE_ITEM_SCHEMA,
    version: REPAIR_QUEUE_VERSION,
    signature,
    guard: sanitizeText(raw.guard, 80) || "reliability",
    stage: sanitizeText(raw.stage, 80) || "unknown",
    repair_scope: REPAIR_SCOPE,
    first_seen: firstSeen,
    last_seen: isoOr(raw.last_seen, firstSeen),
    repeat_count: repeatCount,
    workflow: sanitizeText(raw.workflow, 120) || null,
    source_revision: /^[0-9a-f]{7,40}$/i.test(String(raw.source_revision || "")) ? String(raw.source_revision).toLowerCase() : null,
    latest_run_url: sanitizeLink(raw.latest_run_url),
    latest_receipt_url: sanitizeLink(raw.latest_receipt_url),
    context: { findings: sanitizeFindings(raw.context?.findings) },
    state,
    next_pickup_at: isoOr(raw.next_pickup_at, null),
    pickup_blocked_reason: sanitizeText(raw.pickup_blocked_reason, 120) || null,
    lease: state === "leased" ? lease : null,
    attempts: Number.isFinite(Number(raw.attempts)) && Number(raw.attempts) > 0 ? Math.floor(Number(raw.attempts)) : 0,
    result,
    judgment_reason: sanitizeText(raw.judgment_reason) || null,
    created_at: isoOr(raw.created_at, firstSeen),
    updated_at: isoOr(raw.updated_at, firstSeen),
  };
}

/**
 * The pickup time the alert names is the cycle's own cadence measured from the
 * heartbeat it actually wrote. A missing heartbeat, a stale one, or a cycle that
 * has no dispatcher yields no time and a plain reason instead, so the alert
 * never names a tick from a scheduler that is not demonstrably going to pick up.
 */
export function repairPickupState(heartbeat, now = new Date()) {
  const observed = Date.parse(heartbeat?.observed_at || "");
  if (!Number.isFinite(observed)) {
    return { at: null, blocked: "the scheduler heartbeat is missing" };
  }
  const elapsed = now.getTime() - observed;
  if (elapsed < 0 || elapsed > REPAIR_PICKUP_LIVENESS_MS) {
    return { at: null, blocked: "the scheduler heartbeat is not current" };
  }
  if (heartbeat.repair_dispatch !== true) {
    return { at: null, blocked: "the repair cycle has no dispatcher configured" };
  }
  const ticks = Math.floor(elapsed / REPAIR_PICKUP_INTERVAL_MS) + 1;
  return { at: new Date(observed + ticks * REPAIR_PICKUP_INTERVAL_MS).toISOString(), blocked: null };
}

export function nextRepairPickupAt(heartbeat, now = new Date()) {
  return repairPickupState(heartbeat, now).at;
}

export function isTerminalRepairState(state) {
  return state === "repaired";
}

async function readIndex(kv) {
  const raw = await readJson(kv, REPAIR_QUEUE_INDEX_KEY);
  const signatures = Array.isArray(raw?.signatures)
    ? [...new Set(raw.signatures.filter((value) => typeof value === "string" && value))]
    : [];
  const retired = Array.isArray(raw?.retired)
    ? [...new Set(raw.retired.filter((value) => typeof value === "string" && value))]
    : [];
  return { signatures, retired };
}

async function writeIndex(kv, index, now) {
  // Signatures are not truncated here. Capacity is reclaimed in persistItem by
  // retiring repaired work; an open item that outlives the soft limit is kept
  // rather than dropped, because a silently lost finding is worse than a long
  // index. Retired identities are a bounded tombstone list.
  await putJson(kv, REPAIR_QUEUE_INDEX_KEY, {
    schema: REPAIR_QUEUE_INDEX_SCHEMA,
    observed_at: now.toISOString(),
    signatures: index.signatures,
    retired: index.retired.slice(0, REPAIR_QUEUE_RETIRED_LIMIT),
  });
}

export async function readRepairItem(env, signature) {
  const raw = await readJson(env?.ALERT_STATE, repairItemKey(signature));
  const item = normalizeRepairItem(raw);
  return { item, malformed: Boolean(raw) && !item };
}

async function persistItem(env, item, { retire = false } = {}) {
  const kv = env?.ALERT_STATE;
  const now = new Date(item.updated_at);
  const index = await readIndex(kv);
  if (retire) {
    index.signatures = index.signatures.filter((value) => value !== item.signature);
    index.retired = [item.signature, ...index.retired.filter((value) => value !== item.signature)];
  } else {
    index.signatures = [item.signature, ...index.signatures.filter((value) => value !== item.signature)];
    index.retired = index.retired.filter((value) => value !== item.signature);
  }
  // Capacity is reclaimed only from repaired work. An open item is never
  // dropped to make room, so the queue cannot lose a live finding silently.
  if (index.signatures.length > REPAIR_QUEUE_LIMIT) {
    const overflow = index.signatures.slice(REPAIR_QUEUE_LIMIT);
    const keep = [];
    for (const signature of overflow) {
      const { item: stored } = await readRepairItem(env, signature);
      if (stored && isTerminalRepairState(stored.state)) index.retired = [signature, ...index.retired];
      else keep.push(signature);
    }
    index.signatures = [...index.signatures.slice(0, REPAIR_QUEUE_LIMIT), ...keep];
  }
  await putJson(kv, repairItemKey(item.signature), item);
  await writeIndex(kv, index, now);
  return item;
}

/**
 * One item per canonical signature. A repeat updates the same record: the
 * repeat counter advances, first-seen is preserved, and the latest evidence
 * replaces the previous evidence. Nothing here resets a counter or forks a
 * second item, so dedupe survives a restart because it is a property of the
 * stored key rather than of any process.
 */
export async function upsertRepairItem(env, input = {}, { now = new Date(), heartbeat = null } = {}) {
  const signature = String(input.signature || "").slice(0, 128);
  if (!signature) return { ok: false, reason: "signature-required", item: null };
  const guard = sanitizeText(input.guard, 80) || "reliability";
  if (REPAIR_QUEUE_EXCLUDED_GUARDS.includes(guard)) {
    return { ok: false, reason: "guard-not-queued", item: null, skipped: true };
  }
  let prior = null;
  let malformed = false;
  try {
    const read = await readRepairItem(env, signature);
    prior = read.item;
    malformed = read.malformed;
  } catch { prior = null; }

  const pickup = repairPickupState(heartbeat, now);
  const lastSeen = lastSeenOf(input, now);
  const firstSeen = prior?.first_seen || isoOr(input.first_seen, lastSeen);
  const repeatCount = prior ? Math.min(prior.repeat_count + 1, REPAIR_REPEAT_COUNT_MAX) : 1;
  // A repeat of a signature whose repair already finished is a fresh failure of
  // the same shape: the item reopens for pickup, keeping its first-seen history
  // and its repeat count rather than starting a second item.
  //
  // An item parked at the judgment boundary is different. It reopens at most
  // once a UTC day — the rhythm rel-09 already uses to re-surface a finding that
  // is still happening — so a signature firing every few minutes cannot spin the
  // repair loop against work a human was asked to decide, and a failure that is
  // still there tomorrow still gets another bounded attempt.
  const reopen = !prior
    || prior.state === "repaired"
    || (prior.state === "needs_judgment" && utcDay(lastSeenOf(input, now)) > utcDay(prior.updated_at));
  const state = reopen ? "queued" : prior.state;
  const item = normalizeRepairItem({
    schema: REPAIR_QUEUE_ITEM_SCHEMA,
    version: REPAIR_QUEUE_VERSION,
    signature,
    guard,
    stage: input.stage || prior?.stage || "unknown",
    first_seen: firstSeen,
    last_seen: lastSeen,
    repeat_count: repeatCount,
    workflow: input.workflow || prior?.workflow || null,
    source_revision: input.source_revision || prior?.source_revision || null,
    latest_run_url: input.workflow_run_url || prior?.latest_run_url || null,
    latest_receipt_url: input.receipt_url || prior?.latest_receipt_url || null,
    context: { findings: input.findings?.length ? input.findings : prior?.context?.findings },
    state,
    next_pickup_at: pickup.at,
    pickup_blocked_reason: pickup.blocked,
    lease: state === "leased" ? prior?.lease : null,
    attempts: reopen ? 0 : (prior?.attempts || 0),
    result: reopen ? null : (prior?.result || null),
    judgment_reason: reopen ? null : (prior?.judgment_reason || null),
    created_at: prior?.created_at || firstSeen,
    updated_at: now.toISOString(),
  });
  try {
    await persistItem(env, item);
  } catch (error) {
    // A queue write failure is a durable operational finding, not a new alert:
    // re-alerting through the same unavailable store is how a broken rail
    // becomes a loop. The next pickup reconciles it from the alert history.
    return {
      ok: false,
      reason: "queue-write-failed",
      detail: sanitizeText(error?.message || error, 120),
      item: null,
      malformed_replaced: malformed,
    };
  }
  return { ok: true, item, reason: null, malformed_replaced: malformed };
}

function leaseId(signature, runId, now) {
  return `${signature.slice(0, 12)}-${String(runId || "cycle").replace(/[^A-Za-z0-9_-]/g, "").slice(0, 24)}-${now.getTime()}`;
}

function judgmentDescriptor(item, reason) {
  return {
    signature: item.signature,
    guard: item.guard,
    stage: item.stage,
    reason,
    first_seen: item.first_seen,
    last_seen: item.last_seen,
    attempts: item.attempts,
    workflow: item.workflow,
    source_revision: item.source_revision,
    run_url: item.result?.run_url || item.latest_run_url,
    receipt_url: item.result?.receipt_url || item.latest_receipt_url,
    finding: item.context.findings[0] || `${item.guard} failed`,
    result_summary: item.result?.summary || null,
  };
}

/**
 * Pickup on the existing heartbeat. A lease is bounded, so a cycle that dies
 * mid-repair releases the item by expiry instead of stranding it, and the retry
 * keeps the same item, the same first-seen, and the same repeat count. Each
 * acquisition spends one attempt, so an item that can never be leased cleanly
 * reaches the judgment boundary instead of cycling forever.
 */
export async function leaseRepairItems(env, { runId, now = new Date(), limit = REPAIR_LEASE_BATCH, heartbeat = null } = {}) {
  const index = await readIndex(env?.ALERT_STATE);
  const leased = [];
  const judgment = [];
  // Oldest first. The index is written newest-first, so leasing in reverse
  // keeps a steadily repeating failure from starving an older one.
  for (const signature of [...index.signatures].reverse()) {
    if (leased.length >= limit) break;
    const { item } = await readRepairItem(env, signature);
    if (!item) continue;
    if (isTerminalRepairState(item.state) || item.state === "needs_judgment") continue;
    if (item.state === "leased") {
      const expires = Date.parse(item.lease?.expires_at || "");
      if (Number.isFinite(expires) && expires > now.getTime()) continue;
    }
    if (item.attempts >= REPAIR_MAX_ATTEMPTS) {
      const exhausted = normalizeRepairItem({
        ...item,
        state: "needs_judgment",
        lease: null,
        judgment_reason: `automatic repair stopped after ${item.attempts} attempt(s) without a fix`,
        updated_at: now.toISOString(),
      });
      await persistItem(env, exhausted);
      judgment.push(judgmentDescriptor(exhausted, exhausted.judgment_reason));
      continue;
    }
    const id = leaseId(signature, runId, now);
    const next = normalizeRepairItem({
      ...item,
      state: "leased",
      attempts: item.attempts + 1,
      next_pickup_at: nextRepairPickupAt(heartbeat, now) || item.next_pickup_at,
      pickup_blocked_reason: null,
      lease: {
        lease_id: id,
        holder_run_id: runId || null,
        acquired_at: now.toISOString(),
        expires_at: new Date(now.getTime() + REPAIR_LEASE_MS).toISOString(),
      },
      updated_at: now.toISOString(),
    });
    await persistItem(env, next);
    leased.push(next);
  }
  return { items: leased, judgment };
}

/**
 * The cycle reports what its bounded repair task did. A success retires the
 * item silently. A retryable failure returns the item to the queue, still
 * silent, so retry never becomes mail. A terminal failure or an explicit
 * request for a decision moves the item to the judgment boundary, which is the
 * only outcome that produces a further owner alert.
 */
export async function completeRepairItem(env, report = {}, { now = new Date() } = {}) {
  const signature = String(report.signature || "").slice(0, 128);
  if (!signature) return { ok: false, reason: "signature-required", item: null, judgment: null };
  const { item } = await readRepairItem(env, signature);
  if (!item) return { ok: false, reason: "item-not-found", item: null, judgment: null };
  const reportedLease = sanitizeText(report.lease_id, 64);
  if (item.state !== "leased" || !item.lease?.lease_id || item.lease.lease_id !== reportedLease) {
    // A report from an expired or unknown lease is ignored rather than applied,
    // so a zombie cycle cannot close work another cycle now holds.
    return { ok: false, reason: "lease-mismatch", item, judgment: null };
  }
  const outcome = ["repaired", "failed", "judgment"].includes(report.outcome) ? report.outcome : "failed";
  const result = {
    outcome,
    observed_at: now.toISOString(),
    summary: sanitizeText(report.summary),
    run_url: sanitizeLink(report.run_url),
    receipt_url: sanitizeLink(report.receipt_url),
  };
  const retryable = outcome === "failed" && item.attempts < REPAIR_MAX_ATTEMPTS;
  const state = outcome === "repaired" ? "repaired" : (retryable ? "queued" : "needs_judgment");
  const judgmentReason = state === "needs_judgment"
    ? sanitizeText(report.judgment_reason)
      || (outcome === "judgment"
        ? "the automatic repair asked for a decision before changing anything"
        : `automatic repair stopped after ${item.attempts} attempt(s) without a fix`)
    : null;
  const next = normalizeRepairItem({
    ...item,
    state,
    lease: null,
    result,
    judgment_reason: judgmentReason,
    updated_at: now.toISOString(),
  });
  await persistItem(env, next, { retire: state === "repaired" });
  return {
    ok: true,
    reason: null,
    item: next,
    judgment: state === "needs_judgment" ? judgmentDescriptor(next, judgmentReason) : null,
  };
}

/**
 * Idempotent recovery for the window where the alert landed and the queue write
 * did not. Every alert the history still remembers must have an item; anything
 * missing is rebuilt from the alert record, and a signature already retired
 * stays retired so a finished repair is not resurrected.
 */
export async function reconcileRepairQueue(env, { now = new Date(), heartbeat = null, history = null } = {}) {
  // Only alerts that recorded a failed queue write are rebuilt. Reconciling
  // every remembered alert would resurrect long-settled findings the first time
  // this ran, so the recovery is scoped to the exact failure it exists for.
  const rows = (Array.isArray(history?.items) ? history.items : [])
    .filter((row) => row?.queue && row.queue.queued === false);
  const index = await readIndex(env?.ALERT_STATE);
  const retired = new Set(index.retired);
  const known = new Set(index.signatures);
  const restored = [];
  for (const row of rows) {
    const signature = typeof row?.signature === "string" ? row.signature : "";
    if (!signature || retired.has(signature)) continue;
    const guard = sanitizeText(row.guard, 80) || "reliability";
    if (REPAIR_QUEUE_EXCLUDED_GUARDS.includes(guard)) continue;
    if (known.has(signature)) {
      const { item } = await readRepairItem(env, signature);
      if (item) continue;
    }
    const write = await upsertRepairItem(env, {
      signature,
      guard,
      stage: row.stage,
      findings: row.findings,
      first_seen: row.first_seen,
      last_seen: row.last_seen,
      workflow: row.workflow,
      source_revision: row.source_revision,
      workflow_run_url: row.latest_run_url,
      receipt_url: row.latest_receipt_url,
    }, { now, heartbeat });
    if (write.ok) restored.push(signature);
  }
  return { restored };
}

/**
 * The private projection. Lifecycle is visible to the operator; nothing here is
 * public, and every field was sanitized on the way in.
 */
export async function readRepairQueue(env, { now = new Date(), limit = 30 } = {}) {
  const index = await readIndex(env?.ALERT_STATE);
  const items = [];
  let malformed = 0;
  for (const signature of index.signatures.slice(0, limit)) {
    const read = await readRepairItem(env, signature).catch(() => ({ item: null, malformed: false }));
    if (read.item) items.push(read.item);
    else if (read.malformed) malformed += 1;
  }
  return {
    schema: "cityscroll.ops-repair-queue.v1",
    observed_at: now.toISOString(),
    repair_scope: REPAIR_SCOPE,
    open: items.filter((item) => item.state === "queued" || item.state === "leased").length,
    needs_judgment: items.filter((item) => item.state === "needs_judgment").length,
    malformed,
    items,
  };
}

/**
 * The queued-repair sentence the originating owner alert carries. It names the
 * queue's actual pickup time, and says plainly when there is no live cycle to
 * name one rather than inventing a tick.
 */
export function repairQueueSentence(queue) {
  if (!queue || queue.skipped) return "";
  if (queue.ok === false || !queue.item) {
    return " This finding was not queued for automatic repair: the repair queue write did not land, so it stays an open operational finding.";
  }
  const item = queue.item;
  if (item.next_pickup_at) {
    return ` Queued for automatic repair, next pickup at ${item.next_pickup_at}.`;
  }
  return ` Queued for automatic repair; no pickup time can be named because ${item.pickup_blocked_reason || "the scheduler heartbeat is not current"}.`;
}
