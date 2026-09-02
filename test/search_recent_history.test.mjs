/**
 * Browser-local recent Search history.
 *
 * These tests exercise the store directly against a stand-in for the browser's
 * localStorage, so persistence, validation, eviction and every failure mode are
 * checked without a browser. That the Search document really renders, reruns,
 * removes and clears this store is proven behaviorally by
 * test/functional/42_search_recent_history.py.
 *
 * verify: node --test test/search_recent_history.test.mjs
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  SEARCH_RECENT_HISTORY_LIMIT,
  SEARCH_RECENT_HISTORY_SCHEMA,
  SEARCH_RECENT_HISTORY_STORAGE_KEY,
  canonicalRecentSearchPath,
  clearRecentSearches,
  normalizeRecentSearchEntry,
  normalizeRecentSearchPath,
  readRecentSearches,
  recordRecentSearch,
  removeRecentSearch,
  writeRecentSearches,
} from "../site/search_recent_history.mjs";

const EXECUTION_ID = "exec_9RmYq2Tb4xLd7Vn0Kc8Aiw";

/** A stand-in for the one browser API this store touches. */
function browserStorage(initial = null) {
  const cells = new Map();
  if (initial !== null) cells.set(SEARCH_RECENT_HISTORY_STORAGE_KEY, initial);
  return {
    cells,
    getItem: (key) => (cells.has(key) ? cells.get(key) : null),
    setItem: (key, value) => cells.set(key, String(value)),
    removeItem: (key) => cells.delete(key),
  };
}

function stored(storage) {
  return JSON.parse(storage.getItem(SEARCH_RECENT_HISTORY_STORAGE_KEY));
}

function persist(entries) {
  return JSON.stringify({ schema: SEARCH_RECENT_HISTORY_SCHEMA, entries });
}

function at(minute) {
  return new Date(`2026-09-02T10:${String(minute).padStart(2, "0")}:00.000Z`);
}

// ---- A1: the commissioned journey, as state ----

test("searching rats then CB3 leaves both canonical entries newest first", () => {
  const storage = browserStorage();
  recordRecentSearch({ query: "rats", now: at(0) }, storage);
  recordRecentSearch({ query: "CB3", scope: { cd: "CB3" }, now: at(1) }, storage);

  assert.deepEqual(
    readRecentSearches(storage).map((entry) => [entry.query, entry.path]),
    [
      ["CB3", "/search/?q=CB3&cd=CB3"],
      ["rats", "/search/?q=rats"],
    ],
  );
});

test("an entry carries navigation metadata and nothing that could snapshot a result", () => {
  const storage = browserStorage();
  recordRecentSearch(
    { query: "rats", scope: { boro: "Manhattan" }, now: at(0), searchExecutionId: EXECUTION_ID },
    storage,
  );
  const [entry] = readRecentSearches(storage);
  assert.deepEqual(Object.keys(entry).sort(), [
    "executed_at",
    "path",
    "query",
    "scope",
    "search_execution_id",
  ]);
  assert.deepEqual(entry.scope, { boro: "Manhattan" });
  assert.equal(entry.executed_at, "2026-09-02T10:00:00.000Z");
  assert.equal(entry.search_execution_id, EXECUTION_ID);
  assert.equal(entry.path, "/search/?q=rats&boro=Manhattan");
});

// ---- A2: rerun, dedupe, and the ten-entry bound ----

test("place context round-trips through the canonical path exactly", () => {
  const scope = { boro: "Brooklyn", cd: "CB3", council: "5", neighborhood: "Bushwick", scope: "north" };
  const path = canonicalRecentSearchPath({ query: "rats & refuse", scope });
  assert.equal(normalizeRecentSearchPath(path), path);

  const storage = browserStorage();
  recordRecentSearch({ query: "rats & refuse", scope, now: at(0) }, storage);
  const [entry] = readRecentSearches(storage);
  assert.equal(entry.path, path);
  assert.deepEqual(entry.scope, scope);
  assert.equal(new URLSearchParams(entry.path.split("?")[1]).get("q"), "rats & refuse");
});

test("the same canonical path refreshes recency instead of adding a duplicate", () => {
  const storage = browserStorage();
  recordRecentSearch({ query: "rats", now: at(0) }, storage);
  recordRecentSearch({ query: "CB3", now: at(1) }, storage);
  recordRecentSearch({ query: "rats", now: at(2) }, storage);

  const entries = readRecentSearches(storage);
  assert.equal(entries.length, 2);
  assert.deepEqual(entries.map((entry) => entry.query), ["rats", "CB3"]);
  assert.equal(entries[0].executed_at, "2026-09-02T10:02:00.000Z");
});

