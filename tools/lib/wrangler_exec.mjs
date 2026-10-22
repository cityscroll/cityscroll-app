/**
 * Run `npx wrangler@…` without Node's default 1 MiB stdio maxBuffer.
 *
 * Deploy worker 36921583269 failed mid "Publish and verify bounded D1 delta"
 * with RangeError ERR_CHILD_PROCESS_STDIO_MAXBUFFER: a single `wrangler d1
 * execute` wrote more than 1 MiB to stdout while tools captured it via
 * promisified execFile with no maxBuffer override.
 *
 * This helper streams stdout/stderr to temp files, then returns the text. The
 * optional maxBytes ceiling fails closed with the measured size if a command
 * somehow exceeds the bound (defense in depth; streaming itself has no
 * maxBuffer).
 *
 * On stream write EIO/ENOSPC: tear down the child (SIGTERM, then SIGKILL),
 * await the real stdio `close` (not merely process `exit`), preserve the
 * original stream error, and only then remove the temp capture directory.
 * Do not treat `child.killed` as "exited" — in Node it only means a signal
 * was sent. exitCode/signalCode can be set on `exit` before stdio `close`.
 */

import { spawn } from "node:child_process";
import { createWriteStream, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { finished } from "node:stream/promises";

/** Node's undocumented default for execFile/execSync when maxBuffer is omitted. */
export const NODE_DEFAULT_STDIO_MAX_BUFFER_BYTES = 1024 * 1024;

/**
 * Bound for retained wrangler stdout/stderr after streaming to disk.
 * Sized above the largest D1 execute JSON dumps observed in production deploys
 * while remaining well under CI disk pressure for a single invocation.
 */
export const WRANGLER_STDIO_MAX_BYTES = 32 * 1024 * 1024;

const CLOSE_PROMISE = Symbol("cityscroll.wranglerClosePromise");
const TERMINATE_PROMISE = Symbol("cityscroll.wranglerTerminatePromise");

function fail(message) {
  throw new Error(message);
}

/** One shared promise per child that resolves on stdio `close` (after exit). */
function observeChildClose(child) {
  if (!child) return Promise.resolve({ code: null, signal: null });
  if (child[CLOSE_PROMISE]) return child[CLOSE_PROMISE];
  child[CLOSE_PROMISE] = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
  return child[CLOSE_PROMISE];
}

function processHasExited(child) {
  return child != null && (child.exitCode != null || child.signalCode != null);
}

/**
 * Signal a child, or its whole process group when spawned detached.
 * Group kill drains npx wrappers and TERM-ignoring grandchildren.
 */
function signalChild(child, sig, { processGroup = false } = {}) {
  if (!child) return;
  try {
    if (processGroup && process.platform !== "win32" && child.pid) {
      process.kill(-child.pid, sig);
      return;
    }
  } catch {
    // Fall through to leader-only kill when the group is already gone.
  }
  try {
    child.kill(sig);
  } catch {
    // Child may already be gone.
  }
}

/**
 * Idempotent termination: one TERM/KILL timer chain per child. Always awaits
 * the shared close promise — never returns early just because exitCode is set
 * (exit can precede stdio close). Clears the SIGKILL timer when close wins.
 */
function terminateChild(child, { termTimeoutMs = 1000, processGroup = false } = {}) {
  if (!child) return Promise.resolve();
  if (child[TERMINATE_PROMISE]) return child[TERMINATE_PROMISE];

  child[TERMINATE_PROMISE] = (async () => {
    const closed = observeChildClose(child);
    // Process-group path: leaders can exit on TERM while TERM-ignoring
    // grandchildren remain. When the leader is still alive, wait the grace
    // window then SIGKILL the group. When already exited (success/finally),
    // only best-effort SIGKILL any leftover group members — no grace wait.
    if (processGroup) {
      if (!processHasExited(child)) {
        signalChild(child, "SIGTERM", { processGroup: true });
        await new Promise((resolve) => {
          const timer = setTimeout(resolve, termTimeoutMs);
          timer.unref?.();
        });
      }
      try {
        signalChild(child, "SIGKILL", { processGroup: true });
      } catch {
        // Group may already be gone.
      }
      await closed;
      return;
    }

    let timer = null;
    const timedOut = new Promise((resolve) => {
      timer = setTimeout(() => resolve(true), termTimeoutMs);
      timer.unref?.();
    });
    // Send TERM only while the OS process may still be alive.
    if (!processHasExited(child)) {
      signalChild(child, "SIGTERM", { processGroup: false });
    }
    const winner = await Promise.race([
      closed.then(() => "closed"),
      timedOut.then(() => "timeout"),
    ]);
    if (timer) clearTimeout(timer);
    if (winner === "timeout") {
      if (!processHasExited(child)) {
        signalChild(child, "SIGKILL", { processGroup: false });
      }
      await closed;
    }
  })();

  return child[TERMINATE_PROMISE];
}

async function streamToFile(readable, path, createWriteStreamFn) {
  const out = createWriteStreamFn(path);
  readable.pipe(out);
  try {
    await finished(out);
  } catch (error) {
    readable.unpipe(out);
    readable.destroy();
    out.destroy();
    throw error;
  }
}

/**
 * @param {string[]} args wrangler argv after the package name (e.g. ["d1","execute",…])
 * @param {{ wranglerVersion?: string, cwd?: string, env?: NodeJS.ProcessEnv, maxBytes?: number, command?: string, commandArgs?: string[], createWriteStreamFn?: typeof createWriteStream, termTimeoutMs?: number, onSpawn?: Function, signal?: AbortSignal|null, processGroup?: boolean }} [options]
 * @returns {Promise<{ stdout: string, stderr: string, status: number }>}
 */
export async function runWrangler(args, {
  wranglerVersion = "4.126.0",
  cwd = process.cwd(),
  env = process.env,
  maxBytes = WRANGLER_STDIO_MAX_BYTES,
  // Test seams: run an arbitrary command with the same stream-to-file capture.
  command = "npx",
  commandArgs = null,
  createWriteStreamFn = createWriteStream,
  termTimeoutMs = 1000,
  onSpawn = null,
  signal = null,
  // Detached process-group leader so abort drains wrappers/grandchildren.
  processGroup = process.platform !== "win32",
} = {}) {
  if (!Array.isArray(args)) fail("runWrangler requires an args array");
  if (signal?.aborted) {
    const error = new Error("deployment acquisition was cancelled");
    error.name = "AbortError";
    throw error;
  }
  const argv = commandArgs || [`wrangler@${wranglerVersion}`, ...args];
  const dir = mkdtempSync(join(tmpdir(), "wrangler-exec-"));
  const stdoutPath = join(dir, "stdout.txt");
  const stderrPath = join(dir, "stderr.txt");
  let child = null;
  let streamError = null;
  let aborted = false;
  const onAbort = () => {
    aborted = true;
    void terminateChild(child, { termTimeoutMs, processGroup });
  };
  signal?.addEventListener?.("abort", onAbort, { once: true });
  try {
    child = spawn(command, argv, {
      cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
      detached: processGroup,
    });
    const closed = observeChildClose(child);
    if (typeof onSpawn === "function") onSpawn(child, dir);
    if (signal?.aborted) onAbort();

    // Await close and stream finishes together. A write EIO/ENOSPC must kill the
    // child so close fires — awaiting close first hangs when the producer blocks
    // on a full pipe after the capture stream stops draining.
    const kickTerminate = () => {
      void terminateChild(child, { termTimeoutMs, processGroup });
    };
    const stdoutDone = streamToFile(child.stdout, stdoutPath, createWriteStreamFn).catch((error) => {
      streamError = streamError || error;
      kickTerminate();
      throw error;
    });
    const stderrDone = streamToFile(child.stderr, stderrPath, createWriteStreamFn).catch((error) => {
      streamError = streamError || error;
      kickTerminate();
      throw error;
    });
    const closedStatus = closed.then(({ code, signal: exitSignal }) => {
      if (aborted || signal?.aborted) {
        const error = new Error("deployment acquisition was cancelled");
        error.name = "AbortError";
        throw error;
      }
      if (exitSignal) {
        const error = new Error(`${command} killed by signal ${exitSignal}`);
        error.signal = exitSignal;
        throw error;
      }
      return code ?? 1;
    });
    let status;
    try {
      const settled = await Promise.all([closedStatus, stdoutDone, stderrDone]);
      status = settled[0];
    } catch (error) {
      await terminateChild(child, { termTimeoutMs, processGroup });
      if (aborted || signal?.aborted) {
        const cancel = new Error("deployment acquisition was cancelled");
        cancel.name = "AbortError";
        cancel.cause = streamError || error;
        throw cancel;
      }
      // Prefer the stream failure (ENOSPC/EIO) over a follow-on signal rejection.
      throw streamError || error;
    }

    const stdoutBytes = statSync(stdoutPath).size;
    const stderrBytes = statSync(stderrPath).size;
    if (stdoutBytes > maxBytes) {
      fail(
        `wrangler stdout exceeded bound: size=${stdoutBytes} bytes `
        + `(${(stdoutBytes / 1024 / 1024).toFixed(6)} MiB) limit=${maxBytes} bytes `
        + `(${(maxBytes / 1024 / 1024).toFixed(6)} MiB)`,
      );
    }
    if (stderrBytes > maxBytes) {
      fail(
        `wrangler stderr exceeded bound: size=${stderrBytes} bytes `
        + `(${(stderrBytes / 1024 / 1024).toFixed(6)} MiB) limit=${maxBytes} bytes `
        + `(${(maxBytes / 1024 / 1024).toFixed(6)} MiB)`,
      );
    }

    const stdout = readFileSync(stdoutPath, "utf8");
    const stderr = readFileSync(stderrPath, "utf8");
    if (status !== 0) {
      const error = new Error(
        `wrangler exited ${status}${stderr.trim() ? `: ${stderr.trim().slice(0, 2000)}` : ""}`,
      );
      error.status = status;
      error.stdout = stdout;
      error.stderr = stderr;
      throw error;
    }
    return { stdout, stderr, status };
  } finally {
    signal?.removeEventListener?.("abort", onAbort);
    try {
      await terminateChild(child, { termTimeoutMs, processGroup });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
}

/** Default invoke used by D1 wrangler adapters: (args) => runWrangler(args, …). */
export function createWranglerInvoker({
  wranglerVersion = "4.126.0",
  cwd = process.cwd(),
  env = process.env,
  maxBytes = WRANGLER_STDIO_MAX_BYTES,
} = {}) {
  return (args) => runWrangler(args, { wranglerVersion, cwd, env, maxBytes });
}
