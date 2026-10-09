import assert from "node:assert/strict";
import test from "node:test";

import worker from "../src/worker.mjs";
import { beginCostControlProbe } from "../src/lib/cost_control_probe.mjs";

const ADMIN_KEY = "probe-test-admin-key";
const WORKLOAD = "a".repeat(64);

function request(overrides = {}) {
  return new Request("https://api.cityscroll.org/admin/cost-control-probe", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${ADMIN_KEY}`,
      "x-cityscroll-cost-probe": overrides.tag || "probe-test-0001",
      "x-cityscroll-cost-cohort": overrides.cohort || "health:cold",
      "x-cityscroll-cost-workload": overrides.workload || WORKLOAD,
      "x-cityscroll-cost-series": overrides.series || overrides.tag || "series-test-0001",
      "Content-Type": "application/json",
    },
    body: overrides.rawBody ?? JSON.stringify(overrides.body || { kind: "collector-overhead" }),
  });
}

function kv() {
  const store = new Map([["present", "yes"]]);
  return {
    store,
    async get(key) { return store.get(key) ?? null; },
    async getWithMetadata(key) { return { value: store.get(key) ?? null, metadata: null }; },
    async list() { return { keys: [...store.keys()].map((name) => ({ name })), list_complete: true }; },
    async put(key, value) { store.set(key, value); },
    async delete(key) { store.delete(key); },
  };
}

function d1() {
  const statement = (sql) => ({
    bind() { return this; },
    async all() {
      if (/^\s*select/i.test(sql)) return { results: [{ value: 7 }], meta: { rows_read: 3, rows_written: 0 } };
      return { results: [], meta: { rows_read: 0, rows_written: 2 } };
    },
    async run() { return this.all(); },
  });
  return {
    prepare: statement,
    async batch(statements) { return Promise.all(statements.map((item) => item.all())); },
  };
}

test("probe rejects missing operator authorization without exposing the route", () => {
  const denied = beginCostControlProbe(new Request("https://api.cityscroll.org/health", {
    headers: {
      "x-cityscroll-cost-probe": "probe-test-0002",
      "x-cityscroll-cost-cohort": "health:cold",
      "x-cityscroll-cost-workload": WORKLOAD,
      "x-cityscroll-cost-series": "series-test-0002",
    },
  }), { ADMIN_KEY });
  assert.equal(denied.denied.status, 404);
});

test("probe counts real KV operations and suppresses rehearsal writes", async () => {
  const namespace = kv();
  const probe = beginCostControlProbe(request(), { ADMIN_KEY, STORE: namespace }, { suppressWrites: true });
  assert.equal(probe.accept(), null);
  assert.equal(await probe.env.STORE.get("present"), "yes");
  await probe.env.STORE.put("blocked", "value");
  await probe.env.STORE.delete("present");
  assert.equal(namespace.store.has("blocked"), false);
  assert.equal(namespace.store.has("present"), true);
  assert.deepEqual(probe.snapshot().operations, {
    kv_reads: 1,
    kv_writes: 2,
    d1_rows_read: 0,
    d1_rows_written: 0,
    queue_writes: 0,
    analytics_points: 0,
  });
  assert.equal(probe.snapshot().execution_mode, "production-read-only-rehearsal");
});

test("probe derives D1 row counts and converts first to a metered all query", async () => {
  const probe = beginCostControlProbe(request({ tag: "probe-test-d1", series: "series-test-d1" }), {
    ADMIN_KEY,
    DB: d1(),
  });
  assert.equal(probe.accept(), null);
  const row = await probe.env.DB.prepare("SELECT value FROM sample LIMIT 1").first();
  await probe.env.DB.prepare("UPDATE sample SET value = 8").run();
  assert.deepEqual(row, { value: 7 });
  assert.equal(probe.snapshot().operations.d1_rows_read, 3);
  assert.equal(probe.snapshot().operations.d1_rows_written, 2);
});

test("probe rejects bodies beyond its explicit byte bound", async () => {
  const response = await worker.fetch(request({
    tag: "probe-test-large",
    series: "series-test-large",
    rawBody: JSON.stringify({ kind: "collector-overhead", padding: "x".repeat(17 * 1024) }),
  }), { ADMIN_KEY }, { waitUntil() {} });
  assert.equal(response.status, 404);
});

test("invalid requests do not consume their series condition", async () => {
  const series = "series-test-retry";
  const invalid = await worker.fetch(request({
    tag: "probe-test-invalid",
    series,
    body: { kind: "http", route: "health", method: "GET", url: "https://api.cityscroll.org/not-health" },
  }), { ADMIN_KEY }, { waitUntil() {} });
  const valid = await worker.fetch(request({
    tag: "probe-test-retry",
    series,
    body: { kind: "collector-overhead" },
  }), { ADMIN_KEY }, { waitUntil() {} });
  assert.equal(invalid.status, 404);
  assert.equal(valid.status, 200);
  assert.equal((await valid.json()).isolate_condition, "cold");
});

test("collector-overhead endpoint returns a bounded no-store observation", async () => {
  const response = await worker.fetch(request({ tag: "probe-test-overhead", cohort: "collector-overhead" }), { ADMIN_KEY }, { waitUntil() {} });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  const body = await response.json();
  assert.equal(body.schema, "cityscroll.worker_cost_probe.v1");
  assert.equal(body.execution_mode, "production-read-only-rehearsal");
  assert.equal(body.result.status, 204);
});

test("authenticated HTTP probe runs the real route and reports isolate conditions", async () => {
  const workload = "b".repeat(64);
  const body = {
    kind: "http",
    route: "health",
    method: "GET",
    url: "https://api.cityscroll.org/health",
  };
  const env = { ADMIN_KEY, GIT_COMMIT_SHA: "a".repeat(40), WRANGLER_ENV: "production" };
  const coldResponse = await worker.fetch(request({ tag: "probe-test-http-1", series: "series-test-http", workload, body }), env, { waitUntil() {} });
  const warmResponse = await worker.fetch(request({ tag: "probe-test-http-2", series: "series-test-http", cohort: "health:warm", workload, body }), env, { waitUntil() {} });
  const cold = await coldResponse.json();
  const warm = await warmResponse.json();
  assert.equal(cold.isolate_condition, "cold");
  assert.equal(warm.isolate_condition, "warm");
  assert.equal(cold.result.status, 200);
  assert.equal(cold.result.body_sha256, warm.result.body_sha256);
});
