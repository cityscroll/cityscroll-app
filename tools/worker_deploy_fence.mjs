#!/usr/bin/env node

/**
 * Portable writer fence for the Worker deployment path.
 *
 * GitHub Actions serializes the workflow across runs. This helper adds a
 * durable, per-run writer identity and a last-moment assertion so every
 * mutating command must still belong to the run that acquired the fence.
 * Local callers can use the same contract by supplying WORKER_DEPLOY_OWNER.
 */
import {
  existsSync,
  mkdirSync,
  openSync,
  closeSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";

export const WORKER_DEPLOY_FENCE_SCHEMA = "cityscroll.worker_deploy_fence.v1";
export const DEFAULT_FENCE_TTL_MS = 2 * 60 * 60 * 1000;

function fail(message) {
  throw new Error(`worker deploy fence: ${message}`);
}

function requireValue(value, label) {
  if (typeof value !== "string" || value.trim() === "") fail(`${label} is required`);
  return value.trim();
}

export function fenceRoot(env = process.env) {
  const configured = env.WORKER_DEPLOY_FENCE_ROOT
    || (env.RUNNER_TEMP ? join(env.RUNNER_TEMP, "cityscroll-worker-deploy-fence") : null)
    || join(tmpdir(), "cityscroll-worker-deploy-fence");
  return isAbsolute(configured) ? configured : resolve(configured);
}

export function writerIdentity(env = process.env) {
  if (env.WORKER_DEPLOY_OWNER) return `local:${requireValue(env.WORKER_DEPLOY_OWNER, "WORKER_DEPLOY_OWNER")}`;
  const fields = [
    "GITHUB_REPOSITORY",
    "GITHUB_WORKFLOW",
    "GITHUB_RUN_ID",
    "GITHUB_RUN_ATTEMPT",
    "GITHUB_JOB",
    "GITHUB_SHA",
  ];
  const values = fields.map((field) => requireValue(env[field], field));
  return `github:${values.join("/")}`;
}

function paths(root) {
  return {
    root,
    state: join(root, "state.json"),
    lock: join(root, "lock"),
  };
}

function readState(root) {
  const target = paths(root).state;
  if (!existsSync(target)) return null;
  try {
    return JSON.parse(readFileSync(target, "utf8"));
  } catch (error) {
    fail(`state is unreadable: ${error.message}`);
  }
}

function writeState(root, value) {
  const target = paths(root).state;
  mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
  const next = `${target}.next`;
  writeFileSync(next, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  const fd = openSync(next, "r");
  try {
    closeSync(fd);
  } catch {
    // The rename is still atomic if the platform cannot fsync this tiny fixture.
  }
  renameSync(next, target);
}

function lock(root, owner) {
  const target = paths(root).lock;
  mkdirSync(root, { recursive: true, mode: 0o700 });
  try {
    mkdirSync(target, { mode: 0o700 });
    writeFileSync(join(target, "owner"), `${owner}\n`, { mode: 0o600 });
    return target;
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    const prior = readState(root);
    if (prior?.owner === owner && prior.active === true) return null;
    fail(`another writer holds the fence${prior?.owner ? ` (${prior.owner})` : ""}`);
  }
}

function unlock(root, lockPath) {
  if (!lockPath) return;
  try {
    rmSync(lockPath, { recursive: true, force: true });
  } catch {
    // A failed cleanup is visible on the next fail-closed admission.
  }
}

function assertRecord(record, owner, now) {
  if (!record || record.schema !== WORKER_DEPLOY_FENCE_SCHEMA) fail("state schema is missing or invalid");
  if (record.active !== true) fail("fence is not active");
  if (record.owner !== owner) fail("current writer does not own the fence");
  if (!Number.isInteger(record.generation) || record.generation < 1) fail("generation is invalid");
  const expires = Date.parse(record.expires_at);
  if (!Number.isFinite(expires) || now.getTime() >= expires) fail("fence has expired");
  return record;
}

export function acquire({
  root = fenceRoot(),
  env = process.env,
  now = new Date(),
  ttlMs = Number(env.WORKER_DEPLOY_FENCE_TTL_MS || DEFAULT_FENCE_TTL_MS),
} = {}) {
  const owner = writerIdentity(env);
  if (!Number.isFinite(ttlMs) || ttlMs <= 0) fail("WORKER_DEPLOY_FENCE_TTL_MS must be positive");
  const prior = readState(root);
  if (prior?.active === true) {
    assertRecord(prior, owner, now);
    return { ...prior, idempotent: true };
  }
  const lockPath = lock(root, owner);
  try {
    const current = readState(root);
    if (current?.active === true) {
      assertRecord(current, owner, now);
      return { ...current, idempotent: true };
    }
    const record = {
      schema: WORKER_DEPLOY_FENCE_SCHEMA,
      active: true,
      owner,
      generation: Number.isInteger(current?.generation) ? current.generation + 1 : 1,
      acquired_at: now.toISOString(),
      expires_at: new Date(now.getTime() + ttlMs).toISOString(),
    };
    writeState(root, record);
    return record;
  } finally {
    unlock(root, lockPath);
  }
}

export function assertCurrentWriter({ root = fenceRoot(), env = process.env, now = new Date() } = {}) {
  const owner = writerIdentity(env);
  return assertRecord(readState(root), owner, now);
}

export function release({ root = fenceRoot(), env = process.env, now = new Date() } = {}) {
  const owner = writerIdentity(env);
  const lockPath = lock(root, owner);
  try {
    const record = assertRecord(readState(root), owner, now);
    const released = {
      ...record,
      active: false,
      released_at: now.toISOString(),
    };
    writeState(root, released);
    return released;
  } finally {
    unlock(root, lockPath);
  }
}

export async function run({
  command,
  args = [],
  root = fenceRoot(),
  env = process.env,
} = {}) {
  requireValue(command, "command");
  acquire({ root, env });
  assertCurrentWriter({ root, env });
  const result = await new Promise((resolveResult, reject) => {
    const child = spawn(command, args, { env, stdio: "inherit" });
    child.once("error", reject);
    child.once("exit", (code, signal) => resolveResult({ code: code ?? 1, signal }));
  });
  release({ root, env });
  return result;
}

function parseCommand(argv) {
  const command = argv[2];
  if (["acquire", "assert", "release"].includes(command)) return { command };
  if (command === "run" && argv[3] === "--" && argv[4]) {
    return { command, executable: argv[4], args: argv.slice(5) };
  }
  fail("usage: worker_deploy_fence.mjs <acquire|assert|release|run -- command [args...]");
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname)) {
  try {
    const parsed = parseCommand(process.argv);
    const options = { root: fenceRoot(), env: process.env };
    if (parsed.command === "acquire") acquire(options);
    else if (parsed.command === "assert") assertCurrentWriter(options);
    else if (parsed.command === "release") release(options);
    else {
      const result = await run({ ...options, command: parsed.executable, args: parsed.args });
      process.exitCode = result.code;
    }
  } catch (error) {
    process.stderr.write(`${error.message || error}\n`);
    process.exitCode = 1;
  }
}
