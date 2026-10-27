// Recipient-level delivery trust: provider suppression reconciliation (dry-run/apply,
// idempotent, all-or-nothing) and the one-welcome-per-recipient D1 claim ledger.
//
//   node --test test/subscription_trust.test.mjs   (from worker/)
//
// All provider interaction is a stubbed fetch or a fixture page source; no real
// network and no real recipient appears here.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

import { handleSubscribe } from "../src/subscribe.mjs";
import { processOneSub } from "../src/alerts.mjs";
import {
  recipientHash,
  reconcileRecipientSuppressions,
  suppressionForRecipient,
} from "../src/lib/recipient_suppression.mjs";
import {
  claimWelcomeDelivery,
  completeWelcomeDelivery,
  migrateExistingRosterWelcomeClaims,
  welcomeIdempotencyKey,
} from "../src/lib/welcome_outbox.mjs";

const MIGRATION = readFileSync(
  new URL("../migrations/0036_recipient_delivery_trust.sql", import.meta.url), "utf8");
const SECRET = "subscription-trust-tests-token-secret-32b";
const DAY_MS = 24 * 60 * 60 * 1000;

// ---- in-memory D1 over the real migration ------------------------------------------------

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
              async run() {
                const result = statement.run(...params);
                return { meta: { changes: Number(result.changes || 0) } };
              },
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
    return {
      keys: [...this.data.keys()].filter((key) => key.startsWith(prefix)).map((name) => ({ name })),
      list_complete: true,
    };
  }
}

function env(DB) {
  return {
    TOKEN_SECRET: SECRET,
    RESEND_API_KEY: "resend-key",
    SUBS: new KV(),
    ALERT_STATE: new KV(),
    CONFIRM_BASE: "https://api.cityscroll.org",
    DB,
  };
}

// ---- fixture provider --------------------------------------------------------

async function* pageSource(pages, { failAt = -1 } = {}) {
  for (let i = 0; i < pages.length; i += 1) {
    if (i === failAt) throw new Error("provider page fetch failed");
    yield pages[i];
  }
}

function stubProvider(respond) {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, options = {}) => {
    if (!String(url).includes("api.resend.com")) throw new Error("unexpected fetch: " + url);
    calls.push({ headers: { ...options.headers }, body: JSON.parse(options.body) });
    return respond(calls.length);
  };
  return { calls, restore() { globalThis.fetch = original; } };
}

const ok200 = () => new Response(JSON.stringify({ id: "msg_ok" }), { status: 200 });

async function signup(environment, email) {
  return handleSubscribe(new Request("https://api.cityscroll.org/subscribe", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: "https://cityscroll.org",
      "CF-Connecting-IP": "198.51.100.99",
    },
    body: JSON.stringify({ email, lens: "money", filter: {} }),
  }), environment);
}

// ---- G1: suppression reconciliation -----------------------------------------

test("reconciliation folds a complete multi-page export, normalizes, and preserves other provenance", async () => {
  const { sqlite, DB } = d1();
  // An operator-recorded suppression from another provenance must survive reconciliation.
  const operatorHash = await recipientHash("operator-flagged@example.com");
  sqlite.prepare(`INSERT INTO recipient_suppressions
    (recipient_hash, reason, provenance, suppressed_at, first_seen_at, reconciliation_id)
    VALUES (?, 'desk review', 'operator-desk', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z', 'recon:manual')`)
    .run(operatorHash);

  const pages = [
    { entries: [
      { email: "Reader@Example.com", reason: "bounce", suppressed_at: "2026-02-01T00:00:00Z" },
      { email: " second@example.com ", reason: "complaint", created_at: "2026-02-02T00:00:00Z" },
    ] },
    { entries: [
      { email: "reader@example.COM", reason: "bounce", suppressed_at: "2026-02-01T00:00:00Z" }, // duplicate of page 1 after normalization
      { email: "not-an-address" },
      { email: "third@example.com", reason: "bounce" },
    ] },
    { entries: [] },
  ];
  const authority = "2026-02-10T00:00:00Z";

  const dryRun = await reconcileRecipientSuppressions(DB, pageSource(pages), { authority, now: new Date("2026-02-10T01:00:00Z") });
  assert.equal(dryRun.status, "ok");
  assert.equal(dryRun.mode, "dry-run");
  assert.equal(dryRun.applied, false);
  assert.equal(dryRun.pages_read, 3);
  assert.equal(dryRun.fetched, 5);
  assert.equal(dryRun.invalid, 1);
  assert.equal(dryRun.added, 3);
  assert.equal(dryRun.preserved, 1);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM recipient_suppressions").get().n, 1,
    "a dry run writes nothing");

  const applied = await reconcileRecipientSuppressions(DB, pageSource(pages), { authority, mode: "apply", now: new Date("2026-02-10T01:00:00Z") });
  assert.equal(applied.status, "ok");
  assert.equal(applied.applied, true);
  assert.equal(applied.reconciliation_id, dryRun.reconciliation_id,
    "the receipt is deterministic for the same snapshot");
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM recipient_suppressions").get().n, 4);

  // Normalization: every casing resolves to the same suppressed recipient.
  for (const variant of ["reader@example.com", "READER@example.com", " reader@example.com "]) {
    const row = await suppressionForRecipient(DB, variant);
    assert.equal(row?.reason, "bounce");
    assert.equal(row?.suppressed_at, "2026-02-01T00:00:00.000Z");
    assert.equal(row?.provenance, "provider-suppression-list");
  }
  // The operator row is preserved untouched.
  const operatorRow = sqlite.prepare("SELECT * FROM recipient_suppressions WHERE recipient_hash = ?").get(operatorHash);
  assert.equal(operatorRow.reconciliation_id, "recon:manual");
  assert.equal(operatorRow.lifted_at, null);
});

