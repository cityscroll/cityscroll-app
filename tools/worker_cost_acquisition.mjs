#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { acquireDeploymentBinding, acquireSplitDeploymentBindings } from "./cloudflare_deployment_binding.mjs";
import {
  MAX_COLLECTOR_EVENTS,
  MAX_COLLECTOR_SECONDS,
  acquireWorkerCostProfile,
  aggregateObservedCorrectness,
  httpOperationsFromProviderEvent,
  runMatchedWarehouseExperiment,
  selectOwnedHttpEvent,
} from "./lib/worker_cost_acquisition.mjs";
import {
  WAREHOUSE_EXPERIMENT_COHORTS,
  WAREHOUSE_EXPERIMENT_SAMPLES_PER_COHORT,
  sanitizeNativeInvocation,
} from "./lib/worker_cost_control.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const WORKER_DIRECTORY = join(ROOT, "worker");
const QUERY_PAGE_LIMIT = 2_000;
const WAREHOUSE_BASE_COHORTS = Object.freeze([...new Set(WAREHOUSE_EXPERIMENT_COHORTS.map((cohort) => cohort.replace(/:(?:cold|warm)$/, "")))]);
const WAREHOUSE_COLLECTOR_SAMPLES = WAREHOUSE_EXPERIMENT_COHORTS.length * WAREHOUSE_EXPERIMENT_SAMPLES_PER_COHORT;
const WAREHOUSE_MAX_ATTEMPTS_PER_INPUT = Math.floor((MAX_COLLECTOR_EVENTS - WAREHOUSE_COLLECTOR_SAMPLES) / WAREHOUSE_BASE_COHORTS.length);
const WAREHOUSE_PROBE_CONCURRENCY = 32;

function arg(argv, name) {
  const index = argv.indexOf(name);
  return index < 0 ? null : argv[index + 1];
}

function secret(env, name) {
  if (env[name] && env[`${name}_FILE`]) throw new Error(`${name} and ${name}_FILE are mutually exclusive`);
  if (env[name]) return env[name];
  const path = env[`${name}_FILE`];
  if (!path) throw new Error(`${name} or ${name}_FILE is required`);
  if ((statSync(path).mode & 0o077) !== 0) throw new Error(`${name}_FILE must be mode 0600`);
  return readFileSync(path, "utf8").trim();
}

function defaultWrangler(args, env) {
  return JSON.parse(execFileSync("npx", ["wrangler@4.126.0", ...args], {
    cwd: WORKER_DIRECTORY,
    env,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 8 * 1024 * 1024,
  }));
}

function eventIdentifier(event) {
  return event?.$metadata?.id || event?.id || null;
}

function timestamp(value) {
  const parsed = typeof value === "number" ? value : Date.parse(value);
  if (!Number.isFinite(parsed)) throw new Error("provider event timeframe is invalid");
  return parsed;
}

export function providerEventsFromEnvelope(payload) {
  const invocationGroups = payload?.result?.invocations ?? payload?.invocations;
  if (invocationGroups && typeof invocationGroups === "object" && !Array.isArray(invocationGroups)) {
    return Object.values(invocationGroups).map((records) => mergeInvocationRecords(Array.isArray(records) ? records : [records]));
  }
  const candidates = [
    payload?.result?.events?.events,
    payload?.events?.events,
    payload?.events,
    payload?.data,
  ];
  for (const candidate of candidates) {
    const entries = Array.isArray(candidate)
      ? candidate
      : candidate && typeof candidate === "object"
        ? Object.values(candidate).flat()
        : null;
    if (!entries) continue;
    return entries.map((entry) => Array.isArray(entry?.events) ? mergeInvocationRecords(entry.events) : entry);
  }
  if (payload?.$workers || payload?.event || payload?.logs || payload?.source) return [payload];
  return [];
}

