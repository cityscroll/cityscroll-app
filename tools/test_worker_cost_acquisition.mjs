import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { queueBatchFingerprint } from "../worker/src/lib/cost_control_probe.mjs";
import {
  acquireWorkerCostProfile,
  MAX_COLLECTOR_EVENTS,
  queueFingerprintFromProviderEvent,
  raceAbortable,
  runMatchedWarehouseExperiment,
  selectOwnedHttpEvent,
} from "./lib/worker_cost_acquisition.mjs";
import {
  DOCUMENTED_NUMERIC_RAW_WAREHOUSE_COLD_START_FLAG_CAPABILITY,
  OPERATION_METERS,
  REQUIRED_COST_COHORTS,
  TAIL_WAREHOUSE_COLD_START_FLAG_CAPABILITY,
  WAREHOUSE_COLD_START_FLAG_CAPABILITIES,
  WAREHOUSE_EXPERIMENT_BASE_ROUTES,
  WAREHOUSE_EXPERIMENT_COHORTS,
  WAREHOUSE_EXPERIMENT_SAMPLES_PER_COHORT,
  baseCohortFromFlagRaw,
  coldStartFlagRawCohort,
  parseColdStartFlagRaw,
  providerDeploymentReceiptSha256,
} from "./lib/worker_cost_control.mjs";
import {
  createLiveWorkerCostTransport,
  providerEventsFromEnvelope,
  queryProviderEvents,
  secureWebSocketUrl,
} from "./worker_cost_acquisition.mjs";

const REVISION = "a".repeat(40);
const CANDIDATE = "b".repeat(40);
const RUN = "bounded-owned-run";
const RUN_HASH = createHash("sha256").update(RUN).digest("hex");
const WORKLOAD = "c".repeat(64);
const OUTER_URL = "https://worker.example/admin/cost-control-probe";
const CORRECTNESS = Object.freeze({
  input_digest: "1".repeat(64),
  joins_digest: "2".repeat(64),
  provenance_digest: "3".repeat(64),
  miss_digest: "4".repeat(64),
  freshness_digest: "5".repeat(64),
});
const operations = (queueWrites = 0, analyticsPoints = 0) => Object.fromEntries(OPERATION_METERS.map((meter) => [meter, {
  attempted: meter === "queue_writes" ? queueWrites : meter === "analytics_points" ? analyticsPoints : 0,
  confirmed: meter === "queue_writes" ? queueWrites : meter === "analytics_points" ? analyticsPoints : 0,
}]));

function deployment(revision) {
  const receipt = {
    schema: "cityscroll.cloudflare_deployment_binding.v1",
    evidence_mode: "actual-production",
    observed_at: "2026-10-09T07:50:00Z",
    production_health: { source: "cityscroll-production-health", revision },
    cloudflare_version: { source: "cloudflare-versions-api", id: `version-${revision.slice(0, 8)}` },
  };
  return {
    source: "cloudflare-deployment-receipt+health",
    receipt,
    provider_receipt_sha256: providerDeploymentReceiptSha256(receipt),
  };
}

function expectation(cohort, revision = REVISION, index = 0) {
  const probeCohort = baseCohortFromFlagRaw(cohort);
  const header = `owned-${probeCohort.replaceAll(/[^a-z0-9]/g, "-")}-${index}`;
  const series = "fixed-series";
  const receipt = {
    schema: "cityscroll.worker_cost_probe.v1",
    tag: header,
    series,
    cohort: probeCohort,
    workload_hash: WORKLOAD,
    execution_mode: "production-read-only-rehearsal",
    operation_counts: operations(1, 1),
    result: { status: 200, body_sha256: "6".repeat(64), correctness: CORRECTNESS },
  };
  return {
    header,
    series,
    probeCohort,
    workloadHash: WORKLOAD,
    outerUrl: OUTER_URL,
    providerVersionId: deployment(revision).receipt.cloudflare_version.id,
    receipt,
  };
}

function httpEvent(owned, cohort, cpu = 2, { coldStart, extraRecord = false } = {}) {
  const records = extraRecord
    ? [{ ...owned.receipt, tag: "unrelated" }, owned.receipt]
    : [owned.receipt];
  return {
    source: records[0],
    logs: records.slice(1).map((record) => ({ message: JSON.stringify(record) })),
    event: {
      request: {
        url: owned.outerUrl,
        method: "POST",
        headers: { "x-cityscroll-cost-probe": owned.header },
      },
    },
    $metadata: {
      id: `event-${owned.header}`,
      ...(coldStart === undefined
        ? { coldStart: parseColdStartFlagRaw(cohort) ?? 0 }
        : { coldStart }),
    },
    $workers: { cpuTimeMs: cpu, outcome: "ok", scriptVersion: { id: owned.providerVersionId } },
    exceptions: [],
  };
}

function scheduledEvent(cron, time, revision = REVISION) {
  return {
    source: {
      schema: "cityscroll.worker_native_cost_probe.v1",
      kind: "scheduled",
      run_marker_sha256: RUN_HASH,
      workload_digest: WORKLOAD,
      instrumentation_log_count: 1,
      operations: operations(1, 1),
      trigger: cron,
      scheduled_time: time,
    },
    $metadata: { requestId: `scheduled-${cron}`, trigger: cron },
    $workers: {
      cpuTimeMs: 3,
      outcome: "ok",
      eventType: "scheduled",
      requestId: `scheduled-${cron}`,
      scriptVersion: { id: deployment(revision).receipt.cloudflare_version.id },
      event: { cron, scheduledTime: time },
    },
    exceptions: [],
  };
}

async function queueEvent(revision = REVISION) {
  const messages = [{ id: "provider-message", timestamp: new Date("2026-10-09T08:59:00Z"), attempts: 1, body: { kind: "owned" } }];
  const fingerprint = await queueBatchFingerprint({ queue: "digest-queue", messages });
  return {
    source: {
      schema: "cityscroll.worker_native_cost_probe.v1",
      kind: "queue",
      run_marker_sha256: RUN_HASH,
      workload_digest: WORKLOAD,
      instrumentation_log_count: 1,
      operations: operations(1, 1),
      queue: "digest-queue",
      batch_size: 1,
      batch_fingerprint_sha256: fingerprint,
    },
    $metadata: { requestId: "queue-request", trigger: "digest-queue" },
    $workers: {
      cpuTimeMs: 4,
      outcome: "ok",
      eventType: "queue",
      requestId: "queue-request",
      scriptVersion: { id: deployment(revision).receipt.cloudflare_version.id },
      event: { queue: "digest-queue", batchSize: 1, messages },
    },
    exceptions: [],
  };
}

function plan() {
  return {
    run_marker: RUN,
    workload_digest: WORKLOAD,
    queue: "digest-queue",
    scheduled_times: {
      "0 8 * * *": Date.parse("2026-10-09T08:00:00Z"),
      "0 10 * * *": Date.parse("2026-10-09T10:00:00Z"),
      "0 13 * * *": Date.parse("2026-10-09T13:00:00Z"),
    },
  };
}

