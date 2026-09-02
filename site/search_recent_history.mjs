/**
 * Bounded browser-local recent Search history.
 *
 * An entry is navigation metadata over a canonical Search path — what the reader
 * typed, where it took them, and when — and nothing else. Reopening one simply
 * follows the canonical URL so Search executes normally; there is no second
 * result store, no second search path, and no identity here. The private
 * search-execution receipt (`capabilities/search_activity.mjs`) remains the only
 * stored evidence of what a search actually served.
 *
 * Everything fails soft by construction. A blocked, full, or hostile storage, and
 * any malformed persisted value, degrade to "no history" and never to a broken
 * Search: every exported function catches its own storage access, and every read
 * re-validates what it found instead of trusting it.
 */

import {
  SEARCH_ACTIVITY_CANONICAL_SEARCH_PATH,
  SEARCH_ACTIVITY_MAX_QUERY_LENGTH,
  SEARCH_ACTIVITY_SCOPE_KEYS,
  cleanReceiptText,
  receiptInstant,
} from "../capabilities/search_activity.mjs";

export const SEARCH_RECENT_HISTORY_SCHEMA = "cityscroll.search_recent_history.v1";
export const SEARCH_RECENT_HISTORY_STORAGE_KEY = "crol_search_recent_v1";

/** Ten entries is the whole product promise; an eleventh evicts the oldest. */
export const SEARCH_RECENT_HISTORY_LIMIT = 10;

/** Resident labels for the place context a canonical Search path can carry. */
export const SEARCH_RECENT_SCOPE_LABELS = Object.freeze({
  boro: "Borough",
  cd: "Community district",
  council: "Council district",
  neighborhood: "Neighborhood",
  scope: "Area",
});

const STORE_KEYS = Object.freeze(["schema", "entries"]);
const ENTRY_KEYS = Object.freeze([
  "query",
  "path",
  "scope",
  "executed_at",
  "search_execution_id",
]);

/**
 * The Worker mints `exec_` followed by base64url. Bounded and opaque: an
 * execution id is accepted only when it looks like one this system issues, so a
 * tampered store cannot smuggle markup, a URL, or an identifier of another kind
 * into an entry.
 */
const EXECUTION_ID_PATTERN = /^exec_[A-Za-z0-9_-]{16,64}$/;

/** Control characters and a backslash are never part of a canonical path. */
const UNSAFE_PATH_CHARACTERS = /[\u0000-\u001f\u007f\\]/;

const CANONICAL_PREFIX = `${SEARCH_ACTIVITY_CANONICAL_SEARCH_PATH}?`;

function plainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function unknownKey(candidate, allowed) {
  return Object.keys(candidate).some((key) => !allowed.includes(key));
}

/** Place context, bounded per key exactly as the receipt contract bounds it. */
function boundedScope(scope) {
  const bounded = {};
  if (!plainObject(scope)) return bounded;
  for (const key of SEARCH_ACTIVITY_SCOPE_KEYS) {
    const value = cleanReceiptText(scope[key], 80);
    if (value) bounded[key] = value;
  }
  return bounded;
}

/**
 * Build the canonical Search path for one execution: the query first, then place
 * context in contract order. Key order is fixed so the same search always
 * produces the same path and therefore deduplicates against itself.
 */
export function canonicalRecentSearchPath({ query, scope } = {}) {
  const text = cleanReceiptText(query, SEARCH_ACTIVITY_MAX_QUERY_LENGTH);
  if (!text) return null;
  const params = new URLSearchParams();
  params.set("q", text);
  const bounded = boundedScope(scope);
  for (const key of SEARCH_ACTIVITY_SCOPE_KEYS) {
    if (bounded[key]) params.set(key, bounded[key]);
  }
  return `${CANONICAL_PREFIX}${params}`;
}

/**
 * Accept a persisted path only if it is a root-relative canonical Search route
 * that re-derives to itself. A root-relative `/search/?…` can only ever be
 * same-origin, and round-tripping it through the builder rejects anything
 * carrying a fragment, an unsupported parameter, a different route, or a
 * different parameter order — malformed history, not a smaller one.
 */
export function normalizeRecentSearchPath(value) {
  const raw = String(value ?? "");
  if (!raw.startsWith(CANONICAL_PREFIX)) return null;
  if (UNSAFE_PATH_CHARACTERS.test(raw) || raw.includes("..")) return null;
  const params = new URLSearchParams(raw.slice(CANONICAL_PREFIX.length));
  const scope = {};
  for (const key of SEARCH_ACTIVITY_SCOPE_KEYS) scope[key] = params.get(key);
  const rebuilt = canonicalRecentSearchPath({ query: params.get("q"), scope });
  return rebuilt === raw ? rebuilt : null;
}

/** The place context a canonical path represents, read back from the path itself. */
export function recentSearchScope(path) {
  const params = new URLSearchParams(String(path ?? "").slice(CANONICAL_PREFIX.length));
  const scope = {};
  for (const key of SEARCH_ACTIVITY_SCOPE_KEYS) {
    const value = cleanReceiptText(params.get(key), 80);
    if (value) scope[key] = value;
  }
  return scope;
}

/** A stored execution id we did not mint is dropped, not carried. */
function normalizedExecutionId(value) {
  if (value == null) return null;
  const text = cleanReceiptText(value, 80);
  return EXECUTION_ID_PATTERN.test(text) ? text : null;
}

