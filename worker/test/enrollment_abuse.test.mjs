import { fixtureRecipient } from "./helpers/mail_recipient.mjs";
// Enrollment abuse instrumentation (Item 2): bounded pseudonymous signup-decision
// receipts, per-route accepted-volume ceiling, transactional-mail budget, and
// per-route temporary containment, verified across every enrollment pathway —
// /subscribe (browser verified challenge), /subscribe-pack, and the shared account
// sign-in — plus the delivery-hold contract the private product intake consumes.
//
//   node --test test/enrollment_abuse.test.mjs   (from worker/)
//
// All provider and challenge interaction is a stubbed fetch; no real network and
// no real recipient or address appears here, and no real mail is ever sent.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

import { handleSubscribe as realHandleSubscribe } from "../src/subscribe.mjs";
import { handleMonitorPackSubscribe as realHandlePack } from "../src/monitor_packs.mjs";
import { handleAccount } from "../src/account.mjs";
import { recipientHash, reconcileRecipientSuppressions, deliveryHoldForRecipient } from "../src/lib/recipient_suppression.mjs";
import {
  rotatingActorKey,
  recordSignupDecision,
  observeAcceptedEnrollment,
  routeContainmentActive,
  CONTAINMENT_ALL_ROUTES,
} from "../src/lib/enrollment_instrumentation.mjs";

const MIGRATION = [
  "../migrations/0036_recipient_delivery_trust.sql",
  "../migrations/0037_cityscroll_accounts.sql",
  "../migrations/0038_operator_recipient_holds.sql",
  "../migrations/0039_enrollment_instrumentation.sql",
].map((path) => readFileSync(new URL(path, import.meta.url), "utf8")).join("\n");
const SECRET = "enrollment-abuse-tests-token-secret-32bytes";

const handleSubscribe = (req, env) => realHandleSubscribe(req, env, { verifyTurnstile: async () => ({ ok: true }) });
const handlePack = (req, env) => realHandlePack(req, env, { verifyTurnstile: async () => ({ ok: true }) });

function d1() {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(MIGRATION);
  return {
    sqlite,
    DB: {
      prepare(sql) {
        const statement = sqlite.prepare(sql);
        return {
          bind(...params) {
            return {
              async run() { const result = statement.run(...params); return { meta: { changes: Number(result.changes || 0) } }; },
              async first() { return statement.get(...params) || null; },
              async all() { return { results: statement.all(...params) }; },
            };
          },
        };
      },
    },
  };
}

class KV {
  constructor() { this.data = new Map(); }
  async get(key) { return this.data.has(key) ? this.data.get(key) : null; }
  async put(key, value) { this.data.set(key, String(value)); }
  async delete(key) { this.data.delete(key); }
  async list({ prefix = "" } = {}) {
    return { keys: [...this.data.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name })), list_complete: true };
  }
}

function env(DB, overrides = {}) {
  return {
    TOKEN_SECRET: SECRET,
    RESEND_API_KEY: "resend-key",
    ALERTS_FROM: fixtureRecipient("sender"),
    SUBS: new KV(),
    ALERT_STATE: new KV(),
    CONFIRM_BASE: "https://api.cityscroll.org",
    DB,
    ...overrides,
  };
}

const ok200 = () => new Response(JSON.stringify({ id: "msg_ok" }), { status: 200 });

