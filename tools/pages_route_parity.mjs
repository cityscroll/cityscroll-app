#!/usr/bin/env node
/**
 * Route inventory parity sweep between two static-site origins.
 *
 * Compares HTTP status and a content marker for every path in the site's
 * public route inventory (sitemap pages plus robots/sitemap). Used to prove
 * the direct Cloudflare Pages hostname matches the public custom domain.
 * Never prints credentials.
 */

import { pathToFileURL } from "node:url";
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import {
  CONTENT_MARKER,
  cacheBustUrl,
  classifyProbe,
  formatStatusChain,
  probeUrl,
} from "./live_url_smoke.mjs";

/** Public static routes that must match between hosts after a parallel deploy. */
export const ROUTE_INVENTORY = Object.freeze([
  { path: "/", id: "home", kind: "html", marker: CONTENT_MARKER },
  { path: "/about.html", id: "about", kind: "html", marker: CONTENT_MARKER },
  { path: "/api.html", id: "api", kind: "html", marker: CONTENT_MARKER },
  { path: "/changelog.html", id: "changelog-redirect", kind: "html", marker: CONTENT_MARKER, retired: true },
  { path: "/data.html", id: "data-redirect", kind: "html", marker: CONTENT_MARKER, retired: true },
  { path: "/standards.html", id: "standards", kind: "html", marker: CONTENT_MARKER },
  { path: "/stats.html", id: "stats", kind: "html", marker: CONTENT_MARKER },
  { path: "/robots.txt", id: "robots", kind: "text", marker: /Sitemap:\s*https:\/\/cityscroll\.org\/sitemap\.xml/i },
  { path: "/sitemap.xml", id: "sitemap", kind: "xml", marker: /<urlset\b/i },
]);

export const DEFAULT_REFERENCE_ORIGIN = "https://cityscroll.org";
export const DEFAULT_CANDIDATE_ORIGIN = "https://cityscroll.pages.dev";

export function joinOrigin(origin, path) {
  const base = String(origin || "").replace(/\/+$/, "");
  const suffix = path.startsWith("/") ? path : `/${path}`;
  return `${base}${suffix}`;
}

export function targetsForOrigin(origin, inventory = ROUTE_INVENTORY) {
  return inventory.map((route) => ({
    id: route.id,
    path: route.path,
    kind: route.kind,
    url: joinOrigin(origin, route.path),
    marker: route.marker,
  }));
}

/**
 * Probe one origin for the full inventory.
 * @returns {Promise<object[]>}
 */
export async function probeInventory(origin, opts = {}) {
  const targets = targetsForOrigin(origin, opts.inventory ?? ROUTE_INVENTORY);
  const results = [];
  for (const target of targets) {
    const probe = await probeUrl(target.url, {
      fetchImpl: opts.fetchImpl,
      maxRedirects: opts.maxRedirects,
      requestTimeoutMs: opts.requestTimeoutMs,
      cacheBust: opts.cacheBust !== false,
      now: opts.now,
      marker: target.marker,
    });
    results.push({
      id: target.id,
      path: target.path,
      kind: target.kind,
      origin,
      url: target.url,
      finalStatus: probe.finalStatus,
      finalUrl: probe.finalUrl,
      statusChain: probe.statusChain,
      ok: probe.classification.ok,
      reason: probe.classification.ok ? null : probe.classification.reason,
      markerMatched: probe.classification.ok,
      bodyBytes: (probe.body || "").length,
    });
  }
  return results;
}

/**
 * Compare reference vs candidate inventories.
 * @returns {{ ok: boolean, rows: object[], failures: string[] }}
 */
