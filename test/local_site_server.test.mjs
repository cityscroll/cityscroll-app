import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
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
  assert.match(server, /def publish_ready\(/);
  assert.match(server, /probe_base\(base\)/);
  assert.match(server, /urllib\.error\.URLError/);
  assert.match(server, /READINESS_TIMEOUT_SECONDS/);
  assert.match(server, /connection refused/);

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
  const serve = ci.indexOf("tools/local_site_server.py --directory _site --port 0");
  assert.ok(build >= 0 && build < serve, "CI must build the deploy artifact before serving it");
  assert.match(ci, /tools\/local_site_server\.py --directory _site --port 0 --ready-file/);
  assert.match(ci, /name: browser-pr-site-\$\{\{ github\.run_id \}\}/);
  assert.doesNotMatch(
    ci,
    /name: browser-pr-site-\$\{\{ github\.run_id \}\}-\$\{\{ github\.run_attempt \}\}/,
    "failed-job reruns must reuse the verified artifact from the original attempt",
  );
  assert.match(ci, /name: browser-pr-site-\$\{\{ github\.run_id \}\}[\s\S]*?overwrite: true/);
  assert.match(ci, /- name: Download shared verified site artifact\n\s+if: success\(\)/);
  assert.match(ci, /- name: Verify shared site artifact checksums\n\s+if: success\(\)/);
  assert.match(ci, /- name: Run isolated accessibility shard\n\s+if: success\(\)/);
  assert.match(ci, /readiness_url=\"\$\{local_base\}index\.html\"/);
  assert.match(ci, /curl --silent --show-error[^\n]*--connect-timeout 1[^\n]*\"\$readiness_url\"/);
  assert.match(ci, /HTTP 404/);
  assert.match(ci, /server_log=/);
  assert.match(ci, /for _ in \{1\.\.120\}/);
  assert.doesNotMatch(ci, /tools\/local_site_server\.py --directory _site --port 8000/);
  assert.doesNotMatch(ci, /python3 -m http\.server 8000 --directory _site/);
});

test("accessibility aggregate waits for complete shard results without a second artifact lookup", () => {
  const ci = read(".github/workflows/ci.yml");
  const aggregate = ci.slice(ci.indexOf("  a11y-pr:\n"), ci.indexOf("  browser-pr-site:\n"));
  const shards = ci.slice(ci.indexOf("  a11y-pr-shard:\n"), ci.indexOf("  reading-level:\n"));

  assert.match(aggregate, /needs:\s*\[changes,\s*unit,\s*a11y-pr-shard\]/);
  assert.match(aggregate, /needs\.a11y-pr-shard\.result != 'success'[\s\S]*?exit 1/);
  assert.match(aggregate, /needs\.a11y-pr-shard\.result == 'success'/);
  assert.doesNotMatch(
    aggregate,
    /actions\/download-artifact|github\.run_attempt|a11y-pr-shard-\*-logs/,
    "the verdict must not race an eventually consistent artifact-list query",
  );

  assert.match(shards, /fail-fast:\s*false/);
  assert.match(
    shards,
    /matrix:\s*\n\s*shard:\s*\[browser-a11y, routes-focus, language-layout, rendered-census\]/,
  );
  assert.match(shards, /name: a11y-pr-shard-\$\{\{ matrix\.shard \}\}-logs-\$\{\{ github\.run_id \}\}/);
  assert.doesNotMatch(shards, /a11y-pr-shard[^\n]*github\.run_attempt/);
  assert.match(shards, /if-no-files-found:\s*error/);
  assert.match(shards, /overwrite:\s*true/);
});

test("performance interaction waits for the canonical Contracts document URL", () => {
  const source = read("test/performance/verify.py");
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

  const readiness = await fetch(new URL("index.html", base));
  assert.equal(readiness.status, 200);
  const home = await fetch(new URL("", base));
  const homeBody = await home.text();
  assert.equal(home.status, 200);
  assert.match(homeBody, /data-primary-context="home" data-home-ready="true"/);
  assert.match(homeBody, /data-home-topic-entry/);
  assert.doesNotMatch(homeBody, /<section id="tab-money" class="tabpane active"/);

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

test("local site server does not publish readiness for an artifact without index.html", async (t) => {
  const temp = mkdtempSync(join(tmpdir(), "crol-local-site-empty-"));
  const ready = join(temp, "ready");
  const emptySite = join(temp, "site");
  mkdirSync(emptySite);
  const child = spawn("python3", [
    "tools/local_site_server.py",
    "--directory", emptySite,
    "--port", "0",
    "--ready-file", ready,
  ], { cwd: ROOT, stdio: "ignore" });
  t.after(() => rmSync(temp, { recursive: true, force: true }));

  const exitCode = await new Promise((resolve) => child.once("close", resolve));
  assert.notEqual(exitCode, 0);
  assert.equal(existsSync(ready), false);
});