// A combined network stub: the Turnstile siteverify endpoint (success) and the
// Resend send endpoint. Any other fetch is a test bug.
function stubNetwork({ resend = ok200 } = {}) {
  const calls = { resend: [], siteverify: [] };
  const original = globalThis.fetch;
  globalThis.fetch = async (url, options = {}) => {
    const href = String(url);
    if (href.includes("challenges.cloudflare.com")) {
      calls.siteverify.push(href);
      return new Response(JSON.stringify({ success: true }), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (href.includes("api.resend.com")) {
      calls.resend.push({ headers: { ...options.headers }, body: options.body ? JSON.parse(options.body) : null });
      return resend(calls.resend.length);
    }
    throw new Error("unexpected fetch: " + href);
  };
  return { calls, restore() { globalThis.fetch = original; } };
}

function subscribeRequest(email, ip) {
  return new Request("https://api.cityscroll.org/subscribe", {
    method: "POST",
    headers: { "content-type": "application/json", origin: "https://cityscroll.org", "CF-Connecting-IP": ip },
    body: JSON.stringify({ email, lens: "money", filter: {} }),
  });
}
const signupAs = (environment, email, ip) => handleSubscribe(subscribeRequest(email, ip), environment);

function packRequest(email, ip, children) {
  return new Request("https://api.cityscroll.org/subscribe-pack", {
    method: "POST",
    headers: { "content-type": "application/json", origin: "https://cityscroll.org", "CF-Connecting-IP": ip },
    body: JSON.stringify({ email, pack_id: "civic-starter", children }),
  });
}

// ---- G2a: bounded pseudonymous receipts -------------------------------------

test("a signup-decision receipt stores a rotating pseudonymous key, never the raw IP or address", async () => {
  const { sqlite, DB } = d1();
  const environment = env(DB);
  const ip = "203.0.113.42";
  const address = fixtureRecipient("reader");
  await recordSignupDecision(environment, {
    route: "subscribe", actor: ip, challenge: "verified", rateDecision: "allowed",
    accepted: true, welcomeOutcome: "sent", now: new Date("2026-11-20T15:30:00Z"),
  });
  const row = sqlite.prepare("SELECT * FROM signup_decision_receipts").get();
  assert.ok(row.pseudo_key.startsWith("k:"));
  assert.equal(row.route, "subscribe");
  assert.equal(row.bucket, "2026-11-20T15");
  assert.equal(row.rotation_window, "2026-11-20");
  assert.equal(row.accepted, 1);
  assert.equal(row.welcome_outcome, "sent");
  const serialized = JSON.stringify(row);
  assert.ok(!serialized.includes(ip), "the raw IP never appears in the receipt");
  assert.ok(!serialized.includes(address), "no address is stored");
});

test("the pseudonymous key is stable within a window, rotates across windows, and separates actors", async () => {
  const environment = env(null);
  const ip = "198.51.100.5";
  const day1a = await rotatingActorKey(environment, ip, new Date("2026-11-20T01:00:00Z"));
  const day1b = await rotatingActorKey(environment, ip, new Date("2026-11-20T23:00:00Z"));
  const day2 = await rotatingActorKey(environment, ip, new Date("2026-11-21T01:00:00Z"));
  const other = await rotatingActorKey(environment, "198.51.100.6", new Date("2026-11-20T01:00:00Z"));
  assert.equal(day1a, day1b, "same actor, same window → same key");
  assert.notEqual(day1a, day2, "the key rotates across windows");
  assert.notEqual(day1a, other, "different actors → different keys");
  assert.ok(!day1a.includes(ip), "the key does not contain the actor");
});

test("observeAcceptedEnrollment returns a counts-only summary with no actor data", async () => {
  const { DB } = d1();
  const summary = await observeAcceptedEnrollment(env(DB), {
    route: "subscribe", actor: "203.0.113.9", challenge: "verified", welcomeOutcome: "sent",
  }, { emitAlert: async () => ({ sent: false }) });
  const keys = Object.keys(summary).sort();
  assert.deepEqual(keys, ["contained", "mail_budget", "mail_count", "mail_over", "rotation_window", "route", "route_budget", "route_count", "route_over"]);
  assert.ok(!JSON.stringify(summary).includes("203.0.113.9"));
});

// ---- G2b: accepted-volume ceiling + per-route containment --------------------

test("distributed signups past the route ceiling arm temporary containment that refuses further accepts", async () => {
  const { sqlite, DB } = d1();
  const environment = env(DB, { ENROLLMENT_ACCEPTED_BUDGET: "3" });
  const net = stubNetwork();
  try {
    // Three DISTINCT actors (distinct IPs and addresses): no per-actor rate limit
    // trips, yet their combined volume crosses the route ceiling.
    for (let i = 0; i < 3; i += 1) {
      const res = await signupAs(environment, fixtureRecipient(`person${i}`), `198.51.100.${10 + i}`);
      assert.equal(res.status, 200);
    }
    assert.equal(net.calls.resend.length, 3, "all three legitimate signups before the ceiling succeed");

    const containment = sqlite.prepare("SELECT * FROM enrollment_containment WHERE route = 'subscribe'").get();
    assert.ok(containment, "the route is placed under containment");
    assert.equal(containment.reason, "accepted-volume-over-budget");
    assert.ok(Date.parse(containment.expires_at) > Date.now(), "containment has an explicit future expiry");
    assert.ok([...environment.ALERT_STATE.data.keys()].some((k) => k.startsWith("ops:alert:signature:")),
      "an ops alert was routed for the volume ceiling");

    // A fourth distinct actor is now contained — refused, no welcome.
    const fourth = await signupAs(environment, fixtureRecipient("person4"), "198.51.100.14");
    assert.equal(fourth.status, 429);
    assert.equal((await fourth.json()).reason, "contained");
    assert.equal(net.calls.resend.length, 3, "the contained signup sends no mail");
  } finally { net.restore(); }
});

test("containment expires on its own and does not ban an actor permanently", async () => {
  const { sqlite, DB } = d1();
  const environment = env(DB);
  // Arm containment directly with an already-past expiry.
  sqlite.prepare(`INSERT INTO enrollment_containment
    (route, armed_at, expires_at, reason, rotation_window, observed_count, budget)
    VALUES ('subscribe', '2026-11-20T00:00:00Z', '2026-11-20T01:00:00Z', 'accepted-volume-over-budget', '2026-11-20', 9, 3)`).run();
  const expired = await routeContainmentActive(environment, "subscribe", new Date("2026-11-20T02:00:00Z"));
  assert.equal(expired, null, "an elapsed containment no longer holds");

  const net = stubNetwork();
  try {
    const res = await signupAs(environment, fixtureRecipient("after-expiry"), "198.51.100.50");
    assert.equal(res.status, 200, "signups resume once containment expires");
    assert.equal(net.calls.resend.length, 1);
  } finally { net.restore(); }
});

test("the transactional-mail budget arms global containment across every route", async () => {
  const { sqlite, DB } = d1();
  const environment = env(DB, { TRANSACTIONAL_MAIL_BUDGET: "2", ENROLLMENT_ACCEPTED_BUDGET: "1000" });
  const net = stubNetwork();
  try {
    await signupAs(environment, fixtureRecipient("mb1"), "198.51.100.71");
    await signupAs(environment, fixtureRecipient("mb2"), "198.51.100.72");
    assert.equal(net.calls.resend.length, 2);
    const all = sqlite.prepare("SELECT * FROM enrollment_containment WHERE route = ?").get(CONTAINMENT_ALL_ROUTES);
    assert.ok(all, "the mail budget arms the all-routes containment");
    assert.equal(all.reason, "transactional-mail-budget-exhausted");

    // Both the single-watch route and the pack route are now contained.
    const subscribe = await signupAs(environment, fixtureRecipient("mb3"), "198.51.100.73");
    assert.equal(subscribe.status, 429);
    const pack = await handlePack(packRequest(fixtureRecipient("mb4"), "198.51.100.74", [
      { label: "Housing money", lens: "money", filter: {} },
    ]), environment);
    assert.equal(pack.status, 429);
    assert.equal((await pack.json()).reason, "contained");
    assert.equal(net.calls.resend.length, 2, "no mail is sent once the budget is exhausted");
  } finally { net.restore(); }
});

// ---- G2c: every enrollment pathway refuses a held recipient, legit succeeds --

test("subscribe-pack: a legitimate pack welcomes once; a held recipient's pack is enrolled but never mailed", async () => {
  const { sqlite, DB } = d1();
  const environment = env(DB);
  const net = stubNetwork();
  try {
    const good = await handlePack(packRequest(fixtureRecipient("packgood"), "198.51.100.81", [
      { label: "Money", lens: "money", filter: {} },
      { label: "Land", lens: "land", filter: {} },
    ]), environment);
    assert.equal(good.status, 200);
    assert.equal(net.calls.resend.length, 1, "one welcome for the pack recipient");

    // An operator-held recipient: the pack enrolls the children but sends no mail.
    seedHold(sqlite, await recipientHash(fixtureRecipient("packheld")));
    const held = await handlePack(packRequest(fixtureRecipient("packheld"), "198.51.100.82", [
      { label: "Money", lens: "money", filter: {} },
    ]), environment);
    assert.equal(held.status, 200, "the held recipient is still enrolled");
    assert.equal(net.calls.resend.length, 1, "no welcome is sent to a held recipient via the pack path");
  } finally { net.restore(); }
});

test("account sign-in: legitimate login sends mail; a quarantined or suppressed recipient gets the generic 202 and no mail", async () => {
  const { sqlite, DB } = d1();
  const environment = env(DB, {
    CITYSCROLL_ACCOUNTS_ENABLED: "true",
    TURNSTILE_SECRET: "1x0000000000000000000000000000000AA", // documented testing PASS secret
    ANALYTICS_ENVIRONMENT: "development",
  });
  const login = (email) => handleAccount(new Request("https://cityscroll.org/account/v1/login", {
    method: "POST",
    headers: { "content-type": "application/json", origin: "https://cityscroll.org", "CF-Connecting-IP": "198.51.100.90" },
    body: JSON.stringify({ email, turnstileToken: "token" }),
  }), environment, "/account/v1/login");

  const net = stubNetwork();
  try {
    const good = await login(fixtureRecipient("signin"));
    assert.equal(good.status, 202);
    assert.equal(net.calls.resend.length, 1, "a legitimate sign-in sends the login mail");

    seedHold(sqlite, await recipientHash(fixtureRecipient("quarantined")));
    const held = await login(fixtureRecipient("quarantined"));
    assert.equal(held.status, 202, "the response stays generic so the hold never leaks");
    assert.equal(net.calls.resend.length, 1, "no sign-in mail to an operator-held recipient");

    await reconcileRecipientSuppressions(DB, pageSource([{ entries: [{ email: fixtureRecipient("bounced"), reason: "bounce" }] }]),
      { authority: "2026-11-20T00:00:00Z", mode: "apply" });
    const suppressed = await login(fixtureRecipient("bounced"));
    assert.equal(suppressed.status, 202);
    assert.equal(net.calls.resend.length, 1, "no sign-in mail to a provider-suppressed recipient");
  } finally { net.restore(); }
});

test("the delivery-hold contract a product-intake consumer reads refuses suppressed OR quarantined", async () => {
  const { sqlite, DB } = d1();
  // This task does not modify the product intake; it exposes one boundary the
  // consumer calls. Prove that boundary refuses on either independent fact.
  seedHold(sqlite, await recipientHash(fixtureRecipient("q")));
  await reconcileRecipientSuppressions(DB, pageSource([{ entries: [{ email: fixtureRecipient("s"), reason: "complaint" }] }]),
    { authority: "2026-11-20T00:00:00Z", mode: "apply" });

  assert.equal((await deliveryHoldForRecipient(DB, fixtureRecipient("q")))?.holds.includes("operator-quarantine"), true);
  assert.equal((await deliveryHoldForRecipient(DB, fixtureRecipient("s")))?.holds.includes("provider-suppression"), true);
  assert.equal(await deliveryHoldForRecipient(DB, fixtureRecipient("clear")), null, "a clear recipient is not held");
});

// ---- helpers ----------------------------------------------------------------

async function* pageSource(pages) {
  for (const page of pages) yield page;
}

function seedHold(sqlite, hash) {
  sqlite.prepare(`INSERT INTO operator_recipient_holds
    (recipient_hash, reason, provenance, held_at, lifted_at)
    VALUES (?, 'presumptive-spam-quarantine', 'incident-manifest-a', '2026-03-01T00:00:00Z', NULL)`).run(hash);
}