async function profileTransport({ corruptQueue = false, missingColdStart = false } = {}) {
  const configuration = plan();
  let expectations = {};
  return {
    acquireDeployment: async () => deployment(REVISION),
    measurementPlan: async () => configuration,
    executeFixedHttpWorkloads: async () => {
      expectations = Object.fromEntries(
        REQUIRED_COST_COHORTS
          .filter((cohort) => !cohort.startsWith("cron:") && cohort !== "queue")
          .map((cohort, index) => [cohort, expectation(cohort, REVISION, index)]),
      );
      return expectations;
    },
    collectProviderEvents: async ({ execute }) => {
      await execute?.();
      const events = Object.entries(expectations).map(([cohort, owned], index) => httpEvent(owned, cohort, 2, {
        coldStart: missingColdStart && cohort === "health" ? undefined : parseColdStartFlagRaw(cohort) ?? 0,
        extraRecord: index === 0,
      }));
      if (missingColdStart) {
        const healthEvent = events.find((event) => event.event.request.headers["x-cityscroll-cost-probe"].startsWith("owned-health-"));
        delete healthEvent.$metadata.coldStart;
      }
      for (const [cron, time] of Object.entries(configuration.scheduled_times)) events.push(scheduledEvent(cron, time));
      const queued = await queueEvent();
      if (corruptQueue) queued.source.batch_fingerprint_sha256 = "f".repeat(64);
      events.push(queued);
      return events;
    },
  };
}

test("profile acquisition binds outer requests, structured receipts, and every meter", async () => {
  const result = await acquireWorkerCostProfile({
    revision: REVISION,
    window: { from: "2026-10-09T07:55:00Z", to: "2026-10-09T08:25:00Z" },
    transport: await profileTransport(),
  });
  assert.equal(result.status, "complete");
  assert.equal(result.profile.cohorts.queue.samples[0].operations.queue_writes.confirmed, 1);
  assert.equal(result.profile.cohorts.queue.samples[0].operations.analytics_points.confirmed, 1);
  assert.match(result.profile.correctness.input_digest, /^[a-f0-9]{64}$/);
  const rawQueue = (await (await profileTransport()).collectProviderEvents({
    execute: async () => {},
  })).find((event) => event.$workers?.eventType === "queue");
  assert.equal(await queueFingerprintFromProviderEvent(rawQueue), rawQueue.source.batch_fingerprint_sha256);
});

test("missing provider cold-start metadata keeps route cohorts measured as unknown isolate", async () => {
  const result = await acquireWorkerCostProfile({
    revision: REVISION,
    window: { from: "2026-10-09T07:55:00Z", to: "2026-10-09T08:25:00Z" },
    transport: await profileTransport({ missingColdStart: true }),
  });
  assert.equal(result.status, "complete");
  assert.equal(result.profile.cohorts.health.status, "measured");
  assert.equal(result.profile.cohorts.health.samples[0].condition.isolate_observation.present, false);
  assert.equal(result.profile.cohorts.health.samples[0].condition.isolate_observation.provisional_label, "unknown");
});

test("unbound queue evidence remains partial instead of becoming zero", async () => {
  const result = await acquireWorkerCostProfile({
    revision: REVISION,
    window: { from: "2026-10-09T07:55:00Z", to: "2026-10-09T08:25:00Z" },
    transport: await profileTransport({ corruptQueue: true }),
  });
  assert.equal(result.status, "partial");
  assert.equal(result.profile.cohorts.queue.status, "unknown");
  assert.match(result.reasons.find((entry) => entry.cohort === "queue").reason, /fingerprint/);
});

test("profile collection coordinates future windows without serially consuming their timeouts", async () => {
  let active = 0;
  let maximumActive = 0;
  const limits = [];
  const result = await acquireWorkerCostProfile({
    revision: REVISION,
    window: { windows: [
      { from: "2026-10-09T07:55:00Z", to: "2026-10-09T08:25:00Z" },
      { from: "2026-10-09T09:55:00Z", to: "2026-10-09T10:25:00Z" },
      { from: "2026-10-09T12:55:00Z", to: "2026-10-09T13:25:00Z" },
    ] },
    transport: {
      acquireDeployment: async () => deployment(REVISION),
      measurementPlan: async () => plan(),
      executeFixedHttpWorkloads: async () => ({ "health": expectation("health") }),
      collectProviderEvents: async ({ execute, limit }) => {
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        limits.push(limit);
        await execute?.();
        await Promise.resolve();
        active -= 1;
        return [];
      },
    },
  });
  assert.equal(result.status, "partial");
  assert.equal(maximumActive, 3);
  assert.equal(limits.reduce((sum, value) => sum + value, 0), 10_000);
});

test("provider query uses official envelopes, nested parameters, and bounded cursor pages", async () => {
  const requests = [];
  const first = Array.from({ length: 2_000 }, (_, index) => ({ $metadata: { id: `event-${index}` } }));
  const pages = [first, [{ $metadata: { id: "event-final" } }]];
  const events = await queryProviderEvents({
    accountId: "account",
    token: "token",
    workerName: "cityscroll-worker",
    from: "2026-10-09T08:00:00Z",
    to: "2026-10-09T08:30:00Z",
    limit: 10_000,
    fetchImpl: async (_url, init) => {
      requests.push(JSON.parse(init.body));
      return Response.json({ success: true, result: { events: { events: pages.shift() } } });
    },
  });
  assert.equal(events.length, 2_001);
  assert.equal(requests[0].limit, 2_000);
  assert.deepEqual(requests[0].parameters.datasets, ["cloudflare-workers"]);
  assert.equal(requests[0].datasets, undefined);
  assert.equal(requests[1].offset, "event-1999");
  assert.equal(requests[0].timeframe.from, Date.parse("2026-10-09T08:00:00Z"));
  assert.equal(requests[1].offsetDirection, "next");
});

test("provider invocation envelopes merge structured logs with nested Worker requests", () => {
  const owned = expectation("health");
  const events = providerEventsFromEnvelope({
    result: {
      invocations: {
        request: [
          { source: owned.receipt },
          {
            $metadata: { id: "event-grouped", coldStart: 1 },
            $workers: {
              cpuTimeMs: 2,
              outcome: "ok",
              scriptVersion: { id: owned.providerVersionId },
              event: { request: { url: owned.outerUrl, method: "POST", headers: { "x-cityscroll-cost-probe": owned.header } } },
            },
          },
        ],
      },
    },
  });
  assert.equal(events.length, 1);
  assert.equal(selectOwnedHttpEvent(events, owned, "health").$metadata.id, "event-grouped");
});

test("live-tail URLs accept secure provider schemes and reject user information", () => {
  assert.equal(secureWebSocketUrl("https://tail.example/session"), "wss://tail.example/session");
  assert.equal(secureWebSocketUrl("wss://tail.example/session"), "wss://tail.example/session");
  assert.throws(() => secureWebSocketUrl("https://user:secret@tail.example/session"), /user information/);
  assert.throws(() => secureWebSocketUrl("ws://tail.example/session"), /secure/);
});

class FakeSocket {
  constructor() {
    this.listeners = new Map();
    queueMicrotask(() => this.emit("open", {}));
  }
  addEventListener(type, handler) {
    this.listeners.set(type, [...(this.listeners.get(type) || []), handler]);
  }
  emit(type, value) {
    for (const handler of this.listeners.get(type) || []) handler(value);
  }
  close() {
    this.closed = true;
    this.emit("close", {});
  }
}

function liveTransport(overrides = {}) {
  return createLiveWorkerCostTransport({
    env: {
      CLOUDFLARE_OBSERVABILITY_TOKEN: "telemetry-only",
      WORKER_COST_ADMIN_KEY: "admin-key",
      CLOUDFLARE_ACCOUNT_ID: "account",
      WORKER_HEALTH_URL: "https://worker.example/health",
      WORKER_API_ORIGIN: "https://worker.example",
      WORKER_NAME: "cityscroll-worker",
      WORKER_COST_LIVE_TAIL_SETTLE_MS: "0",
      WORKER_COST_MEASUREMENT_PLAN: JSON.stringify({ run_marker: RUN, workload_digest: WORKLOAD }),
    },
    now: () => Date.parse("2026-10-09T08:00:00Z"),
    ...overrides,
  });
}

