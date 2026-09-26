#!/usr/bin/env node
// Worker startup CPU budget guard.
//
// A Cloudflare Worker must finish its top-level ("startup") evaluation within a
// CPU budget, or the upload is rejected with validation error 10021
// ("Script startup exceeded CPU time limit"). Every module reached from the
// entry point through a static `import` is evaluated at startup; a large JSON
// imported that way (`import data from "./big.json" with { type: "json" }`) is
// built into an object literal during startup, and that parse is the dominant,
// avoidable cost.
//
// This guard reads an esbuild metafile — produced by
// `wrangler deploy --dry-run --metafile <file>` — and fails when a large JSON
// sits on the startup (static-import) graph unless it is a grandfathered
// baseline dataset. A NEW large dataset must be loaded off the startup path:
// a dynamic `import()` (parsed on first request), or a KV/asset read. It runs in
// pull-request CI so this class of regression is caught before it reaches the
// deploy that Cloudflare would reject.
//
// Usage:
//   node tools/worker_startup_budget.mjs --metafile <path> [--json]
//
// Exit code is non-zero when any finding is reported.

import { readFileSync } from "node:fs";
import path from "node:path";

// A JSON module above this size is "large" — cheap ones cost little at startup.
export const STARTUP_JSON_PER_FILE_LIMIT_BYTES = 512 * 1024; // 0.5 MiB

// Aggregate backstop over the whole startup-evaluated JSON footprint. Set with
// headroom above the current baseline so ordinary data-refresh growth of the
// grandfathered datasets does not block deploys, while a gross regression does.
export const STARTUP_JSON_AGGREGATE_LIMIT_BYTES = 44 * 1024 * 1024; // 44 MiB

// Large JSON already evaluated at startup when this guard was introduced
// (repo-relative paths). These predate the guard and are accepted as-is.
//
// Do NOT add an entry here to silence the guard for a NEW dataset — import it
// lazily instead (dynamic import() or a KV read) so its parse runs on first
// request, not during startup. Growing an existing entry is allowed; the
// aggregate backstop above still applies to the whole footprint.
export const STARTUP_JSON_BASELINE_ALLOWLIST = new Set([
  "site/data/procurement_digest_snapshot.json",
  "site/data/exam_certification_constellation.json",
  "worker/src/data/zap_bbl_warehouse_lookup.json",
  "worker/src/data/zap_projects_warehouse_lookup.json",
  "worker/src/data/doing_business_warehouse_lookup.json",
  "site/data/legal_code/manifest.json",
  "site/data/staffing_exams.json",
  "worker/src/data/community_board_geography_lookup.json",
  "worker/src/data/passport_ei_graph.json",
  "worker/src/data/agency_entity_publication.json",
]);

/**
 * esbuild metafile input paths are relative to the directory wrangler ran in
 * (worker/). Normalize to a stable repo-relative path so the allowlist does not
 * depend on that working directory or on ambiguous basenames.
 */
export function toRepoRelative(metaPath, { workerDir = "worker" } = {}) {
  return path.posix.normalize(path.posix.join(workerDir, metaPath));
}

/**
 * Set of metafile input keys evaluated during startup: everything reachable from
 * an entry point through non-dynamic import edges. A module reached only via a
 * `dynamic-import` edge is deferred to first use and is excluded; one reached by
 * any static edge is included even if it is also imported dynamically elsewhere.
 */
export function startupEvaluatedInputs(metafile) {
  const inputs = metafile?.inputs || {};
  const entries = Object.values(metafile?.outputs || {})
    .map((output) => output?.entryPoint)
    .filter(Boolean);
  const seen = new Set();
  const stack = [...entries];
  while (stack.length) {
    const current = stack.pop();
    if (seen.has(current) || !inputs[current]) continue;
    seen.add(current);
    for (const edge of inputs[current].imports || []) {
      if (edge.kind === "dynamic-import") continue; // deferred, not startup
      if (edge.path && !seen.has(edge.path)) stack.push(edge.path);
    }
  }
  return seen;
}

/**
 * Assess a bundle metafile against the startup JSON budgets.
 * @returns {{ startupJsonBytes: number, largeStartupJson: Array, findings: Array }}
 */
export function assessWorkerStartupBudget(metafile, {
  perFileLimitBytes = STARTUP_JSON_PER_FILE_LIMIT_BYTES,
  aggregateLimitBytes = STARTUP_JSON_AGGREGATE_LIMIT_BYTES,
  allowlist = STARTUP_JSON_BASELINE_ALLOWLIST,
  workerDir = "worker",
} = {}) {
  const inputs = metafile?.inputs || {};
  const startup = startupEvaluatedInputs(metafile);
  const findings = [];
  let startupJsonBytes = 0;
  const largeStartupJson = [];

  for (const key of startup) {
    if (!key.endsWith(".json")) continue;
    const bytes = inputs[key]?.bytes || 0;
    startupJsonBytes += bytes;
    if (bytes <= perFileLimitBytes) continue;
    const repoPath = toRepoRelative(key, { workerDir });
    largeStartupJson.push({ path: repoPath, bytes });
    if (!allowlist.has(repoPath)) {
      findings.push({
        kind: "unlisted-large-startup-json",
        path: repoPath,
        bytes,
        limit: perFileLimitBytes,
        message: `${repoPath} (${(bytes / 1024 / 1024).toFixed(2)} MiB) is imported on the Worker startup graph. `
          + `Load it lazily (dynamic import() or KV) so its parse runs on first request, not at startup.`,
      });
    }
  }

  if (startupJsonBytes > aggregateLimitBytes) {
    findings.push({
      kind: "aggregate-startup-json-over-budget",
      bytes: startupJsonBytes,
      limit: aggregateLimitBytes,
      message: `Startup-evaluated JSON is ${(startupJsonBytes / 1024 / 1024).toFixed(2)} MiB, over the `
        + `${(aggregateLimitBytes / 1024 / 1024).toFixed(0)} MiB budget. Move a dataset off the startup path.`,
    });
  }

  largeStartupJson.sort((a, b) => b.bytes - a.bytes);
  return { startupJsonBytes, largeStartupJson, findings };
}

function arg(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : null;
}

function main() {
  const metafilePath = arg("--metafile");
  if (!metafilePath) {
    console.error("usage: node tools/worker_startup_budget.mjs --metafile <path> [--json]");
    process.exit(2);
  }
  const metafile = JSON.parse(readFileSync(metafilePath, "utf8"));
  const result = assessWorkerStartupBudget(metafile);
  const report = {
    startup_json_bytes: result.startupJsonBytes,
    startup_json_mib: Number(result.startupJsonBytes / 1024 / 1024).toFixed(2),
    per_file_limit_bytes: STARTUP_JSON_PER_FILE_LIMIT_BYTES,
    aggregate_limit_bytes: STARTUP_JSON_AGGREGATE_LIMIT_BYTES,
    large_startup_json: result.largeStartupJson,
    findings: result.findings,
  };
  console.log(JSON.stringify(report, null, 2));
  if (result.findings.length) {
    console.error(`Worker startup budget: ${result.findings.length} finding(s).`);
    process.exit(1);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
