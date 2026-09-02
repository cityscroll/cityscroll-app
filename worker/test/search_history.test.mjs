/**
 * A recognized account's own recent searches, across its devices.
 *
 * The card's claim is narrow and worth stating precisely: a search performed
 * while the EXISTING email session recognizes a reader becomes visible on any
 * other device that same session recognizes, and nothing else does. These tests
 * hold both halves of that — the journey that must work, and the far longer list
 * of things that must not: another account reading it, an anonymous browser
 * writing into it, an earlier anonymous search being adopted by a later
 * recognition, a browser naming its own account, and any failure in this route
 * costing a reader their ordinary Search.
 *
 * verify: node --test worker/test/search_history.test.mjs
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { signToken } from "optin-token";

import {
  SEARCH_HISTORY_ENTRY_SCHEMA,
  SEARCH_HISTORY_MAX_ENTRIES,
  SEARCH_HISTORY_MAX_REQUEST_BYTES,
  SEARCH_HISTORY_RETENTION_MS,
  canonicalSearchHistoryHref,
  isSearchHistoryEntryId,
  normalizeSearchHistoryRequest,
} from "../../capabilities/search_history.mjs";
import { handleSearchHistory } from "../src/search_history.mjs";
import { handleSession } from "../src/session.mjs";
import { handleSearchActivity } from "../src/search_activity.mjs";
import {
  SEARCH_HISTORY_RETENTION_SECONDS,
  readSearchHistory,
  searchHistoryKey,
} from "../src/lib/search_history.mjs";
import { SEARCH_ACTIVITY_KEY_PREFIX } from "../src/lib/search_activity.mjs";
import { deriveSubscriberId } from "../src/lib/subscriptions.mjs";
import { EMAIL_SESSION_TTL_SECONDS, sessionPayload } from "../src/lib/session.mjs";

const HISTORY_URL = "https://api.cityscroll.org/search-history";
const ORIGIN = "https://cityscroll.org";
const TOKEN_SECRET = "token-secret-for-session-cookies-0123456789";
const READER = "resident@example.org";
const OTHER_READER = "neighbor@example.org";

function kv() {
  const store = new Map();
  const ttls = new Map();
  return {
    store,
    ttls,
    get: async (key) => (store.has(key) ? store.get(key) : null),
    put: async (key, value, options = {}) => {
      store.set(key, value);
      if (options.expirationTtl) ttls.set(key, options.expirationTtl);
    },
    delete: async (key) => { store.delete(key); ttls.delete(key); },
    list: async ({ prefix = "", limit = 1000 } = {}) => {
      const keys = [...store.keys()].filter((key) => key.startsWith(prefix)).sort();
      return { keys: keys.slice(0, limit).map((name) => ({ name })), list_complete: true };
    },
  };
}

function env(overrides = {}) {
  return { TOKEN_SECRET, SUBS: kv(), ALERT_STATE: kv(), ANALYTICS_ENVIRONMENT: "production", ...overrides };
}

/**
 * A device is a cookie jar and nothing else. Two devices for one account differ
 * only in that each ran the email link itself; that is exactly the isolation the
 * card claims, so the tests model it that way rather than sharing a token.
 */
function device(cookie = null) {
  return {
    cookie,
    headers() {
      return this.cookie
        ? { Origin: ORIGIN, Cookie: this.cookie }
        : { Origin: ORIGIN };
    },
  };
}

/** The real journey: a signed email-link token exchanged for a session cookie. */
async function recognizeThroughEmailLink(environment, email, { ttlSeconds } = {}) {
  const linkToken = await signToken(
    environment.TOKEN_SECRET,
    sessionPayload(email),
    { ttlSeconds: ttlSeconds ?? EMAIL_SESSION_TTL_SECONDS },
  );
  const response = await handleSession(
    new Request(`https://api.cityscroll.org/session?token=${encodeURIComponent(linkToken)}&next=https://cityscroll.org/search/`),
    environment,
    "/session",
  );
  assert.equal(response.status, 302, "an email link always lands the reader somewhere");
  const setCookie = response.headers.get("set-cookie");
  if (!setCookie) return device(null);
  return device(setCookie.split(";")[0]);
}

function read(target, environment) {
  return handleSearchHistory(
    new Request(HISTORY_URL, { method: "GET", headers: target.headers() }),
    environment,
  );
}

function write(target, environment, body, extraHeaders = {}) {
  return handleSearchHistory(
    new Request(HISTORY_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...target.headers(), ...extraHeaders },
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
    environment,
  );
}

