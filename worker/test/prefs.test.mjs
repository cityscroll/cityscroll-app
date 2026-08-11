// Preference center HTTP handler: list, pause, update, delete, unsub_all.
import { test } from "node:test";
import assert from "node:assert/strict";
import { signToken } from "optin-token";
import { handlePrefs, prefsLink } from "../src/prefs.mjs";
import { prefsPayload } from "../src/lib/prefs.mjs";
import { sessionPayload } from "../src/lib/session.mjs";
import { handleUnsubscribe } from "../src/unsubscribe.mjs";
import { handleAdminWatchLog, handleAdminWatchLogEnrich, handleAdminSubs } from "../src/admin.mjs";

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
const TEST_EMAIL = ["watcher", "example.com"].join("@");
const OTHER_EMAIL = ["other", "example.com"].join("@");
const ALL_EMAIL = ["all", "example.com"].join("@");
const REDACTED_EMAIL = `${TEST_EMAIL.slice(0, 2)}***${TEST_EMAIL.slice(TEST_EMAIL.indexOf("@"))}`;
const OWNER_EMAIL = ["owner", "example.com"].join("@");
const ATTACKER_EMAIL = ["attacker", "example.com"].join("@");

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

function prefsUrl(origin, token = "") {
  const url = new URL("/prefs", origin);
  if (token) url.searchParams.set("token", token);
  return url;
}

test("prefsLink issues prefs-scoped URL", async () => {
  const env = makeEnv({});
  const url = await prefsLink(env, ["a", "b.co"].join("@"));
  const parsed = new URL(url);
  assert.equal(parsed.origin, "https://cityscroll.org");
  assert.equal(parsed.pathname, "/prefs");
  assert.ok(parsed.searchParams.get("token"));
});

test("GET /prefs lists watches for the token email", async () => {
  const map = {
    "sub:w1": JSON.stringify({
      email: TEST_EMAIL,
      lens: "money",
      filter: { keywords: ["schools"] },
      freq: "daily",
      createdAt: "2026-01-01T00:00:00.000Z",
    }),
    "sub:other": JSON.stringify({
      email: OTHER_EMAIL,
      lens: "money",
      filter: { keywords: ["roads"] },
      freq: "daily",
      createdAt: "2026-01-01T00:00:00.000Z",
    }),
  };
  const env = makeEnv(map);
  const tok = await tokenFor(TEST_EMAIL);
  const res = await handlePrefs(new Request(prefsUrl("https://cityscroll.org", tok)), env);
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.match(html, /schools/i);
  assert.doesNotMatch(html, /roads/i);
  assert.match(html, /next digest/i);
  assert.match(html, /9am Eastern/i);
  assert.match(html, /takes effect immediately/i);
  assert.match(html, /14 days/i);
});

