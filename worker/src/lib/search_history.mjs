/**
 * Worker-owned half of a recognized account's search history.
 *
 * The account key is derived here and nowhere else. A request never names the
 * account it wants: the email comes from the existing session cookie, the
 * subscriber id from the existing derivation, and the storage key from that.
 * There is therefore no request shape that can address another account's row,
 * which is what makes cross-account isolation a property of the design rather
 * than a check that could be forgotten.
 *
 * `visitor_id` has no part in any of this. A browser identity is not evidence
 * that an account owns a search, so anonymous activity stays where it was
 * recorded and is never imported into a personal history.
 */

import {
  SEARCH_HISTORY_MAX_ENTRIES,
  SEARCH_HISTORY_RETENTION_DAYS,
  SEARCH_HISTORY_SCHEMA,
  applySearchHistoryAppend,
  applySearchHistoryRemove,
  validSearchHistoryEntries,
} from "../../../capabilities/search_history.mjs";

/** Direct, account-scoped key. Never listed or scanned; always read by name. */
export const SEARCH_HISTORY_KEY_PREFIX = "search-history:";

export const SEARCH_HISTORY_RETENTION_SECONDS = SEARCH_HISTORY_RETENTION_DAYS * 24 * 3600;

/** `search-history:<subscriber_id>`, and only ever that. */
export function searchHistoryKey(subscriberId) {
  return `${SEARCH_HISTORY_KEY_PREFIX}${subscriberId}`;
}

/**
 * Read one account's stored entries, pruned to what the contract still accepts.
 * A missing row, unreadable JSON, or malformed state all read as no history —
 * never as an error the reader has to act on.
 */
export async function readSearchHistory(env, subscriberId, { nowMs } = {}) {
  if (!env?.SUBS?.get) return { available: false, entries: [] };
  let raw;
  try {
    raw = await env.SUBS.get(searchHistoryKey(subscriberId));
  } catch {
    return { available: false, entries: [] };
  }
  if (!raw) return { available: true, entries: [] };
  let stored;
  try {
    stored = JSON.parse(raw);
  } catch {
    return { available: true, entries: [] };
  }
  return {
    available: true,
    entries: validSearchHistoryEntries(stored?.entries, { nowMs, limit: SEARCH_HISTORY_MAX_ENTRIES }),
  };
}

/**
 * Replace one account's stored entries. Every write refreshes the bounded
 * expiration, so an account that keeps searching keeps its history and one that
 * stops loses it mechanically without a sweep.
 */
export async function writeSearchHistory(env, subscriberId, entries, { nowMs } = {}) {
  if (!env?.SUBS?.put) return false;
  if (!entries.length) return deleteSearchHistory(env, subscriberId);
  const document = {
    schema: SEARCH_HISTORY_SCHEMA,
    updated_at: new Date(nowMs).toISOString(),
    entries,
  };
  try {
    await env.SUBS.put(
      searchHistoryKey(subscriberId),
      JSON.stringify(document),
      { expirationTtl: SEARCH_HISTORY_RETENTION_SECONDS },
    );
    return true;
  } catch {
    return false;
  }
}

/** Clearing removes the row outright; an empty history leaves nothing behind. */
export async function deleteSearchHistory(env, subscriberId) {
  if (!env?.SUBS?.delete) return false;
  try {
    await env.SUBS.delete(searchHistoryKey(subscriberId));
    return true;
  } catch {
    return false;
  }
}

/**
 * Apply one mutation and persist the result. Returns the entries the reader
 * should now see plus whether the store accepted the change, so a storage
 * failure can degrade the browser to local behavior instead of lying to it.
 *
 * Read-modify-write, deliberately: the store offers no compare-and-set, and this
 * is a convenience list, not a ledger. Two devices appending in the same instant
 * can cost one of the two entries; the next search on either device restores a
 * correct list. Nothing else in the product depends on this value.
 */
export async function mutateSearchHistory(env, subscriberId, request, { nowMs } = {}) {
  const current = await readSearchHistory(env, subscriberId, { nowMs });
  if (!current.available) return { stored: false, entries: [] };

  if (request.action === "clear") {
    const stored = await deleteSearchHistory(env, subscriberId);
    // A refused delete leaves the stored list intact; report what is still there
    // rather than an empty list the reader would read as a successful clear.
    return { stored, entries: stored ? [] : current.entries };
  }

  const next = request.action === "append"
    ? applySearchHistoryAppend(current.entries, request.entry, { nowMs })
    : applySearchHistoryRemove(current.entries, request.id, { nowMs });

  const stored = await writeSearchHistory(env, subscriberId, next, { nowMs });
  return { stored, entries: stored ? next : current.entries };
}
