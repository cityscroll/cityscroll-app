import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  CUTOVER_TARGETS,
  architectureFailures,
  pagesHeaderFailure,
  runCutoverRegression,
} from "../tools/cutover_regression.mjs";
import { ROUTE_INVENTORY } from "../tools/pages_route_parity.mjs";
import { PUBLIC_STATS_SCHEMA, buildPublicStatsBody } from "../worker/src/stats.mjs";
import { extractFn } from "./contract/site_extract.mjs";

const publicStats = () => buildPublicStatsBody(null, new Date("2026-09-09T00:00:00Z"));
const statsResult = (body) => ({
  id: "api-worker-stats",
  classification: { ok: true },
  body: JSON.stringify(body),
});
const statsFailures = (body) => architectureFailures([statsResult(body)])
  .filter((failure) => failure.startsWith("api-worker-stats:"));

const pagesHeaders = {
  server: "cloudflare",
  "cache-control": "public, max-age=0, must-revalidate",
  "x-content-type-options": "nosniff",
};

function response(status, body, headers = {}) {
  return {
    status,
    headers: new Headers(headers),
    text: async () => body,
  };
}

function healthyFetch(url) {
  const parsed = new URL(url);
  if (parsed.hostname === "api.cityscroll.org" && parsed.pathname === "/stats") {
    return Promise.resolve(response(200, JSON.stringify(publicStats()),
      { server: "cloudflare", "content-type": "application/json" }));
  }
  if (parsed.hostname === "api.cityscroll.org") {
    return Promise.resolve(response(200, "cityscroll-worker ok", { server: "cloudflare" }));
  }
  if (parsed.pathname === "/robots.txt") {
    return Promise.resolve(response(200, "Sitemap: https://cityscroll.org/sitemap.xml", pagesHeaders));
  }
  if (parsed.pathname === "/sitemap.xml") {
    return Promise.resolve(response(200, "<urlset><url /></urlset>", pagesHeaders));
  }
  return Promise.resolve(response(200, "<title>CityScroll</title>", pagesHeaders));
}

test("cutover target matrix covers every public route and each retained service", () => {
  const ids = new Set(CUTOVER_TARGETS.map((target) => target.id));
  for (const route of ROUTE_INVENTORY) assert.ok(ids.has(`pages-apex-${route.id}`));
  for (const id of [
    "pages-www-home",
    "pages-dev-home",
    "api-worker-health",
    "api-worker-stats",
    "legacy-origin",
  ]) assert.ok(ids.has(id));
});

