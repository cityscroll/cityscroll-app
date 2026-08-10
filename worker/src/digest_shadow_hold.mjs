// Digest-shadow delivery lease. The 06:00 rehearsal remains delivery-free; this module
// turns only its named affected_digest_ids into short-lived 09:00 delivery holds.

import { notifyOperator } from "./feedback.mjs";

export const DIGEST_SHADOW_HOLD_CONTRACT = "digest-shadow-hold.v1";
export const DIGEST_SHADOW_HOLD_CUTOFF_UTC = "12:45:00.000Z";
export const DIGEST_SHADOW_DELIVERY_BOUNDARY_UTC = "13:00:00.000Z";
export const DIGEST_SHADOW_HOLD_EXPIRES_UTC = "14:00:00.000Z";
export const DIGEST_SHADOW_DARK_DAYS = 3;
export const DIGEST_SHADOW_DEGRADED_CONTRACT = "digest-shadow-degraded-decision.v1";

const DEGRADED_LATEST_KEY = "digest:shadow:degraded:latest";
const DARK_HOLD_PENDING_KEY = "digest:shadow:dark-hold:pending";
const DEGRADED_ALERT_PREFIX = "digest:shadow:degraded:alerted:";
const LAST_KNOWN_STATE_PREFIX = "digest:shadow:hold:last-known:";
const DEFAULT_RETRY_DELAYS_MS = Object.freeze([250, 1000]);

export class DigestShadowHoldInputError extends Error {
  constructor(message) {
    super(message);
    this.name = "DigestShadowHoldInputError";
  }
}

function iso(value) {
  return new Date(value == null ? Date.now() : value).toISOString();
}

function uniqueIds(values) {
  return [...new Set((Array.isArray(values) ? values : [])
    .map((value) => String(value || "").trim())
    .filter((value) => value && value !== "run"))].sort();
}

function boundary(day, time) {
  return `${day}T${time}`;
}

function dayAge(day, today) {
  if (!day || !today) return null;
  const start = Date.parse(`${day}T00:00:00.000Z`);
  const end = Date.parse(`${today}T00:00:00.000Z`);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  return Math.max(0, Math.floor((end - start) / 86_400_000));
}

function normalizeDarkDays(value) {
  const n = Number(value);
  return Number.isInteger(n) && n >= 1 && n <= 30 ? n : DIGEST_SHADOW_DARK_DAYS;
}

function degradedReceipt({ state, decision, lastReadyRunDay = null, readyAgeDays = null, attempts = 1 }) {
  return {
    contract: DIGEST_SHADOW_DEGRADED_CONTRACT,
    decision_id: `${state.run_day}:${decision}`,
    run_day: state.run_day,
    evaluated_at: state.evaluated_at,
    source_status: state.source_status,
    delivery_policy: state.delivery_policy,
    fail_policy: state.fail_policy,
    decision,
    signal: "desk_loud",
    attention_status: "open",
    last_ready_run_day: lastReadyRunDay,
    ready_age_days: readyAgeDays,
    retry_attempts: attempts,
    dark_period_days: state.dark_period_days || DIGEST_SHADOW_DARK_DAYS,
    catch_up_required: decision === "HOLD_ALL_DARK_PERIOD",
    observation: state.observation || null,
  };
}

function openState({
  now,
  sourceStatus,
  observation,
  lastReadyRunDay = undefined,
  attempts = 1,
  darkDays = DIGEST_SHADOW_DARK_DAYS,
} = {}) {
  const evaluatedAt = iso(now);
  const day = evaluatedAt.slice(0, 10);
  const darkPeriodDays = normalizeDarkDays(darkDays);
  const readyAgeDays = dayAge(lastReadyRunDay, day);
  const readyHistoryKnown = lastReadyRunDay !== undefined;
  const dark = readyHistoryKnown && (lastReadyRunDay == null || readyAgeDays >= darkPeriodDays);
  const state = {
    contract: DIGEST_SHADOW_HOLD_CONTRACT,
    run_day: day,
    evaluated_at: evaluatedAt,
    cutoff_at: boundary(day, DIGEST_SHADOW_HOLD_CUTOFF_UTC),
    delivery_boundary_at: boundary(day, DIGEST_SHADOW_DELIVERY_BOUNDARY_UTC),
    expires_at: boundary(day, DIGEST_SHADOW_HOLD_EXPIRES_UTC),
    source_status: dark ? "DARK_PERIOD" : sourceStatus,
    delivery_policy: dark ? "ALL_DIGESTS_HELD" : "ALL_DIGESTS_ELIGIBLE",
    fail_policy: dark ? "fail_closed_after_dark_period" : "fail_open_without_digest_scope",
    affected_digest_ids: [],
    overridden_digest_ids: [],
    active_digest_ids: [],
    dark_period_days: darkPeriodDays,
    observation: observation || null,
  };
  const decision = dark ? "HOLD_ALL_DARK_PERIOD" : "SEND_FAIL_OPEN";
  return {
    ...state,
    degraded_receipt: degradedReceipt({
      state,
      decision,
      lastReadyRunDay: lastReadyRunDay ?? null,
      readyAgeDays,
      attempts,
    }),
  };
}

