import { createHash } from "node:crypto";

import { queueBatchFingerprint } from "../../worker/src/lib/cost_control_probe.mjs";
import {
  COST_METERS,
  OPERATION_METERS,
  REQUIRED_COST_COHORTS,
  WAREHOUSE_EXPERIMENT_COHORTS,
  WAREHOUSE_EXPERIMENT_SAMPLES_PER_COHORT,
  buildWorkerCostProfile,
  evaluateWarehouseExperiment,
  sanitizeNativeInvocation,
} from "./worker_cost_control.mjs";

export const MAX_COLLECTOR_SECONDS = 30 * 60;
export const MAX_COLLECTOR_EVENTS = 10_000;

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function applicationRecords(event, schema) {
  const found = [];
  const visit = (value) => {
    if (Array.isArray(value)) return value.forEach(visit);
    if (value && typeof value === "object") {
      if (value.schema === schema) found.push(value);
      return;
    }
    if (typeof value === "string") {
      try { visit(JSON.parse(value)); } catch {}
    }
  };
  visit(event?.source);
  for (const log of event?.logs || event?.Logs || []) visit(log?.message ?? log?.Message);
  return found;
}

function matchingHttpReceipts(event, expectation) {
  const records = applicationRecords(event, "cityscroll.worker_cost_probe.v1");
  return records.filter((record) => (
    record.tag === expectation.header
    && record.series === expectation.series
    && record.cohort === expectation.probeCohort
    && record.workload_hash === expectation.workloadHash
    && record.result?.status === expectation.receipt.result?.status
    && record.result?.body_sha256 === expectation.receipt.result?.body_sha256
    && canonicalJson(record.result?.correctness) === canonicalJson(expectation.receipt.result?.correctness)
  ));
}

export function httpReceiptFromProviderEvent(event, expectation) {
  const records = matchingHttpReceipts(event, expectation);
  if (records.length !== 1) throw new Error("exactly one owned structured HTTP cost receipt is required");
  return records[0];
}

export function httpOperationsFromProviderEvent(event, expectation) {
  const operations = httpReceiptFromProviderEvent(event, expectation).operation_counts;
  if (!operations || Object.keys(operations).length !== OPERATION_METERS.length) {
    throw new Error("HTTP cost receipt does not contain the complete operation vector");
  }
  for (const meter of OPERATION_METERS) {
    const value = operations[meter];
    if (!value || !Number.isInteger(value.attempted) || !Number.isInteger(value.confirmed)) {
      throw new Error(`HTTP cost receipt is missing ${meter}`);
    }
  }
  return operations;
}

export async function queueFingerprintFromProviderEvent(event) {
  if (event?.$workers?.eventType !== "queue") throw new Error("provider batch evidence is not a queue invocation");
  const details = event.$workers.event;
  if (!details || !Array.isArray(details.messages) || details.messages.length !== details.batchSize) {
    throw new Error("authenticated provider batch evidence is unavailable");
  }
  const fingerprint = await queueBatchFingerprint({ queue: details.queue, messages: details.messages });
  if (!fingerprint) throw new Error("authenticated provider batch evidence is invalid");
  return fingerprint;
}

function boundedWindows(window) {
  const requested = Array.isArray(window?.windows) ? window.windows : [window];
  if (!requested.length || requested.length > 8) throw new Error("collector windows are invalid");
  const windows = requested.map((entry) => {
    const from = Date.parse(entry?.from);
    const to = Date.parse(entry?.to);
    if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) throw new Error("collector window is invalid");
    if (to - from > MAX_COLLECTOR_SECONDS * 1000) throw new Error("collector window exceeds 30 minutes");
    return { from, to };
  }).sort((left, right) => left.from - right.from);
  if (windows.at(-1).to - windows[0].from > 24 * 60 * 60 * 1000) throw new Error("collector windows exceed 24 hours");
  return windows;
}

function requireTransport(transport, methods) {
  for (const method of methods) {
    if (typeof transport?.[method] !== "function") throw new Error(`live provider transport is missing ${method}`);
  }
}

function httpRequest(event) {
  return event?.event?.request || event?.$workers?.event?.request || event?.request;
}

