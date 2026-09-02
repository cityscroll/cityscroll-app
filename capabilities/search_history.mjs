/**
 * Account search-history contract — the narrow waist between a recognized
 * reader's browser and the bounded personal state the Worker keeps for them.
 *
 * This is NOT the private search-execution receipt in `search_activity.mjs`.
 * That stream is operational evidence about every execution, anonymous or not,
 * read back only by an operator. This one is a small resident-owned continuation
 * of a reader's OWN recent searches, readable only by the account that ran them.
 *
 * Three rules give the two streams different shapes, and they must stay apart:
 *
 *   - Recognition is the authorization boundary. A search performed while the
 *     existing email session recognizes the reader may be projected here; a
 *     search performed anonymously never is, and is never imported later.
 *   - The browser never names the account. It sends a search it just ran and
 *     receives entries back; the Worker derives the account from the session.
 *   - An entry carries only what it takes to reopen a canonical Search. No
 *     result rows, no identifiers, no network observation, no operator fields.
 *
 * The scope vocabulary and text-cleaning helper are shared with the receipt
 * contract because both describe the SAME canonical Search route. Sharing the
 * route's vocabulary is not a join between the two stores: they have different
 * keys, different retention, and different readers.
 */

import {
  SEARCH_ACTIVITY_SCOPE_KEYS,
  cleanReceiptText,
} from "./search_activity.mjs";

export const SEARCH_HISTORY_SCHEMA = "cityscroll.search_history.v1";
export const SEARCH_HISTORY_ENTRY_SCHEMA = "cityscroll.search_history_entry.v1";

/** Credentialed personal route, modeled on `/following/personal`. */
export const SEARCH_HISTORY_PATH = "/search-history";

/** The one canonical Search document an entry may reopen. */
export const SEARCH_HISTORY_CANONICAL_SEARCH_PATH = "/search/";

/** Place-context keys the canonical Search route already carries. */
export const SEARCH_HISTORY_SCOPE_KEYS = SEARCH_ACTIVITY_SCOPE_KEYS;

/** A continuation, not an archive: the newest 25 distinct searches. */
export const SEARCH_HISTORY_MAX_ENTRIES = 25;

/** Bounded expiration. The store expires the row; nothing sweeps. */
export const SEARCH_HISTORY_RETENTION_DAYS = 90;

export const SEARCH_HISTORY_MAX_QUERY_LENGTH = 240;
export const SEARCH_HISTORY_MAX_REQUEST_BYTES = 4_096;

/** A stored entry is dropped once it is older than the retention window. */
export const SEARCH_HISTORY_RETENTION_MS = SEARCH_HISTORY_RETENTION_DAYS * 24 * 3600 * 1000;

export const SEARCH_HISTORY_ACTIONS = Object.freeze(["append", "remove", "clear"]);

/**
 * What the browser is told about its own request. `recognized` is the only state
 * that can carry entries; the other two are why a reader keeps local behavior.
 */
export const SEARCH_HISTORY_STATES = Object.freeze([
  "recognized",
  "unrecognized",
  "unavailable",
]);

const ACTION_SET = new Set(SEARCH_HISTORY_ACTIONS);
const APPEND_KEYS = Object.freeze(["action", "entry"]);
const ENTRY_KEYS = Object.freeze([
  "schema",
  "occurred_at",
  "query",
  "search_path",
  "scope",
  "execution_id",
]);
const QUERY_KEYS = Object.freeze(["raw", "normalized"]);
const REMOVE_KEYS = Object.freeze(["action", "id"]);
const CLEAR_KEYS = Object.freeze(["action"]);

/**
 * A browser-minted opaque name for one settled Search execution. It is minted
 * for THIS stream and is deliberately not the receipt stream's `execution_id`:
 * the two id spaces never meet, so an account entry cannot be used to reach a
 * private receipt, and a private receipt cannot be used to reach an account.
 */
const EXECUTION_ID_PATTERN = /^exec_[A-Za-z0-9_-]{8,64}$/;

/** Collapse control characters and whitespace, then bound the length. */
export function cleanSearchHistoryText(value, max = 240) {
  return cleanReceiptText(value, max);
}

function plainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function unknownKey(candidate, allowed) {
  return Object.keys(candidate).find((key) => !allowed.includes(key)) || null;
}

/** ISO-8601 instant in UTC, as epoch milliseconds, or null. */
export function searchHistoryInstant(value) {
  const text = cleanReceiptText(value, 40);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/.test(text)) return null;
  const ms = Date.parse(text);
  return Number.isFinite(ms) ? ms : null;
}

