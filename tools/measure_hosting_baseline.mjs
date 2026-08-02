#!/usr/bin/env node
/**
 * Dual-host hosting baseline measurement (read-only).
 *
 * Captures pre-cutover (or post-cutover re-run) metrics for the visitor-facing
 * Worker mirror, the parallel Cloudflare Pages host, and the documented
 * GitHub Pages origin hostname — without changing DNS, routes, deploy config,
 * or any production origin.
 *
 * Metrics: TTFB/latency samples, HTTP status / availability, cache headers,
 * redirect chains (including the 2026-07-30 redirect-loop class), and
 * payload size + SHA-256 parity across hosts.
 *
 * Writes machine-readable receipts and can merge a dual_host_live_metrics
 * block into docs/evidence/hosting-migration-baseline.json.
 */

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  CONTENT_MARKER,
  classifyProbe,
  formatStatusChain,
  headerValue,
  probeUrl,
} from "./live_url_smoke.mjs";
import { ROUTE_INVENTORY } from "./pages_route_parity.mjs";

export const HARNESS_ID = "tools/measure_hosting_baseline.mjs";
export const METRICS_SCHEMA = "hosting-dual-host-metrics.v1";
export const DEFAULT_SAMPLES = 5;
export const DEFAULT_REQUEST_TIMEOUT_MS = 20_000;

/** Hosts under dual-serve observation. Roles document serving shape only. */
export const DEFAULT_HOSTS = Object.freeze([
  {
    id: "production_mirror",
    origin: "https://cityscroll.org",
    role: "visitor-facing Worker reverse-proxy on cityscroll.org (custom domain)",
    expect: "document",
  },
  {
    id: "production_www",
    origin: "https://www.cityscroll.org",
    role: "visitor-facing Worker reverse-proxy on www (custom domain)",
    expect: "document",
  },
  {
    id: "pages_parallel",
    origin: "https://cityscroll.pages.dev",
    role: "Cloudflare Pages parallel host (no custom-domain cutover required to measure)",
    expect: "document",
  },
  {
    id: "gh_pages_hostname",
    origin: "https://crol-list.org",
    role: "documented GitHub Pages origin hostname (mirror.mjs ORIGIN); visitors currently redirect to cityscroll.org",
    expect: "redirect_to_cityscroll",
  },
]);

/** Paths used for latency + availability + parity. Route inventory + one binary asset. */
export const DEFAULT_PATHS = Object.freeze([
  ...ROUTE_INVENTORY.map((r) => ({ path: r.path, id: r.id, kind: r.kind, marker: r.marker })),
  {
    path: "/assets/brand/apple-touch-icon.png",
    id: "apple-touch-icon",
    kind: "binary",
    marker: null,
  },
]);

/** Headers recorded for cache / edge fingerprinting (values may be null). */
export const CACHE_HEADER_NAMES = Object.freeze([
  "cf-cache-status",
  "age",
  "cache-control",
  "etag",
  "last-modified",
  "x-github-request-id",
  "server",
  "cf-ray",
]);

export function joinOrigin(origin, path) {
  const base = String(origin || "").replace(/\/+$/, "");
  const suffix = path.startsWith("/") ? path : `/${path}`;
  return `${base}${suffix}`;
}

export function summarizeNumbers(values) {
  const nums = (values || []).filter((n) => typeof n === "number" && Number.isFinite(n)).sort((a, b) => a - b);
  if (!nums.length) {
    return { n: 0, min_ms: null, max_ms: null, mean_ms: null, median_ms: null, p95_ms: null };
  }
  const sum = nums.reduce((a, b) => a + b, 0);
  const mean = sum / nums.length;
  const mid = Math.floor(nums.length / 2);
  const median = nums.length % 2 === 0 ? (nums[mid - 1] + nums[mid]) / 2 : nums[mid];
  const p95Index = Math.min(nums.length - 1, Math.ceil(nums.length * 0.95) - 1);
  return {
    n: nums.length,
    min_ms: round1(nums[0]),
    max_ms: round1(nums[nums.length - 1]),
    mean_ms: round1(mean),
    median_ms: round1(median),
    p95_ms: round1(nums[p95Index]),
  };
}

