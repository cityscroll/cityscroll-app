// Characterization for dual-host hosting baseline measurement (read-only harness).
// Pins redirect-loop failure class, latency summary math, parity, and baseline merge.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  buildPayloadParity,
  classifyRedirectExpectation,
  finalBodyGet,
  mergeBaselineMetrics,
  receiptToBaselineSummary,
  summarizeNumbers,
  timedGet,
  DEFAULT_HOSTS,
  METRICS_SCHEMA,
  measureDualHost,
} from "../tools/measure_hosting_baseline.mjs";
import { createFixtureFetch } from "../tools/live_url_smoke.mjs";

const fieldCase = JSON.parse(
  readFileSync(new URL("./fixtures/live_url_smoke/field-case-2026-07-30.json", import.meta.url), "utf8"),
);

test("summarizeNumbers reports n/min/max/mean/median/p95", () => {
  const s = summarizeNumbers([10, 20, 30, 40, 100]);
  assert.equal(s.n, 5);
  assert.equal(s.min_ms, 10);
  assert.equal(s.max_ms, 100);
  assert.equal(s.mean_ms, 40);
  assert.equal(s.median_ms, 30);
  assert.equal(s.p95_ms, 100);
});

test("summarizeNumbers empty stays nulls", () => {
  const s = summarizeNumbers([]);
  assert.equal(s.n, 0);
  assert.equal(s.median_ms, null);
});

test("classifyRedirectExpectation flags the 2026-07-30 redirect-loop class", async () => {
  const fetchImpl = createFixtureFetch(fieldCase.redirect_loop);
  const { probeUrl } = await import("../tools/live_url_smoke.mjs");
  const probe = await probeUrl("https://cityscroll.org/", {
    fetchImpl,
    cacheBust: false,
  });
  const host = DEFAULT_HOSTS.find((h) => h.id === "production_mirror");
  const result = classifyRedirectExpectation(host, probe);
  assert.equal(result.ok, false);
  assert.equal(result.class, "redirect_loop");
  assert.match(result.detail, /redirect loop/i);
});

test("classifyRedirectExpectation accepts legacy crol-list → cityscroll 301", () => {
  const host = DEFAULT_HOSTS.find((h) => h.id === "gh_pages_hostname");
  const probe = {
    statusChain: [
      { url: "https://crol-list.org/", status: 301, location: "https://cityscroll.org/" },
    ],
    finalStatus: 301,
    classification: { ok: false, reason: "final status 301, expected 200" },
  };
  const result = classifyRedirectExpectation(host, probe);
  assert.equal(result.ok, true);
  assert.equal(result.class, "legacy_hostname_redirect");
});

test("buildPayloadParity matches identical hashes", () => {
  const paths = [{ path: "/", kind: "html" }, { path: "/about.html", kind: "html" }];
  const rows = [
    { host_id: "production_mirror", path: "/", status: 200, bytes: 10, sha256: "aaa" },
    { host_id: "pages_parallel", path: "/", status: 200, bytes: 10, sha256: "aaa" },
    { host_id: "production_mirror", path: "/about.html", status: 200, bytes: 5, sha256: "bbb" },
    { host_id: "pages_parallel", path: "/about.html", status: 200, bytes: 5, sha256: "bbb" },
  ];
  const parity = buildPayloadParity(rows, paths);
  assert.equal(parity.compared, 2);
  assert.equal(parity.matched, 2);
  assert.equal(parity.rate, 1);
  assert.equal(parity.rows[0].match_kind, "sha256");
});

test("buildPayloadParity soft-matches HTML on equal bytes when hash differs", () => {
  const paths = [{ path: "/", kind: "html" }];
  const rows = [
    { host_id: "production_mirror", path: "/", status: 200, bytes: 100, sha256: "aaa" },
    { host_id: "pages_parallel", path: "/", status: 200, bytes: 100, sha256: "bbb" },
  ];
  const parity = buildPayloadParity(rows, paths);
  assert.equal(parity.matched, 1);
  assert.equal(parity.rows[0].match_kind, "bytes_only");
});