test("a partial provider failure applies nothing and reports the failure", async () => {
  const { sqlite, DB } = d1();
  const pages = [
    { entries: [{ email: "reader@example.com", reason: "bounce" }] },
    { entries: [{ email: "second@example.com", reason: "bounce" }] },
  ];
  const receipt = await reconcileRecipientSuppressions(DB, pageSource(pages, { failAt: 1 }), {
    authority: "2026-02-10T00:00:00Z",
    mode: "apply",
  });
  assert.equal(receipt.status, "provider-error");
  assert.equal(receipt.applied, false);
  assert.equal(receipt.pages_read, 1);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM recipient_suppressions").get().n, 0,
    "all-or-nothing: a partial export never lands");
});

test("stale authority is refused and the same authority cannot carry different content", async () => {
  const { sqlite, DB } = d1();
  const pages = [{ entries: [{ email: "reader@example.com", reason: "bounce" }] }];
  const first = await reconcileRecipientSuppressions(DB, pageSource(pages), {
    authority: "2026-02-10T00:00:00Z", mode: "apply",
  });
  assert.equal(first.status, "ok");

  const stale = await reconcileRecipientSuppressions(DB, pageSource([{ entries: [] }]), {
    authority: "2026-02-09T00:00:00Z", mode: "apply",
  });
  assert.equal(stale.status, "stale-authority");
  assert.equal(stale.applied, false);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM recipient_suppressions WHERE lifted_at IS NULL").get().n, 1,
    "a stale export must not lift current suppressions");

  const conflict = await reconcileRecipientSuppressions(DB, pageSource([{ entries: [] }]), {
    authority: "2026-02-10T00:00:00Z", mode: "apply",
  });
  assert.equal(conflict.status, "authority-conflict",
    "the same epoch carrying different content is a provider bug, not a lift");
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM recipient_suppressions WHERE lifted_at IS NULL").get().n, 1);
});

test("repeated reconciliation is an idempotent replay; a later snapshot lifts and reinstates", async () => {
  const { sqlite, DB } = d1();
  const pages = [{ entries: [
    { email: "reader@example.com", reason: "bounce", suppressed_at: "2026-02-01T00:00:00Z" },
    { email: "second@example.com", reason: "complaint", suppressed_at: "2026-02-01T00:00:00Z" },
  ] }];
  const authority = "2026-02-10T00:00:00Z";
  const first = await reconcileRecipientSuppressions(DB, pageSource(pages), { authority, mode: "apply" });
  const replay = await reconcileRecipientSuppressions(DB, pageSource(pages), { authority, mode: "apply" });
  assert.equal(replay.status, "ok");
  assert.equal(replay.idempotent_replay, true);
  assert.equal(replay.reconciliation_id, first.reconciliation_id);
  assert.equal(replay.added + replay.updated + replay.reinstated + replay.lifted, 0);
  assert.equal(replay.unchanged, 2);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM recipient_suppressions").get().n, 2,
    "an idempotent replay writes no new rows");

  // A later snapshot drops one address: it is lifted (preserved), not deleted.
  const later = await reconcileRecipientSuppressions(DB, pageSource([{ entries: [pages[0].entries[0]] }]), {
    authority: "2026-02-11T00:00:00Z", mode: "apply",
  });
  assert.equal(later.status, "ok");
  assert.equal(later.lifted, 1);
  assert.equal(await suppressionForRecipient(DB, "second@example.com"), null);
  const liftedRow = sqlite.prepare("SELECT * FROM recipient_suppressions WHERE recipient_hash = ?")
    .get(await recipientHash("second@example.com"));
  assert.ok(liftedRow.lifted_at, "the lifted record is preserved with its lift time");

  // And a still-later snapshot reinstates it.
  const reinstated = await reconcileRecipientSuppressions(DB, pageSource(pages), {
    authority: "2026-02-12T00:00:00Z", mode: "apply",
  });
  assert.equal(reinstated.reinstated, 1);
  assert.equal((await suppressionForRecipient(DB, "second@example.com"))?.reason, "complaint");
});