export function selectOwnedHttpEvent(events, expectation, cohort) {
  const coldStart = cohort.endsWith(":cold") ? 1 : cohort.endsWith(":warm") ? 0 : null;
  const matches = events.filter((event) => {
    const request = httpRequest(event);
    const header = request?.headers?.["x-cityscroll-cost-probe"] || request?.headers?.["X-Cityscroll-Cost-Probe"];
    if (
      header !== expectation.header
      || request?.url !== expectation.outerUrl
      || request?.method !== "POST"
      || event?.$workers?.scriptVersion?.id !== expectation.providerVersionId
      || (coldStart !== null && event?.$metadata?.coldStart !== coldStart)
    ) return false;
    try { return Boolean(httpReceiptFromProviderEvent(event, expectation)); }
    catch { return false; }
  });
  if (matches.length !== 1) throw new Error(`${cohort} requires exactly one owned provider event`);
  return matches[0];
}

export async function acquireWorkerCostProfile({ revision, window, transport } = {}) {
  if (!/^[a-f0-9]{40}$/.test(String(revision || ""))) throw new Error("revision must be a full commit SHA");
  requireTransport(transport, ["acquireDeployment", "executeFixedHttpWorkloads", "collectProviderEvents", "measurementPlan"]);
  const windows = boundedWindows(window);
  const bounds = { from: windows[0].from, to: windows.at(-1).to };
  const deployment = await transport.acquireDeployment(revision);
  const plan = await transport.measurementPlan({ revision, window: bounds });
  let httpExpectations = {};
  const baseLimit = Math.floor(MAX_COLLECTOR_EVENTS / windows.length);
  const collections = await Promise.all(windows.map((entry, index) => transport.collectProviderEvents({
    revision,
    from: entry.from,
    to: entry.to,
    limit: baseLimit + (index < MAX_COLLECTOR_EVENTS % windows.length ? 1 : 0),
    execute: index === 0 ? async (signal) => {
      httpExpectations = await transport.executeFixedHttpWorkloads({ revision, window: bounds, plan, deployment, signal });
    } : undefined,
  })));
  if (collections.some((events) => !Array.isArray(events))) throw new Error("provider event collection is unavailable");
  if (collections.some((events) => events.length > MAX_COLLECTOR_EVENTS)) throw new Error("provider collector run exceeds 10000 events");
  const events = collections.flat();
  if (events.length > MAX_COLLECTOR_EVENTS) throw new Error("provider event collection exceeds 10000 events");
  const samples = [];
  const reasons = [];
  for (const cohort of REQUIRED_COST_COHORTS) {
    try {
      if (cohort.startsWith("cron:")) {
        const cron = cohort.slice(5);
        const expectedTime = plan.scheduled_times?.[cron];
        const event = events.find((item) => item?.$workers?.eventType === "scheduled" && item?.$workers?.event?.cron === cron);
        if (!event) throw new Error("provider scheduled event is unavailable");
        samples.push(sanitizeNativeInvocation(event, {
          cohort, revision, providerDeployment: deployment, expectedCron: cron,
          expectedScheduledTime: expectedTime, expectedRunMarker: plan.run_marker,
          expectedWorkloadDigest: plan.workload_digest,
        }));
      } else if (cohort === "queue") {
        const event = events.find((item) => item?.$workers?.eventType === "queue" && item?.$workers?.event?.queue === plan.queue);
        if (!event) throw new Error("provider queue event is unavailable");
        const fingerprint = await queueFingerprintFromProviderEvent(event);
        samples.push(sanitizeNativeInvocation(event, {
          cohort, revision, providerDeployment: deployment, expectedQueue: plan.queue,
          expectedBatchSize: event.$workers.event.batchSize, expectedBatchFingerprint: fingerprint,
          expectedRunMarker: plan.run_marker, expectedWorkloadDigest: plan.workload_digest,
        }));
      } else {
        const expectation = httpExpectations?.[cohort];
        if (!expectation) throw new Error("owned HTTP workload was not executed");
        const event = selectOwnedHttpEvent(events, expectation, cohort);
        samples.push(sanitizeNativeInvocation(event, {
          cohort, revision, providerDeployment: deployment,
          expectedHeaderValue: expectation.header, expectedUrl: expectation.outerUrl,
          expectedMethod: "POST", operations: httpOperationsFromProviderEvent(event, expectation),
          condition: { mode: "bounded-production-execution" },
        }));
      }
    } catch (error) {
      reasons.push({ cohort, reason: String(error?.message || error) });
    }
  }
  const profile = buildWorkerCostProfile(samples, {
    revision, observedAt: new Date(bounds.to).toISOString(),
    durationSeconds: (bounds.to - bounds.from) / 1000, eventCount: events.length,
    providerDeployment: deployment, correctness: aggregateObservedCorrectness(httpExpectations),
  });
  return {
    schema: "cityscroll.worker_cost_acquisition.v1",
    status: profile.complete ? "complete" : "partial",
    reasons,
    profile,
  };
}

