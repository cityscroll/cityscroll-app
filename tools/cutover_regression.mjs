#!/usr/bin/env node
/**
 * Scheduled production regression monitor for the Pages-primary hosting shape.
 *
 * The monitor checks the public Pages hostnames, every deep static route, the
 * API Worker, and the retained GitHub Pages fallback. Redirects are followed
 * manually by live_url_smoke so a host-to-host cycle fails deterministically.
 */

import { pathToFileURL } from "node:url";
import {
  API_HEALTH_MARKER,
  CONTENT_MARKER,
  DEFAULT_INTERVAL_MS,
  DEFAULT_MAX_REDIRECTS,
  DEFAULT_REQUEST_TIMEOUT_MS,
  formatStatusChain,
  headerValue,
  runSmoke,
} from "./live_url_smoke.mjs";
import { ROUTE_INVENTORY, joinOrigin } from "./pages_route_parity.mjs";

export const PUBLIC_ORIGIN = "https://cityscroll.org";
export const WWW_ORIGIN = "https://www.cityscroll.org";
export const PAGES_ORIGIN = "https://cityscroll.pages.dev";
export const API_HEALTH_URL = "https://api.cityscroll.org/health";
export const API_STATS_URL = "https://api.cityscroll.org/stats";
export const LEGACY_ORIGIN = "https://crol-list.org";
export const GITHUB_FALLBACK_URL = "https://cityscroll.github.io/crol-list/";

export const DEFAULT_CUTOVER_TIMEOUT_MS = 180_000;

const PAGES_HEADER_TARGET_IDS = new Set([
  "pages-apex-home",
  "pages-www-home",
  "pages-dev-home",
]);

export function buildCutoverTargets() {
  const routeTargets = ROUTE_INVENTORY.map((route) => ({
    id: `pages-apex-${route.id}`,
    url: joinOrigin(PUBLIC_ORIGIN, route.path),
    marker: route.marker,
    requireAbsentHeaders: ["x-github-request-id"],
  }));

  return Object.freeze([
    ...routeTargets,
    {
      id: "pages-www-home",
      url: `${WWW_ORIGIN}/`,
      marker: CONTENT_MARKER,
      requireAbsentHeaders: ["x-github-request-id"],
    },
    {
      id: "pages-dev-home",
      url: `${PAGES_ORIGIN}/`,
      marker: CONTENT_MARKER,
      requireAbsentHeaders: ["x-github-request-id"],
    },
    {
      id: "api-worker-health",
      url: API_HEALTH_URL,
      marker: API_HEALTH_MARKER,
    },
    {
      id: "api-worker-stats",
      url: API_STATS_URL,
      marker: /"schema"\s*:\s*"public-stats\.v2"/,
    },
    {
      id: "legacy-origin",
      url: `${LEGACY_ORIGIN}/`,
      marker: CONTENT_MARKER,
    },
    {
      id: "github-pages-fallback",
      url: GITHUB_FALLBACK_URL,
      marker: CONTENT_MARKER,
    },
  ]);
}

export const CUTOVER_TARGETS = buildCutoverTargets();

/**
 * Verify the stable Pages response profile used by both the custom domains and
 * pages.dev. The GitHub header absence is also enforced inside each URL probe.
 */
export function pagesHeaderFailure(result) {
  const headers = result?.finalHeaders;
  if (headerValue(headers, "x-github-request-id")) {
    return `${result.id}: x-github-request-id must be absent`;
  }
  if (String(headerValue(headers, "server") || "").toLowerCase() !== "cloudflare") {
    return `${result.id}: expected server=cloudflare`;
  }
  if (String(headerValue(headers, "x-content-type-options") || "").toLowerCase() !== "nosniff") {
    return `${result.id}: expected x-content-type-options=nosniff`;
  }
  if (!/must-revalidate/i.test(String(headerValue(headers, "cache-control") || ""))) {
    return `${result.id}: expected Pages cache-control profile`;
  }
  return null;
}

