/**
 * Browser client for the recognized-account search history.
 *
 * Every call is credentialed and fail-soft. Nothing here can throw into Search,
 * nothing here is awaited before painting, and every failure resolves to a
 * state the island renders as "nothing to show" rather than an error a reader
 * has to clear. If this endpoint is missing, slow, blocked, or hostile, Search
 * behaves exactly as it does today.
 *
 * The browser never claims an account. It sends the search it just ran and the
 * session cookie the reader already has; the Worker decides whose history that
 * is. There is no account parameter to get wrong.
 */

import {
  SEARCH_HISTORY_CANONICAL_SEARCH_PATH,
  SEARCH_HISTORY_ENTRY_SCHEMA,
  SEARCH_HISTORY_MAX_QUERY_LENGTH,
  SEARCH_HISTORY_MAX_REQUEST_BYTES,
  SEARCH_HISTORY_PATH,
  SEARCH_HISTORY_SCOPE_KEYS,
  cleanSearchHistoryText,
} from "../capabilities/search_history.mjs";
import { normalizeUniversalSearchQuery } from "./universal_search_federator.mjs";

const REQUEST_TIMEOUT_MS = 4_000;

/** One shape for every failure, so no caller has to tell them apart. */
const FAILED = Object.freeze({ ok: false, state: null, entries: [], limit: null, failed: true });

/**
 * An opaque name for one settled Search execution, minted in the browser for
 * this stream only. It is not the private receipt stream's execution id and is
 * never sent there: two separate id spaces are what stop an account entry and
 * an operational receipt from being joined.
 */
export function newSearchHistoryExecutionId(randomId) {
  const raw = randomId ?? (typeof crypto?.randomUUID === "function" ? crypto.randomUUID() : null);
  if (!raw) return null;
  const token = String(raw).replace(/[^A-Za-z0-9_-]/g, "");
  return token.length >= 8 ? `exec_${token.slice(0, 59)}` : null;
}

/** Place context the canonical Search route already carries, bounded per key. */
export function searchHistoryScope(searchParams) {
  const scope = {};
  if (!searchParams) return scope;
  for (const key of SEARCH_HISTORY_SCOPE_KEYS) {
    const value = cleanSearchHistoryText(searchParams.get(key), 80);
    if (value) scope[key] = value;
  }
  return scope;
}

/**
 * The browser-owned half of one remembered search. Returns null when there is
 * nothing legitimate to remember, which is the same rule the receipt uses: no
 * query means no execution happened that a reader would want to reopen.
 */
export function buildSearchHistoryEntry({ query, scope = {}, executionId = null, now = new Date() } = {}) {
  const raw = cleanSearchHistoryText(query, SEARCH_HISTORY_MAX_QUERY_LENGTH);
  if (!raw) return null;
  const normalized = cleanSearchHistoryText(
    normalizeUniversalSearchQuery(raw),
    SEARCH_HISTORY_MAX_QUERY_LENGTH,
  ) || raw;
  return {
    schema: SEARCH_HISTORY_ENTRY_SCHEMA,
    occurred_at: new Date(now).toISOString(),
    query: { raw, normalized },
    search_path: SEARCH_HISTORY_CANONICAL_SEARCH_PATH,
    scope,
    execution_id: executionId,
  };
}

function endpoint(origins) {
  const origin = origins?.[0];
  return origin ? `${origin}${SEARCH_HISTORY_PATH}` : null;
}

function readResult(body) {
  if (!body || typeof body !== "object") return FAILED;
  return {
    ok: body.ok === true,
    state: typeof body.state === "string" ? body.state : null,
    entries: Array.isArray(body.entries) ? body.entries : [],
    limit: Number.isSafeInteger(body.limit) ? body.limit : null,
    failed: false,
  };
}

async function call(url, init, { fetchImpl, timeoutMs = REQUEST_TIMEOUT_MS } = {}) {
  const send = fetchImpl || (typeof fetch === "function" ? fetch : null);
  if (!send || !url) return FAILED;
  const controller = typeof AbortController === "function" ? new AbortController() : null;
  const timer = controller && typeof setTimeout === "function"
    ? setTimeout(() => controller.abort(), timeoutMs)
    : null;
  try {
    const response = await send(url, {
      // The session cookie is first-party to cityscroll.org and set by the API
      // host, so every personal read and write is credentialed cross-origin.
      credentials: "include",
      ...init,
      ...(controller ? { signal: controller.signal } : {}),
    });
    let body = null;
    try { body = await response.json(); } catch { body = null; }
    return readResult(body);
  } catch {
    return FAILED;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Read this account's remembered searches. Never throws. */
export async function readAccountSearchHistory(options = {}) {
  const url = endpoint(options.origins);
  if (!url) return FAILED;
  return call(url, { method: "GET", headers: { Accept: "application/json" } }, options);
}

async function post(body, options) {
  const url = endpoint(options.origins);
  if (!url) return FAILED;
  const payload = JSON.stringify(body);
  // Refuse locally rather than making the endpoint reject an oversized request.
  if (payload.length > SEARCH_HISTORY_MAX_REQUEST_BYTES) return FAILED;
  return call(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: payload,
  }, options);
}

/**
 * Offer one settled search to the account history. The Worker stores it only if
 * the reader is recognized right now; an anonymous browser is told so and
 * nothing is written, which is why recognition can never backfill earlier
 * anonymous searches.
 */
export async function appendAccountSearchHistory(entry, options = {}) {
  if (!entry) return FAILED;
  return post({ action: "append", entry }, options);
}

export async function removeAccountSearchHistoryEntry(id, options = {}) {
  if (!id) return FAILED;
  return post({ action: "remove", id }, options);
}

export async function clearAccountSearchHistory(options = {}) {
  return post({ action: "clear" }, options);
}
