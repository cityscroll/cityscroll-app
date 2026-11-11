// Contract tests for the common CityScroll account identity/session authority
// (worker/src/lib/account.mjs). These mirror the accepted offline proof for the
// engine-owned half — principals, revocable sessions, one-use login challenges,
// scope/audience boundaries, CSRF, and rate limits — and run against node:sqlite
// standing in for D1, exactly as the other worker read-model tests do.
//
// Time is handled in whole seconds here, matching the frozen reference semantics;
// the HTTP adapter converts epoch milliseconds at the boundary.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import {
  AccountStore,
  ContractError,
  authorizeForProduct,
  canonicalJSON,
  csrfTokenFor,
  isCommonSessionToken,
  maskEmail,
  ownerForEmail,
  sha256Hex,
  SESSION_TOKEN_PREFIX,
} from "../src/lib/account.mjs";
import { handleAccount, authorizeIdentity } from "../src/account.mjs";

const MIGRATION = readFileSync(new URL("../migrations/0037_cityscroll_accounts.sql", import.meta.url), "utf8");

// Minimal D1-shaped wrapper over node:sqlite: prepare().bind().run()/.first()/.all().
function wrapD1(sqlite) {
  return {
    prepare(sql) {
      let args = [];
      const wrapper = {
        bind(...values) { args = values; return wrapper; },
        async run() { return sqlite.prepare(sql).run(...args); },
        async first() { return sqlite.prepare(sql).get(...args) ?? null; },
        async all() { return { results: sqlite.prepare(sql).all(...args) }; },
      };
      return wrapper;
    },
  };
}

function freshStore() {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec("PRAGMA foreign_keys=ON;");
  sqlite.exec(MIGRATION);
  const store = new AccountStore(wrapD1(sqlite));
  return { store, sqlite };
}

function seedPrincipal(sqlite, owner, email) {
  sqlite.prepare("INSERT OR IGNORE INTO cityscroll_principals(owner, email, created_at) VALUES(?,?,0)").run(owner, email);
}

async function assertError(status, fn) {
  try {
    await fn();
  } catch (err) {
    if (err instanceof assert.AssertionError) throw err;
    assert.ok(err instanceof ContractError, `expected ContractError, got ${err}`);
    assert.equal(err.status, status, `expected status ${status}, got ${err.status} (${err.reason})`);
    return;
  }
  assert.fail(`expected ContractError ${status} but none was thrown`);
}

test("csrf + origin enforced on mutation; logout and expiry fail closed", async () => {
  const { store, sqlite } = freshStore();
  seedPrincipal(sqlite, "alice", "alice@example.test");
  const { token, csrf } = await store.issueSession("alice", { now: 0 });

  await assertError(403, () => store.authenticate(token, { csrf, origin: "https://evil.example", mutation: true, now: 0 }));
  const ok = await store.authenticate(token, { csrf, origin: "https://cityscroll.org", mutation: true, now: 0 });
  assert.equal(ok.owner, "alice");

  await store.logout(token);
  await assertError(401, () => store.authenticate(token, { now: 0 }));

  const again = await store.issueSession("alice", { now: 0 });
  await assertError(401, () => store.authenticate(again.token, { now: 8 * 86400 }));
});

test("first email login creates only a common civic+procurement identity", async () => {
  const { store, sqlite } = freshStore();
  const link = await store.createChallenge("new@example.test", "browser", 0);
  await store.markDelivered(link);
  const owner = await store.consume(link, "browser", 0);

  assert.equal(await store.principalEmail(owner), "new@example.test");
  assert.equal(owner, await ownerForEmail("new@example.test"));

  const { token } = await store.issueSession(owner, { now: 0 });
  assert.equal((await store.authenticate(token, { audience: "civic", now: 0 })).owner, owner);
  assert.equal((await store.authenticate(token, { audience: "procurement", now: 0 })).owner, owner);
  // Engine identity only: no product tenancy row is created here.
  const principals = sqlite.prepare("SELECT COUNT(*) AS n FROM cityscroll_principals").get().n;
  assert.equal(principals, 1);
});

test("login link does not consume before delivery, under wrong intent, or twice", async () => {
  const { store } = freshStore();
  const link = await store.createChallenge("Alice@Example.test", "browser-intent", 0);
  await assertError(401, () => store.consume(link, "browser-intent", 0)); // not delivered (GET scanner)
  await store.markDelivered(link);
  await assertError(401, () => store.consume(link, "other", 0)); // wrong same-browser intent
  const owner = await store.consume(link, "browser-intent", 0);
  assert.ok(owner.startsWith("a:"));
  await assertError(401, () => store.consume(link, "browser-intent", 0)); // one-use
});