function entry(query, { scope = {}, occurredAt = "2026-09-02T12:00:00.000Z", executionId = null } = {}) {
  return {
    schema: SEARCH_HISTORY_ENTRY_SCHEMA,
    occurred_at: occurredAt,
    query: { raw: query, normalized: query.toLowerCase() },
    search_path: "/search/",
    scope,
    execution_id: executionId,
  };
}

function append(target, environment, query, options) {
  return write(target, environment, { action: "append", entry: entry(query, options) });
}

async function entriesFor(target, environment) {
  const payload = await (await read(target, environment)).json();
  return payload.entries;
}

// ---- A1: the cross-device journey the card exists for ----

test("a search run on one recognized device is rerunnable on another", async () => {
  const environment = env();
  const deviceA = await recognizeThroughEmailLink(environment, READER);
  assert.ok(deviceA.cookie, "the real email link establishes the session");

  const appended = await append(deviceA, environment, "Rats", { scope: { boro: "Queens" } });
  assert.equal(appended.status, 200);
  assert.equal((await appended.json()).state, "recognized");

  // A second device recognized by the SAME account through its own email link.
  // Its cookie comes from its own exchange, not from device A: nothing is copied
  // between the two, which is what makes this a cross-device result and not a
  // restatement of "the same browser can read what it just wrote".
  const deviceB = await recognizeThroughEmailLink(environment, READER);
  assert.ok(deviceB.cookie, "device B establishes recognition by running the link itself");

  const [remembered] = await entriesFor(deviceB, environment);
  assert.equal(remembered.query, "Rats");
  assert.deepEqual(remembered.scope, { boro: "Queens" });
  // The canonical rerun URL is the whole point: opening it runs the same search.
  assert.equal(remembered.href, "/search/?q=Rats&boro=Queens");
  assert.equal(new URL(remembered.href, ORIGIN).searchParams.get("q"), "Rats");
  assert.equal(new URL(remembered.href, ORIGIN).pathname, "/search/");
});

// ---- A2: bounded read, append, remove, and clear that propagate ----

test("remove and clear on one device reach the other", async () => {
  const environment = env();
  const deviceA = await recognizeThroughEmailLink(environment, READER);
  const deviceB = await recognizeThroughEmailLink(environment, READER);

  await append(deviceA, environment, "rats", { occurredAt: "2026-09-02T12:00:00.000Z" });
  await append(deviceA, environment, "rezoning", { occurredAt: "2026-09-02T13:00:00.000Z" });
  assert.deepEqual((await entriesFor(deviceB, environment)).map((row) => row.query), ["rezoning", "rats"]);

  const removed = await write(deviceB, environment, {
    action: "remove",
    id: canonicalSearchHistoryHref("rats"),
  });
  assert.equal(removed.status, 200);
  assert.deepEqual((await removed.json()).entries.map((row) => row.query), ["rezoning"]);
  assert.deepEqual((await entriesFor(deviceA, environment)).map((row) => row.query), ["rezoning"]);

  const cleared = await write(deviceA, environment, { action: "clear" });
  assert.deepEqual((await cleared.json()).entries, []);
  assert.deepEqual(await entriesFor(deviceB, environment), []);
  assert.equal(
    environment.SUBS.store.has(searchHistoryKey(await deriveSubscriberId(READER))),
    false,
    "clearing removes the row rather than leaving an empty one behind",
  );
});

test("history is bounded to the newest 25 distinct searches", async () => {
  const environment = env();
  const reader = await recognizeThroughEmailLink(environment, READER);
  for (let index = 0; index < SEARCH_HISTORY_MAX_ENTRIES + 12; index += 1) {
    await append(reader, environment, `query-${index}`, {
      occurredAt: `2026-09-02T${String(index % 24).padStart(2, "0")}:00:00.000Z`,
    });
  }
  const entries = await entriesFor(reader, environment);
  assert.equal(entries.length, SEARCH_HISTORY_MAX_ENTRIES);
  const times = entries.map((row) => row.occurred_at);
  assert.deepEqual([...times].sort().reverse(), times, "newest first");
});

test("running the same search again moves it up instead of duplicating it", async () => {
  const environment = env();
  const reader = await recognizeThroughEmailLink(environment, READER);
  await append(reader, environment, "rats", { occurredAt: "2026-09-02T09:00:00.000Z" });
  await append(reader, environment, "rezoning", { occurredAt: "2026-09-02T10:00:00.000Z" });
  // Different words, same search once normalized.
  await append(reader, environment, "RATS", { occurredAt: "2026-09-02T11:00:00.000Z" });

  const entries = await entriesFor(reader, environment);
  assert.equal(entries.length, 2);
  assert.deepEqual(entries.map((row) => row.query), ["RATS", "rezoning"]);
  assert.equal(entries[0].href, "/search/?q=RATS", "the link carries the words most recently typed");
});

