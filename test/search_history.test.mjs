/**
 * Browser half of the recognized-account search history.
 *
 * Two things are proven here that the Worker suite cannot: that every call the
 * page makes is credentialed and fail-soft, and that the island renders an
 * actionable surface ONLY for a recognized reader with searches to reopen.
 * Everything else — anonymous, unavailable, failed — must render nothing, which
 * is what lets an account feature degrade to ordinary Search instead of turning
 * a bad session into a visible error or a second place to sign in.
 *
 * That the real document actually wires these together is proven behaviorally by
 * test/functional/35_account_search_history.py in a real browser.
 *
 * verify: node --test test/search_history.test.mjs
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  SEARCH_HISTORY_ENTRY_SCHEMA,
  SEARCH_HISTORY_MAX_ENTRIES,
  SEARCH_HISTORY_MAX_QUERY_LENGTH,
  SEARCH_HISTORY_MAX_REQUEST_BYTES,
  SEARCH_HISTORY_PATH,
  applySearchHistoryAppend,
  applySearchHistoryRemove,
  canonicalSearchHistoryHref,
  normalizeSearchHistoryEntry,
  projectSearchHistoryEntry,
  validSearchHistoryEntries,
} from "../capabilities/search_history.mjs";
import {
  appendAccountSearchHistory,
  buildSearchHistoryEntry,
  clearAccountSearchHistory,
  newSearchHistoryExecutionId,
  readAccountSearchHistory,
  removeAccountSearchHistoryEntry,
  searchHistoryScope,
} from "../site/search_history_client.mjs";
import {
  searchHistoryIslandHtml,
  searchHistoryUiState,
} from "../site/search_history_state.mjs";

const ORIGINS = ["https://api.cityscroll.org"];
const FIXED_NOW = new Date("2026-09-02T12:00:00.000Z");

function storedEntry(query, { scope = {}, occurredAt = "2026-09-02T12:00:00.000Z" } = {}) {
  return {
    id: canonicalSearchHistoryHref(query.toLowerCase(), scope),
    query,
    scope,
    href: canonicalSearchHistoryHref(query, scope),
    occurred_at: occurredAt,
    execution_id: null,
  };
}

/** A fetch that records what it was called with and answers with one body. */
function recordingFetch(body, { ok = true, status = 200 } = {}) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url, init });
    return { ok, status, json: async () => body };
  };
  impl.calls = calls;
  return impl;
}

// ---- every call is credentialed, bounded, and aimed at the personal route ----

test("read, append, remove, and clear all send credentials to /search-history", async () => {
  const answer = { ok: true, schema: "cityscroll.search_history.v1", state: "recognized", limit: 25, entries: [] };
  for (const [label, call] of [
    ["read", (options) => readAccountSearchHistory(options)],
    ["append", (options) => appendAccountSearchHistory(buildSearchHistoryEntry({ query: "rats", now: FIXED_NOW }), options)],
    ["remove", (options) => removeAccountSearchHistoryEntry("/search/?q=rats", options)],
    ["clear", (options) => clearAccountSearchHistory(options)],
  ]) {
    const fetchImpl = recordingFetch(answer);
    const result = await call({ origins: ORIGINS, fetchImpl });
    assert.equal(result.state, "recognized", label);
    assert.equal(fetchImpl.calls.length, 1, label);
    const [{ url, init }] = fetchImpl.calls;
    assert.equal(url, `https://api.cityscroll.org${SEARCH_HISTORY_PATH}`, label);
    assert.equal(init.credentials, "include", `${label} must be a credentialed request`);
  }
});

test("a mutation names its action and never names an account", async () => {
  const fetchImpl = recordingFetch({ ok: true, state: "recognized", entries: [] });
  await appendAccountSearchHistory(
    buildSearchHistoryEntry({ query: "rats", scope: { boro: "Queens" }, now: FIXED_NOW }),
    { origins: ORIGINS, fetchImpl },
  );
  const body = JSON.parse(fetchImpl.calls[0].init.body);
  assert.deepEqual(Object.keys(body).sort(), ["action", "entry"]);
  assert.equal(body.action, "append");
  assert.deepEqual(Object.keys(body.entry).sort(), [
    "execution_id", "occurred_at", "query", "schema", "scope", "search_path",
  ]);
  // Whatever the browser sends, the endpoint has to accept it.
  assert.equal(normalizeSearchHistoryEntry(body.entry).ok, true);
});