test("live-tail heartbeat starts before acquisition and is stopped after idle collection", async () => {
  const requests = [];
  const intervals = [];
  const cleared = [];
  let socket;
  const transport = liveTransport({
    fetchImpl: async (url, init = {}) => {
      requests.push({ url, init });
      if (url.endsWith("/heartbeat")) return Response.json({ success: true, result: {} });
      return Response.json({ success: true, result: { wsUrl: "wss://tail.example/session" } });
    },
    webSocketFactory: () => (socket = new FakeSocket()),
    setIntervalImpl: (callback, milliseconds) => {
      intervals.push({ callback, milliseconds });
      return "heartbeat-interval";
    },
    clearIntervalImpl: (timer) => cleared.push(timer),
    sleep: async () => {},
  });
  await transport.collectProviderEvents({
    from: "2026-10-09T08:00:00Z",
    to: "2026-10-09T08:30:00Z",
    limit: 100,
  });
  const heartbeatRequests = requests.filter(({ url }) => url.endsWith("/heartbeat"));
  assert.equal(heartbeatRequests.length, 1);
  assert.deepEqual(JSON.parse(heartbeatRequests[0].init.body), { scriptId: "cityscroll-worker" });
  assert.equal(heartbeatRequests[0].init.headers.Authorization, "Bearer telemetry-only");
  assert.equal(intervals[0].milliseconds, 15_000);
  assert.deepEqual(cleared, ["heartbeat-interval"]);
  assert.equal(socket.closed, true);
});

test("live-tail heartbeat failure aborts acquisition and clears its interval", async () => {
  let heartbeatCount = 0;
  let intervalCallback;
  const cleared = [];
  let socket;
  const transport = liveTransport({
    fetchImpl: async (url) => {
      if (!url.endsWith("/heartbeat")) return Response.json({ success: true, result: { wsUrl: "wss://tail.example/session" } });
      heartbeatCount += 1;
      return heartbeatCount === 1
        ? Response.json({ success: true, result: {} })
        : Response.json({ success: false, errors: [{ message: "expired" }] }, { status: 401 });
    },
    webSocketFactory: () => (socket = new FakeSocket()),
    setIntervalImpl: (callback) => {
      intervalCallback = callback;
      return "heartbeat-interval";
    },
    clearIntervalImpl: (timer) => cleared.push(timer),
    sleep: async () => { await intervalCallback(); },
  });
  await assert.rejects(transport.collectProviderEvents({
    from: "2026-10-09T08:00:00Z",
    to: "2026-10-09T08:30:00Z",
    limit: 100,
  }), /authenticated live-tail heartbeat failed/);
  assert.deepEqual(cleared, ["heartbeat-interval"]);
  assert.equal(socket.closed, true);
});

test("initial heartbeat precedes acquisition and abort cancels further scheduling", async () => {
  const controller = new AbortController();
  let heartbeatCount = 0;
  const cleared = [];
  const transport = liveTransport({
    fetchImpl: async (url) => {
      if (url.endsWith("/heartbeat")) {
        heartbeatCount += 1;
        return Response.json({ success: true, result: {} });
      }
      return Response.json({ success: true, result: { wsUrl: "wss://tail.example/session" } });
    },
    webSocketFactory: () => new FakeSocket(),
    setIntervalImpl: () => "heartbeat-interval",
    clearIntervalImpl: (timer) => cleared.push(timer),
    sleep: async (_milliseconds, signal) => {
      controller.abort();
      if (signal.aborted) throw new Error("provider event collection was cancelled");
    },
  });
  await assert.rejects(transport.collectProviderEvents({
    from: "2026-10-09T08:00:00Z",
    to: "2026-10-09T08:30:00Z",
    limit: 100,
    signal: controller.signal,
    execute: async () => assert.equal(heartbeatCount, 1),
  }), /cancelled/);
  assert.equal(heartbeatCount, 1);
  assert.deepEqual(cleared, ["heartbeat-interval"]);
});

test("future live-tail windows wait before starting their collection timeout", async () => {
  let current = Date.parse("2026-10-09T08:25:00Z");
  const activity = [];
  const transport = createLiveWorkerCostTransport({
    env: {
      CLOUDFLARE_OBSERVABILITY_TOKEN: "telemetry-only",
      WORKER_COST_ADMIN_KEY: "admin-key",
      CLOUDFLARE_ACCOUNT_ID: "account",
      WORKER_HEALTH_URL: "https://worker.example/health",
      WORKER_API_ORIGIN: "https://worker.example",
      WORKER_COST_MEASUREMENT_PLAN: JSON.stringify({ run_marker: RUN, workload_digest: WORKLOAD }),
    },
    now: () => current,
    sleep: async (milliseconds) => {
      activity.push(["wait", milliseconds]);
      current += milliseconds;
    },
    fetchImpl: async (url) => {
      activity.push(["fetch", url]);
      return Response.json({ success: true, result: { wsUrl: "https://tail.example/session" } });
    },
    webSocketFactory: (url) => {
      activity.push(["socket", url]);
      return new FakeSocket();
    },
  });
  await transport.collectProviderEvents({
    from: "2026-10-09T09:55:00Z",
    to: "2026-10-09T10:25:00Z",
    limit: 100,
  });
  assert.deepEqual(activity[0], ["wait", 90 * 60 * 1000]);
  assert.equal(activity[1][0], "fetch");
  assert.deepEqual(activity[2], ["socket", "wss://tail.example/session"]);
});

test("collection cancellation reaches in-flight workload fetches", async () => {
  const controller = new AbortController();
  let workloadSignal;
  const transport = createLiveWorkerCostTransport({
    env: {
      CLOUDFLARE_OBSERVABILITY_TOKEN: "telemetry-only",
      WORKER_COST_ADMIN_KEY: "admin-key",
      CLOUDFLARE_ACCOUNT_ID: "account",
      WORKER_HEALTH_URL: "https://worker.example/health",
      WORKER_API_ORIGIN: "https://worker.example",
      WORKER_COST_LIVE_TAIL_SETTLE_MS: "0",
      WORKER_COST_MEASUREMENT_PLAN: JSON.stringify({ run_marker: RUN, workload_digest: WORKLOAD }),
    },
    now: () => Date.parse("2026-10-09T08:00:00Z"),
    webSocketFactory: () => new FakeSocket(),
    fetchImpl: async (url, init = {}) => {
      if (url.includes("/live-tail")) return Response.json({ success: true, result: { wsUrl: "wss://tail.example/session" } });
      workloadSignal = init.signal;
      queueMicrotask(() => controller.abort());
      return new Promise((_resolve, reject) => init.signal.addEventListener("abort", () => reject(new Error("request aborted")), { once: true }));
    },
  });
  const acquired = deployment(REVISION);
  const planValue = {
    series: "fixed-series",
    http_workloads: [{ cohort: "health", probe_cohort: "health", header: expectation("health").header, workload_hash: WORKLOAD, body: { kind: "http", route: "health" } }],
  };
  await assert.rejects(transport.collectProviderEvents({
    from: "2026-10-09T08:00:00Z",
    to: "2026-10-09T08:30:00Z",
    limit: 100,
    signal: controller.signal,
    execute: (signal) => transport.executeFixedHttpWorkloads({ plan: planValue, deployment: acquired, signal }),
  }), /aborted|cancelled/);
  assert.equal(workloadSignal.aborted, true);
});

