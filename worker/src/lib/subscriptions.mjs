// Pure helpers for the subscription record — no I/O, fully unit-testable.
//
// A subscription is a standing DELIVERY of a query the user already built in one of the
// site's lenses (money | people | land | property | rules | meetings) to one address, on a
// schedule. "Alerts" is not its own query type — it's this delivery wrapper. The stored
// `filter` is that lens's already-sanitized filter (lib/filter.mjs sanitize()), so the daily
// cron can replay it as a deterministic, free SODA query — no model call per run.

export const CHANNELS = ["email", "sms"];
export const FREQS = ["daily", "weekly"];
export const TOPICLESS_SOURCE = "top-of-site";
export const TOPICLESS_STATES = Object.freeze(["confirmed"]);
export const DEPRECATED_OPT_IN_RECOVERY_SOURCE = "recovered-from-deprecated-double-opt-in";
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

/** Plus-tagged automation accounts are evidence, not real digest subscribers. */
export function isDeveloperTestEmail(raw) {
  const email = normalizeEmail(raw);
  const local = email.slice(0, email.indexOf("@"));
  const plus = local.indexOf("+");
  if (plus < 0) return false;
  const tag = local.slice(plus + 1);
  return /(?:^|[-_.])(?:scope-watch|e2e)(?:$|[-_.])/.test(tag);
}

export const SIGNUP_LIFECYCLE = Object.freeze({
  RECOVERED: "recovered",
  PENDING_ENROLLMENT: "pending-enrollment",
  ENROLLED: "enrolled",
  CONFIRMED: "confirmed",
  TEST: "test",
  // A sender on the product's own outbound sending domain (or a subdomain of it). These are
  // the app's own mail infrastructure looping back, never a person — kept in their own bucket
  // so the ops view separates them from real users at a glance.
  SELF_ORIGIN: "self-origin",
});

// The product's own outbound (transactional email) domains. Any address on one of these — or
// on any subdomain such as send.cityscroll.org — is our own machinery, never a subscriber. The
// set is the canonical apex plus the legacy compatibility apex the product is migrating away
// from; the compatibility apex is composed from its label parts so the retiring alias is
// defined here once rather than copied as a literal into new modules.
const COMPAT_APEX = `${["crol", "list"].join("-")}.org`;
export const OWNED_EMAIL_DOMAINS = Object.freeze(["cityscroll.org", COMPAT_APEX]);

/** True when an address is on an owned sending domain or any subdomain of one. */
export function isSelfOriginEmail(raw) {
  const email = normalizeEmail(raw);
  const at = email.lastIndexOf("@");
  if (at < 0) return false;
  const host = email.slice(at + 1);
  return OWNED_EMAIL_DOMAINS.some((domain) => host === domain || host.endsWith(`.${domain}`));
}

export const RECOVERY_EXPLANATION = "signed up in the legacy pre-double-opt-in period, has not been sent an email yet, and will be emailed starting the next scheduled digest";

/** Marker-only KV key for plus-tagged automation accounts that must not become watches. */
export function developerTestAccountKey(subscriberId) {
  return `developer-test-account:${subscriberId}`;
}

export function isTestSubscriber(record) {
  if (!record || typeof record !== "object") return false;
  return record.developer_test === true
    || record.status === "developer/test"
    || record.signup_lifecycle === SIGNUP_LIFECYCLE.TEST
    || record.signup_lifecycle === SIGNUP_LIFECYCLE.SELF_ORIGIN
    || isDeveloperTestEmail(record.email)
    || isSelfOriginEmail(record.email);
}

export function isRealSubscriber(record) {
  return !!record && typeof record === "object" && !isTestSubscriber(record);
}

function isoDay(value) {
  const match = /^(\d{4}-\d{2}-\d{2})/.exec(String(value || ""));
  return match ? match[1] : null;
}

/** True only after a send day later than the recovery watermark (same-day lastsent is the watermark). */
export function recoveredSignupReceivedDigest(record, lastSent) {
  const watermark = isoDay(record?.delivery_not_before || record?.recovered_at);
  const sent = isoDay(lastSent);
  return !!(watermark && sent && sent > watermark);
}

/**
 * Ops-visibility projector: recovered / pending-enrollment / enrolled / confirmed / test.
 * Recovered rows stay pending-enrollment until a digest day after the recovery watermark.
 */