test("the same words in a different place are a different search", async () => {
  const environment = env();
  const reader = await recognizeThroughEmailLink(environment, READER);
  await append(reader, environment, "rats", { occurredAt: "2026-09-02T09:00:00.000Z" });
  await append(reader, environment, "rats", { scope: { boro: "Queens" }, occurredAt: "2026-09-02T10:00:00.000Z" });
  assert.equal((await entriesFor(reader, environment)).length, 2);
});

test("stored rows carry the bounded expiration and expired ones stop being read", async () => {
  const environment = env();
  const reader = await recognizeThroughEmailLink(environment, READER);
  await append(reader, environment, "rats");
  const subscriberId = await deriveSubscriberId(READER);
  assert.equal(environment.SUBS.ttls.get(searchHistoryKey(subscriberId)), SEARCH_HISTORY_RETENTION_SECONDS);

  // The retention boundary is read against an explicit instant supplied here, so
  // it is a stated fact about the window rather than a claim about the clock the
  // suite happened to run under.
  const ranAtMs = Date.parse("2026-09-02T12:00:00.000Z");
  const stored = { entries: [{
    id: canonicalSearchHistoryHref("ancient"),
    query: "ancient",
    scope: {},
    href: canonicalSearchHistoryHref("ancient"),
    occurred_at: new Date(ranAtMs).toISOString(),
    execution_id: null,
  }] };
  await environment.SUBS.put(searchHistoryKey(subscriberId), JSON.stringify(stored));

  const inside = await readSearchHistory(environment, subscriberId, {
    nowMs: ranAtMs + SEARCH_HISTORY_RETENTION_MS,
  });
  assert.deepEqual(inside.entries.map((row) => row.query), ["ancient"]);

  const past = await readSearchHistory(environment, subscriberId, {
    nowMs: ranAtMs + SEARCH_HISTORY_RETENTION_MS + 1,
  });
  assert.deepEqual(past.entries, [], "a row older than the window stops being readable");
});

// ---- A2/A3: account isolation is a property of the key, not a check ----

test("another account can neither read nor mutate this history", async () => {
  const environment = env();
  const reader = await recognizeThroughEmailLink(environment, READER);
  const stranger = await recognizeThroughEmailLink(environment, OTHER_READER);
  await append(reader, environment, "rats");

  assert.deepEqual(await entriesFor(stranger, environment), [], "a separate account starts empty");

  // The stranger names the reader's entry id exactly. Ids are not capabilities:
  // the row addressed is always the caller's own, so this removes nothing.
  const attempt = await write(stranger, environment, {
    action: "remove",
    id: canonicalSearchHistoryHref("rats"),
  });
  assert.equal(attempt.status, 200);
  assert.deepEqual((await attempt.json()).entries, []);
  assert.deepEqual((await entriesFor(reader, environment)).map((row) => row.query), ["rats"]);

  await write(stranger, environment, { action: "clear" });
  assert.deepEqual((await entriesFor(reader, environment)).map((row) => row.query), ["rats"]);

  // The two accounts occupy two distinct keys and neither key names an address.
  const readerKey = searchHistoryKey(await deriveSubscriberId(READER));
  const strangerKey = searchHistoryKey(await deriveSubscriberId(OTHER_READER));
  assert.notEqual(readerKey, strangerKey);
  for (const key of [readerKey, strangerKey]) {
    assert.ok(!key.includes("@"), "a storage key never carries an address");
  }
});

test("a request cannot name the account it wants", async () => {
  const environment = env();
  const reader = await recognizeThroughEmailLink(environment, READER);
  await append(reader, environment, "rats");
  const stranger = await recognizeThroughEmailLink(environment, OTHER_READER);

  // Every shape a caller might use to address someone else is an unknown field.
  for (const body of [
    { action: "append", entry: entry("theirs"), email: READER },
    { action: "append", entry: entry("theirs"), subscriber_id: await deriveSubscriberId(READER) },
    { action: "clear", subscriber_id: await deriveSubscriberId(READER) },
  ]) {
    const response = await write(stranger, environment, body);
    assert.equal(response.status, 400);
    assert.equal((await response.json()).reason, "unknown_field");
  }
  assert.deepEqual((await entriesFor(reader, environment)).map((row) => row.query), ["rats"]);
});

