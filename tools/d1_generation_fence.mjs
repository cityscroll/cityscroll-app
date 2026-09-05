#!/usr/bin/env node

/**
 * Single-writer generation fencing for D1 read-model publication.
 *
 * The core only knows an injected state store. A store must provide read(),
 * compareAndSet(expectedGeneration, nextState), and appendAudit(receipt).
 * compareAndSet is the publication boundary: a publisher that read an older
 * generation can never replace a state written by a competing publisher.
 *
 * The Wrangler adapter is intentionally thin. KV has no native compare-and-set,
 * so it uses a read, conditional put, and read-back identity check. The pure
 * store contract remains strict, which is what the fixture and any transactional
 * deployment store use to make the race deterministic.
 */

import { execFile } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { promisify } from "node:util";

import { SNAPSHOT_SCHEMA, watermarksFromSnapshot } from "./d1_delta_plan.mjs";
import { D1_GENERATION_FENCE_SCHEMA, D1_PUBLICATION_STATE_SCHEMA } from "./d1_deploy_fingerprint.mjs";

export { D1_GENERATION_FENCE_SCHEMA };

const execFileAsync = promisify(execFile);
export const D1_GENERATION_FENCE_KEY = "d1-publication:state:v1";
export const D1_GENERATION_FENCE_AUDIT_KEY_PREFIX = "d1-publication:audit:v1:";
export const D1_GENERATION_FENCE_AUDIT_SCHEMA = "cityscroll.d1-publication-generation-fence-audit.v1";
export const DEFAULT_LEASE_MS = 10 * 60 * 1000;

const STATUSES = new Set(["claimed", "accepted", "published", "abandoned"]);

function clone(value) {
  return value == null ? value : structuredClone(value);
}

function fail(message) {
  throw new Error(`d1 generation fence: ${message}`);
}

function requireString(value, field) {
  if (typeof value !== "string" || value.trim() === "") fail(`${field} must be a non-empty string`);
  return value;
}

function timestampMs(value, field) {
  const parsed = typeof value === "number" ? value : Date.parse(value);
  if (!Number.isFinite(parsed)) fail(`${field} must be an ISO timestamp or milliseconds`);
  return parsed;
}

function isoTimestamp(value) {
  return new Date(timestampMs(value, "timestamp")).toISOString();
}

function nowMs(now) {
  return timestampMs(now ?? Date.now(), "now");
}

function generationOf(state) {
  return state?.generation ?? null;
}

function validateWatermarks(watermarks) {
  if (!watermarks || typeof watermarks !== "object" || Array.isArray(watermarks)) {
    fail("watermarks must be an object");
  }
  for (const [modelId, partitions] of Object.entries(watermarks)) {
    if (!partitions || typeof partitions !== "object" || Array.isArray(partitions)) {
      fail(`watermarks.${modelId} must be an object`);
    }
    for (const [partition, watermark] of Object.entries(partitions)) {
      if (watermark !== null && typeof watermark !== "string") {
        fail(`watermarks.${modelId}.${partition} must be a string or null`);
      }
    }
  }
  return watermarks;
}

export function validateFenceState(state) {
  if (!state || typeof state !== "object" || Array.isArray(state)) fail("state must be an object");
  if (state.schema !== D1_GENERATION_FENCE_SCHEMA) fail("state has the wrong schema");
  if (!Number.isInteger(state.generation) || state.generation < 1) fail("state.generation must be a positive integer");
  if (!STATUSES.has(state.status)) fail(`state.status must be one of ${[...STATUSES].join(", ")}`);
  requireString(state.holder, "state.holder");
  if (!/^[a-f0-9]{64}$/.test(state.fingerprint || "")) fail("state.fingerprint must be a sha256 fingerprint");
  validateWatermarks(state.watermarks);
  if (state.lease_until !== null) timestampMs(state.lease_until, "state.lease_until");
  if (state.accepted_at !== null) timestampMs(state.accepted_at, "state.accepted_at");
  return state;
}

function readState(store) {
  return Promise.resolve(store.read()).then((state) => {
    if (state == null) return null;
    return clone(validateFenceState(state));
  });
}

function expectedGeneration(state) {
  return state?.generation ?? null;
}

function requireStore(store) {
  for (const method of ["read", "compareAndSet", "appendAudit"]) {
    if (!store || typeof store[method] !== "function") fail(`store must provide ${method}()`);
  }
}

function active(state, atMs) {
  return state && (state.status === "claimed" || state.status === "accepted")
    && state.lease_until !== null && timestampMs(state.lease_until, "state.lease_until") > atMs;
}

