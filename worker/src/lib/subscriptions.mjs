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

// Canonical string for a (email, lens, filter) triple — hash it for a stable KV id so the
// same alert isn't stored twice. (Hashing is done by the caller via Web Crypto.)
// IMPORTANT: `lang` is deliberately excluded — changing language must not duplicate a watch.
export function subCanonical({ email, lens, filter }) {
  return JSON.stringify({ email: normalizeEmail(email), lens, filter: filter || {} });
}

// For logs: never print a full subscriber address.
export function redactEmail(email) {
  const e = normalizeEmail(email);
  const at = e.indexOf("@");
  if (at < 1) return "***";
  const u = e.slice(0, at);
  return (u.length <= 2 ? u[0] : u.slice(0, 2)) + "***" + e.slice(at);
}
