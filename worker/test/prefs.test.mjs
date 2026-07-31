// Preference center HTTP handler: list, pause, update, delete, unsub_all.
import { test } from "node:test";
import assert from "node:assert/strict";
import { signToken } from "optin-token";
import { handlePrefs, prefsLink } from "../src/prefs.mjs";
import { prefsPayload } from "../src/lib/prefs.mjs";
import { handleUnsubscribe } from "../src/unsubscribe.mjs";
import { handleAdminWatchLog, handleAdminSubs } from "../src/admin.mjs";

function kv(map = {}) {
  return {
    get: async (k) => (Object.prototype.hasOwnProperty.call(map, k) ? map[k] : null),
    put: async (k, v) => { map[k] = typeof v === "string" ? v : String(v); },
    delete: async (k) => { delete map[k]; },
    list: async (options = {}) => {
      const prefix = options.prefix || "";
      const keys = Object.keys(map).filter((k) => k.startsWith(prefix)).map((k) => ({ name: k }));
      return { keys, list_complete: true };
    },
    _map: map,
  };
}

const SECRET = "t".repeat(32);

async function tokenFor(email) {
  return signToken(SECRET, prefsPayload(email), { ttlSeconds: 3600 });
}

function makeEnv(subsMap) {
  return {
    TOKEN_SECRET: SECRET,
    SUBS: kv(subsMap),
    ALERT_STATE: kv(),
    ADMIN_KEY: "admin",
    CONFIRM_BASE: "https://api.cityscroll.org",
  };
}

test("prefsLink issues prefs-scoped URL", async () => {
  const env = makeEnv({});
  const url = await prefsLink(env, "a@b.co");
  assert.match(url, /^https:\/\/api\.cityscroll\.org\/prefs\?token=/);
});

test("GET /prefs lists watches for the token email", async () => {
  const map = {
    "sub:w1": JSON.stringify({
      email: "example@example.com",
      lens: "money",
      filter: { keywords: ["schools"] },
      freq: "daily",
      createdAt: "2026-01-01T00:00:00.000Z",
    }),
    "sub:other": JSON.stringify({
      email: "other@example.com",
      lens: "money",
      filter: { keywords: ["roads"] },
      freq: "daily",
      createdAt: "2026-01-01T00:00:00.000Z",
    }),
  };
  const env = makeEnv(map);
  const tok = await tokenFor("example@example.com");
  const res = await handlePrefs(new Request(`https://api.cityscroll.org/prefs?token=${encodeURIComponent(tok)}`), env);
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.match(html, /schools/i);
  assert.doesNotMatch(html, /roads/i);
  assert.match(html, /next daily digest run/i);
  assert.match(html, /9am Eastern/i);
});

test("POST pause then unpause", async () => {
  const map = {
    "sub:w1": JSON.stringify({
      email: "example@example.com",
      lens: "money",
      filter: { keywords: ["schools"] },
      freq: "daily",
      createdAt: "2026-01-01T00:00:00.000Z",
    }),
  };
  const env = makeEnv(map);
  const tok = await tokenFor("example@example.com");
  const body = new URLSearchParams({
    token: tok,
    key: "sub:w1",
    action: "pause",
  });
  const res = await handlePrefs(new Request("https://api.cityscroll.org/prefs", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  }), env);
  assert.equal(res.status, 200);
  const stored = JSON.parse(await env.SUBS.get("sub:w1"));
  assert.equal(stored.paused, true);

  const body2 = new URLSearchParams({ token: tok, key: "sub:w1", action: "unpause" });
  await handlePrefs(new Request("https://api.cityscroll.org/prefs", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body2.toString(),
  }), env);
  assert.equal(JSON.parse(await env.SUBS.get("sub:w1")).paused, false);
  const day = new Date().toISOString().slice(0, 10);
  const events = JSON.parse(await env.ALERT_STATE.get(`watchlog:${day}`));
  assert.deepEqual(events.map((event) => event.action), ["pause", "unpause"]);
  assert.equal(events[0].emailRedacted, "ex***@example.com");
  assert.equal(events[0].subKeyMasked, "sub:w1***");
  assert.equal(events[0].lens, "money");
  assert.equal(JSON.parse(await env.ALERT_STATE.get("watchlog:latest")).length, 2);
});

test("POST update keywords and freq", async () => {
  const map = {
    "sub:w1": JSON.stringify({
      email: "example@example.com",
      lens: "money",
      filter: { keywords: ["schools"], minAmount: 1000000 },
      freq: "daily",
      createdAt: "2026-01-01T00:00:00.000Z",
    }),
  };
  const env = makeEnv(map);
  const tok = await tokenFor("example@example.com");
  const body = new URLSearchParams({
    token: tok,
    key: "sub:w1",
    action: "update",
    keywords: "education, libraries",
    freq: "weekly",
  });
  const res = await handlePrefs(new Request("https://api.cityscroll.org/prefs", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: body.toString(),
  }), env);
  assert.equal(res.status, 200);
  const json = await res.json();
  assert.equal(json.ok, true);
  assert.match(json.flash.message, /next daily/i);
  const stored = JSON.parse(await env.SUBS.get("sub:w1"));
  assert.equal(stored.freq, "weekly");
  assert.deepEqual(stored.filter.keywords, ["education", "libraries"]);
  assert.equal(stored.filter.minAmount, 1000000);
});