export function compareInventories(referenceRows, candidateRows) {
  const byPath = new Map(candidateRows.map((row) => [row.path, row]));
  const rows = [];
  const failures = [];

  for (const ref of referenceRows) {
    const cand = byPath.get(ref.path);
    const statusMatch = Boolean(cand) && ref.finalStatus === cand.finalStatus;
    const bothOk = Boolean(cand) && ref.ok && cand.ok;
    const parityOk = statusMatch && bothOk;
    const row = {
      path: ref.path,
      id: ref.id,
      kind: ref.kind,
      reference: {
        status: ref.finalStatus,
        ok: ref.ok,
        reason: ref.reason,
        chain: formatStatusChain(ref.statusChain),
      },
      candidate: cand
        ? {
            status: cand.finalStatus,
            ok: cand.ok,
            reason: cand.reason,
            chain: formatStatusChain(cand.statusChain),
          }
        : null,
      statusMatch,
      parityOk,
    };
    rows.push(row);
    if (!parityOk) {
      const detail = !cand
        ? "missing candidate probe"
        : !statusMatch
          ? `status ${ref.finalStatus} vs ${cand.finalStatus}`
          : `content failure ref=${ref.reason || "ok"} cand=${cand.reason || "ok"}`;
      failures.push(`${ref.path}: ${detail}`);
    }
  }

  return { ok: failures.length === 0, rows, failures };
}

export function formatParityReport({
  referenceOrigin,
  candidateOrigin,
  comparedAt,
  comparison,
  referenceRows,
  candidateRows,
}) {
  const lines = [
    "# Cloudflare Pages route parity report",
    "",
    "The direct Cloudflare Pages hostname is compared against the public site",
    "for every path in the public route inventory.",
    "",
    `- Compared at: ${comparedAt}`,
    `- Reference (live): ${referenceOrigin}`,
    `- Candidate (Pages): ${candidateOrigin}`,
    `- Inventory size: ${ROUTE_INVENTORY.length}`,
    `- Overall: ${comparison.ok ? "PASS" : "FAIL"}`,
    "",
    "## Routes",
    "",
    "| Path | Ref status | Cand status | Marker | Parity |",
    "| --- | ---: | ---: | --- | --- |",
  ];

  for (const row of comparison.rows) {
    const marker = row.parityOk
      ? "ok"
      : row.candidate?.ok === false
        ? "candidate marker miss"
        : row.reference?.ok === false
          ? "reference marker miss"
          : "mismatch";
    lines.push(
      `| \`${row.path}\` | ${row.reference.status} | ${row.candidate?.status ?? "—"} | ${marker} | ${row.parityOk ? "pass" : "FAIL"} |`,
    );
  }

  if (comparison.failures.length) {
    lines.push("", "## Failures", "");
    for (const failure of comparison.failures) {
      lines.push(`- ${failure}`);
    }
  } else {
    lines.push(
      "",
      "## Result",
      "",
      "Every inventory route returned HTTP 200 with the expected content marker",
      "on both hosts. Status codes matched path-for-path.",
    );
  }

  lines.push(
    "",
    "## Probe detail",
    "",
    "### Reference",
    "",
  );
  for (const row of referenceRows) {
    lines.push(
      `- \`${row.path}\` status=${row.finalStatus} ok=${row.ok} chain=${formatStatusChain(row.statusChain)}`,
    );
  }
  lines.push("", "### Candidate", "");
  for (const row of candidateRows) {
    lines.push(
      `- \`${row.path}\` status=${row.finalStatus} ok=${row.ok} chain=${formatStatusChain(row.statusChain)}`,
    );
  }
  lines.push("");
  return lines.join("\n");
}

export const DEFAULT_TIMEOUT_MS = 180_000;
export const DEFAULT_INTERVAL_MS = 10_000;

function parseArgs(argv) {
  const opts = {
    reference: DEFAULT_REFERENCE_ORIGIN,
    candidate: DEFAULT_CANDIDATE_ORIGIN,
    out: null,
    cacheBust: true,
    requestTimeoutMs: 20_000,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    intervalMs: DEFAULT_INTERVAL_MS,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--reference") opts.reference = argv[++i];
    else if (arg === "--candidate") opts.candidate = argv[++i];
    else if (arg === "--out") opts.out = argv[++i];
    else if (arg === "--no-cache-bust") opts.cacheBust = false;
    else if (arg === "--request-timeout-ms") opts.requestTimeoutMs = Number(argv[++i]);
    else if (arg === "--timeout-ms") opts.timeoutMs = Number(argv[++i]);
    else if (arg === "--interval-ms") opts.intervalMs = Number(argv[++i]);
    else if (arg === "--help" || arg === "-h") opts.help = true;
  }
  return opts;
}