// ---- A3: anonymous activity is never adopted ----

test("an anonymous browser is told so, gets nothing, and stores nothing", async () => {
  const environment = env();
  const anonymous = device(null);

  const readResponse = await read(anonymous, environment);
  assert.equal(readResponse.status, 200);
  const readBody = await readResponse.json();
  assert.equal(readBody.state, "unrecognized");
  assert.deepEqual(readBody.entries, []);

  const appended = await append(anonymous, environment, "rats");
  assert.equal((await appended.json()).state, "unrecognized");
  assert.equal(environment.SUBS.store.size, 0, "nothing anonymous is ever written");
});

test("recognizing later never adopts searches run before recognition", async () => {
  const environment = env();
  const browser = device(null);
  await append(browser, environment, "searched-before-recognition");
  assert.equal(environment.SUBS.store.size, 0);

  // The same browser now runs the email link. Its earlier search is not its
  // account's search and no code path exists that could make it one.
  const recognized = await recognizeThroughEmailLink(environment, READER);
  assert.deepEqual(await entriesFor(recognized, environment), []);

  await append(recognized, environment, "searched-after-recognition");
  assert.deepEqual(
    (await entriesFor(recognized, environment)).map((row) => row.query),
    ["searched-after-recognition"],
  );
});

test("nothing the browser receives identifies the account", async () => {
  const environment = env();
  const reader = await recognizeThroughEmailLink(environment, READER);
  const response = await append(reader, environment, "rats", {
    scope: { boro: "Queens" },
    executionId: "exec_abcdefgh12345678",
  });
  const body = await response.json();
  const serialized = JSON.stringify(body);

  for (const secret of [READER, await deriveSubscriberId(READER), "subscriber:", "@example.org"]) {
    assert.ok(!serialized.includes(secret), `the response must not carry ${secret}`);
  }
  assert.deepEqual(Object.keys(body).sort(), ["entries", "limit", "ok", "schema", "state"]);
  assert.deepEqual(Object.keys(body.entries[0]).sort(), [
    "execution_id", "href", "id", "occurred_at", "query", "scope",
  ]);
  assert.equal(body.entries[0].execution_id, "exec_abcdefgh12345678");
});

test("the two projections of one recognized search stay independent", async () => {
  const environment = env();
  const reader = await recognizeThroughEmailLink(environment, READER);

  // The receipt stream keeps its private per-execution evidence...
  const receipt = await handleSearchActivity(new Request("https://api.cityscroll.org/search-activity", {
    method: "POST",
    headers: { Origin: ORIGIN, "Content-Type": "application/json", Cookie: reader.cookie },
    body: JSON.stringify({
      schema: "cityscroll.search_execution.v1",
      occurred_at: "2026-09-02T12:00:00.000Z",
      query: { raw: "rats", normalized: "rats" },
      search_path: "/search/",
      scope: {},
      outcome: "empty",
      rendered_count: 0,
      family_counts: {},
      incomplete_families: [],
      results: [],
      producers: {},
    }),
  }), environment);
  assert.equal(receipt.status, 202);
  await append(reader, environment, "rats");

  // ...and the account history keeps none of it. Different stores, different
  // keys, and no field in one that can be used to reach the other.
  const stored = [...environment.ALERT_STATE.store.entries()]
    .filter(([key]) => key.startsWith(SEARCH_ACTIVITY_KEY_PREFIX))
    .map(([, value]) => JSON.parse(value));
  assert.equal(stored.length, 1);
  assert.ok(stored[0].visitor_id && stored[0].network, "the receipt keeps operational fields");

  const [remembered] = await entriesFor(reader, environment);
  assert.equal(remembered.execution_id, null, "no id crosses from the receipt stream");
  const serialized = JSON.stringify(remembered);
  assert.ok(!serialized.includes(stored[0].visitor_id));
  assert.ok(!serialized.includes(stored[0].execution_id));
  assert.ok(!serialized.includes(stored[0].receipt_id));
});

// ---- A4: credentialed CORS, caching, recognition failures, storage failures ----