test("the same query in a different place is a different entry", () => {
  const storage = browserStorage();
  recordRecentSearch({ query: "rats", now: at(0) }, storage);
  recordRecentSearch({ query: "rats", scope: { cd: "CB3" }, now: at(1) }, storage);
  assert.deepEqual(
    readRecentSearches(storage).map((entry) => entry.path),
    ["/search/?q=rats&cd=CB3", "/search/?q=rats"],
  );
});

test("an eleventh search evicts the oldest and the store never exceeds ten", () => {
  const storage = browserStorage();
  for (let index = 0; index < 11; index += 1) {
    recordRecentSearch({ query: `query ${index}`, now: at(index) }, storage);
  }
  const entries = readRecentSearches(storage);
  assert.equal(entries.length, SEARCH_RECENT_HISTORY_LIMIT);
  assert.equal(stored(storage).entries.length, SEARCH_RECENT_HISTORY_LIMIT);
  assert.equal(entries[0].query, "query 10");
  assert.equal(entries.at(-1).query, "query 1");
  assert.ok(!entries.some((entry) => entry.query === "query 0"));
});

test("a persisted list longer than the bound is read back bounded", () => {
  const entries = Array.from({ length: 25 }, (_value, index) => ({
    query: `query ${index}`,
    path: `/search/?q=query+${index}`,
    scope: {},
    executed_at: at(index % 60).toISOString(),
    search_execution_id: null,
  }));
  const storage = browserStorage(persist(entries));
  assert.equal(readRecentSearches(storage).length, SEARCH_RECENT_HISTORY_LIMIT);
});

// ---- A3: remove and clear ----

test("remove deletes one entry and clear deletes all of them, immediately", () => {
  const storage = browserStorage();
  recordRecentSearch({ query: "rats", now: at(0) }, storage);
  recordRecentSearch({ query: "CB3", now: at(1) }, storage);

  assert.deepEqual(
    removeRecentSearch("/search/?q=rats", storage).map((entry) => entry.query),
    ["CB3"],
  );
  assert.deepEqual(stored(storage).entries.map((entry) => entry.query), ["CB3"]);

  assert.deepEqual(clearRecentSearches(storage), []);
  assert.equal(storage.getItem(SEARCH_RECENT_HISTORY_STORAGE_KEY), null);
  assert.deepEqual(readRecentSearches(storage), []);
});

test("removing a path that is not stored changes nothing", () => {
  const storage = browserStorage();
  recordRecentSearch({ query: "rats", now: at(0) }, storage);
  const before = stored(storage);
  assert.deepEqual(
    removeRecentSearch("/search/?q=nothing-here", storage).map((entry) => entry.query),
    ["rats"],
  );
  assert.deepEqual(stored(storage), before);
});

// ---- A4: boundaries — unsafe paths, foreign fields, and failing storage ----

test("only same-origin canonical Search paths can be rerun", () => {
  for (const unsafe of [
    "https://evil.example/search/?q=rats",
    "//evil.example/search/?q=rats",
    "/search/?q=rats#/../admin",
    "/search/?q=rats&next=https://evil.example",
    "/search?q=rats",
    "/browse/contracts/?q=rats",
    "javascript:alert(1)",
    "/search/?boro=Manhattan",
    "/search/?q=",
    "",
    null,
  ]) {
    assert.equal(normalizeRecentSearchPath(unsafe), null, String(unsafe));
  }
  assert.equal(normalizeRecentSearchPath("/search/?q=rats"), "/search/?q=rats");
});

test("a path whose parameters are not in canonical order is not accepted as canonical", () => {
  assert.equal(normalizeRecentSearchPath("/search/?cd=CB3&q=rats"), null);
  assert.equal(normalizeRecentSearchPath("/search/?q=rats&cd=CB3"), "/search/?q=rats&cd=CB3");
});

test("a persisted result snapshot or identity field discards its entry", () => {
  for (const smuggled of [
    { results: [{ title: "Rats abatement services", canonical_href: "/contracts/rats" }] },
    { coverage: { returned_count: 2 } },
    { visitor_id: "v1_abc" },
    { subscriber_id: "sub_abc" },
  ]) {
    assert.equal(
      normalizeRecentSearchEntry({
        query: "rats",
        path: "/search/?q=rats",
        scope: {},
        executed_at: at(0).toISOString(),
        search_execution_id: null,
        ...smuggled,
      }),
      null,
      Object.keys(smuggled)[0],
    );
  }
});

