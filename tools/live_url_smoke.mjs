#!/usr/bin/env node
// Post-deploy live-URL smoke guard.
//
// After a worker or site deploy, curls the public apex hosts plus a deep route,
// asserts HTTP 200 with known page content, and fails the pipeline loudly on
// redirect loops, non-200s, empty bodies, or error pages. GitHub Pages / Fastly
// redirect caching can lag ~10 minutes after a bad CNAME or DNS change; the
// checker polls inside a bounded retry window before declaring failure.
//
// Field case (2026-07-30): cityscroll.org served ERR_TOO_MANY_REDIRECTS while the
// deploy workflow reported success. The missing gate is this module.

import { pathToFileURL } from "node:url";

/** Stable markers that real CityScroll HTML carries; error shells must not. */
export const CONTENT_MARKER = /CityScroll/;

/** API Worker health body marker (not HTML). */
export const API_HEALTH_MARKER = /crol-worker ok/;

/** Bodies that look like an error shell even when status is 200. */
export const ERROR_BODY_PATTERNS = [
  /ERR_TOO_MANY_REDIRECTS/i,
  /too many redirects/i,
  /redirect(?:ed)? (?:you )?(?:too many times|loop)/i,
  /<title>\s*404\b/i,
  /<title>\s*5\d\d\b/i,
  /Page not found/i,
  /There isn't a GitHub Pages site here/i,
  /Error\s*100[0-9]/i, // Cloudflare error codes
  /cf-error-details/i,
  /Bad gateway/i,
  /Gateway time-?out/i,
  /Service Unavailable/i,
  /Internal Server Error/i,
];

/**
 * Build-time tokens that must never ship on a live page.
 * Field case (2026-07-30): homepage served i18n.js?v=__I18N_ASSET_VERSION__ after the
 * site-root restructure broke the stamped-artifact failover path.
 * Matches ALL-CAPS __TOKEN__ placeholders (not markdown __emphasis__).
 */
export const UNSUBSTITUTED_PLACEHOLDER_RE = /__[A-Z][A-Z0-9_]{2,}__/;

/**
 * Default post-deploy smoke (current GitHub Pages + Worker mirror serving).
 * Includes www so a split-brain apex/www outage cannot go green.
 * Does not change what hosts serve production traffic.
 */
export const DEFAULT_TARGETS = Object.freeze([
  {
    id: "cityscroll-apex",
    url: "https://cityscroll.org/",
    marker: CONTENT_MARKER,
  },
  {
    id: "cityscroll-www",
    url: "https://www.cityscroll.org/",
    marker: CONTENT_MARKER,
  },
  {
    id: "crol-list-apex",
    url: "https://crol-list.org/",
    marker: CONTENT_MARKER,
  },
  {
    id: "cityscroll-about",
    url: "https://cityscroll.org/about.html",
    marker: CONTENT_MARKER,
  },
]);

/**
 * Parallel Cloudflare Pages host only. Safe to run any time; does not flip DNS.
 * Select with --set pages-dev (workflows already pass --base-url for the same host).
 */
export const PAGES_DEV_TARGETS = Object.freeze([
  {
    id: "pages-dev-apex",
    url: "https://cityscroll.pages.dev/",
    marker: CONTENT_MARKER,
  },
  {
    id: "pages-dev-about",
    url: "https://cityscroll.pages.dev/about.html",
    marker: CONTENT_MARKER,
  },
]);

/**
 * Post-flip verification matrix. Dormant until an operator deliberately selects
 * --set post-flip after a site-owner-authorized cutover — never the deploy default.
 *
 * Optional header checks (no GitHub Pages request id on apex/www) assert the
 * Pages-primary edge only when this set is used.
 */
export const POST_FLIP_TARGETS = Object.freeze([
  {
    id: "post-flip-cityscroll-apex",
    url: "https://cityscroll.org/",
    marker: CONTENT_MARKER,
    requireAbsentHeaders: Object.freeze(["x-github-request-id"]),
  },
  {
    id: "post-flip-cityscroll-www",
    url: "https://www.cityscroll.org/",
    marker: CONTENT_MARKER,
    requireAbsentHeaders: Object.freeze(["x-github-request-id"]),
  },
  {
    id: "post-flip-cityscroll-about",
    url: "https://cityscroll.org/about.html",
    marker: CONTENT_MARKER,
  },
  {
    id: "post-flip-crol-list-apex",
    url: "https://crol-list.org/",
    marker: CONTENT_MARKER,
  },
  {
    id: "post-flip-api-health",
    url: "https://api.cityscroll.org/health",
    marker: API_HEALTH_MARKER,
  },
  {
    id: "post-flip-pages-dev",
    url: "https://cityscroll.pages.dev/",
    marker: CONTENT_MARKER,
  },
]);