test("expired login link does not consume and leaves the challenge unused", async () => {
  const { store, sqlite } = freshStore();
  const link = await store.createChallenge("alice@example.test", "intent", 0);
  await store.markDelivered(link);
  await assertError(401, () => store.consume(link, "intent", 601));
  const consumedAt = sqlite.prepare("SELECT consumed_at FROM cityscroll_login_challenges").get().consumed_at;
  assert.equal(consumedAt, null);
});

test("one shared session authorizes both products and logout revokes both", async () => {
  const { store, sqlite } = freshStore();
  seedPrincipal(sqlite, "alice", "alice@example.test");
  const { token } = await store.issueSession("alice", { now: 0 });
  assert.equal((await store.authenticate(token, { audience: "civic", now: 0 })).owner, "alice");
  assert.equal((await store.authenticate(token, { audience: "procurement", now: 0 })).owner, "alice");
  await store.logout(token);
  for (const audience of ["civic", "procurement"]) {
    await assertError(401, () => store.authenticate(token, { audience, now: 0 }));
  }
});

test("a civic-only (legacy-style) session cannot enter procurement", async () => {
  const { store, sqlite } = freshStore();
  seedPrincipal(sqlite, "alice", "alice@example.test");
  const { token } = await store.issueSession("alice", { now: 0, scopes: ["civic"] });
  assert.equal((await store.authenticate(token, { audience: "civic", now: 0 })).owner, "alice");
  await assertError(403, () => store.authenticate(token, { audience: "procurement", now: 0 }));
});

test("one principal's logout never revokes another principal's session", async () => {
  const { store, sqlite } = freshStore();
  seedPrincipal(sqlite, "alice", "alice@example.test");
  seedPrincipal(sqlite, "bob", "bob@example.test");
  const a = await store.issueSession("alice", { now: 0 });
  const b = await store.issueSession("bob", { now: 0 });
  await store.logoutAll("bob");
  assert.equal((await store.authenticate(a.token, { now: 0 })).owner, "alice");
  await assertError(401, () => store.authenticate(b.token, { now: 0 }));
});

test("only the session token hash is stored; the raw cookie never persists", async () => {
  const { store, sqlite } = freshStore();
  seedPrincipal(sqlite, "alice", "alice@example.test");
  const { token, csrf } = await store.issueSession("alice", { now: 0 });
  const row = sqlite.prepare("SELECT * FROM cityscroll_sessions").get();
  assert.ok(isCommonSessionToken(token));
  for (const value of Object.values(row)) {
    assert.notEqual(value, token);
    assert.notEqual(value, csrf);
  }
  assert.equal(row.token_hash, await sha256Hex(token));
  assert.equal(row.csrf_hash, await sha256Hex(csrf));
});

test("inactivity window is measured from last activity, not issuance", async () => {
  const { store, sqlite } = freshStore();
  seedPrincipal(sqlite, "alice", "alice@example.test");
  const { token } = await store.issueSession("alice", { now: 0 });
  // Active at day 6: still valid, advances last_seen.
  assert.equal((await store.authenticate(token, { now: 6 * 86400 })).owner, "alice");
  // Day 6 + just under 7 inactive days: still valid (and still inside 14-day absolute).
  assert.equal((await store.authenticate(token, { now: 6 * 86400 + 7 * 86400 - 1 })).owner, "alice");
  // More than 7 days after the last activity: inactivity closes it.
  await assertError(401, () => store.authenticate(token, { now: 13 * 86400 + 7 * 86400 }));
});

test("absolute 14-day lifetime closes even an active session", async () => {
  const { store, sqlite } = freshStore();
  seedPrincipal(sqlite, "alice", "alice@example.test");
  const { token } = await store.issueSession("alice", { now: 0 });
  for (let day = 2; day <= 12; day += 2) {
    assert.equal((await store.authenticate(token, { now: day * 86400 })).owner, "alice");
  }
  await assertError(401, () => store.authenticate(token, { now: 14 * 86400 }));
});

test("product authorization is introspection-only and never leaks email or secret", async () => {
  const { store, sqlite } = freshStore();
  seedPrincipal(sqlite, "alice", "alice@example.test");
  const { token, csrf } = await store.issueSession("alice", { now: 0 });

  const read = await authorizeForProduct(store, { token, now: 0, audience: "procurement" });
  assert.equal(read.authenticated, true);
  assert.equal(read.subject, "alice");
  assert.equal(read.csrfToken, await csrfTokenFor(token)); // reproducible, no rotation
  assert.equal(JSON.stringify(read).includes("alice@example.test"), false);

  const mutate = await authorizeForProduct(store, { token, csrfToken: csrf, origin: "https://cityscroll.org", method: "PUT", now: 0 });
  assert.equal(mutate.authenticated, true);

  // Failures report only authenticated:false — no email, no session secret.
  const badOrigin = await authorizeForProduct(store, { token, csrfToken: csrf, origin: "https://evil.example", method: "PUT", now: 0 });
  assert.deepEqual(badOrigin, { authenticated: false });
  const badToken = await authorizeForProduct(store, { token: `${SESSION_TOKEN_PREFIX}bogus`, now: 0 });
  assert.deepEqual(badToken, { authenticated: false });
});