test("a clean unsuppressed control recipient keeps full delivery", async () => {
  const { DB } = d1();
  await reconcileRecipientSuppressions(DB, pageSource([{ entries: [
    { email: "suppressed@example.com", reason: "bounce" },
  ] }]), { authority: "2026-02-10T00:00:00Z", mode: "apply" });

  const environment = env(DB);
  const provider = stubProvider(ok200);
  try {
    const response = await signup(environment, "control@example.com");
    assert.equal(response.status, 200);
    assert.equal(provider.calls.length, 1, "the unsuppressed control still gets its welcome");
    assert.equal(provider.calls[0].body.to, "control@example.com");
  } finally { provider.restore(); }
});

// ---- G1/G2 boundary: suppressed recipients get no subscriber mail -----------

test("a suppressed recipient is enrolled but never sent a welcome, on first or repeated signup", async () => {
  const { sqlite, DB } = d1();
  await reconcileRecipientSuppressions(DB, pageSource([{ entries: [
    { email: "suppressed@example.com", reason: "complaint", suppressed_at: "2026-02-01T00:00:00Z" },
  ] }]), { authority: "2026-02-10T00:00:00Z", mode: "apply" });

  const environment = env(DB);
  const provider = stubProvider(ok200);
  try {
    const first = await signup(environment, "Suppressed@Example.com");
    assert.equal(first.status, 200);
    const body = await first.json();
    assert.equal(body.ok, true);
    assert.equal(provider.calls.length, 0, "no welcome attempt for a known-suppressed recipient");

    const row = sqlite.prepare("SELECT * FROM ops_welcome_deliveries").get();
    assert.equal(row.state, "suppressed");
    assert.equal(row.attempt_count, 0);

    const repeat = await signup(environment, "suppressed@example.com");
    assert.equal(repeat.status, 200);
    assert.equal(provider.calls.length, 0, "repeated signup still sends nothing");
  } finally { provider.restore(); }
});

test("a suppressed recipient's queued digest is skipped at the send boundary", async () => {
  const { DB } = d1();
  await reconcileRecipientSuppressions(DB, pageSource([{ entries: [
    { email: "reader@example.com", reason: "bounce" },
  ] }]), { authority: "2026-02-10T00:00:00Z", mode: "apply" });

  // Award-watch digest path: seed the precomputed match cache through a composite
  // DB that serves the suppression table from sqlite and the award cache inline.
  const cache = {
    "20250110001": {
      matches: JSON.stringify({ matches: [{ id: "C1", pin: "337474", vendor: "EXAMPLE VENDOR LLC", amount: 100, approved: "2025-03-01" }] }),
      computed_at: "2026-08-03T12:00:00.000Z",
    },
  };
  const compositeDB = {
    prepare(sql) {
      if (/FROM recipient_suppressions/.test(sql)) return DB.prepare(sql);
      return {
        bind(...args) {
          return {
            async first() {
              if (/FROM external_award_matches/.test(sql)) return cache[args[0]] || null;
              return null;
            },
            async run() { return { meta: { changes: 0 } }; },
            async all() { return { results: [] }; },
          };
        },
      };
    },
  };
  const environment = {
    DB: compositeDB,
    ALERT_STATE: new KV(),
    SUBS: new KV(),
    RESEND_API_KEY: "rk",
    TOKEN_SECRET: SECRET,
  };
  const provider = stubProvider(ok200);
  try {
    const watch = {
      key: "sub:award-watch-1", email: "reader@example.com", lens: "award",
      filter: { requestId: "20250110001", agency: "Housing Authority" },
      freq: "daily", channel: "email", lang: "en", createdAt: "2026-08-03",
    };
    const result = await processOneSub(environment, watch, {
      FROM: "CityScroll <alerts@cityscroll.org>", LIVE: true, heartbeatDays: 14,
      today: "2026-08-03", isMonday: true, nowMs: Date.parse("2026-08-03T12:00:00.000Z"),
      counts: () => ({ "per-run": 0, daily: 0 }), caps: { "per-run": 25, daily: 50 },
      onSent: async () => {},
    });
    assert.equal(result.error, undefined);
    assert.equal(result.sent, false);
    assert.equal(result.skipped, "recipient-suppressed");
    assert.equal(result.suppression?.reason, "bounce");
    assert.equal(provider.calls.length, 0, "the queued delivery is never attempted");
  } finally { provider.restore(); }
});

