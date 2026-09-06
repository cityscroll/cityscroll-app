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
 * so it uses a read, conditional put, and a read-back check. KV is also
 * eventually consistent: a read moments after a put can still return the value
 * the put replaced. Two rules keep the protocol correct on such a store.
 *
 *  1. compareAndSet is read-your-writes. It polls after the put until the value
 *     it wrote is actually readable, so the next command in the deploy cannot
 *     read-modify-write a pre-put state.
 *  2. A holder's own view of its generation is monotonic. Each command records
 *     the state it confirmed in a per-run ledger, and a later command that reads
 *     an older status for the same generation, holder, and fingerprint writes
 *     forward from the ledger instead of regressing the fence.
 *
 * Neither rule loosens the fence: a state belonging to a different generation or
 * holder always wins, and `abandoned` is terminal.
 */

import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { promisify } from "node:util";

import { SNAPSHOT_SCHEMA, watermarksFromSnapshot } from "./d1_delta_plan.mjs";
import { D1_GENERATION_FENCE_SCHEMA, D1_PUBLICATION_STATE_SCHEMA } from "./d1_deploy_fingerprint.mjs";

export { D1_GENERATION_FENCE_SCHEMA };

const execFileAsync = promisify(execFile);
export const D1_GENERATION_FENCE_KEY = "d1-publication:state:v1";
export const D1_GENERATION_FENCE_AUDIT_KEY_PREFIX = "d1-publication:audit:v1:";
export const D1_GENERATION_FENCE_AUDIT_SCHEMA = "cityscroll.d1-publication-generation-fence-audit.v1";
export const D1_GENERATION_FENCE_OUTCOME_SCHEMA = "cityscroll.d1-publication-generation-fence-outcome.v1";
export const DEFAULT_LEASE_MS = 10 * 60 * 1000;

const STATUSES = new Set(["claimed", "accepted", "published", "abandoned"]);

// A holder only ever moves its own generation forward: claimed -> accepted ->
// published. `abandoned` is terminal and ranks above every live status, so a
// local ledger can never talk a remote abandonment back into a live claim.
const STATUS_RANK = { claimed: 1, accepted: 2, published: 3, abandoned: 4 };

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

/** A per-run record of the last state this holder confirmed it wrote. */
export function createMemoryLedger(initial = null) {
  let confirmed = clone(initial);
  return {
    read() { return clone(confirmed); },
    write(state) { confirmed = clone(state); },
  };
}

export function createFileLedger(path) {
  return {
    read() {
      if (!existsSync(path)) return null;
      try {
        return JSON.parse(readFileSync(path, "utf8"));
      } catch {
        // A ledger is an optimisation over the remote state, never an authority
        // of its own. An unreadable one degrades to "no local view", not a failure.
        return null;
      }
    },
    write(state) {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, `${JSON.stringify(state, null, 2)}\n`);
    },
  };
}

async function readLedger(ledger) {
  if (!ledger || typeof ledger.read !== "function") return null;
  const state = await Promise.resolve(ledger.read());
  if (state == null) return null;
  try {
    return clone(validateFenceState(state));
  } catch {
    return null;
  }
}

async function writeLedger(ledger, state) {
  if (!ledger || typeof ledger.write !== "function") return;
  await Promise.resolve(ledger.write(clone(state)));
}

function leaseMsOf(state) {
  return state.lease_until === null ? Number.POSITIVE_INFINITY : timestampMs(state.lease_until, "state.lease_until");
}

/**
 * The prior state to write forward from. A remote read that lags this holder's
 * own confirmed write would otherwise regress the fence — that is exactly how an
 * accepted generation came back as claimed and blocked its own completion. Only
 * a remote state with the same generation, holder, and fingerprint is eligible
 * for that repair, so a competing generation still fences this holder outright.
 */