function normalizedScope(candidate) {
  if (candidate == null) return { value: {} };
  if (!plainObject(candidate)) return { reason: "scope" };
  if (unknownKey(candidate, SEARCH_HISTORY_SCOPE_KEYS)) return { reason: "unknown_field" };
  const scope = {};
  for (const key of SEARCH_HISTORY_SCOPE_KEYS) {
    if (!Object.hasOwn(candidate, key)) continue;
    const value = cleanReceiptText(candidate[key], 80);
    if (!value) return { reason: "scope" };
    scope[key] = value;
  }
  return { value: scope };
}

/**
 * The canonical Search URL for a query and its place context.
 *
 * Deterministic by construction: one fixed parameter order, one encoder, and a
 * scope vocabulary that is a closed list. Two searches that mean the same thing
 * therefore produce the same string, which is what makes deduplication and
 * removal work without storing a second identifier.
 */
export function canonicalSearchHistoryHref(query, scope = {}) {
  const params = new URLSearchParams();
  params.set("q", cleanReceiptText(query, SEARCH_HISTORY_MAX_QUERY_LENGTH));
  for (const key of SEARCH_HISTORY_SCOPE_KEYS) {
    const value = cleanReceiptText(scope?.[key], 80);
    if (value) params.set(key, value);
  }
  return `${SEARCH_HISTORY_CANONICAL_SEARCH_PATH}?${params.toString()}`;
}

/**
 * The identity of one remembered search: the canonical URL of its NORMALIZED
 * query. "Rats" and "rats " are the same search to a reader, so they collapse
 * to one entry whose visible link still carries the words most recently typed.
 */
export function searchHistoryEntryId(normalizedQuery, scope = {}) {
  return canonicalSearchHistoryHref(normalizedQuery, scope);
}

/** An id must look like one this contract mints; anything else is malformed. */
export function isSearchHistoryEntryId(value) {
  const text = cleanReceiptText(value, 800);
  if (!text.startsWith(`${SEARCH_HISTORY_CANONICAL_SEARCH_PATH}?`)) return false;
  let parsed;
  try {
    parsed = new URL(text, "https://cityscroll.org");
  } catch {
    return false;
  }
  if (parsed.pathname !== SEARCH_HISTORY_CANONICAL_SEARCH_PATH) return false;
  const query = cleanReceiptText(parsed.searchParams.get("q"), SEARCH_HISTORY_MAX_QUERY_LENGTH);
  if (!query) return false;
  for (const key of parsed.searchParams.keys()) {
    if (key !== "q" && !SEARCH_HISTORY_SCOPE_KEYS.includes(key)) return false;
  }
  return text === canonicalSearchHistoryHref(
    query,
    Object.fromEntries([...parsed.searchParams.entries()].filter(([key]) => key !== "q")),
  );
}

function normalizedExecutionId(value) {
  if (value == null) return { value: null };
  const text = cleanReceiptText(value, 80);
  if (!EXECUTION_ID_PATTERN.test(text)) return { reason: "execution_id" };
  return { value: text };
}

/**
 * Validate one browser-submitted search for the account history.
 *
 * Strict like the receipt contract: unknown fields and malformed values are
 * rejected rather than trimmed, so a stored entry always means what it says.
 * Returns `{ ok: true, value }` or `{ ok: false, reason }`.
 */
export function normalizeSearchHistoryEntry(input) {
  if (!plainObject(input)) return { ok: false, reason: "not_an_object" };
  if (unknownKey(input, ENTRY_KEYS)) return { ok: false, reason: "unknown_field" };
  if (input.schema !== SEARCH_HISTORY_ENTRY_SCHEMA) return { ok: false, reason: "schema" };

  const occurredAtMs = searchHistoryInstant(input.occurred_at);
  if (occurredAtMs === null) return { ok: false, reason: "occurred_at" };

  if (!plainObject(input.query)) return { ok: false, reason: "query" };
  if (unknownKey(input.query, QUERY_KEYS)) return { ok: false, reason: "unknown_field" };
  const raw = cleanReceiptText(input.query.raw, SEARCH_HISTORY_MAX_QUERY_LENGTH);
  const normalized = cleanReceiptText(input.query.normalized, SEARCH_HISTORY_MAX_QUERY_LENGTH);
  if (!raw || !normalized) return { ok: false, reason: "query" };

  if (cleanReceiptText(input.search_path, 120) !== SEARCH_HISTORY_CANONICAL_SEARCH_PATH) {
    return { ok: false, reason: "search_path" };
  }

  const scope = normalizedScope(input.scope);
  if (scope.reason) return { ok: false, reason: scope.reason };

  const executionId = normalizedExecutionId(input.execution_id);
  if (executionId.reason) return { ok: false, reason: executionId.reason };

  return {
    ok: true,
    value: {
      id: searchHistoryEntryId(normalized, scope.value),
      query: raw,
      scope: scope.value,
      href: canonicalSearchHistoryHref(raw, scope.value),
      occurred_at: new Date(occurredAtMs).toISOString(),
      execution_id: executionId.value,
    },
  };
}

