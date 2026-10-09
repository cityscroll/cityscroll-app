import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { createNativeCostControlProbeRecord } from "../worker/src/lib/cost_control_probe.mjs";

import {
  REQUIRED_COST_COHORTS,
  buildWorkerCostProfile as buildWorkerCostProfileRaw,
  providerDeploymentReceiptSha256,
  sanitizeNativeInvocation as sanitizeNativeInvocationRaw,
  validateWorkerCostProfile,
} from "./lib/worker_cost_control.mjs";

const revision = "a".repeat(40);
const WORKLOAD_DIGEST = "d".repeat(64);
const RUN_MARKER = "cost-run-2026-10-09";
const BATCH_MARKER = "queue-batch-1";
const PROVIDER_RECEIPT = Object.freeze({
  schema: "cityscroll.cloudflare_deployment_binding.v1",
  evidence_mode: "actual-production",
  observed_at: "2026-10-08T23:29:00Z",
  production_health: { source: "cityscroll-production-health", revision },
  cloudflare_version: { source: "cloudflare-versions-api", id: "provider-version" },
});
const PROVIDER_DEPLOYMENT = Object.freeze({
  source: "cloudflare-deployment-receipt+health",
  receipt: PROVIDER_RECEIPT,
  provider_receipt_sha256: providerDeploymentReceiptSha256(PROVIDER_RECEIPT),
});
const buildWorkerCostProfile = (samples, options) => buildWorkerCostProfileRaw(samples, {
  providerDeployment: structuredClone(PROVIDER_DEPLOYMENT),
  ...options,
});
const sanitizeNativeInvocation = (rawEvent, options) => sanitizeNativeInvocationRaw(rawEvent, {
  providerDeployment: structuredClone(PROVIDER_DEPLOYMENT),
  ...options,
});
const emptyOperations = () => Object.fromEntries([
  "kv_reads", "kv_writes", "d1_rows_read", "d1_rows_written", "storage_bytes",
].map((meter) => [meter, { attempted: 0, confirmed: 0 }]));
function event(cpuTime = 4, coldStart = 1) {
  return {
    cpuTime,
    wallTime: 999,
    outcome: "ok",
    scriptVersion: { id: "provider-version" },
    exceptions: [],
    $metadata: { coldStart },
    event: { request: {
      url: "https://example.invalid/health",
      method: "GET",
      headers: { "x-cityscroll-cost-probe": "owned" },
    } },
  };
}
function nativeEvent(kind, trigger, cpuTime = 4) {
  const requestId = `${kind}-provider-event`;
  const eventDetails = kind === "scheduled"
    ? { cron: trigger, scheduledTime: 1_760_000_000_000 }
    : { queue: trigger, batchSize: 1 };
  const now = Date.parse("2026-10-09T01:05:00Z");
  const source = createNativeCostControlProbeRecord({
    WORKER_COST_NATIVE_PROBE: JSON.stringify({
      schema: "cityscroll.worker_native_cost_probe.v1",
      enabled: true,
      starts_at: "2026-10-09T01:00:00Z",
      expires_at: "2026-10-09T01:10:00Z",
      run_marker_sha256: createHash("sha256").update(RUN_MARKER).digest("hex"),
      workload_digest: WORKLOAD_DIGEST,
      scheduled_crons: ["0 8 * * *", "0 10 * * *", "0 13 * * *"],
      queue: "crol-cost-probe",
      batch_marker_sha256: createHash("sha256").update(BATCH_MARKER).digest("hex"),
      max_queue_batch: 1,
    }),
  }, kind === "scheduled"
    ? { kind, trigger, scheduledTime: 1_760_000_000_000 }
    : { kind, queue: trigger, batchSize: 1 }, now);
  return {
    source,
    $metadata: { requestId, trigger },
    $workers: {
      cpuTimeMs: cpuTime,
      eventType: kind,
      outcome: "ok",
      requestId,
      scriptVersion: { id: "provider-version" },
      event: eventDetails,
    },
    exceptions: [],
  };
}
function sample(cohort, cpu = 4) {
  const isScheduled = cohort.startsWith("cron:");
  const isQueue = cohort === "queue";
  const cron = isScheduled ? cohort.slice("cron:".length) : null;
  const raw = isScheduled
    ? nativeEvent("scheduled", cron, cpu)
    : isQueue
      ? nativeEvent("queue", "crol-cost-probe", cpu)
      : event(cpu, cohort.endsWith(":warm") ? 0 : 1);
  return sanitizeNativeInvocation(raw, {
    cohort,
    revision,
    expectedHeaderValue: "owned",
    expectedUrl: "https://example.invalid/health",
    condition: { mode: "bounded-production-execution" },
    expectedCron: cron,
    expectedScheduledTime: isScheduled ? 1_760_000_000_000 : undefined,
    expectedRunMarker: isScheduled || isQueue ? RUN_MARKER : undefined,
    expectedWorkloadDigest: isScheduled || isQueue ? WORKLOAD_DIGEST : undefined,
    expectedQueue: isQueue ? "crol-cost-probe" : undefined,
    expectedBatchMarker: isQueue ? BATCH_MARKER : undefined,
    expectedBatchSize: isQueue ? 1 : undefined,
    operations: { ...emptyOperations(), kv_writes: { attempted: 1, confirmed: 1 } },
  });
}