test("healthy Pages-primary architecture passes", async () => {
  const result = await runCutoverRegression({
    fetchImpl: healthyFetch,
    timeoutMs: 0,
    now: () => 1_785_755_000_000,
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.failures, []);
});

test("public host fails when a GitHub Pages origin header reappears", async () => {
  const fetchImpl = async (url) => {
    const parsed = new URL(url);
    if (parsed.hostname === "cityscroll.org" && parsed.pathname === "/") {
      return response(200, "<title>CityScroll</title>", {
        server: "GitHub.com",
        "x-github-request-id": "regression",
      });
    }
    return healthyFetch(url);
  };
  const result = await runCutoverRegression({ fetchImpl, timeoutMs: 0 });
  assert.equal(result.ok, false);
  assert.match(result.failures.join("\n"), /x-github-request-id/);
});

test("bounded redirect following rejects a cycle between public hosts", async () => {
  const fetchImpl = async (url) => {
    const parsed = new URL(url);
    if (parsed.pathname === "/" && parsed.hostname === "cityscroll.org") {
      return response(301, "", { location: "https://www.cityscroll.org/" });
    }
    if (parsed.pathname === "/" && parsed.hostname === "www.cityscroll.org") {
      return response(301, "", { location: "https://cityscroll.org/" });
    }
    return healthyFetch(url);
  };
  const result = await runCutoverRegression({ fetchImpl, timeoutMs: 0 });
  assert.equal(result.ok, false);
  assert.match(result.failures.join("\n"), /redirect loop/);
});

test("architecture checks require Cloudflare Pages headers", () => {
  const result = (id, headers) => ({
    id,
    classification: { ok: true },
    finalHeaders: new Headers(headers),
  });
  const failures = architectureFailures([
    result("pages-apex-home", pagesHeaders),
    result("pages-www-home", pagesHeaders),
    result("pages-dev-home", pagesHeaders),
    statsResult(publicStats()),
  ]);
  assert.deepEqual(failures, []);
});

test("stats marker and architecture checks consume the current owner projection", () => {
  const marker = CUTOVER_TARGETS.find((target) => target.id === "api-worker-stats").marker;
  for (const body of [publicStats(), buildPublicStatsBody()]) {
    assert.equal(body.schema, PUBLIC_STATS_SCHEMA);
    assert.deepEqual(Object.keys(body).sort(), [
      "coverage", "generated_at", "language_coverage", "schema", "scope", "search_usage",
    ]);
    assert.match(JSON.stringify(body, null, 2), marker);
    assert.deepEqual(statsFailures(body), []);
  }
  const wrongSchema = { ...publicStats(), schema: `${PUBLIC_STATS_SCHEMA}.unexpected` };
  assert.doesNotMatch(JSON.stringify(wrongSchema), marker);
  assert.equal(statsFailures(wrongSchema).length, 1);
});

test("stats checks require every public field and reject private operational fields even when null", () => {
  for (const field of Object.keys(publicStats())) {
    const body = publicStats();
    delete body[field];
    assert.equal(statsFailures(body).length, 1, `missing ${field}`);
  }
  for (const field of ["coverage", "language_coverage", "search_usage"]) {
    for (const value of [null, [], "invalid"]) {
      assert.equal(statsFailures({ ...publicStats(), [field]: value }).length, 1, field);
    }
  }
  for (const field of ["usage", "subscriptions", "digests"]) {
    assert.equal(statsFailures({ ...publicStats(), [field]: null }).length, 1, field);
  }
  for (const field of ["generated_at", "scope"]) {
    assert.equal(statsFailures({ ...publicStats(), [field]: "" }).length, 1, field);
  }
  const failures = architectureFailures([{ ...statsResult({}), body: "not JSON" }]);
  assert.ok(failures.includes("api-worker-stats: response is not valid JSON"));
});

test("Following uses its Worker cache profile while the Pages home targets retain revalidation", async () => {
  // Exercise the owner's pure header function without importing Worker npm
  // dependencies into the independently provisioned site unit family.
  const source = readFileSync(new URL("../worker/src/following.mjs", import.meta.url), "utf8");
  const ownedHeaders = new Function("SITE_ORIGIN", `${extractFn("publicHeaders", source)}; return publicHeaders();`)("https://cityscroll.org");
  const followingHeaders = new Headers(ownedHeaders);
  assert.equal(followingHeaders.get("cache-control"), "public, max-age=120, s-maxage=300, stale-while-revalidate=3600");
  assert.equal(followingHeaders.get("x-content-type-options"), "nosniff");
  const headers = { ...Object.fromEntries(followingHeaders), server: "cloudflare" };
  assert.match(pagesHeaderFailure({ id: "pages-apex-following", finalHeaders: headers }), /cache-control profile/);
  const fetchImpl = (url) => new URL(url).pathname === "/following/"
    ? Promise.resolve(response(200, "<title>CityScroll</title>", headers))
    : healthyFetch(url);
  assert.equal((await runCutoverRegression({ fetchImpl, timeoutMs: 0 })).ok, true);
  for (const hostname of ["cityscroll.org", "www.cityscroll.org", "cityscroll.pages.dev"]) {
    const result = await runCutoverRegression({
      timeoutMs: 0,
      fetchImpl: (url) => new URL(url).hostname === hostname && new URL(url).pathname === "/"
        ? Promise.resolve(response(200, "<title>CityScroll</title>", headers))
        : healthyFetch(url),
    });
    assert.equal(result.ok, false, hostname);
    assert.match(result.failures.join("\n"), /cache-control profile/);
  }
});

test("Following still rejects a GitHub origin header", async () => {
  const result = await runCutoverRegression({
    timeoutMs: 0,
    fetchImpl: (url) => new URL(url).pathname === "/following/"
      ? Promise.resolve(response(200, "<title>CityScroll</title>", { ...pagesHeaders, "x-github-request-id": "regression" }))
      : healthyFetch(url),
  });
  assert.equal(result.ok, false);
  assert.match(result.failures.join("\n"), /x-github-request-id/);
});

test("scheduled monitor is dispatchable but never a pull-request or merge-queue check", () => {
  const workflow = readFileSync(
    new URL("../.github/workflows/cutover-regression.yml", import.meta.url),
    "utf8",
  );
  assert.match(workflow, /schedule:/);
  assert.match(workflow, /workflow_dispatch:/);
  assert.match(workflow, /node tools\/cutover_regression\.mjs/);
  assert.match(workflow, /Full public demo-link contract on production/);
  assert.match(workflow, /attachment-metadata\/receipt/);
  assert.match(workflow, /CROL_DEMO_LINK_IDS: notice-cannonsville-attachment/);
  assert.doesNotMatch(workflow, /continue-on-error/);
  assert.doesNotMatch(workflow, /pull_request:|merge_group:|push:/);
});

test("scheduled monitor owns the full production demo-link contract", () => {
  const workflow = readFileSync(
    new URL("../.github/workflows/cutover-regression.yml", import.meta.url),
    "utf8",
  );
  assert.match(workflow, /uses: \.\/\.github\/actions\/setup-playwright/);
  assert.match(workflow, /CROL_BASE: https:\/\/cityscroll\.org\//);
  assert.match(workflow, /Full public demo-link contract on production/);
  assert.match(workflow, /python3 test\/functional\/20_demo_links\.py/);
  // Primary production step runs the full manifest (no ID filter on that step).
  const full = workflow.slice(
    workflow.indexOf("Full public demo-link contract on production"),
  );
  const fullEnv = full.slice(0, full.indexOf("run:"));
  assert.doesNotMatch(fullEnv, /CROL_DEMO_LINK_IDS/);
  assert.doesNotMatch(workflow, /continue-on-error:\s*true/);
});