test("live transport separates telemetry authentication and targets the authenticated version", async () => {
  const fetches = [];
  const wranglerEnvironments = [];
  let socket;
  const env = {
    CLOUDFLARE_OBSERVABILITY_TOKEN: "telemetry-only",
    CLOUDFLARE_API_TOKEN: "must-not-reach-wrangler",
    WORKER_COST_ADMIN_KEY: "admin-key",
    CLOUDFLARE_ACCOUNT_ID: "account",
    WORKER_HEALTH_URL: "https://worker.example/health",
    WORKER_API_ORIGIN: "https://worker.example",
    WORKER_NAME: "cityscroll-worker",
    WORKER_COST_LIVE_TAIL_SETTLE_MS: "0",
    WORKER_COST_MEASUREMENT_PLAN: JSON.stringify({ run_marker: RUN, workload_digest: WORKLOAD }),
  };
  const transport = createLiveWorkerCostTransport({
    env,
    now: () => Date.parse("2026-10-09T08:00:00Z"),
    webSocketFactory: () => (socket = new FakeSocket()),
    invokeWrangler: (args, invocationEnv) => {
      wranglerEnvironments.push(invocationEnv);
      if (args[0] === "deployments") {
        return { created_on: "2026-10-09T07:50:00Z", versions: [{ version_id: "version-aaaaaaaa", percentage: 100 }] };
      }
      return [{ id: "version-aaaaaaaa", annotations: { "workers/tag": `cityscroll-canary-${REVISION}` } }];
    },
    fetchImpl: async (url, init = {}) => {
      fetches.push({ url, init });
      if (url.endsWith("/health")) {
        return Response.json({ status: "cityscroll-worker ok", environment: "production", commit: REVISION });
      }
      if (url.includes("/live-tail")) return Response.json({ success: true, result: { wsUrl: "wss://tail.example/session" } });
      if (url.endsWith("/admin/cost-control-probe")) {
        const receipt = expectation("health").receipt;
        return Response.json(receipt);
      }
      throw new Error(`unexpected fetch ${url}`);
    },
  });
  const acquired = await transport.acquireDeployment(REVISION);
  assert.equal(acquired.receipt.cloudflare_version.id, "version-aaaaaaaa");
  assert.ok(wranglerEnvironments.every((value) => !value.CLOUDFLARE_API_TOKEN && !value.CLOUDFLARE_OBSERVABILITY_TOKEN));
  const planValue = {
    series: "fixed-series",
    http_workloads: [{ cohort: "health", probe_cohort: "health", header: expectation("health").header, workload_hash: WORKLOAD, body: { kind: "http", route: "health" } }],
  };
  let expected;
  const events = await transport.collectProviderEvents({
    from: "2026-10-09T08:00:00Z",
    to: "2026-10-09T08:30:00Z",
    limit: 10_000,
    execute: async () => {
      expected = (await transport.executeFixedHttpWorkloads({ plan: planValue, deployment: acquired })).health;
      socket.emit("message", { data: JSON.stringify({ events: [{ events: [httpEvent(expected, "health")] }] }) });
    },
  });
  assert.equal(events.length, 1);
  assert.equal(providerEventsFromEnvelope({ result: { events: { events } } }).length, 1);
  const tailRequest = fetches.find((entry) => entry.url.includes("/live-tail"));
  assert.equal(tailRequest.init.headers.Authorization, "Bearer telemetry-only");
  const workloadRequest = fetches.find((entry) => entry.url.endsWith("/admin/cost-control-probe"));
  assert.equal(workloadRequest.init.headers["Cloudflare-Workers-Version-Overrides"], 'cityscroll-worker="version-aaaaaaaa"');
  assert.equal(workloadRequest.init.method, "POST");
});

function liveWarehouseTransport({ flagRaw1Coverage = true } = {}) {
  const bases = [...new Set(WAREHOUSE_EXPERIMENT_COHORTS.map((cohort) => baseCohortFromFlagRaw(cohort)))];
  const workloads = WAREHOUSE_EXPERIMENT_COHORTS.map((cohort) => {
    const base = baseCohortFromFlagRaw(cohort);
    return {
      cohort,
      probe_cohort: base,
      workload_hash: createHash("sha256").update(base).digest("hex"),
      body: { kind: "http", route: base },
    };
  });
  const measurement = {
    run_marker: RUN,
    workload_digest: WORKLOAD,
    warehouse_workloads: workloads,
    collector_workload: {
      cohort: "collector-overhead",
      probe_cohort: "collector-overhead",
      workload_hash: createHash("sha256").update("collector-overhead").digest("hex"),
      body: { kind: "collector-overhead" },
    },
  };
  const events = [];
  const counts = new Map(bases.map((base) => [base, 0]));
  let requests = 0;
  const transport = createLiveWorkerCostTransport({
    env: {
      CLOUDFLARE_OBSERVABILITY_TOKEN: "telemetry-only",
      WORKER_COST_ADMIN_KEY: "admin-key",
      CLOUDFLARE_ACCOUNT_ID: "account",
      WORKER_HEALTH_URL: "https://worker.example/health",
      WORKER_API_ORIGIN: "https://worker.example",
      WORKER_COST_MEASUREMENT_PLAN: JSON.stringify(measurement),
    },
    warehouseAttemptsPerInput: 200,
    now: () => Date.parse("2026-10-09T08:00:00Z"),
    fetchImpl: async (url, init) => {
      if (!url.endsWith("/admin/cost-control-probe")) throw new Error(`unexpected fetch ${url}`);
      requests += 1;
      const headers = init.headers;
      const cohort = headers["x-cityscroll-cost-cohort"];
      const isCollector = cohort === "collector-overhead";
      const seen = isCollector ? 0 : counts.get(cohort);
      if (!isCollector) counts.set(cohort, seen + 1);
      const receipt = {
        schema: "cityscroll.worker_cost_probe.v1",
        tag: headers["x-cityscroll-cost-probe"],
        series: headers["x-cityscroll-cost-series"],
        cohort,
        workload_hash: headers["x-cityscroll-cost-workload"],
        execution_mode: "production-read-only-rehearsal",
        operation_counts: operations(),
        result: {
          status: isCollector ? 204 : 200,
          body_sha256: "6".repeat(64),
          ...(!isCollector ? { correctness: CORRECTNESS } : {}),
        },
      };
      events.push({
        source: receipt,
        $metadata: {
          id: `warehouse-${requests}`,
          ...(!isCollector ? { coldStart: flagRaw1Coverage && seen < 100 ? 1 : 0 } : {}),
        },
        $workers: {
          cpuTimeMs: 2,
          outcome: "ok",
          scriptVersion: { id: deployment(REVISION).receipt.cloudflare_version.id },
          event: { request: { url: OUTER_URL, method: "POST", headers: { "x-cityscroll-cost-probe": receipt.tag } } },
        },
        exceptions: [],
      });
      return Response.json(receipt);
    },
  });
  transport.collectProviderEvents = async ({ execute }) => {
    await execute(new AbortController().signal, { events });
    return events;
  };
  return { transport, requestCount: () => requests, events };
}

test("warehouse runner samples until exact provider-observed cold_start_flag_raw 0/1 populations exist", async () => {
  const { transport, requestCount } = liveWarehouseTransport();
  const result = await transport.collectWarehouseRun({
    label: "baseline",
    revision: REVISION,
    deployment: deployment(REVISION),
    workloadId: "fixed-warehouse-test",
    cohorts: WAREHOUSE_EXPERIMENT_COHORTS,
    samplesPerCohort: WAREHOUSE_EXPERIMENT_SAMPLES_PER_COHORT,
    maxEvents: 10_000,
  });
  assert.equal(result.status, "complete");
  assert.equal(requestCount(), 2_000);
  for (const cohort of WAREHOUSE_EXPERIMENT_COHORTS) {
    assert.equal(result.cohorts[cohort].length, 100);
    assert.ok(result.cohorts[cohort].every((sample) => {
      const isolate = sample.condition.isolate_observation;
      return isolate?.present === true
        && isolate.raw === parseColdStartFlagRaw(cohort)
        && isolate.provisional_label === "unverified-raw"
        && isolate.semantics === "unverified-provider-flag"
        && !("cold_start" in sample.condition);
    }));
  }
});

