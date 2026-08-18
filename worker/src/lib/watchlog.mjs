// Operational audit trail for watch lifecycle changes.
// Stored in ALERT_STATE as one UTC-day array plus a bounded latest view.

import { redactEmail } from "./subscriptions.mjs";
import { describeFilter } from "./confirm_email.mjs";
import { appendActionLog } from "./action_log.mjs";

export const WATCHLOG_LATEST_KEY = "watchlog:latest";
export const WATCHLOG_LATEST_LIMIT = 100;

function dayFor(at) {
  return String(at).slice(0, 10);
}

export function maskKey(key) {
  if (typeof key !== "string") return undefined;
  return key.replace(/^(sub:)([^@:]{0,2})[^@:]*/, "$1$2***");
}

export function watchLabel(record) {
  if (!record || typeof record !== "object") return undefined;
  if (record.lens) return describeFilter(record.lens, record.filter);
  return nonEmptyString(record.label);
}

export function watchSnapshot(record) {
  if (!record || typeof record !== "object") return undefined;
  const snapshot = {};
  const label = watchLabel(record) || nonEmptyString(record.label);
  const freq = nonEmptyString(record.freq);
  if (label) snapshot.label = label;
  if (freq) snapshot.freq = freq;
  if (typeof record.paused === "boolean") snapshot.paused = record.paused;
  else snapshot.paused = false;
  return Object.keys(snapshot).length ? snapshot : undefined;
}

export function updateDetail(beforeRecord, afterRecord) {
  const before = watchSnapshot(beforeRecord) || {};
  const after = watchSnapshot(afterRecord) || {};
  const changes = [];
  if (before.freq && after.freq && before.freq !== after.freq) {
    changes.push(`freq ${before.freq} → ${after.freq}`);
  }
  if (before.label && after.label && before.label !== after.label) {
    changes.push(`filter: ${before.label} → ${after.label}`);
  }
  if (before.paused !== after.paused) {
    changes.push(`${before.paused ? "paused" : "active"} → ${after.paused ? "paused" : "active"}`);
  }
  return changes.join("; ") || undefined;
}

/** Pure retrofit helper. Existing fields win; only events without a human label are enriched. */
export function enrichWatchLogEvents(events, liveSubsByMask, overrides = []) {
  let enriched = 0;
  const output = (Array.isArray(events) ? events : []).map((event) => {
    if (!event || nonEmptyString(event.label)) return event;
    const override = matchingOverride(event, overrides);
    const record = liveSubsByMask?.get?.(event.subKeyMasked);
    const label = nonEmptyString(override?.label) || watchLabel(record);
    if (!label) return event;
    const next = { ...event, label };
    const freq = nonEmptyString(override?.freq) || nonEmptyString(record?.freq);
    const detail = nonEmptyString(override?.detail);
    if (freq) next.freq = freq;
    if (detail) next.detail = detail;
    enriched++;
    return next;
  });
  return { events: output, enriched, unchanged: output.length - enriched };
}

function matchingOverride(event, overrides) {
  return (Array.isArray(overrides) ? overrides : []).find((candidate) => {
    if (!candidate || !nonEmptyString(candidate.label)) return false;
    const selectors = ["at", "subKeyMasked", "action"].filter((key) => candidate[key] != null);
    return selectors.length > 0 && selectors.every((key) => candidate[key] === event[key]);
  });
}

function cleanSnapshot(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const clean = {};
  const label = nonEmptyString(value.label);
  const freq = nonEmptyString(value.freq);
  if (label) clean.label = label;
  if (freq) clean.freq = freq;
  if (typeof value.paused === "boolean") clean.paused = value.paused;
  return Object.keys(clean).length ? clean : undefined;
}

function nonEmptyString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/** Append one redacted lifecycle event; logging is fail-soft when the binding is absent. */
export async function appendWatchLog(env, {
  action, email, subKey, lens, label, freq, detail, before, after, source,
  originalSignupAt, recoveredAt,
  at = new Date().toISOString(),
}) {
  const actionType = {
    subscribe: "watch_confirmed",
    update: "watch_updated",
    pause: "watch_paused",
    unpause: "watch_resumed",
    delete: "watch_removed",
    unsubscribe: "watch_removed",
    unsub_all: "watch_removed",
  }[action];
  if (actionType) {
    const methodName = action === "subscribe"
      ? (source === "legacy-confirm"
        ? "legacy_double_opt_in"
        : source === "recovered-from-deprecated-double-opt-in"
          ? "deprecated_double_opt_in_recovery"
          : "single_opt_in")
      : (source === "prefs" ? "preference_center" : "unsubscribe");
    await appendActionLog(env, {
      action_type: actionType,
      object: { type: "watch", id: lens || "topicless" },
      method: { name: methodName, version: "v1" },
      metadata: { lens, freq, source, original_signup_at: originalSignupAt, recovered_at: recoveredAt },
      ts: at,
    });
  }
  if (!env?.ALERT_STATE || !action || !email || !source) return false;
  const event = {
    at,
    action,
    emailRedacted: redactEmail(email),
    source,
  };
  const masked = maskKey(subKey);
  if (masked) event.subKeyMasked = masked;
  if (lens) event.lens = lens;
  const cleanLabel = nonEmptyString(label);
  const cleanFreq = nonEmptyString(freq);
  const cleanDetail = nonEmptyString(detail);
  const cleanBefore = cleanSnapshot(before);
  const cleanAfter = cleanSnapshot(after);
  if (cleanLabel) event.label = cleanLabel;
  if (cleanFreq) event.freq = cleanFreq;
  if (cleanDetail) event.detail = cleanDetail;
  if (nonEmptyString(originalSignupAt)) event.original_signup_at = originalSignupAt;
  if (nonEmptyString(recoveredAt)) event.recovered_at = recoveredAt;
  if (cleanBefore) event.before = cleanBefore;
  if (cleanAfter) event.after = cleanAfter;

  const dayKey = `watchlog:${dayFor(at)}`;
  try {
    let day = [];
    let latest = [];
    try { day = parseArray(await env.ALERT_STATE.get(dayKey)); } catch { /* best effort */ }
    try { latest = parseArray(await env.ALERT_STATE.get(WATCHLOG_LATEST_KEY)); } catch { /* best effort */ }
    day.push(event);
    latest.push(event);
    await Promise.all([
      env.ALERT_STATE.put(dayKey, JSON.stringify(day)),
      env.ALERT_STATE.put(WATCHLOG_LATEST_KEY, JSON.stringify(latest.slice(-WATCHLOG_LATEST_LIMIT))),
    ]);
    return true;
  } catch {
    // Ordinary lifecycle writes are fail-soft; recovery callers use the false return to retry.
    return false;
  }
}

export async function readWatchLog(env, days = 7, now = new Date()) {
  if (!env?.ALERT_STATE) return [];
  const count = Math.max(1, Math.min(31, Number(days) || 7));
  const events = [];
  const cursor = new Date(now);
  cursor.setUTCHours(0, 0, 0, 0);
  for (let i = 0; i < count; i++) {
    const day = cursor.toISOString().slice(0, 10);
    try { events.push(...parseArray(await env.ALERT_STATE.get(`watchlog:${day}`))); } catch { /* skip unavailable day */ }
    cursor.setUTCDate(cursor.getUTCDate() - 1);
  }
  return events.sort((a, b) => String(b.at).localeCompare(String(a.at)));
}

function parseArray(raw) {
  try {
    const value = JSON.parse(raw || "[]");
    return Array.isArray(value) ? value : [];
  } catch {
    return [];
  }
}
