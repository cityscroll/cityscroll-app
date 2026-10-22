// Leak-safe scratch directories for tests and tools.
//
// `mkdtemp(join(tmpdir(), "prefix-"))` on its own only gets removed if the
// caller remembers to rm it back out, and a plain `try/finally` around that
// rm still leaves the directory behind when the process is killed by a gate
// timeout (SIGTERM) before the finally block runs. `withTempDir` fixes both:
// every directory it hands out carries a `cityscroll-<prefix>-` name so a
// leak is attributable, and cleanup also runs from `process.on("exit"/
// "SIGTERM"/"SIGINT")` so an interrupted run does not leave its directory.
//
// Cleanup must not drop a directory from the active set until removal
// succeeds. Under disk pressure, `rm` can throw ENOSPC/ENOTEMPTY on unlink;
// deleting from `active` first left `cityscroll-client-assets-*` behind for
// `check_temp_leaks` even though the suite thought cleanup had run.

import { mkdtemp, rm } from "node:fs/promises";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const active = new Set();
let handlersInstalled = false;

const RETRYABLE_CODES = new Set(["ENOSPC", "ENOTEMPTY", "EBUSY"]);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryable(error) {
  return error && RETRYABLE_CODES.has(error.code);
}

async function removeDirAsync(dir, { rmAsync = rm, rmRetries = 5, rmRetryDelayMs = 15 } = {}) {
  let lastError;
  for (let attempt = 1; attempt <= rmRetries; attempt += 1) {
    try {
      await rmAsync(dir, { recursive: true, force: true });
      return;
    } catch (error) {
      lastError = error;
      if (!isRetryable(error) || attempt === rmRetries) throw error;
      if (rmRetryDelayMs > 0) await sleep(rmRetryDelayMs * attempt);
    }
  }
  throw lastError;
}

function removeDirSync(dir, { rmSyncFn = rmSync, rmRetries = 5, rmRetryDelayMs = 15 } = {}) {
  let lastError;
  for (let attempt = 1; attempt <= rmRetries; attempt += 1) {
    try {
      rmSyncFn(dir, { recursive: true, force: true });
      return;
    } catch (error) {
      lastError = error;
      if (!isRetryable(error) || attempt === rmRetries) throw error;
      if (rmRetryDelayMs > 0) {
        const end = Date.now() + rmRetryDelayMs * attempt;
        while (Date.now() < end) {
          /* spin — sync cleanup path has no await */
        }
      }
    }
  }
  throw lastError;
}

function cleanupAllSync() {
  for (const dir of [...active]) {
    try {
      removeDirSync(dir);
      active.delete(dir);
    } catch {
      // best effort - leave in active if still present so a later signal can retry
    }
  }
}

function installHandlers() {
  if (handlersInstalled) return;
  handlersInstalled = true;
  process.on("exit", cleanupAllSync);
  process.on("SIGTERM", () => {
    cleanupAllSync();
    process.exit(143);
  });
  process.on("SIGINT", () => {
    cleanupAllSync();
    process.exit(130);
  });
}

function normalizePrefix(prefix) {
  const namespaced = prefix.startsWith("cityscroll-") ? prefix : `cityscroll-${prefix}`;
  return namespaced.endsWith("-") ? namespaced : `${namespaced}-`;
}

/** Run `fn(dir)` against a fresh `cityscroll-<prefix>-` temp directory, removing it
 * afterward on success, on a thrown error, and on SIGTERM/SIGINT. */
export async function withTempDir(prefix, fn, options = {}) {
  installHandlers();
  const dir = await mkdtemp(join(tmpdir(), normalizePrefix(prefix)));
  active.add(dir);
  let callbackError;
  try {
    return await fn(dir);
  } catch (error) {
    callbackError = error;
    throw error;
  } finally {
    try {
      await removeDirAsync(dir, options);
      active.delete(dir);
    } catch (cleanupError) {
      // Keep `dir` in `active` so exit/SIGTERM can retry. Prefer the callback
      // error when both fired; otherwise surface the cleanup failure.
      if (!callbackError) throw cleanupError;
    }
  }
}

/** Synchronous counterpart of {@link withTempDir}, for callers that cannot await. */
export function withTempDirSync(prefix, fn, options = {}) {
  installHandlers();
  const dir = mkdtempSync(join(tmpdir(), normalizePrefix(prefix)));
  active.add(dir);
  let callbackError;
  try {
    return fn(dir);
  } catch (error) {
    callbackError = error;
    throw error;
  } finally {
    try {
      removeDirSync(dir, options);
      active.delete(dir);
    } catch (cleanupError) {
      if (!callbackError) throw cleanupError;
    }
  }
}

/** Test seam: directories still awaiting successful removal. */
export function listActiveTempDirsForTest() {
  return [...active];
}

/** Test seam: run the sync exit-path cleanup against the active set. */
export function forceCleanupActiveTempDirsForTest() {
  cleanupAllSync();
}