test("every answer is credentialed, uncached, and varies on origin and cookie", async () => {
  const environment = env();
  const reader = await recognizeThroughEmailLink(environment, READER);
  const responses = [
    await read(reader, environment),
    await read(device(null), environment),
    await append(reader, environment, "rats"),
    await handleSearchHistory(new Request(HISTORY_URL, { method: "OPTIONS", headers: { Origin: ORIGIN } }), environment),
    await handleSearchHistory(new Request(HISTORY_URL, { method: "DELETE", headers: { Origin: ORIGIN } }), environment),
  ];
  for (const response of responses) {
    assert.equal(response.headers.get("Access-Control-Allow-Origin"), ORIGIN);
    assert.equal(response.headers.get("Access-Control-Allow-Credentials"), "true");
    assert.equal(response.headers.get("Cache-Control"), "no-store");
    assert.equal(response.headers.get("Vary"), "Origin, Cookie");
  }
  assert.equal(responses[3].status, 204);
  assert.equal(responses[4].status, 405);
  assert.equal(responses[4].headers.get("Allow"), "GET, POST, OPTIONS");
});

test("a foreign origin is refused before anything is read", async () => {
  const environment = env();
  const reader = await recognizeThroughEmailLink(environment, READER);
  await append(reader, environment, "rats");
  const response = await handleSearchHistory(
    new Request(HISTORY_URL, { method: "GET", headers: { Origin: "https://evil.example", Cookie: reader.cookie } }),
    environment,
  );
  assert.equal(response.status, 403);
  const body = await response.json();
  assert.equal(body.reason, "origin");
  assert.deepEqual(body.entries, []);
  assert.notEqual(response.headers.get("Access-Control-Allow-Origin"), "https://evil.example");
  assert.notEqual(response.headers.get("Access-Control-Allow-Origin"), "*");
});

test("expired recognition and a missing cookie read the same as anonymous", async () => {
  const environment = env();
  const reader = await recognizeThroughEmailLink(environment, READER);
  await append(reader, environment, "rats");

  const expiredToken = await signToken(TOKEN_SECRET, sessionPayload(READER), { ttlSeconds: -1 });
  const cases = [
    device(null),
    device("cs_session="),
    device(`cs_session=${expiredToken}`),
    device("cs_session=not-a-token"),
    device("cs_session=eyJhbGciOiJub25lIn0.eyJlIjoicmVzaWRlbnRAZXhhbXBsZS5vcmciLCJzYyI6InBpbnMifQ."),
  ];
  for (const target of cases) {
    const body = await (await read(target, environment)).json();
    assert.equal(body.state, "unrecognized", `expected anonymous for ${target.cookie}`);
    assert.deepEqual(body.entries, []);
  }
  // The reader's own history is untouched by any of it.
  assert.deepEqual((await entriesFor(reader, environment)).map((row) => row.query), ["rats"]);
});

test("an unavailable store degrades instead of pretending the change landed", async () => {
  const withoutStore = env({ SUBS: undefined });
  const reader = await recognizeThroughEmailLink(withoutStore, READER);
  const readBody = await (await read(reader, withoutStore)).json();
  assert.equal(readBody.ok, false);
  assert.equal(readBody.state, "unavailable");
  assert.deepEqual(readBody.entries, []);

  const appendBody = await (await append(reader, withoutStore, "rats")).json();
  assert.equal(appendBody.ok, false);
  assert.equal(appendBody.state, "unavailable");
});

test("a store that throws on write reports the failure and keeps what was there", async () => {
  const environment = env();
  const reader = await recognizeThroughEmailLink(environment, READER);
  await append(reader, environment, "rats");

  environment.SUBS.put = async () => { throw new Error("store unavailable"); };
  const body = await (await append(reader, environment, "rezoning")).json();
  assert.equal(body.ok, false);
  assert.equal(body.state, "unavailable");
  assert.deepEqual(body.entries.map((row) => row.query), ["rats"], "the reader still sees what is stored");
});

test("a refused clear reports the history that is still there, not an empty one", async () => {
  const environment = env();
  const reader = await recognizeThroughEmailLink(environment, READER);
  await append(reader, environment, "rats");

  environment.SUBS.delete = async () => { throw new Error("store unavailable"); };
  const body = await (await write(reader, environment, { action: "clear" })).json();
  assert.equal(body.ok, false);
  assert.equal(body.state, "unavailable");
  assert.deepEqual(body.entries.map((row) => row.query), ["rats"],
    "a failed clear must not read as a successful one");
});