/** Pure policy builder. Times match the configured 13:00 UTC production delivery cron. */
export function buildDigestShadowHoldState({
  summary = null,
  overriddenDigestIds = [],
  now = new Date(),
  sourceError = null,
  lastReadyRunDay = undefined,
  attempts = 1,
  darkDays = DIGEST_SHADOW_DARK_DAYS,
} = {}) {
  if (sourceError) {
    return openState({
      now,
      sourceStatus: "HOLD_STORE_UNAVAILABLE",
      observation: String(sourceError?.message || sourceError),
      lastReadyRunDay,
      attempts,
      darkDays,
    });
  }

  const evaluatedAt = iso(now);
  const day = evaluatedAt.slice(0, 10);
  if (!summary || summary.run_day !== day) {
    return openState({
      now,
      sourceStatus: "MISSING_RUN",
      observation: summary?.run_day ? `latest run is ${summary.run_day}` : "no run for delivery day",
      lastReadyRunDay,
      attempts,
      darkDays,
    });
  }

  const base = {
    contract: DIGEST_SHADOW_HOLD_CONTRACT,
    run_day: day,
    evaluated_at: evaluatedAt,
    cutoff_at: boundary(day, DIGEST_SHADOW_HOLD_CUTOFF_UTC),
    delivery_boundary_at: boundary(day, DIGEST_SHADOW_DELIVERY_BOUNDARY_UTC),
    expires_at: boundary(day, DIGEST_SHADOW_HOLD_EXPIRES_UTC),
  };
  const affected = uniqueIds(summary.affected_digest_ids);
  const overridden = uniqueIds(overriddenDigestIds).filter((id) => affected.includes(id));

  if (summary.status === "READY" && summary.ok !== false) {
    return {
      ...base,
      source_status: "READY",
      delivery_policy: "ALL_DIGESTS_ELIGIBLE",
      fail_policy: "not_applicable",
      affected_digest_ids: [],
      overridden_digest_ids: [],
      active_digest_ids: [],
      observation: "authenticated successful reruns release the scoped hold state",
    };
  }

  if (evaluatedAt < base.cutoff_at) {
    return {
      ...base,
      source_status: "REDLINES_REPAIR_WINDOW",
      delivery_policy: "ALL_DIGESTS_ELIGIBLE",
      fail_policy: "repair_window_open",
      affected_digest_ids: affected,
      overridden_digest_ids: overridden,
      active_digest_ids: [],
      observation: "redlined digests become held only if still affected at the 12:45 UTC cutoff",
    };
  }

  if (evaluatedAt >= base.expires_at) {
    return {
      ...base,
      source_status: "REDLINES_HOLD_EXPIRED",
      delivery_policy: "ALL_DIGESTS_ELIGIBLE",
      fail_policy: "fail_open_after_expiry",
      affected_digest_ids: affected,
      overridden_digest_ids: overridden,
      active_digest_ids: [],
      observation: "holds never survive beyond the bounded delivery window",
    };
  }

  if (affected.length === 0) {
    return {
      ...base,
      source_status: "REDLINES_WITHOUT_DIGEST_SCOPE",
      delivery_policy: "ALL_DIGESTS_ELIGIBLE",
      fail_policy: "fail_open_without_digest_scope",
      affected_digest_ids: [],
      overridden_digest_ids: [],
      active_digest_ids: [],
      observation: "run-level redlines cannot become a global delivery hold",
    };
  }

  const active = affected.filter((id) => !overridden.includes(id));
  return {
    ...base,
    source_status: "REDLINES_AT_CUTOFF",
    delivery_policy: active.length ? "AFFECTED_DIGESTS_HELD" : "ALL_DIGESTS_ELIGIBLE",
    fail_policy: "fail_closed_for_named_digests",
    affected_digest_ids: affected,
    overridden_digest_ids: overridden,
    active_digest_ids: active,
    observation: active.length
      ? `${active.length} named digest(s) held; unrelated digests remain eligible`
      : "every named digest has an authenticated operator override",
  };
}

