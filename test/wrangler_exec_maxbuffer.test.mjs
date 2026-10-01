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

test("createWranglerInvoker matches the adapter seam and the bound exceeds 1 MiB", () => {
  const viaInvoker = createWranglerInvoker({});
  assert.equal(typeof viaInvoker, "function");
  assert.ok(WRANGLER_STDIO_MAX_BYTES > NODE_DEFAULT_STDIO_MAX_BUFFER_BYTES);
  assert.ok(WRANGLER_STDIO_MAX_BYTES >= 32 * 1024 * 1024);
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