test("POST delete one watch", async () => {
  const map = {
    "sub:w1": JSON.stringify({
      email: "example@example.com",
      lens: "money",
      filter: { keywords: ["a"] },
      freq: "daily",
      createdAt: "2026-01-01T00:00:00.000Z",
    }),
  };
  const env = makeEnv(map);
  const tok = await tokenFor("example@example.com");
  const body = new URLSearchParams({ token: tok, key: "sub:w1", action: "delete" });
  await handlePrefs(new Request("https://api.cityscroll.org/prefs", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  }), env);
  assert.equal(await env.SUBS.get("sub:w1"), null);
});

test("admin watch log returns recent events and admin subs exposes paused", async () => {
  const env = makeEnv({
    "sub:w1": JSON.stringify({ email: "example@example.com", lens: "money", filter: {}, freq: "daily", paused: true }),
  });
  await env.ALERT_STATE.put(`watchlog:${new Date().toISOString().slice(0, 10)}`, JSON.stringify([
    { at: new Date().toISOString(), action: "pause", emailRedacted: "ex***@example.com", source: "prefs" },
  ]));
  const logRes = await handleAdminWatchLog(new Request("https://w/admin/watch-log?key=admin&days=7"), env);
  assert.equal(logRes.status, 200);
  assert.equal((await logRes.json()).events[0].action, "pause");
  const subsRes = await handleAdminSubs(new Request("https://w/admin/subs?key=admin"), env);
  assert.equal((await subsRes.json()).subs[0].paused, true);
});

test("POST unsub_all removes every watch for email", async () => {
  const map = {
    "sub:w1": JSON.stringify({
      email: "example@example.com",
      lens: "money",
      filter: { keywords: ["a"] },
      freq: "daily",
      createdAt: "2026-01-01T00:00:00.000Z",
    }),
    "sub:w2": JSON.stringify({
      email: "example@example.com",
      lens: "entity",
      filter: { name: "Acme", kind: "vendor" },
      freq: "daily",
      createdAt: "2026-01-01T00:00:00.000Z",
    }),
    "sub:keep": JSON.stringify({
      email: "other@example.com",
      lens: "money",
      filter: { keywords: ["z"] },
      freq: "daily",
      createdAt: "2026-01-01T00:00:00.000Z",
    }),
  };
  const env = makeEnv(map);
  const tok = await tokenFor("example@example.com");
  const body = new URLSearchParams({ token: tok, action: "unsub_all" });
  await handlePrefs(new Request("https://api.cityscroll.org/prefs", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  }), env);
  assert.equal(await env.SUBS.get("sub:w1"), null);
  assert.equal(await env.SUBS.get("sub:w2"), null);
  assert.ok(await env.SUBS.get("sub:keep"));
});

test("unsubscribe all token removes every watch", async () => {
  const map = {
    "sub:w1": JSON.stringify({
      email: "all@example.com",
      lens: "money",
      filter: { keywords: ["a"] },
      freq: "daily",
      createdAt: "2026-01-01T00:00:00.000Z",
    }),
    "sub:w2": JSON.stringify({
      email: "all@example.com",
      lens: "money",
      filter: { keywords: ["b"] },
      freq: "daily",
      createdAt: "2026-01-01T00:00:00.000Z",
    }),
  };
  const env = makeEnv(map);
  const tok = await signToken(SECRET, { all: 1, e: "all@example.com" }, { ttlSeconds: 3600 });
  const res = await handleUnsubscribe(
    new Request(`https://api.cityscroll.org/unsubscribe?token=${encodeURIComponent(tok)}`),
    env,
  );
  assert.equal(res.status, 200);
  assert.equal(await env.SUBS.get("sub:w1"), null);
  assert.equal(await env.SUBS.get("sub:w2"), null);
});

test("cannot mutate another account's watch", async () => {
  const map = {
    "sub:w1": JSON.stringify({
      email: "owner@example.com",
      lens: "money",
      filter: { keywords: ["a"] },
      freq: "daily",
      createdAt: "2026-01-01T00:00:00.000Z",
    }),
  };
  const env = makeEnv(map);
  const tok = await tokenFor("attacker@example.com");
  const body = new URLSearchParams({ token: tok, key: "sub:w1", action: "delete" });
  const res = await handlePrefs(new Request("https://api.cityscroll.org/prefs", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: body.toString(),
  }), env);
  const json = await res.json();
  assert.equal(json.ok, false);
  assert.ok(await env.SUBS.get("sub:w1"), "owner watch still present");
});