// ---- G2: one welcome per recipient -------------------------------------------

test("concurrent enrollments through the same channel claim exactly one welcome", async () => {
  const { sqlite, DB } = d1();
  const environment = env(DB);
  const provider = stubProvider(ok200);
  try {
    const [a, b, c] = await Promise.all([
      signup(environment, "race@example.com"),
      signup(environment, "Race@Example.com"),
      signup(environment, "race@example.com"),
    ]);
    assert.equal(a.status, 200);
    assert.equal(b.status, 200);
    assert.equal(c.status, 200);
    assert.equal(provider.calls.length, 1, "exactly one welcome delivery under contention");
    const rows = sqlite.prepare("SELECT * FROM ops_welcome_deliveries").all();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].state, "accepted");
    assert.equal(rows[0].attempt_count, 1);
    assert.equal(rows[0].provider_id, "msg_ok");
  } finally { provider.restore(); }
});

test("an indeterminate provider failure retries with the same provider key, then closes", async () => {
  const { sqlite, DB } = d1();
  const environment = env(DB);
  let failures = 1;
  const provider = stubProvider(() => {
    if (failures-- > 0) return new Response("upstream timeout", { status: 500 });
    return ok200();
  });
  try {
    const first = await signup(environment, "retry@example.com");
    assert.equal(first.status, 502, "the reader is told the welcome failed while enrolled");

    const retry = await signup(environment, "retry@example.com");
    assert.equal(retry.status, 200);
    assert.equal(provider.calls.length, 2, "one retry inside the provider dedupe window");
    const keys = provider.calls.map((call) => call.headers["Idempotency-Key"]);
    assert.equal(keys[0], await welcomeIdempotencyKey("retry@example.com"));
    assert.equal(keys[1], keys[0], "the retry reuses the stable per-recipient provider key");

    const row = sqlite.prepare("SELECT * FROM ops_welcome_deliveries").get();
    assert.equal(row.state, "accepted");
    assert.equal(row.attempt_count, 2);

    const repeat = await signup(environment, "retry@example.com");
    assert.equal(repeat.status, 200);
    assert.equal(provider.calls.length, 2, "an accepted welcome never sends again");
  } finally { provider.restore(); }
});

test("a definitive rejection retries inside the window and stands closed after it expires", async () => {
  const { sqlite, DB } = d1();
  const email = "rejected@example.com";
  const first = new Date("2026-03-01T12:00:00Z");

  let owned = await claimWelcomeDelivery(DB, { email, now: first });
  assert.equal(owned.owned, true);
  await completeWelcomeDelivery(DB, {
    email, claimToken: owned.claimToken, state: "rejected",
    errorReason: "Resend 422: invalid address", now: first,
  });

  // A repeat enrollment inside the dedupe window re-claims with the same key.
  const withinWindow = new Date(first.getTime() + 60 * 60 * 1000);
  const retry = await claimWelcomeDelivery(DB, { email, now: withinWindow });
  assert.equal(retry.owned, true);
  assert.equal(retry.idempotencyKey, owned.idempotencyKey);
  await completeWelcomeDelivery(DB, {
    email, claimToken: retry.claimToken, state: "rejected",
    errorReason: "Resend 422: invalid address", now: withinWindow,
  });
  let row = sqlite.prepare("SELECT * FROM ops_welcome_deliveries").get();
  assert.equal(row.state, "rejected");
  assert.equal(row.attempt_count, 2);
  assert.equal(row.first_attempted_at, first.toISOString(),
    "the retry window stays anchored to the first attempt");

  // After the window, the durable state is the truth and no further send is claimed.
  const afterWindow = new Date(first.getTime() + DAY_MS);
  const closed = await claimWelcomeDelivery(DB, { email, now: afterWindow });
  assert.equal(closed.owned, false);
  row = sqlite.prepare("SELECT * FROM ops_welcome_deliveries").get();
  assert.equal(row.state, "rejected");
  assert.equal(row.attempt_count, 2, "no phantom retry after the provider dedupe window");
});