export function signupLifecycleFromRecord(record, { lastSent = null } = {}) {
  if (!record || typeof record !== "object") return null;
  // Self-origin is checked before the generic test bucket so the app's own sending-domain
  // addresses land in their own ops panel rather than being folded in with e2e fixtures.
  if (isSelfOriginEmail(record.email) || record.signup_lifecycle === SIGNUP_LIFECYCLE.SELF_ORIGIN) {
    return {
      signup_lifecycle: SIGNUP_LIFECYCLE.SELF_ORIGIN,
      status: SIGNUP_LIFECYCLE.SELF_ORIGIN,
    };
  }
  if (isTestSubscriber(record)) {
    return {
      signup_lifecycle: SIGNUP_LIFECYCLE.TEST,
      status: SIGNUP_LIFECYCLE.TEST,
    };
  }
  if (record.source === DEPRECATED_OPT_IN_RECOVERY_SOURCE) {
    if (recoveredSignupReceivedDigest(record, lastSent)) {
      return {
        signup_lifecycle: SIGNUP_LIFECYCLE.ENROLLED,
        status: SIGNUP_LIFECYCLE.ENROLLED,
      };
    }
    return {
      signup_lifecycle: SIGNUP_LIFECYCLE.RECOVERED,
      status: SIGNUP_LIFECYCLE.PENDING_ENROLLMENT,
    };
  }
  if (isTopiclessIntent(record) || record.state === "confirmed") {
    return {
      signup_lifecycle: SIGNUP_LIFECYCLE.CONFIRMED,
      status: SIGNUP_LIFECYCLE.CONFIRMED,
    };
  }
  return {
    signup_lifecycle: SIGNUP_LIFECYCLE.ENROLLED,
    status: SIGNUP_LIFECYCLE.ENROLLED,
  };
}

/** Closed ops-visibility buckets: recovered stays intermediate until a later digest day. */
export const SIGNUP_LIFECYCLE_CATEGORY = Object.freeze({
  RECOVERED_PENDING: "recovered_pending",
  ENROLLED: "enrolled",
  CONFIRMED: "confirmed",
  TEST: "test",
  SELF_ORIGIN: "self_origin",
});

export const SIGNUP_LIFECYCLE_CATEGORY_ORDER = Object.freeze([
  SIGNUP_LIFECYCLE_CATEGORY.RECOVERED_PENDING,
  SIGNUP_LIFECYCLE_CATEGORY.ENROLLED,
  SIGNUP_LIFECYCLE_CATEGORY.CONFIRMED,
  SIGNUP_LIFECYCLE_CATEGORY.TEST,
  SIGNUP_LIFECYCLE_CATEGORY.SELF_ORIGIN,
]);

export const SIGNUP_LIFECYCLE_CATEGORY_LABELS = Object.freeze({
  recovered_pending: "recovered / pending-enrollment",
  enrolled: "enrolled",
  confirmed: "confirmed",
  test: "test",
  self_origin: "machine / self-origin",
});

export function signupLifecycleBucket(row) {
  if (!row || typeof row !== "object") return null;
  const status = row.status;
  const life = row.signup_lifecycle;
  if (status === SIGNUP_LIFECYCLE.SELF_ORIGIN || life === SIGNUP_LIFECYCLE.SELF_ORIGIN) {
    return SIGNUP_LIFECYCLE_CATEGORY.SELF_ORIGIN;
  }
  if (status === SIGNUP_LIFECYCLE.TEST || life === SIGNUP_LIFECYCLE.TEST) {
    return SIGNUP_LIFECYCLE_CATEGORY.TEST;
  }
  if (life === SIGNUP_LIFECYCLE.RECOVERED || status === SIGNUP_LIFECYCLE.PENDING_ENROLLMENT) {
    return SIGNUP_LIFECYCLE_CATEGORY.RECOVERED_PENDING;
  }
  if (status === SIGNUP_LIFECYCLE.CONFIRMED || life === SIGNUP_LIFECYCLE.CONFIRMED) {
    return SIGNUP_LIFECYCLE_CATEGORY.CONFIRMED;
  }
  if (status === SIGNUP_LIFECYCLE.ENROLLED || life === SIGNUP_LIFECYCLE.ENROLLED) {
    return SIGNUP_LIFECYCLE_CATEGORY.ENROLLED;
  }
  return null;
}

export function formatSignupLifecycleSummary(counts = {}) {
  const recoveredPending = Number(counts.recovered_pending) || 0;
  const enrolled = Number(counts.enrolled) || 0;
  const confirmed = Number(counts.confirmed) || 0;
  const parts = [];
  if (recoveredPending) parts.push(`${recoveredPending} recovered, pending`);
  if (enrolled) parts.push(`${enrolled} enrolled`);
  if (confirmed) parts.push(`${confirmed} confirmed`);
  return parts.join(" · ") || "No signups";
}

/**
 * Category view over already-projected ops rows (status + signup_lifecycle).
 * Recovered rows stay in recovered_pending until a digest day after the watermark.
 */
