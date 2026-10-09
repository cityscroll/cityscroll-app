import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import worker from "../src/worker.mjs";
import { beginCostControlProbe, canonicalCostProbeWorkload } from "../src/lib/cost_control_probe.mjs";
import { RUM_BATCH_SCHEMA, RUM_OBSERVATION_SCHEMA } from "../src/performance_events.mjs";

const ADMIN_KEY = "probe-test-admin-key";
const DEFAULT_BODY = Object.freeze({ kind: "collector-overhead" });

function workloadHash(body) {
  return createHash("sha256").update(canonicalCostProbeWorkload(body)).digest("hex");
}

const WORKLOAD = workloadHash(DEFAULT_BODY);

function request(overrides = {}) {
  const body = overrides.body ?? DEFAULT_BODY;
  return new Request("https://api.cityscroll.org/admin/cost-control-probe", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${ADMIN_KEY}`,
      "x-cityscroll-cost-probe": overrides.tag || "probe-test-0001",
      "x-cityscroll-cost-cohort": overrides.cohort || "collector-overhead",
      "x-cityscroll-cost-workload": overrides.workload || workloadHash(body),
      "x-cityscroll-cost-series": overrides.series || overrides.tag || "series-test-0001",
      "Content-Type": "application/json",
    },
    body: overrides.rawBody ?? JSON.stringify(body),
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

function rumBatch() {
  const observation = {
    schema: RUM_OBSERVATION_SCHEMA,
    state: "measured",
    metric_id: "ttfb_ms",
    metric_version: "1.0.0",
    unit: "ms",
    value: 123.5,
    surface_id: "home",
    component_id: "none",
    device_class: "mobile",
    navigation_type: "navigate",
    delivery_class: "static",
    result_state: "content",
    collector_version: "rum-browser-v1",
    manifest_version: "rum-surfaces-v1",
    release_id: "a".repeat(40),
  };
  return {
    schema: RUM_BATCH_SCHEMA,
    observations: Array.from({ length: 16 }, () => ({ ...observation })),
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
  }), { ADMIN_KEY }, { workloadHash: WORKLOAD });
  assert.equal(denied.denied.status, 404);
});

test("probe counts real KV operations and suppresses rehearsal writes", async () => {
  const namespace = kv();
  const probe = beginCostControlProbe(request(), { ADMIN_KEY, STORE: namespace }, {
    suppressWrites: true,
    workloadHash: WORKLOAD,
  });
  probe.accept();
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
  const probe = beginCostControlProbe(
    request({ tag: "probe-test-d1", series: "series-test-d1" }),
    { ADMIN_KEY, DB: d1() },
    { workloadHash: WORKLOAD },
  );
  probe.accept();
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

test("invalid requests do not affect a corrected retry", async () => {
  const series = "series-test-retry";
  const invalid = await worker.fetch(request({
    tag: "probe-test-invalid",
    series,
    cohort: "health",
    body: { kind: "http", route: "health", method: "GET", url: "https://api.cityscroll.org/not-health" },
  }), { ADMIN_KEY }, { waitUntil() {} });
  const valid = await worker.fetch(request({
    tag: "probe-test-retry",
    series,
    body: { kind: "collector-overhead" },
  }), { ADMIN_KEY }, { waitUntil() {} });
  assert.equal(invalid.status, 404);
  assert.equal(valid.status, 200);
  assert.equal("isolate_condition" in await valid.json(), false);
});

test("probe rejects a cohort that does not match the validated workload", async () => {
  const response = await worker.fetch(request({
    tag: "probe-test-mismatch",
    series: "series-test-mismatch",
    cohort: "browse",
    body: { kind: "http", route: "health", method: "GET", url: "https://api.cityscroll.org/health" },
  }), { ADMIN_KEY }, { waitUntil() {} });
  assert.equal(response.status, 404);
});

test("probe rejects the events workload instead of contaminating resident usage", async () => {
  const analyticsPoints = [];
  const state = kv();
  const response = await worker.fetch(request({
    tag: "probe-test-events",
    series: "series-test-events",
    cohort: "events",
    body: {
      kind: "http",
      route: "events",
      method: "POST",
      url: "https://api.cityscroll.org/events",
      origin: "https://cityscroll.org",
      body: { event: "page_view", surface: "home" },
    },
  }), {
    ADMIN_KEY,
    ANALYTICS_ENVIRONMENT: "production",
    ALERT_STATE: state,
    USAGE_ANALYTICS: { writeDataPoint(point) { analyticsPoints.push(point); } },
  }, { waitUntil() {} });
  assert.equal(response.status, 404);
  assert.equal(analyticsPoints.length, 0);
  assert.deepEqual([...state.store.keys()], ["present"]);
});

test("probe rejects a workload hash copied from a different request", async () => {
  const first = {
    kind: "http",
    route: "search",
    method: "GET",
    url: "https://api.cityscroll.org/search?q=parks",
  };
  const second = { ...first, url: "https://api.cityscroll.org/search?q=schools" };
  const response = await worker.fetch(request({
    tag: "probe-test-workload-hash",
    series: "series-test-workload-hash",
    cohort: "search",
    workload: workloadHash(first),
    body: second,
  }), { ADMIN_KEY }, { waitUntil() {} });
  assert.notEqual(workloadHash(first), workloadHash(second));
  assert.equal(response.status, 404);
});

test("probe rejects malformed cohort payloads before accepting their series", async () => {
  const series = "series-test-shape";
  const invalid = await worker.fetch(request({
    tag: "probe-test-shape-bad",
    series,
    cohort: "rum-16",
    body: {
      kind: "http",
      route: "rum-16",
      method: "POST",
      url: "https://api.cityscroll.org/performance-events",
      origin: "https://cityscroll.org",
      body: {},
    },
  }), { ADMIN_KEY }, { waitUntil() {} });
  const corrected = await worker.fetch(request({
    tag: "probe-test-shape-ok",
    series,
    cohort: "collector-overhead",
    body: { kind: "collector-overhead" },
  }), { ADMIN_KEY }, { waitUntil() {} });
  assert.equal(invalid.status, 404);
  assert.equal(corrected.status, 200);
});

test("RUM probe requires production origin and marked traffic", async () => {
  const batch = rumBatch();
  const missingOrigin = await worker.fetch(request({
    tag: "probe-test-rum-origin",
    series: "series-test-rum-origin",
    cohort: "rum-16",
    body: {
      kind: "http",
      route: "rum-16",
      method: "POST",
      url: "https://api.cityscroll.org/performance-events?traffic_class=synthetic",
      body: batch,
    },
  }), { ADMIN_KEY }, { waitUntil() {} });
  const residentTraffic = await worker.fetch(request({
    tag: "probe-test-rum-resident",
    series: "series-test-rum-resident",
    cohort: "rum-16",
    body: {
      kind: "http",
      route: "rum-16",
      method: "POST",
      url: "https://api.cityscroll.org/performance-events",
      origin: "https://cityscroll.org",
      body: batch,
    },
  }), { ADMIN_KEY }, { waitUntil() {} });
  assert.equal(missingOrigin.status, 404);
  assert.equal(residentTraffic.status, 404);
});

test("RUM probe retains all observations outside resident traffic", async () => {
  const points = [];
  const response = await worker.fetch(request({
    tag: "probe-test-rum-synthetic",
    series: "series-test-rum-synthetic",
    cohort: "rum-16",
    body: {
      kind: "http",
      route: "rum-16",
      method: "POST",
      url: "https://api.cityscroll.org/performance-events?traffic_class=synthetic",
      origin: "https://cityscroll.org",
      body: rumBatch(),
    },
  }), {
    ADMIN_KEY,
    RUM_INGEST_ENABLED: "true",
    ANALYTICS_ENVIRONMENT: "production",
    RUM_ANALYTICS: { writeDataPoint(point) { points.push(point); } },
  }, { waitUntil() {} });
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.operations.analytics_points, 16);
  assert.equal(points.length, 16);
  assert.ok(points.every((point) => point.blobs[9] === "synthetic"));
});

test("probe binds each route to its supported method", async () => {
  const response = await worker.fetch(request({
    tag: "probe-test-method",
    series: "series-test-method",
    cohort: "health",
    body: { kind: "http", route: "health", method: "POST", url: "https://api.cityscroll.org/health" },
  }), { ADMIN_KEY }, { waitUntil() {} });
  assert.equal(response.status, 404);
});

test("probe rejects a supported path on the wrong production host", async () => {
  const response = await worker.fetch(request({
    tag: "probe-test-host",
    series: "series-test-host",
    cohort: "health",
    body: { kind: "http", route: "health", method: "GET", url: "https://cityscroll.org/health" },
  }), { ADMIN_KEY }, { waitUntil() {} });
  assert.equal(response.status, 404);
});

test("unconstructable requests do not prevent a corrected retry", async () => {
  const series = "series-test-construct";
  const invalid = await worker.fetch(request({
    tag: "probe-test-construct-bad",
    series,
    cohort: "health",
    body: { kind: "http", route: "health", method: "GET", url: "https://user:pass@api.cityscroll.org/health" },
  }), { ADMIN_KEY }, { waitUntil() {} });
  const valid = await worker.fetch(request({
    tag: "probe-test-construct-ok",
    series,
    cohort: "health",
    body: { kind: "http", route: "health", method: "GET", url: "https://api.cityscroll.org/health" },
  }), { ADMIN_KEY, GIT_COMMIT_SHA: "a".repeat(40), WRANGLER_ENV: "production" }, { waitUntil() {} });
  assert.equal(invalid.status, 404);
  assert.equal(valid.status, 200);
});

test("collector-overhead endpoint returns a bounded no-store observation", async () => {
  const response = await worker.fetch(request({ tag: "probe-test-overhead", cohort: "collector-overhead" }), { ADMIN_KEY }, { waitUntil() {} });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  const body = await response.json();
  assert.equal(body.schema, "cityscroll.worker_cost_probe.v1");
  assert.equal(body.execution_mode, "production-read-only-rehearsal");
  assert.equal(body.workload_hash, WORKLOAD);
  assert.equal(body.result.status, 204);
});

test("authenticated HTTP probe runs the real route without synthetic isolate labels", async () => {
  const body = {
    kind: "http",
    route: "health",
    method: "GET",
    url: "https://api.cityscroll.org/health",
  };
  const env = { ADMIN_KEY, GIT_COMMIT_SHA: "a".repeat(40), WRANGLER_ENV: "production" };
  const syntheticResponse = await worker.fetch(request({ tag: "probe-test-http-0", series: "series-test-http-0", cohort: "health:cold", body }), env, { waitUntil() {} });
  const firstResponse = await worker.fetch(request({ tag: "probe-test-http-1", series: "series-test-http-1", cohort: "health", body }), env, { waitUntil() {} });
  const secondResponse = await worker.fetch(request({ tag: "probe-test-http-2", series: "series-test-http-2", cohort: "health", body }), env, { waitUntil() {} });
  const first = await firstResponse.json();
  const second = await secondResponse.json();
  assert.equal(syntheticResponse.status, 404);
  assert.equal("isolate_condition" in first, false);
  assert.equal("isolate_condition" in second, false);
  assert.equal(first.result.status, 200);
  assert.equal(first.result.body_sha256, second.result.body_sha256);
});

test("probe does not log a successful observation when response hashing fails", async () => {
  const logs = [];
  const originalLog = console.log;
  const originalDigest = crypto.subtle.digest.bind(crypto.subtle);
  let digestCalls = 0;
  console.log = (...args) => logs.push(args);
  crypto.subtle.digest = async (...args) => {
    digestCalls += 1;
    if (digestCalls === 2) throw new Error("digest unavailable");
    return originalDigest(...args);
  };
  try {
    const response = worker.fetch(request({
      tag: "probe-test-failure",
      series: "series-test-failure",
      cohort: "health",
      body: { kind: "http", route: "health", method: "GET", url: "https://api.cityscroll.org/health" },
    }), { ADMIN_KEY, GIT_COMMIT_SHA: "a".repeat(40), WRANGLER_ENV: "production" }, { waitUntil() {} });
    await assert.rejects(response, /digest unavailable/);
    assert.equal(logs.length, 0);
  } finally {
    crypto.subtle.digest = originalDigest;
    console.log = originalLog;
  }
});
