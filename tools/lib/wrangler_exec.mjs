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

function fail(message) {
  throw new Error(message);
}

async function streamToFile(readable, path) {
  const out = createWriteStream(path);
  readable.pipe(out);
  await finished(out);
}

/**
 * @param {string[]} args wrangler argv after the package name (e.g. ["d1","execute",…])
 * @param {{ wranglerVersion?: string, cwd?: string, env?: NodeJS.ProcessEnv, maxBytes?: number, command?: string, commandArgs?: string[] }} [options]
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
} = {}) {
  if (!Array.isArray(args)) fail("runWrangler requires an args array");
  const argv = commandArgs || [`wrangler@${wranglerVersion}`, ...args];
  const dir = mkdtempSync(join(tmpdir(), "wrangler-exec-"));
  const stdoutPath = join(dir, "stdout.txt");
  const stderrPath = join(dir, "stderr.txt");
  try {
    const child = spawn(command, argv, {
      cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdoutDone = streamToFile(child.stdout, stdoutPath);
    const stderrDone = streamToFile(child.stderr, stderrPath);
    const status = await new Promise((resolve, reject) => {
      child.on("error", reject);
      child.on("close", (code, signal) => {
        if (signal) reject(new Error(`${command} killed by signal ${signal}`));
        else resolve(code ?? 1);
      });
    });
    await Promise.all([stdoutDone, stderrDone]);

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
    rmSync(dir, { recursive: true, force: true });
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
