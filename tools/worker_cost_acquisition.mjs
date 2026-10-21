#!/usr/bin/env node

import { createHash } from "node:crypto";
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
  normalizeWranglerTailEvent,
  parseWranglerTailJsonStream,
  providerEventsFromWranglerTailStream,
  runMatchedWarehouseExperiment,
  selectOwnedHttpEvent,
} from "./lib/worker_cost_acquisition.mjs";

export {
  normalizeWranglerTailEvent,
  parseWranglerTailJsonStream,
  providerEventsFromWranglerTailStream,
};
import {
  TAIL_WAREHOUSE_COLD_START_FLAG_CAPABILITY,
  WAREHOUSE_EXPERIMENT_BASE_ROUTES,
  WAREHOUSE_EXPERIMENT_COHORTS,
  WAREHOUSE_EXPERIMENT_SAMPLES_PER_COHORT,
  baseCohortFromFlagRaw,
  coldStartFlagRawCohort,
  parseColdStartFlagRaw,
  sanitizeNativeInvocation,
} from "./lib/worker_cost_control.mjs";
import {
  DEFAULT_WORKER_ID,
  PROVIDER_OBSERVABILITY_CONCURRENCY,
  armRestorer,
  assertPrivacyArmedFromRawGet,
  assertWindowMutable,
  createBetaWorkerObservabilityTransport,
  createFileWindowStore,
  measurementWindowObservability,
  mutateOwnedWindowObservability,
  normalizeObservability,
  observabilitySha256,
  openSettingsWindow,
  privacyArmedObservability,
  runIndependentRestorer,
  settingsCommandSucceeded,
} from "./lib/worker_observability_settings.mjs";
import {
  DEFAULT_RESTORER_STATE_ROOT,
  assertRestorerReady,
  bindWindowToRestorer,
  restorerPaths,
  startSupervisedRestorerProcess,
  waitForRestorerReady,
} from "./lib/worker_observability_restorer.mjs";
import { existsSync as fsExistsSync } from "node:fs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const WORKER_DIRECTORY = join(ROOT, "worker");
const QUERY_PAGE_LIMIT = 2_000;
const LIVE_TAIL_HEARTBEAT_MS = 15_000;
const WAREHOUSE_BASE_COHORTS = WAREHOUSE_EXPERIMENT_BASE_ROUTES;
const WAREHOUSE_FLAG_CAPABLE_COLLECTOR_SAMPLES = WAREHOUSE_EXPERIMENT_COHORTS.length * WAREHOUSE_EXPERIMENT_SAMPLES_PER_COHORT;
const WAREHOUSE_MAX_ATTEMPTS_PER_INPUT = Math.floor(
  (MAX_COLLECTOR_EVENTS - WAREHOUSE_FLAG_CAPABLE_COLLECTOR_SAMPLES) / WAREHOUSE_BASE_COHORTS.length,
);
const WAREHOUSE_PROBE_CONCURRENCY = 32;

function sameCohortSet(left, right) {
  if (left.length !== right.length) return false;
  const want = new Set(right);
  return left.every((cohort) => want.has(cohort));
}

function warehouseCohortMode(cohorts) {
  if (!Array.isArray(cohorts) || cohorts.length === 0) {
    throw new Error("warehouse cohorts are required");
  }
  const rawCount = cohorts.filter((cohort) => parseColdStartFlagRaw(cohort) !== null).length;
  if (rawCount === cohorts.length) {
    if (!sameCohortSet(cohorts, WAREHOUSE_EXPERIMENT_COHORTS)) {
      throw new Error("flag-capable warehouse cohorts must be the fixed raw 0/1 partition set");
    }
    return "flag-capable";
  }
  if (rawCount === 0) {
    if (!sameCohortSet(cohorts, WAREHOUSE_EXPERIMENT_BASE_ROUTES)) {
      throw new Error("flag-less warehouse cohorts must be the fixed base route set");
    }
    return "flag-less";
  }
  throw new Error("warehouse cohorts cannot mix raw partitions with base routes");
}

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
    const flagRaw1 = byCohort.get(coldStartFlagRawCohort(base, 1));
    const flagRaw0 = byCohort.get(coldStartFlagRawCohort(base, 0));
    if (!flagRaw1 || !flagRaw0 || flagRaw1.workload_hash !== flagRaw0.workload_hash) {
      throw new Error(`${base} cold_start_flag_raw=0 and =1 workloads must be an exact matched input`);
    }
    pairs.set(base, flagRaw1);
  }
  return pairs;
}