export function isDigestHeld(state, digestId) {
  if (!digestId) return false;
  if (state?.delivery_policy === "ALL_DIGESTS_HELD") return true;
  return new Set(state?.active_digest_ids || []).has(digestId);
}

export async function digestShadowId(kind, value) {
  const input = new TextEncoder().encode(String(value || ""));
  const digest = await crypto.subtle.digest("SHA-256", input);
  const hex = Array.from(
    new Uint8Array(digest),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
  return `${kind}:${hex.slice(0, 24)}`;
}

export async function digestIdForJob(job = {}) {
  if (job.type === "rollup") {
    return digestShadowId("digest", (job.keys || []).map(String).sort().join("|"));
  }
  return digestShadowId("digest", job.key || "");
}

export async function partitionDigestJobsByHold(jobs = [], state = null) {
  const eligible = [];
  const held = [];
  for (const job of jobs) {
    const digestId = await digestIdForJob(job);
    if (isDigestHeld(state, digestId)) held.push({ job, digest_id: digestId });
    else eligible.push(job);
  }
  return { eligible, held };
}

async function readSummary(db, day) {
  const row = await db.prepare(
    "SELECT summary_json FROM digest_shadow_runs WHERE run_day = ?",
  ).bind(day).first();
  return row?.summary_json ? JSON.parse(row.summary_json) : null;
}

async function readOverrides(db, day) {
  const out = await db.prepare(
    "SELECT digest_id FROM digest_shadow_hold_overrides WHERE run_day = ? ORDER BY digest_id",
  ).bind(day).all();
  return uniqueIds((out?.results || []).map((row) => row.digest_id));
}

async function readLastReadyRunDay(db, day) {
  const row = await db.prepare(
    "SELECT run_day FROM digest_shadow_runs WHERE status = 'READY' AND run_day <= ? ORDER BY run_day DESC LIMIT 1",
  ).bind(day).first();
  return row?.run_day || null;
}

async function readPersistedState(db, day, fallbackStore = null) {
  try {
    const row = await db.prepare(
      "SELECT state_json FROM digest_shadow_hold_states WHERE run_day = ?",
    ).bind(day).first();
    if (row?.state_json) {
      const state = JSON.parse(row.state_json);
      if (state?.run_day === day && !state?.degraded_receipt) return state;
    }
  } catch {
    // D1 is the canonical audit store; the KV copy keeps today's last-known
    // decision available when that store itself is unavailable.
  }
  if (!fallbackStore?.get) return null;
  try {
    const raw = await fallbackStore.get(`${LAST_KNOWN_STATE_PREFIX}${day}`);
    if (!raw) return null;
    const state = JSON.parse(raw);
    return state?.run_day === day && !state?.degraded_receipt ? state : null;
  } catch {
    return null;
  }
}

function lastKnownState(lastKnown, { now, attempts, sourceError }) {
  if (!lastKnown) return null;
  const evaluatedAt = iso(now);
  const day = evaluatedAt.slice(0, 10);
  if (lastKnown.run_day !== day) return null;
  const base = {
    ...lastKnown,
    evaluated_at: evaluatedAt,
    cutoff_at: boundary(day, DIGEST_SHADOW_HOLD_CUTOFF_UTC),
    delivery_boundary_at: boundary(day, DIGEST_SHADOW_DELIVERY_BOUNDARY_UTC),
    expires_at: boundary(day, DIGEST_SHADOW_HOLD_EXPIRES_UTC),
  };
  const affected = uniqueIds(lastKnown.affected_digest_ids);
  const overridden = uniqueIds(lastKnown.overridden_digest_ids).filter((id) => affected.includes(id));
  const active = affected.filter((id) => !overridden.includes(id));
  let state;
  if (evaluatedAt >= base.expires_at) {
    state = {
      ...base,
      source_status: "LAST_KNOWN_EXPIRED",
      delivery_policy: "ALL_DIGESTS_ELIGIBLE",
      fail_policy: "fail_open_after_expiry",
      active_digest_ids: [],
      observation: `store unavailable after ${attempts} attempts; today's persisted state expired`,
    };
  } else if (affected.length && evaluatedAt >= base.cutoff_at) {
    state = {
      ...base,
      source_status: "LAST_KNOWN_REDLINE",
      delivery_policy: active.length ? "AFFECTED_DIGESTS_HELD" : "ALL_DIGESTS_ELIGIBLE",
      fail_policy: "last_known_fail_closed_for_named_digests",
      affected_digest_ids: affected,
      overridden_digest_ids: overridden,
      active_digest_ids: active,
      observation: `store unavailable after ${attempts} attempts; enforcing today's persisted named hold state`,
    };
  } else {
    state = {
      ...base,
      source_status: "LAST_KNOWN_READY",
      delivery_policy: "ALL_DIGESTS_ELIGIBLE",
      fail_policy: "last_known_state",
      active_digest_ids: [],
      observation: `store unavailable after ${attempts} attempts; sending on today's persisted eligible state`,
    };
  }
  state.degraded_receipt = degradedReceipt({
    state,
    decision: "SEND_ON_LAST_KNOWN_STATE",
    attempts,
  });
  state.degraded_receipt.source_error = String(sourceError?.message || sourceError || "hold store unavailable");
  return state;
}

/** Send one operator-facing signal per degraded decision; never contact a subscriber. */
export async function announceDigestShadowDegrade(env, receipt, {
  notifyFn = notifyOperator,
} = {}) {
  if (!receipt) return { sent: false, reason: "no-receipt" };
  // Cloudflare production always has the D1 binding. Local unit callers can
  // opt into the route explicitly without accidentally issuing network calls.
  if (!env?.DB && env?.DIGEST_SHADOW_ALERTS !== "true") return { sent: false, reason: "not-configured" };
  if (!env?.RESEND_API_KEY) return { sent: false, reason: "not-configured" };
  const key = `${DEGRADED_ALERT_PREFIX}${receipt.decision_id}`;
  try {
    if (env.ALERT_STATE && await env.ALERT_STATE.get(key)) {
      return { sent: false, duplicate: true };
    }
    const reason = [
      `Digest safety degraded on ${receipt.run_day}.`,
      `Decision: ${receipt.decision}.`,
      `Source: ${receipt.source_status}.`,
      `Delivery policy: ${receipt.delivery_policy}.`,
      `Last READY rehearsal: ${receipt.last_ready_run_day || "none known"}.`,
      `READY age: ${receipt.ready_age_days == null ? "unknown" : `${receipt.ready_age_days} day(s)`}.`,
      `Observation: ${receipt.observation || "none"}.`,
      "This is an operator signal; no subscriber address is included.",
    ].join(" ");
    await notifyFn(env, {
      subject: `[CityScroll] Digest safety: ${receipt.decision}`,
      text: reason,
      html: `<div style="font:15px/1.6 system-ui,sans-serif"><h2>Digest safety degraded</h2><p>${reason.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")}</p></div>`,
    });
    if (env.ALERT_STATE) await env.ALERT_STATE.put(key, receipt.evaluated_at || new Date().toISOString());
    return { sent: true };
  } catch (error) {
    console.error("digest shadow operator notification failed:", String(error?.message || error));
    return { sent: false, reason: String(error?.message || error) };
  }
}

function sleep(ms) {
  if (!(ms > 0)) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function writeDegradedReceipt(store, receipt) {
  if (!store || !receipt) return;
  const body = JSON.stringify(receipt);
  await Promise.all([
    store.put(DEGRADED_LATEST_KEY, body),
    store.put(`digest:shadow:degraded:${receipt.run_day}`, body),
    receipt.catch_up_required
      ? store.put(DARK_HOLD_PENDING_KEY, body)
      : Promise.resolve(),
  ]);
}

export async function readDigestShadowDegradedReceipt(store, { day = null } = {}) {
  if (!store) return null;
  try {
    const raw = await store.get(day ? `digest:shadow:degraded:${day}` : DEGRADED_LATEST_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

async function readPendingDarkHold(store) {
  if (!store) return null;
  try {
    const raw = await store.get(DARK_HOLD_PENDING_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

export async function completeDigestShadowRecovery(store, {
  now = new Date(),
  recoveryOf = null,
  catchUp = null,
} = {}) {
  if (!store) return null;
  const evaluatedAt = iso(now);
  const receipt = {
    contract: DIGEST_SHADOW_DEGRADED_CONTRACT,
    decision_id: `${evaluatedAt.slice(0, 10)}:CATCH_UP_SENT_ON_RECOVERY`,
    run_day: evaluatedAt.slice(0, 10),
    evaluated_at: evaluatedAt,
    source_status: "READY",
    delivery_policy: "ALL_DIGESTS_ELIGIBLE",
    fail_policy: "recovered",
    decision: "CATCH_UP_SENT_ON_RECOVERY",
    signal: "desk_loud",
    attention_status: "closed",
    catch_up_required: false,
    recovery_of: recoveryOf?.decision_id || null,
    catch_up: catchUp || null,
    observation: "a READY rehearsal triggered catch-up delivery and cleared the dark-period hold",
  };
  await Promise.all([
    store.put(DEGRADED_LATEST_KEY, JSON.stringify(receipt)),
    store.put(`digest:shadow:degraded:${receipt.run_day}`, JSON.stringify(receipt)),
    store.delete(DARK_HOLD_PENDING_KEY),
  ]);
  return receipt;
}

async function persistState(db, state) {
  await db.prepare(`INSERT INTO digest_shadow_hold_states
    (run_day, contract, evaluated_at, source_status, delivery_policy, cutoff_at,
      delivery_boundary_at, expires_at, state_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(run_day) DO UPDATE SET
      contract = excluded.contract,
      evaluated_at = excluded.evaluated_at,
      source_status = excluded.source_status,
      delivery_policy = excluded.delivery_policy,
      cutoff_at = excluded.cutoff_at,
      delivery_boundary_at = excluded.delivery_boundary_at,
      expires_at = excluded.expires_at,
      state_json = excluded.state_json`)
    .bind(
      state.run_day,
      state.contract,
      state.evaluated_at,
      state.source_status,
      state.delivery_policy,
      state.cutoff_at,
      state.delivery_boundary_at,
      state.expires_at,
      JSON.stringify(state),
    ).run();
}

async function persistLastKnownState(store, state) {
  if (!store?.put || !state?.run_day || state.degraded_receipt) return;
  await store.put(`${LAST_KNOWN_STATE_PREFIX}${state.run_day}`, JSON.stringify(state));
}

/**
 * Delivery-path read. A transient store blip gets three bounded attempts. After that,
 * today's persisted state is the narrow waist; without one, recent READY history keeps
 * delivery open while a three-day rehearsal dark period holds everything for recovery.
 */
export async function resolveDigestShadowHold(db, {
  now = new Date(),
  persist = false,
  receiptStore = null,
  retryDelaysMs = DEFAULT_RETRY_DELAYS_MS,
  sleepFn = sleep,
  darkDays = DIGEST_SHADOW_DARK_DAYS,
  alertEnv = null,
  notifyFn = notifyOperator,
} = {}) {
  const day = iso(now).slice(0, 10);
  if (!db) {
    const sourceError = new Error("DB binding unavailable");
    let lastKnown = null;
    try { lastKnown = await readPersistedState(null, day, receiptStore); } catch { /* KV fallback is best effort */ }
    const state = lastKnown
      ? lastKnownState(lastKnown, { now, attempts: 0, sourceError })
      : buildDigestShadowHoldState({ now, sourceError, attempts: 0, darkDays });
    if (persist) {
      try { await writeDegradedReceipt(receiptStore, state.degraded_receipt); } catch { /* signal is fail-soft */ }
      await announceDigestShadowDegrade(alertEnv, state.degraded_receipt, { notifyFn });
      console.error("digest shadow degraded decision:", JSON.stringify(state.degraded_receipt));
    }
    return state;
  }
  const delays = Array.isArray(retryDelaysMs) ? retryDelaysMs : DEFAULT_RETRY_DELAYS_MS;
  const maxAttempts = delays.length + 1;
  let state = null;
  let sourceError = null;
  let attempts = 0;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    attempts = attempt + 1;
    try {
      const [summary, overriddenDigestIds] = await Promise.all([
        readSummary(db, day),
        readOverrides(db, day),
      ]);
      const lastReadyRunDay = summary ? undefined : await readLastReadyRunDay(db, day);
      state = buildDigestShadowHoldState({
        summary,
        overriddenDigestIds,
        lastReadyRunDay,
        now,
        attempts,
        darkDays,
      });
      break;
    } catch (error) {
      sourceError = error;
      if (attempt < delays.length) await sleepFn(delays[attempt]);
    }
  }

  if (!state) {
    let lastKnown = null;
    let lastReadyRunDay = undefined;
    try { lastKnown = await readPersistedState(db, day, receiptStore); } catch { /* primary error remains authoritative */ }
    if (lastKnown) {
      state = lastKnownState(lastKnown, { now, attempts, sourceError });
    } else {
      try { lastReadyRunDay = await readLastReadyRunDay(db, day); } catch { /* unknown history stays fail-open */ }
      state = buildDigestShadowHoldState({
        now,
        sourceError,
        lastReadyRunDay,
        attempts,
        darkDays,
      });
    }
  }

  if (state.source_status === "READY") {
    const pending = await readPendingDarkHold(receiptStore);
    if (pending) {
      state = {
        ...state,
        catch_up_required: true,
        recovery_of: pending,
        observation: "READY rehearsal restored delivery; catch-up is required before the normal send",
      };
    }
  }

  if (persist) {
    if (!state.degraded_receipt) {
      try {
        await persistState(db, state);
      } catch (error) {
        state = { ...state, observation: `${state.observation}; audit persistence failed: ${String(error?.message || error)}` };
      }
      try {
        await persistLastKnownState(receiptStore, state);
      } catch (error) {
        state = { ...state, observation: `${state.observation}; last-known persistence failed: ${String(error?.message || error)}` };
      }
    }
    if (state.degraded_receipt) {
      try {
        await writeDegradedReceipt(receiptStore, state.degraded_receipt);
        await announceDigestShadowDegrade(alertEnv, state.degraded_receipt, { notifyFn });
        console.error("digest shadow degraded decision:", JSON.stringify(state.degraded_receipt));
      } catch (error) {
        state = { ...state, observation: `${state.observation}; degraded receipt failed: ${String(error?.message || error)}` };
      }
    }
  }
  return state;
}

/** Shadow-run write. A READY rerun replaces any active state with an eligible receipt. */
export async function recordDigestShadowHoldState(db, summary, { now = new Date(), receiptStore = null } = {}) {
  const day = summary?.run_day || iso(now).slice(0, 10);
  let overriddenDigestIds = [];
  if (summary?.status === "READY" && summary?.ok !== false) {
    await db.prepare("DELETE FROM digest_shadow_hold_overrides WHERE run_day = ?").bind(day).run();
  } else {
    overriddenDigestIds = await readOverrides(db, day);
  }
  const state = buildDigestShadowHoldState({ summary, overriddenDigestIds, now });
  await persistState(db, state);
  await persistLastKnownState(receiptStore, state);
  return state;
}

export async function overrideDigestShadowHold(db, {
  day,
  digestIds,
  reason,
  now = new Date(),
} = {}) {
  const runDay = day || iso(now).slice(0, 10);
  const summary = await readSummary(db, runDay);
  if (!summary) throw new DigestShadowHoldInputError("no digest shadow run exists for the requested day");
  const affected = uniqueIds(summary.affected_digest_ids);
  const requested = uniqueIds(digestIds);
  const invalid = requested.filter((id) => !affected.includes(id));
  if (!requested.length) throw new DigestShadowHoldInputError("digest_ids must name at least one affected digest");
  if (requested.length > 100) throw new DigestShadowHoldInputError("digest_ids exceeds the 100-item override limit");
  if (invalid.length) throw new DigestShadowHoldInputError(`digest_ids are not affected by this run: ${invalid.join(", ")}`);
  const note = String(reason || "").trim();
  if (!note) throw new DigestShadowHoldInputError("reason is required for an operator override");
  if (note.length > 500) throw new DigestShadowHoldInputError("reason exceeds 500 characters");
  const createdAt = iso(now);
  const existing = await readOverrides(db, runDay);
  await db.batch(requested.map((digestId) => db.prepare(`INSERT INTO digest_shadow_hold_overrides
    (run_day, digest_id, created_at, reason)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(run_day, digest_id) DO UPDATE SET
      created_at = excluded.created_at,
      reason = excluded.reason`)
    .bind(runDay, digestId, createdAt, note)));
  const state = buildDigestShadowHoldState({
    summary,
    overriddenDigestIds: uniqueIds([...existing, ...requested]),
    now,
  });
  await persistState(db, state);
  return state;
}