test("warehouse runner reports incomplete cold_start_flag_raw=1 coverage", async () => {
  const { transport } = liveWarehouseTransport({ flagRaw1Coverage: false });
  const result = await transport.collectWarehouseRun({
    label: "baseline",
    revision: REVISION,
    deployment: deployment(REVISION),
    workloadId: "fixed-warehouse-test",
    cohorts: WAREHOUSE_EXPERIMENT_COHORTS,
    samplesPerCohort: WAREHOUSE_EXPERIMENT_SAMPLES_PER_COHORT,
    maxEvents: 10_000,
  });
  assert.equal(result.status, "blocked");
  assert.match(result.reason, /cold_start_flag_raw=1 provider samples are incomplete/);
});

/**
 * Flag-less warehouse transport with synthetic collector retention.
 * retainEveryK=1 → perfect retention (every collector probe becomes a tail event).
 * retainEveryK=K → keep only every K-th collector probe (approx retention 1/K).
 */
function liveFlaglessCollectorRetentionTransport({
  retainEveryK = 1,
  baseRetainEveryK = 1,
  warehouseAttemptsPerInput = 1_800,
  versionId = deployment(REVISION).receipt.cloudflare_version.id,
  collectorMillisecondsPerSend = 0,
} = {}) {
  const workloads = WAREHOUSE_EXPERIMENT_BASE_ROUTES.map((cohort) => ({
    cohort,
    probe_cohort: cohort,
    workload_hash: createHash("sha256").update(cohort).digest("hex"),
    body: { kind: "http", route: cohort },
  }));
  const measurement = {
    run_marker: RUN,
    workload_digest: WORKLOAD,
    warehouse_workloads: workloads,
    collector_workload: {
      cohort: "collector-overhead",
      probe_cohort: "collector-overhead",
      workload_hash: createHash("sha256").update("collector-overhead").digest("hex"),
      body: { kind: "collector-overhead" },
    },
  };
  const events = [];
  let requests = 0;
  let collectorSends = 0;
  let collectorRetained = 0;
  let currentTime = Date.parse("2026-10-09T08:00:00Z");
  const baseSends = new Map();
  const overrideHeaders = [];
  const transport = createLiveWorkerCostTransport({
    env: {
      CLOUDFLARE_OBSERVABILITY_TOKEN: "telemetry-only",
      WORKER_COST_ADMIN_KEY: "admin-key",
      CLOUDFLARE_ACCOUNT_ID: "account",
      WORKER_HEALTH_URL: "https://worker.example/health",
      WORKER_API_ORIGIN: "https://worker.example",
      WORKER_COST_MEASUREMENT_PLAN: JSON.stringify(measurement),
    },
    warehouseAttemptsPerInput,
    now: () => currentTime,
    fetchImpl: async (url, init) => {
      if (!url.endsWith("/admin/cost-control-probe")) throw new Error(`unexpected fetch ${url}`);
      requests += 1;
      const headers = init.headers;
      overrideHeaders.push(headers["Cloudflare-Workers-Version-Overrides"]);
      const cohort = headers["x-cityscroll-cost-cohort"];
      const isCollector = cohort === "collector-overhead";
      const receipt = {
        schema: "cityscroll.worker_cost_probe.v1",
        tag: headers["x-cityscroll-cost-probe"],
        series: headers["x-cityscroll-cost-series"],
        cohort,
        workload_hash: headers["x-cityscroll-cost-workload"],
        execution_mode: "production-read-only-rehearsal",
        operation_counts: operations(),
        result: {
          status: isCollector ? 204 : 200,
          body_sha256: "6".repeat(64),
          ...(!isCollector ? { correctness: CORRECTNESS } : {}),
        },
      };
      let retain = true;
      if (isCollector) {
        collectorSends += 1;
        currentTime += collectorMillisecondsPerSend;
        retain = retainEveryK <= 1 || (collectorSends % retainEveryK === 0);
        if (retain) collectorRetained += 1;
      } else {
        const cohortSends = (baseSends.get(cohort) || 0) + 1;
        baseSends.set(cohort, cohortSends);
        retain = baseRetainEveryK <= 1 || (cohortSends % baseRetainEveryK === 0);
      }
      if (retain) {
        events.push({
          source: receipt,
          $metadata: { id: `warehouse-retention-${requests}` },
          $workers: {
            cpuTimeMs: 2,
            outcome: "ok",
            scriptVersion: { id: versionId },
            event: { request: { url: OUTER_URL, method: "POST", headers: { "x-cityscroll-cost-probe": receipt.tag } } },
          },
          exceptions: [],
        });
      }
      return Response.json(receipt);
    },
  });
  transport.collectProviderEvents = async ({ execute }) => {
    await execute(new AbortController().signal, { events });
    return events;
  };
  return {
    transport,
    requestCount: () => requests,
    collectorSends: () => collectorSends,
    collectorRetained: () => collectorRetained,
    eventCount: () => events.length,
    overrideHeaders: () => overrideHeaders,
  };
}

test("adaptive collector early-stops at N under perfect retention (same request count)", async () => {
  const { transport, requestCount, collectorSends } = liveFlaglessCollectorRetentionTransport({
    retainEveryK: 1,
    warehouseAttemptsPerInput: 200,
  });
  const result = await transport.collectWarehouseRun({
    label: "baseline",
    revision: REVISION,
    deployment: deployment(REVISION),
    workloadId: "fixed-warehouse-test",
    cohorts: WAREHOUSE_EXPERIMENT_BASE_ROUTES,
    samplesPerCohort: WAREHOUSE_EXPERIMENT_SAMPLES_PER_COHORT,
    maxEvents: 10_000,
  });
  assert.equal(result.status, "complete");
  const baseProbes = 200 * WAREHOUSE_EXPERIMENT_BASE_ROUTES.length;
  const collectorTarget = WAREHOUSE_EXPERIMENT_BASE_ROUTES.length * WAREHOUSE_EXPERIMENT_SAMPLES_PER_COHORT;
  assert.equal(collectorSends(), collectorTarget);
  assert.equal(requestCount(), baseProbes + collectorTarget);
});

test("adaptive collector fails closed without a live event buffer", async () => {
  const { transport } = liveFlaglessCollectorRetentionTransport({ warehouseAttemptsPerInput: 200 });
  transport.collectProviderEvents = async ({ execute }) => {
    await execute(new AbortController().signal);
    return [];
  };
  const result = await transport.collectWarehouseRun({
    label: "baseline",
    revision: REVISION,
    deployment: deployment(REVISION),
    workloadId: "fixed-warehouse-test",
    cohorts: WAREHOUSE_EXPERIMENT_BASE_ROUTES,
    samplesPerCohort: WAREHOUSE_EXPERIMENT_SAMPLES_PER_COHORT,
    maxEvents: 10_000,
  });
  assert.equal(result.status, "blocked");
  assert.equal(result.reason, "warehouse collector live event buffer is unavailable");
});