/** Named target sets. Deploy pipelines keep using `default` unless overridden. */
export const TARGET_SETS = Object.freeze({
  default: DEFAULT_TARGETS,
  "pages-dev": PAGES_DEV_TARGETS,
  "post-flip": POST_FLIP_TARGETS,
});

export const TARGET_SET_NAMES = Object.freeze(Object.keys(TARGET_SETS));

/**
 * Resolve a named smoke target set.
 * @param {string} [name]
 * @returns {readonly object[]}
 */
export function resolveTargetSet(name = "default") {
  const key = String(name || "default").trim().toLowerCase();
  const targets = TARGET_SETS[key];
  if (!targets) {
    const known = TARGET_SET_NAMES.join(", ");
    throw new Error(`unknown smoke target set "${name}" (known: ${known})`);
  }
  return targets;
}

export const DEFAULT_MAX_REDIRECTS = 8;
export const DEFAULT_TIMEOUT_MS = 720_000; // 12 min covers ~10 min cache lag + margin
export const DEFAULT_INTERVAL_MS = 20_000;
export const DEFAULT_REQUEST_TIMEOUT_MS = 20_000;
export const BODY_SNIPPET_CHARS = 240;

/**
 * Append a cache-busting query so intermediate caches cannot serve a stale
 * redirect or error shell as a false green.
 */
export function cacheBustUrl(url, now = Date.now()) {
  const parsed = new URL(url);
  parsed.searchParams.set("_smoke", String(now));
  return parsed.toString();
}

export function bodySnippet(body, limit = BODY_SNIPPET_CHARS) {
  const text = String(body ?? "")
    .replace(/\s+/g, " ")
    .trim();
  if (!text) return "(empty body)";
  return text.length <= limit ? text : `${text.slice(0, limit)}…`;
}

export function formatStatusChain(chain) {
  if (!chain?.length) return "(no responses)";
  return chain
    .map((hop) => {
      const loc = hop.location ? ` → ${hop.location}` : "";
      return `${hop.status}${loc}`;
    })
    .join(" | ");
}

export function looksLikeErrorBody(body) {
  const text = String(body ?? "");
  if (!text.trim()) return true;
  return ERROR_BODY_PATTERNS.some((re) => re.test(text));
}

/**
 * Classify a finished probe. Pure — fixtures feed this directly.
 * @returns {{ ok: true } | { ok: false, reason: string }}
 */
export function classifyProbe({
  statusChain,
  finalStatus,
  body,
  marker = CONTENT_MARKER,
  finalHeaders = null,
  requireAbsentHeaders = null,
}) {
  if (!statusChain?.length) {
    return { ok: false, reason: "no HTTP response received" };
  }

  const redirectHops = statusChain.filter((h) => h.status >= 300 && h.status < 400);
  if (redirectHops.length >= DEFAULT_MAX_REDIRECTS) {
    return {
      ok: false,
      reason: `redirect loop or redirect budget exceeded (${redirectHops.length} hops)`,
    };
  }

  // A cycle in the Location chain is the 2026-07-30 field shape.
  const seen = new Set();
  for (const hop of statusChain) {
    if (hop.url && seen.has(hop.url) && hop.status >= 300 && hop.status < 400) {
      return { ok: false, reason: `redirect loop involving ${hop.url}` };
    }
    if (hop.url) seen.add(hop.url);
  }

  if (finalStatus !== 200) {
    return { ok: false, reason: `final status ${finalStatus}, expected 200` };
  }

  const text = String(body ?? "");
  if (!text.trim()) {
    return { ok: false, reason: "empty body" };
  }

  if (looksLikeErrorBody(text) && !marker.test(text)) {
    return { ok: false, reason: "error-page body (status 200 but no real content marker)" };
  }

  if (!marker.test(text)) {
    return {
      ok: false,
      reason: `body missing content marker ${marker}`,
    };
  }

  // Cheap class check: unsubstituted build placeholders on live HTML.
  const placeholder = text.match(UNSUBSTITUTED_PLACEHOLDER_RE);
  if (placeholder) {
    return {
      ok: false,
      reason: `unsubstituted build placeholder ${placeholder[0]}`,
    };
  }

  if (requireAbsentHeaders?.length) {
    for (const name of requireAbsentHeaders) {
      const value = headerValue(finalHeaders, name);
      if (value) {
        return {
          ok: false,
          reason: `expected absent response header ${name} (got ${value})`,
        };
      }
    }
  }

  // Real pages can mention error strings in docs; the content marker is authoritative.
  return { ok: true };
}