test("an abandoned in-flight claim is re-claimed once with the same provider key", async () => {
  const { sqlite, DB } = d1();
  const email = "crash@example.com";
  const hash = await recipientHash(email);
  // Simulated worker death after the provider call: in-flight, claim expired.
  sqlite.prepare(`INSERT INTO ops_welcome_deliveries
    (recipient_hash, idempotency_key, state, claim_token, claim_expires_at,
     first_attempted_at, last_attempted_at, retry_until, attempt_count)
    VALUES (?, ?, 'in-flight', 'dead-claim', '2026-03-01T12:00:00Z',
            '2026-03-01T11:59:00Z', '2026-03-01T11:59:00Z', '2026-03-02T11:44:00Z', 1)`)
    .run(hash, await welcomeIdempotencyKey(email));

  const claim = await claimWelcomeDelivery(DB, { email, now: new Date("2026-03-01T12:05:00Z") });
  assert.equal(claim.owned, true, "an expired abandoned claim is stealable inside the window");
  assert.equal(claim.idempotencyKey, `welcome:${hash}`, "the retried send keeps the stable key");

  // A concurrent second stealer loses the compare-and-swap.
  const loser = await claimWelcomeDelivery(DB, { email, now: new Date("2026-03-01T12:05:01Z") });
  assert.equal(loser.owned, false);

  await completeWelcomeDelivery(DB, {
    email, claimToken: claim.claimToken, state: "accepted", providerId: "msg_after_crash",
    now: new Date("2026-03-01T12:05:02Z"),
  });
  const row = sqlite.prepare("SELECT * FROM ops_welcome_deliveries").get();
  assert.equal(row.state, "accepted");
  assert.equal(row.attempt_count, 2);
  assert.equal(row.provider_id, "msg_after_crash");
});

test("the existing roster migration records preexisting claims and sends no welcomes", async () => {
  const { DB } = d1();
  const roster = ["legacy-one@example.com", "Legacy-Two@Example.com", "legacy-two@example.com"];

  const dryRun = await migrateExistingRosterWelcomeClaims(DB, roster);
  assert.equal(dryRun.applied, false);
  assert.equal(dryRun.considered, 3);

  const applied = await migrateExistingRosterWelcomeClaims(DB, roster, { mode: "apply" });
  assert.equal(applied.applied, true);
  assert.equal(applied.recorded, 2, "the roster normalizes before recording");
  assert.equal(applied.already_recorded, 1);

  // Re-running the migration is a no-op.
  const rerun = await migrateExistingRosterWelcomeClaims(DB, roster, { mode: "apply" });
  assert.equal(rerun.recorded, 0);
  assert.equal(rerun.already_recorded, 3);

  // A migrated subscriber who signs up again is enrolled but gets no welcome.
  const environment = env(DB);
  const provider = stubProvider(ok200);
  try {
    const response = await signup(environment, "legacy-one@example.com");
    assert.equal(response.status, 200);
    assert.equal(provider.calls.length, 0, "roster migration must not welcome existing subscribers");
  } finally { provider.restore(); }
});

test("repeated enrollment after acceptance sends nothing through any repeat", async () => {
  const { DB } = d1();
  const environment = env(DB);
  const provider = stubProvider(ok200);
  try {
    assert.equal((await signup(environment, "steady@example.com")).status, 200);
    assert.equal(provider.calls.length, 1);
    for (let i = 0; i < 3; i += 1) {
      const repeat = await signup(environment, "steady@example.com");
      assert.equal(repeat.status, 200);
      const body = await repeat.json();
      assert.equal(body.ok, true);
    }
    assert.equal(provider.calls.length, 1, "repeats create no duplicate delivery");
  } finally { provider.restore(); }
});