function mergeInvocationRecords(records) {
  if (records.length === 1) return records[0];
  const merged = { logs: [], exceptions: [] };
  for (const record of records) {
    for (const [key, value] of Object.entries(record || {})) {
      if (!["$metadata", "$workers", "event", "logs", "Logs", "source", "exceptions"].includes(key) && value !== undefined) {
        merged[key] = value;
      }
    }
    merged.$metadata = { ...merged.$metadata, ...record?.$metadata };
    merged.event = { ...merged.event, ...record?.event };
    merged.$workers = { ...merged.$workers, ...record?.$workers };
    if (record?.$workers?.event) {
      merged.$workers.event = { ...merged.$workers.event, ...record.$workers.event };
    }
    if (record?.source !== undefined) merged.logs.push({ message: record.source });
    merged.logs.push(...(record?.logs || record?.Logs || []));
    merged.exceptions.push(...(record?.exceptions || []));
  }
  return merged;
}

export async function queryProviderEvents({
  accountId,
  token,
  workerName,
  from,
  to,
  limit = MAX_COLLECTOR_EVENTS,
  fetchImpl = fetch,
  signal,
} = {}) {
  const boundedLimit = Math.min(MAX_COLLECTOR_EVENTS, Math.max(0, Number(limit) || 0));
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), MAX_COLLECTOR_SECONDS * 1000);
  signal?.addEventListener("abort", () => controller.abort(), { once: true });
  const deadline = Date.now() + MAX_COLLECTOR_SECONDS * 1000;
  const events = [];
  let offset;
  try {
    while (events.length < boundedLimit) {
      if (controller.signal.aborted || Date.now() >= deadline) throw new Error("provider event query exceeded 30 minutes");
      const pageLimit = Math.min(QUERY_PAGE_LIMIT, boundedLimit - events.length);
      const response = await fetchImpl(`https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}/workers/observability/telemetry/query`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        signal: controller.signal,
        body: JSON.stringify({
          queryId: "cityscroll-worker-cost-acquisition",
          timeframe: { from: timestamp(from), to: timestamp(to) },
          view: "events",
          limit: pageLimit,
          ...(offset ? { offset, offsetDirection: "next" } : {}),
          parameters: {
            datasets: ["cloudflare-workers"],
            filterCombination: "and",
            filters: [{ key: "$metadata.service", operation: "eq", type: "string", value: workerName }],
          },
        }),
      });
      if (!response.ok) throw new Error("authenticated provider event acquisition failed");
      const page = providerEventsFromEnvelope(await response.json());
      events.push(...page.slice(0, boundedLimit - events.length));
      if (page.length < pageLimit) break;
      const next = eventIdentifier(page.at(-1));
      if (!next || next === offset) throw new Error("provider event pagination cursor is unavailable");
      offset = next;
    }
    return events;
  } finally {
    clearTimeout(timeout);
  }
}

function socketListener(socket, type, handler) {
  if (typeof socket.addEventListener === "function") socket.addEventListener(type, handler);
  else if (typeof socket.on === "function") socket.on(type, handler);
  else socket[`on${type}`] = handler;
}

function socketText(message) {
  const value = message?.data ?? message;
  if (typeof value === "string") return value;
  if (value instanceof ArrayBuffer) return new TextDecoder().decode(value);
  if (ArrayBuffer.isView(value)) return new TextDecoder().decode(value);
  return null;
}

function wait(milliseconds, signal) {
  if (milliseconds <= 0) return Promise.resolve();
  if (signal?.aborted) return Promise.reject(new Error("provider event collection was cancelled"));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, milliseconds);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(new Error("provider event collection was cancelled"));
    }, { once: true });
  });
}

export function secureWebSocketUrl(value) {
  let url;
  try { url = new URL(value); }
  catch { throw new Error("live-tail response is incomplete"); }
  if (url.username || url.password || !["https:", "wss:"].includes(url.protocol)) {
    throw new Error("live-tail URL must be secure and contain no user information");
  }
  if (url.protocol === "https:") url.protocol = "wss:";
  return url.href;
}

