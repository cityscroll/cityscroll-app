// Bounded recovery for delivered signup emails stranded by the retired double-opt-in gate.
// It writes enrollment + delivery/ops watermarks but sends no welcome and invokes no digest
// compiler. The only input is the committed four-row vetted reconstruction manifest.

import {
  DEPRECATED_OPT_IN_RECOVERY_SOURCE,
  RECOVERY_EXPLANATION,
  SIGNUP_LIFECYCLE,
  buildSubscription,
  deriveSubscriberId,
  deriveWatchId,
  developerTestAccountKey,
  isDeveloperTestEmail,
  isValidEmail,
  normalizeEmail,
  subscriptionKey,
} from "./lib/subscriptions.mjs";
import { appendWatchLog, watchLabel } from "./lib/watchlog.mjs";
import {
  VETTED_DEPRECATED_OPT_IN_RECOVERY_MANIFEST,
  VETTED_RECOVERED_SIGNUP_EMAILS,
} from "./lib/deprecated_opt_in_recovery_manifest.mjs";

export { RECOVERY_EXPLANATION, VETTED_DEPRECATED_OPT_IN_RECOVERY_MANIFEST, VETTED_RECOVERED_SIGNUP_EMAILS };
const RECOVERY_MANIFEST_SIZE = VETTED_DEPRECATED_OPT_IN_RECOVERY_MANIFEST.length;

function validOriginalSignupAt(value) {
  if (typeof value !== "string" || !value.trim()) return false;
  const parsed = new Date(value);
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString() === value;
}

function isEmptyFilter(value) {
  return value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).length === 0;
}

function recoveryMarkerKey(subscriberId) {
  return `recovery:deprecated-double-opt-in:${subscriberId}`;
}

function developerMarkerKey(subscriberId) {
  return developerTestAccountKey(subscriberId);
}

async function readJson(store, key) {
  try {
    const raw = await store.get(key);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function validateRow(row) {
  if (!row || !isValidEmail(row.email)) throw new TypeError("recovery row has an invalid email");
  if (!validOriginalSignupAt(row.original_signup_at)) throw new TypeError("recovery row has an invalid original_signup_at");
  if (isDeveloperTestEmail(row.email)) return;
  if (row.lens !== "money" || !isEmptyFilter(row.filter)) {
    throw new TypeError("recovery is limited to the vetted broad contracts watch");
  }
  if (row.freq !== "weekly") throw new TypeError("recovery is limited to the weekly cadence");
}

async function markDeveloperTestAccount(env, row, recoveredAt) {
  const email = normalizeEmail(row.email);
  const subscriberId = await deriveSubscriberId(email);
  const key = developerMarkerKey(subscriberId);
  const prior = await readJson(env.SUBS, key);
  if (!prior) {
    await env.SUBS.put(key, JSON.stringify({
      email,
      subscriber_id: subscriberId,
      status: "developer/test",
      signup_lifecycle: SIGNUP_LIFECYCLE.TEST,
      developer_test: true,
      source: DEPRECATED_OPT_IN_RECOVERY_SOURCE,
      reason: "plus-tagged scope-watch/e2e account; excluded from real enrollment and digest delivery",
      original_signup_at: row.original_signup_at,
      marked_at: recoveredAt,
    }));
  }
  return { status: prior ? "already-marked-developer-test" : "marked-developer-test", subscriber_id: subscriberId };
}

async function recoverOne(env, row, recoveredAt) {
  validateRow(row);
  if (isDeveloperTestEmail(row.email)) return markDeveloperTestAccount(env, row, recoveredAt);

  const candidate = buildSubscription({
    email: row.email,
    lens: "money",
    filter: {},
    freq: "weekly",
    lang: row.lang || "en",
    now: Date.parse(row.original_signup_at),
  });
  const key = await subscriptionKey(candidate);
  const subscriberId = await deriveSubscriberId(candidate.email);
  const markerKey = recoveryMarkerKey(subscriberId);
  const completed = await readJson(env.SUBS, markerKey);
  if (completed?.status === "recovered") return { status: "already-recovered", key, subscriber_id: subscriberId };

  const existing = await readJson(env.SUBS, key);
  const recoveryTime = existing?.source === DEPRECATED_OPT_IN_RECOVERY_SOURCE
    ? (existing?.recovered_at || recoveredAt)
    : recoveredAt;
  const record = {
    ...candidate,
    subscriber_id: existing?.subscriber_id || subscriberId,
    watch_id: existing?.watch_id || await deriveWatchId(key),
    source: DEPRECATED_OPT_IN_RECOVERY_SOURCE,
    signup_lifecycle: SIGNUP_LIFECYCLE.RECOVERED,
    status: SIGNUP_LIFECYCLE.PENDING_ENROLLMENT,
    original_signup_at: row.original_signup_at,
    recovered_at: recoveryTime,
    delivery_not_before: recoveryTime,
    recovery_explanation: RECOVERY_EXPLANATION,
  };
  await env.SUBS.put(key, JSON.stringify(record));
  await env.ALERT_STATE.put(`lastsent:${key}`, recoveryTime.slice(0, 10));
  const logged = await appendWatchLog(env, {
    action: "subscribe",
    email: record.email,
    subKey: key,
    lens: record.lens,
    label: watchLabel(record),
    freq: record.freq,
    source: record.source,
    detail: RECOVERY_EXPLANATION,
    originalSignupAt: record.original_signup_at,
    recoveredAt: record.recovered_at,
    at: record.recovered_at,
  });
  if (!logged) throw new Error("recovery ops receipt could not be stored");
  await env.SUBS.put(markerKey, JSON.stringify({
    status: "recovered",
    sub_key: key,
    subscriber_id: subscriberId,
    recovered_at: recoveryTime,
  }));
  return { status: "recovered", key, subscriber_id: subscriberId };
}

export async function recoverDeprecatedDoubleOptIn(env, rowsOrOptions, maybeOptions = {}) {
  if (!env?.SUBS || !env?.ALERT_STATE) throw new TypeError("SUBS and ALERT_STATE are required");
  const options = Array.isArray(rowsOrOptions) ? maybeOptions : (rowsOrOptions || {});
  const rows = VETTED_DEPRECATED_OPT_IN_RECOVERY_MANIFEST;
  if (rows.length !== RECOVERY_MANIFEST_SIZE) {
    throw new TypeError(`recovery manifest must contain exactly ${RECOVERY_MANIFEST_SIZE} rows`);
  }
  rows.forEach(validateRow);
  const distinct = new Set(rows.map((row) => normalizeEmail(row.email)));
  if (distinct.size !== RECOVERY_MANIFEST_SIZE) throw new TypeError("recovery manifest contains duplicate addresses");
  if (rows.filter((row) => isDeveloperTestEmail(row.email)).length !== 1) {
    throw new TypeError("recovery manifest must contain exactly one scope-watch/e2e developer account");
  }
  const recoveredAt = new Date(options.now || Date.now()).toISOString();
  const results = [];
  for (const row of rows) results.push(await recoverOne(env, row, recoveredAt));
  return {
    recovered_at: recoveredAt,
    results,
    recovered: results.filter((row) => row.status === "recovered").length,
    already_recovered: results.filter((row) => row.status === "already-recovered").length,
    developer_test: results.filter((row) =>
      row.status === "marked-developer-test" || row.status === "already-marked-developer-test").length,
    emails: [...VETTED_RECOVERED_SIGNUP_EMAILS],
  };
}
