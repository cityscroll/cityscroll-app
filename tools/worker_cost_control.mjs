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
import { scanActionsLogForBillAccountLeaks } from "./lib/worker_cost_actions_log_guard.mjs";
import { acquireSplitDeploymentBindings } from "./cloudflare_deployment_binding.mjs";

const WORKER_DIRECTORY = join(dirname(fileURLToPath(import.meta.url)), "..", "worker");
const PRODUCTION_HEALTH_URL = "https://cityscroll-worker.crol-worker.workers.dev/health";
const WORKER_NAME = "cityscroll-worker";

/**
 * Allowlisted CLI error codes and their static messages. Untrusted IO, parse,
 * and evaluator failures must map here so stderr never echoes filenames,
 * JSON snippets, or other caller-controlled text into public Actions logs.
 */
export const CLI_SAFE_ERROR_CODES = Object.freeze({
  input_unreadable: "worker_cost_control: input could not be read",
  input_invalid_json: "worker_cost_control: input is not valid JSON",
  input_required: "worker_cost_control: an input path or env binding is required",
  flags_mutually_exclusive: "worker_cost_control: path and env input flags are mutually exclusive",
  env_required: "worker_cost_control: required environment value is missing",
  profile_check_requires_input: "profile-check requires --input",
  release_requires_acquired: "release-evaluate requires --acquired-split-deployments",
  release_requires_bindings: "release-evaluate requires both acquired split deployment bindings",
  release_revision_mismatch: "candidate evidence revision does not match the release revision",
  warehouse_bindings_caller_supplied: "warehouse deployment bindings are acquired directly and cannot be supplied by callers",
  enforcement_requires_flags: "enforcement-mode requires --value-env and --github-output",
  token_required: "CLOUDFLARE_API_TOKEN is required for authenticated deployment acquisition",
  deployment_acquisition_failed: "authenticated Cloudflare deployment acquisition failed",
  usage: "usage: worker_cost_control.mjs <profile-check|warehouse-evaluate|release-evaluate|enforcement-mode> [options]",
  evaluator_rejected: "worker_cost_control: evaluator rejected the input",
  emission_refused_result: "worker_cost_control emission refused: bill or account identifiers in result",
  emission_refused_error: "worker_cost_control emission refused: bill or account identifiers in error",
  internal: "worker_cost_control: internal error",
});

export function cliSafeError(code) {
  const resolved = Object.hasOwn(CLI_SAFE_ERROR_CODES, code) ? code : "internal";
  const err = new Error(CLI_SAFE_ERROR_CODES[resolved]);
  err.code = resolved;
  err.cliSafe = true;
  return err;
}

function read(path) {
  let text;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    throw cliSafeError("input_unreadable");
  }
  try {
    return JSON.parse(text);
  } catch {
    throw cliSafeError("input_invalid_json");
  }
}

function evidence(argv, env, pathFlag, envFlag) {
  const path = arg(argv, pathFlag);
  const envName = arg(argv, envFlag);
  if (path && envName) throw cliSafeError("flags_mutually_exclusive");
  if (path) return read(path);
  if (envName) {
    const value = env[envName];
    if (!value) throw cliSafeError("env_required");
    try {
      return JSON.parse(value);
    } catch {
      throw cliSafeError("input_invalid_json");
    }
  }
  throw cliSafeError("input_required");
}

function arg(argv, name) {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : null;
}

function invokeAuthenticatedWrangler(args, env) {
  if (!env.CLOUDFLARE_API_TOKEN) throw cliSafeError("token_required");
  try {
    return JSON.parse(execFileSync("npx", ["wrangler@4.126.0", ...args], {
      cwd: WORKER_DIRECTORY,
      env,
      encoding: "utf8",
      maxBuffer: 8 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    }));
  } catch {
    throw cliSafeError("deployment_acquisition_failed");
  }
}

