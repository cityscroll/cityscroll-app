import test from "node:test";
import assert from "node:assert/strict";

import { handleAdminDeprecatedOptInRecovery, handleAdminSubs, handleAdminWatchLog } from "../src/admin.mjs";
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
import { recoverDeprecatedDoubleOptIn } from "../src/recovered_signups.mjs";
import { isWatchActive } from "../src/lib/rollup.mjs";
import { toRosterRow } from "../src/lib/digest_ops.mjs";

class KV {
  constructor() { this.data = new Map(); }
  async get(key) { return this.data.get(key) ?? null; }
  async put(key, value) { this.data.set(key, String(value)); }
  async list({ prefix = "" } = {}) {
    return { keys: [...this.data.keys()].filter((key) => key.startsWith(prefix)).map((name) => ({ name })), list_complete: true };
  }
}

function environment() {
  return { ADMIN_KEY: "secret", SUBS: new KV(), ALERT_STATE: new KV() };
}

const RECOVERED_REAL = [
  ["shelly.ronen@gmail.com", "2026-08-16T23:22:22.092Z"],
  ["ninodepaola@gmail.com", "2026-08-18T15:58:35.654Z"],
  ["devinbalkind@gmail.com", "2026-08-18T21:45:33.701Z"],
];
const TEST_EMAIL = "jamesca2ro+scope-watch-e2e-20260806@gmail.com";
const ROWS = RECOVERED_REAL.map(([email, original_signup_at]) => ({
  email, lens: "money", filter: {}, freq: "weekly", original_signup_at,
}));
ROWS.push({
  email: TEST_EMAIL,
  lens: "money",
  filter: {
    agency: "Housing Preservation and Development",
    noticeType: "award",
    entity_refs_all: ["agency:id:housing-preservation-and-development"],
    connection_relation: "published_by_agency",
  },
  freq: "daily",
  original_signup_at: "2026-08-06T01:48:49.718Z",
});

async function recover(env) {
  return recoverDeprecatedDoubleOptIn(env, ROWS, { now: new Date("2026-08-18T23:00:00.000Z") });
}

async function recoverThroughAdmin(env) {
  return handleAdminDeprecatedOptInRecovery(new Request("https://worker/admin/recover-deprecated-opt-in?key=secret", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ rows: ROWS }),
  }), env);
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
    RECOVERED_REAL.map(([email]) => email).sort(),
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
    ["de***@gmail.com", "ni***@gmail.com", "sh***@gmail.com"],
  );

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

test("ops visibility is derived from recovered records, including a restamped manual insertion", async () => {
  const env = environment();
  const manual = buildSubscription({
    email: "devinbalkind@gmail.com",
    lens: "money",
    filter: {},
    freq: "weekly",
    now: Date.parse("2026-08-18T21:45:33.701Z"),
  });
  const key = await subscriptionKey(manual);
  await env.SUBS.put(key, JSON.stringify({ ...manual, source: "manual-ops-insert" }));

  await recover(env);
  const subsResponse = await handleAdminSubs(new Request("https://worker/admin/subs?key=secret"), env);
  const body = await subsResponse.json();
  assert.equal(body.recoveredPendingCount, 3);
  assert.equal(body.subs.every((row) => row.source === DEPRECATED_OPT_IN_RECOVERY_SOURCE), true);
  assert.equal(JSON.parse(await env.SUBS.get(key)).source, DEPRECATED_OPT_IN_RECOVERY_SOURCE);
});

test("signup lifecycle distinguishes recovered, pending-enrollment, enrolled, and test", () => {
  const recovered = {
    email: "devinbalkind@gmail.com",
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

test("the authenticated admin endpoint accepts only the bounded four-row recovery manifest", async () => {
  const env = environment();
  const denied = await handleAdminDeprecatedOptInRecovery(new Request("https://worker/admin/recover-deprecated-opt-in?key=wrong", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ rows: ROWS }),
  }), env);
  assert.equal(denied.status, 401);

  const invalid = await handleAdminDeprecatedOptInRecovery(new Request("https://worker/admin/recover-deprecated-opt-in?key=secret", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ rows: ROWS.slice(0, 3) }),
  }), env);
  assert.equal(invalid.status, 400);

  const accepted = await recoverThroughAdmin(environment());
  assert.equal(accepted.status, 200);
});

test("the recovery entitlement watermark excludes backlog and admits only later notices", () => {
  const record = { delivery_not_before: "2026-08-18T23:00:00.000Z" };
  assert.equal(rowAfterDeliveryNotBefore(record, { start_date: "2026-08-17T12:00:00.000Z" }), false);
  assert.equal(rowAfterDeliveryNotBefore(record, { start_date: "2026-08-18T23:30:00.000Z" }), false, "same-day rows fail closed");
  assert.equal(rowAfterDeliveryNotBefore(record, { start_date: "2026-08-19T00:00:00.000Z" }), true);
  assert.equal(rowAfterDeliveryNotBefore(record, {}), false);
  assert.equal(rowAfterDeliveryNotBefore({}, { start_date: "2020-01-01" }), true, "ordinary watches stay byte-compatible");
});