test("civic readers resolve a v3 session to an email; pins tokens fall through", async () => {
  const { store, sqlite } = freshStore();
  seedPrincipal(sqlite, "alice", "alice@example.test");
  const { token } = await store.issueSession("alice", { now: 0 });
  assert.equal(await store.resolveCivicEmail(token, 0), "alice@example.test");
  // A legacy signed pins token has no v3 prefix and is left to the signed-token path.
  assert.equal(await store.resolveCivicEmail("eyJhbGciOi.pinsish.sig", 0), null);
  await store.logout(token);
  assert.equal(await store.resolveCivicEmail(token, 0), null);
});

test("login sends are rate limited per email, resetting on the next window", async () => {
  const { store } = freshStore();
  const emailHash = await sha256Hex("alice@example.test");
  for (let i = 0; i < 3; i++) {
    assert.equal((await store.loginRateAllowed({ emailHash, ip: "203.0.113.5", now: 0 })).allowed, true);
  }
  // Fourth send inside the same hour exceeds the per-email-hour cap.
  assert.equal((await store.loginRateAllowed({ emailHash, ip: "203.0.113.5", now: 100 })).allowed, false);
  // A send in the next hour is allowed again (hour bucket reset).
  assert.equal((await store.loginRateAllowed({ emailHash, ip: "203.0.113.5", now: 3600 })).allowed, true);
});

test("canonicalJSON sorts keys, preserves array order, and rejects non-finite numbers", async () => {
  assert.equal(canonicalJSON({ b: 1, a: [3, 2, 1] }), '{"a":[3,2,1],"b":1}');
  assert.equal(canonicalJSON(["civic", "procurement"]), '["civic","procurement"]');
  await assertError(400, () => canonicalJSON({ x: Infinity }));
});

test("maskEmail hides the local part while keeping the domain", () => {
  assert.equal(maskEmail("Alice@Example.test"), "a****@example.test");
  assert.equal(maskEmail("bad"), "");
});

// --- HTTP surface: the flow stays inert until explicitly enabled -------------

test("every account route 404s while the flow is disabled", async () => {
  for (const [path, method] of [
    ["/account/v1/login", "POST"],
    ["/account/v1/confirm", "POST"],
    ["/account/v1/me", "GET"],
    ["/account/v1/logout", "POST"],
  ]) {
    const res = await handleAccount(new Request(`https://api.cityscroll.org${path}`, { method }), {}, path);
    assert.equal(res.status, 404);
  }
});

test("GET /me with no session reports authenticated:false (200)", async () => {
  const { sqlite } = freshStore();
  const env = { CITYSCROLL_ACCOUNTS_ENABLED: "true", DB: wrapD1(sqlite) };
  const res = await handleAccount(new Request("https://api.cityscroll.org/account/v1/me", { method: "GET" }), env, "/account/v1/me");
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { authenticated: false });
});

test("the product authorize surface reports subject but never the email, and is read-only off", async () => {
  const { store, sqlite } = freshStore();
  seedPrincipal(sqlite, "alice", "alice@example.test");
  const { token } = await store.issueSession("alice", { now: Math.floor(Date.now() / 1000) });
  const cookie = `cs_session=${token}`;

  // Disabled: the binding authorizes no one.
  assert.deepEqual(await authorizeIdentity({ DB: wrapD1(sqlite) }, { cookie, audience: "procurement" }), { authenticated: false });

  // Enabled: a valid common session authorizes procurement reads without leaking email.
  const env = { CITYSCROLL_ACCOUNTS_ENABLED: "true", DB: wrapD1(sqlite) };
  const ok = await authorizeIdentity(env, { cookie, method: "GET", audience: "procurement" });
  assert.equal(ok.authenticated, true);
  assert.equal(ok.subject, "alice");
  assert.equal(JSON.stringify(ok).includes("alice@example.test"), false);

  // A pins-only cookie (no v3 token) never authorizes procurement.
  assert.deepEqual(
    await authorizeIdentity(env, { cookie: "cs_session=legacy.pins.signed", audience: "procurement" }),
    { authenticated: false },
  );
});
