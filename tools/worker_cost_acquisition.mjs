#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { acquireDeploymentBinding, acquireSplitDeploymentBindings } from "./cloudflare_deployment_binding.mjs";
import {
  acquireWorkerCostProfile,
  httpOperationsFromProviderEvent,
  runMatchedWarehouseExperiment,
} from "./lib/worker_cost_acquisition.mjs";
import { sanitizeNativeInvocation, WAREHOUSE_EXPERIMENT_COHORTS, WAREHOUSE_EXPERIMENT_SAMPLES_PER_COHORT } from "./lib/worker_cost_control.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const WORKER_DIRECTORY = join(ROOT, "worker");

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

function wrangler(args, env) {
  return JSON.parse(execFileSync("npx", ["wrangler@4.126.0", ...args], {
    cwd: WORKER_DIRECTORY, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 8 * 1024 * 1024,
  }));
}

export function createLiveWorkerCostTransport({ env = process.env, fetchImpl = fetch } = {}) {
  const token = secret(env, "CLOUDFLARE_API_TOKEN");
  const adminKey = secret(env, "WORKER_COST_ADMIN_KEY");
  const accountId = env.CLOUDFLARE_ACCOUNT_ID;
  const healthUrl = env.WORKER_HEALTH_URL;
  const workerName = env.WORKER_NAME || "cityscroll-worker";
  const apiOrigin = env.WORKER_API_ORIGIN;
  if (!accountId || !healthUrl || !apiOrigin) throw new Error("CLOUDFLARE_ACCOUNT_ID, WORKER_HEALTH_URL and WORKER_API_ORIGIN are required");
  const authEnv = { ...env, CLOUDFLARE_API_TOKEN: token };
  const providerState = () => ({
    providerStatus: wrangler(["deployments", "status", "--json"], authEnv),
    providerVersions: wrangler(["versions", "list", "--json"], authEnv),
  });
  const measurementPlan = async () => {
    const raw = env.WORKER_COST_MEASUREMENT_PLAN;
    if (!raw) throw new Error("WORKER_COST_MEASUREMENT_PLAN is required");
    const plan = JSON.parse(raw);
    if (!plan.run_marker || !/^[a-f0-9]{64}$/.test(String(plan.workload_digest || ""))) throw new Error("measurement plan ownership is invalid");
    return plan;
  };
  const queryEvents = async ({ from, to, limit }) => {
    const response = await fetchImpl(`https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}/workers/observability/telemetry/query`, {
      method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ queryId: "cityscroll-worker-cost-acquisition", timeframe: { from, to }, view: "events", limit, datasets: ["cloudflare-workers"], filters: [{ key: "$metadata.service", operation: "eq", type: "string", value: workerName }] }),
    });
    if (!response.ok) throw new Error("authenticated provider event acquisition failed");
    const payload = await response.json();
    const events = payload?.result?.events || payload?.result?.invocations;
    if (!Array.isArray(events)) throw new Error("provider event response is incomplete");
    return events;
  };
  const executeWorkload = async (workload, series) => {
    const probeCohort = workload.probe_cohort || workload.cohort.replace(/:(?:cold|warm)$/, "");
    const response = await fetchImpl(`${apiOrigin}/admin/cost-control-probe`, {
      method: "POST", redirect: "error",
      headers: { Authorization: `Bearer ${adminKey}`, "Content-Type": "application/json", "x-cityscroll-cost-probe": workload.header, "x-cityscroll-cost-cohort": probeCohort, "x-cityscroll-cost-workload": workload.workload_hash, "x-cityscroll-cost-series": series },
      body: JSON.stringify(workload.body),
    });
    if (!response.ok) throw new Error(`owned HTTP workload ${workload.cohort} failed`);
  };
  return {
    measurementPlan,
    async acquireDeployment(revision) {
      const state = providerState();
      return acquireDeploymentBinding({ ...state, healthUrl, workerName, expectedRevision: revision, fetchImpl });
    },
    async acquireSplitDeployments({ baselineRevision, candidateRevision }) {
      const state = providerState();
      return acquireSplitDeploymentBindings({ ...state, healthUrl, workerName, baselineRevision, candidateRevision, fetchImpl });
    },
    async executeFixedHttpWorkloads({ plan }) {
      const expectations = {};
      for (const workload of plan.http_workloads || []) {
        await executeWorkload(workload, plan.series);
        expectations[workload.cohort] = { header: workload.header, url: workload.url, method: workload.method };
      }
      return expectations;
    },
    collectProviderEvents: queryEvents,
    async collectWarehouseRun({ revision, deployment, workloadId, cohorts, samplesPerCohort, maxEvents }) {
      if (samplesPerCohort !== WAREHOUSE_EXPERIMENT_SAMPLES_PER_COHORT || maxEvents !== 10_000) {
        throw new Error("warehouse acquisition bounds are invalid");
      }
      const plan = await measurementPlan();
      const byCohort = new Map((plan.warehouse_workloads || []).map((workload) => [workload.cohort, workload]));
      if (cohorts.some((cohort) => !byCohort.has(cohort))) {
        return { status: "blocked", reason: "fixed warehouse workload plan is incomplete" };
      }
      const started = Date.now();
      for (const cohort of cohorts) {
        const workload = byCohort.get(cohort);
        for (let index = 0; index < samplesPerCohort; index += 1) await executeWorkload(workload, workloadId);
      }
      if (!plan.collector_workload) return { status: "blocked", reason: "collector-overhead workload is unavailable" };
      for (let index = 0; index < cohorts.length * samplesPerCohort; index += 1) {
        await executeWorkload(plan.collector_workload, workloadId);
      }
      const ended = Date.now();
      if (ended - started > 30 * 60 * 1000) return { status: "blocked", reason: "warehouse collector exceeded 30 minutes" };
      const events = await queryEvents({ from: started, to: ended + 60_000, limit: maxEvents });
      const retained = {};
      const collectorEvents = events.filter((event) => {
        const request = event?.event?.request || event?.request;
        return request?.headers?.["x-cityscroll-cost-cohort"] === "collector-overhead";
      });
      let collectorIndex = 0;
      for (const cohort of WAREHOUSE_EXPERIMENT_COHORTS) {
        const workload = byCohort.get(cohort);
        const cold = cohort.endsWith(":cold") ? 1 : 0;
        const matches = events.filter((event) => {
          const request = event?.event?.request || event?.request;
          return event?.$metadata?.coldStart === cold
            && (request?.headers?.["x-cityscroll-cost-probe"] || request?.headers?.["X-Cityscroll-Cost-Probe"]) === workload.header
            && request?.url === workload.url && request?.method === workload.method;
        }).slice(0, samplesPerCohort);
        if (matches.length !== samplesPerCohort || collectorEvents.length < collectorIndex + samplesPerCohort) {
          return { status: "blocked", reason: `${cohort} provider samples are incomplete` };
        }
        retained[cohort] = matches.map((event) => {
          const collector = collectorEvents[collectorIndex++];
          const sample = sanitizeNativeInvocation(event, {
            cohort, revision, providerDeployment: deployment,
            expectedHeaderValue: workload.header, expectedUrl: workload.url, expectedMethod: workload.method,
            operations: httpOperationsFromProviderEvent(event),
          });
          const collectorCpu = collector?.cpuTime ?? collector?.$workers?.cpuTimeMs;
          if (!Number.isFinite(collectorCpu) || collectorCpu < 0) throw new Error("collector CPU evidence is unavailable");
          return { ...sample, collector_cpu_ms: collectorCpu };
        });
      }
      return { status: "complete", observedAt: new Date(ended).toISOString(), cohorts: retained, correctness: plan.correctness };
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
    console.log(JSON.stringify({ schema: "cityscroll.worker_cost_acquisition.v1", status: "blocked", reason: String(error?.message || error) }));
    process.exitCode = 2;
  }
}
