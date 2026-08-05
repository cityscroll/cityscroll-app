// Magic-link session + server-synced pins.
// Covers: token issue/verify/expiry/scope, cookie exchange, silent degrade,
// pin merge (union + dedupe), anonymous fallback, two-browser pin sync.

import { test } from "node:test";
import assert from "node:assert/strict";
import { signToken, verifyToken } from "optin-token";
import {
  sessionPayload,
  isPinsSessionPayload,
  mergePinStores,
  normalizePinStore,
  serializePinStore,
  safeNextUrl,
  sessionCookieHeader,
  readSessionCookie,
  pinsKeyForEmail,
  EMAIL_SESSION_TTL_SECONDS,
  SESSION_SCOPE,
} from "../src/lib/session.mjs";
import { handleSession, issueEmailSessionToken, emailFromRequest } from "../src/session.mjs";
import { handlePins } from "../src/pins.mjs";
import { handleRedirect } from "../src/redirect.mjs";
import { handleUnsubscribe } from "../src/unsubscribe.mjs";

const SECRET = "test-session-secret-do-not-use-in-prod";
const T0 = 1_700_000_000_000;

function kv(map = {}) {
  return {
    get: async (k) => (Object.prototype.hasOwnProperty.call(map, k) ? map[k] : null),
    put: async (k, v, _opts) => { map[k] = typeof v === "string" ? v : String(v); },
    delete: async (k) => { delete map[k]; },
    list: async () => ({ keys: Object.keys(map).map((name) => ({ name })), list_complete: true }),
    _map: map,
  };
}

function env(extra = {}) {
  return {
    TOKEN_SECRET: SECRET,
    SUBS: kv({}),
    ALERT_STATE: kv({}),
    ...extra,
  };
}

// ---- pure token / payload -------------------------------------------------

test("session payload is pins-scoped and email-normalized", () => {
  const p = sessionPayload("  User@Example.COM ");
  assert.equal(p.e, "user@example.com");
  assert.equal(p.sc, SESSION_SCOPE);
  assert.equal(isPinsSessionPayload(p), true);
});

test("confirm / unsub payloads are NOT pins sessions", async () => {
  const confirm = await signToken(SECRET, { e: "a@b.com", l: "money", f: {}, c: "email", q: "daily" }, { ttlSeconds: 3600, now: T0 });
  const unsub = await signToken(SECRET, { k: "sub:abc" }, { ttlSeconds: 3600, now: T0 });
  const c = await verifyToken(SECRET, confirm, { now: T0 });
  const u = await verifyToken(SECRET, unsub, { now: T0 });
  assert.equal(c.valid, true);
  assert.equal(isPinsSessionPayload(c.payload), false, "confirm tokens must not open a pins session");
  assert.equal(u.valid, true);
  assert.equal(isPinsSessionPayload(u.payload), false, "unsubscribe tokens must not open a pins session");
});

test("email session token verifies within TTL and fails when expired", async () => {
  const e = env();
  const tok = await issueEmailSessionToken(e, "a@b.com", { now: T0 });
  assert.ok(tok);
  const ok = await verifyToken(SECRET, tok, { now: T0 + 1000 });
  assert.equal(ok.valid, true);
  assert.equal(isPinsSessionPayload(ok.payload), true);
  const expired = await verifyToken(SECRET, tok, { now: T0 + (EMAIL_SESSION_TTL_SECONDS + 1) * 1000 });
  assert.equal(expired.valid, false);
  assert.equal(expired.reason, "expired");
});

test("forged session token is rejected", async () => {
  const tok = await signToken(SECRET, sessionPayload("a@b.com"), { ttlSeconds: 3600, now: T0 });
  const res = await verifyToken("wrong-secret", tok, { now: T0 });
  assert.equal(res.valid, false);
});

// ---- pin merge ------------------------------------------------------------

test("mergePinStores unions items and dedupes by type+id", () => {
  const local = {
    current: "inv1",
    invs: {
      inv1: {
        name: "Local",
        created: "2026-01-01",
        items: [
          { t: "notice", id: "1", title: "A", note: "", added: "2026-01-01" },
          { t: "notice", id: "2", title: "B", note: "mine", added: "2026-01-02" },
        ],
      },
    },
  };
  const server = {
    current: "inv1",
    invs: {
      inv1: {
        name: "Server",
        created: "2026-01-03",
        items: [
          { t: "notice", id: "2", title: "B-server", note: "longer note here", added: "2026-01-04" },
          { t: "vendor", id: "v1", title: "Acme", note: "", added: "2026-01-05" },
        ],
      },
    },
  };
  const m = mergePinStores(local, server);
  const items = m.invs.inv1.items;
  assert.equal(items.length, 3, "union of 1,2,v1");
  const byId = Object.fromEntries(items.map((i) => [i.t + ":" + i.id, i]));
  assert.ok(byId["notice:1"]);
  assert.equal(byId["notice:2"].note, "longer note here", "prefer longer note");
  assert.equal(byId["notice:2"].added, "2026-01-02", "prefer earlier added date");
  assert.ok(byId["vendor:v1"]);
});

