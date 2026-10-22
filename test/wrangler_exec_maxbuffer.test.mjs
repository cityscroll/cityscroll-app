import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import test from "node:test";

import {
  NODE_DEFAULT_STDIO_MAX_BUFFER_BYTES,
  WRANGLER_STDIO_MAX_BYTES,
  createWranglerInvoker,
  runWrangler,
} from "../tools/lib/wrangler_exec.mjs";

const execFileAsync = promisify(execFile);
const OVER_DEFAULT = NODE_DEFAULT_STDIO_MAX_BUFFER_BYTES + (256 * 1024);

test("Node's default execFile maxBuffer is 1 MiB", () => {
  assert.equal(NODE_DEFAULT_STDIO_MAX_BUFFER_BYTES, 1024 * 1024);
});

test("the stream-to-file wrangler runner retains stdout larger than 1 MiB", async () => {
  assert.ok(OVER_DEFAULT > NODE_DEFAULT_STDIO_MAX_BUFFER_BYTES);
  assert.ok(OVER_DEFAULT < WRANGLER_STDIO_MAX_BYTES);

  // Bare promisified execFile (the pre-fix D1 path) dies on >1 MiB stdout.
  await assert.rejects(
    () => execFileAsync(
      process.execPath,
      ["-e", `process.stdout.write("x".repeat(${OVER_DEFAULT}))`],
      { encoding: "utf8" },
    ),
    (error) => {
      assert.equal(error.code, "ERR_CHILD_PROCESS_STDIO_MAXBUFFER");
      return true;
    },
  );

  // The shared helper streams to a file, so the same payload succeeds.
  const result = await runWrangler([], {
    command: process.execPath,
    commandArgs: ["-e", `process.stdout.write("x".repeat(${OVER_DEFAULT})); process.stderr.write("ok");`],
  });
  assert.equal(result.status, 0);
  assert.equal(result.stdout.length, OVER_DEFAULT);
  assert.equal(result.stderr, "ok");
});

test("createWranglerInvoker matches the adapter seam and the bound stays 32 MiB", () => {
  const viaInvoker = createWranglerInvoker({});
  assert.equal(typeof viaInvoker, "function");
  assert.ok(WRANGLER_STDIO_MAX_BYTES > NODE_DEFAULT_STDIO_MAX_BUFFER_BYTES);
  assert.equal(WRANGLER_STDIO_MAX_BYTES, 32 * 1024 * 1024);
});

test("runWrangler fails closed when retained stdout exceeds the 32 MiB bound", async () => {
  // Mirrors Deploy worker 37399462266: wrangler d1 execute --json dumped
  // ~68 MiB for one unpaged partition SELECT. Keep the bound; page the scan.
  const overBound = WRANGLER_STDIO_MAX_BYTES + 1;
  await assert.rejects(
    () => runWrangler([], {
      command: process.execPath,
      commandArgs: ["-e", `process.stdout.write("x".repeat(${overBound}))`],
    }),
    (error) => {
      assert.match(String(error?.message || error), /wrangler stdout exceeded bound/);
      assert.match(String(error?.message || error), new RegExp(`limit=${WRANGLER_STDIO_MAX_BYTES}`));
      return true;
    },
  );
});

test("runWrangler reaps a SIGTERM-ignoring child after ENOSPC and preserves the stream error", async () => {
  // Defects:
  // 1) awaiting child close before stream promises hung on full-disk writes;
  // 2) killChild skipped SIGKILL once child.killed was true after SIGTERM
  //    (Node: killed means signal sent, not that the process exited);
  // 3) finally removed the temp dir and returned before the child was reaped.
  // Keep the 32 MiB bound. Fail closed on ENOSPC/EIO with the original stream
  // error, escalate to SIGKILL, await close, then clean up.
  const { Writable } = await import("node:stream");
  const { existsSync } = await import("node:fs");
  const enospc = Object.assign(new Error("ENOSPC: no space left on device, write"), {
    code: "ENOSPC",
  });
  const createWriteStreamFn = () => new Writable({
    write(_chunk, _enc, cb) {
      cb(enospc);
    },
  });

  let spawnedPid = null;
  let captureDir = null;
  const started = performance.now(); // test-clock: allow-real-clock hang bound for teardown
  await assert.rejects(
    () => runWrangler([], {
      command: process.execPath,
      // Ignore SIGTERM; swallow EPIPE; keep writing so a hang would outlive us.
      commandArgs: ["-e", `
        process.on("SIGTERM", () => {});
        process.stdout.on("error", () => {});
        setInterval(() => {
          try { process.stdout.write("x".repeat(65536)); } catch (_) {}
        }, 0);
      `],
      createWriteStreamFn,
      termTimeoutMs: 50,
      onSpawn(child, dir) {
        spawnedPid = child.pid;
        captureDir = dir;
      },
    }),
    (error) => {
      assert.equal(error?.code, "ENOSPC", `must preserve stream error, got ${error}`);
      return true;
    },
  );
  assert.ok(
    performance.now() - started < 5000, // test-clock: allow-real-clock hang bound for teardown
    "ENOSPC must reject promptly instead of hanging on child close",
  );
  assert.ok(spawnedPid, "onSpawn must observe the child pid");
  // Child must be reaped — kill(pid, 0) throws ESRCH when gone.
  assert.throws(
    () => process.kill(spawnedPid, 0),
    (error) => error?.code === "ESRCH",
    `child pid ${spawnedPid} must be reaped after ENOSPC teardown`,
  );
  assert.equal(
    captureDir && existsSync(captureDir),
    false,
    "temp capture dir must be removed only after the child is reaped",
  );
});

test("D1 wrangler adapters use the shared invoker instead of bare execFileAsync", async () => {
  const { readFileSync } = await import("node:fs");
  const paths = [
    "tools/d1_production_delta.mjs",
    "tools/d1_generation_fence.mjs",
    "tools/d1_bounded_publisher.mjs",
    "tools/d1_publication_receipt.mjs",
  ];
  for (const path of paths) {
    const text = readFileSync(path, "utf8");
    assert.match(text, /createWranglerInvoker/, `${path} must use createWranglerInvoker`);
    assert.doesNotMatch(
      text,
      /execFileAsync\("npx"/,
      `${path} must not keep the default execFileAsync npx wrangler invoke`,
    );
    assert.doesNotMatch(text, /from "node:child_process"/, `${path} should not import child_process directly`);
  }
});
