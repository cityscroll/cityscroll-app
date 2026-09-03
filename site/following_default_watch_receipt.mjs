/**
 * Narrow, same-tab handoff for the homepage default-watch enrollment.
 *
 * The receipt is intentionally short-lived and display-only. It carries a
 * normalized watch projection that can be rendered on the Following page,
 * but it never carries credentials, watch state keys, or email address.
 */

const DAY_MS = 86_400_000;

export const DEFAULT_WATCH_HANDOFF_SCHEMA = "cityscroll.following_default_watch_handoff.v1";
export const DEFAULT_WATCH_HANDOFF_VERSION = 1;
export const DEFAULT_WATCH_HANDOFF_MAX_AGE_MS = 5 * 60 * 1000;
export const DEFAULT_WATCH_HANDOFF_STORAGE_KEY = "cs_default_watch_handoff_v1";

function cleanString(value, max = 400) {
  return String(value ?? "").trim().slice(0, max);
}

function parseJSON(raw) {
  try {
    return typeof raw === "string" ? JSON.parse(raw) : raw;
  } catch {
    return null;
  }
}

function normalizeBool(value) {
  return value === true;
}

function normalizeWatchId(value) {
  return cleanString(value, 120);
}

function normalizeLens(value) {
  return cleanString(value, 40);
}

function normalizeFilter(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return JSON.parse(JSON.stringify(value));
}

function normalizeFreq(value) {
  return cleanString(value, 24) === "weekly" ? "weekly" : "daily";
}

function normalizeUrl(value) {
  return cleanString(value, 200) || "/following/";
}

function hasCredential(value) {
  const text = String(value ?? "").toLowerCase();
  return ["token", "secret", "key", "subscribe", "unsubscribe", "credential", "session"].some((term) => text.includes(term));
}

export function buildFollowingDefaultWatchReceipt({ watch, created = true, now = null } = {}) {
  const safe = {
    schema: DEFAULT_WATCH_HANDOFF_SCHEMA,
    version: DEFAULT_WATCH_HANDOFF_VERSION,
    issued_at: new Date((now ?? Date.now())).toISOString(),
    workstream_card: "FS-16",
    watch: {
      watch_id: normalizeWatchId(watch?.watch_id),
      lens: normalizeLens(watch?.lens),
      filter: normalizeFilter(watch?.filter),
      freq: normalizeFreq(watch?.freq),
      label: cleanString(watch?.label, 400),
      followingUrl: normalizeUrl(watch?.followingUrl),
    },
    created: normalizeBool(created),
  };
  const validation = validateFollowingDefaultWatchReceipt(safe);
  if (validation.ok) return { ...safe, ok: true };
  return { ...safe, ...validation, ok: false };
}

export function validateFollowingDefaultWatchReceipt(value) {
  const errors = [];
  if (value?.schema !== DEFAULT_WATCH_HANDOFF_SCHEMA) errors.push("schema");
  if (value?.version !== DEFAULT_WATCH_HANDOFF_VERSION) errors.push("version");
  if (value?.workstream_card !== "FS-16") errors.push("workstream_card");
  const issuedAt = typeof value?.issued_at === "string" ? Date.parse(value.issued_at) : Number.NaN;
  if (!Number.isFinite(issuedAt)) errors.push("issued_at");
  if (typeof value?.watch !== "object" || value.watch === null) {
    errors.push("watch");
  } else {
    if (!/^[A-Za-z0-9][A-Za-z0-9-:.]*$/.test(String(value.watch.watch_id || ""))) errors.push("watch_id");
    if (!value.watch.lens) errors.push("watch_lens");
    if (!value.watch.filter || typeof value.watch.filter !== "object" || Array.isArray(value.watch.filter)) errors.push("watch_filter");
    if (!["daily", "weekly"].includes(value.watch.freq)) errors.push("watch_freq");
    if (!value.watch.followingUrl || !String(value.watch.followingUrl).startsWith("/")) errors.push("following_url");
    if (hasCredential(value.watch.label) || hasCredential(value.watch.watch_id) || hasCredential(value.watch.followingUrl)) {
      errors.push("credential_leakage");
    }
  }
  if (typeof value?.created !== "boolean") errors.push("created_flag");
  return { ok: errors.length === 0, errors };
}

function defaultStorage(storage = globalThis.sessionStorage) {
  return storage && storage.getItem && storage.setItem && storage.removeItem ? storage : null;
}

export function setFollowingDefaultWatchReceipt(receipt, storage = globalThis.sessionStorage) {
  const store = defaultStorage(storage);
  if (!store) return false;
  const safe = parseJSON(receipt);
  if (!safe || !validateFollowingDefaultWatchReceipt(safe).ok) return false;
  try {
    store.setItem(DEFAULT_WATCH_HANDOFF_STORAGE_KEY, JSON.stringify(safe));
    return true;
  } catch {
    return false;
  }
}

export function readFollowingDefaultWatchReceipt(storage = globalThis.sessionStorage) {
  const store = defaultStorage(storage);
  if (!store) return null;
  const raw = store.getItem(DEFAULT_WATCH_HANDOFF_STORAGE_KEY);
  if (raw == null) return null;
  const parsed = parseJSON(raw);
  return parsed && typeof parsed === "object" ? parsed : null;
}

export function deleteFollowingDefaultWatchReceipt(storage = globalThis.sessionStorage) {
  const store = defaultStorage(storage);
  if (!store) return false;
  try {
    store.removeItem(DEFAULT_WATCH_HANDOFF_STORAGE_KEY);
    return true;
  } catch {
    return false;
  }
}

function ageTooOld(receipt, now = Date.now()) {
  const issued = Date.parse(receipt?.issued_at);
  return !Number.isFinite(issued) || issued + DEFAULT_WATCH_HANDOFF_MAX_AGE_MS < now;
}

export function consumeFollowingDefaultWatchReceipt(storage = globalThis.sessionStorage, now = Date.now()) {
  const raw = readFollowingDefaultWatchReceipt(storage);
  if (!raw) return { ok: false, reason: "missing" };
  deleteFollowingDefaultWatchReceipt(storage);
  const parsed = parseJSON(raw);
  if (!parsed) return { ok: false, reason: "malformed" };
  const validation = validateFollowingDefaultWatchReceipt(parsed);
  if (!validation.ok) return { ok: false, reason: "invalid", errors: validation.errors };
  if (ageTooOld(parsed, now)) return { ok: false, reason: "stale" };
  return { ok: true, receipt: parsed };
}

export function normalizeWatchProjectionForIdentity(watch = {}) {
  return {
    lens: normalizeLens(watch.lens),
    filter: normalizeFilter(watch.filter),
    freq: normalizeFreq(watch.freq),
  };
}

export function sameDefaultWatchIdentity(a = {}, b = {}) {
  const left = normalizeWatchProjectionForIdentity(a);
  const right = normalizeWatchProjectionForIdentity(b);
  return JSON.stringify(left) === JSON.stringify(right);
}
