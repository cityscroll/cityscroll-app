#!/usr/bin/env node
/**
 * Durable supervised observability-settings restorer.
 * Installed under ~/.local/state/cityscroll-cost-control/observability-restorer/
 * so it survives controller death and disposal of the source checkout.
 */
import { readFileSync, existsSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  createFileWindowStore,
  createBetaWorkerObservabilityTransport,
  createDualViewObservabilityTransport,
  createScriptSettingsObservabilityTransport,
  windowRequiresExactLayerTransport,
} from "./lib/worker_observability_settings.mjs";
import {
  DEFAULT_POLL_MS,
  DEFAULT_RESTORER_STATE_ROOT,
  readJsonIfPresent,
  restorerPaths,
  runRestorerLoop,
} from "./lib/worker_observability_restorer.mjs";

export const DUAL_VIEW_TRANSPORT_MODE = "dual-view-script-settings+beta";

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

function createCredentialedBetaTransport(env) {
  return createBetaWorkerObservabilityTransport({
    accountId: env.CLOUDFLARE_ACCOUNT_ID,
    workerId: env.CLOUDFLARE_WORKER_ID || "cityscroll-worker",
    token: secret(env, "CLOUDFLARE_API_TOKEN"),
  });
}

function createCredentialedDualViewTransport(env) {
  const accountId = env.CLOUDFLARE_ACCOUNT_ID;
  const workerId = env.CLOUDFLARE_WORKER_ID || "cityscroll-worker";
  const token = secret(env, "CLOUDFLARE_API_TOKEN");
  return createDualViewObservabilityTransport({
    scriptSettingsTransport: createScriptSettingsObservabilityTransport({
      accountId,
      scriptName: workerId,
      token,
    }),
    betaTransport: createBetaWorkerObservabilityTransport({
      accountId,
      workerId,
      token,
    }),
  });
}

/**
 * Transport selection is window-bound for exact-layer windows: a script_layer
 * restore_mode of script-settings-null requires dual-view. Env
 * CITYSCROLL_OBSERVABILITY_RESTORER_TRANSPORT may force dual-view. A custom
 * transport module still wins when set. Exact-layer never silently falls back
 * to beta-only.
 */
export async function loadTransport(env, { window = null } = {}) {
  const moduleUrl = env.CITYSCROLL_OBSERVABILITY_RESTORER_TRANSPORT_MODULE;
  if (moduleUrl) {
    const mod = await import(moduleUrl);
    let transport;
    if (typeof mod.createTransport === "function") transport = await mod.createTransport({ env, window });
    else if (typeof mod.default === "function") transport = await mod.default({ env, window });
    else if (mod.transport) transport = mod.transport;
    else throw new Error("transport module must export createTransport, default, or transport");
    if (windowRequiresExactLayerTransport(window) && typeof transport?.getDualView !== "function") {
      throw new Error("exact-layer window requires dual-view transport; refusing silent beta fallback");
    }
    return transport;
  }

  const envMode = env.CITYSCROLL_OBSERVABILITY_RESTORER_TRANSPORT || "";
  const needsDual = windowRequiresExactLayerTransport(window) || envMode === DUAL_VIEW_TRANSPORT_MODE;
  if (needsDual) {
    return createCredentialedDualViewTransport(env);
  }
  return createCredentialedBetaTransport(env);
}

export async function main(argv = process.argv.slice(2), env = process.env) {
  const stateRoot = arg(argv, "--state-root") || env.CITYSCROLL_OBSERVABILITY_RESTORER_STATE || DEFAULT_RESTORER_STATE_ROOT;
  const paths = restorerPaths(stateRoot);
  const assignment = readJsonIfPresent(paths.assignedWindow);
  const windowPath = arg(argv, "--window-state") || assignment?.window_path;
  if (!windowPath) throw new Error("--window-state or assigned-window.json is required");
  const pollMs = Number(arg(argv, "--poll-ms") || DEFAULT_POLL_MS);
  const expectedWindowId = arg(argv, "--window-id") || assignment?.window_id || null;
  const store = createFileWindowStore(windowPath);
  const window = await store.read();
  if (expectedWindowId && window?.window_id && window.window_id !== expectedWindowId) {
    throw new Error(`window id mismatch: expected ${expectedWindowId}, got ${window.window_id}`);
  }
  const transport = await loadTransport(env, { window });
  return runRestorerLoop({
    store,
    transport,
    stateRoot,
    pollMs,
    expectedWindowId,
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().then((result) => {
    if (result?.terminal_receipt) {
      process.stdout.write(`${JSON.stringify(result.terminal_receipt)}\n`);
    }
    process.exitCode = 0;
  }).catch((error) => {
    process.stderr.write(`${String(error?.stack || error)}\n`);
    process.exitCode = 2;
  });
}