test("owned tail events retain provider-native CPU and discard raw request material", () => {
  const retained = sample("health:cold", 0);
  assert.equal(retained.native_cpu_ms, 0);
  assert.equal(retained.native_cpu_source.field, "cpuTime");
  assert.equal("wallTime" in retained, false);
  assert.equal("request" in retained, false);
});

test("one failed invocation is not double-counted when it also has an exception", () => {
  const raw = event();
  raw.outcome = "exception";
  raw.exceptions = [{ name: "Error", message: "bounded" }];
  const retained = sanitizeNativeInvocation(raw, {
    cohort: "health:cold", revision,
    condition: { mode: "provider-observed", source: "$metadata.coldStart", cold_start: true },
    expectedHeaderValue: "owned", expectedUrl: "https://example.invalid/health",
    operations: emptyOperations(),
  });
  assert.equal(retained.error_count, 1);
});

test("provider samples must match the receipt-bound version for the health revision", () => {
  const wrongVersion = event();
  wrongVersion.scriptVersion.id = "older-provider-version";
  assert.throws(() => sanitizeNativeInvocation(wrongVersion, {
    cohort: "health:cold", revision,
    condition: { mode: "provider-observed", source: "$metadata.coldStart", cold_start: true },
    expectedHeaderValue: "owned", expectedUrl: "https://example.invalid/health",
    operations: emptyOperations(),
  }), /script version does not match/);
  const profile = buildWorkerCostProfile(REQUIRED_COST_COHORTS.map((cohort) => sample(cohort)), {
    revision, observedAt: "2026-10-08T23:30:00Z", durationSeconds: 1,
    eventCount: REQUIRED_COST_COHORTS.length,
  });
  profile.provider_deployment.receipt.production_health.revision = "b".repeat(40);
  assert.throws(() => validateWorkerCostProfile(profile), /production health revision does not match/);
});

test("provider deployment digest detects retained receipt mutation", () => {
  const profile = buildWorkerCostProfile(REQUIRED_COST_COHORTS.map((cohort) => sample(cohort)), {
    revision, observedAt: "2026-10-08T23:30:00Z", durationSeconds: 1,
    eventCount: REQUIRED_COST_COHORTS.length,
  });
  profile.provider_deployment.receipt.cloudflare_version.id = "older-provider-version";
  assert.throws(() => validateWorkerCostProfile(profile), /does not match receipt contents/);
});

test("literal header, URL and method ownership are all required before persistence", () => {
  for (const override of [
    { expectedHeaderValue: "other" },
    { expectedUrl: "https://example.invalid/other" },
    { expectedMethod: "POST" },
  ]) assert.throws(() => sanitizeNativeInvocation(event(), {
    cohort: "health:cold", revision,
    condition: { mode: "provider-observed", source: "$metadata.coldStart", cold_start: true },
    expectedHeaderValue: "owned", expectedUrl: "https://example.invalid/health", ...override,
  }));
});

test("native scheduled ownership binds cron, timestamp, run and workload", () => {
  const retained = sample("cron:0 8 * * *", 3);
  assert.equal(retained.condition.mode, "provider-native-scheduled");
  assert.equal(retained.condition.cron, "0 8 * * *");
  assert.equal(retained.condition.scheduled_time, 1_760_000_000_000);
  assert.equal("run_marker" in retained.condition, false);
  for (const mutate of [
    (raw) => { raw.$workers.eventType = "fetch"; },
    (raw) => { raw.$metadata.trigger = "0 10 * * *"; },
    (raw) => { raw.$workers.event.scheduledTime += 1; },
    (raw) => { raw.source.run_marker_sha256 = "e".repeat(64); },
    (raw) => { raw.source.workload_digest = "e".repeat(64); },
    (raw) => { delete raw.$workers.requestId; delete raw.$metadata.requestId; },
    (raw) => { raw.$workers.scriptVersion.id = "older-provider-version"; },
  ]) {
    const raw = nativeEvent("scheduled", "0 8 * * *");
    mutate(raw);
    assert.throws(() => sanitizeNativeInvocation(raw, {
      cohort: "cron:0 8 * * *", revision,
      expectedCron: "0 8 * * *", expectedScheduledTime: 1_760_000_000_000,
      expectedRunMarker: RUN_MARKER, expectedWorkloadDigest: WORKLOAD_DIGEST,
      operations: emptyOperations(),
    }), /provider|ownership|scheduled|workload/);
  }
});