export function architectureFailures(results) {
  const failures = [];
  const byId = new Map(results.map((result) => [result.id, result]));

  for (const id of PAGES_HEADER_TARGET_IDS) {
    const result = byId.get(id);
    if (!result) {
      failures.push(`${id}: missing result`);
      continue;
    }
    if (result.classification?.ok) {
      const failure = pagesHeaderFailure(result);
      if (failure) failures.push(failure);
    }
  }

  const fallback = byId.get("github-pages-fallback");
  if (!fallback) {
    failures.push("github-pages-fallback: missing result");
  } else if (fallback.classification?.ok) {
    const server = String(headerValue(fallback.finalHeaders, "server") || "").toLowerCase();
    const requestId = headerValue(fallback.finalHeaders, "x-github-request-id");
    if (server !== "github.com" || !requestId) {
      failures.push("github-pages-fallback: expected GitHub Pages origin headers");
    }
  }

  const stats = byId.get("api-worker-stats");
  if (!stats) {
    failures.push("api-worker-stats: missing result");
  } else if (stats.classification?.ok) {
    try {
      const body = JSON.parse(stats.body || "");
      const shapeOk = body?.schema === "public-stats.v2"
        && body?.city_record
        && body?.sources
        && body?.language_coverage
        && !Object.hasOwn(body, "usage")
        && !Object.hasOwn(body, "subscriptions")
        && !Object.hasOwn(body, "digests");
      if (!shapeOk) failures.push("api-worker-stats: required public schema fields are missing");
    } catch (_error) {
      failures.push("api-worker-stats: response is not valid JSON");
    }
  }

  return failures;
}

export async function runCutoverRegression({
  targets = CUTOVER_TARGETS,
  fetchImpl = globalThis.fetch,
  timeoutMs = DEFAULT_CUTOVER_TIMEOUT_MS,
  intervalMs = DEFAULT_INTERVAL_MS,
  requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
  maxRedirects = DEFAULT_MAX_REDIRECTS,
  sleep,
  now,
} = {}) {
  const smoke = await runSmoke({
    targets,
    fetchImpl,
    timeoutMs,
    intervalMs,
    requestTimeoutMs,
    maxRedirects,
    ...(sleep ? { sleep } : {}),
    ...(now ? { now } : {}),
  });
  const hostingFailures = architectureFailures(smoke.results);
  return {
    ok: smoke.ok && hostingFailures.length === 0,
    attempts: smoke.attempts,
    results: smoke.results,
    failures: [...smoke.failures, ...hostingFailures],
  };
}

function parseArgs(argv) {
  const opts = {
    timeoutMs: DEFAULT_CUTOVER_TIMEOUT_MS,
    intervalMs: DEFAULT_INTERVAL_MS,
    requestTimeoutMs: DEFAULT_REQUEST_TIMEOUT_MS,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--timeout-ms") opts.timeoutMs = Number(argv[++i]);
    else if (arg === "--interval-ms") opts.intervalMs = Number(argv[++i]);
    else if (arg === "--request-timeout-ms") opts.requestTimeoutMs = Number(argv[++i]);
    else if (arg === "--help" || arg === "-h") opts.help = true;
  }
  return opts;
}

export async function main(argv = process.argv.slice(2)) {
  const opts = parseArgs(argv);
  if (opts.help) {
    console.log(`Usage: node tools/cutover_regression.mjs [options]

Options:
  --timeout-ms N
  --interval-ms N
  --request-timeout-ms N

Checks Pages origin headers on apex/www, the complete public route inventory,
bounded redirect following, API Worker health, the crol-list.org compatibility
host, and the retained GitHub Pages fallback origin.`);
    return 0;
  }

  console.log(
    `cutover regression: probing ${CUTOVER_TARGETS.length} targets `
    + `(timeout ${opts.timeoutMs}ms, interval ${opts.intervalMs}ms)`,
  );
  const result = await runCutoverRegression(opts);
  for (const row of result.results) {
    const tag = row.classification.ok ? "OK" : "FAIL";
    console.log(`${tag} ${row.id} status=${row.finalStatus} chain=${formatStatusChain(row.statusChain)}`);
  }
  if (!result.ok) {
    console.error(`cutover regression FAILED after ${result.attempts} attempt(s)`);
    for (const failure of result.failures) console.error(failure);
    return 1;
  }
  console.log(`cutover regression green after ${result.attempts} attempt(s)`);
  return 0;
}

const isDirect = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirect) {
  main().then((code) => {
    process.exitCode = code;
  }).catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
