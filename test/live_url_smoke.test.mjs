// Characterization tests for the post-deploy live-URL smoke guard.
// Regression anchor: 2026-07-30 cityscroll.org ERR_TOO_MANY_REDIRECTS while deploy
// reported success (GitHub Pages CNAME 301 loop). Class boundaries: non-200, empty
// body, redirect loop, 200-with-error-page, healthy content.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  API_HEALTH_MARKER,
  CONTENT_MARKER,
  DEFAULT_TARGETS,
  PAGES_DEV_TARGETS,
  POST_FLIP_TARGETS,
  TARGET_SETS,
  TARGET_SET_NAMES,
  cacheBustUrl,
  classifyProbe,
  createFixtureFetch,
  formatFailure,
  formatStatusChain,
  probeUrl,
  resolveTargetSet,
  runSmoke,
  targetsFromCli,
} from "../tools/live_url_smoke.mjs";

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");
const fieldCase = JSON.parse(read("./fixtures/live_url_smoke/field-case-2026-07-30.json"));
const variants = JSON.parse(read("./fixtures/live_url_smoke/variants.json"));

test("field-case fixture documents the 2026-07-30 redirect-loop outage verbatim", () => {
  assert.equal(fieldCase.id, "cityscroll-redirect-loop-2026-07-30");
  assert.match(fieldCase.description, /2026-07-30/);
  assert.match(fieldCase.description, /ERR_TOO_MANY_REDIRECTS/);
  assert.match(fieldCase.description, /deploy pipeline reported success/);
  assert.match(fieldCase.description, /GitHub Pages CNAME/);
  assert.equal(fieldCase.observed, "ERR_TOO_MANY_REDIRECTS");
  assert.deepEqual(fieldCase.hosts, ["https://cityscroll.org/", "https://crol-list.org/"]);
  assert.equal(fieldCase.redirect_loop["https://cityscroll.org/"].status, 301);
  assert.equal(fieldCase.redirect_loop["https://cityscroll.org/"].location, "https://crol-list.org/");
  assert.equal(fieldCase.redirect_loop["https://crol-list.org/"].status, 301);
  assert.equal(fieldCase.redirect_loop["https://crol-list.org/"].location, "https://cityscroll.org/");
});