test("native queue ownership rejects HTTP rehearsal and cross-batch evidence", () => {
  const retained = sample("queue", 5);
  assert.equal(retained.condition.mode, "provider-native-queue");
  assert.equal(retained.condition.queue, "crol-cost-probe");
  assert.equal("batch_marker" in retained.condition, false);
  assert.throws(() => sanitizeNativeInvocation(event(), {
    cohort: "queue", revision,
    expectedRunMarker: RUN_MARKER, expectedWorkloadDigest: WORKLOAD_DIGEST,
    expectedQueue: "crol-cost-probe", expectedBatchMarker: BATCH_MARKER,
    expectedBatchSize: 1,
    operations: emptyOperations(),
  }), /native invocation|structured native probe/);
  const wrongBatch = nativeEvent("queue", "crol-cost-probe");
  wrongBatch.source.batch_marker_sha256 = "e".repeat(64);
  assert.throws(() => sanitizeNativeInvocation(wrongBatch, {
    cohort: "queue", revision,
    expectedRunMarker: RUN_MARKER, expectedWorkloadDigest: WORKLOAD_DIGEST,
    expectedQueue: "crol-cost-probe", expectedBatchMarker: BATCH_MARKER,
    expectedBatchSize: 1,
    operations: emptyOperations(),
  }), /batch marker/);
  const wrongTrigger = nativeEvent("queue", "crol-cost-probe");
  wrongTrigger.$metadata.trigger = "other-queue";
  assert.throws(() => sanitizeNativeInvocation(wrongTrigger, {
    cohort: "queue", revision,
    expectedRunMarker: RUN_MARKER, expectedWorkloadDigest: WORKLOAD_DIGEST,
    expectedQueue: "crol-cost-probe", expectedBatchMarker: BATCH_MARKER,
    expectedBatchSize: 1,
    operations: emptyOperations(),
  }), /queue trigger/);
});

test("complete bounded profiles cover routes, three crons, queue and collector overhead", () => {
  const samples = REQUIRED_COST_COHORTS.map((cohort, index) => sample(cohort, index));
  const profile = buildWorkerCostProfile(samples, {
    revision, observedAt: "2026-10-08T23:30:00Z", durationSeconds: 120, eventCount: samples.length,
  });
  assert.equal(profile.complete, true);
  assert.deepEqual(validateWorkerCostProfile(profile), { ok: true, complete: true });
});

test("profiles retain and enforce every sample revision", () => {
  const samples = REQUIRED_COST_COHORTS.map((cohort) => sample(cohort));
  samples[0].revision = "b".repeat(40);
  assert.throws(() => buildWorkerCostProfile(samples, {
    revision, observedAt: "2026-10-08T23:30:00Z", durationSeconds: 120, eventCount: samples.length,
  }), /sample revision/);
  const profile = buildWorkerCostProfile(REQUIRED_COST_COHORTS.map((cohort) => sample(cohort)), {
    revision, observedAt: "2026-10-08T23:30:00Z", durationSeconds: 120, eventCount: samples.length,
  });
  profile.cohorts["health:cold"].revision = "b".repeat(40);
  assert.throws(() => validateWorkerCostProfile(profile), /revision does not match/);
});

test("imported profiles validate every retained sample's source and condition", () => {
  const makeProfile = () => buildWorkerCostProfile(REQUIRED_COST_COHORTS.map((cohort) => sample(cohort)), {
    revision, observedAt: "2026-10-08T23:30:00Z", durationSeconds: 120, eventCount: REQUIRED_COST_COHORTS.length,
  });
  const badSource = makeProfile();
  badSource.cohorts["health:cold"].samples[0].native_cpu_source.field = "wallTime";
  assert.throws(() => validateWorkerCostProfile(badSource), /provider-native invocation CPU/);
  const badCondition = makeProfile();
  badCondition.cohorts["health:cold"].samples[0].condition.cold_start = false;
  assert.throws(() => validateWorkerCostProfile(badCondition), /does not match cohort/);
});