test("adaptive collector oversamples until N retained under synthetic low retention", async () => {
  // retainEveryK=5 ≈ 0.20 retention; 500 retained need ~2500 collector sends.
  const { transport, collectorSends, collectorRetained } = liveFlaglessCollectorRetentionTransport({
    retainEveryK: 5,
    warehouseAttemptsPerInput: 200,
  });
  const result = await transport.collectWarehouseRun({
    label: "baseline",
    revision: REVISION,
    deployment: deployment(REVISION),
    workloadId: "fixed-warehouse-test",
    cohorts: WAREHOUSE_EXPERIMENT_BASE_ROUTES,
    samplesPerCohort: WAREHOUSE_EXPERIMENT_SAMPLES_PER_COHORT,
    maxEvents: 10_000,
  });
  assert.equal(result.status, "complete");
  const collectorTarget = WAREHOUSE_EXPERIMENT_BASE_ROUTES.length * WAREHOUSE_EXPERIMENT_SAMPLES_PER_COHORT;
  assert.ok(collectorSends() > collectorTarget, `expected oversample sends > ${collectorTarget}, got ${collectorSends()}`);
  assert.ok(collectorRetained() >= collectorTarget);
  for (const cohort of WAREHOUSE_EXPERIMENT_BASE_ROUTES) {
    assert.equal(result.cohorts[cohort].length, WAREHOUSE_EXPERIMENT_SAMPLES_PER_COHORT);
  }
});

test("adaptive collector completes at production attempts under observed tail retention", async () => {
  const { transport, collectorSends, collectorRetained, eventCount } = liveFlaglessCollectorRetentionTransport({
    retainEveryK: 17,
    baseRetainEveryK: 17,
  });
  const result = await transport.collectWarehouseRun({
    label: "baseline",
    revision: REVISION,
    deployment: deployment(REVISION),
    workloadId: "fixed-warehouse-test",
    cohorts: WAREHOUSE_EXPERIMENT_BASE_ROUTES,
    samplesPerCohort: WAREHOUSE_EXPERIMENT_SAMPLES_PER_COHORT,
    maxEvents: 10_000,
  });
  assert.equal(result.status, "complete", result.reason);
  const collectorTarget = WAREHOUSE_EXPERIMENT_BASE_ROUTES.length * WAREHOUSE_EXPERIMENT_SAMPLES_PER_COHORT;
  assert.equal(collectorRetained(), collectorTarget);
  assert.equal(collectorSends(), collectorTarget * 17);
  assert.ok(eventCount() <= 10_000);
  for (const cohort of WAREHOUSE_EXPERIMENT_BASE_ROUTES) {
    assert.equal(result.cohorts[cohort].length, WAREHOUSE_EXPERIMENT_SAMPLES_PER_COHORT);
  }
});

test("adaptive collector blocks when oversample budget cannot retain N", async () => {
  // retainEveryK=50 ≈ 0.02 retention; the 9500-send budget retains ~190 < 500.
  const { transport, collectorSends } = liveFlaglessCollectorRetentionTransport({
    retainEveryK: 50,
    warehouseAttemptsPerInput: 200,
  });
  const result = await transport.collectWarehouseRun({
    label: "baseline",
    revision: REVISION,
    deployment: deployment(REVISION),
    workloadId: "fixed-warehouse-test",
    cohorts: WAREHOUSE_EXPERIMENT_BASE_ROUTES,
    samplesPerCohort: WAREHOUSE_EXPERIMENT_SAMPLES_PER_COHORT,
    maxEvents: 10_000,
  });
  assert.equal(result.status, "blocked");
  assert.match(result.reason, /collector-overhead provider samples are incomplete/);
  const retainedBaseSamples = WAREHOUSE_EXPERIMENT_SAMPLES_PER_COHORT * WAREHOUSE_EXPERIMENT_BASE_ROUTES.length;
  const leftover = 10_000 - retainedBaseSamples;
  assert.equal(collectorSends(), leftover);
});

test("adaptive collector stops when the 30-minute collection deadline is reached", async () => {
  const { transport, collectorSends } = liveFlaglessCollectorRetentionTransport({
    retainEveryK: 50_000,
    warehouseAttemptsPerInput: 200,
    collectorMillisecondsPerSend: 1_000,
  });
  const result = await transport.collectWarehouseRun({
    label: "baseline",
    revision: REVISION,
    deployment: deployment(REVISION),
    workloadId: "fixed-warehouse-test",
    cohorts: WAREHOUSE_EXPERIMENT_BASE_ROUTES,
    samplesPerCohort: WAREHOUSE_EXPERIMENT_SAMPLES_PER_COHORT,
    maxEvents: 10_000,
  });
  assert.equal(result.status, "blocked");
  assert.match(result.reason, /warehouse collector exceeded (shared deadline|30 minutes)/);
  assert.ok(collectorSends() >= 1_800 && collectorSends() <= 1_832,
    `deadline should stop within one concurrency batch, got ${collectorSends()} sends`);
});

test("owned warehouse probes target exact provider version via Cloudflare-Workers-Version-Overrides", async () => {
  const baselineVersion = "23e487f5-ea8f-4bfb-ae54-608f21434574";
  const candidateVersion = "87a8d418-cd78-4de6-8e13-0ee0082a9ec2";
  const baselineDeployment = {
    ...deployment(REVISION),
    receipt: {
      ...deployment(REVISION).receipt,
      cloudflare_version: { source: "cloudflare-versions-api", id: baselineVersion },
    },
  };
  baselineDeployment.provider_receipt_sha256 = providerDeploymentReceiptSha256(baselineDeployment.receipt);
  const candidateDeployment = {
    ...deployment(CANDIDATE),
    receipt: {
      ...deployment(CANDIDATE).receipt,
      cloudflare_version: { source: "cloudflare-versions-api", id: candidateVersion },
      production_health: { source: "cityscroll-production-health", revision: CANDIDATE },
    },
  };
  candidateDeployment.provider_receipt_sha256 = providerDeploymentReceiptSha256(candidateDeployment.receipt);

  const seen = { baseline: new Set(), candidate: new Set() };
  for (const [arm, dep, versionId] of [
    ["baseline", baselineDeployment, baselineVersion],
    ["candidate", candidateDeployment, candidateVersion],
  ]) {
    const { transport, overrideHeaders } = liveFlaglessCollectorRetentionTransport({
      retainEveryK: 1,
      warehouseAttemptsPerInput: 200,
      versionId,
    });
    const result = await transport.collectWarehouseRun({
      label: arm,
      revision: dep.receipt.production_health.revision,
      deployment: dep,
      workloadId: "version-target-proof",
      cohorts: WAREHOUSE_EXPERIMENT_BASE_ROUTES,
      samplesPerCohort: WAREHOUSE_EXPERIMENT_SAMPLES_PER_COHORT,
      maxEvents: 10_000,
    });
    assert.equal(result.status, "complete", `${arm} collect failed: ${result.reason}`);
    const expected = `cityscroll-worker="${versionId}"`;
    assert.ok(overrideHeaders().length > 0);
    assert.ok(overrideHeaders().every((value) => value === expected), `${arm} probes must all carry ${expected}`);
    for (const value of overrideHeaders()) seen[arm].add(value);
    // Retained samples must bind the targeted script version, not a split percentage.
    for (const cohort of WAREHOUSE_EXPERIMENT_BASE_ROUTES) {
      assert.ok(result.cohorts[cohort].every((sample) => sample.script_version_id === versionId));
    }
  }
  assert.equal(seen.baseline.size, 1);
  assert.equal(seen.candidate.size, 1);
  assert.equal([...seen.baseline][0], `cityscroll-worker="${baselineVersion}"`);
  assert.equal([...seen.candidate][0], `cityscroll-worker="${candidateVersion}"`);
  // Candidate targeting is the Version-Overrides header on the arm deployment id;
  // it does not depend on the staged 5% traffic split.
});

