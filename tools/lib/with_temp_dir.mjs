// Leak-safe scratch directories for tests and tools.
//
// `mkdtemp(join(tmpdir(), "prefix-"))` on its own only gets removed if the
// caller remembers to rm it back out, and a plain `try/finally` around that
// rm still leaves the directory behind when the process is killed by a gate
// timeout (SIGTERM) before the finally block runs. `withTempDir` fixes both:
// every directory it hands out carries a `cityscroll-<prefix>-` name so a
// leak is attributable, and cleanup also runs from `process.on("exit"/
// "SIGTERM"/"SIGINT")` so an interrupted run does not leave its directory.

import { mkdtemp, rm } from "node:fs/promises";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const active = new Set();
let handlersInstalled = false;

function cleanupAllSync() {
  for (const dir of active) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // best effort - the directory may already be gone
    }
    active.delete(dir);
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
export async function withTempDir(prefix, fn) {
  installHandlers();
  const dir = await mkdtemp(join(tmpdir(), normalizePrefix(prefix)));
  active.add(dir);
  try {
    return await fn(dir);
  } finally {
    active.delete(dir);
    await rm(dir, { recursive: true, force: true });
  }
}

/** Synchronous counterpart of {@link withTempDir}, for callers that cannot await. */
export function withTempDirSync(prefix, fn) {
  installHandlers();
  const dir = mkdtempSync(join(tmpdir(), normalizePrefix(prefix)));
  active.add(dir);
  try {
    return fn(dir);
  } finally {
    active.delete(dir);
    rmSync(dir, { recursive: true, force: true });
  }
}
