// Operational audit trail for watch lifecycle changes.
// Stored in ALERT_STATE as one UTC-day array plus a bounded latest view.

import { redactEmail } from "./subscriptions.mjs";

export const WATCHLOG_LATEST_KEY = "watchlog:latest";
export const WATCHLOG_LATEST_LIMIT = 100;

function dayFor(at) {
  return String(at).slice(0, 10);
}

function maskKey(key) {
  if (typeof key !== "string") return undefined;
  return key.replace(/^(sub:)([^@:]{0,2})[^@:]*/, "$1$2***");
}

/** Append one redacted lifecycle event; logging is fail-soft when the binding is absent. */
export async function appendWatchLog(env, { action, email, subKey, lens, label, source, at = new Date().toISOString() }) {
  if (!env?.ALERT_STATE || !action || !email || !source) return;
  const event = {
    at,
    action,
    emailRedacted: redactEmail(email),
    source,
  };
  const masked = maskKey(subKey);
  if (masked) event.subKeyMasked = masked;
  if (lens) event.lens = lens;
  if (label) event.label = label;

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
  } catch { /* the audit trail must not block the user's lifecycle change */ }
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
