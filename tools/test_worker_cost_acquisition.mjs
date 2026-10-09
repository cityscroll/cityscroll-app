import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { queueBatchFingerprint } from "../worker/src/lib/cost_control_probe.mjs";
import {
  acquireWorkerCostProfile,
  queueFingerprintFromProviderEvent,
  runMatchedWarehouseExperiment,
} from "./lib/worker_cost_acquisition.mjs";
import {
  OPERATION_METERS,
  REQUIRED_COST_COHORTS,
  WAREHOUSE_EXPERIMENT_COHORTS,
  WAREHOUSE_EXPERIMENT_SAMPLES_PER_COHORT,
  providerDeploymentReceiptSha256,
} from "./lib/worker_cost_control.mjs";
import {
  createLiveWorkerCostTransport,
  providerEventsFromEnvelope,
  queryProviderEvents,
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
  const probeCohort = cohort.replace(/:(?:cold|warm)$/, "");
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
      ...(coldStart === undefined ? { coldStart: cohort.endsWith(":cold") ? 1 : 0 } : { coldStart }),
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
        coldStart: missingColdStart && cohort === "health:cold" ? undefined : cohort.endsWith(":cold") ? 1 : 0,
        extraRecord: index === 0,
      }));
      if (missingColdStart) {
        const coldHealth = events.find((event) => event.event.request.headers["x-cityscroll-cost-probe"].startsWith("owned-health-"));
        delete coldHealth.$metadata.coldStart;
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

test("missing provider cold-start metadata remains partial", async () => {
  const result = await acquireWorkerCostProfile({
    revision: REVISION,
    window: { from: "2026-10-09T07:55:00Z", to: "2026-10-09T08:25:00Z" },
    transport: await profileTransport({ missingColdStart: true }),
  });
  assert.equal(result.status, "partial");
  assert.equal(result.profile.cohorts["health:cold"].status, "unknown");
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
  }
}

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
        const receipt = expectation("health:cold").receipt;
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
    http_workloads: [{ cohort: "health:cold", probe_cohort: "health", header: expectation("health:cold").header, workload_hash: WORKLOAD, body: { kind: "http", route: "health" } }],
  };
  let expected;
  const events = await transport.collectProviderEvents({
    from: "2026-10-09T08:00:00Z",
    to: "2026-10-09T08:30:00Z",
    limit: 10_000,
    execute: async () => {
      expected = (await transport.executeFixedHttpWorkloads({ plan: planValue, deployment: acquired }))["health:cold"];
      socket.emit("message", { data: JSON.stringify({ events: [{ events: [httpEvent(expected, "health:cold")] }] }) });
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

function warehouseSample(revision, meter = 0) {
  return {
    revision,
    native_cpu_ms: 2,
    collector_cpu_ms: 1,
    native_cpu_source: { field: "$workers.cpuTimeMs", unit: "milliseconds", precision: "integer" },
    condition: { mode: "provider-observed", source: "$metadata.coldStart", cold_start: false },
    script_version_id: deployment(revision).receipt.cloudflare_version.id,
    outcome: "ok",
    operations: operations(meter, 0),
    error_count: 0,
  };
}

test("matched warehouse acquisition retains baseline on a queue regression", async () => {
  const result = await runMatchedWarehouseExperiment({
    baselineRevision: REVISION,
    candidateRevision: CANDIDATE,
    transport: {
      acquireSplitDeployments: async () => ({ baseline: deployment(REVISION), candidate: deployment(CANDIDATE) }),
      collectWarehouseRun: async ({ label, revision }) => ({
        status: "complete",
        observedAt: label === "baseline" ? "2026-10-09T08:00:00Z" : "2026-10-09T09:00:00Z",
        cohorts: Object.fromEntries(WAREHOUSE_EXPERIMENT_COHORTS.map((cohort) => [cohort,
          Array.from({ length: WAREHOUSE_EXPERIMENT_SAMPLES_PER_COHORT }, () => ({
            ...warehouseSample(revision, label === "candidate" ? 1 : 0),
            condition: { mode: "provider-observed", source: "$metadata.coldStart", cold_start: cohort.endsWith(":cold") },
          })),
        ])),
        correctness: CORRECTNESS,
      }),
    },
  });
  assert.equal(result.status, "complete");
  assert.equal(result.decision.decision, "candidate-rejected");
  assert.deepEqual(result.decision.regressions, ["queue_writes"]);
});
