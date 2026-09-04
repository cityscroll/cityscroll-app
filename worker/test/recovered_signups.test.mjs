import test from "node:test";
import assert from "node:assert/strict";

import {
  handleAdminDeprecatedOptInRecovery,
  handleAdminSubs,
  handleAdminWatchLog,
  renderSignupLifecyclePage,
} from "../src/admin.mjs";
import {
  DEPRECATED_OPT_IN_RECOVERY_SOURCE,
  RECOVERY_EXPLANATION,
  SIGNUP_LIFECYCLE,
  buildSubscription,
  isDeveloperTestEmail,
  rowAfterDeliveryNotBefore,
  signupLifecycleFromRecord,
  subscriptionKey,
} from "../src/lib/subscriptions.mjs";
import {
  isEquivalentBroadMoneyWatch,
  recoverDeprecatedDoubleOptIn,
} from "../src/recovered_signups.mjs";
import { isWatchActive } from "../src/lib/rollup.mjs";
import { toRosterRow } from "../src/lib/digest_ops.mjs";
import { processOneSub } from "../src/alerts.mjs";
import { sanitize } from "../src/lib/filter.mjs";

class KV {
  constructor() { this.data = new Map(); }
  async get(key) { return this.data.get(key) ?? null; }
  async put(key, value) { this.data.set(key, String(value)); }
  async delete(key) { this.data.delete(key); }
  async list({ prefix = "" } = {}) {
    return { keys: [...this.data.keys()].filter((key) => key.startsWith(prefix)).map((name) => ({ name })), list_complete: true };
  }
}

const RECOVERED_SUBSCRIBER_ROWS = Object.freeze([
  { email: "recovered-subscriber-1@example.com", lens: "money", filter: {}, freq: "weekly", original_signup_at: "2026-08-16T23:22:22.092Z" },
  { email: "recovered-subscriber-2@example.com", lens: "money", filter: {}, freq: "weekly", original_signup_at: "2026-08-18T15:58:35.654Z" },
  { email: "recovered-subscriber-3@example.com", lens: "money", filter: {}, freq: "weekly", original_signup_at: "2026-08-18T21:45:33.701Z" },
]);
const VETTED_RECOVERED_SIGNUP_EMAILS = RECOVERED_SUBSCRIBER_ROWS.map((row) => row.email);

function environment() {
  return {
    ADMIN_KEY: "secret",
    SUBS: new KV(),
    ALERT_STATE: new KV(),
    DEPRECATED_OPT_IN_RECOVERY_MANIFEST_JSON: JSON.stringify(RECOVERED_SUBSCRIBER_ROWS),
  };
}

const TEST_EMAIL = "jamesca2ro+scope-watch-e2e-20260806@gmail.com";

async function recover(env) {
  return recoverDeprecatedDoubleOptIn(env, { now: new Date("2026-08-18T23:00:00.000Z") });
}

async function recoverThroughAdmin(env, body) {
  const init = { method: "POST" };
  if (body !== undefined) {
    init.headers = { "content-type": "application/json" };
    init.body = JSON.stringify(body);
  }
  return handleAdminDeprecatedOptInRecovery(
    new Request("https://worker/admin/recover-deprecated-opt-in?key=secret", init),
    env,
  );
}

test("recovery enrolls three broad watches, watermarks next-send state, and excludes the e2e account", async () => {
  const env = environment();
  const result = await recover(env);
  assert.equal(result.recovered, 3);
  assert.equal(result.developer_test, 1);

  const subs = [...env.SUBS.data.entries()].filter(([key]) => key.startsWith("sub:"));
  assert.equal(subs.length, 3);
  for (const [key, raw] of subs) {
    const record = JSON.parse(raw);
    assert.equal(record.lens, "money");
    assert.deepEqual(record.filter, {});
    assert.equal(record.freq, "weekly");
    assert.equal(record.source, DEPRECATED_OPT_IN_RECOVERY_SOURCE);
    assert.equal(record.signup_lifecycle, SIGNUP_LIFECYCLE.RECOVERED);
    assert.equal(record.status, SIGNUP_LIFECYCLE.PENDING_ENROLLMENT);
    assert.equal(record.recovered_at, "2026-08-18T23:00:00.000Z");
    assert.equal(record.delivery_not_before, record.recovered_at);
    assert.match(record.original_signup_at, /^2026-08-/);
    assert.equal(record.recovery_explanation, RECOVERY_EXPLANATION);
    assert.equal(await env.ALERT_STATE.get(`lastsent:${key}`), "2026-08-18");
  }
  assert.deepEqual(
    subs.map(([, raw]) => JSON.parse(raw).email).sort(),
    [...VETTED_RECOVERED_SIGNUP_EMAILS].sort(),
  );
  assert.equal(subs.some(([, raw]) => JSON.parse(raw).email.includes("scope-watch")), false);
  const developer = [...env.SUBS.data.entries()].filter(([key]) => key.startsWith("developer-test-account:"));
  assert.equal(developer.length, 1);
  assert.equal(JSON.parse(developer[0][1]).status, "developer/test");
  assert.equal(JSON.parse(developer[0][1]).email, TEST_EMAIL);
});