function warehouseIsolateCondition(raw) {
  if (raw === null) {
    return {
      mode: "bounded-production-execution",
      source: "owned-http-probe",
      isolate_observation: {
        present: false,
        raw: null,
        provisional_label: "unknown",
        semantics: "unverified-provider-flag",
      },
    };
  }
  return {
    mode: "bounded-production-execution",
    source: "owned-http-probe",
    isolate_observation: {
      present: true,
      raw,
      provisional_label: "unverified-raw",
      semantics: "unverified-provider-flag",
    },
  };
}

function warehouseSample(revision, meter = 0, rawColdStart = null) {
  return {
    revision,
    native_cpu_ms: 2,
    collector_cpu_ms: 1,
    native_cpu_source: { field: "$workers.cpuTimeMs", unit: "milliseconds", precision: "integer" },
    condition: warehouseIsolateCondition(rawColdStart),
    script_version_id: deployment(revision).receipt.cloudflare_version.id,
    outcome: "ok",
    operations: operations(meter, 0),
    error_count: 0,
  };
}

function liveFlaglessWarehouseTransport() {
  const workloads = WAREHOUSE_EXPERIMENT_BASE_ROUTES.map((cohort) => ({
    cohort,
    probe_cohort: cohort,
    workload_hash: createHash("sha256").update(cohort).digest("hex"),
    body: { kind: "http", route: cohort },
  }));
  const measurement = {
    run_marker: RUN,
    workload_digest: WORKLOAD,
    warehouse_workloads: workloads,
    collector_workload: {
      cohort: "collector-overhead",
      probe_cohort: "collector-overhead",
      workload_hash: createHash("sha256").update("collector-overhead").digest("hex"),
      body: { kind: "collector-overhead" },
    },
  };
  const events = [];
  let requests = 0;
  let activeDeployment = deployment(REVISION);
  const transport = createLiveWorkerCostTransport({
    env: {
      CLOUDFLARE_OBSERVABILITY_TOKEN: "telemetry-only",
      WORKER_COST_ADMIN_KEY: "admin-key",
      CLOUDFLARE_ACCOUNT_ID: "account",
      WORKER_HEALTH_URL: "https://worker.example/health",
      WORKER_API_ORIGIN: "https://worker.example",
      WORKER_COST_MEASUREMENT_PLAN: JSON.stringify(measurement),
    },
    warehouseAttemptsPerInput: 200,
    now: () => Date.parse("2026-10-09T08:00:00Z"),
    fetchImpl: async (url, init) => {
      if (!url.endsWith("/admin/cost-control-probe")) throw new Error(`unexpected fetch ${url}`);
      requests += 1;
      const headers = init.headers;
      const cohort = headers["x-cityscroll-cost-cohort"];
      const isCollector = cohort === "collector-overhead";
      const receipt = {
        schema: "cityscroll.worker_cost_probe.v1",
        tag: headers["x-cityscroll-cost-probe"],
        series: headers["x-cityscroll-cost-series"],
        cohort,
        workload_hash: headers["x-cityscroll-cost-workload"],
        execution_mode: "production-read-only-rehearsal",
        operation_counts: operations(),
        result: {
          status: isCollector ? 204 : 200,
          body_sha256: "6".repeat(64),
          ...(!isCollector ? { correctness: CORRECTNESS } : {}),
        },
      };
      events.push({
        source: receipt,
        // Tail TraceItem: no coldStart field.
        $metadata: { id: `warehouse-flagless-${requests}` },
        $workers: {
          cpuTimeMs: 2,
          outcome: "ok",
          scriptVersion: { id: activeDeployment.receipt.cloudflare_version.id },
          event: { request: { url: OUTER_URL, method: "POST", headers: { "x-cityscroll-cost-probe": receipt.tag } } },
        },
        exceptions: [],
      });
      return Response.json(receipt);
    },
  });
  transport.collectProviderEvents = async ({ execute }) => {
    events.length = 0;
    await execute(new AbortController().signal, { events });
    return [...events];
  };
  transport.acquireSplitDeployments = async () => ({
    baseline: deployment(REVISION),
    candidate: deployment(CANDIDATE),
  });
  let arm = 0;
  const originalCollect = transport.collectWarehouseRun.bind(transport);
  transport.collectWarehouseRun = async (args) => {
    activeDeployment = args.deployment;
    const result = await originalCollect(args);
    if (result.status !== "complete") return result;
    arm += 1;
    return {
      ...result,
      observedAt: arm === 1 ? "2026-10-09T08:00:00Z" : "2026-10-09T09:00:00Z",
      cohorts: Object.fromEntries(Object.entries(result.cohorts).map(([name, samples]) => [
        name,
        samples.map((sample) => (
          arm === 2 ? { ...sample, operations: operations(1, 0) } : sample
        )),
      ])),
    };
  };
  return { transport, requestCount: () => requests };
}

test("matched warehouse acquisition defaults to Tail flag-less cohorts and evaluates end to end", async () => {
  const { transport } = liveFlaglessWarehouseTransport();
  const result = await runMatchedWarehouseExperiment({
    baselineRevision: REVISION,
    candidateRevision: CANDIDATE,
    transport,
  });
  assert.equal(result.status, "complete");
  assert.equal(result.baseline.cold_start_flag_capability.carries_numeric_raw, false);
  assert.equal(result.baseline.cold_start_flag_capability.status, WAREHOUSE_COLD_START_FLAG_CAPABILITIES.ABSENT);
  assert.deepEqual(
    Object.keys(result.baseline.cohorts).sort(),
    [...WAREHOUSE_EXPERIMENT_BASE_ROUTES].sort(),
  );
  assert.equal(
    result.baseline.workload_count,
    WAREHOUSE_EXPERIMENT_BASE_ROUTES.length * WAREHOUSE_EXPERIMENT_SAMPLES_PER_COHORT,
  );
  assert.ok(Object.values(result.baseline.cohorts).every((cohort) => (
    cohort.samples.every((sample) => sample.condition.isolate_observation.present === false
      && sample.condition.isolate_observation.raw === null
      && sample.condition.isolate_observation.provisional_label === "unknown")
  )));
  assert.equal(result.decision.decision, "candidate-rejected");
  assert.deepEqual(result.decision.regressions, ["queue_writes"]);
  assert.equal(result.decision.cold_start_flag_raw.status, "unknown");
});

test("matched warehouse acquisition retains baseline on a queue regression for a documented numeric-raw source", async () => {
  const result = await runMatchedWarehouseExperiment({
    baselineRevision: REVISION,
    candidateRevision: CANDIDATE,
    coldStartFlagCapability: DOCUMENTED_NUMERIC_RAW_WAREHOUSE_COLD_START_FLAG_CAPABILITY,
    transport: {
      acquireSplitDeployments: async () => ({ baseline: deployment(REVISION), candidate: deployment(CANDIDATE) }),
      collectWarehouseRun: async ({ label, revision, cohorts }) => {
        assert.deepEqual([...cohorts].sort(), [...WAREHOUSE_EXPERIMENT_COHORTS].sort());
        return {
          status: "complete",
          observedAt: label === "baseline" ? "2026-10-09T08:00:00Z" : "2026-10-09T09:00:00Z",
          cohorts: Object.fromEntries(WAREHOUSE_EXPERIMENT_COHORTS.map((cohort) => [cohort,
            Array.from({ length: WAREHOUSE_EXPERIMENT_SAMPLES_PER_COHORT }, () => ({
              ...warehouseSample(
                revision,
                label === "candidate" ? 1 : 0,
                parseColdStartFlagRaw(cohort),
              ),
            })),
          ])),
          correctness: CORRECTNESS,
          provider_event_count: 100,
          provider_event_count_status: "known",
        };
      },
    },
  });
  assert.equal(result.status, "complete");
  assert.equal(result.decision.decision, "candidate-rejected");
  assert.deepEqual(result.decision.regressions, ["queue_writes"]);
  assert.equal(result.baseline.cold_start_flag_capability.carries_numeric_raw, true);
});