async function openLiveTail({ accountId, token, workerName, fetchImpl, webSocketFactory, signal }) {
  const response = await fetchImpl(`https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}/workers/observability/telemetry/live-tail`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    signal,
    body: JSON.stringify({
      scriptId: workerName,
      filterCombination: "and",
      filters: [{ key: "$metadata.service", operation: "eq", type: "string", value: workerName }],
    }),
  });
  if (!response.ok) throw new Error("authenticated live-tail creation failed");
  const wsUrl = secureWebSocketUrl((await response.json())?.result?.wsUrl);
  const socket = webSocketFactory(wsUrl);
  await new Promise((resolve, reject) => {
    socketListener(socket, "open", resolve);
    socketListener(socket, "error", () => reject(new Error("live-tail connection failed")));
    signal?.addEventListener("abort", () => reject(new Error("live-tail connection was cancelled")), { once: true });
  });
  return socket;
}

function receiptExpectation({ receipt, header, outerUrl, providerVersionId, series }) {
  if (receipt?.schema !== "cityscroll.worker_cost_probe.v1") throw new Error("owned HTTP workload receipt is invalid");
  if (receipt.tag !== header || receipt.series !== series) throw new Error("owned HTTP workload receipt ownership is invalid");
  if (!receipt.result || (receipt.cohort !== "collector-overhead" && !receipt.result.correctness)) {
    throw new Error("owned HTTP workload correctness is unavailable");
  }
  return {
    header,
    series,
    probeCohort: receipt.cohort,
    workloadHash: receipt.workload_hash,
    outerUrl,
    providerVersionId,
    receipt,
  };
}

async function mapConcurrent(items, concurrency, signal, operation) {
  const results = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (next < items.length) {
      if (signal?.aborted) throw new Error("cost workload collection was cancelled");
      const index = next;
      next += 1;
      results[index] = await operation(items[index], index, signal);
    }
  });
  await Promise.all(workers);
  return results;
}

function warehouseWorkloadPairs(byCohort) {
  const pairs = new Map();
  for (const base of WAREHOUSE_BASE_COHORTS) {
    const cold = byCohort.get(`${base}:cold`);
    const warm = byCohort.get(`${base}:warm`);
    if (!cold || !warm || cold.workload_hash !== warm.workload_hash) {
      throw new Error(`${base} cold and warm workloads must be an exact matched input`);
    }
    pairs.set(base, cold);
  }
  return pairs;
}

function providerEventsByProbeHeader(events) {
  const indexed = new Map();
  for (const event of events) {
    const request = event?.event?.request || event?.$workers?.event?.request || event?.request;
    const header = request?.headers?.["x-cityscroll-cost-probe"] || request?.headers?.["X-Cityscroll-Cost-Probe"];
    if (!header) continue;
    indexed.set(header, [...(indexed.get(header) || []), event]);
  }
  return indexed;
}

function selectConditionedEvents(eventIndex, expectations, cohort, count) {
  const selected = [];
  for (const expectation of expectations) {
    try {
      selected.push({ expectation, event: selectOwnedHttpEvent(eventIndex.get(expectation.header) || [], expectation, cohort) });
    } catch {}
    if (selected.length === count) break;
  }
  if (selected.length !== count) throw new Error(`${cohort} provider samples are incomplete`);
  return selected;
}

function correctnessFingerprint(expectation) {
  const correctness = expectation?.receipt?.result?.correctness;
  return ["input_digest", "joins_digest", "provenance_digest", "miss_digest", "freshness_digest"]
    .map((field) => correctness?.[field] || "")
    .join(":");
}