test("mergeBaselineMetrics pre-cutover preserves scorecard history", () => {
  const baseline = {
    schema: "hosting-migration-baseline.v1",
    merge_to_live: { n: 8, median_s: 74.5 },
    after_cutover: { status: "not-yet-measured", merge_to_live: null },
  };
  const receipt = {
    schema: METRICS_SCHEMA,
    phase: "pre-cutover",
    captured_at: "2026-08-01T12:00:00Z",
    samples_per_path: 3,
    hosts: [
      {
        id: "production_mirror",
        origin: "https://cityscroll.org",
        role: "mirror",
        availability: { rate: 1, paths_ok: 1, paths_total: 1 },
        latency_ttfb: { n: 3, median_ms: 50 },
        latency_total: { n: 3, median_ms: 60 },
        paths: [
          {
            redirect: { ok: true, class: "direct_200" },
            cache_headers_sample: { "cache-control": "public, max-age=0, must-revalidate" },
          },
        ],
      },
    ],
    payload_parity: {
      compared: 1,
      matched: 1,
      rate: 1,
      reference_host: "production_mirror",
      candidate_host: "pages_parallel",
      rows: [
        {
          path: "/",
          match: true,
          match_kind: "sha256",
          production_mirror: { bytes: 1, sha256: "x" },
          pages_parallel: { bytes: 1, sha256: "x" },
        },
      ],
    },
    redirects_summary: { ok: true, redirect_loops_detected: 0 },
    provenance: { harness: "tools/measure_hosting_baseline.mjs", tag: "measured" },
  };
  const merged = mergeBaselineMetrics(baseline, receipt, { phase: "pre-cutover" });
  assert.equal(merged.merge_to_live.median_s, 74.5);
  assert.equal(merged.after_cutover.status, "not-yet-measured");
  assert.equal(merged.dual_host_live_metrics.phase, "pre-cutover");
  assert.equal(merged.dual_host_live_metrics.tag, "measured");
  assert.equal(merged.dual_host_live_metrics.hosts.production_mirror.ttfb_ms.median_ms, 50);
});

test("mergeBaselineMetrics after-cutover is partial until scorecard fields land", () => {
  const baseline = {
    after_cutover: {
      status: "not-yet-measured",
      merge_to_live: null,
      detection_latency: null,
      rollback_wall_clock: null,
    },
  };
  const receipt = {
    schema: METRICS_SCHEMA,
    phase: "after-cutover",
    captured_at: "2026-09-01T00:00:00Z",
    samples_per_path: 1,
    hosts: [],
    payload_parity: {
      compared: 0,
      matched: 0,
      rate: 0,
      reference_host: "production_mirror",
      candidate_host: "pages_parallel",
      rows: [],
    },
    redirects_summary: { ok: true, redirect_loops_detected: 0 },
    provenance: { harness: "tools/measure_hosting_baseline.mjs" },
  };
  const merged = mergeBaselineMetrics(baseline, receipt, { phase: "after-cutover" });
  assert.equal(merged.after_cutover.dual_host_status, "measured");
  assert.equal(merged.after_cutover.status, "partial-dual-host-only");
  assert.equal(merged.after_cutover.merge_to_live, null);
  assert.ok(merged.after_cutover.dual_host_live_metrics);
});

test("receiptToBaselineSummary keeps compact host rows", () => {
  const summary = receiptToBaselineSummary({
    phase: "pre-cutover",
    captured_at: "2026-08-01T00:00:00Z",
    samples_per_path: 2,
    hosts: [
      {
        id: "pages_parallel",
        origin: "https://cityscroll.pages.dev",
        role: "pages",
        availability: { rate: 1, paths_ok: 2, paths_total: 2 },
        latency_ttfb: { median_ms: 40 },
        latency_total: { median_ms: 50 },
        paths: [
          {
            redirect: { ok: true, class: "direct_200" },
            cache_headers_sample: { "cf-cache-status": null, "cache-control": "public" },
          },
        ],
      },
    ],
    payload_parity: {
      compared: 1,
      matched: 1,
      rate: 1,
      reference_host: "production_mirror",
      candidate_host: "pages_parallel",
      rows: [
        {
          path: "/",
          match: true,
          match_kind: "sha256",
          production_mirror: { bytes: 9, sha256: "h" },
          pages_parallel: { bytes: 9, sha256: "h" },
        },
      ],
    },
    redirects_summary: { ok: true, redirect_loops_detected: 0 },
    provenance: { harness: "tools/measure_hosting_baseline.mjs" },
  });
  assert.equal(summary.schema, METRICS_SCHEMA);
  assert.equal(summary.hosts.pages_parallel.origin, "https://cityscroll.pages.dev");
  assert.equal(summary.payload_parity.rows[0].production_sha256, "h");
});