test("matched warehouse acquisition never defaults carries_numeric_raw to true", async () => {
  const result = await runMatchedWarehouseExperiment({
    baselineRevision: REVISION,
    candidateRevision: CANDIDATE,
    transport: {
      acquireSplitDeployments: async () => ({ baseline: deployment(REVISION), candidate: deployment(CANDIDATE) }),
      collectWarehouseRun: async ({ label, revision, cohorts }) => {
        assert.deepEqual([...cohorts].sort(), [...WAREHOUSE_EXPERIMENT_BASE_ROUTES].sort());
        assert.deepEqual(TAIL_WAREHOUSE_COLD_START_FLAG_CAPABILITY.carries_numeric_raw, false);
        return {
          status: "complete",
          observedAt: label === "baseline" ? "2026-10-09T08:00:00Z" : "2026-10-09T09:00:00Z",
          cohorts: Object.fromEntries(WAREHOUSE_EXPERIMENT_BASE_ROUTES.map((cohort) => [cohort,
            Array.from({ length: WAREHOUSE_EXPERIMENT_SAMPLES_PER_COHORT }, () => warehouseSample(revision)),
          ])),
          correctness: CORRECTNESS,
          provider_event_count: 100,
          provider_event_count_status: "known",
        };
      },
    },
  });
  assert.equal(result.baseline.cold_start_flag_capability.carries_numeric_raw, false);
  assert.equal(result.candidate.cold_start_flag_capability.carries_numeric_raw, false);
  assert.equal(result.decision.cold_start_flag_capability.carries_numeric_raw, false);
});

test("matched warehouse acquisition fails when a flag-less source claims raw partitions", async () => {
  await assert.rejects(
    () => runMatchedWarehouseExperiment({
      baselineRevision: REVISION,
      candidateRevision: CANDIDATE,
      transport: {
        acquireSplitDeployments: async () => ({ baseline: deployment(REVISION), candidate: deployment(CANDIDATE) }),
        collectWarehouseRun: async ({ label, revision }) => ({
          status: "complete",
          observedAt: label === "baseline" ? "2026-10-09T08:00:00Z" : "2026-10-09T09:00:00Z",
          cohorts: Object.fromEntries([
            ...WAREHOUSE_EXPERIMENT_BASE_ROUTES.map((cohort) => [cohort,
              Array.from({ length: WAREHOUSE_EXPERIMENT_SAMPLES_PER_COHORT }, () => warehouseSample(revision)),
            ]),
            [coldStartFlagRawCohort("browse", 1), Array.from(
              { length: WAREHOUSE_EXPERIMENT_SAMPLES_PER_COHORT },
              () => warehouseSample(revision, 0, 1),
            )],
          ]),
          correctness: CORRECTNESS,
          provider_event_count: 100,
          provider_event_count_status: "known",
        }),
      },
    }),
    /fabricated cold_start_flag_raw|flag-less source must not supply/,
  );
});

test("matched warehouse acquisition stamps the same cold_start_flag_capability on both arms", async () => {
  const result = await runMatchedWarehouseExperiment({
    baselineRevision: REVISION,
    candidateRevision: CANDIDATE,
    transport: {
      acquireSplitDeployments: async () => ({ baseline: deployment(REVISION), candidate: deployment(CANDIDATE) }),
      collectWarehouseRun: async ({ label, revision }) => ({
        status: "complete",
        observedAt: label === "baseline" ? "2026-10-09T08:00:00Z" : "2026-10-09T09:00:00Z",
        cohorts: Object.fromEntries(WAREHOUSE_EXPERIMENT_BASE_ROUTES.map((cohort) => [cohort,
          Array.from({ length: WAREHOUSE_EXPERIMENT_SAMPLES_PER_COHORT }, () => warehouseSample(revision)),
        ])),
        correctness: CORRECTNESS,
        provider_event_count: 100,
        provider_event_count_status: "known",
      }),
    },
  });
  assert.deepEqual(
    result.baseline.cold_start_flag_capability,
    result.candidate.cold_start_flag_capability,
  );
  assert.deepEqual(result.baseline.cold_start_flag_capability, TAIL_WAREHOUSE_COLD_START_FLAG_CAPABILITY);
});

test("matched warehouse races signal-ignoring acquire — blocked within elapsed bound, no arms", async () => {
  const calls = [];
  const started = Date.now();
  const maxSeconds = 1;
  const transport = {
    acquireSplitDeployments: async () => {
      calls.push("acquire");
      // Never settles and ignores AbortSignal entirely.
      await new Promise(() => {});
    },
    collectWarehouseRun: async (args) => {
      calls.push(`arm:${args.label}`);
      return {
        status: "complete",
        observedAt: "2026-10-09T08:00:00Z",
        cohorts: Object.fromEntries(WAREHOUSE_EXPERIMENT_BASE_ROUTES.map((cohort) => [cohort,
          Array.from({ length: WAREHOUSE_EXPERIMENT_SAMPLES_PER_COHORT }, () => warehouseSample(
            args.label === "baseline" ? REVISION : CANDIDATE,
          )),
        ])),
        correctness: CORRECTNESS,
        provider_event_count: 10,
        provider_event_count_status: "known",
      };
    },
  };
  const result = await runMatchedWarehouseExperiment({
    baselineRevision: REVISION,
    candidateRevision: CANDIDATE,
    transport,
    maxCollectorSeconds: maxSeconds,
    maxCollectorEvents: MAX_COLLECTOR_EVENTS,
  });
  const elapsedMs = Date.now() - started;
  assert.equal(result.status, "blocked");
  assert.match(result.reason, /during deployment acquisition/);
  assert.deepEqual(calls, ["acquire"]);
  assert.ok(!calls.some((c) => String(c).startsWith("arm:")), "no collectWarehouseRun arm may start");
  assert.ok(elapsedMs < (maxSeconds + 2.5) * 1000, `elapsed ${elapsedMs}ms exceeds ${maxSeconds}s+slack`);
  assert.deepEqual(result.shared_budget?.ledger, []);
});

test("raceAbortable rejects a never-settling promise when the signal aborts", async () => {
  const ac = new AbortController();
  setTimeout(() => ac.abort(), 40).unref?.();
  const started = Date.now();
  await assert.rejects(
    () => raceAbortable(new Promise(() => {}), ac.signal),
    /cancelled|aborted|exhausted/i,
  );
  assert.ok(Date.now() - started < 1500);
});

test("collectWarehouseRun forwards external signal into collectProviderEvents", async () => {
  const ac = new AbortController();
  let seenSignal = null;
  const { transport } = liveFlaglessCollectorRetentionTransport({ warehouseAttemptsPerInput: 200 });
  transport.collectProviderEvents = async ({ signal, from, to, limit }) => {
    seenSignal = signal;
    assert.equal(signal, ac.signal);
    assert.ok(from && to && limit > 0);
    throw new Error("cost workload collection was cancelled");
  };
  const result = await transport.collectWarehouseRun({
    label: "baseline",
    revision: REVISION,
    deployment: deployment(REVISION),
    workloadId: "fixed-warehouse-test",
    cohorts: WAREHOUSE_EXPERIMENT_BASE_ROUTES,
    samplesPerCohort: WAREHOUSE_EXPERIMENT_SAMPLES_PER_COHORT,
    maxEvents: 10_000,
    signal: ac.signal,
  });
  assert.equal(seenSignal, ac.signal);
  assert.equal(result.status, "blocked");
  assert.match(result.reason, /cancelled/);
});