function identityMatches(state, { generation, holder, fingerprint }) {
  return state?.generation === generation
    && state?.holder === holder
    && (fingerprint == null || state?.fingerprint === fingerprint);
}

function claimState({ generation, holder, fingerprint, watermarks, now, leaseMs }) {
  return {
    schema: D1_GENERATION_FENCE_SCHEMA,
    status: "claimed",
    generation,
    holder,
    lease_until: isoTimestamp(now + leaseMs),
    fingerprint,
    watermarks: clone(watermarks),
    accepted_at: null,
  };
}

async function conditionalClaim({ store, prior, holder, fingerprint, watermarks, now, leaseMs, reclaim }) {
  const generation = (prior?.generation ?? 0) + 1;
  const next = claimState({ generation, holder, fingerprint, watermarks, now, leaseMs });
  const won = await store.compareAndSet(expectedGeneration(prior), next);
  if (!won) {
    const observed = await readState(store);
    return {
      result: "lost-race",
      claimed: false,
      retry: true,
      generation: observed?.generation ?? null,
      state: observed,
    };
  }

  let audit = null;
  if (reclaim && prior) {
    audit = {
      schema: D1_GENERATION_FENCE_AUDIT_SCHEMA,
      event: "stale_claim_reclaimed",
      observed_at: isoTimestamp(now),
      abandoned_claim: {
        generation: prior.generation,
        holder: prior.holder,
        lease_until: prior.lease_until,
        fingerprint: prior.fingerprint,
        watermarks: clone(prior.watermarks),
        accepted_at: prior.accepted_at,
      },
      reclaimed_by: { generation, holder },
    };
    await store.appendAudit(audit);
  }
  return { result: reclaim ? "reclaimed" : "claimed", claimed: true, retry: false, generation, state: next, audit };
}

/** Claim the next generation, or return a safe busy/lost-race result. */
export async function claimGeneration({ store, holder, fingerprint, watermarks, now = Date.now(), leaseMs = DEFAULT_LEASE_MS }) {
  requireStore(store);
  requireString(holder, "holder");
  if (!/^[a-f0-9]{64}$/.test(fingerprint || "")) fail("fingerprint must be a sha256 fingerprint");
  if (!Number.isInteger(leaseMs) || leaseMs <= 0) fail("leaseMs must be a positive integer");
  validateWatermarks(watermarks);
  const atMs = nowMs(now);
  const prior = await readState(store);
  if (active(prior, atMs)) {
    return { result: "busy", claimed: false, retry: true, generation: prior.generation, state: prior };
  }
  return conditionalClaim({ store, prior, holder, fingerprint, watermarks, now: atMs, leaseMs, reclaim: prior?.status === "claimed" || prior?.status === "accepted" });
}

/** Reclaim only an expired claim; never removes or resets the fence state. */
export async function reclaimGeneration({ store, holder, fingerprint, watermarks, now = Date.now(), leaseMs = DEFAULT_LEASE_MS }) {
  requireStore(store);
  requireString(holder, "holder");
  if (!/^[a-f0-9]{64}$/.test(fingerprint || "")) fail("fingerprint must be a sha256 fingerprint");
  if (!Number.isInteger(leaseMs) || leaseMs <= 0) fail("leaseMs must be a positive integer");
  validateWatermarks(watermarks);
  const atMs = nowMs(now);
  const prior = await readState(store);
  if (!prior || !(prior.status === "claimed" || prior.status === "accepted") || active(prior, atMs)) {
    return { result: "not-reclaimable", claimed: false, retry: Boolean(active(prior, atMs)), generation: prior?.generation ?? null, state: prior };
  }
  return conditionalClaim({ store, prior, holder, fingerprint, watermarks, now: atMs, leaseMs, reclaim: true });
}

/** Renew a live lease without changing its generation identity. */
export async function renewGeneration({ store, generation, holder, fingerprint, now = Date.now(), leaseMs = DEFAULT_LEASE_MS }) {
  requireStore(store);
  requireString(holder, "holder");
  const atMs = nowMs(now);
  const prior = await readState(store);
  if (!identityMatches(prior, { generation, holder, fingerprint })) {
    return { result: "fenced", renewed: false, fenced: true, state: prior };
  }
  if (!active(prior, atMs)) return { result: "expired", renewed: false, fenced: true, state: prior };
  const next = { ...prior, lease_until: isoTimestamp(atMs + leaseMs) };
  const renewed = await store.compareAndSet(prior.generation, next);
  return renewed
    ? { result: "renewed", renewed: true, fenced: false, state: next }
    : { result: "lost-race", renewed: false, fenced: true, state: await readState(store) };
}