test("malformed stored state reads as no history and is replaced on the next write", async () => {
  const environment = env();
  const reader = await recognizeThroughEmailLink(environment, READER);
  const key = searchHistoryKey(await deriveSubscriberId(READER));
  for (const corrupt of ["not json at all", "[]", '{"entries":"nope"}', '{"entries":[{"id":"../../etc"},null,7]}']) {
    await environment.SUBS.put(key, corrupt);
    assert.deepEqual(await entriesFor(reader, environment), [], `corrupt state: ${corrupt}`);
  }
  await append(reader, environment, "rats");
  assert.deepEqual((await entriesFor(reader, environment)).map((row) => row.query), ["rats"]);
});

// ---- malformed requests are rejected, never trimmed ----

test("malformed actions, ids, entries, and payloads are refused", async () => {
  const environment = env();
  const reader = await recognizeThroughEmailLink(environment, READER);
  const cases = [
    [{ action: "list" }, 400, "action"],
    [{}, 400, "action"],
    [{ action: "remove" }, 400, "id"],
    [{ action: "remove", id: "/browse/?q=rats" }, 400, "id"],
    [{ action: "remove", id: "https://evil.example/search/?q=rats" }, 400, "id"],
    [{ action: "remove", id: "/search/?q=rats&secret=1" }, 400, "id"],
    [{ action: "append" }, 400, "not_an_object"],
    [{ action: "append", entry: entry("rats", { occurredAt: "yesterday" }) }, 400, "occurred_at"],
    [{ action: "append", entry: { ...entry("rats"), schema: "something.else" } }, 400, "schema"],
    [{ action: "append", entry: { ...entry("rats"), search_path: "/browse/" } }, 400, "search_path"],
    [{ action: "append", entry: { ...entry("rats"), scope: { tracking: "1" } } }, 400, "unknown_field"],
    [{ action: "append", entry: { ...entry("rats"), execution_id: "nope" } }, 400, "execution_id"],
    [{ action: "append", entry: { ...entry("rats"), query: { raw: "", normalized: "" } } }, 400, "query"],
    ["{not json", 400, "bad-json"],
  ];
  for (const [body, status, reason] of cases) {
    const response = await write(reader, environment, body);
    assert.equal(response.status, status, `body: ${JSON.stringify(body)}`);
    assert.equal((await response.json()).reason, reason, `body: ${JSON.stringify(body)}`);
  }
  assert.deepEqual(await entriesFor(reader, environment), [], "nothing malformed was stored");
});

test("an oversized payload is refused by declared and actual length alike", async () => {
  const environment = env();
  const reader = await recognizeThroughEmailLink(environment, READER);
  const huge = JSON.stringify({
    action: "append",
    entry: entry("x".repeat(SEARCH_HISTORY_MAX_REQUEST_BYTES)),
  });
  assert.ok(huge.length > SEARCH_HISTORY_MAX_REQUEST_BYTES);
  assert.equal((await write(reader, environment, huge)).status, 413);
  assert.equal(
    (await write(reader, environment, { action: "clear" }, { "Content-Length": String(SEARCH_HISTORY_MAX_REQUEST_BYTES + 1) })).status,
    413,
  );
});

test("a malformed body is refused without revealing whether the browser is recognized", async () => {
  const environment = env();
  const reader = await recognizeThroughEmailLink(environment, READER);
  const recognizedAnswer = await write(reader, environment, { action: "nope" });
  const anonymousAnswer = await write(device(null), environment, { action: "nope" });
  assert.equal(recognizedAnswer.status, anonymousAnswer.status);
  assert.deepEqual(await recognizedAnswer.json(), await anonymousAnswer.json());
});

// ---- the contract itself ----

test("an entry id is the canonical URL of its normalized search", () => {
  assert.equal(canonicalSearchHistoryHref("rats", { boro: "Queens" }), "/search/?q=rats&boro=Queens");
  // Scope order is fixed by the contract, not by the caller.
  assert.equal(
    canonicalSearchHistoryHref("rats", { council: "3", boro: "Queens" }),
    canonicalSearchHistoryHref("rats", { boro: "Queens", council: "3" }),
  );
  assert.ok(isSearchHistoryEntryId("/search/?q=rats"));
  assert.ok(!isSearchHistoryEntryId("/search/"));
  assert.ok(!isSearchHistoryEntryId("//evil.example/search/?q=rats"));
  assert.ok(!isSearchHistoryEntryId("/search/?boro=Queens&q=rats"), "a re-ordered id is not one we minted");
});

test("the request contract rejects unknown fields rather than dropping them", () => {
  assert.deepEqual(
    normalizeSearchHistoryRequest({ action: "clear", extra: 1 }),
    { ok: false, reason: "unknown_field" },
  );
  assert.equal(normalizeSearchHistoryRequest({ action: "clear" }).ok, true);
});