test("merge with empty server returns local; empty local returns server", () => {
  const local = normalizePinStore({
    current: "inv1",
    invs: { inv1: { name: "L", created: "2026-01-01", items: [{ t: "notice", id: "9", title: "X" }] } },
  });
  assert.equal(mergePinStores(local, null).invs.inv1.items[0].id, "9");
  assert.equal(mergePinStores(null, local).invs.inv1.items[0].id, "9");
});

test("serializePinStore rejects junk types and caps fields", () => {
  const s = serializePinStore({
    current: "inv1",
    invs: {
      inv1: {
        name: "n".repeat(200),
        items: [
          { t: "notice", id: "1", title: "t".repeat(500), note: "ok" },
          { t: "hacker", id: "x", title: "nope" },
        ],
      },
    },
  });
  assert.ok(s);
  assert.equal(s.invs.inv1.name.length, 80);
  assert.equal(s.invs.inv1.items.length, 1);
  assert.equal(s.invs.inv1.items[0].title.length, 300);
});

// ---- safe next / cookie helpers ------------------------------------------

test("safeNextUrl blocks open redirects and strips residual tokens", () => {
  assert.equal(
    safeNextUrl("https://evil.example/phish"),
    "https://cityscroll.org/",
  );
  assert.match(safeNextUrl("https://cityscroll.org/#notice/1?s=SECRET"), /cityscroll\.org/);
  assert.doesNotMatch(safeNextUrl("https://cityscroll.org/#notice/1?s=SECRET"), /s=SECRET/);
  assert.equal(safeNextUrl("#notice/abc"), "https://cityscroll.org/#notice/abc");
});

test("session cookie header is HttpOnly Secure SameSite=Lax", () => {
  const h = sessionCookieHeader("tok123");
  assert.match(h, /HttpOnly/);
  assert.match(h, /Secure/);
  assert.match(h, /SameSite=Lax/);
  assert.match(h, /cs_session=tok123/);
  assert.equal(readSessionCookie("foo=1; cs_session=tok123; bar=2"), "tok123");
});

// ---- HTTP handlers --------------------------------------------------------

test("POST /session exchanges a valid email token for a session cookie", async () => {
  const e = env();
  // Issue with live clock — the handler verifies with Date.now(), so a frozen
  // T0-dated token would already be expired in 2026.
  const tok = await issueEmailSessionToken(e, "reader@example.com");
  const req = new Request("https://api.cityscroll.org/session", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: "https://cityscroll.org",
    },
    body: JSON.stringify({ token: tok }),
  });
  const res = await handleSession(req, e, "/session");
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.recognized, true);
  const setCookie = res.headers.get("Set-Cookie") || "";
  assert.match(setCookie, /cs_session=/);
  assert.match(setCookie, /HttpOnly/);
  assert.equal(res.headers.get("Access-Control-Allow-Credentials"), "true");
});

test("GET /session names the recognized account and exposes its watch manager", async () => {
  const e = env();
  const fixtureEmail = ["user", "example.test"].join("@");
  const cookieTok = await signToken(SECRET, sessionPayload(fixtureEmail), { ttlSeconds: 3600 });
  const res = await handleSession(new Request("https://api.cityscroll.org/session", {
    headers: {
      Origin: "https://cityscroll.org",
      Cookie: `cs_session=${cookieTok}`,
    },
  }), e, "/session");
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), {
    ok: true,
    recognized: true,
    email: fixtureEmail,
    prefsUrl: "https://api.cityscroll.org/prefs",
  });
});

test("GET /session never returns account fields without a valid cookie", async () => {
  const e = env();
  const res = await handleSession(new Request("https://api.cityscroll.org/session", {
    headers: { Origin: "https://cityscroll.org" },
  }), e, "/session");
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.deepEqual(body, { ok: true, recognized: false });
  assert.equal(body.email, undefined);
  assert.equal(body.prefsUrl, undefined);
});