/**
 * Probe both origins until parity passes or the retry window elapses.
 * Fresh deploys can return 522/5xx on pages.dev for a short window before the edge is ready.
 */
export async function runParity({
  reference,
  candidate,
  cacheBust = true,
  requestTimeoutMs = 20_000,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  intervalMs = DEFAULT_INTERVAL_MS,
  fetchImpl,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  now = () => Date.now(),
} = {}) {
  const deadline = now() + timeoutMs;
  let attempts = 0;
  let referenceRows = [];
  let candidateRows = [];
  let comparison = { ok: false, rows: [], failures: ["not started"] };

  while (true) {
    attempts += 1;
    referenceRows = await probeInventory(reference, {
      cacheBust,
      requestTimeoutMs,
      fetchImpl,
      now: now(),
    });
    candidateRows = await probeInventory(candidate, {
      cacheBust,
      requestTimeoutMs,
      fetchImpl,
      now: now(),
    });
    comparison = compareInventories(referenceRows, candidateRows);
    if (comparison.ok) {
      return { ok: true, attempts, referenceRows, candidateRows, comparison };
    }
    const remaining = deadline - now();
    if (remaining <= 0) break;
    console.error(
      `route parity attempt ${attempts} failed (${comparison.failures.length} path(s)); retrying…`,
    );
    await sleep(Math.min(intervalMs, Math.max(0, remaining)));
    if (now() > deadline) break;
  }

  return { ok: false, attempts, referenceRows, candidateRows, comparison };
}

export async function main(argv = process.argv.slice(2)) {
  const opts = parseArgs(argv);
  if (opts.help) {
    console.log(`Usage: node tools/pages_route_parity.mjs \\
  [--reference ${DEFAULT_REFERENCE_ORIGIN}] \\
  [--candidate ${DEFAULT_CANDIDATE_ORIGIN}] \\
  [--out docs/evidence/cloudflare-pages-route-parity.md] \\
  [--timeout-ms ${DEFAULT_TIMEOUT_MS}] [--interval-ms ${DEFAULT_INTERVAL_MS}]

Probes the full route inventory on both origins and writes a parity report.
Retries inside the timeout window so a fresh pages.dev deploy can warm up.
`);
    return 0;
  }

  console.log(
    `route parity: reference=${opts.reference} candidate=${opts.candidate} `
    + `routes=${ROUTE_INVENTORY.length} (timeout ${opts.timeoutMs}ms)`,
  );

  const result = await runParity({
    reference: opts.reference,
    candidate: opts.candidate,
    cacheBust: opts.cacheBust,
    requestTimeoutMs: opts.requestTimeoutMs,
    timeoutMs: opts.timeoutMs,
    intervalMs: opts.intervalMs,
  });
  const comparedAt = new Date().toISOString();
  const report = formatParityReport({
    referenceOrigin: opts.reference,
    candidateOrigin: opts.candidate,
    comparedAt,
    comparison: result.comparison,
    referenceRows: result.referenceRows,
    candidateRows: result.candidateRows,
  });

  if (opts.out) {
    mkdirSync(dirname(opts.out), { recursive: true });
    writeFileSync(opts.out, report, "utf8");
    console.log(`wrote ${opts.out}`);
  } else {
    process.stdout.write(report);
  }

  if (!result.ok) {
    console.error(
      `route parity FAILED after ${result.attempts} attempt(s) (${result.comparison.failures.length} path(s))`,
    );
    for (const failure of result.comparison.failures) console.error(`  ${failure}`);
    return 1;
  }

  console.log(`route parity PASS after ${result.attempts} attempt(s)`);
  return 0;
}

// re-export cacheBustUrl so tests can assert inventory URLs stay cache-busted via probe
export { cacheBustUrl };

const isDirect = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirect) {
  main().then((code) => {
    process.exitCode = code;
  }).catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}