export function aggregateObservedCorrectness(expectations) {
  const entries = Object.entries(expectations || {})
    .filter(([, expectation]) => expectation?.receipt?.result?.correctness)
    .sort(([left], [right]) => left.localeCompare(right));
  if (!entries.length) return {};
  const result = {};
  for (const field of ["input_digest", "joins_digest", "provenance_digest", "miss_digest", "freshness_digest"]) {
    const values = entries.map(([cohort, expectation]) => {
      const value = expectation?.receipt?.result?.correctness?.[field];
      if (!/^[a-f0-9]{64}$/.test(String(value || ""))) throw new Error(`${cohort} is missing observed ${field}`);
      return [cohort, value];
    });
    result[field] = sha256(canonicalJson(values));
  }
  return result;
}

function warehouseRun({ revision, deployment, observedAt, workloadId, cohorts, correctness }) {
  const meters = Object.fromEntries(COST_METERS.map((meter) => [meter, 0]));
  let errorCount = 0;
  let workloadCount = 0;
  for (const cohort of WAREHOUSE_EXPERIMENT_COHORTS) {
    const samples = cohorts[cohort];
    if (!Array.isArray(samples) || samples.length !== WAREHOUSE_EXPERIMENT_SAMPLES_PER_COHORT) {
      throw new Error(`${cohort} does not contain the fixed sample population`);
    }
    for (const sample of samples) {
      workloadCount += 1;
      meters.native_cpu_ms += sample.native_cpu_ms;
      meters.collector_cpu_ms += sample.collector_cpu_ms;
      for (const meter of OPERATION_METERS) meters[meter] += sample.operations[meter].confirmed;
      errorCount += sample.error_count;
    }
  }
  return {
    schema: "cityscroll.warehouse_cost_experiment_run.v1", evidence_mode: "actual-production",
    deployed_revision: revision, observed_at: observedAt, workload_id: workloadId,
    workload_count: workloadCount, provider_deployment: deployment,
    cohorts: Object.fromEntries(Object.entries(cohorts).map(([name, samples]) => [name, { sample_count: samples.length, samples }])),
    meters, error_count: errorCount, correctness,
  };
}

export async function runMatchedWarehouseExperiment({ baselineRevision, candidateRevision, transport } = {}) {
  requireTransport(transport, ["acquireSplitDeployments", "collectWarehouseRun"]);
  const deployments = await transport.acquireSplitDeployments({ baselineRevision, candidateRevision });
  const workloadId = `fixed-warehouse-${sha256(WAREHOUSE_EXPERIMENT_COHORTS.join("\n"))}`;
  const acquired = {};
  for (const [label, revision] of Object.entries({ baseline: baselineRevision, candidate: candidateRevision })) {
    const result = await transport.collectWarehouseRun({
      label, revision, deployment: deployments[label], workloadId,
      cohorts: WAREHOUSE_EXPERIMENT_COHORTS, samplesPerCohort: WAREHOUSE_EXPERIMENT_SAMPLES_PER_COHORT,
      maxEvents: MAX_COLLECTOR_EVENTS,
    });
    if (!result || result.status !== "complete") {
      return { schema: "cityscroll.warehouse_cost_acquisition.v1", status: "blocked", reason: result?.reason || `${label} evidence unavailable` };
    }
    acquired[label] = warehouseRun({ revision, deployment: deployments[label], workloadId, ...result });
  }
  return {
    schema: "cityscroll.warehouse_cost_acquisition.v1", status: "complete",
    baseline: acquired.baseline, candidate: acquired.candidate,
    decision: evaluateWarehouseExperiment({ baseline: acquired.baseline, candidate: acquired.candidate, acquiredDeployments: deployments }),
  };
}