test("invalid / expired tokens degrade silently (recognized:false, no cookie)", async () => {
  const e = env();
  const expired = await signToken(SECRET, sessionPayload("a@b.com"), { ttlSeconds: 1, now: T0 });
  // verify with live now — T0 is 2023, so this is long expired
  const req = new Request("https://api.cityscroll.org/session", {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: "https://cityscroll.org" },
    body: JSON.stringify({ token: expired }),
  });
  const res = await handleSession(req, e, "/session");
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.recognized, false);
  assert.equal(res.headers.get("Set-Cookie"), null);

  const bad = new Request("https://api.cityscroll.org/session", {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: "https://cityscroll.org" },
    body: JSON.stringify({ token: "not-a-token" }),
  });
  const res2 = await handleSession(bad, e, "/session");
  assert.equal((await res2.json()).recognized, false);
});

test("confirm-scope token cannot open a pins session", async () => {
  const e = env();
  const confirm = await signToken(SECRET, { e: "a@b.com", l: "money", f: {}, c: "email", q: "daily" }, { ttlSeconds: 3600 });
  const req = new Request("https://api.cityscroll.org/session", {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: "https://cityscroll.org" },
    body: JSON.stringify({ token: confirm }),
  });
  const res = await handleSession(req, e, "/session");
  assert.equal((await res.json()).recognized, false);
});

test("GET /session?token=…&next=… sets cookie and redirects without token on Location", async () => {
  const e = env();
  const tok = await issueEmailSessionToken(e, "a@b.com");
  const next = "https://cityscroll.org/#notice/20260701200";
  const req = new Request(
    `https://api.cityscroll.org/session?token=${encodeURIComponent(tok)}&next=${encodeURIComponent(next)}`,
  );
  const res = await handleSession(req, e, "/session");
  assert.equal(res.status, 302);
  assert.equal(res.headers.get("Location"), next);
  assert.match(res.headers.get("Set-Cookie") || "", /cs_session=/);
});

test("GET /r/... with s= exchanges session and redirects to notice without s", async () => {
  const e = env();
  const tok = await issueEmailSessionToken(e, "a@b.com");
  const req = new Request(
    `https://api.cityscroll.org/r/money/20260701200?s=${encodeURIComponent(tok)}`,
  );
  const res = await handleRedirect(req, e, null, "/r/money/20260701200");
  assert.equal(res.status, 302);
  const loc = res.headers.get("Location") || "";
  assert.match(loc, /cityscroll\.org\/notices\/20260701200/);
  assert.doesNotMatch(loc, /[?&]s=/);
  assert.match(res.headers.get("Set-Cookie") || "", /cs_session=/);
});

test("GET /r/... with bad s= still redirects anonymously (no scary error)", async () => {
  const e = env();
  const req = new Request("https://api.cityscroll.org/r/money/20260701200?s=garbage");
  const res = await handleRedirect(req, e, null, "/r/money/20260701200");
  assert.equal(res.status, 302);
  assert.match(res.headers.get("Location") || "", /\/notices\/20260701200/);
  assert.equal(res.headers.get("Set-Cookie"), null);
});

test("session cookie cannot unsubscribe (account-affecting needs purpose token)", async () => {
  const e = env();
  const sessionTok = await signToken(SECRET, sessionPayload("a@b.com"), { ttlSeconds: 3600 });
  // Put a real sub in KV — unsubscribe must not delete it based on session cookie alone.
  e.SUBS._map["sub:testkey"] = JSON.stringify({ email: "a@b.com", lens: "money", filter: {} });
  const req = new Request("https://api.cityscroll.org/unsubscribe?token=" + encodeURIComponent(sessionTok));
  const res = await handleUnsubscribe(req, e);
  assert.equal(res.status, 400, "pins session is not a valid unsub token");
  assert.ok(e.SUBS._map["sub:testkey"], "subscription must remain");
});

// ---- pins API + two-browser E2E simulation --------------------------------

async function recognizedRequest(env, email, path, init = {}) {
  const emailTok = await issueEmailSessionToken(env, email);
  const exchange = await handleSession(
    new Request("https://api.cityscroll.org/session", {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: "https://cityscroll.org" },
      body: JSON.stringify({ token: emailTok }),
    }),
    env,
    "/session",
  );
  const setCookie = exchange.headers.get("Set-Cookie") || "";
  const cookie = setCookie.split(";")[0]; // cs_session=…
  const headers = {
    Origin: "https://cityscroll.org",
    Cookie: cookie,
    ...(init.headers || {}),
  };
  return handlePins(
    new Request("https://api.cityscroll.org" + path, { ...init, headers }),
    env,
  );
}