test("field-case redirect loop fails with URL + status chain + body snippet diagnostic", async () => {
  const fetchImpl = createFixtureFetch(fieldCase.redirect_loop);
  const result = await probeUrl("https://cityscroll.org/", {
    fetchImpl,
    cacheBust: true,
    now: 1_700_000_000_000,
  });

  assert.equal(result.classification.ok, false);
  assert.match(result.classification.reason, /redirect loop/i);

  const diagnostic = formatFailure({
    url: result.url,
    statusChain: result.statusChain,
    body: result.body,
    reason: result.classification.reason,
  });
  assert.match(diagnostic, /LIVE URL SMOKE FAIL: https:\/\/cityscroll\.org\//);
  assert.match(diagnostic, /status chain:/);
  assert.match(diagnostic, /301/);
  assert.match(diagnostic, /body snippet:/);
  // Chain must name both hosts involved in the loop.
  const chain = formatStatusChain(result.statusChain);
  assert.match(chain, /cityscroll\.org|crol-list\.org/);
});

test("class-boundary fixtures pin fail/pass shapes", async () => {
  for (const c of variants.cases) {
    const fetchImpl = createFixtureFetch(c.hops);
    const result = await probeUrl(c.url || "https://cityscroll.org/", {
      fetchImpl,
      cacheBust: false,
    });
    if (c.expect === "pass") {
      assert.equal(result.classification.ok, true, `${c.id}: ${result.classification.reason}`);
    } else {
      assert.equal(result.classification.ok, false, `${c.id} should fail`);
      assert.match(
        result.classification.reason,
        new RegExp(c.reason_match, "i"),
        `${c.id}: got ${result.classification.reason}`,
      );
    }
  }
});

test("classifyProbe rejects empty body, non-200, and marker-less error shells", () => {
  assert.equal(
    classifyProbe({ statusChain: [{ status: 200 }], finalStatus: 200, body: "" }).ok,
    false,
  );
  assert.match(
    classifyProbe({ statusChain: [{ status: 502 }], finalStatus: 502, body: "Bad gateway" }).reason,
    /final status 502/,
  );
  assert.match(
    classifyProbe({
      statusChain: [{ status: 200 }],
      finalStatus: 200,
      body: "<title>404 Not Found</title><p>Page not found</p>",
    }).reason,
    /error-page body/,
  );
  assert.equal(
    classifyProbe({
      statusChain: [{ status: 200 }],
      finalStatus: 200,
      body: "<title>CityScroll</title>",
      marker: CONTENT_MARKER,
    }).ok,
    true,
  );
});

test("field case: live smoke fails on unsubstituted __I18N_ASSET_VERSION__ (and any __TOKEN__)", () => {
  // Symptom (2026-07-30): homepage served src="i18n.js?v=__I18N_ASSET_VERSION__".
  const result = classifyProbe({
    statusChain: [{ status: 200 }],
    finalStatus: 200,
    body: '<title>CityScroll</title><script src="i18n.js?v=__I18N_ASSET_VERSION__"></script>',
    marker: CONTENT_MARKER,
  });
  assert.equal(result.ok, false);
  assert.match(result.reason, /unsubstituted build placeholder __I18N_ASSET_VERSION__/);
  assert.equal(
    classifyProbe({
      statusChain: [{ status: 200 }],
      finalStatus: 200,
      body: '<title>CityScroll</title><script src="i18n.js?v=c4609cdfa552"></script>',
      marker: CONTENT_MARKER,
    }).ok,
    true,
  );
});

test("cache-bust query is applied so stale redirect caches cannot false-green", () => {
  const busted = cacheBustUrl("https://cityscroll.org/about.html", 42);
  assert.match(busted, /_smoke=42/);
  assert.match(busted, /^https:\/\/cityscroll\.org\/about\.html\?/);
});

test("runSmoke passes quickly when content is healthy", async () => {
  const healthy = variants.cases.find((c) => c.id === "healthy-cityscroll-200");
  const fetchImpl = createFixtureFetch(healthy.hops);
  let sleeps = 0;
  const result = await runSmoke({
    targets: [{ id: "apex", url: "https://cityscroll.org/", marker: CONTENT_MARKER }],
    fetchImpl,
    timeoutMs: 60_000,
    intervalMs: 1_000,
    cacheBust: false,
    sleep: async () => {
      sleeps += 1;
    },
  });
  assert.equal(result.ok, true);
  assert.equal(result.attempts, 1);
  assert.equal(sleeps, 0);
});

test("runSmoke retries then fails with named diagnostics after the window", async () => {
  const fetchImpl = createFixtureFetch([{ status: 503, body: "Service Unavailable" }]);
  let now = 0;
  const result = await runSmoke({
    targets: [{ id: "apex", url: "https://cityscroll.org/" }],
    fetchImpl,
    timeoutMs: 100,
    intervalMs: 40,
    cacheBust: false,
    now: () => now,
    sleep: async (ms) => {
      now += ms;
    },
  });
  assert.equal(result.ok, false);
  assert.ok(result.attempts >= 2, `expected retries, got ${result.attempts}`);
  assert.match(result.failures.join("\n"), /LIVE URL SMOKE FAIL: https:\/\/cityscroll\.org\//);
  assert.match(result.failures.join("\n"), /503/);
});

test("default targets cover both public apex hosts, www, and a deep route", () => {
  const urls = DEFAULT_TARGETS.map((t) => t.url);
  assert.ok(urls.includes("https://cityscroll.org/"));
  assert.ok(urls.includes("https://www.cityscroll.org/"));
  assert.ok(urls.includes("https://crol-list.org/"));
  assert.ok(urls.some((u) => u.includes("about.html")));
  // Parallel host and post-flip matrix stay off the deploy default.
  assert.ok(!urls.includes("https://cityscroll.pages.dev/"));
  assert.ok(!urls.includes("https://api.cityscroll.org/health"));
});

test("named smoke target sets: pages-dev and post-flip are selectable and dormant", () => {
  assert.deepEqual([...TARGET_SET_NAMES].sort(), ["default", "pages-dev", "post-flip"].sort());
  assert.equal(TARGET_SETS.default, DEFAULT_TARGETS);
  assert.equal(resolveTargetSet("default"), DEFAULT_TARGETS);
  assert.equal(resolveTargetSet("pages-dev"), PAGES_DEV_TARGETS);
  assert.equal(resolveTargetSet("post-flip"), POST_FLIP_TARGETS);
  assert.equal(resolveTargetSet("PAGES-DEV"), PAGES_DEV_TARGETS);

  const pagesDevUrls = PAGES_DEV_TARGETS.map((t) => t.url);
  assert.deepEqual(pagesDevUrls, [
    "https://cityscroll.pages.dev/",
    "https://cityscroll.pages.dev/about.html",
  ]);

  const postFlipUrls = POST_FLIP_TARGETS.map((t) => t.url);
  assert.deepEqual(postFlipUrls, [
    "https://cityscroll.org/",
    "https://www.cityscroll.org/",
    "https://cityscroll.org/about.html",
    "https://crol-list.org/",
    "https://api.cityscroll.org/health",
    "https://api.cityscroll.org/stats",
    "https://cityscroll.pages.dev/",
  ]);
  const api = POST_FLIP_TARGETS.find((t) => t.id === "post-flip-api-health");
  assert.equal(api.marker, API_HEALTH_MARKER);
  const stats = POST_FLIP_TARGETS.find((t) => t.id === "post-flip-api-stats");
  assert.match(String(stats.marker), /public-stats/);
  const apex = POST_FLIP_TARGETS.find((t) => t.id === "post-flip-cityscroll-apex");
  assert.deepEqual([...apex.requireAbsentHeaders], ["x-github-request-id"]);
  const www = POST_FLIP_TARGETS.find((t) => t.id === "post-flip-cityscroll-www");
  assert.deepEqual([...www.requireAbsentHeaders], ["x-github-request-id"]);

  assert.throws(() => resolveTargetSet("not-a-set"), /unknown smoke target set/);
});

test("targetsFromCli selects named sets; --url and --base-url still take precedence", () => {
  assert.equal(targetsFromCli({}), DEFAULT_TARGETS);
  assert.equal(targetsFromCli({ targetSet: "pages-dev" }), PAGES_DEV_TARGETS);
  assert.equal(targetsFromCli({ targetSet: "post-flip" }), POST_FLIP_TARGETS);

  const fromBase = targetsFromCli({ baseUrl: "https://cityscroll.pages.dev", targetSet: "post-flip" });
  assert.deepEqual(
    fromBase.map((t) => t.url),
    ["https://cityscroll.pages.dev/", "https://cityscroll.pages.dev/about.html"],
  );

  const fromUrls = targetsFromCli({
    urls: ["https://example.test/x"],
    targetSet: "pages-dev",
  });
  assert.equal(fromUrls[0].url, "https://example.test/x");
  assert.equal(fromUrls[0].marker, CONTENT_MARKER);
});

test("post-flip header assertion fails when x-github-request-id is still present", () => {
  const withGithubHeader = classifyProbe({
    statusChain: [{ status: 200 }],
    finalStatus: 200,
    body: "<title>CityScroll</title>",
    marker: CONTENT_MARKER,
    finalHeaders: { "x-github-request-id": "ABC123" },
    requireAbsentHeaders: ["x-github-request-id"],
  });
  assert.equal(withGithubHeader.ok, false);
  assert.match(withGithubHeader.reason, /x-github-request-id/i);

  const pagesPrimary = classifyProbe({
    statusChain: [{ status: 200 }],
    finalStatus: 200,
    body: "<title>CityScroll</title>",
    marker: CONTENT_MARKER,
    finalHeaders: { "cf-ray": "xyz" },
    requireAbsentHeaders: ["x-github-request-id"],
  });
  assert.equal(pagesPrimary.ok, true);

  const apiHealth = classifyProbe({
    statusChain: [{ status: 200 }],
    finalStatus: 200,
    body: "crol-worker ok",
    marker: API_HEALTH_MARKER,
  });
  assert.equal(apiHealth.ok, true);
});

test("probeUrl applies requireAbsentHeaders from the target", async () => {
  const fetchImpl = createFixtureFetch([
    {
      status: 200,
      body: "<title>CityScroll</title>",
      headers: { "x-github-request-id": "still-on-pages" },
    },
  ]);
  const result = await probeUrl("https://cityscroll.org/", {
    fetchImpl,
    cacheBust: false,
    requireAbsentHeaders: ["x-github-request-id"],
  });
  assert.equal(result.classification.ok, false);
  assert.match(result.classification.reason, /x-github-request-id/i);
});

test("deploy-pages and deploy-worker run the live-URL smoke after deploy", () => {
  const pages = readFileSync(new URL("../.github/workflows/deploy-pages.yml", import.meta.url), "utf8");
  const worker = readFileSync(new URL("../.github/workflows/deploy-worker.yml", import.meta.url), "utf8");

  for (const [name, workflow] of [["deploy-pages", pages], ["deploy-worker", worker]]) {
    assert.match(workflow, /live_url_smoke\.mjs/, `${name} must invoke the smoke tool`);
    assert.match(workflow, /needs:\s*deploy/, `${name} smoke job must run after deploy`);
    // Failure must fail the workflow (default step failure); no continue-on-error.
    const smokeBlock = workflow.slice(workflow.indexOf("live_url_smoke"));
    assert.doesNotMatch(
      smokeBlock.slice(0, 400),
      /continue-on-error:\s*true/,
      `${name} must not soft-pass smoke failures`,
    );
    // Deploy gates must not auto-select the post-flip matrix (owner flip is separate).
    assert.doesNotMatch(
      smokeBlock.slice(0, 600),
      /--set\s+post-flip/,
      `${name} must not run post-flip set until cutover is authorized`,
    );
  }
});