/** Mark a failed holder abandoned, leaving the state and an audit receipt intact. */
export async function abandonGeneration({ store, generation, holder, fingerprint, now = Date.now() }) {
  requireStore(store);
  const atMs = nowMs(now);
  const prior = await readState(store);
  if (!identityMatches(prior, { generation, holder, fingerprint })) {
    return { result: "fenced", abandoned: false, fenced: true, state: prior };
  }
  const next = { ...prior, status: "abandoned", lease_until: isoTimestamp(atMs) };
  const abandoned = await store.compareAndSet(prior.generation, next);
  if (!abandoned) return { result: "lost-race", abandoned: false, fenced: true, state: await readState(store) };
  const audit = {
    schema: D1_GENERATION_FENCE_AUDIT_SCHEMA,
    event: "claim_abandoned",
    observed_at: isoTimestamp(atMs),
    abandoned_claim: {
      generation: prior.generation, holder: prior.holder, lease_until: prior.lease_until,
      fingerprint: prior.fingerprint, watermarks: clone(prior.watermarks), accepted_at: prior.accepted_at,
    },
  };
  await store.appendAudit(audit);
  return { result: "abandoned", abandoned: true, fenced: false, state: next, audit };
}

/**
 * Re-check and accept the fence immediately before the first D1 SQL command.
 * The CAS changes claimed -> accepted, so a newer accepted generation fences
 * every older holder at this exact boundary.
 */
export async function checkGenerationCommit({ store, generation, holder, fingerprint, now = Date.now() }) {
  requireStore(store);
  const atMs = nowMs(now);
  const prior = await readState(store);
  if (!identityMatches(prior, { generation, holder, fingerprint })) {
    return { result: "fenced", committable: false, fenced: true, state: prior };
  }
  if (!(prior.status === "claimed" || prior.status === "accepted") || !active(prior, atMs)) {
    return { result: "expired", committable: false, fenced: true, state: prior };
  }
  if (prior.status === "accepted") return { result: "accepted", committable: true, fenced: false, state: prior };
  const next = { ...prior, status: "accepted", accepted_at: isoTimestamp(atMs) };
  const accepted = await store.compareAndSet(prior.generation, next);
  if (!accepted) return { result: "fenced", committable: false, fenced: true, state: await readState(store) };
  return { result: "accepted", committable: true, fenced: false, state: next };
}

/** Record successful SQL publication while preserving the accepted generation. */
export async function completeGeneration({ store, generation, holder, fingerprint, now = Date.now() }) {
  requireStore(store);
  const prior = await readState(store);
  if (!identityMatches(prior, { generation, holder, fingerprint }) || prior.status !== "accepted") {
    return { result: "fenced", completed: false, fenced: true, state: prior };
  }
  const next = { ...prior, status: "published", lease_until: null, accepted_at: prior.accepted_at || isoTimestamp(now) };
  const completed = await store.compareAndSet(prior.generation, next);
  return completed
    ? { result: "published", completed: true, fenced: false, state: next }
    : { result: "fenced", completed: false, fenced: true, state: await readState(store) };
}

/** Small deterministic fixture store used by tests and local rehearsals. */
export function createMemoryStateStore(initial = null) {
  let state = clone(initial);
  const audits = [];
  return {
    async read() { return clone(state); },
    async compareAndSet(expected, next) {
      if (generationOf(state) !== expected) return false;
      state = clone(next);
      return true;
    },
    async appendAudit(receipt) { audits.push(clone(receipt)); },
    get audits() { return clone(audits); },
  };
}

/**
 * Adapter for the Wrangler KV commands used by the deploy workflow.
 * `run` may be injected by a fixture; production uses npx Wrangler and the
 * existing ALERT_STATE binding. KV contention is surfaced as lost-race.
 */