test("GET /prefs bridges a recognized session into the same account's watch manager", async () => {
  const env = makeEnv({
    "sub:w1": JSON.stringify({
      email: TEST_EMAIL,
      lens: "money",
      filter: { keywords: ["schools"] },
      freq: "daily",
      createdAt: "2026-01-01T00:00:00.000Z",
    }),
    "sub:other": JSON.stringify({
      email: OTHER_EMAIL,
      lens: "money",
      filter: { keywords: ["roads"] },
      freq: "daily",
    }),
  });
  const sessionToken = await signToken(SECRET, sessionPayload(TEST_EMAIL), { ttlSeconds: 3600 });
  const res = await handlePrefs(new Request("https://cityscroll.org/prefs", {
    headers: { Cookie: `cs_session=${sessionToken}` },
  }), env);
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.match(html, /schools/i);
  assert.doesNotMatch(html, /roads/i);
  assert.match(html, /name="token" value="[^\"]+"/);
  assert.doesNotMatch(html, new RegExp(sessionToken.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});

test("GET /prefs shows the recognized account's empty state", async () => {
  const env = makeEnv({});
  const sessionToken = await signToken(SECRET, sessionPayload(TEST_EMAIL), { ttlSeconds: 3600 });
  const res = await handlePrefs(new Request("https://cityscroll.org/prefs", {
    headers: { Cookie: `cs_session=${sessionToken}` },
  }), env);
  assert.equal(res.status, 200);
  assert.match(await res.text(), /No active watches for this address/i);
});

test("a stale manage token cannot override a recognized session", async () => {
  const env = makeEnv({
    "sub:w1": JSON.stringify({
      email: TEST_EMAIL,
      lens: "money",
      filter: { keywords: ["schools"] },
      freq: "daily",
    }),
  });
  const sessionToken = await signToken(SECRET, sessionPayload(TEST_EMAIL), { ttlSeconds: 3600 });
  const res = await handlePrefs(new Request("https://cityscroll.org/prefs?token=your-token-here", {
    headers: { Cookie: `cs_session=${sessionToken}` },
  }), env);

  assert.equal(res.status, 200);
  const html = await res.text();
  assert.match(html, /schools/i);
  assert.doesNotMatch(html, /Link not valid/i);
  assert.doesNotMatch(html, /name="token" value="your-token-here"/);
});

test("anonymous /prefs remains invalid and leaks no account email", async () => {
  const env = makeEnv({
    "sub:w1": JSON.stringify({ email: TEST_EMAIL, lens: "money", filter: {}, freq: "daily" }),
  });
  const res = await handlePrefs(new Request("https://cityscroll.org/prefs"), env);
  assert.equal(res.status, 400);
  const html = await res.text();
  assert.doesNotMatch(html, new RegExp(TEST_EMAIL, "i"));
  assert.doesNotMatch(html, /schools/i);
});

test("shared API-host preference documents permanently recover to the canonical host", async () => {
  const response = await handlePrefs(new Request(prefsUrl("https://api.cityscroll.org", "shared")), {});
  assert.equal(response.status, 301);
  assert.equal(response.headers.get("location"), prefsUrl("https://cityscroll.org", "shared").toString());
});

test("session cookie alone cannot POST a watch mutation", async () => {
  const env = makeEnv({
    "sub:w1": JSON.stringify({ email: TEST_EMAIL, lens: "money", filter: {}, freq: "daily" }),
  });
  const sessionToken = await signToken(SECRET, sessionPayload(TEST_EMAIL), { ttlSeconds: 3600 });
  const res = await handlePrefs(new Request("https://api.cityscroll.org/prefs", {
    method: "POST",
    headers: {
      Cookie: `cs_session=${sessionToken}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({ action: "delete", key: "sub:w1" }).toString(),
  }), env);
  assert.equal(res.status, 400);
  assert.ok(await env.SUBS.get("sub:w1"));
});

test("POST pause then unpause", async () => {
  const map = {
    "sub:w1": JSON.stringify({
      email: TEST_EMAIL,
      lens: "money",
      filter: { keywords: ["schools"] },
      freq: "daily",
      createdAt: "2026-01-01T00:00:00.000Z",
    }),
  };
  const env = makeEnv(map);
  const tok = await tokenFor(TEST_EMAIL);
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
  assert.equal(events[0].emailRedacted, REDACTED_EMAIL);
  assert.equal(events[0].subKeyMasked, "sub:w1***");
  assert.equal(events[0].lens, "money");
  assert.equal(events[0].label, "Contracts and RFPs — about “schools”");
  assert.equal(events[0].freq, "daily");
  assert.equal(events[1].label, "Contracts and RFPs — about “schools”");
  assert.equal(events[1].freq, "daily");
  assert.equal(JSON.parse(await env.ALERT_STATE.get("watchlog:latest")).length, 2);
});

test("POST update keywords and freq", async () => {
  const map = {
    "sub:w1": JSON.stringify({
      email: TEST_EMAIL,
      lens: "money",
      filter: { keywords: ["schools"], minAmount: 1000000 },
      freq: "daily",
      createdAt: "2026-01-01T00:00:00.000Z",
    }),
  };
  const env = makeEnv(map);
  const tok = await tokenFor(TEST_EMAIL);
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
  assert.match(json.flash.message, /next digest/i);
  const stored = JSON.parse(await env.SUBS.get("sub:w1"));
  assert.equal(stored.freq, "weekly");
  assert.deepEqual(stored.filter.keywords, ["education", "libraries"]);
  assert.equal(stored.filter.minAmount, 1000000);
  const events = JSON.parse(await env.ALERT_STATE.get("watchlog:latest"));
  assert.equal(events[0].label, "Contracts and RFPs — about “education / libraries” · ≥ $1,000,000");
  assert.equal(events[0].freq, "weekly");
  assert.match(events[0].detail, /freq daily → weekly/);
  assert.match(events[0].detail, /filter: .*schools.* → .*education \/ libraries/);
  assert.deepEqual(events[0].before, {
    label: "Contracts and RFPs — about “schools” · ≥ $1,000,000",
    freq: "daily",
    paused: false,
  });
  assert.deepEqual(events[0].after, {
    label: "Contracts and RFPs — about “education / libraries” · ≥ $1,000,000",
    freq: "weekly",
    paused: false,
  });
});

test("POST update describes a filter-only change", async () => {
  const env = makeEnv({
    "sub:w1": JSON.stringify({
      email: TEST_EMAIL,
      lens: "money",
      filter: { keywords: ["schools"] },
      freq: "daily",
    }),
  });
  const tok = await tokenFor(TEST_EMAIL);
  await handlePrefs(new Request("https://api.cityscroll.org/prefs", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token: tok, key: "sub:w1", action: "update", keywords: "parks" }),
  }), env);
  const [event] = JSON.parse(await env.ALERT_STATE.get("watchlog:latest"));
  assert.equal(event.freq, "daily");
  assert.match(event.detail, /^filter: .*schools.* → .*parks/);
});

test("POST delete one watch", async () => {
  const map = {
    "sub:w1": JSON.stringify({
      email: TEST_EMAIL,
      lens: "money",
      filter: { keywords: ["a"] },
      freq: "daily",
      createdAt: "2026-01-01T00:00:00.000Z",
    }),
  };
  const env = makeEnv(map);
  const tok = await tokenFor(TEST_EMAIL);
  const body = new URLSearchParams({ token: tok, key: "sub:w1", action: "delete" });
  await handlePrefs(new Request("https://api.cityscroll.org/prefs", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  }), env);
  assert.equal(await env.SUBS.get("sub:w1"), null);
  const [event] = JSON.parse(await env.ALERT_STATE.get("watchlog:latest"));
  assert.equal(event.label, "Contracts and RFPs — about “a”");
  assert.equal(event.freq, "daily");
});

test("admin watch-log enrich uses live watches and explicit deleted-watch overrides", async () => {
  const env = makeEnv({
    "sub:w1-long-key": JSON.stringify({
      email: TEST_EMAIL,
      lens: "entity",
      filter: { name: "Acacia", kind: "vendor" },
      freq: "weekly",
    }),
  });
  const at = "2026-08-01T00:58:39.000Z";
  const missingAt = "2026-08-01T00:57:00.000Z";
  const events = [
    { at, action: "delete", subKeyMasked: "sub:15***", source: "prefs" },
    { at: "2026-08-01T00:58:53.000Z", action: "update", subKeyMasked: "sub:w1***", source: "prefs" },
    { at: missingAt, action: "delete", subKeyMasked: "sub:zz***", source: "prefs" },
  ];
  await env.ALERT_STATE.put("watchlog:latest", JSON.stringify(events));
  await env.ALERT_STATE.put("watchlog:2026-08-01", JSON.stringify(events));
  const res = await handleAdminWatchLogEnrich(new Request("https://w/admin/watch-log/enrich?key=admin", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      days: 1,
      date: "2026-08-01",
      overrides: [{
        at,
        action: "delete",
        subKeyMasked: "sub:15***",
        label: "Contracts and RFPs — awards only · ≥ $100,000,000",
        freq: "daily",
        detail: "deleted",
      }],
    }),
  }), env);
  assert.equal(res.status, 200);
  const result = await res.json();
  assert.deepEqual(result, { scanned: 6, enriched: 4, unchanged: 2 });
  const enriched = JSON.parse(await env.ALERT_STATE.get("watchlog:latest"));
  assert.equal(enriched[0].label, "Contracts and RFPs — awards only · ≥ $100,000,000");
  assert.equal(enriched[0].detail, "deleted");
  assert.equal(enriched[1].label, "vendor “Acacia” — every new City Record notice naming them");
  assert.equal(enriched[1].freq, "weekly");
  assert.equal(enriched[2].label, undefined);
});

test("admin watch log returns recent events and admin subs exposes paused", async () => {
  const env = makeEnv({
    "sub:w1": JSON.stringify({ email: TEST_EMAIL, lens: "money", filter: {}, freq: "daily", paused: true }),
  });
  await env.ALERT_STATE.put(`watchlog:${new Date().toISOString().slice(0, 10)}`, JSON.stringify([
    { at: new Date().toISOString(), action: "pause", emailRedacted: REDACTED_EMAIL, source: "prefs" },
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
      email: TEST_EMAIL,
      lens: "money",
      filter: { keywords: ["a"] },
      freq: "daily",
      createdAt: "2026-01-01T00:00:00.000Z",
    }),
    "sub:w2": JSON.stringify({
      email: TEST_EMAIL,
      lens: "entity",
      filter: { name: "Acme", kind: "vendor" },
      freq: "daily",
      createdAt: "2026-01-01T00:00:00.000Z",
    }),
    "sub:keep": JSON.stringify({
      email: OTHER_EMAIL,
      lens: "money",
      filter: { keywords: ["z"] },
      freq: "daily",
      createdAt: "2026-01-01T00:00:00.000Z",
    }),
  };
  const env = makeEnv(map);
  const tok = await tokenFor(TEST_EMAIL);
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
      email: ALL_EMAIL,
      lens: "money",
      filter: { keywords: ["a"] },
      freq: "daily",
      createdAt: "2026-01-01T00:00:00.000Z",
    }),
    "sub:w2": JSON.stringify({
      email: ALL_EMAIL,
      lens: "money",
      filter: { keywords: ["b"] },
      freq: "daily",
      createdAt: "2026-01-01T00:00:00.000Z",
    }),
  };
  const env = makeEnv(map);
  const tok = await signToken(SECRET, { all: 1, e: ALL_EMAIL }, { ttlSeconds: 3600 });
  const res = await handleUnsubscribe(
    new Request(`https://api.cityscroll.org/unsubscribe?token=${encodeURIComponent(tok)}`),
    env,
  );
  assert.equal(res.status, 200);
  assert.equal(await env.SUBS.get("sub:w1"), null);
  assert.equal(await env.SUBS.get("sub:w2"), null);
  const events = JSON.parse(await env.ALERT_STATE.get("watchlog:latest"));
  assert.deepEqual(events.map((event) => event.label), [
    "Contracts and RFPs — about “a”",
    "Contracts and RFPs — about “b”",
  ]);
  assert.deepEqual(events.map((event) => event.freq), ["daily", "daily"]);
});

test("cannot mutate another account's watch", async () => {
  const map = {
    "sub:w1": JSON.stringify({
      email: OWNER_EMAIL,
      lens: "money",
      filter: { keywords: ["a"] },
      freq: "daily",
      createdAt: "2026-01-01T00:00:00.000Z",
    }),
  };
  const env = makeEnv(map);
  const tok = await tokenFor(ATTACKER_EMAIL);
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