test("finalBodyGet follows Pages pretty-URL 308 to body", async () => {
  const map = {
    "https://cityscroll.pages.dev/about.html": {
      status: 308,
      location: "https://cityscroll.pages.dev/about",
      body: "",
    },
    "https://cityscroll.pages.dev/about": {
      status: 200,
      body: "<!doctype html><title>CityScroll</title>",
      headers: { "cache-control": "public, max-age=0, must-revalidate" },
    },
  };
  const baseFetch = createFixtureFetch(map);
  const fetchImpl = async (url, init) => {
    const res = await baseFetch(url, init);
    const text = await res.text();
    const bytes = new TextEncoder().encode(text);
    return {
      status: res.status,
      headers: res.headers,
      text: async () => text,
      arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    };
  };
  const row = await finalBodyGet("https://cityscroll.pages.dev/about.html", { fetchImpl });
  assert.equal(row.status, 200);
  assert.ok(row.bytes > 0);
  assert.ok(row.sha256);
  assert.match(row.finalUrl, /\/about$/);
});

test("timedGet records status and bytes via fixture fetch", async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    return {
      status: 200,
      headers: {
        get(name) {
          const map = {
            "cache-control": "public, max-age=0, must-revalidate",
            server: "cloudflare",
          };
          return map[String(name).toLowerCase()] ?? null;
        },
      },
      arrayBuffer: async () => new TextEncoder().encode("CityScroll hello").buffer,
    };
  };
  const row = await timedGet("https://cityscroll.org/", { fetchImpl });
  assert.equal(row.status, 200);
  assert.equal(row.bytes, 16);
  assert.equal(row.headers.server, "cloudflare");
  assert.ok(row.sha256);
  assert.equal(calls, 1);
});

test("measureDualHost with fixtures produces receipt without network", async () => {
  const html = "<!doctype html><title>CityScroll</title>";
  const body = html;
  const robots = "Sitemap: https://cityscroll.org/sitemap.xml\n";
  const sitemap = '<?xml version="1.0"?><urlset></urlset>';
  const png = new Uint8Array([137, 80, 78, 71]); // not real PNG parse needed

  function hop(status, bodyText, headers = {}, location = null) {
    return { status, body: bodyText, headers, location };
  }

  // Map every host/path to a healthy response; crol-list redirects.
  const map = {};
  const docHosts = [
    "https://cityscroll.org",
    "https://www.cityscroll.org",
    "https://cityscroll.pages.dev",
  ];
  const paths = [
    ["/", body],
    ["/about.html", body],
    ["/api.html", body],
    ["/changelog.html", body],
    ["/data.html", body],
    ["/standards.html", body],
    ["/stats.html", body],
    ["/robots.txt", robots],
    ["/sitemap.xml", sitemap],
  ];
  for (const origin of docHosts) {
    for (const [path, text] of paths) {
      map[`${origin}${path}`] = hop(200, text, {
        "cache-control": "public, max-age=0, must-revalidate",
        server: "cloudflare",
      });
    }
    map[`${origin}/assets/brand/apple-touch-icon.png`] = {
      status: 200,
      body: Buffer.from(png).toString("binary"),
      headers: { "content-type": "image/png", server: "cloudflare" },
      // arrayBuffer path: createFixtureFetch only supports text(); timedGet uses arrayBuffer.
      // Override below with a custom fetch.
    };
  }
  map["https://crol-list.org/"] = hop(301, "", {}, "https://cityscroll.org/");
  for (const [path] of paths) {
    if (path === "/") continue;
    map[`https://crol-list.org${path}`] = hop(301, "", {}, `https://cityscroll.org${path}`);
  }
  map["https://crol-list.org/assets/brand/apple-touch-icon.png"] = hop(
    301,
    "",
    {},
    "https://cityscroll.org/assets/brand/apple-touch-icon.png",
  );

  const baseFetch = createFixtureFetch(map);
  const fetchImpl = async (url, init) => {
    const res = await baseFetch(url, init);
    // Provide arrayBuffer for timedGet
    const text = await res.text();
    const bytes = new TextEncoder().encode(text);
    return {
      status: res.status,
      headers: res.headers,
      text: async () => text,
      arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    };
  };

  const receipt = await measureDualHost({
    fetchImpl,
    samples: 2,
    phase: "pre-cutover",
    capturedAt: "2026-08-01T00:00:00.000Z",
  });

  assert.equal(receipt.schema, METRICS_SCHEMA);
  assert.equal(receipt.phase, "pre-cutover");
  assert.equal(receipt.hosts.length, 4);
  assert.equal(receipt.redirects_summary.redirect_loops_detected, 0);
  assert.equal(receipt.redirects_summary.ok, true);
  const prod = receipt.hosts.find((h) => h.id === "production_mirror");
  assert.equal(prod.availability.paths_ok, prod.availability.paths_total);
  const legacy = receipt.hosts.find((h) => h.id === "gh_pages_hostname");
  assert.ok(legacy.paths.every((p) => p.redirect.class === "legacy_hostname_redirect"));
  assert.ok(receipt.payload_parity.rate >= 0.9);
});
