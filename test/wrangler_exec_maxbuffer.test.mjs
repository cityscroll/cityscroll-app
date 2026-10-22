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

test("runWrangler tears down the child when a stdio write fails with ENOSPC", async () => {
  // Defect: awaiting child close before stream promises left a full-disk write
  // hanging (producer blocked on a full pipe; close never fired). Fail closed
  // on stream EIO/ENOSPC and kill the child instead.
  const { Writable } = await import("node:stream");
  const enospc = Object.assign(new Error("ENOSPC: no space left on device, write"), {
    code: "ENOSPC",
  });
  const createWriteStreamFn = () => new Writable({
    write(_chunk, _enc, cb) {
      cb(enospc);
    },
  });

  const started = Date.now();
  await assert.rejects(
    () => runWrangler([], {
      command: process.execPath,
      // Keep writing forever so a hang would outlive the assertion timeout.
      commandArgs: ["-e", "setInterval(() => process.stdout.write('x'.repeat(65536)), 0)"],
      createWriteStreamFn,
    }),
    (error) => {
      assert.equal(error?.code, "ENOSPC");
      return true;
    },
  );
  assert.ok(
    Date.now() - started < 5000,
    "ENOSPC on stdio write must reject promptly instead of hanging on child close",
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