test("nothing about the request can be pointed at another origin or account", async () => {
  const fetchImpl = recordingFetch({ ok: true, state: "recognized", entries: [] });
  await readAccountSearchHistory({ origins: [], fetchImpl });
  assert.equal(fetchImpl.calls.length, 0, "with no API origin there is nothing to ask");
  const failed = await readAccountSearchHistory({ origins: [] });
  assert.equal(failed.failed, true);
  assert.deepEqual(failed.entries, []);
});

// ---- fail-soft: no failure mode can throw into Search ----

test("every transport failure resolves to an empty, unfailed answer", async () => {
  const failures = [
    ["network error", async () => { throw new Error("offline"); }],
    ["not JSON", async () => ({ ok: true, status: 200, json: async () => { throw new Error("bad json"); } })],
    ["JSON that is not an answer", async () => ({ ok: true, status: 200, json: async () => "nope" })],
    ["server error", async () => ({ ok: false, status: 500, json: async () => ({ ok: false }) })],
  ];
  for (const [label, fetchImpl] of failures) {
    const result = await readAccountSearchHistory({ origins: ORIGINS, fetchImpl });
    assert.equal(result.ok, false, label);
    assert.deepEqual(result.entries, [], label);
  }
});

test("an oversized append is refused locally rather than sent", async () => {
  const fetchImpl = recordingFetch({ ok: true, state: "recognized", entries: [] });
  const entry = buildSearchHistoryEntry({
    query: "x".repeat(SEARCH_HISTORY_MAX_QUERY_LENGTH),
    scope: { boro: "y".repeat(80), cd: "z".repeat(80), council: "w".repeat(80), neighborhood: "v".repeat(80), scope: "u".repeat(80) },
    now: FIXED_NOW,
  });
  entry.query.normalized = "n".repeat(SEARCH_HISTORY_MAX_REQUEST_BYTES);
  const result = await appendAccountSearchHistory(entry, { origins: ORIGINS, fetchImpl });
  assert.equal(result.failed, true);
  assert.equal(fetchImpl.calls.length, 0);
});

test("nothing to remember produces no request at all", async () => {
  assert.equal(buildSearchHistoryEntry({ query: "   ", now: FIXED_NOW }), null);
  const fetchImpl = recordingFetch({ ok: true, state: "recognized", entries: [] });
  await appendAccountSearchHistory(null, { origins: ORIGINS, fetchImpl });
  await removeAccountSearchHistoryEntry("", { origins: ORIGINS, fetchImpl });
  assert.equal(fetchImpl.calls.length, 0);
});

// ---- what the browser builds ----

test("the submitted entry carries the query, the place, and nothing else", () => {
  const entry = buildSearchHistoryEntry({
    query: "  Rats!  ",
    scope: { boro: "Queens" },
    executionId: "exec_abcdefgh12345678",
    now: FIXED_NOW,
  });
  assert.equal(entry.schema, SEARCH_HISTORY_ENTRY_SCHEMA);
  assert.equal(entry.query.raw, "Rats!");
  assert.equal(entry.query.normalized, "rats", "the normalized form is what deduplicates");
  assert.equal(entry.search_path, "/search/");
  assert.equal(entry.occurred_at, "2026-09-02T12:00:00.000Z");
  assert.deepEqual(entry.scope, { boro: "Queens" });
});

test("place context comes only from the keys the canonical route carries", () => {
  const params = new URLSearchParams("q=rats&boro=Queens&council=3&utm_source=mail&session=abc");
  assert.deepEqual(searchHistoryScope(params), { boro: "Queens", council: "3" });
  assert.deepEqual(searchHistoryScope(null), {});
});

test("a browser-minted execution name is opaque and never a stored identifier", () => {
  const minted = newSearchHistoryExecutionId("11111111-2222-3333-4444-555555555555");
  assert.match(minted, /^exec_[A-Za-z0-9_-]{8,64}$/);
  assert.equal(newSearchHistoryExecutionId("short"), null);
  assert.equal(newSearchHistoryExecutionId(""), null);
  // It is derived from randomness, not from the reader or the query.
  assert.notEqual(newSearchHistoryExecutionId("11111111-2222-3333-4444-555555555555"), "exec_rats");
});

// ---- the island: only a recognized reader sees something to act on ----

