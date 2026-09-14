import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";

const ROOT = new URL("..", import.meta.url).pathname;
const CLASSIFIER = join(ROOT, "tools", "classify_a11y_browser_failure.sh");

function classify(log, status) {
  return new Promise(async (resolve, reject) => {
    const dir = await mkdtemp(join(tmpdir(), "a11y-classifier-"));
    const path = join(dir, "shard.log");
    await writeFile(path, log, "utf8");
    const child = spawn("bash", [CLASSIFIER, path, String(status)], { cwd: ROOT });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("close", async (code) => {
      await rm(dir, { recursive: true, force: true });
      resolve({ code, stdout: stdout.trim(), stderr: stderr.trim() });
    });
    child.on("error", reject);
  });
}

test("SIGSEGV with no axe result is a retryable browser crash", async () => {
  const result = await classify(
    "InitializeSandbox() called with multiple threads in process gpu-process\n<process did exit: exitCode=null, signal=SIGSEGV>\n",
    139,
  );
  assert.equal(result.code, 0);
  assert.equal(result.stdout, "browser-crashed");
});

test("an axe violation is not retryable even when the browser later crashes", async () => {
  const result = await classify(
    "FAIL home: color-contrast (serious)\naxe result: 1 violation\n<process did exit: exitCode=null, signal=SIGSEGV>\n",
    139,
  );
  assert.equal(result.code, 0);
  assert.equal(result.stdout, "test-failed");
});

test("ordinary shard failures are not retryable", async () => {
  const result = await classify("FAIL: rendered schema vocabulary\n", 1);
  assert.equal(result.code, 0);
  assert.equal(result.stdout, "test-failed");
});