export function createWranglerKvStore({
  key = D1_GENERATION_FENCE_KEY,
  binding = "ALERT_STATE",
  config = "worker/wrangler.toml",
  remote = true,
  wranglerVersion = "4.126.0",
  run = null,
} = {}) {
  const invoke = run || (async (args) => execFileAsync("npx", [`wrangler@${wranglerVersion}`, ...args], { encoding: "utf8" }));
  const common = ["kv", "key", "--binding", binding, ...(remote ? ["--remote"] : []), "--config", config];
  const read = async () => {
    try {
      const result = await invoke([...common.slice(0, 2), "get", key, "--text", ...common.slice(2)]);
      const raw = String(result?.stdout ?? result ?? "").trim();
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      // d1-01 stored only a published fingerprint. It is a valid prior
      // publication for the gate, but not a live generation claim to fence.
      return parsed?.schema === D1_PUBLICATION_STATE_SCHEMA ? null : parsed;
    } catch (error) {
      const details = `${error?.stderr || ""} ${error?.message || ""}`.toLowerCase();
      if (details.includes("not found") || details.includes("does not exist") || details.includes("missing")) return null;
      throw error;
    }
  };
  const putKey = async (targetKey, value) => {
    await invoke([...common.slice(0, 2), "put", targetKey, JSON.stringify(value), ...common.slice(2)]);
  };
  return {
    read,
    async compareAndSet(expected, next) {
      const current = await read();
      if ((current?.generation ?? null) !== expected) return false;
      await putKey(key, next);
      const observed = await read();
      return observed?.generation === next.generation
        && observed?.holder === next.holder
        && observed?.fingerprint === next.fingerprint;
    },
    async appendAudit(receipt) {
      const generation = receipt?.reclaimed_by?.generation ?? receipt?.abandoned_claim?.generation ?? "unknown";
      await putKey(`${D1_GENERATION_FENCE_AUDIT_KEY_PREFIX}${generation}`, receipt);
    },
  };
}

function fileStore(path) {
  let state = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : null;
  return {
    async read() { return clone(state); },
    async compareAndSet(expected, next) {
      if ((state?.generation ?? null) !== expected) return false;
      state = clone(next);
      writeFileSync(path, `${JSON.stringify(state, null, 2)}\n`);
      return true;
    },
    async appendAudit(receipt) { return receipt; },
  };
}

function parseArgs(argv) {
  const args = { command: argv[2] };
  for (let index = 3; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!argument.startsWith("--")) fail(`unknown argument ${argument}`);
    args[argument.slice(2)] = argv[++index];
  }
  return args;
}

function required(args, name) {
  if (!args[name]) fail(`missing --${name}`);
  return args[name];
}

function storeFromArgs(args) {
  if (args["state-file"]) return fileStore(args["state-file"]);
  return createWranglerKvStore({
    key: args.key || D1_GENERATION_FENCE_KEY,
    binding: args.binding || "ALERT_STATE",
    config: args.config || "worker/wrangler.toml",
    remote: args.remote !== "false",
    wranglerVersion: args["wrangler-version"] || "4.126.0",
  });
}

function writeOutput(path, value) {
  if (path) writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
  else process.stdout.write(`${JSON.stringify(value)}\n`);
}

function writeGithubOutput(path, values) {
  if (!path) return;
  writeFileSync(path, Object.entries(values).map(([key, value]) => `${key}=${value}\n`).join(""), { flag: "a" });
}

async function main(argv) {
  const args = parseArgs(argv);
  const store = storeFromArgs(args);
  let result;
  if (args.command === "claim") {
    const snapshot = JSON.parse(readFileSync(required(args, "snapshot"), "utf8"));
    if (snapshot.schema !== SNAPSHOT_SCHEMA) fail("snapshot has the wrong schema");
    result = await claimGeneration({
      store, holder: required(args, "holder"), fingerprint: required(args, "fingerprint"),
      watermarks: watermarksFromSnapshot(snapshot), leaseMs: Number(args["lease-ms"] || DEFAULT_LEASE_MS),
    });
    writeGithubOutput(args["github-output"], { claimed: String(result.claimed), generation: result.generation ?? "" });
  } else if (args.command === "renew") {
    result = await renewGeneration({ store, generation: Number(required(args, "generation")), holder: required(args, "holder"), fingerprint: args.fingerprint, leaseMs: Number(args["lease-ms"] || DEFAULT_LEASE_MS) });
  } else if (args.command === "abandon") {
    result = await abandonGeneration({ store, generation: Number(required(args, "generation")), holder: required(args, "holder"), fingerprint: args.fingerprint });
  } else if (args.command === "commit-check") {
    result = await checkGenerationCommit({ store, generation: Number(required(args, "generation")), holder: required(args, "holder"), fingerprint: args.fingerprint });
    writeGithubOutput(args["github-output"], { committable: String(result.committable), fenced: String(result.fenced) });
  } else if (args.command === "complete") {
    result = await completeGeneration({ store, generation: Number(required(args, "generation")), holder: required(args, "holder"), fingerprint: args.fingerprint });
  } else {
    fail("usage: claim, renew, abandon, commit-check, or complete");
  }
  writeOutput(args.receipt, result);
  return 0;
}

if (process.argv[1] && process.argv[1].endsWith("d1_generation_fence.mjs")) {
  main(process.argv).catch((error) => {
    console.error(error?.stack || error);
    process.exitCode = 1;
  });
}
