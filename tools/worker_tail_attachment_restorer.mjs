#!/usr/bin/env node
/**
 * Durable supervised Tail-attachment restorer.
 * Installed under a durable state root (run.mjs + lib/) so it survives
 * controller exit and disposal of the source checkout.
 *
 * Loads the same consumer-bound deployments versionTransport the actuator
 * tests cover (fresh GET before/after attach) when the window carries bound
 * version evidence.
 */
import { readFileSync, existsSync, statSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import { pathToFileURL } from "node:url";

import {
  CAP_CREDENTIAL_PROVENANCE,
  assertTailTransportTargetMatchesWindow,
  createFileTailAttachmentStore,
  createOwnedCapDetachActuator,
  createScriptSettingsTailConsumersTransport,
  createSinkReadbackCapSignal,
  establishCapReadbackIdentityBinding,
} from "./lib/worker_tail_attachment.mjs";
import {
  DEFAULT_TAIL_POLL_MS,
  DEFAULT_TAIL_RESTORER_STATE_ROOT,
  createBoundDeploymentsVersionTransport,
  createBoundDualViewTailConsumersTransport,
  createBoundScriptSettingsTailTransport,
  runTailRestorerLoop,
  tailRestorerPaths,
} from "./lib/worker_tail_attachment_restorer.mjs";

function arg(argv, name) {
  const index = argv.indexOf(name);
  return index < 0 ? null : argv[index + 1];
}

function secret(env, name) {
  if (env[name] && env[`${name}_FILE`]) {
    throw new Error(`${name} and ${name}_FILE are mutually exclusive`);
  }
  if (env[name]) return env[name];
  const path = env[`${name}_FILE`];
  if (!path) throw new Error(`${name} or ${name}_FILE is required`);
  if ((statSync(path).mode & 0o077) !== 0) {
    throw new Error(`${name}_FILE must be mode 0600`);
  }
  return readFileSync(path, "utf8").trim();
}

async function loadTransport(env, window) {
  assertTailTransportTargetMatchesWindow(env, window);
  if (env.CITYSCROLL_TAIL_ATTACHMENT_RESTORER_TRANSPORT_MODULE) {
    const mod = await import(env.CITYSCROLL_TAIL_ATTACHMENT_RESTORER_TRANSPORT_MODULE);
    if (typeof mod.createTransport === "function") {
      return mod.createTransport(env, window);
    }
    if (typeof mod.default === "function") return mod.default(env, window);
    if (mod.transport) return mod.transport;
    throw new Error("transport module must export createTransport, default, or transport");
  }
  const token = secret(env, "CLOUDFLARE_API_TOKEN");
  // Dual-view: script-settings write + independent beta Worker GET empty view.
  // createBoundScriptSettingsTailTransport remains available for fixtures that
  // deliberately exercise script-settings alone.
  if (env.CITYSCROLL_TAIL_ATTACHMENT_RESTORER_SCRIPT_SETTINGS_ONLY === "1") {
    return createBoundScriptSettingsTailTransport({
      ...env,
      CLOUDFLARE_API_TOKEN: token,
    }, window);
  }
  return createBoundDualViewTailConsumersTransport({
    ...env,
    CLOUDFLARE_API_TOKEN: token,
  }, window);
}

async function loadVersionTransport(env, window) {
  if (env.CITYSCROLL_TAIL_ATTACHMENT_RESTORER_VERSION_TRANSPORT_MODULE) {
    const mod = await import(env.CITYSCROLL_TAIL_ATTACHMENT_RESTORER_VERSION_TRANSPORT_MODULE);
    if (typeof mod.createVersionTransport === "function") {
      return mod.createVersionTransport(env, window);
    }
    if (typeof mod.createTransport === "function") {
      return mod.createTransport(env, window);
    }
    if (mod.versionTransport) return mod.versionTransport;
    throw new Error(
      "version transport module must export createVersionTransport, createTransport, or versionTransport",
    );
  }
  if (!window?.version_evidence?.present) return null;
  // Fake script-settings modules in fixtures may not have a Cloudflare token;
  // only bind the real deployments transport when account+token are present.
  if (!env.CLOUDFLARE_ACCOUNT_ID || (!env.CLOUDFLARE_API_TOKEN && !env.CLOUDFLARE_API_TOKEN_FILE)) {
    return null;
  }
  const token = secret(env, "CLOUDFLARE_API_TOKEN");
  return createBoundDeploymentsVersionTransport({
    ...env,
    CLOUDFLARE_API_TOKEN: token,
  }, window);
}

/**
 * Default-loader readiness: configured authenticated AggregateSink readback AND
 * a successful validated poll. Missing env, unauthorized, malformed, or failed
 * poll → UNKNOWN (null), which refuses ARM/READY when the window is bound.
 * Fixture injection via CITYSCROLL_TAIL_ATTACHMENT_RESTORER_CAP_DETACH_MODULE
 * is for tests only.
 */
export async function loadCapDetachActuator(env, window, {
  store,
  transport,
  versionTransport,
  fetchImpl = globalThis.fetch,
} = {}) {
  if (window?.restorer?.cap_detach_actuator_bound !== true) {
    return null;
  }
  if (env.CITYSCROLL_TAIL_ATTACHMENT_RESTORER_CAP_DETACH_MODULE) {
    const mod = await import(env.CITYSCROLL_TAIL_ATTACHMENT_RESTORER_CAP_DETACH_MODULE);
    if (typeof mod.createCapDetachActuator === "function") {
      return mod.createCapDetachActuator(env, window, { store, transport, versionTransport });
    }
    if (typeof mod.default === "function") {
      return mod.default(env, window, { store, transport, versionTransport });
    }
    if (mod.capDetachActuator) return mod.capDetachActuator;
    throw new Error(
      "cap-detach module must export createCapDetachActuator, default, or capDetachActuator",
    );
  }
  const readbackUrl = env.CITYSCROLL_TAIL_SINK_READBACK_URL;
  const readbackToken = env.CITYSCROLL_TAIL_SINK_READBACK_TOKEN;
  if (!readbackUrl || !readbackToken) {
    // UNKNOWN — no idle fake actuator. Bound windows refuse READY/run.
    return null;
  }
  // Identity binding: authoritative window + desired consumer + deployed
  // version + exact readback target/credential provenance. Limit scalars
  // (deadline_ms / max_events) are not identity. Missing any part → UNKNOWN.
  const identity = establishCapReadbackIdentityBinding({
    window,
    desiredConsumer: window?.version_evidence?.consumer
      ?? window?.owned_consumers?.[0]
      ?? null,
    versionEvidence: window?.version_evidence ?? null,
    readbackUrl,
    credentialProvenance: CAP_CREDENTIAL_PROVENANCE.ENV_READBACK_TOKEN,
  });
  if (!identity.ok) {
    return null;
  }
  const readCapSignal = createSinkReadbackCapSignal({
    url: readbackUrl,
    token: readbackToken,
    identityBinding: identity.binding,
    fetchImpl,
  });
  const readiness = await readCapSignal({});
  if (!readiness || readiness.readback_ok !== true) {
    return null;
  }
  return createOwnedCapDetachActuator({
    transport,
    versionTransport,
    readCapSignal,
  });
}

async function main(argv = process.argv.slice(2), env = process.env) {
  const windowPath = arg(argv, "--window-state");
  const stateRoot = arg(argv, "--state-root") || env.CITYSCROLL_TAIL_ATTACHMENT_RESTORER_STATE
    || DEFAULT_TAIL_RESTORER_STATE_ROOT;
  const pollMs = Number(arg(argv, "--poll-ms") || DEFAULT_TAIL_POLL_MS);
  if (!windowPath) throw new Error("--window-state is required");
  if (!existsSync(windowPath)) throw new Error(`window state missing at ${windowPath}`);

  const store = createFileTailAttachmentStore(windowPath);
  const window = await store.read();
  if (!window) throw new Error("tail attachment window is empty");
  const transport = await loadTransport(env, window);
  const versionTransport = await loadVersionTransport(env, window);
  const capDetachActuator = await loadCapDetachActuator(env, window, {
    store,
    transport,
    versionTransport,
  });
  // Touch createScriptSettingsTailConsumersTransport so durable copy keeps the import.
  if (typeof createScriptSettingsTailConsumersTransport !== "function") {
    throw new Error("script-settings Tail transport is unavailable");
  }
  const paths = tailRestorerPaths(stateRoot);
  await runTailRestorerLoop({
    store,
    transport,
    versionTransport,
    capDetachActuator,
    stateRoot,
    pollMs: Number.isFinite(pollMs) && pollMs > 0 ? pollMs : DEFAULT_TAIL_POLL_MS,
  });
  return paths.terminalReceipt;
}

// Only auto-run when this file (or an installed durable run.mjs copy) is the
// process entrypoint. Importing from tests must not invoke main().
function isDirectEntrypoint() {
  if (!process.argv[1]) return false;
  try {
    if (import.meta.url === pathToFileURL(resolvePath(process.argv[1])).href) {
      return true;
    }
  } catch {
    // fall through
  }
  const entry = String(process.argv[1]).replace(/\\/g, "/");
  // Durable installed copy is always named run.mjs.
  if (import.meta.url.endsWith("/run.mjs") && entry.endsWith("run.mjs")) {
    return true;
  }
  return false;
}

if (isDirectEntrypoint()) {
  main().catch((error) => {
    console.error(String(error?.stack || error));
    process.exit(1);
  });
}

export { main, loadTransport, loadVersionTransport, secret };
