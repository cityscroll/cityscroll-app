#!/usr/bin/env node
/**
 * Host helper to rebuild the committed WH-05 floor (not a daily PR).
 * Live sell-facing freshness is Worker cron → ALERT_STATE `land:zap-lookup:v1`.
 *
 * 1. Materialize sell-facing WH-05 lookup from current SODA
 * 2. Rebuild the keyword search index (land family consumes the lookup)
 * 3. Rebuild the land default Active ULURP first-paint snapshot from SODA
 * 4. Optionally probe WH-02 bulk CSV lag (non-fatal unless --require-bulk-fresh)
 *
 * Usage:
 *   node tools/refresh_land_zap_freshness.mjs
 *   node tools/refresh_land_zap_freshness.mjs --check-only
 */

import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function parseArgs(argv) {
  return {
    checkOnly: argv.includes("--check-only"),
    requireBulkFresh: argv.includes("--require-bulk-fresh"),
    skipLandDefault: argv.includes("--skip-land-default"),
  };
}

function runNode(script, args = []) {
  const result = spawnSync(process.execPath, [script, ...args], {
    cwd: ROOT,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.status !== 0) {
    const err = new Error(
      `${path.relative(ROOT, script)} failed:\n${result.stderr || result.stdout || ""}`,
    );
    err.status = result.status;
    throw err;
  }
  return (result.stdout || "").trim();
}

function main() {
  const args = parseArgs(process.argv);
  const steps = [];

  if (args.checkOnly) {
    steps.push({
      name: "wh05_canaries",
      out: runNode(path.join(ROOT, "tools/build_zap_warehouse_lookup.mjs"), ["--check"]),
    });
    steps.push({
      name: "keyword_index",
      out: runNode(path.join(ROOT, "tools/build_keyword_search_index.mjs"), ["--check"]),
    });
    steps.push({
      name: "e_designation_digest",
      out: runNode(path.join(ROOT, "tools/build_e_designation_digest.mjs"), ["--check"]),
    });
    steps.push({
      name: "later_housing_activity",
      out: runNode(path.join(ROOT, "tools/build_later_housing_activity.mjs"), ["--check"]),
    });
  } else {
    steps.push({
      name: "wh05_from_soda",
      out: runNode(path.join(ROOT, "tools/build_zap_warehouse_lookup.mjs"), [
        "--from-soda",
      ]),
    });
    steps.push({
      name: "wh05_check",
      out: runNode(path.join(ROOT, "tools/build_zap_warehouse_lookup.mjs"), ["--check"]),
    });
    steps.push({
      name: "e_designation_digest",
      out: runNode(path.join(ROOT, "warehouse/scripts/refresh_e_designations.mjs")),
    });
    steps.push({
      name: "e_designation_digest_check",
      out: runNode(path.join(ROOT, "tools/build_e_designation_digest.mjs"), ["--check"]),
    });
    steps.push({
      name: "later_housing_activity",
      out: runNode(path.join(ROOT, "warehouse/scripts/refresh_housing_project_activity.mjs")),
    });
    steps.push({
      name: "later_housing_activity_check",
      out: runNode(path.join(ROOT, "tools/build_later_housing_activity.mjs"), ["--check"]),
    });
    steps.push({
      name: "keyword_index",
      out: runNode(path.join(ROOT, "tools/build_keyword_search_index.mjs"), []),
    });
    steps.push({
      name: "keyword_index_check",
      out: runNode(path.join(ROOT, "tools/build_keyword_search_index.mjs"), ["--check"]),
    });
    if (!args.skipLandDefault) {
      steps.push({
        name: "land_default",
        out: runNode(path.join(ROOT, "tools/build_batch_precompute_snapshots.mjs"), [
          "--land-only",
        ]),
      });
    }
  }

  let bulk = null;
  try {
    const out = runNode(path.join(ROOT, "tools/check_zap_bulk_freshness.mjs"), [
      args.requireBulkFresh ? "--check" : "",
    ].filter(Boolean));
    bulk = JSON.parse(out);
    steps.push({ name: "bulk_freshness", out });
  } catch (err) {
    if (args.requireBulkFresh) throw err;
    bulk = {
      status: "probe_failed_or_stale",
      error: String(err && err.message ? err.message : err).slice(0, 500),
    };
    steps.push({ name: "bulk_freshness", out: JSON.stringify(bulk) });
  }

  console.log(
    JSON.stringify(
      {
        status: "ok",
        mode: args.checkOnly ? "check_only" : "refresh",
        steps: steps.map((s) => s.name),
        bulk_freshness: bulk,
      },
      null,
      2,
    ),
  );
}

main();