export function createLiveWorkerCostTransport({
  env = process.env,
  fetchImpl = fetch,
  webSocketFactory = (url) => new WebSocket(url),
  invokeWrangler = defaultWrangler,
  now = () => Date.now(),
  sleep = wait,
  warehouseAttemptsPerInput = WAREHOUSE_MAX_ATTEMPTS_PER_INPUT,
} = {}) {
  const telemetryToken = secret(env, "CLOUDFLARE_OBSERVABILITY_TOKEN");
  const adminKey = secret(env, "WORKER_COST_ADMIN_KEY");
  const accountId = env.CLOUDFLARE_ACCOUNT_ID;
  const healthUrl = env.WORKER_HEALTH_URL;
  const workerName = env.WORKER_NAME || "cityscroll-worker";
  const apiOrigin = env.WORKER_API_ORIGIN;
  if (!accountId || !healthUrl || !apiOrigin) {
    throw new Error("CLOUDFLARE_ACCOUNT_ID, WORKER_HEALTH_URL and WORKER_API_ORIGIN are required");
  }
  const deploymentEnv = { ...env };
  delete deploymentEnv.CLOUDFLARE_API_TOKEN;
  delete deploymentEnv.CLOUDFLARE_API_TOKEN_FILE;
  delete deploymentEnv.CLOUDFLARE_OBSERVABILITY_TOKEN;
  delete deploymentEnv.CLOUDFLARE_OBSERVABILITY_TOKEN_FILE;
  const providerState = () => ({
    providerStatus: invokeWrangler(["deployments", "status", "--json"], deploymentEnv),
    providerVersions: invokeWrangler(["versions", "list", "--json"], deploymentEnv),
  });
  const measurementPlan = async () => {
    const raw = env.WORKER_COST_MEASUREMENT_PLAN;
    if (!raw) throw new Error("WORKER_COST_MEASUREMENT_PLAN is required");
    const plan = JSON.parse(raw);
    if (!plan.run_marker || !/^[a-f0-9]{64}$/.test(String(plan.workload_digest || ""))) {
      throw new Error("measurement plan ownership is invalid");
    }
    return plan;
  };
  if (!Number.isInteger(warehouseAttemptsPerInput)
    || warehouseAttemptsPerInput < WAREHOUSE_EXPERIMENT_SAMPLES_PER_COHORT * 2
    || warehouseAttemptsPerInput > WAREHOUSE_MAX_ATTEMPTS_PER_INPUT) {
    throw new Error("warehouse attempt bound is invalid");
  }
  const executeWorkload = async (workload, series, deployment, header = workload.header, signal) => {
    if (signal?.aborted) throw new Error("cost workload collection was cancelled");
    const probeCohort = workload.probe_cohort || workload.cohort.replace(/:(?:cold|warm)$/, "");
    const providerVersionId = deployment?.receipt?.cloudflare_version?.id;
    if (!providerVersionId) throw new Error("exact provider version is unavailable");
    const outerUrl = `${apiOrigin}/admin/cost-control-probe`;
    const response = await fetchImpl(outerUrl, {
      method: "POST",
      redirect: "error",
      signal,
      headers: {
        Authorization: `Bearer ${adminKey}`,
        "Content-Type": "application/json",
        "Cloudflare-Workers-Version-Overrides": `${workerName}="${providerVersionId}"`,
        "x-cityscroll-cost-probe": header,
        "x-cityscroll-cost-cohort": probeCohort,
        "x-cityscroll-cost-workload": workload.workload_hash,
        "x-cityscroll-cost-series": series,
      },
      body: JSON.stringify(workload.body),
    });
    if (signal?.aborted) throw new Error("cost workload collection was cancelled");
    if (!response.ok) throw new Error(`owned HTTP workload ${workload.cohort} failed`);
    const receipt = await response.json();
    if (receipt.cohort !== probeCohort || receipt.workload_hash !== workload.workload_hash) {
      throw new Error("owned HTTP workload receipt does not match the requested child workload");
    }
    return receiptExpectation({ receipt, header, outerUrl, providerVersionId, series });
  };

  return {
    measurementPlan,
    async acquireDeployment(revision) {
      return acquireDeploymentBinding({ ...providerState(), healthUrl, workerName, expectedRevision: revision, fetchImpl });
    },
    async acquireSplitDeployments({ baselineRevision, candidateRevision }) {
      return acquireSplitDeploymentBindings({
        ...providerState(), healthUrl, workerName, baselineRevision, candidateRevision, fetchImpl,
      });
    },
    async executeFixedHttpWorkloads({ plan, deployment, signal }) {
      const expectations = {};
      for (const workload of plan.http_workloads || []) {
        if (signal?.aborted) throw new Error("cost workload collection was cancelled");
        expectations[workload.cohort] = await executeWorkload(workload, plan.series, deployment, workload.header, signal);
      }
      return expectations;
    },
    async collectProviderEvents({ from, to, limit, execute, signal }) {
      const startsAt = timestamp(from);
      const endsAt = timestamp(to);
      if (endsAt <= startsAt) throw new Error("provider event window is invalid");
      if (now() < startsAt) await sleep(startsAt - now(), signal);
      if (signal?.aborted) throw new Error("provider event collection was cancelled");
      if (now() >= endsAt) return [];
      const controller = new AbortController();
      const collectionMilliseconds = Math.min(MAX_COLLECTOR_SECONDS * 1000, endsAt - now());
      let collectionEnded = false;
      const timeout = setTimeout(() => {
        collectionEnded = true;
        controller.abort();
      }, collectionMilliseconds);
      signal?.addEventListener("abort", () => controller.abort(), { once: true });
      const events = [];
      let socket;
      let failure;
      try {
        socket = await openLiveTail({
          accountId, token: telemetryToken, workerName, fetchImpl, webSocketFactory, signal: controller.signal,
        });
        socketListener(socket, "message", (message) => {
          if (events.length >= Math.min(limit, MAX_COLLECTOR_EVENTS)) return;
          const text = socketText(message);
          if (text == null) return;
          try {
            const decoded = JSON.parse(text);
            events.push(...providerEventsFromEnvelope(decoded).slice(0, Math.min(limit, MAX_COLLECTOR_EVENTS) - events.length));
          } catch {
            failure = new Error("live-tail emitted an invalid event envelope");
          }
        });
        socketListener(socket, "error", () => { failure = new Error("live-tail collection failed"); });
        await execute?.(controller.signal);
        const requestedRemaining = Math.max(0, endsAt - now());
        const settle = execute
          ? Math.min(Number(env.WORKER_COST_LIVE_TAIL_SETTLE_MS || 10_000), MAX_COLLECTOR_SECONDS * 1000)
          : Math.min(requestedRemaining, MAX_COLLECTOR_SECONDS * 1000);
        await sleep(settle, controller.signal);
        if (failure) throw failure;
        return events;
      } catch (error) {
        if (!execute && collectionEnded) return events;
        throw error;
      } finally {
        clearTimeout(timeout);
        if (socket && typeof socket.close === "function") socket.close();
      }
    },
    async collectWarehouseRun({ label, revision, deployment, workloadId, cohorts, samplesPerCohort, maxEvents }) {
      if (samplesPerCohort !== WAREHOUSE_EXPERIMENT_SAMPLES_PER_COHORT || maxEvents !== MAX_COLLECTOR_EVENTS) {
        throw new Error("warehouse acquisition bounds are invalid");
      }
      const plan = await measurementPlan();
      const byCohort = new Map((plan.warehouse_workloads || []).map((workload) => [workload.cohort, workload]));
      if (cohorts.some((cohort) => !byCohort.has(cohort)) || !plan.collector_workload) {
        return { status: "blocked", reason: "fixed warehouse workload plan is incomplete" };
      }
      let pairs;
      try { pairs = warehouseWorkloadPairs(byCohort); }
      catch (error) { return { status: "blocked", reason: String(error?.message || error) }; }
      const attempts = Array.from({ length: warehouseAttemptsPerInput }, (_, index) => (
        [...pairs.entries()].map(([base, workload]) => ({ base, workload, index }))
      )).flat();
      const collectorAttempts = Array.from({ length: WAREHOUSE_COLLECTOR_SAMPLES }, (_, index) => index);
      let expectations = [];
      let collectorExpectations = [];
      const started = now();
      let events;
      try {
        events = await this.collectProviderEvents({
          from: new Date(started).toISOString(),
          to: new Date(started + MAX_COLLECTOR_SECONDS * 1000).toISOString(),
          limit: maxEvents,
          execute: async (signal) => {
            expectations = await mapConcurrent(attempts, WAREHOUSE_PROBE_CONCURRENCY, signal, ({ base, workload, index }) => (
              executeWorkload(workload, workloadId, deployment, `cost-${label}-${base}-${index}`, signal)
            ));
            collectorExpectations = await mapConcurrent(collectorAttempts, WAREHOUSE_PROBE_CONCURRENCY, signal, (index) => (
              executeWorkload(plan.collector_workload, workloadId, deployment, `cost-${label}-collector-${index}`, signal)
            ));
          },
        });
      } catch (error) {
        return { status: "blocked", reason: String(error?.message || error) };
      }
      if (now() - started > MAX_COLLECTOR_SECONDS * 1000) {
        return { status: "blocked", reason: "warehouse collector exceeded 30 minutes" };
      }
      if (!Array.isArray(events) || events.length > maxEvents) {
        return { status: "blocked", reason: "warehouse provider event collection exceeded its bound" };
      }
      const retained = {};
      let collectorIndex = 0;
      const retainedCorrectness = {};
      try {
        const eventIndex = providerEventsByProbeHeader(events);
        const conditioned = Object.fromEntries(WAREHOUSE_EXPERIMENT_COHORTS.map((cohort) => [
          cohort,
          selectConditionedEvents(
            eventIndex,
            expectations.filter((expectation) => expectation.probeCohort === cohort.replace(/:(?:cold|warm)$/, "")),
            cohort,
            samplesPerCohort,
          ),
        ]));
        for (const base of WAREHOUSE_BASE_COHORTS) {
          const fingerprints = new Set([
            ...conditioned[`${base}:cold`],
            ...conditioned[`${base}:warm`],
          ].map(({ expectation }) => correctnessFingerprint(expectation)));
          if (fingerprints.size !== 1 || [...fingerprints][0].startsWith(":")) {
            throw new Error(`${base} cold and warm responses are not matched`);
          }
        }
        const collectors = collectorExpectations.map((expectation) => ({
          expectation,
          event: selectOwnedHttpEvent(eventIndex.get(expectation.header) || [], expectation, "collector-overhead"),
        }));
        if (collectors.length < WAREHOUSE_COLLECTOR_SAMPLES) throw new Error("collector-overhead provider samples are incomplete");
        for (const cohort of cohorts) {
          retained[cohort] = conditioned[cohort].map(({ expectation, event }, index) => {
            const collector = collectors[collectorIndex++].event;
            const sample = sanitizeNativeInvocation(event, {
              cohort,
              revision,
              providerDeployment: deployment,
              expectedHeaderValue: expectation.header,
              expectedUrl: expectation.outerUrl,
              expectedMethod: "POST",
              operations: httpOperationsFromProviderEvent(event, expectation),
            });
            const collectorCpu = collector?.$workers?.cpuTimeMs;
            if (!Number.isFinite(collectorCpu) || collectorCpu < 0) throw new Error("collector CPU evidence is unavailable");
            retainedCorrectness[`${cohort}:${index}`] = expectation;
            return { ...sample, collector_cpu_ms: collectorCpu };
          });
        }
      } catch (error) {
        return { status: "blocked", reason: String(error?.message || error) };
      }
      return {
        status: "complete",
        observedAt: new Date(now()).toISOString(),
        cohorts: retained,
        correctness: aggregateObservedCorrectness(retainedCorrectness),
      };
    },
  };
}