function monotonicPrior(remote, confirmed, identity) {
  if (!remote || !confirmed) return remote;
  if (!identityMatches(remote, identity) || !identityMatches(confirmed, identity)) return remote;
  const remoteRank = STATUS_RANK[remote.status] ?? 0;
  const confirmedRank = STATUS_RANK[confirmed.status] ?? 0;
  if (confirmedRank !== remoteRank) return confirmedRank > remoteRank ? confirmed : remote;
  return leaseMsOf(confirmed) > leaseMsOf(remote) ? confirmed : remote;
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

async function conditionalClaim({ store, ledger, prior, holder, fingerprint, watermarks, now, leaseMs, reclaim }) {
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
  await writeLedger(ledger, next);
  return { result: reclaim ? "reclaimed" : "claimed", claimed: true, retry: false, generation, state: next, audit };
}

/** Claim the next generation, or return a safe busy/lost-race result. */
export async function claimGeneration({ store, ledger = null, holder, fingerprint, watermarks, now = Date.now(), leaseMs = DEFAULT_LEASE_MS }) {
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
  return conditionalClaim({ store, ledger, prior, holder, fingerprint, watermarks, now: atMs, leaseMs, reclaim: prior?.status === "claimed" || prior?.status === "accepted" });
}

/** Reclaim only an expired claim; never removes or resets the fence state. */
export async function reclaimGeneration({ store, ledger = null, holder, fingerprint, watermarks, now = Date.now(), leaseMs = DEFAULT_LEASE_MS }) {
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
  return conditionalClaim({ store, ledger, prior, holder, fingerprint, watermarks, now: atMs, leaseMs, reclaim: true });
}

/** Renew a live lease without changing its generation identity. */
export async function renewGeneration({ store, ledger = null, generation, holder, fingerprint, now = Date.now(), leaseMs = DEFAULT_LEASE_MS }) {
  requireStore(store);
  requireString(holder, "holder");
  const atMs = nowMs(now);
  const identity = { generation, holder, fingerprint };
  const remote = await readState(store);
  if (!identityMatches(remote, identity)) {
    return { result: "fenced", renewed: false, fenced: true, state: remote };
  }
  // A renewal extends a lease. It must never be the write that walks this
  // holder's own status back down the ladder.
  const prior = monotonicPrior(remote, await readLedger(ledger), identity);
  if (!active(prior, atMs)) return { result: "expired", renewed: false, fenced: true, state: prior };
  const next = { ...prior, lease_until: isoTimestamp(atMs + leaseMs) };
  const renewed = await store.compareAndSet(prior.generation, next);
  if (!renewed) return { result: "lost-race", renewed: false, fenced: true, state: await readState(store) };
  await writeLedger(ledger, next);
  return { result: "renewed", renewed: true, fenced: false, state: next };
}

/** Mark a failed holder abandoned, leaving the state and an audit receipt intact. */
export async function abandonGeneration({ store, ledger = null, generation, holder, fingerprint, now = Date.now() }) {
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
  await writeLedger(ledger, next);
  return { result: "abandoned", abandoned: true, fenced: false, state: next, audit };
}

/**
 * A durable, machine-readable record of one fence decision at a write boundary.
 *
 * A rejection names both generations: the one the caller carries and the one the
 * store already holds. That pair is the whole diagnosis of an out-of-order
 * publication, so it belongs in the receipt rather than only in a log line.
 */
export function fenceOutcome({ result, reason, generation = null, holder = null, state = null, observedAt = Date.now() }) {
  return {
    schema: D1_GENERATION_FENCE_OUTCOME_SCHEMA,
    result,
    reason,
    observed_at: isoTimestamp(observedAt),
    generation,
    holder,
    stale_generation: result === "rejected" ? generation : null,
    current_generation: state?.generation ?? null,
    current_holder: state?.holder ?? null,
    current_status: state?.status ?? null,
  };
}

/**
 * Re-check and accept the fence immediately before the first D1 SQL command.
 * The CAS changes claimed -> accepted, so a newer accepted generation fences
 * every older holder at this exact boundary.
 *
 * The fence is monotonic by generation number, not merely by identity. A caller
 * whose generation is below the one the store already holds is stale by
 * definition and is rejected outright: no local ledger, lease, or retry can talk
 * it back into a committable state. Every result carries an `outcome` record so
 * the decision — and, on a rejection, both generation numbers — survives in the
 * caller's receipt.
 */
export async function checkGenerationCommit({ store, ledger = null, generation, holder, fingerprint, now = Date.now() }) {
  requireStore(store);
  const atMs = nowMs(now);
  const identity = { generation, holder, fingerprint };
  const remote = await readState(store);
  const reject = (reason, state) => ({
    result: "fenced",
    committable: false,
    fenced: true,
    stale: reason === "stale_generation",
    current_generation: state?.generation ?? null,
    outcome: fenceOutcome({ result: "rejected", reason, generation, holder, state, observedAt: atMs }),
    state,
  });

  if (remote && Number.isInteger(generation) && remote.generation > generation) {
    return reject("stale_generation", remote);
  }
  if (!identityMatches(remote, identity)) {
    return reject("generation_not_held", remote);
  }
  const prior = monotonicPrior(remote, await readLedger(ledger), identity);
  if (!(prior.status === "claimed" || prior.status === "accepted") || !active(prior, atMs)) {
    return { ...reject("lease_expired", prior), result: "expired" };
  }
  const accept = (state) => ({
    result: "accepted",
    committable: true,
    fenced: false,
    stale: false,
    current_generation: state.generation,
    outcome: fenceOutcome({ result: "accepted", reason: "generation_held", generation, holder, state, observedAt: atMs }),
    state,
  });
  if (prior.status === "accepted") {
    await writeLedger(ledger, prior);
    return accept(prior);
  }
  const next = { ...prior, status: "accepted", accepted_at: isoTimestamp(atMs) };
  const accepted = await store.compareAndSet(prior.generation, next);
  if (!accepted) return reject("lost_race", await readState(store));
  await writeLedger(ledger, next);
  return accept(next);
}

/** Record successful SQL publication while preserving the accepted generation. */
export async function completeGeneration({ store, ledger = null, generation, holder, fingerprint, now = Date.now() }) {
  requireStore(store);
  const identity = { generation, holder, fingerprint };
  const remote = await readState(store);
  if (!identityMatches(remote, identity)) {
    return { result: "fenced", completed: false, fenced: true, state: remote };
  }
  // The acceptance this run confirmed for itself counts even if the remote read
  // has not caught up to it yet; a state owned by anyone else never does.
  const prior = monotonicPrior(remote, await readLedger(ledger), identity);
  if (prior.status !== "accepted") {
    return { result: "fenced", completed: false, fenced: true, state: prior };
  }
  const next = { ...prior, status: "published", lease_until: null, accepted_at: prior.accepted_at || isoTimestamp(now) };
  const completed = await store.compareAndSet(prior.generation, next);
  if (!completed) return { result: "fenced", completed: false, fenced: true, state: await readState(store) };
  await writeLedger(ledger, next);
  return { result: "published", completed: true, fenced: false, state: next };
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
  readAfterWriteMs = 90_000,
  readAfterWritePollMs = 3_000,
  sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); }),
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
  // The write is only committed once it is readable. Matching generation, holder,
  // and fingerprint is not enough: those are identical across a claim, its
  // acceptance, and its renewals, so a stale read of an earlier step in the same
  // generation used to pass as confirmation of a later one.
  const observedAsWritten = (observed, next) => observed?.generation === next.generation
    && observed?.holder === next.holder
    && observed?.fingerprint === next.fingerprint
    && observed?.status === next.status
    && (observed?.lease_until ?? null) === (next.lease_until ?? null);

  return {
    read,
    async compareAndSet(expected, next) {
      const current = await read();
      if ((current?.generation ?? null) !== expected) return false;
      await putKey(key, next);
      // KV is eventually consistent, so poll until this process can read its own
      // write back. Returning before then lets the next fence command in the
      // deploy read-modify-write a state that predates this put.
      for (let waited = 0; ; waited += readAfterWritePollMs) {
        if (observedAsWritten(await read(), next)) return true;
        if (waited >= readAfterWriteMs) return false;
        await sleep(readAfterWritePollMs);
      }
    },
    async appendAudit(receipt) {
      const generation = receipt?.reclaimed_by?.generation ?? receipt?.abandoned_claim?.generation ?? "unknown";
      await putKey(`${D1_GENERATION_FENCE_AUDIT_KEY_PREFIX}${generation}`, receipt);
    },
  };
}