test("recovery is idempotent and never invokes an email sender", async () => {
  const env = environment();
  const realFetch = globalThis.fetch;
  let fetches = 0;
  globalThis.fetch = async () => { fetches++; throw new Error("recovery must not send"); };
  try {
    await recover(env);
    const second = await recover(env);
    assert.equal(second.results.filter((row) => row.status === "already-recovered").length, 3);
    assert.equal(second.results.filter((row) => row.status === "already-marked-developer-test").length, 1);
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.equal(fetches, 0);
  const latest = JSON.parse(await env.ALERT_STATE.get("watchlog:latest"));
  assert.equal(latest.length, 3, "a rerun does not duplicate ops events");
});

test("admin read surfaces show recovery timestamps, provenance, explanation, and test-account marker", async () => {
  const env = environment();
  await recover(env);
  const subsResponse = await handleAdminSubs(new Request("https://worker/admin/subs?key=secret"), env);
  const subs = await subsResponse.json();
  assert.equal(subs.confirmedSubs, 0);
  assert.equal(subs.recoveredPendingCount, 3);
  assert.equal(subs.enrolledCount, 0);
  assert.equal(subs.signup_lifecycle.recovered_pending, 3);
  assert.equal(subs.signup_lifecycle.enrolled, 0);
  assert.equal(subs.signup_lifecycle.summary, "3 recovered, pending");
  assert.equal(subs.developerTestAccounts.length, 1);
  assert.equal(subs.developerTestAccounts[0].status, SIGNUP_LIFECYCLE.TEST);
  assert.equal(subs.developerTestAccounts[0].signup_lifecycle, SIGNUP_LIFECYCLE.TEST);
  assert.equal(subs.subs.length, 3);
  for (const row of subs.subs) {
    assert.equal(row.signup_lifecycle, SIGNUP_LIFECYCLE.RECOVERED);
    assert.equal(row.status, SIGNUP_LIFECYCLE.PENDING_ENROLLMENT);
    assert.equal(row.source, DEPRECATED_OPT_IN_RECOVERY_SOURCE);
    assert.equal(row.recovered_at, "2026-08-18T23:00:00.000Z");
    assert.match(row.original_signup_at, /^2026-08-/);
    assert.equal(row.recovery_explanation, RECOVERY_EXPLANATION);
  }
  assert.deepEqual(
    subs.recoveredPending.map((row) => row.email).sort(),
    [...VETTED_RECOVERED_SIGNUP_EMAILS].sort(),
  );
  assert.equal(subs.recoveredPending.every((row) => typeof row.key === "string" && row.key.startsWith("sub:")), true);
  assert.equal(new Set(subs.recoveredPending.map((row) => row.key)).size, 3);

  const opsResponse = await handleAdminWatchLog(
    new Request("https://worker/admin/watch-log?key=secret&days=1"),
    env,
    { now: new Date("2026-08-18T23:30:00.000Z") },
  );
  const ops = await opsResponse.json();
  assert.equal(ops.events.length, 3);
  for (const event of ops.events) {
    assert.equal(event.at, "2026-08-18T23:00:00.000Z");
    assert.match(event.original_signup_at, /^2026-08-/);
    assert.equal(event.recovered_at, "2026-08-18T23:00:00.000Z");
    assert.equal(event.detail, RECOVERY_EXPLANATION);
  }
});

test("ops HTML renders recovered / pending-enrollment as the intermediate category before enrolled", async () => {
  const env = environment();
  await recover(env);
  const pendingHtmlResponse = await handleAdminSubs(
    new Request("https://worker/admin/subs?key=secret&view=html"),
    env,
  );
  assert.equal(pendingHtmlResponse.status, 200);
  assert.match(pendingHtmlResponse.headers.get("Content-Type"), /text\/html/);
  const pendingHtml = await pendingHtmlResponse.text();
  assert.match(pendingHtml, /3 recovered, pending/);
  assert.match(pendingHtml, /recovered \/ pending-enrollment/);
  assert.match(pendingHtml, /pending-enrollment/);
  assert.match(pendingHtml, /data-signup-category="enrolled"/);
  assert.doesNotMatch(pendingHtml, />3 enrolled</);

  for (const key of [...env.ALERT_STATE.data.keys()].filter((name) => name.startsWith("lastsent:"))) {
    await env.ALERT_STATE.put(key, "2026-08-24");
  }
  const enrolledHtml = await (await handleAdminSubs(
    new Request("https://worker/admin/subs?key=secret&view=html"),
    env,
  )).text();
  assert.match(enrolledHtml, /3 enrolled/);
  assert.doesNotMatch(enrolledHtml, /3 recovered, pending/);
  const enrolledJson = await (await handleAdminSubs(
    new Request("https://worker/admin/subs?key=secret"),
    env,
  )).json();
  assert.equal(enrolledJson.signup_lifecycle.recovered_pending, 0);
  assert.equal(enrolledJson.signup_lifecycle.enrolled, 3);
  assert.equal(enrolledJson.signup_lifecycle.summary, "3 enrolled");
  for (const row of enrolledJson.subs) {
    assert.equal(row.signup_lifecycle, SIGNUP_LIFECYCLE.ENROLLED);
    assert.equal(row.status, SIGNUP_LIFECYCLE.ENROLLED);
  }
  assert.match(renderSignupLifecyclePage(enrolledJson), /3 enrolled/);
});

test("recovery keeps an already-enrolled equivalent watch and does not mint a pending duplicate", async () => {
  const env = environment();
  const manual = buildSubscription({
    email: "recovered-subscriber-3@example.com",
    lens: "money",
    filter: {},
    freq: "weekly",
    now: Date.parse("2026-08-18T21:45:33.701Z"),
  });
  const key = await subscriptionKey(manual);
  await env.SUBS.put(key, JSON.stringify({ ...manual, source: "manual-ops-insert" }));

  const result = await recover(env);
  assert.equal(result.already_enrolled, 1);
  assert.equal(result.recovered, 2);
  const stored = JSON.parse(await env.SUBS.get(key));
  assert.equal(stored.source, "manual-ops-insert");
  const ops = await (await handleAdminSubs(new Request("https://worker/admin/subs?key=secret"), env)).json();
  const lifecycleRows = [...ops.subs, ...ops.developerTestAccounts]
    .filter((row) => row.email === "recovered-subscriber-3@example.com");
  assert.equal(lifecycleRows.length, 1, "one address must not produce two lifecycle rows");
  assert.equal(lifecycleRows[0].status, SIGNUP_LIFECYCLE.ENROLLED);
  assert.equal(ops.recoveredPending.filter((row) => row.email === "recovered-subscriber-3@example.com").length, 0);
});

test("signup lifecycle distinguishes recovered, pending-enrollment, enrolled, and test", () => {
  const recovered = {
    email: "recovered-subscriber-3@example.com",
    source: DEPRECATED_OPT_IN_RECOVERY_SOURCE,
    delivery_not_before: "2026-08-18T23:00:00.000Z",
    recovered_at: "2026-08-18T23:00:00.000Z",
    recovery_explanation: RECOVERY_EXPLANATION,
    original_signup_at: "2026-08-18T21:45:33.701Z",
  };
  const pending = signupLifecycleFromRecord(recovered, { lastSent: "2026-08-18" });
  assert.equal(pending.signup_lifecycle, SIGNUP_LIFECYCLE.RECOVERED);
  assert.equal(pending.status, SIGNUP_LIFECYCLE.PENDING_ENROLLMENT);

  const enrolled = signupLifecycleFromRecord(recovered, { lastSent: "2026-08-24" });
  assert.equal(enrolled.signup_lifecycle, SIGNUP_LIFECYCLE.ENROLLED);
  assert.equal(enrolled.status, SIGNUP_LIFECYCLE.ENROLLED);

  const confirmed = signupLifecycleFromRecord({
    email: "reader@example.com",
    no_topic: true,
    source: "top-of-site",
    state: "confirmed",
  });
  assert.equal(confirmed.status, SIGNUP_LIFECYCLE.CONFIRMED);

  assert.equal(isDeveloperTestEmail(TEST_EMAIL), true);
  const testLife = signupLifecycleFromRecord({ email: TEST_EMAIL, developer_test: true });
  assert.equal(testLife.status, SIGNUP_LIFECYCLE.TEST);
  assert.equal(isWatchActive({ email: TEST_EMAIL, paused: false }), false);

  const roster = toRosterRow(recovered, { lastSent: "2026-08-18" });
  assert.equal(roster.signup_lifecycle, SIGNUP_LIFECYCLE.RECOVERED);
  assert.equal(roster.status, SIGNUP_LIFECYCLE.PENDING_ENROLLMENT);
  assert.equal(roster.confirmed, false);
  assert.equal(roster.original_signup_at, recovered.original_signup_at);
  assert.equal(roster.recovery_explanation, RECOVERY_EXPLANATION);
});

test("the authenticated admin endpoint applies the vetted manifest even with no or partial caller rows", async () => {
  const denied = await handleAdminDeprecatedOptInRecovery(new Request("https://worker/admin/recover-deprecated-opt-in?key=wrong", {
    method: "POST",
  }), environment());
  assert.equal(denied.status, 401);

  const empty = environment();
  const accepted = await recoverThroughAdmin(empty);
  assert.equal(accepted.status, 200);
  const acceptedBody = await accepted.json();
  assert.equal(acceptedBody.recovered, 3);
  assert.deepEqual(acceptedBody.emails.sort(), [...VETTED_RECOVERED_SIGNUP_EMAILS].sort());

  const partial = environment();
  const ignoredCallerRows = await recoverThroughAdmin(partial, {
    rows: RECOVERED_SUBSCRIBER_ROWS.filter((row) => row.email === "recovered-subscriber-3@example.com"),
  });
  assert.equal(ignoredCallerRows.status, 200);
  const ops = await (await handleAdminSubs(new Request("https://worker/admin/subs?key=secret"), partial)).json();
  assert.equal(ops.recoveredPendingCount, 3);
  assert.deepEqual(
    [...partial.SUBS.data.values()].filter((raw) => {
      try { return JSON.parse(raw).source === DEPRECATED_OPT_IN_RECOVERY_SOURCE && JSON.parse(raw).email; }
      catch { return false; }
    }).map((raw) => JSON.parse(raw).email).filter((email) => !email.includes("+")).sort(),
    [...VETTED_RECOVERED_SIGNUP_EMAILS].sort(),
  );
});

test("recovery creates pending-enrollment records for all three vetted addresses from an empty store", async () => {
  const env = environment();
  const result = await recoverDeprecatedDoubleOptIn(env, { now: new Date("2026-08-18T23:00:00.000Z") });
  assert.equal(result.recovered, 3);
  assert.deepEqual(result.emails.sort(), [...VETTED_RECOVERED_SIGNUP_EMAILS].sort());
  const recoveredEmails = [...env.SUBS.data.entries()]
    .filter(([key]) => key.startsWith("sub:"))
    .map(([, raw]) => JSON.parse(raw))
    .filter((row) => row.status === SIGNUP_LIFECYCLE.PENDING_ENROLLMENT)
    .map((row) => row.email)
    .sort();
  assert.deepEqual(recoveredEmails, [...VETTED_RECOVERED_SIGNUP_EMAILS].sort());
  const ops = await (await handleAdminSubs(new Request("https://worker/admin/subs?key=secret"), env)).json();
  assert.equal(ops.recoveredPendingCount, 3);
  assert.deepEqual(ops.recoveredPending.map((row) => row.email).sort(), [
    ...VETTED_RECOVERED_SIGNUP_EMAILS,
  ].sort());
});

test("the recovery entitlement watermark excludes backlog and admits only later notices", () => {
  const record = { delivery_not_before: "2026-08-18T23:00:00.000Z" };
  assert.equal(rowAfterDeliveryNotBefore(record, { start_date: "2026-08-17T12:00:00.000Z" }), false);
  assert.equal(rowAfterDeliveryNotBefore(record, { start_date: "2026-08-18T23:30:00.000Z" }), false, "same-day rows fail closed");
  assert.equal(rowAfterDeliveryNotBefore(record, { start_date: "2026-08-19T00:00:00.000Z" }), true);
  assert.equal(rowAfterDeliveryNotBefore(record, {}), false);
  assert.equal(rowAfterDeliveryNotBefore({}, { start_date: "2020-01-01" }), true, "ordinary watches stay byte-compatible");
});

test("empty and sanitize() money filters are equivalent broad contracts watches", () => {
  const email = "recovered-subscriber-3@example.com";
  assert.equal(isEquivalentBroadMoneyWatch({ email, lens: "money", filter: {} }, email), true);
  assert.equal(isEquivalentBroadMoneyWatch({ email, lens: "money", filter: sanitize("money", {}) }, email), true);
  assert.equal(isEquivalentBroadMoneyWatch({
    email,
    lens: "money",
    filter: {
      agency: null,
      category: null,
      closingWeek: false,
      connection_relation: null,
      entity_refs_all: [],
      excludeSpecial: false,
      keywords: [],
      maxAmount: null,
      minAmount: null,
      months: null,
      name: null,
      noticeType: null,
      route: null,
      tab: null,
    },
  }, email), true);
  assert.equal(isEquivalentBroadMoneyWatch({ email, lens: "money", filter: { keywords: ["housing"] } }, email), false);
});

test("recovery drops a recovered pending duplicate when a sanitized legacy-confirm watch already exists", async () => {
  const env = environment();
  await recover(env);
  const recoveredKey = [...env.SUBS.data.keys()].find((name) => name.startsWith("sub:")
    && JSON.parse(env.SUBS.data.get(name)).email === "recovered-subscriber-3@example.com");
  assert.ok(recoveredKey);

  const confirm = buildSubscription({
    email: "recovered-subscriber-3@example.com",
    lens: "money",
    filter: sanitize("money", {}),
    freq: "weekly",
    now: Date.parse("2026-08-19T16:16:22.985Z"),
  });
  const confirmKey = await subscriptionKey(confirm);
  assert.notEqual(confirmKey, recoveredKey, "sanitize() empty filter must not share the {} recovery key");
  await env.SUBS.put(confirmKey, JSON.stringify({ ...confirm, source: "legacy-confirm" }));

  const result = await recover(env);
  assert.equal(result.already_enrolled, 1);
  assert.equal(await env.SUBS.get(recoveredKey), null);
  assert.equal(JSON.parse(await env.SUBS.get(confirmKey)).source, "legacy-confirm");

  const ops = await (await handleAdminSubs(new Request("https://worker/admin/subs?key=secret"), env)).json();
  const lifecycleRows = ops.subs.filter((row) => row.email === "recovered-subscriber-3@example.com");
  assert.equal(lifecycleRows.length, 1);
  assert.equal(lifecycleRows[0].status, SIGNUP_LIFECYCLE.ENROLLED);
  assert.equal(ops.recoveredPending.filter((row) => row.email === "recovered-subscriber-3@example.com").length, 0);
});

test("a recovered pending watch becomes enrolled when a later digest send processes it", async () => {
  const env = environment();
  env.RESEND_API_KEY = "rk";
  env.TOKEN_SECRET = "s".repeat(32);
  await recover(env);
  const key = [...env.SUBS.data.keys()].find((name) => name.startsWith("sub:")
    && JSON.parse(env.SUBS.data.get(name)).email === "recovered-subscriber-2@example.com");
  const record = JSON.parse(await env.SUBS.get(key));
  assert.equal(record.status, SIGNUP_LIFECYCLE.PENDING_ENROLLMENT);
  assert.equal(await env.ALERT_STATE.get(`lastsent:${key}`), "2026-08-18");

  const realFetch = globalThis.fetch;
  const sent = [];
  globalThis.fetch = async (url, opts) => {
    const target = String(url);
    if (target.includes("data.cityofnewyork.us") || target.includes("dg92-zbpx")) {
      return Response.json([]);
    }
    if (target.includes("api.resend.com")) {
      sent.push(JSON.parse(opts.body));
      return Response.json({ id: "digest_1" });
    }
    throw new Error("unexpected fetch: " + target);
  };
  try {
    const result = await processOneSub(env, { key, ...record }, {
      FROM: "CityScroll <alerts@cityscroll.org>",
      LIVE: true,
      heartbeatDays: 14,
      today: "2026-08-24",
      isMonday: true,
      counts: () => ({ "per-run": 0, daily: 0 }),
      caps: { "per-run": 25, daily: 50 },
      onSent: async () => {},
    });
    assert.equal(result.sent, true, JSON.stringify(result));
    assert.equal(sent.length, 1);
  } finally {
    globalThis.fetch = realFetch;
  }

  assert.equal(await env.ALERT_STATE.get(`lastsent:${key}`), "2026-08-24");
  for (const name of [...env.SUBS.data.keys()].filter((item) => item.startsWith("recovery:"))) {
    await env.SUBS.delete(name);
  }
  const again = await recover(env);
  assert.ok(again.already_recovered + again.recovered + again.already_enrolled >= 1);
  assert.equal(await env.ALERT_STATE.get(`lastsent:${key}`), "2026-08-24");
  const ops = await (await handleAdminSubs(new Request("https://worker/admin/subs?key=secret"), env)).json();
  const row = ops.subs.find((item) => item.email === "recovered-subscriber-2@example.com");
  assert.equal(row.status, SIGNUP_LIFECYCLE.ENROLLED);
  assert.equal(row.signup_lifecycle, SIGNUP_LIFECYCLE.ENROLLED);
  assert.equal(ops.recoveredPending.filter((item) => item.email === "recovered-subscriber-2@example.com").length, 0);
});
