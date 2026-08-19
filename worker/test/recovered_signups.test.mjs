import test from "node:test";
import assert from "node:assert/strict";

import { handleAdminDeprecatedOptInRecovery, handleAdminSubs, handleAdminWatchLog } from "../src/admin.mjs";
import { rowAfterDeliveryNotBefore } from "../src/lib/subscriptions.mjs";
import { recoverDeprecatedDoubleOptIn } from "../src/recovered_signups.mjs";

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

const ROWS = [
  ["alpha@example.com", "2026-08-16T23:22:22.092Z"],
  ["bravo@example.com", "2026-08-18T15:58:35.654Z"],
  ["charlie@example.com", "2026-08-18T21:45:33.701Z"],
].map(([email, original_signup_at]) => ({ email, lens: "money", filter: {}, freq: "weekly", original_signup_at }));
ROWS.push({
  email: "developer+scope-watch-e2e-20260806@example.com",
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
    assert.equal(record.source, "recovered-from-deprecated-double-opt-in");
    assert.equal(record.recovered_at, "2026-08-18T23:00:00.000Z");
    assert.equal(record.delivery_not_before, record.recovered_at);
    assert.match(record.original_signup_at, /^2026-08-/);
    assert.equal(await env.ALERT_STATE.get(`lastsent:${key}`), "2026-08-18");
  }
  assert.equal(subs.some(([, raw]) => JSON.parse(raw).email.includes("scope-watch")), false);
  const developer = [...env.SUBS.data.entries()].filter(([key]) => key.startsWith("developer-test-account:"));
  assert.equal(developer.length, 1);
  assert.equal(JSON.parse(developer[0][1]).status, "developer/test");
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
  assert.equal(subs.confirmedSubs, 3);
  assert.equal(subs.developerTestAccounts.length, 1);
  for (const row of subs.subs) {
    assert.equal(row.status, "confirmed");
    assert.equal(row.source, "recovered-from-deprecated-double-opt-in");
    assert.equal(row.recovered_at, "2026-08-18T23:00:00.000Z");
    assert.match(row.original_signup_at, /^2026-08-/);
    assert.equal(row.recovery_explanation, "was stuck in the now-deprecated double opt-in; emails start next scheduled digest");
  }

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
    assert.equal(event.detail, "was stuck in the now-deprecated double opt-in; emails start next scheduled digest");
  }
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