export async function runWorkerCostAcquisition(argv, { env = process.env, transport } = {}) {
  const command = argv[0];
  const live = transport || createLiveWorkerCostTransport({ env });
  if (command === "profile") {
    const configuredWindows = env.WORKER_COST_COLLECTION_WINDOWS;
    return acquireWorkerCostProfile({
      revision: arg(argv, "--revision"),
      window: configuredWindows
        ? { windows: JSON.parse(configuredWindows) }
        : { from: arg(argv, "--from"), to: arg(argv, "--to") },
      transport: live,
    });
  }
  if (command === "warehouse") {
    return runMatchedWarehouseExperiment({
      baselineRevision: arg(argv, "--baseline-revision"),
      candidateRevision: arg(argv, "--candidate-revision"),
      transport: live,
    });
  }
  throw new Error("usage: worker_cost_acquisition.mjs <profile|warehouse> [options]");
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    const result = await runWorkerCostAcquisition(process.argv.slice(2));
    console.log(JSON.stringify(result, null, 2));
    if (result.status !== "complete") process.exitCode = 2;
  } catch (error) {
    console.log(JSON.stringify({
      schema: "cityscroll.worker_cost_acquisition.v1",
      status: "blocked",
      reason: String(error?.message || error),
    }));
    process.exitCode = 2;
  }
}
