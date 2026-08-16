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
  const shardRunner = read("tools/run_a11y_ci_shard.sh");
  const build = ci.indexOf("uses: ./.github/actions/build-site");
  const runShard = ci.indexOf("tools/run_a11y_ci_shard.sh");
  assert.ok(build >= 0 && build < runShard, "CI must build the deploy artifact before running shards");
  assert.match(shardRunner, /tools\/local_site_server\.py[\s\\]*\n\s*--directory _site[\s\\]*\n\s*--port 0/);
  assert.match(shardRunner, /--ready-file "\$ready_file"/);
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
  assert.match(shardRunner, /readiness_url="\$\{local_base\}index\.html"/);
  assert.match(shardRunner, /curl --silent --show-error[^\n]*--connect-timeout 1[^\n]*"\$readiness_url"/);
  assert.match(shardRunner, /HTTP 404/);
  assert.match(shardRunner, /server_log=/);
  assert.match(shardRunner, /for _ in \{1\.\.120\}/);
  assert.doesNotMatch(shardRunner, /tools\/local_site_server\.py[\s\S]*?--port 8000/);
  assert.doesNotMatch(shardRunner, /python3 -m http\.server 8000 --directory _site/);
});

test("accessibility aggregate accepts only a green matrix and a green routes-focus attempt", () => {
  const ci = read(".github/workflows/ci.yml");
  const shardRunner = read("tools/run_a11y_ci_shard.sh");
  const aggregate = ci.slice(ci.indexOf("  a11y-pr:\n"), ci.indexOf("  browser-pr-site:\n"));
  const shards = ci.slice(ci.indexOf("  a11y-pr-shard:\n"), ci.indexOf("  a11y-routes-focus-primary:\n"));
  const routes = ci.slice(ci.indexOf("  a11y-routes-focus-primary:\n"), ci.indexOf("  reading-level:\n"));

  assert.match(
    aggregate,
    /needs:\s*\[changes,\s*unit,\s*a11y-pr-shard,\s*a11y-routes-focus-primary,\s*a11y-routes-focus-retry\]/,
  );
  assert.match(
    aggregate,
    /needs\.a11y-pr-shard\.result != 'success' \|\| \(needs\.a11y-routes-focus-primary\.result != 'success' && needs\.a11y-routes-focus-retry\.result != 'success'\)[\s\S]*?exit 1/,
  );
  assert.match(
    aggregate,
    /needs\.a11y-pr-shard\.result == 'success' && \(needs\.a11y-routes-focus-primary\.result == 'success' \|\| needs\.a11y-routes-focus-retry\.result == 'success'\)/,
  );
  assert.match(aggregate, /Routes-focus recovered on its one fresh-runner retry/);
  assert.doesNotMatch(
    aggregate,
    /actions\/download-artifact|github\.run_attempt|a11y-pr-shard-\*-logs/,
    "the verdict must not race an eventually consistent artifact-list query",
  );

  assert.match(shards, /fail-fast:\s*false/);
  assert.match(
    shards,
    /matrix:\s*\n\s*shard:\s*\[browser-a11y, language-layout, rendered-census\]/,
  );
  assert.doesNotMatch(shards, /shard:\s*\[[^\]]*routes-focus/);
  assert.match(
    shards,
    /name: a11y-pr-shard-\$\{\{ matrix\.shard \}\}-primary-logs-\$\{\{ github\.run_id \}\}/,
  );
  assert.doesNotMatch(shards, /a11y-pr-shard[^\n]*github\.run_attempt/);
  assert.match(shards, /if-no-files-found:\s*error/);
  assert.match(shards, /overwrite:\s*true/);

  assert.match(routes, /a11y-routes-focus-primary:[\s\S]*?runs-on: ubuntu-latest/);
  assert.match(
    routes,
    /a11y-routes-focus-primary:[\s\S]*?Fail when the shared site artifact is unavailable[\s\S]*?needs\.browser-pr-site\.result != 'success'[\s\S]*?exit 1/,
  );
  assert.match(
    routes,
    /a11y-routes-focus-retry:[\s\S]*?needs\.a11y-routes-focus-primary\.result == 'failure'[\s\S]*?runs-on: ubuntu-latest/,
  );
  assert.match(routes, /tools\/run_a11y_ci_shard\.sh routes-focus primary/);
  assert.match(routes, /tools\/run_a11y_ci_shard\.sh routes-focus fresh-runner-retry/);
  assert.match(routes, /a11y-pr-shard-routes-focus-primary-logs-\$\{\{ github\.run_id \}\}/);
  assert.match(
    routes,
    /a11y-pr-shard-routes-focus-fresh-runner-retry-logs-\$\{\{ github\.run_id \}\}/,
  );
  assert.doesNotMatch(routes, /continue-on-error/);

  assert.match(
    shardRunner,
    /# Keep axe and its final assertion outside the functional retry wrapper\.\n\s*python3 test\/functional\/11_accessibility\.py/,
  );
  assert.doesNotMatch(
    shardRunner,
    /run_a11y_functional_check\.sh[^\n]*11_accessibility\.py/,
    "axe must remain a direct assertion rather than a retried functional check",
  );

  const aggregateGreen = (matrix, primary, retry) => (
    matrix === "success" && (primary === "success" || retry === "success")
  );
  assert.equal(aggregateGreen("success", "success", "skipped"), true, "normal primary pass");
  assert.equal(aggregateGreen("success", "failure", "success"), true, "fresh-runner recovery");
  assert.equal(aggregateGreen("success", "failure", "failure"), false, "both routes attempts fail");
  assert.equal(aggregateGreen("failure", "success", "skipped"), false, "a non-route shard fails");
  assert.equal(aggregateGreen("success", "failure", "skipped"), false, "retry is missing");
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