/** Read a header value from a Headers-like object or plain map (case-insensitive). */
export function headerValue(headers, name) {
  if (!headers || !name) return null;
  if (typeof headers.get === "function") {
    return headers.get(name) ?? headers.get(String(name).toLowerCase()) ?? null;
  }
  const want = String(name).toLowerCase();
  for (const [k, v] of Object.entries(headers)) {
    if (String(k).toLowerCase() === want) return v;
  }
  return null;
}

/**
 * Format a failure line naming URL, status chain, and body snippet.
 */
export function formatFailure({ url, statusChain, body, reason }) {
  return [
    `LIVE URL SMOKE FAIL: ${url}`,
    `  reason: ${reason}`,
    `  status chain: ${formatStatusChain(statusChain)}`,
    `  body snippet: ${bodySnippet(body)}`,
  ].join("\n");
}

async function readBody(response) {
  try {
    return await response.text();
  } catch {
    return "";
  }
}

/**
 * Follow redirects manually so a loop is observed as a chain, not a browser opaque error.
 *
 * @param {string} url
 * @param {{
 *   fetchImpl?: typeof fetch,
 *   maxRedirects?: number,
 *   requestTimeoutMs?: number,
 *   cacheBust?: boolean,
 *   now?: number,
 * }} [opts]
 */
export async function probeUrl(url, opts = {}) {
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  const maxRedirects = opts.maxRedirects ?? DEFAULT_MAX_REDIRECTS;
  const requestTimeoutMs = opts.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  const cacheBust = opts.cacheBust !== false;
  const now = opts.now ?? Date.now();

  const statusChain = [];
  let current = cacheBust ? cacheBustUrl(url, now) : url;
  // Cycle detection ignores the cache-bust query so a 301 loop between hosts is
  // still seen when only the first hop was stamped.
  const visited = new Set();

  for (let i = 0; i <= maxRedirects; i++) {
    const visitKey = stripSmokeParam(current);
    if (visited.has(visitKey)) {
      statusChain.push({ url: current, status: 0, location: null, note: "cycle" });
      return {
        url,
        finalUrl: current,
        finalStatus: 0,
        statusChain,
        body: "",
        classification: {
          ok: false,
          reason: `redirect loop involving ${visitKey}`,
        },
      };
    }
    visited.add(visitKey);

    let response;
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), requestTimeoutMs);
      try {
        response = await fetchImpl(current, {
          method: "GET",
          redirect: "manual",
          signal: controller.signal,
          headers: {
            "Cache-Control": "no-cache",
            Pragma: "no-cache",
            "User-Agent": "cityscroll-live-url-smoke/1.0",
          },
        });
      } finally {
        clearTimeout(timer);
      }
    } catch (err) {
      const message = err?.name === "AbortError" ? "request timeout" : (err?.message || String(err));
      statusChain.push({ url: current, status: 0, location: null, note: message });
      return {
        url,
        finalUrl: current,
        finalStatus: 0,
        statusChain,
        body: "",
        classification: {
          ok: false,
          reason: `fetch error: ${message}`,
        },
      };
    }

    const location = response.headers?.get?.("location") ?? response.headers?.get?.("Location") ?? null;
    statusChain.push({
      url: current,
      status: response.status,
      location,
    });

    if (response.status >= 300 && response.status < 400 && location) {
      current = new URL(location, current).toString();
      continue;
    }

    const body = await readBody(response);
    const finalHeaders = response.headers ?? null;
    const classification = classifyProbe({
      statusChain,
      finalStatus: response.status,
      body,
      marker: opts.marker ?? CONTENT_MARKER,
      finalHeaders,
      requireAbsentHeaders: opts.requireAbsentHeaders ?? null,
    });
    return {
      url,
      finalUrl: current,
      finalStatus: response.status,
      statusChain,
      body,
      finalHeaders,
      classification,
    };
  }

  // Exhausted redirect budget without a terminal response.
  return {
    url,
    finalUrl: current,
    finalStatus: statusChain.at(-1)?.status ?? 0,
    statusChain,
    body: "",
    finalHeaders: null,
    classification: classifyProbe({
      statusChain,
      finalStatus: statusChain.at(-1)?.status ?? 0,
      body: "",
      marker: opts.marker ?? CONTENT_MARKER,
      requireAbsentHeaders: opts.requireAbsentHeaders ?? null,
    }),
  };
}