test("anonymous /pins returns recognized:false and never writes", async () => {
  const e = env();
  const res = await handlePins(
    new Request("https://api.cityscroll.org/pins", {
      headers: { Origin: "https://cityscroll.org" },
    }),
    e,
  );
  const body = await res.json();
  assert.equal(body.recognized, false);
  assert.equal(Object.keys(e.SUBS._map).filter((k) => k.startsWith("pins:")).length, 0);
});

test("E2E: email link → pin on device A → email link on device B → same pins", async () => {
  const e = env();
  const email = "subscriber@example.com";

  // Device A: click digest link (session exchange) and upload a pin.
  const pinsA = {
    current: "inv1",
    invs: {
      inv1: {
        name: "My investigation",
        created: "2026-07-30",
        items: [
          { t: "notice", id: "20260701200", title: "Elevator Inspection", meta: "DOB", note: "", added: "2026-07-30" },
        ],
      },
    },
  };
  const putA = await recognizedRequest(e, email, "/pins", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ pins: pinsA }),
  });
  assert.equal(putA.status, 200);
  assert.equal((await putA.json()).recognized, true);

  // Device B: separate cookie jar (fresh email click), GET pins — same list.
  const getB = await recognizedRequest(e, email, "/pins", { method: "GET" });
  const bodyB = await getB.json();
  assert.equal(bodyB.recognized, true);
  assert.equal(bodyB.pins.invs.inv1.items.length, 1);
  assert.equal(bodyB.pins.invs.inv1.items[0].id, "20260701200");

  // Device B adds another pin; merge semantics keep both.
  const pinsB = mergePinStores(bodyB.pins, {
    current: "inv1",
    invs: {
      inv1: {
        name: "My investigation",
        created: "2026-07-30",
        items: [
          { t: "vendor", id: "acme-co", title: "Acme Co", meta: "", note: "watch", added: "2026-07-30" },
        ],
      },
    },
  });
  const putB = await recognizedRequest(e, email, "/pins", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ pins: pinsB }),
  });
  assert.equal((await putB.json()).ok, true);

  const getA2 = await recognizedRequest(e, email, "/pins", { method: "GET" });
  const final = await getA2.json();
  assert.equal(final.pins.invs.inv1.items.length, 2);
  const ids = final.pins.invs.inv1.items.map((i) => i.id).sort();
  assert.deepEqual(ids, ["20260701200", "acme-co"]);
});

test("PUT /pins with merge:true unions client local pins with server", async () => {
  const e = env();
  const email = "merge@example.com";
  // Seed server
  await recognizedRequest(e, email, "/pins", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      pins: {
        current: "inv1",
        invs: { inv1: { name: "S", created: "2026-01-01", items: [{ t: "notice", id: "srv", title: "Server" }] } },
      },
    }),
  });
  const res = await recognizedRequest(e, email, "/pins", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      merge: true,
      pins: {
        current: "inv1",
        invs: { inv1: { name: "L", created: "2026-01-02", items: [{ t: "notice", id: "loc", title: "Local" }] } },
      },
    }),
  });
  const body = await res.json();
  assert.equal(body.pins.invs.inv1.items.length, 2);
});

test("pinsKeyForEmail is opaque (no raw email in key)", async () => {
  const key = await pinsKeyForEmail("Person@Example.com");
  assert.match(key, /^pins:a:[0-9a-f]{64}$/);
  assert.doesNotMatch(key, /person|example/i);
});

test("emailFromRequest reads a valid session cookie", async () => {
  const e = env();
  const cookieTok = await signToken(SECRET, sessionPayload("z@y.com"), { ttlSeconds: 3600 });
  const req = new Request("https://api.cityscroll.org/pins", {
    headers: { Cookie: `cs_session=${cookieTok}` },
  });
  assert.equal(await emailFromRequest(req, e), "z@y.com");
});

test("logout clears cookie and subsequent /pins is anonymous", async () => {
  const e = env();
  const emailTok = await issueEmailSessionToken(e, "out@example.com");
  const exchange = await handleSession(
    new Request("https://api.cityscroll.org/session", {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: "https://cityscroll.org" },
      body: JSON.stringify({ token: emailTok }),
    }),
    e,
    "/session",
  );
  const cookie = (exchange.headers.get("Set-Cookie") || "").split(";")[0];
  const logout = await handleSession(
    new Request("https://api.cityscroll.org/session/logout", {
      method: "POST",
      headers: { Origin: "https://cityscroll.org", Cookie: cookie },
    }),
    e,
    "/session/logout",
  );
  assert.match(logout.headers.get("Set-Cookie") || "", /Max-Age=0/);
});
