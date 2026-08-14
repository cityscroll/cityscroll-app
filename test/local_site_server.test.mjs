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

test("full preflight and CI use the route-aware server without touching existing listeners", () => {
  const server = read("tools/local_site_server.py");
  assert.match(server, /def _static_document\(/);
  assert.match(server, /if self\._static_document\(route, query\):/);

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

  const ci = read(".github/workflows/ci.yml");
  const build = ci.indexOf("uses: ./.github/actions/build-site");
  const serve = ci.indexOf("tools/local_site_server.py --directory _site --port 8000");
  assert.ok(build >= 0 && build < serve, "CI must build the deploy artifact before serving it");
  assert.match(ci, /tools\/local_site_server\.py --directory _site --port 8000 --ready-file/);
  assert.match(ci, /curl --fail --silent --show-error \"\$local_base\"/);
  assert.doesNotMatch(ci, /python3 -m http\.server 8000 --directory _site/);
});

test("performance interaction waits for the canonical Contracts document URL", () => {
  const source = read("test/performance/verify.py");
  assert.match(source, /data-home-topic-entry/);
  assert.match(source, /topic\.getClientRects\(\)\.length > 0/);
  assert.doesNotMatch(source, /const listReady =/);
  assert.match(source, /location\.pathname === "\/browse\/contracts\/"/);
  assert.match(source, /new URLSearchParams\(location\.search\)\.get\("q"\) === "housing"/);
  assert.doesNotMatch(source, /location\.hash\.split\("\?"\).*get\("q"\)/);
});

test("standalone browser gates share the clean-route server", () => {
  for (const path of [
    "test/functional/15_rtl.py",
    "test/functional/16_forecast_discoverability.py",
    "test/functional/17_default_examples.py",
  ]) {
    const source = read(path);
    assert.match(source, /from tools\.local_site_server import QuietHandler/, path);
    assert.doesNotMatch(source, /http\.server\.SimpleHTTPRequestHandler/, path);
  }
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

  for (const route of ["now/", "browse/", "browse/rules/?q=air", "search/?q=mosquitos"]) {
    const clean = await fetch(new URL(route, base));
    assert.equal(clean.status, 200, route);
    assert.match(await clean.text(), /id="main"/, route);
  }
  const search = await fetch(new URL("search/?q=mosquitos", base));
  const searchBody = await search.text();
  assert.match(searchBody, /data-primary-context="search"/);
  assert.match(searchBody, /name="q"/);
  assert.match(searchBody, /data-search-lane="obligations"/);

  const agencyProfile = await fetch(new URL(
    "agencies/citywide-administrative-services/?tab=forecast",
    base,
  ));
  assert.equal(agencyProfile.status, 200);
  assert.match(await agencyProfile.text(), /id="entityview"/);
});