test("a persisted scope key outside the contract discards its entry", () => {
  assert.equal(
    normalizeRecentSearchEntry({
      query: "rats",
      path: "/search/?q=rats",
      scope: { email: "reader@example.com" },
      executed_at: at(0).toISOString(),
      search_execution_id: null,
    }),
    null,
  );
});

test("a displayed query that does not match its path is not rendered", () => {
  assert.equal(
    normalizeRecentSearchEntry({
      query: "something else entirely",
      path: "/search/?q=rats",
      scope: {},
      executed_at: at(0).toISOString(),
      search_execution_id: null,
    }),
    null,
  );
});

test("malformed persisted data is discarded without losing the valid entries", () => {
  const storage = browserStorage(persist([
    "not an object",
    null,
    { query: "rats", path: "/search/?q=rats", scope: {}, executed_at: at(0).toISOString(), search_execution_id: null },
    { query: "evil", path: "https://evil.example/search/?q=evil", scope: {}, executed_at: at(1).toISOString() },
    { query: "no time", path: "/search/?q=no+time", scope: {} },
    { query: "CB3", path: "/search/?q=CB3", scope: {}, executed_at: at(2).toISOString(), search_execution_id: null },
  ]));
  assert.deepEqual(readRecentSearches(storage).map((entry) => entry.query), ["CB3", "rats"]);
});

test("an unreadable, foreign, or corrupt store reads back as no history", () => {
  assert.deepEqual(readRecentSearches(browserStorage("{not json")), []);
  assert.deepEqual(readRecentSearches(browserStorage("[]")), []);
  assert.deepEqual(readRecentSearches(browserStorage(JSON.stringify({
    schema: "cityscroll.search_recent_history.v0",
    entries: [],
  }))), []);
  assert.deepEqual(readRecentSearches(browserStorage(JSON.stringify({
    schema: SEARCH_RECENT_HISTORY_SCHEMA,
    entries: [],
    results: [],
  }))), []);
  assert.deepEqual(readRecentSearches(browserStorage()), []);
  assert.deepEqual(readRecentSearches(null), []);
});

test("blocked and full storage lose the history, not the search", () => {
  const blocked = {
    getItem() { throw new Error("SecurityError"); },
    setItem() { throw new Error("SecurityError"); },
    removeItem() { throw new Error("SecurityError"); },
  };
  assert.deepEqual(readRecentSearches(blocked), []);
  assert.equal(writeRecentSearches([], blocked), false);
  assert.deepEqual(recordRecentSearch({ query: "rats", now: at(0) }, blocked), []);
  assert.deepEqual(removeRecentSearch("/search/?q=rats", blocked), []);
  assert.deepEqual(clearRecentSearches(blocked), []);

  // A store that refuses the write reports the history it actually holds, so the
  // reader is never shown an entry that would vanish on the next page load.
  const quota = browserStorage();
  quota.setItem = () => { throw new Error("QuotaExceededError"); };
  assert.deepEqual(recordRecentSearch({ query: "rats", now: at(0) }, quota), []);
  assert.deepEqual(readRecentSearches(quota), []);
});

test("an empty or unusable query is never recorded", () => {
  const storage = browserStorage();
  for (const query of ["", "   ", null, undefined]) {
    assert.deepEqual(recordRecentSearch({ query, now: at(0) }, storage), []);
  }
  assert.equal(storage.getItem(SEARCH_RECENT_HISTORY_STORAGE_KEY), null);
});

// ---- A2/A4: execution identity is optional and validated ----


test("an execution id is stored when supplied and dropped when it is not one we mint", () => {
  const storage = browserStorage();
  recordRecentSearch({ query: "rats", now: at(0), searchExecutionId: EXECUTION_ID }, storage);
  assert.equal(readRecentSearches(storage)[0].search_execution_id, EXECUTION_ID);

  for (const value of [null, "", "exec_", "v1_9RmYq2Tb4xLd7Vn0Kc8Aiw", "<script>", `exec_${"a".repeat(200)}`]) {
    const fresh = browserStorage();
    recordRecentSearch({ query: "rats", now: at(0), searchExecutionId: value }, fresh);
    assert.equal(readRecentSearches(fresh)[0].search_execution_id, null, String(value));
    assert.equal(readRecentSearches(fresh)[0].path, "/search/?q=rats", String(value));
  }
});

test("rerunning a search re-states its execution identity rather than inheriting one", () => {
  const storage = browserStorage();
  recordRecentSearch({ query: "rats", now: at(0), searchExecutionId: EXECUTION_ID }, storage);
  recordRecentSearch({ query: "rats", now: at(1) }, storage);
  const entries = readRecentSearches(storage);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].search_execution_id, null);
  assert.equal(entries[0].executed_at, "2026-09-02T10:01:00.000Z");
});