/** Validate one mutation request body. Returns `{ ok, action, ... }`. */
export function normalizeSearchHistoryRequest(input) {
  if (!plainObject(input)) return { ok: false, reason: "not_an_object" };
  const action = cleanReceiptText(input.action, 40);
  if (!ACTION_SET.has(action)) return { ok: false, reason: "action" };

  if (action === "clear") {
    if (unknownKey(input, CLEAR_KEYS)) return { ok: false, reason: "unknown_field" };
    return { ok: true, action };
  }

  if (action === "remove") {
    if (unknownKey(input, REMOVE_KEYS)) return { ok: false, reason: "unknown_field" };
    const id = cleanReceiptText(input.id, 800);
    if (!isSearchHistoryEntryId(id)) return { ok: false, reason: "id" };
    return { ok: true, action, id };
  }

  if (unknownKey(input, APPEND_KEYS)) return { ok: false, reason: "unknown_field" };
  const entry = normalizeSearchHistoryEntry(input.entry);
  if (!entry.ok) return { ok: false, reason: entry.reason };
  return { ok: true, action, entry: entry.value };
}

/**
 * Keep only entries this contract still recognizes: well-formed, inside the
 * retention window, distinct by id, newest first, and no more than the bound.
 *
 * Stored state is never trusted. A malformed row is dropped rather than
 * repaired, so a corrupt value degrades to a shorter history, never an error.
 */
export function validSearchHistoryEntries(entries, { nowMs, limit = SEARCH_HISTORY_MAX_ENTRIES } = {}) {
  if (!Array.isArray(entries)) return [];
  const seen = new Set();
  const kept = [];
  for (const candidate of entries) {
    if (!plainObject(candidate)) continue;
    const occurredAtMs = searchHistoryInstant(candidate.occurred_at);
    if (occurredAtMs === null) continue;
    if (Number.isFinite(nowMs) && nowMs - occurredAtMs > SEARCH_HISTORY_RETENTION_MS) continue;
    const id = cleanReceiptText(candidate.id, 800);
    if (!isSearchHistoryEntryId(id) || seen.has(id)) continue;
    const query = cleanReceiptText(candidate.query, SEARCH_HISTORY_MAX_QUERY_LENGTH);
    if (!query) continue;
    const scope = normalizedScope(candidate.scope);
    if (scope.reason) continue;
    const executionId = normalizedExecutionId(candidate.execution_id);
    seen.add(id);
    kept.push({
      id,
      query,
      scope: scope.value,
      href: canonicalSearchHistoryHref(query, scope.value),
      occurred_at: new Date(occurredAtMs).toISOString(),
      execution_id: executionId.reason ? null : executionId.value,
    });
  }
  kept.sort((left, right) => Date.parse(right.occurred_at) - Date.parse(left.occurred_at));
  return kept.slice(0, Math.max(0, limit));
}

/**
 * Append one search, collapsing a repeat onto the newest run. Pure.
 *
 * The result is re-normalized rather than prepended, so the stored order is
 * always "newest first by the instant the search ran" even if a delayed append
 * arrives after a later one.
 */
export function applySearchHistoryAppend(entries, entry, options = {}) {
  const existing = validSearchHistoryEntries(entries, { ...options, limit: Number.MAX_SAFE_INTEGER });
  return validSearchHistoryEntries(
    [entry, ...existing.filter((row) => row.id !== entry.id)],
    options,
  );
}

/** Drop one remembered search by id. Removing an absent id is not an error. */
export function applySearchHistoryRemove(entries, id, options = {}) {
  return validSearchHistoryEntries(entries, options).filter((row) => row.id !== id);
}

/**
 * The resident-visible shape. Everything the reader needs to reopen the search
 * and nothing that names them: no email, no subscriber id, no visitor id, no
 * network observation, no stored results, no operator bookkeeping.
 */
export function projectSearchHistoryEntry(entry) {
  return {
    query: entry.query,
    scope: entry.scope,
    href: entry.href,
    id: entry.id,
    occurred_at: entry.occurred_at,
    execution_id: entry.execution_id ?? null,
  };
}