export function summarizeSignupLifecycle(rows = []) {
  const groups = {
    recovered_pending: [],
    enrolled: [],
    confirmed: [],
    test: [],
    self_origin: [],
  };
  for (const row of rows) {
    const bucket = signupLifecycleBucket(row);
    if (bucket) groups[bucket].push(row);
  }
  const counts = {
    recovered_pending: groups.recovered_pending.length,
    enrolled: groups.enrolled.length,
    confirmed: groups.confirmed.length,
    test: groups.test.length,
    self_origin: groups.self_origin.length,
  };
  return {
    ...counts,
    groups,
    summary: formatSignupLifecycleSummary(counts),
    categories: SIGNUP_LIFECYCLE_CATEGORY_ORDER.map((id) => ({
      id,
      label: SIGNUP_LIFECYCLE_CATEGORY_LABELS[id],
      count: counts[id],
      rows: groups[id],
    })),
  };
}

/**
 * Recovered watches start at recovery, not at the beginning of the query's open-result set.
 * Rows without a trustworthy source day fail closed on this one migration-only boundary.
 */
export function rowAfterDeliveryNotBefore(record, row) {
  const boundary = record?.delivery_not_before;
  if (!boundary) return true;
  const observed = row?.start_date || row?.observed_at || row?.source_observed_at;
  const boundaryDay = String(boundary).slice(0, 10);
  const observedDay = String(observed || "").slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(boundaryDay) || !/^\d{4}-\d{2}-\d{2}$/.test(observedDay)) return false;
  return observedDay > boundaryDay;
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

/** Build the disclosed weekly-contracts default created by the topicless homepage CTA. */
export function buildTopiclessIntent({ email, source = TOPICLESS_SOURCE, lang = "en", now = Date.now() }) {
  const at = new Date(now).toISOString();
  return {
    email: normalizeEmail(email),
    no_topic: true,
    no_topic_default: true,
    source,
    state: "confirmed",
    lens: "money",
    filter: {},
    channel: "email",
    freq: "weekly",
    lang: SUPPORTED_LANGS.includes(lang) ? lang : "en",
    createdAt: at,
    confirmedAt: at,
    updatedAt: at,
  };
}

/** Only new, explicitly marked homepage intents qualify; legacy money/{} stays untouched. */
export function isTopiclessIntent(record) {
  return !!record
    && record.no_topic === true
    && record.source === TOPICLESS_SOURCE
    && TOPICLESS_STATES.includes(record.state);
}

/** Stable per-address key: repeated homepage requests refresh the same marked default watch. */
export async function topiclessIntentKey(email, source = TOPICLESS_SOURCE) {
  const canonical = JSON.stringify({ email: normalizeEmail(email), no_topic: true, source });
  return `sub:${(await digestHex(canonical)).slice(0, 16)}`;
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

/** Stable KV key shared by immediate signup and legacy confirmation-link replay. */
export async function subscriptionKey(sub) {
  return `sub:${(await digestHex(subCanonical(sub))).slice(0, 16)}`;
}

async function digestHex(value) {
  const data = new TextEncoder().encode(String(value));
  const buf = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(buf)].slice(0, 12).map((b) => b.toString(16).padStart(2, "0")).join("");
}

// For shared/less-trusted logs only (Cloudflare console, inbound traces).
// Authenticated operator surfaces must store and display the full address.
export function redactEmail(email) {
  const e = normalizeEmail(email);
  const at = e.indexOf("@");
  if (at < 1) return "***";
  const u = e.slice(0, at);
  return (u.length <= 2 ? u[0] : u.slice(0, 2)) + "***" + e.slice(at);
}

/**
 * Truncate sub:/rl:addr:/account: keys for shared logs.
 * Two hex chars are only 256-way and collide on the live roster — never use this
 * on authenticated desk/admin/ops responses.
 */
export function maskKeyForLog(key) {
  if (typeof key !== "string" || !key) return key;
  return key.replace(/^(sub:|rl:addr:|account:)([^@:]{0,2})[^@:]*/, "$1$2***");
}

/** Mask subscription identity on a digest result before it hits a shared log sink. */
export function maskDigestResultForLog(result) {
  if (!result || typeof result !== "object") return result;
  const out = { ...result };
  for (const field of ["sub", "key", "subKey", "watch"]) {
    if (typeof out[field] === "string") out[field] = maskKeyForLog(out[field]);
  }
  if (typeof out.email === "string") out.email = redactEmail(out.email);
  if (Array.isArray(out.sections)) out.sections = out.sections.map(maskDigestResultForLog);
  if (Array.isArray(out.results)) out.results = out.results.map(maskDigestResultForLog);
  return out;
}
