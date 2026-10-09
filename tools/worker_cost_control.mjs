#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  evaluateAllMeterRelease,
  evaluateWarehouseExperiment,
  validateWorkerCostProfile,
  workerCostEnforcementMode,
} from "./lib/worker_cost_control.mjs";
import { acquireWarehouseDeploymentBindings } from "./cloudflare_deployment_binding.mjs";

const WORKER_DIRECTORY = join(dirname(fileURLToPath(import.meta.url)), "..", "worker");
const PRODUCTION_HEALTH_URL = "https://cityscroll-worker.crol-worker.workers.dev/health";
const WORKER_NAME = "cityscroll-worker";

function read(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function evidence(argv, env, pathFlag, envFlag) {
  const path = arg(argv, pathFlag);
  const envName = arg(argv, envFlag);
  if (path && envName) throw new Error(`${pathFlag} and ${envFlag} are mutually exclusive`);
  if (path) return read(path);
  if (envName) {
    const value = env[envName];
    if (!value) throw new Error(`${envName} is required`);
    return JSON.parse(value);
  }
  throw new Error(`one of ${pathFlag} or ${envFlag} is required`);
}

function arg(argv, name) {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : null;
}

function invokeAuthenticatedWrangler(args, env) {
  if (!env.CLOUDFLARE_API_TOKEN) throw new Error("CLOUDFLARE_API_TOKEN is required for authenticated deployment acquisition");
  try {
    return JSON.parse(execFileSync("npx", ["wrangler@4.126.0", ...args], {
      cwd: WORKER_DIRECTORY,
      env,
      encoding: "utf8",
      maxBuffer: 8 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    }));
  } catch {
    throw new Error("authenticated Cloudflare deployment acquisition failed");
  }
}

export async function runWorkerCostControl(argv, {
  env = process.env,
  invokeWrangler = (args) => invokeAuthenticatedWrangler(args, env),
  fetchImpl = fetch,
} = {}) {
  const command = argv[0];
  let result;
  if (command === "profile-check") {
    const input = arg(argv, "--input");
    if (!input) throw new Error("profile-check requires --input");
    result = validateWorkerCostProfile(read(input));
  } else if (command === "warehouse-evaluate") {
    const baseline = evidence(argv, env, "--baseline", "--baseline-env");
    const candidate = evidence(argv, env, "--candidate", "--candidate-env");
    for (const forbidden of [
      "--trusted-baseline-deployment", "--trusted-baseline-deployment-env",
      "--trusted-candidate-deployment", "--trusted-candidate-deployment-env",
    ]) {
      if (argv.includes(forbidden)) throw new Error("warehouse deployment bindings are acquired directly and cannot be supplied by callers");
    }
    const providerStatus = await invokeWrangler(["deployments", "status", "--json"]);
    const providerVersions = await invokeWrangler(["versions", "list", "--json"]);
    const trustedDeployments = await acquireWarehouseDeploymentBindings({
      providerStatus,
      providerVersions,
      healthUrl: PRODUCTION_HEALTH_URL,
      workerName: WORKER_NAME,
      baselineRevision: baseline.deployed_revision,
      candidateRevision: candidate.deployed_revision,
      fetchImpl,
    });
    result = evaluateWarehouseExperiment({ baseline, candidate, trustedDeployments });
  } else if (command === "release-evaluate") {
    const baseline = evidence(argv, env, "--baseline", "--baseline-env");
    const candidate = evidence(argv, env, "--candidate", "--candidate-env");
    const trustedBaseline = evidence(argv, env, "--trusted-baseline-deployment", "--trusted-baseline-deployment-env");
    const trustedCandidate = evidence(argv, env, "--trusted-candidate-deployment", "--trusted-candidate-deployment-env");
    const expectedCandidateRevision = arg(argv, "--expected-candidate-revision");
    if (expectedCandidateRevision && candidate.deployed_revision !== expectedCandidateRevision) {
      throw new Error("candidate evidence revision does not match the release revision");
    }
    result = evaluateAllMeterRelease({
      baseline,
      candidate,
      trustedDeployments: { baseline: trustedBaseline, candidate: trustedCandidate },
    });
  } else if (command === "enforcement-mode") {
    const valueEnv = arg(argv, "--value-env");
    const output = arg(argv, "--github-output");
    if (!valueEnv || !output) throw new Error("enforcement-mode requires --value-env and --github-output");
    result = workerCostEnforcementMode(env[valueEnv]);
    appendFileSync(output, `mode=${result.mode}\n`);
  } else {
    throw new Error("usage: worker_cost_control.mjs <profile-check|warehouse-evaluate|release-evaluate|enforcement-mode> [options]");
  }
  return result;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const result = await runWorkerCostControl(process.argv.slice(2));
  console.log(JSON.stringify(result, null, 2));
  if (result?.pass === false) process.exitCode = 1;
}