/**
 * Build a fetch mock from recorded hop fixtures.
 * Each entry is either a terminal body response or a redirect hop.
 *
 * Fixture shape (array of hops for one URL's chain):
 *   { status, location?, body?, headers? }
 * Or a map of absolute URL → hop (for multi-host loops).
 */
export function createFixtureFetch(fixture) {
  if (Array.isArray(fixture)) {
    let index = 0;
    return async function fixtureFetch() {
      const hop = fixture[Math.min(index, fixture.length - 1)];
      index += 1;
      return fixtureResponse(hop);
    };
  }

  // URL-keyed map (strip cache-bust query for lookup).
  return async function fixtureFetch(url) {
    const key = stripSmokeParam(String(url));
    const hop = fixture[key] ?? fixture[String(url)];
    if (!hop) {
      return fixtureResponse({ status: 404, body: "fixture miss" });
    }
    // Support one-shot queue per URL for sequences on the same host.
    if (Array.isArray(hop)) {
      const next = hop.shift();
      hop.push(next); // cycle for loops
      return fixtureResponse(next);
    }
    return fixtureResponse(hop);
  };
}

function stripSmokeParam(url) {
  try {
    const parsed = new URL(url);
    parsed.searchParams.delete("_smoke");
    // Normalize trailing slash variants for fixture keys.
    return parsed.toString();
  } catch {
    return url;
  }
}

function fixtureResponse(hop) {
  const headers = new Map(Object.entries(hop.headers || {}));
  if (hop.location) headers.set("location", hop.location);
  return {
    status: hop.status,
    statusText: hop.statusText || "",
    headers: {
      get(name) {
        const lower = String(name).toLowerCase();
        for (const [k, v] of headers) {
          if (k.toLowerCase() === lower) return v;
        }
        return null;
      },
    },
    text: async () => hop.body ?? "",
  };
}

/**
 * Poll targets until all pass or the retry window elapses.
 *
 * @returns {Promise<{ ok: boolean, results: object[], attempts: number, failures: string[] }>}
 */
export async function runSmoke({
  targets = DEFAULT_TARGETS,
  fetchImpl = globalThis.fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  intervalMs = DEFAULT_INTERVAL_MS,
  requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
  maxRedirects = DEFAULT_MAX_REDIRECTS,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  now = () => Date.now(),
  cacheBust = true,
} = {}) {
  const deadline = now() + timeoutMs;
  let attempts = 0;
  let lastResults = [];
  let lastFailures = [];

  while (true) {
    attempts += 1;
    const stamp = now();
    const results = [];
    for (const target of targets) {
      const probe = await probeUrl(target.url, {
        fetchImpl,
        maxRedirects,
        requestTimeoutMs,
        cacheBust,
        now: stamp,
        marker: target.marker ?? CONTENT_MARKER,
        requireAbsentHeaders: target.requireAbsentHeaders ?? null,
      });
      results.push({ ...probe, id: target.id });
    }
    lastResults = results;
    lastFailures = results
      .filter((r) => !r.classification.ok)
      .map((r) => formatFailure({
        url: r.url,
        statusChain: r.statusChain,
        body: r.body,
        reason: r.classification.reason,
      }));

    if (lastFailures.length === 0) {
      return { ok: true, results, attempts, failures: [] };
    }

    const remaining = deadline - now();
    if (remaining <= 0) break;
    await sleep(Math.min(intervalMs, Math.max(0, remaining)));
    if (now() > deadline) break;
  }

  return { ok: false, results: lastResults, attempts, failures: lastFailures };
}

