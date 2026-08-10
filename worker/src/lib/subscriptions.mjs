// Pure helpers for the subscription record — no I/O, fully unit-testable.
//
// A subscription is a standing DELIVERY of a query the user already built in one of the
// site's lenses (money | people | land | property | rules | meetings) to one address, on a
// schedule. "Alerts" is not its own query type — it's this delivery wrapper. The stored
// `filter` is that lens's already-sanitized filter (lib/filter.mjs sanitize()), so the daily
// cron can replay it as a deterministic, free SODA query — no model call per run.

export const CHANNELS = ["email", "sms"];
export const FREQS = ["daily", "weekly"];
// Supported language codes for subscriptions (clamp unknown → "en").
// Extend as new languages ship in i18n.js; email templates must have matching entries.
export const SUPPORTED_LANGS = ["en", "es"];

export function normalizeEmail(raw) {
  return String(raw == null ? "" : raw).trim().toLowerCase();
}

// Deliberately conservative: one @, a dotted domain, no spaces, sane length. We only ever
// send to confirmed addresses anyway; this is the cheap front-door filter.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export function isValidEmail(raw) {
  const e = normalizeEmail(raw);
  return e.length > 0 && e.length <= 254 && EMAIL_RE.test(e);
}

// Build the stored record from validated parts. Channel/freq/lang clamp to safe defaults;
// the caller is responsible for having already sanitize()d `filter` for its lens.
// NOTE: `lang` is intentionally excluded from subCanonical — changing language must not
// create a duplicate watch; it updates the existing record in place (see confirm.mjs).
export function buildSubscription({ email, lens, filter, channel = "email", freq = "daily", lang = "en", now = Date.now() }) {
  return {
    email: normalizeEmail(email),
    lens,
    filter: filter || {},
    channel: CHANNELS.includes(channel) ? channel : "email",
    freq: FREQS.includes(freq) ? freq : "daily",
    lang: SUPPORTED_LANGS.includes(lang) ? lang : "en",
    createdAt: new Date(now).toISOString(),
  };
}

// Immutable carry-forward identities.  `subscriber_id` is account-scoped; `watch_id`
// is scoped to the legacy KV address.  The latter is intentional: the SUBS key remains
// the storage address during this migration, while /prefs may safely mutate its filter.
// Both values are opaque truncated SHA-256 identifiers and never contain the address.
export async function deriveSubscriberId(email) {
  return `subscriber:${await digestHex(normalizeEmail(email))}`;
}

export async function deriveWatchId(legacyKey) {
  return `watch:${await digestHex(String(legacyKey || ""))}`;
}

/**
 * Add missing immutable identity fields to a legacy SUBS record without changing any
 * existing subscription fields.  Existing IDs always win so this is safe to rerun.
 */
export async function ensureSubscriptionIdentity(record, legacyKey) {
  if (!record || typeof record !== "object") return { record, changed: false };
  const next = { ...record };
  let changed = false;
  if (!next.subscriber_id) {
    next.subscriber_id = await deriveSubscriberId(next.email);
    changed = true;
  }
  if (!next.watch_id) {
    next.watch_id = await deriveWatchId(legacyKey);
    changed = true;
  }
  return { record: next, changed };
}

// Canonical string for a (email, lens, filter) triple — hash it for a stable KV id so the
// same alert isn't stored twice. (Hashing is done by the caller via Web Crypto.)
// IMPORTANT: `lang` is deliberately excluded — changing language must not duplicate a watch.
export function subCanonical({ email, lens, filter }) {
  return JSON.stringify({ email: normalizeEmail(email), lens, filter: filter || {} });
}

async function digestHex(value) {
  const data = new TextEncoder().encode(String(value));
  const buf = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(buf)].slice(0, 12).map((b) => b.toString(16).padStart(2, "0")).join("");
}

// For logs: never print a full subscriber address.
export function redactEmail(email) {
  const e = normalizeEmail(email);
  const at = e.indexOf("@");
  if (at < 1) return "***";
  const u = e.slice(0, at);
  return (u.length <= 2 ? u[0] : u.slice(0, 2)) + "***" + e.slice(at);
}
