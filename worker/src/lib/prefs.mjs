// Pure helpers for the preference center (magic-link watch management).
//
// Auth is a purpose-scoped optin-token: { sc: "prefs", e: <email> }.
// Edits write immediately to SUBS KV; delivery reads SUBS on the next daily cron
// (~13:00 UTC / ~9am Eastern) — document that cutover on every prefs surface.
//
// No passwords / full accounts — identity is the confirmed email only.

import { normalizeEmail, FREQS, SUPPORTED_LANGS } from "./subscriptions.mjs";
import { sanitize } from "./filter.mjs";
import { describeFilter } from "./confirm_email.mjs";

export const PREFS_SCOPE = "prefs";
/** Preference-center link lifetime (~60 days — same order as unsubscribe links). */
export const PREFS_TOKEN_TTL_SECONDS = 60 * 24 * 3600;
/** Max watches listed/edited in one prefs session (denial-of-wallet / page size). */
export const PREFS_MAX_WATCHES = 40;

/** Pref edits land in SUBS immediately; digests read SUBS on the next cron. */
export const CUTOVER_COPY =
  "Changes apply to the next digest (about 9am Eastern).";

/** Unsubscribe removes watches immediately (not gated on the next digest). */
export const UNSUB_IMMEDIATE_COPY =
  "Unsubscribe takes effect immediately.";

/** Documented heartbeat contract for daily watches (not user-tunable without product OK). */
export const HEARTBEAT_HELP_COPY =
  "If a daily watch is quiet for 14 days, we send a still-watching note so silence never looks like an outage.";

export function prefsPayload(email) {
  return { e: normalizeEmail(email), sc: PREFS_SCOPE };
}

export function isPrefsPayload(payload) {
  if (!payload || typeof payload !== "object") return false;
  if (payload.sc !== PREFS_SCOPE) return false;
  const e = normalizeEmail(payload.e);
  return e.length > 0 && e.includes("@");
}

/**
 * Shape one SUBS record for the preference center (no secrets).
 * key is required for edit/delete actions.
 */
export function toPrefsWatchRow(sub, key) {
  if (!sub || typeof sub !== "object") return null;
  const k = key || sub.key || null;
  if (!k) return null;
  const lens = sub.lens || null;
  const filter = sub.filter || {};
  return {
    key: k,
    lens,
    filter,
    query: describeFilter(lens, filter),
    freq: FREQS.includes(sub.freq) ? sub.freq : "daily",
    lang: SUPPORTED_LANGS.includes(sub.lang) ? sub.lang : "en",
    paused: !!sub.paused,
    createdAt: sub.createdAt || null,
    channel: sub.channel || "email",
  };
}

/**
 * Apply a preference-center patch to a stored subscription record.
 * Returns { ok, record } or { ok:false, reason }.
 *
 * Allowed fields: freq, paused, filter (re-sanitized for the existing lens),
 * lang. Email and lens are immutable here (lens change = new watch via signup).
 */
export function applyWatchPatch(record, patch = {}) {
  if (!record || typeof record !== "object") return { ok: false, reason: "missing" };
  const next = { ...record };
  if (patch.freq != null) {
    if (!FREQS.includes(patch.freq)) return { ok: false, reason: "bad-freq" };
    next.freq = patch.freq;
  }
  if (patch.paused != null) {
    next.paused = !!patch.paused;
  }
  if (patch.lang != null) {
    next.lang = SUPPORTED_LANGS.includes(patch.lang) ? patch.lang : "en";
  }
  if (patch.filter != null && typeof patch.filter === "object") {
    const lens = next.lens;
    if (!lens) return { ok: false, reason: "bad-lens" };
    // Merge into existing filter so partial keyword edits work, then sanitize.
    const merged = { ...(next.filter || {}), ...patch.filter };
    next.filter = sanitize(lens, merged);
  }
  // Keyword-only convenience: { keywords: [...] } without full filter object.
  if (Array.isArray(patch.keywords) && next.lens) {
    const merged = { ...(next.filter || {}), keywords: patch.keywords };
    next.filter = sanitize(next.lens, merged);
  }
  return { ok: true, record: next };
}

/**
 * Parse a preference-center form/JSON action body.
 * action: list | update | pause | unpause | delete | unsub_all
 */
export function parsePrefsAction(body = {}) {
  const action = String(body.action || "list").toLowerCase();
  const key = typeof body.key === "string" && body.key.startsWith("sub:") ? body.key : null;
  const patch = {};
  if (body.freq != null) patch.freq = body.freq;
  if (body.paused != null) patch.paused = body.paused === true || body.paused === "true" || body.paused === "1";
  if (body.lang != null) patch.lang = body.lang;
  if (body.filter && typeof body.filter === "object") patch.filter = body.filter;
  if (body.keywords != null) {
    // Accept comma-separated string or array.
    if (typeof body.keywords === "string") {
      patch.keywords = body.keywords.split(/[,/]/).map((s) => s.trim()).filter(Boolean);
    } else if (Array.isArray(body.keywords)) {
      patch.keywords = body.keywords;
    }
  }
  return { action, key, patch };
}