/**
 * Build smoke targets from CLI options.
 * Precedence: --url (repeatable) > --base-url > --set > default set.
 * Named sets (pages-dev, post-flip) stay opt-in so deploy defaults are unchanged
 * aside from the additive www host on the default set.
 */
export function targetsFromCli(opts) {
  if (opts.urls?.length) {
    return opts.urls.map((url, index) => ({
      id: `url-${index + 1}`,
      url,
      marker: CONTENT_MARKER,
    }));
  }
  if (opts.baseUrl) {
    const base = String(opts.baseUrl).replace(/\/+$/, "");
    return [
      { id: "base-apex", url: `${base}/`, marker: CONTENT_MARKER },
      { id: "base-about", url: `${base}/about.html`, marker: CONTENT_MARKER },
    ];
  }
  return resolveTargetSet(opts.targetSet || "default");
}

function parseArgs(argv) {
  const opts = {
    timeoutMs: DEFAULT_TIMEOUT_MS,
    intervalMs: DEFAULT_INTERVAL_MS,
    requestTimeoutMs: DEFAULT_REQUEST_TIMEOUT_MS,
    urls: [],
    baseUrl: null,
    targetSet: "default",
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--timeout-ms") opts.timeoutMs = Number(argv[++i]);
    else if (arg === "--interval-ms") opts.intervalMs = Number(argv[++i]);
    else if (arg === "--request-timeout-ms") opts.requestTimeoutMs = Number(argv[++i]);
    else if (arg === "--url") opts.urls.push(argv[++i]);
    else if (arg === "--base-url") opts.baseUrl = argv[++i];
    else if (arg === "--set") opts.targetSet = argv[++i];
    else if (arg === "--help" || arg === "-h") opts.help = true;
  }
  return opts;
}

export async function main(argv = process.argv.slice(2)) {
  const opts = parseArgs(argv);
  if (opts.help) {
    console.log(`Usage: node tools/live_url_smoke.mjs [options]

Options:
  --timeout-ms N
  --interval-ms N
  --request-timeout-ms N
  --set NAME                      Named target set: ${TARGET_SET_NAMES.join(", ")}
  --base-url https://host.example Probe / and /about.html on one host
  --url https://host.example/path Probe an explicit URL (repeatable)

Default set probes: ${DEFAULT_TARGETS.map((t) => t.url).join(", ")}
Named sets (opt-in; not used by deploy jobs unless selected):
  pages-dev  ${PAGES_DEV_TARGETS.map((t) => t.url).join(", ")}
  post-flip  post-cutover verification matrix (apex, www, about, crol-list, api/health, pages.dev)
Each HTML target must return HTTP 200 with a CityScroll content marker, or the retry window ends.
API health uses the worker health marker. The post-flip set also asserts apex/www lack a
GitHub Pages request-id header once Pages is the public origin.
`);
    return 0;
  }

  let targets;
  try {
    targets = targetsFromCli(opts);
  } catch (err) {
    console.error(err?.message || String(err));
    return 2;
  }
  console.log(
    `live-url smoke: probing ${targets.length} URLs `
    + `(timeout ${opts.timeoutMs}ms, interval ${opts.intervalMs}ms)`,
  );

  const result = await runSmoke({
    targets,
    timeoutMs: opts.timeoutMs,
    intervalMs: opts.intervalMs,
    requestTimeoutMs: opts.requestTimeoutMs,
  });

  if (result.ok) {
    for (const r of result.results) {
      console.log(`OK ${r.id || r.url} → ${r.finalStatus} (${r.finalUrl}) chain=${formatStatusChain(r.statusChain)}`);
    }
    console.log(`live-url smoke green after ${result.attempts} attempt(s)`);
    return 0;
  }

  console.error(`live-url smoke FAILED after ${result.attempts} attempt(s)`);
  for (const line of result.failures) {
    console.error(line);
  }
  return 1;
}

const isDirect = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirect) {
  main().then((code) => {
    process.exitCode = code;
  }).catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}
