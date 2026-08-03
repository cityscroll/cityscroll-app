import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  CUTOVER_TARGETS,
  architectureFailures,
  runCutoverRegression,
} from "../tools/cutover_regression.mjs";
import { ROUTE_INVENTORY } from "../tools/pages_route_parity.mjs";

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
  if (parsed.hostname === "api.cityscroll.org") {
    return Promise.resolve(response(200, "crol-worker ok", { server: "cloudflare" }));
  }
  if (parsed.hostname === "cityscroll.github.io") {
    return Promise.resolve(response(200, "<title>CityScroll</title>", {
      server: "GitHub.com",
      "x-github-request-id": "fixture-request-id",
    }));
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
    "legacy-origin",
    "github-pages-fallback",
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

test("architecture checks require Pages headers and the GitHub fallback header", () => {
  const result = (id, headers) => ({
    id,
    classification: { ok: true },
    finalHeaders: new Headers(headers),
  });
  const failures = architectureFailures([
    result("pages-apex-home", pagesHeaders),
    result("pages-www-home", pagesHeaders),
    result("pages-dev-home", pagesHeaders),
    result("github-pages-fallback", { server: "cloudflare" }),
  ]);
  assert.deepEqual(failures, [
    "github-pages-fallback: expected GitHub Pages origin headers",
  ]);
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