function runEvaluator(fn) {
  try {
    return fn();
  } catch (err) {
    if (err?.cliSafe) throw err;
    throw cliSafeError("evaluator_rejected");
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
    if (!input) throw cliSafeError("profile_check_requires_input");
    const profile = read(input);
    result = runEvaluator(() => validateWorkerCostProfile(profile));
  } else if (command === "warehouse-evaluate") {
    const baseline = evidence(argv, env, "--baseline", "--baseline-env");
    const candidate = evidence(argv, env, "--candidate", "--candidate-env");
    for (const forbidden of [
      "--trusted-baseline-deployment", "--trusted-baseline-deployment-env",
      "--trusted-candidate-deployment", "--trusted-candidate-deployment-env",
    ]) {
      if (argv.includes(forbidden)) throw cliSafeError("warehouse_bindings_caller_supplied");
    }
    const providerStatus = await invokeWrangler(["deployments", "status", "--json"]);
    const providerVersions = await invokeWrangler(["versions", "list", "--json"]);
    const acquiredDeployments = await acquireSplitDeploymentBindings({
      providerStatus,
      providerVersions,
      healthUrl: PRODUCTION_HEALTH_URL,
      workerName: WORKER_NAME,
      baselineRevision: baseline.deployed_revision,
      candidateRevision: candidate.deployed_revision,
      fetchImpl,
    });
    result = runEvaluator(() => evaluateWarehouseExperiment({ baseline, candidate, acquiredDeployments }));
  } else if (command === "release-evaluate") {
    const baseline = evidence(argv, env, "--baseline", "--baseline-env");
    const candidate = evidence(argv, env, "--candidate", "--candidate-env");
    const acquiredPath = arg(argv, "--acquired-split-deployments");
    if (!acquiredPath) throw cliSafeError("release_requires_acquired");
    const acquired = read(acquiredPath);
    if (!acquired?.baseline || !acquired?.candidate) {
      throw cliSafeError("release_requires_bindings");
    }
    const expectedCandidateRevision = arg(argv, "--expected-candidate-revision");
    if (expectedCandidateRevision && candidate.deployed_revision !== expectedCandidateRevision) {
      throw cliSafeError("release_revision_mismatch");
    }
    result = runEvaluator(() => evaluateAllMeterRelease({
      baseline,
      candidate,
      acquiredDeployments: acquired,
    }));
  } else if (command === "enforcement-mode") {
    const valueEnv = arg(argv, "--value-env");
    const output = arg(argv, "--github-output");
    if (!valueEnv || !output) throw cliSafeError("enforcement_requires_flags");
    result = workerCostEnforcementMode(env[valueEnv]);
    appendFileSync(output, `mode=${result.mode}\n`);
  } else {
    throw cliSafeError("usage");
  }
  return result;
}

/**
 * Pure stdout guard shared by the CLI entrypoint and tip tests. Findings stay
 * value-free; refused payloads never become the printed text.
 */
export function guardCliResultPayload(result, { path = "worker_cost_control:stdout" } = {}) {
  const payload = JSON.stringify(result, null, 2);
  const scan = scanActionsLogForBillAccountLeaks(payload, { path });
  if (!scan.ok) {
    return {
      ok: false,
      text: JSON.stringify({
        ok: false,
        error: CLI_SAFE_ERROR_CODES.emission_refused_result,
        code: "emission_refused_result",
        findings: scan.findings,
      }),
      findings: scan.findings,
      stream: "stderr",
    };
  }
  return { ok: true, text: payload, findings: [], stream: "stdout" };
}

/**
 * Map any thrown value to an allowlisted, value-free diagnostic. Never include
 * err.message unless it is already a cliSafe allowlisted code.
 */
export function formatGuardedCliError(err, { path = "worker_cost_control:stderr" } = {}) {
  let code = "internal";
  if (err?.cliSafe && typeof err.code === "string" && Object.hasOwn(CLI_SAFE_ERROR_CODES, err.code)) {
    code = err.code;
  } else if (err && typeof err === "object" && (err.code === "ENOENT" || err.code === "EACCES")) {
    code = "input_unreadable";
  } else if (err instanceof SyntaxError) {
    code = "input_invalid_json";
  } else {
    code = "evaluator_rejected";
  }
  const diagnostic = {
    ok: false,
    error: CLI_SAFE_ERROR_CODES[code],
    code,
  };
  const scan = scanActionsLogForBillAccountLeaks(JSON.stringify(diagnostic), { path });
  if (!scan.ok) {
    return {
      ok: false,
      error: CLI_SAFE_ERROR_CODES.emission_refused_error,
      code: "emission_refused_error",
      findings: scan.findings,
    };
  }
  return diagnostic;
}

/**
 * Emit CLI JSON only after the Actions-log bill/account guard accepts it.
 * On refusal, print a value-free diagnostic (rule/path only) and exit non-zero
 * so public Actions logs never receive the polluted payload.
 */
export function emitGuardedCliResult(result, options) {
  const guarded = guardCliResultPayload(result, options);
  if (!guarded.ok) {
    console.error(guarded.text);
    process.exitCode = 1;
    return;
  }
  console.log(guarded.text);
  if (result?.pass === false) process.exitCode = 1;
}

export function emitGuardedCliError(err, options) {
  console.error(JSON.stringify(formatGuardedCliError(err, options)));
  process.exitCode = 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    const result = await runWorkerCostControl(process.argv.slice(2));
    emitGuardedCliResult(result);
  } catch (err) {
    emitGuardedCliError(err);
  }
}
