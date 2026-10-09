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

const REVISION = "a".repeat(40);
const CANDIDATE = "b".repeat(40);
const RUN = "bounded-owned-run";
const RUN_HASH = createHash("sha256").update(RUN).digest("hex");
const WORKLOAD = "c".repeat(64);
const operations = (queueWrites = 0, analyticsPoints = 0) => Object.fromEntries(OPERATION_METERS.map((meter) => [meter, {
  attempted: meter === "queue_writes" ? queueWrites : meter === "analytics_points" ? analyticsPoints : 0,
  confirmed: meter === "queue_writes" ? queueWrites : meter === "analytics_points" ? analyticsPoints : 0,
}]));

function deployment(revision) {
  const receipt = {
    schema: "cityscroll.cloudflare_deployment_binding.v1", evidence_mode: "actual-production",
    observed_at: "2026-10-09T07:50:00Z",
    production_health: { source: "cityscroll-production-health", revision },
    cloudflare_version: { source: "cloudflare-versions-api", id: `version-${revision.slice(0, 8)}` },
  };
  return { source: "cloudflare-deployment-receipt+health", receipt, provider_receipt_sha256: providerDeploymentReceiptSha256(receipt) };
}

function httpEvent(cohort, revision = REVISION, cpu = 2) {
  const header = `owned-${cohort.replaceAll(/[^a-z0-9]/g, "-")}`;
  return {
    source: { schema: "cityscroll.worker_cost_probe.v1", operation_counts: operations(1, 1) },
    event: { request: { url: `https://example.invalid/${cohort}`, method: "GET", headers: { "x-cityscroll-cost-probe": header } } },
    $metadata: { coldStart: cohort.endsWith(":cold") ? 1 : 0 },
    $workers: { cpuTimeMs: cpu, outcome: "ok", scriptVersion: { id: deployment(revision).receipt.cloudflare_version.id } },
    exceptions: [],
  };
}

function scheduledEvent(cron, time, revision = REVISION) {
  return {
    source: {
      schema: "cityscroll.worker_native_cost_probe.v1", kind: "scheduled",
      run_marker_sha256: RUN_HASH, workload_digest: WORKLOAD, instrumentation_log_count: 1,
      operations: operations(1, 1), trigger: cron, scheduled_time: time,
    },
    $metadata: { requestId: `scheduled-${cron}`, trigger: cron },
    $workers: {
      cpuTimeMs: 3, outcome: "ok", eventType: "scheduled", requestId: `scheduled-${cron}`,
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
      schema: "cityscroll.worker_native_cost_probe.v1", kind: "queue",
      run_marker_sha256: RUN_HASH, workload_digest: WORKLOAD, instrumentation_log_count: 1,
      operations: operations(1, 1), queue: "digest-queue", batch_size: 1,
      batch_fingerprint_sha256: fingerprint,
    },
    $metadata: { requestId: "queue-request", trigger: "digest-queue" },
    $workers: {
      cpuTimeMs: 4, outcome: "ok", eventType: "queue", requestId: "queue-request",
      scriptVersion: { id: deployment(revision).receipt.cloudflare_version.id },
      event: { queue: "digest-queue", batchSize: 1, messages },
    },
    exceptions: [],
  };
}

function plan() {
  const scheduled_times = {
    "0 8 * * *": Date.parse("2026-10-09T08:00:00Z"),
    "0 10 * * *": Date.parse("2026-10-09T10:00:00Z"),
    "0 13 * * *": Date.parse("2026-10-09T13:00:00Z"),
  };
  return { run_marker: RUN, workload_digest: WORKLOAD, queue: "digest-queue", scheduled_times, correctness: {} };
}