test("only a recognized reader with searches gets an actionable island", () => {
  const entries = [storedEntry("rats", { scope: { boro: "Queens" } })];
  const states = {
    loading: searchHistoryUiState({ loading: true }),
    unrecognized: searchHistoryUiState({ responseState: "unrecognized" }),
    unavailable: searchHistoryUiState({ responseOk: false, responseState: "unavailable" }),
    error: searchHistoryUiState({ fetchFailed: true }),
    empty: searchHistoryUiState({ responseState: "recognized", entryCount: 0 }),
    recognized: searchHistoryUiState({ responseState: "recognized", entryCount: 1 }),
  };
  for (const [expected, actual] of Object.entries(states)) assert.equal(actual, expected);

  for (const state of ["loading", "unrecognized", "unavailable", "error"]) {
    assert.equal(searchHistoryIslandHtml(state, { entries }), "", `${state} must render nothing`);
  }
  const empty = searchHistoryIslandHtml("empty", { entries: [] });
  assert.match(empty, /Your recent searches/);
  assert.doesNotMatch(empty, /<button/, "an empty history offers no controls");

  const recognized = searchHistoryIslandHtml("recognized", { entries });
  assert.match(recognized, /href="\/search\/\?q=rats&amp;boro=Queens"/);
  assert.match(recognized, /data-search-history-remove="\/search\/\?q=rats&amp;boro=Queens"/);
  assert.match(recognized, /data-search-history-clear/);
});

test("a recognized island with no entries still renders nothing to act on", () => {
  assert.equal(searchHistoryIslandHtml("recognized", { entries: [] }), "");
});

test("entry text is escaped, so a query can never become markup", () => {
  const hostile = storedEntry('<img src=x onerror="alert(1)">');
  const html = searchHistoryIslandHtml("recognized", { entries: [hostile] });
  assert.ok(!html.includes("<img"), html);
  assert.match(html, /&lt;img src=x onerror=&quot;alert\(1\)&quot;&gt;/);
});

test("the day a search ran is read in UTC, so two devices agree on it", () => {
  const html = searchHistoryIslandHtml("recognized", {
    entries: [storedEntry("rats", { occurredAt: "2026-09-02T23:30:00.000Z" })],
  });
  assert.match(html, /<time class="topic-search-history-when" datetime="2026-09-02T23:30:00.000Z">2026-09-02<\/time>/);
});

// ---- the shared list algebra both sides depend on ----

test("appending is deterministic: newest first, distinct, and bounded", () => {
  let entries = [];
  for (let index = 0; index < SEARCH_HISTORY_MAX_ENTRIES + 5; index += 1) {
    const hour = String(index % 24).padStart(2, "0");
    entries = applySearchHistoryAppend(
      entries,
      storedEntry(`query-${index}`, { occurredAt: `2026-09-02T${hour}:00:00.000Z` }),
    );
  }
  assert.equal(entries.length, SEARCH_HISTORY_MAX_ENTRIES);
  const times = entries.map((row) => row.occurred_at);
  assert.deepEqual([...times].sort().reverse(), times);

  const repeat = applySearchHistoryAppend(entries, {
    ...entries[3],
    occurred_at: "2026-09-03T00:00:00.000Z",
  });
  assert.equal(repeat.length, SEARCH_HISTORY_MAX_ENTRIES);
  assert.equal(repeat[0].id, entries[3].id, "a repeat rises instead of duplicating");
});

test("removing an id that is not there is not an error", () => {
  const entries = [storedEntry("rats")];
  assert.deepEqual(applySearchHistoryRemove(entries, "/search/?q=nothing"), entries);
  assert.deepEqual(applySearchHistoryRemove(entries, entries[0].id), []);
});

test("malformed stored rows are dropped rather than repaired", () => {
  const kept = validSearchHistoryEntries([
    null,
    7,
    { id: "/search/?q=rats" },
    { ...storedEntry("rats"), occurred_at: "not a time" },
    { ...storedEntry("rats"), id: "//evil.example/search/?q=rats" },
    { ...storedEntry("rats"), scope: { tracking: "1" } },
    storedEntry("kept"),
  ]);
  assert.deepEqual(kept.map((row) => row.query), ["kept"]);
});

test("the projected entry is exactly what a reader needs and nothing more", () => {
  const projected = projectSearchHistoryEntry(storedEntry("rats", { scope: { boro: "Queens" } }));
  assert.deepEqual(Object.keys(projected).sort(), [
    "execution_id", "href", "id", "occurred_at", "query", "scope",
  ]);
});
