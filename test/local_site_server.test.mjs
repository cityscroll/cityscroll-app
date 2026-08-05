import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const ROOT = new URL("../", import.meta.url);
const read = (path) => readFileSync(new URL(path, ROOT), "utf8");

async function waitForReady(path, child) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`local server exited ${child.exitCode}`);
    try {
      const value = readFileSync(path, "utf8").trim();
      if (value) return value;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("local server did not publish its address");
}

test("full preflight allocates its own port without touching existing listeners", () => {
  const source = read("tools/preflight-required-checks.sh");
  assert.match(source, /tools\/local_site_server\.py/);
  assert.match(source, /CROL_TEST_PORT:-0/);
  assert.match(source, /export CROL_BASE/);
  assert.doesNotMatch(source, /lsof -tiTCP:8000|freeing port 8000/);

  const functional = read("test/functional/run.sh");
  assert.match(functional, /tools\/local_site_server\.py/);
  assert.match(functional, /CROL_TEST_PORT:-0/);
  assert.match(functional, /export CROL_BASE/);
  assert.doesNotMatch(functional, /http\.server 8000|lsof -tiTCP:8000/);
});

test("local site server publishes an OS-assigned origin and serves the requested tree", async (t) => {
  const temp = mkdtempSync(join(tmpdir(), "crol-local-site-"));
  const ready = join(temp, "ready");
  const child = spawn("python3", [
    "tools/local_site_server.py",
    "--directory", "site",
    "--port", "0",
    "--ready-file", ready,
  ], { cwd: ROOT, stdio: "ignore" });
  t.after(() => {
    child.kill("SIGTERM");
    rmSync(temp, { recursive: true, force: true });
  });

  const base = await waitForReady(ready, child);
  const url = new URL(base);
  assert.equal(url.hostname, "127.0.0.1");
  assert.ok(Number(url.port) > 0);
  const response = await fetch(new URL("near-you/index.html", base));
  assert.equal(response.status, 200);
  assert.match(await response.text(), /data-near-you-root/);

  const notice = await fetch(new URL("notices/20260701099", base));
  assert.equal(notice.status, 200);
  assert.match(await notice.text(), /id="noticeview"/);
});