/**
 * Validate one persisted entry. An unknown field is a rejection rather than a
 * trim, so a smuggled result snapshot, coverage block, or identity attribute
 * discards the entry instead of surviving inside it.
 */
export function normalizeRecentSearchEntry(candidate) {
  if (!plainObject(candidate)) return null;
  if (unknownKey(candidate, ENTRY_KEYS)) return null;
  if (candidate.scope != null && !plainObject(candidate.scope)) return null;
  if (plainObject(candidate.scope) && unknownKey(candidate.scope, SEARCH_ACTIVITY_SCOPE_KEYS)) {
    return null;
  }

  const path = normalizeRecentSearchPath(candidate.path);
  if (!path) return null;

  // Scope is read back from the canonical path, never from the stored copy, so a
  // rendered entry describes exactly what rerunning it will search.
  const scope = recentSearchScope(path);
  const query = cleanReceiptText(candidate.query, SEARCH_ACTIVITY_MAX_QUERY_LENGTH);
  const params = new URLSearchParams(path.slice(CANONICAL_PREFIX.length));
  if (!query || query !== params.get("q")) return null;

  const executedAtMs = receiptInstant(candidate.executed_at);
  if (executedAtMs === null) return null;

  return {
    query,
    path,
    scope,
    executed_at: new Date(executedAtMs).toISOString(),
    search_execution_id: normalizedExecutionId(candidate.search_execution_id),
  };
}

/** The browser store, or null when the browser refuses to hand one over. */
export function defaultRecentSearchStorage() {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    // Blocked storage throws on access alone; that is "no history", not an error.
    return null;
  }
}

function readStoredValue(storage) {
  try {
    return storage?.getItem?.(SEARCH_RECENT_HISTORY_STORAGE_KEY) ?? null;
  } catch {
    return null;
  }
}

/**
 * Read the bounded, deduplicated, newest-first history. Never throws and never
 * returns an entry it could not validate.
 */
export function readRecentSearches(storage = defaultRecentSearchStorage()) {
  const raw = readStoredValue(storage);
  if (!raw) return [];
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!plainObject(parsed) || unknownKey(parsed, STORE_KEYS)) return [];
  if (parsed.schema !== SEARCH_RECENT_HISTORY_SCHEMA || !Array.isArray(parsed.entries)) return [];

  const valid = [];
  for (const candidate of parsed.entries) {
    const entry = normalizeRecentSearchEntry(candidate);
    if (entry) valid.push(entry);
  }
  // Recency is a property of the entries, not of the order they happen to sit in.
  valid.sort((left, right) => Date.parse(right.executed_at) - Date.parse(left.executed_at));

  const seen = new Set();
  const entries = [];
  for (const entry of valid) {
    if (seen.has(entry.path)) continue;
    seen.add(entry.path);
    entries.push(entry);
    if (entries.length === SEARCH_RECENT_HISTORY_LIMIT) break;
  }
  return entries;
}

/** Persist a bounded list. Returns false when the browser would not store it. */
export function writeRecentSearches(entries, storage = defaultRecentSearchStorage()) {
  try {
    storage.setItem(
      SEARCH_RECENT_HISTORY_STORAGE_KEY,
      JSON.stringify({
        schema: SEARCH_RECENT_HISTORY_SCHEMA,
        entries: entries.slice(0, SEARCH_RECENT_HISTORY_LIMIT),
      }),
    );
    return true;
  } catch {
    // A missing, blocked, or full store loses the history, not the search.
    return false;
  }
}

/**
 * Record one settled execution. An identical canonical path refreshes recency
 * instead of adding a duplicate, and the eleventh entry evicts the oldest.
 */
export function recordRecentSearch({
  query,
  scope,
  now = new Date(),
  searchExecutionId = null,
} = {}, storage = defaultRecentSearchStorage()) {
  const path = canonicalRecentSearchPath({ query, scope });
  if (!path) return readRecentSearches(storage);

  let occurredAt;
  try {
    occurredAt = new Date(now).toISOString();
  } catch {
    return readRecentSearches(storage);
  }

  const entry = normalizeRecentSearchEntry({
    query: cleanReceiptText(query, SEARCH_ACTIVITY_MAX_QUERY_LENGTH),
    path,
    scope: boundedScope(scope),
    executed_at: occurredAt,
    search_execution_id: searchExecutionId,
  });
  if (!entry) return readRecentSearches(storage);

  const next = [
    entry,
    ...readRecentSearches(storage).filter((existing) => existing.path !== entry.path),
  ].slice(0, SEARCH_RECENT_HISTORY_LIMIT);
  // Report what the store actually holds, so a blocked or full store shows the
  // reader an honest empty list rather than an entry that vanishes on reload.
  return writeRecentSearches(next, storage) ? next : readRecentSearches(storage);
}

/** Forget one entry immediately. */
export function removeRecentSearch(path, storage = defaultRecentSearchStorage()) {
  const canonical = normalizeRecentSearchPath(path);
  const entries = readRecentSearches(storage);
  if (!canonical) return entries;
  const next = entries.filter((entry) => entry.path !== canonical);
  if (next.length === entries.length) return entries;
  return writeRecentSearches(next, storage) ? next : readRecentSearches(storage);
}

/** Forget every entry immediately. */
export function clearRecentSearches(storage = defaultRecentSearchStorage()) {
  try {
    storage.removeItem(SEARCH_RECENT_HISTORY_STORAGE_KEY);
  } catch {
    // Nothing to clear is the same reader outcome as a cleared store.
  }
  return [];
}