export function fileStore(path) {
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

// A bare `--flag` is a boolean, not a flag that swallows the next token. Consuming
// the next token unconditionally made `--remote --config worker/wrangler.toml` read as
// remote="--config", left config on its silent default, and then rejected the real path
// as a positional. Only a token that is not itself a flag can be a value.
export function parseArgs(argv) {
  const args = { command: argv[2] };
  for (let index = 3; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!argument.startsWith("--")) fail(`unknown argument ${argument}`);
    const next = argv[index + 1];
    if (next === undefined || next.startsWith("--")) {
      args[argument.slice(2)] = "true";
    } else {
      args[argument.slice(2)] = next;
      index += 1;
    }
  }
  return args;
}

function required(args, name) {
  if (!args[name]) fail(`missing --${name}`);
  return args[name];
}

function ledgerFromArgs(args) {
  return args.ledger ? createFileLedger(args.ledger) : null;
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
  const ledger = ledgerFromArgs(args);
  let result;
  if (args.command === "claim") {
    const snapshot = JSON.parse(readFileSync(required(args, "snapshot"), "utf8"));
    if (snapshot.schema !== SNAPSHOT_SCHEMA) fail("snapshot has the wrong schema");
    result = await claimGeneration({
      store, ledger, holder: required(args, "holder"), fingerprint: required(args, "fingerprint"),
      watermarks: watermarksFromSnapshot(snapshot), leaseMs: Number(args["lease-ms"] || DEFAULT_LEASE_MS),
    });
    writeGithubOutput(args["github-output"], { claimed: String(result.claimed), generation: result.generation ?? "" });
  } else if (args.command === "renew") {
    result = await renewGeneration({ store, ledger, generation: Number(required(args, "generation")), holder: required(args, "holder"), fingerprint: args.fingerprint, leaseMs: Number(args["lease-ms"] || DEFAULT_LEASE_MS) });
  } else if (args.command === "abandon") {
    result = await abandonGeneration({ store, ledger, generation: Number(required(args, "generation")), holder: required(args, "holder"), fingerprint: args.fingerprint });
  } else if (args.command === "commit-check") {
    result = await checkGenerationCommit({ store, ledger, generation: Number(required(args, "generation")), holder: required(args, "holder"), fingerprint: args.fingerprint });
    writeGithubOutput(args["github-output"], { committable: String(result.committable), fenced: String(result.fenced) });
  } else if (args.command === "complete") {
    result = await completeGeneration({ store, ledger, generation: Number(required(args, "generation")), holder: required(args, "holder"), fingerprint: args.fingerprint });
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