function warehouseFlaglessWorkloads(byCohort) {
  const workloads = new Map();
  for (const base of WAREHOUSE_BASE_COHORTS) {
    const workload = byCohort.get(base);
    if (!workload) throw new Error(`${base} warehouse workload is missing`);
    workloads.set(base, workload);
  }
  return workloads;
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
  setIntervalImpl = setInterval,
  clearIntervalImpl = clearInterval,
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
    const probeCohort = workload.probe_cohort || baseCohortFromFlagRaw(workload.cohort);
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
      let closing = false;
      let heartbeatTimer;
      let heartbeatPending;
      const heartbeat = async () => {
        const response = await fetchImpl(`https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}/workers/observability/telemetry/live-tail/heartbeat`, {
          method: "POST",
          headers: { Authorization: `Bearer ${telemetryToken}`, "Content-Type": "application/json" },
          signal: controller.signal,
          body: JSON.stringify({ scriptId: workerName }),
        });
        const payload = await response.json();
        if (!response.ok || payload?.success !== true) throw new Error("authenticated live-tail heartbeat failed");
      };
      const scheduleHeartbeat = () => {
        heartbeatTimer = setIntervalImpl(() => {
          if (heartbeatPending || controller.signal.aborted) return heartbeatPending;
          heartbeatPending = heartbeat()
            .catch((error) => {
              if (!closing && !controller.signal.aborted) {
                failure = error;
                controller.abort();
              }
            })
            .finally(() => { heartbeatPending = undefined; });
          return heartbeatPending;
        }, LIVE_TAIL_HEARTBEAT_MS);
      };
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
        socketListener(socket, "error", () => {
          failure = new Error("live-tail collection failed");
          controller.abort();
        });
        socketListener(socket, "close", () => {
          if (closing) return;
          failure = new Error("live-tail connection closed");
          controller.abort();
        });
        await heartbeat();
        scheduleHeartbeat();
        await execute?.(controller.signal);
        const requestedRemaining = Math.max(0, endsAt - now());
        const settle = execute
          ? Math.min(Number(env.WORKER_COST_LIVE_TAIL_SETTLE_MS || 10_000), MAX_COLLECTOR_SECONDS * 1000)
          : Math.min(requestedRemaining, MAX_COLLECTOR_SECONDS * 1000);
        await sleep(settle, controller.signal);
        if (failure) throw failure;
        return events;
      } catch (error) {
        if (failure) throw failure;
        if (!execute && collectionEnded) return events;
        throw error;
      } finally {
        closing = true;
        clearTimeout(timeout);
        if (heartbeatTimer !== undefined) clearIntervalImpl(heartbeatTimer);
        controller.abort();
        if (heartbeatPending) await heartbeatPending;
        if (socket && typeof socket.close === "function") socket.close();
      }
    },
    warehouseColdStartFlagCapability: TAIL_WAREHOUSE_COLD_START_FLAG_CAPABILITY,
    async collectWarehouseRun({ label, revision, deployment, workloadId, cohorts, samplesPerCohort, maxEvents }) {
      if (samplesPerCohort !== WAREHOUSE_EXPERIMENT_SAMPLES_PER_COHORT || maxEvents !== MAX_COLLECTOR_EVENTS) {
        throw new Error("warehouse acquisition bounds are invalid");
      }
      let mode;
      try { mode = warehouseCohortMode(cohorts); }
      catch (error) { return { status: "blocked", reason: String(error?.message || error) }; }
      const collectorSampleCount = cohorts.length * samplesPerCohort;
      const plan = await measurementPlan();
      const byCohort = new Map((plan.warehouse_workloads || []).map((workload) => [workload.cohort, workload]));
      if (!plan.collector_workload) {
        return { status: "blocked", reason: "fixed warehouse workload plan is incomplete" };
      }
      let workloadsByBase;
      try {
        workloadsByBase = mode === "flag-capable"
          ? warehouseWorkloadPairs(byCohort)
          : warehouseFlaglessWorkloads(byCohort);
      } catch (error) {
        return { status: "blocked", reason: String(error?.message || error) };
      }
      const attempts = Array.from({ length: warehouseAttemptsPerInput }, (_, index) => (
        [...workloadsByBase.entries()].map(([base, workload]) => ({ base, workload, index }))
      )).flat();
      const collectorAttempts = Array.from({ length: collectorSampleCount }, (_, index) => index);
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
        const conditioned = Object.fromEntries(cohorts.map((cohort) => [
          cohort,
          selectConditionedEvents(
            eventIndex,
            expectations.filter((expectation) => expectation.probeCohort === baseCohortFromFlagRaw(cohort)),
            cohort,
            samplesPerCohort,
          ),
        ]));
        if (mode === "flag-capable") {
          for (const base of WAREHOUSE_BASE_COHORTS) {
            const fingerprints = new Set([
              ...conditioned[coldStartFlagRawCohort(base, 1)],
              ...conditioned[coldStartFlagRawCohort(base, 0)],
            ].map(({ expectation }) => correctnessFingerprint(expectation)));
            if (fingerprints.size !== 1 || [...fingerprints][0].startsWith(":")) {
              throw new Error(`${base} cold_start_flag_raw=0 and =1 responses are not matched`);
            }
          }
        } else {
          for (const base of WAREHOUSE_BASE_COHORTS) {
            const fingerprints = new Set(
              conditioned[base].map(({ expectation }) => correctnessFingerprint(expectation)),
            );
            if (fingerprints.size !== 1 || [...fingerprints][0].startsWith(":")) {
              throw new Error(`${base} flag-less responses are not matched`);
            }
          }
        }
        const collectors = collectorExpectations.map((expectation) => ({
          expectation,
          event: selectOwnedHttpEvent(eventIndex.get(expectation.header) || [], expectation, "collector-overhead"),
        }));
        if (collectors.length < collectorSampleCount) throw new Error("collector-overhead provider samples are incomplete");
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

function windowStoreFromPath(path) {
  if (!path) throw new Error("--window-state is required");
  return createFileWindowStore(path);
}

async function writeWindowState(path, window) {
  await windowStoreFromPath(path).write(window);
}

async function readWindowState(path) {
  const window = await windowStoreFromPath(path).read();
  if (!window) throw new Error(`--window-state is missing: ${path}`);
  return window;
}

function settingsTransportFromEnv(env) {
  const accountId = env.CLOUDFLARE_ACCOUNT_ID;
  if (!accountId) throw new Error("CLOUDFLARE_ACCOUNT_ID is required");
  const token = secret(env, "CLOUDFLARE_API_TOKEN");
  return createBetaWorkerObservabilityTransport({
    accountId,
    workerId: env.CLOUDFLARE_WORKER_ID || DEFAULT_WORKER_ID,
    token,
  });
}

export async function runObservabilitySettingsCommand(argv, { env = process.env, transport } = {}) {
  const command = argv[0];
  const settings = transport || settingsTransportFromEnv(env);
  const windowPath = arg(argv, "--window-state");
  const accountId = env.CLOUDFLARE_ACCOUNT_ID || "";
  const accountIdSha256 = createHash("sha256").update(accountId).digest("hex");

  if (command === "observability-get") {
    const observability = normalizeObservability(await settings.getObservability());
    return {
      schema: "cityscroll.worker_observability_effective.v1",
      status: "ok",
      observability,
      observability_sha256: observabilitySha256(observability),
    };
  }

  if (command === "observability-window-open") {
    const baseline = normalizeObservability(await settings.getObservability());
    const durationSeconds = Number(arg(argv, "--duration-seconds") || MAX_COLLECTOR_SECONDS);
    const stateRoot = env.CITYSCROLL_OBSERVABILITY_RESTORER_STATE || DEFAULT_RESTORER_STATE_ROOT;
    let window = openSettingsWindow({
      baseline,
      workerId: env.CLOUDFLARE_WORKER_ID || DEFAULT_WORKER_ID,
      accountIdSha256,
      durationSeconds,
    });
    window = armRestorer(window);
    await writeWindowState(windowPath, window);

    // Ensure durable runner copies exist (install script is authoritative).
    const paths = restorerPaths(stateRoot);
    if (!fsExistsSync(paths.durableRunner)) {
      throw new Error(`durable restorer runner missing at ${paths.durableRunner}; run tools/install_observability_settings_restorer.sh`);
    }
    const started = startSupervisedRestorerProcess({
      windowPath,
      windowId: window.window_id,
      stateRoot,
      env,
    });
    window = bindWindowToRestorer(window, {
      pid: started.pid,
      stateRoot,
      restorerId: window.restorer.restorer_id,
    });
    await writeWindowState(windowPath, window);
    await waitForRestorerReady({ window, stateRoot });
    window = await readWindowState(windowPath);
    return {
      schema: "cityscroll.worker_observability_settings_window.v1",
      status: "captured",
      window_id: window.window_id,
      baseline_sha256: window.baseline_sha256,
      expires_at: window.expires_at,
      restorer_armed: window.restorer?.armed === true,
      restorer_pid: window.restorer?.runtime?.pid || started.pid,
      restorer_state_root: stateRoot,
      concurrency_control: PROVIDER_OBSERVABILITY_CONCURRENCY,
      window_state: windowPath,
    };
  }

  if (command === "observability-privacy-arm") {
    const store = windowStoreFromPath(windowPath);
    let window = await store.read();
    if (!window) throw new Error(`--window-state is missing: ${windowPath}`);
    assertWindowMutable(window);
    if (!window.restorer?.armed) {
      window = armRestorer(window);
      await store.write(window);
    }
    const stateRoot = window.restorer?.runtime?.state_root || env.CITYSCROLL_OBSERVABILITY_RESTORER_STATE || DEFAULT_RESTORER_STATE_ROOT;
    assertRestorerReady(window, { stateRoot });
    const armed = privacyArmedObservability(window.baseline_observability);
    const result = await mutateOwnedWindowObservability({
      transport: settings,
      store,
      expectedSha256: window.owned_sha256 || window.baseline_sha256,
      nextObservability: armed,
      phase: "privacy_armed",
      assertRestorerReady: (current) => assertRestorerReady(current, { stateRoot }),
    });
    if (!result.ok) {
      return {
        schema: "cityscroll.worker_observability_settings_receipt.v1",
        status: "blocked",
        reason: result.reason,
        before_sha256: result.before_sha256,
        expected_sha256: result.expected_sha256 || result.expected_after_sha256 || null,
        after_sha256: result.after_sha256 || null,
        expected_after_sha256: result.expected_after_sha256 || null,
        patch_error: result.patch_error || null,
        after_redacted: result.after_redacted || null,
        expected_after_redacted: result.expected_after_redacted || null,
        provider_exchanges: result.provider_exchanges || null,
        concurrency_control: PROVIDER_OBSERVABILITY_CONCURRENCY,
      };
    }
    const proved = assertPrivacyArmedFromRawGet(await settings.getObservability());
    return {
      schema: "cityscroll.worker_observability_settings_receipt.v1",
      status: "privacy-armed",
      window_id: result.window.window_id,
      after_sha256: result.after_sha256,
      proved_sha256: observabilitySha256(proved),
      observability: proved,
      provider_exchanges: result.provider_exchanges || {
        patch: settings.last_exchange || null,
      },
      concurrency_control: PROVIDER_OBSERVABILITY_CONCURRENCY,
    };
  }

  if (command === "observability-enable") {
    const store = windowStoreFromPath(windowPath);
    const window = await store.read();
    if (!window) throw new Error(`--window-state is missing: ${windowPath}`);
    assertWindowMutable(window);
    if (window.phase !== "privacy_armed") {
      throw new Error("privacy arming must be proved before enabling a measurement window");
    }
    if (!window.restorer?.armed) {
      throw new Error("independent restorer must be armed before enabling a measurement window");
    }
    const stateRoot = window.restorer?.runtime?.state_root || env.CITYSCROLL_OBSERVABILITY_RESTORER_STATE || DEFAULT_RESTORER_STATE_ROOT;
    assertRestorerReady(window, { stateRoot });
    const provedBeforeEnable = assertPrivacyArmedFromRawGet(await settings.getObservability());
    if (observabilitySha256(provedBeforeEnable) !== window.owned_sha256) {
      return {
        schema: "cityscroll.worker_observability_settings_receipt.v1",
        status: "blocked",
        reason: "privacy-settings-changed-before-enable",
        expected_sha256: window.owned_sha256,
        current_sha256: observabilitySha256(provedBeforeEnable),
        concurrency_control: PROVIDER_OBSERVABILITY_CONCURRENCY,
      };
    }
    const enabled = measurementWindowObservability(provedBeforeEnable);
    const result = await mutateOwnedWindowObservability({
      transport: settings,
      store,
      expectedSha256: window.owned_sha256,
      nextObservability: enabled,
      phase: "enabled",
      assertRestorerReady: (current) => assertRestorerReady(current, { stateRoot }),
    });
    if (!result.ok) {
      return {
        schema: "cityscroll.worker_observability_settings_receipt.v1",
        status: "blocked",
        reason: result.reason,
        before_sha256: result.before_sha256,
        expected_sha256: result.expected_sha256 || result.expected_after_sha256 || null,
        after_sha256: result.after_sha256 || null,
        expected_after_sha256: result.expected_after_sha256 || null,
        patch_error: result.patch_error || null,
        after_redacted: result.after_redacted || null,
        expected_after_redacted: result.expected_after_redacted || null,
        provider_exchanges: result.provider_exchanges || null,
        concurrency_control: PROVIDER_OBSERVABILITY_CONCURRENCY,
      };
    }
    return {
      schema: "cityscroll.worker_observability_settings_receipt.v1",
      status: "enabled",
      window_id: result.window.window_id,
      after_sha256: result.after_sha256,
      observability: result.after,
      provider_exchanges: result.provider_exchanges || null,
      concurrency_control: PROVIDER_OBSERVABILITY_CONCURRENCY,
    };
  }

  if (command === "observability-restore") {
    const store = windowStoreFromPath(windowPath);
    let window = await store.read();
    if (!window) throw new Error(`--window-state is missing: ${windowPath}`);
    if (!window.restorer?.armed) {
      window = armRestorer(window);
      await store.write(window);
    }
    const restored = await runIndependentRestorer({ store, transport: settings });
    return {
      schema: "cityscroll.worker_observability_settings_receipt.v1",
      status: restored.proved ? restored.action : "blocked",
      ...restored.receipt,
      proved: restored.proved,
      observability: restored.after,
      concurrency_control: PROVIDER_OBSERVABILITY_CONCURRENCY,
    };
  }

  return null;
}

export async function runWorkerCostAcquisition(argv, { env = process.env, transport } = {}) {
  const command = argv[0];
  const settingsResult = await runObservabilitySettingsCommand(argv, { env, transport: transport?.observability });
  if (settingsResult) return settingsResult;
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
  throw new Error("usage: worker_cost_acquisition.mjs <profile|warehouse|observability-get|observability-window-open|observability-privacy-arm|observability-enable|observability-restore> [options]");
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    const result = await runWorkerCostAcquisition(process.argv.slice(2));
    console.log(JSON.stringify(result, null, 2));
    // Settings statuses (captured/privacy-armed/enabled/restored/ok) exit 0.
    // Profile/warehouse keep requiring status=complete. Blocked/unknown => nonzero.
    if (!settingsCommandSucceeded(result)) process.exitCode = 2;
  } catch (error) {
    console.log(JSON.stringify({
      schema: "cityscroll.worker_cost_acquisition.v1",
      status: "blocked",
      reason: String(error?.message || error),
    }));
    process.exitCode = 2;
  }
}