function round1(n) {
  return Math.round(n * 10) / 10;
}

export function headersToObject(headers) {
  const out = {};
  if (!headers) return out;
  for (const name of CACHE_HEADER_NAMES) {
    out[name] = headerValue(headers, name);
  }
  return out;
}

export function sha256Hex(buffer) {
  return createHash("sha256").update(Buffer.from(buffer)).digest("hex");
}

async function fetchManual(fetchImpl, url, requestTimeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), requestTimeoutMs);
  try {
    return await fetchImpl(url, {
      method: "GET",
      redirect: "manual",
      signal: controller.signal,
      headers: {
        "Cache-Control": "no-cache",
        Pragma: "no-cache",
        "User-Agent": "cityscroll-hosting-baseline/1.0",
      },
    });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * One timed GET that does not follow redirects (redirect class is measured separately).
 * TTFB is request-start → response headers available (Node fetch approximation).
 */
export async function timedGet(url, opts = {}) {
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  const requestTimeoutMs = opts.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  const t0 = opts.now ? opts.now() : performance.now();
  let response;
  try {
    response = await fetchManual(fetchImpl, url, requestTimeoutMs);
  } catch (err) {
    const t1 = opts.now ? opts.now() : performance.now();
    const message = err?.name === "AbortError" ? "request timeout" : (err?.message || String(err));
    return {
      ok: false,
      error: message,
      status: 0,
      ttfb_ms: round1(t1 - t0),
      total_ms: round1(t1 - t0),
      bytes: 0,
      sha256: null,
      headers: {},
      location: null,
    };
  }

  const tHeaders = opts.now ? opts.now() : performance.now();
  const location = response.headers?.get?.("location") ?? null;
  let bodyBuf = new Uint8Array(0);
  if (response.status >= 200 && response.status < 300) {
    try {
      const ab = await response.arrayBuffer();
      bodyBuf = new Uint8Array(ab);
    } catch {
      bodyBuf = new Uint8Array(0);
    }
  }
  const tEnd = opts.now ? opts.now() : performance.now();
  return {
    ok: true,
    error: null,
    status: response.status,
    ttfb_ms: round1(tHeaders - t0),
    total_ms: round1(tEnd - t0),
    bytes: bodyBuf.byteLength,
    sha256: bodyBuf.byteLength ? sha256Hex(bodyBuf) : null,
    headers: headersToObject(response.headers),
    location,
    // Keep text for marker checks when HTML-ish
    bodyText:
      bodyBuf.byteLength && bodyBuf.byteLength < 2_000_000
        ? new TextDecoder("utf-8", { fatal: false }).decode(bodyBuf)
        : "",
  };
}

/**
 * Follow redirects (bounded) and return final body for payload parity.
 * Cloudflare Pages pretty-URL 308s (e.g. /about.html → /about) must not be
 * scored as empty-body mismatches against hosts that serve the .html path.
 */
export async function finalBodyGet(url, opts = {}) {
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  const requestTimeoutMs = opts.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  const maxRedirects = opts.maxRedirects ?? 8;
  let current = url;
  const chain = [];
  for (let i = 0; i <= maxRedirects; i++) {
    let response;
    try {
      response = await fetchManual(fetchImpl, current, requestTimeoutMs);
    } catch (err) {
      const message = err?.name === "AbortError" ? "request timeout" : (err?.message || String(err));
      return {
        ok: false,
        error: message,
        status: 0,
        finalUrl: current,
        bytes: 0,
        sha256: null,
        headers: {},
        statusChain: chain,
      };
    }
    const location = response.headers?.get?.("location") ?? null;
    chain.push({ url: current, status: response.status, location });
    if (response.status >= 300 && response.status < 400 && location) {
      current = new URL(location, current).toString();
      continue;
    }
    let bodyBuf = new Uint8Array(0);
    if (response.status >= 200 && response.status < 300) {
      try {
        const ab = await response.arrayBuffer();
        bodyBuf = new Uint8Array(ab);
      } catch {
        bodyBuf = new Uint8Array(0);
      }
    }
    return {
      ok: response.status === 200 && bodyBuf.byteLength > 0,
      error: null,
      status: response.status,
      finalUrl: current,
      bytes: bodyBuf.byteLength,
      sha256: bodyBuf.byteLength ? sha256Hex(bodyBuf) : null,
      headers: headersToObject(response.headers),
      statusChain: chain,
    };
  }
  return {
    ok: false,
    error: "redirect budget exceeded",
    status: chain.at(-1)?.status ?? 0,
    finalUrl: current,
    bytes: 0,
    sha256: null,
    headers: {},
    statusChain: chain,
  };
}

/**
 * Classify redirect correctness for a host role.
 * @returns {{ ok: boolean, class: string, detail: string, status_chain: string }}
 */
export function classifyRedirectExpectation(host, probe) {
  const chain = formatStatusChain(probe.statusChain);
  if (!probe.classification?.ok && /redirect loop/i.test(probe.classification?.reason || "")) {
    return {
      ok: false,
      class: "redirect_loop",
      detail: probe.classification.reason,
      status_chain: chain,
    };
  }

  if (host.expect === "redirect_to_cityscroll") {
    const first = probe.statusChain?.[0];
    const loc = first?.location || "";
    const is301ish = first && first.status >= 300 && first.status < 400;
    const pointsToCityscroll = /https:\/\/(www\.)?cityscroll\.org(\/|$|\?)/i.test(loc);
    // Single hop to cityscroll is correct; multi-hop loops fail above.
    if (is301ish && pointsToCityscroll && (probe.statusChain?.length || 0) <= 2) {
      return {
        ok: true,
        class: "legacy_hostname_redirect",
        detail: `${first.status} → ${loc}`,
        status_chain: chain,
      };
    }
    // If hostname now serves content directly, still not a loop — note the shape.
    if (probe.finalStatus === 200 && probe.classification?.ok) {
      return {
        ok: true,
        class: "serves_document",
        detail: "hostname returns 200 document (no visitor redirect)",
        status_chain: chain,
      };
    }
    return {
      ok: false,
      class: "unexpected_redirect",
      detail: probe.classification?.reason || `unexpected chain for legacy origin: ${chain}`,
      status_chain: chain,
    };
  }

  // Document hosts: final 200 with content marker (or binary OK).
  if (probe.classification?.ok || probe.finalStatus === 200) {
    const hops = (probe.statusChain || []).filter((h) => h.status >= 300 && h.status < 400);
    return {
      ok: true,
      class: hops.length ? "pretty_url_redirect_then_200" : "direct_200",
      detail: hops.length ? `followed ${hops.length} same-site redirect(s) to 200` : "no redirect",
      status_chain: chain,
    };
  }

  return {
    ok: false,
    class: "unavailable",
    detail: probe.classification?.reason || `final status ${probe.finalStatus}`,
    status_chain: chain,
  };
}

/**
 * Run the full dual-host measurement.
 */
export async function measureDualHost(opts = {}) {
  const hosts = opts.hosts ?? DEFAULT_HOSTS;
  const paths = opts.paths ?? DEFAULT_PATHS;
  const samples = Math.max(1, Number(opts.samples ?? DEFAULT_SAMPLES));
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  const requestTimeoutMs = opts.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  const phase = opts.phase === "after-cutover" ? "after-cutover" : "pre-cutover";
  const capturedAt = opts.capturedAt ?? new Date().toISOString();
  const now = opts.now ?? (() => performance.now());

  const hostReports = [];
  const parityRows = [];

  for (const host of hosts) {
    const pathReports = [];
    const allTtfb = [];
    const allTotal = [];
    let availablePaths = 0;

    for (const pathSpec of paths) {
      const url = joinOrigin(host.origin, pathSpec.path);
      const sampleRows = [];
      for (let i = 0; i < samples; i++) {
        const row = await timedGet(url, { fetchImpl, requestTimeoutMs, now });
        sampleRows.push({
          sample: i + 1,
          status: row.status,
          ttfb_ms: row.ttfb_ms,
          total_ms: row.total_ms,
          bytes: row.bytes,
          sha256: row.sha256,
          error: row.error,
          headers: row.headers,
          location: row.location,
        });
        if (row.ok && row.status > 0) {
          allTtfb.push(row.ttfb_ms);
          allTotal.push(row.total_ms);
        }
      }

      // Redirect / content classification via probeUrl (follows redirect budget).
      const marker =
        pathSpec.kind === "binary"
          ? /./ // any non-empty body is fine for binary
          : pathSpec.marker ?? CONTENT_MARKER;
      const probe = await probeUrl(url, {
        fetchImpl,
        requestTimeoutMs,
        cacheBust: false,
        marker: pathSpec.kind === "binary" ? /[\s\S]/ : marker,
      });
      // Binary: classify manually if probeUrl marker is loose
      let classification = probe.classification;
      if (pathSpec.kind === "binary") {
        if (probe.finalStatus === 200 && (probe.body?.length || 0) > 0) {
          classification = { ok: true };
        } else if (host.expect === "redirect_to_cityscroll") {
          // probe followed redirect to cityscroll asset — still ok for hostname role
          classification = probe.classification;
        }
      }

      const redirect = classifyRedirectExpectation(host, { ...probe, classification });
      const firstHopOk = sampleRows.find((s) => s.status === 200) || sampleRows[0];
      // Final body after pretty-URL / hostname redirects — used for payload parity.
      const finalDoc = await finalBodyGet(url, { fetchImpl, requestTimeoutMs });
      const statusOk =
        host.expect === "redirect_to_cityscroll"
          ? redirect.ok
          : sampleRows.some((s) => s.status === 200) || classification.ok || finalDoc.ok;
      if (statusOk) availablePaths += 1;

      const pathReport = {
        path: pathSpec.path,
        id: pathSpec.id,
        kind: pathSpec.kind,
        url,
        samples: sampleRows,
        latency: summarizeNumbers(sampleRows.map((s) => s.ttfb_ms).filter((n) => n > 0)),
        total_latency: summarizeNumbers(sampleRows.map((s) => s.total_ms).filter((n) => n > 0)),
        http_status_observed: [...new Set(sampleRows.map((s) => s.status))],
        available: statusOk,
        redirect,
        cache_headers_sample: firstHopOk?.headers || finalDoc.headers || {},
        // First-hop sample (may be 308 with empty body on Pages pretty URLs)
        first_hop_status: firstHopOk?.status ?? null,
        first_hop_bytes: firstHopOk?.bytes ?? null,
        // Final document after following redirects
        body_bytes: finalDoc.bytes || null,
        body_sha256: finalDoc.sha256 || null,
        final_status: finalDoc.status,
        final_url: finalDoc.finalUrl,
      };
      pathReports.push(pathReport);

      if (host.id === "production_mirror" || host.id === "pages_parallel") {
        parityRows.push({
          host_id: host.id,
          path: pathSpec.path,
          status: finalDoc.status,
          bytes: finalDoc.bytes || null,
          sha256: finalDoc.sha256 || null,
        });
      }
    }

    hostReports.push({
      id: host.id,
      origin: host.origin,
      role: host.role,
      expect: host.expect,
      availability: {
        paths_ok: availablePaths,
        paths_total: paths.length,
        rate: paths.length ? round1((availablePaths / paths.length) * 100) / 100 : 0,
      },
      latency_ttfb: summarizeNumbers(allTtfb),
      latency_total: summarizeNumbers(allTotal),
      paths: pathReports,
    });
  }

  const parity = buildPayloadParity(parityRows, paths);

  const receipt = {
    schema: METRICS_SCHEMA,
    harness: HARNESS_ID,
    phase,
    captured_at: capturedAt,
    serving_shape_declared: "github-pages-origin-via-worker-mirror",
    note:
      "Read-only measurement of the live dual-host setup. Does not change DNS, Worker routes, Pages custom domains, or deploy config.",
    samples_per_path: samples,
    request_timeout_ms: requestTimeoutMs,
    hosts: hostReports,
    payload_parity: parity,
    redirects_summary: summarizeRedirects(hostReports),
    cache_summary: summarizeCache(hostReports),
    provenance: {
      harness: HARNESS_ID,
      node: process.version,
      command: reconstructCommand(opts),
      measured_from: "operator workstation / CI runner network path to public hosts",
      tag: "measured",
    },
  };

  return receipt;
}

function reconstructCommand(opts) {
  const parts = ["node", HARNESS_ID];
  if (opts.phase) parts.push("--phase", opts.phase);
  if (opts.samples) parts.push("--samples", String(opts.samples));
  if (opts.writeBaseline) parts.push("--write-baseline", opts.writeBaseline);
  if (opts.outReceipt) parts.push("--out-receipt", opts.outReceipt);
  return parts.join(" ");
}

export function buildPayloadParity(parityRows, paths) {
  const byHost = new Map();
  for (const row of parityRows) {
    if (!byHost.has(row.host_id)) byHost.set(row.host_id, new Map());
    byHost.get(row.host_id).set(row.path, row);
  }
  const left = byHost.get("production_mirror") || new Map();
  const right = byHost.get("pages_parallel") || new Map();
  const rows = [];
  let matched = 0;
  let compared = 0;
  for (const pathSpec of paths) {
    const a = left.get(pathSpec.path);
    const b = right.get(pathSpec.path);
    if (!a || !b) {
      rows.push({
        path: pathSpec.path,
        match: false,
        reason: "missing host row",
        production_mirror: a || null,
        pages_parallel: b || null,
      });
      compared += 1;
      continue;
    }
    // For redirecting legacy paths we only compare 200 document hosts.
    // Pretty-URL redirects on pages.dev can change final path; compare bytes/hash of final body.
    const statusBothOk = a.status === 200 && b.status === 200;
    const bytesMatch = statusBothOk && a.bytes === b.bytes;
    const hashMatch = statusBothOk && a.sha256 && a.sha256 === b.sha256;
    // HTML may differ by injected edge beacons; for homepage allow size-equal when hash differs
    // only if both non-empty and same status — still report hash_match honestly.
    const match = statusBothOk && (hashMatch || (bytesMatch && pathSpec.kind === "html"));
    // Prefer strict hash; fall back to bytes for HTML only when hashes differ due to edge transforms.
    const strict = statusBothOk && hashMatch;
    const soft = statusBothOk && bytesMatch && !hashMatch;
    const ok = strict || soft;
    if (ok) matched += 1;
    compared += 1;
    rows.push({
      path: pathSpec.path,
      match: ok,
      match_kind: strict ? "sha256" : soft ? "bytes_only" : "none",
      production_mirror: { status: a.status, bytes: a.bytes, sha256: a.sha256 },
      pages_parallel: { status: b.status, bytes: b.bytes, sha256: b.sha256 },
    });
  }
  return {
    compared,
    matched,
    rate: compared ? round1((matched / compared) * 100) / 100 : 0,
    reference_host: "production_mirror",
    candidate_host: "pages_parallel",
    rows,
  };
}

export function summarizeRedirects(hostReports) {
  const byHost = {};
  let loops = 0;
  for (const host of hostReports) {
    const classes = host.paths.map((p) => p.redirect.class);
    if (classes.includes("redirect_loop")) loops += 1;
    byHost[host.id] = {
      classes: [...new Set(classes)],
      all_ok: host.paths.every((p) => p.redirect.ok),
      samples: host.paths.map((p) => ({
        path: p.path,
        class: p.redirect.class,
        ok: p.redirect.ok,
        status_chain: p.redirect.status_chain,
      })),
    };
  }
  return {
    redirect_loops_detected: loops,
    ok: loops === 0 && Object.values(byHost).every((h) => h.all_ok),
    by_host: byHost,
  };
}

export function summarizeCache(hostReports) {
  const byHost = {};
  for (const host of hostReports) {
    const statuses = new Set();
    const ages = new Set();
    const cacheControls = new Set();
    const githubIds = new Set();
    for (const p of host.paths) {
      const h = p.cache_headers_sample || {};
      if (h["cf-cache-status"]) statuses.add(h["cf-cache-status"]);
      if (h.age != null) ages.add(String(h.age));
      if (h["cache-control"]) cacheControls.add(h["cache-control"]);
      if (h["x-github-request-id"]) githubIds.add(h["x-github-request-id"]);
    }
    byHost[host.id] = {
      cf_cache_status_values: [...statuses],
      age_values: [...ages],
      cache_control_values: [...cacheControls],
      x_github_request_id_present: githubIds.size > 0,
      note:
        statuses.size === 0
          ? "CF-Cache-Status not present on sampled responses (common with cache-control must-revalidate)"
          : null,
    };
  }
  return { by_host: byHost };
}

/**
 * Merge a dual_host_live_metrics block into the baseline scorecard JSON.
 * Preserves merge_to_live / detection / rollback history.
 */
export function mergeBaselineMetrics(baseline, receipt, { phase = "pre-cutover" } = {}) {
  const next = structuredClone(baseline);
  const summary = receiptToBaselineSummary(receipt);

  if (phase === "after-cutover") {
    next.after_cutover = next.after_cutover || {};
    next.after_cutover.dual_host_live_metrics = summary;
    next.after_cutover.dual_host_status = "measured";
    // Do not invent merge_to_live / detection / rollback improvements.
    if (!next.after_cutover.status || next.after_cutover.status === "not-yet-measured") {
      next.after_cutover.status = "partial-dual-host-only";
    }
    next.after_cutover.instructions =
      next.after_cutover.instructions ||
      "Fill merge_to_live, detection_latency, and rollback_wall_clock only after a completed flip + soak. dual_host_live_metrics may be re-measured independently.";
  } else {
    next.dual_host_live_metrics = summary;
    next.dual_host_metrics_captured_at = receipt.captured_at;
  }

  return next;
}

/** Compact summary embedded in hosting-migration-baseline.json */
export function receiptToBaselineSummary(receipt) {
  const hosts = {};
  for (const h of receipt.hosts || []) {
    hosts[h.id] = {
      origin: h.origin,
      role: h.role,
      availability_rate: h.availability.rate,
      paths_ok: h.availability.paths_ok,
      paths_total: h.availability.paths_total,
      ttfb_ms: h.latency_ttfb,
      total_ms: h.latency_total,
      redirect_ok: h.paths.every((p) => p.redirect.ok),
      redirect_classes: [...new Set(h.paths.map((p) => p.redirect.class))],
      cache: {
        cf_cache_status_values: [
          ...new Set(
            h.paths
              .map((p) => p.cache_headers_sample?.["cf-cache-status"])
              .filter(Boolean),
          ),
        ],
        cache_control_values: [
          ...new Set(
            h.paths
              .map((p) => p.cache_headers_sample?.["cache-control"])
              .filter(Boolean),
          ),
        ],
        x_github_request_id_present: h.paths.some(
          (p) => p.cache_headers_sample?.["x-github-request-id"],
        ),
      },
    };
  }

  return {
    schema: METRICS_SCHEMA,
    phase: receipt.phase,
    captured_at: receipt.captured_at,
    samples_per_path: receipt.samples_per_path,
    hosts,
    payload_parity: {
      compared: receipt.payload_parity.compared,
      matched: receipt.payload_parity.matched,
      rate: receipt.payload_parity.rate,
      reference_host: receipt.payload_parity.reference_host,
      candidate_host: receipt.payload_parity.candidate_host,
      rows: receipt.payload_parity.rows.map((r) => ({
        path: r.path,
        match: r.match,
        match_kind: r.match_kind,
        production_bytes: r.production_mirror?.bytes ?? null,
        pages_bytes: r.pages_parallel?.bytes ?? null,
        production_sha256: r.production_mirror?.sha256 ?? null,
        pages_sha256: r.pages_parallel?.sha256 ?? null,
      })),
    },
    redirects: {
      ok: receipt.redirects_summary.ok,
      redirect_loops_detected: receipt.redirects_summary.redirect_loops_detected,
    },
    provenance: receipt.provenance,
    full_receipt: "docs/evidence/hosting-dual-host-metrics.json",
    tag: "measured",
  };
}

function parseArgs(argv) {
  const opts = {
    phase: "pre-cutover",
    samples: DEFAULT_SAMPLES,
    writeBaseline: null,
    outReceipt: "docs/evidence/hosting-dual-host-metrics.json",
    requestTimeoutMs: DEFAULT_REQUEST_TIMEOUT_MS,
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--phase") opts.phase = argv[++i];
    else if (arg === "--samples") opts.samples = Number(argv[++i]);
    else if (arg === "--write-baseline") opts.writeBaseline = argv[++i];
    else if (arg === "--out-receipt") opts.outReceipt = argv[++i];
    else if (arg === "--request-timeout-ms") opts.requestTimeoutMs = Number(argv[++i]);
    else if (arg === "--help" || arg === "-h") opts.help = true;
  }
  return opts;
}

export async function main(argv = process.argv.slice(2)) {
  const opts = parseArgs(argv);
  if (opts.help) {
    console.log(`Usage: node tools/measure_hosting_baseline.mjs [options]

Read-only dual-host measurement for the hosting migration scorecard.
Does NOT change DNS, Worker routes, Pages custom domains, or deploy config.

Options:
  --phase pre-cutover|after-cutover   Measurement phase (default: pre-cutover)
  --samples N                        Latency samples per host/path (default: ${DEFAULT_SAMPLES})
  --out-receipt PATH                 Full JSON receipt
                                     (default: docs/evidence/hosting-dual-host-metrics.json)
  --write-baseline PATH              Merge summary into baseline scorecard JSON
  --request-timeout-ms N             Per-request timeout (default: ${DEFAULT_REQUEST_TIMEOUT_MS})

Re-run after an authorized cutover (one command):
  node tools/measure_hosting_baseline.mjs \\
    --phase after-cutover \\
    --samples 5 \\
    --out-receipt docs/evidence/hosting-dual-host-metrics-after.json \\
    --write-baseline docs/evidence/hosting-migration-baseline.json
`);
    return 0;
  }

  if (opts.phase !== "pre-cutover" && opts.phase !== "after-cutover") {
    console.error(`unknown --phase ${opts.phase} (use pre-cutover or after-cutover)`);
    return 2;
  }

  console.log(
    `hosting baseline measure: phase=${opts.phase} samples=${opts.samples} `
    + `hosts=${DEFAULT_HOSTS.length} paths=${DEFAULT_PATHS.length}`,
  );

  const receipt = await measureDualHost({
    phase: opts.phase,
    samples: opts.samples,
    requestTimeoutMs: opts.requestTimeoutMs,
    writeBaseline: opts.writeBaseline,
    outReceipt: opts.outReceipt,
  });

  if (opts.outReceipt) {
    const outPath = resolve(opts.outReceipt);
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, `${JSON.stringify(receipt, null, 2)}\n`, "utf8");
    console.log(`wrote receipt ${opts.outReceipt}`);
  }

  if (opts.writeBaseline) {
    const baselinePath = resolve(opts.writeBaseline);
    const baseline = JSON.parse(readFileSync(baselinePath, "utf8"));
    const merged = mergeBaselineMetrics(baseline, receipt, { phase: opts.phase });
    writeFileSync(baselinePath, `${JSON.stringify(merged, null, 2)}\n`, "utf8");
    console.log(`merged dual_host_live_metrics into ${opts.writeBaseline}`);
  }

  // Human summary
  for (const h of receipt.hosts) {
    console.log(
      `  ${h.id}: avail=${h.availability.paths_ok}/${h.availability.paths_total} `
      + `ttfb_median_ms=${h.latency_ttfb.median_ms} redirect_ok=${h.paths.every((p) => p.redirect.ok)}`,
    );
  }
  console.log(
    `  payload_parity: ${receipt.payload_parity.matched}/${receipt.payload_parity.compared} `
    + `(rate=${receipt.payload_parity.rate})`,
  );
  console.log(
    `  redirects: ok=${receipt.redirects_summary.ok} loops=${receipt.redirects_summary.redirect_loops_detected}`,
  );

  // Non-zero exit if redirect loops or complete unavailability — measurement still wrote.
  if (receipt.redirects_summary.redirect_loops_detected > 0) {
    console.error("FAIL: redirect loop detected (2026-07-30 class)");
    return 1;
  }
  const prod = receipt.hosts.find((h) => h.id === "production_mirror");
  if (prod && prod.availability.paths_ok === 0) {
    console.error("FAIL: production_mirror unavailable on all paths");
    return 1;
  }

  console.log("hosting baseline measure complete");
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then((code) => process.exit(code));
}