test("imported profile windows fail closed on invalid bounds", () => {
  const profile = buildWorkerCostProfile(REQUIRED_COST_COHORTS.map((cohort) => sample(cohort)), {
    revision, observedAt: "2026-10-08T23:30:00Z", durationSeconds: 120, eventCount: REQUIRED_COST_COHORTS.length,
  });
  for (const [field, value] of [["duration_seconds", undefined], ["duration_seconds", -1], ["event_count", "25"]]) {
    const invalid = structuredClone(profile);
    invalid.window[field] = value;
    assert.throws(() => validateWorkerCostProfile(invalid), /finite non-negative/);
  }
});

test("missing samples stay unknown and cannot masquerade as zero", () => {
  const profile = buildWorkerCostProfile([sample("health:cold", 0)], {
    revision, observedAt: "2026-10-08T23:30:00Z", durationSeconds: 1, eventCount: 1,
  });
  assert.equal(profile.cohorts["health:warm"].status, "unknown");
  assert.equal(profile.cohorts["health:warm"].native_cpu_ms, null);
  assert.throws(() => validateWorkerCostProfile(profile), /unknown/);
});

test("wall time without a native CPU field is rejected", () => {
  const raw = event();
  delete raw.cpuTime;
  assert.throws(() => sanitizeNativeInvocation(raw, {
    cohort: "health:cold", revision,
    condition: { mode: "provider-observed", source: "$metadata.coldStart", cold_start: true },
    expectedHeaderValue: "owned", expectedUrl: "https://example.invalid/health",
  }), /provider-native CPU/);
});

test("cold and warm labels require matching provider coldStart evidence", () => {
  const derived = sanitizeNativeInvocation(event(4, 1), {
    cohort: "health:cold", revision,
    condition: { mode: "caller-invented", source: "$metadata.coldStart", cold_start: false },
    expectedHeaderValue: "owned", expectedUrl: "https://example.invalid/health",
    operations: emptyOperations(),
  });
  assert.deepEqual(derived.condition, {
    mode: "provider-observed", source: "$metadata.coldStart", cold_start: true,
  });
  assert.throws(() => sanitizeNativeInvocation(event(4, 0), {
    cohort: "health:cold", revision,
    expectedHeaderValue: "owned", expectedUrl: "https://example.invalid/health",
  }), /does not match cohort/);
  const missing = event();
  delete missing.$metadata.coldStart;
  assert.throws(() => sanitizeNativeInvocation(missing, {
    cohort: "health:warm", revision,
    expectedHeaderValue: "owned", expectedUrl: "https://example.invalid/health",
  }), /numeric 0 or 1/);
  assert.throws(() => sanitizeNativeInvocation(event(4, true), {
    cohort: "health:cold", revision,
    expectedHeaderValue: "owned", expectedUrl: "https://example.invalid/health",
  }), /numeric 0 or 1/);
});

test("attempted writes cannot be represented as confirmed", () => {
  const bad = sample("health:cold");
  bad.operations = { ...emptyOperations(), kv_writes: { attempted: 0, confirmed: 1 } };
  const samples = REQUIRED_COST_COHORTS.map((cohort) => sample(cohort));
  samples[0] = bad;
  assert.throws(() => buildWorkerCostProfile(samples, {
    revision, observedAt: "2026-10-08T23:30:00Z", durationSeconds: 1, eventCount: samples.length,
  }), /confirmed exceeds attempted/);
});

test("profiles require explicit operation evidence and honest event counts", () => {
  const samples = REQUIRED_COST_COHORTS.map((cohort) => sample(cohort));
  delete samples[0].operations.storage_bytes;
  assert.throws(() => buildWorkerCostProfile(samples, {
    revision, observedAt: "2026-10-08T23:30:00Z", durationSeconds: 1, eventCount: samples.length,
  }), /storage_bytes must separate attempted and confirmed/);
  assert.throws(() => buildWorkerCostProfile(REQUIRED_COST_COHORTS.map((cohort) => sample(cohort)), {
    revision, observedAt: "2026-10-08T23:30:00Z", durationSeconds: 1,
    eventCount: REQUIRED_COST_COHORTS.length - 1,
  }), /less than retained sample count/);
  const profile = buildWorkerCostProfile(REQUIRED_COST_COHORTS.map((cohort) => sample(cohort)), {
    revision, observedAt: "2026-10-08T23:30:00Z", durationSeconds: 1,
    eventCount: REQUIRED_COST_COHORTS.length,
  });
  profile.window.event_count -= 1;
  assert.throws(() => validateWorkerCostProfile(profile), /less than retained sample count/);
});