async function profileTransport({ corruptQueue = false } = {}) {
  const configuration = plan();
  const events = REQUIRED_COST_COHORTS.filter((cohort) => !cohort.startsWith("cron:") && cohort !== "queue").map((cohort) => httpEvent(cohort));
  for (const [cron, time] of Object.entries(configuration.scheduled_times)) events.push(scheduledEvent(cron, time));
  const queued = await queueEvent();
  if (corruptQueue) queued.source.batch_fingerprint_sha256 = "f".repeat(64);
  events.push(queued);
  return {
    acquireDeployment: async () => deployment(REVISION),
    measurementPlan: async () => configuration,
    executeFixedHttpWorkloads: async () => Object.fromEntries(
      REQUIRED_COST_COHORTS.filter((cohort) => !cohort.startsWith("cron:") && cohort !== "queue").map((cohort) => [cohort, {
        header: `owned-${cohort.replaceAll(/[^a-z0-9]/g, "-")}`, url: `https://example.invalid/${cohort}`, method: "GET",
      }]),
    ),
    collectProviderEvents: async () => events,
  };
}

test("profile acquisition recomputes provider queue ownership and retains every meter", async () => {
  const result = await acquireWorkerCostProfile({
    revision: REVISION, window: { from: "2026-10-09T07:55:00Z", to: "2026-10-09T08:25:00Z" },
    transport: await profileTransport(),
  });
  assert.equal(result.status, "complete");
  assert.equal(result.profile.cohorts.queue.samples[0].operations.queue_writes.confirmed, 1);
  assert.equal(result.profile.cohorts.queue.samples[0].operations.analytics_points.confirmed, 1);
  const rawQueue = (await (await profileTransport()).collectProviderEvents()).find((event) => event.$workers?.eventType === "queue");
  assert.equal(await queueFingerprintFromProviderEvent(rawQueue), rawQueue.source.batch_fingerprint_sha256);
});

test("unbound queue evidence remains partial instead of becoming zero", async () => {
  const result = await acquireWorkerCostProfile({
    revision: REVISION, window: { from: "2026-10-09T07:55:00Z", to: "2026-10-09T08:25:00Z" },
    transport: await profileTransport({ corruptQueue: true }),
  });
  assert.equal(result.status, "partial");
  assert.equal(result.profile.cohorts.queue.status, "unknown");
  assert.match(result.reasons.find((entry) => entry.cohort === "queue").reason, /fingerprint/);
});

function warehouseSample(revision, meter = 0) {
  return {
    revision, native_cpu_ms: 2, collector_cpu_ms: 1,
    native_cpu_source: { field: "$workers.cpuTimeMs", unit: "milliseconds", precision: "integer" },
    condition: { mode: "provider-observed", source: "$metadata.coldStart", cold_start: false },
    script_version_id: deployment(revision).receipt.cloudflare_version.id,
    outcome: "ok", operations: operations(meter, 0), error_count: 0,
  };
}

test("matched warehouse acquisition retains baseline on a queue regression", async () => {
  const result = await runMatchedWarehouseExperiment({
    baselineRevision: REVISION, candidateRevision: CANDIDATE,
    transport: {
      acquireSplitDeployments: async () => ({ baseline: deployment(REVISION), candidate: deployment(CANDIDATE) }),
      collectWarehouseRun: async ({ label, revision }) => ({
        status: "complete", observedAt: label === "baseline" ? "2026-10-09T08:00:00Z" : "2026-10-09T09:00:00Z",
        cohorts: Object.fromEntries(WAREHOUSE_EXPERIMENT_COHORTS.map((cohort) => [cohort,
          Array.from({ length: WAREHOUSE_EXPERIMENT_SAMPLES_PER_COHORT }, () => ({
            ...warehouseSample(revision, label === "candidate" ? 1 : 0),
            condition: { mode: "provider-observed", source: "$metadata.coldStart", cold_start: cohort.endsWith(":cold") },
          })),
        ])),
        correctness: { input_digest: "i", joins_digest: "j", provenance_digest: "p", miss_digest: "m", freshness_digest: "f" },
      }),
    },
  });
  assert.equal(result.status, "complete");
  assert.equal(result.decision.decision, "candidate-rejected");
  assert.deepEqual(result.decision.regressions, ["queue_writes"]);
});
