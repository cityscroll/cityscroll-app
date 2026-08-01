#!/usr/bin/env node
// Produce a read-only entity-resolution shadow-monitor receipt from the
// characterization fixture, an exported snapshot, or production D1 SELECTs.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  DEFAULT_MONITOR_WINDOW_DAYS,
  DEFAULT_SOURCE_STALE_AFTER_DAYS,
  buildShadowMonitorReceipt,
} from "../entity_resolution/evaluation/shadow_monitoring.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_FIXTURE = join(ROOT, "entity_resolution/eval/fixtures/shadow_monitoring_v0.json");
const DEFAULT_DATABASE = "crol-notices";
const DEFAULT_LIMIT = 5000;

function usage(message = null) {
  if (message) console.error(`error: ${message}`);
  console.error(`Usage:
  node tools/run_er_shadow_monitor.mjs --fixture [options]
  node tools/run_er_shadow_monitor.mjs --input <snapshot.json> [options]
  node tools/run_er_shadow_monitor.mjs --live [options]

Options:
  --observed-at ISO_TIMESTAMP
  --window-days N                    default ${DEFAULT_MONITOR_WINDOW_DAYS}
  --source-stale-after-days N        default ${DEFAULT_SOURCE_STALE_AFTER_DAYS}
  --compare <prior-receipt.json>     like-for-like delta, or incompatible
  --out <receipt.json>               write the deterministic receipt
  --check                            require --out to match generated content
  --database NAME                    live mode; default ${DEFAULT_DATABASE}
  --limit N                          live per-relation cap; default ${DEFAULT_LIMIT}
  --json                             print the complete receipt

Live mode issues SELECT statements only and never changes ER or public-read state.`);
  process.exitCode = message ? 1 : 0;
}

function parseArgs(argv) {
  const args = {
    fixture: false,
    input: null,
    live: false,
    observedAt: null,
    windowDays: DEFAULT_MONITOR_WINDOW_DAYS,
    sourceStaleAfterDays: DEFAULT_SOURCE_STALE_AFTER_DAYS,
    compare: null,
    out: null,
    check: false,
    database: DEFAULT_DATABASE,
    limit: DEFAULT_LIMIT,
    json: false,
    help: false,
  };
  const values = new Map([
    ["--input", "input"],
    ["--observed-at", "observedAt"],
    ["--window-days", "windowDays"],
    ["--source-stale-after-days", "sourceStaleAfterDays"],
    ["--compare", "compare"],
    ["--out", "out"],
    ["--database", "database"],
    ["--limit", "limit"],
  ]);
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === "--fixture") args.fixture = true;
    else if (arg === "--live") args.live = true;
    else if (arg === "--check") args.check = true;
    else if (arg === "--json") args.json = true;
    else if (arg === "--help" || arg === "-h") args.help = true;
    else if (values.has(arg)) {
      const value = argv[++index];
      if (value == null) throw new Error(`${arg} requires a value`);
      args[values.get(arg)] = value;
    } else throw new Error(`unknown argument: ${arg}`);
  }
  args.windowDays = Number(args.windowDays);
  args.sourceStaleAfterDays = Number(args.sourceStaleAfterDays);
  args.limit = Number(args.limit);
  if (!Number.isFinite(args.windowDays) || args.windowDays < 1) throw new Error("--window-days must be positive");
  if (!Number.isFinite(args.sourceStaleAfterDays) || args.sourceStaleAfterDays <= 0) {
    throw new Error("--source-stale-after-days must be positive");
  }
  if (!Number.isInteger(args.limit) || args.limit < 1 || args.limit > 25000) {
    throw new Error("--limit must be an integer from 1 to 25000");
  }
  if (args.check && !args.out) throw new Error("--check requires --out");
  return args;
}

function parseWranglerResults(text) {
  const payload = JSON.parse(text);
  if (!Array.isArray(payload)) throw new Error("Wrangler did not return a JSON result array");
  const failed = payload.find((result) => result?.success !== true);
  if (failed) throw new Error(`D1 query failed: ${JSON.stringify(failed)}`);
  return payload.flatMap((result) => Array.isArray(result.results) ? result.results : []);
}

function wranglerSelect(database, sql) {
  if (!/^SELECT\b/i.test(sql.trim())) throw new Error("live shadow monitor accepts SELECT queries only");
  const command = spawnSync("npx", [
    "--no-install", "wrangler", "d1", "execute", database,
    "--remote", "--json", "--command", sql,
  ], {
    cwd: join(ROOT, "worker"),
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  });
  if (command.status !== 0) {
    throw new Error(`Wrangler SELECT failed: ${String(command.stderr || command.stdout).trim()}`);
  }
  return parseWranglerResults(command.stdout);
}

function liveSnapshot(database, limit, observedAt) {
  const sourceRecords = wranglerSelect(database, `SELECT source_system, source_system_id,
      content_hash, normalized_snapshot, ingested_at
    FROM source_records ORDER BY ingested_at DESC LIMIT ${limit}`);
  const entityLinks = wranglerSelect(database, `SELECT source_record_id, canonical_entity_id,
      decision, confidence, method, matcher_version, resolution_run_id, created_at
    FROM entity_link ORDER BY created_at DESC LIMIT ${limit}`);
  const resolutionRuns = wranglerSelect(database, `SELECT id, method, matcher_version,
      started_at, finished_at, metrics_json, status
    FROM resolution_run ORDER BY started_at DESC LIMIT ${limit}`);
  const currentRecords = wranglerSelect(database, `SELECT 'city_record' AS source_system,
      request_id AS source_system_id, ingested_at
    FROM notices WHERE TRIM(COALESCE(vendor_name, '')) <> ''
    ORDER BY ingested_at DESC LIMIT ${limit}`);
  return {
    observed_at: observedAt || new Date().toISOString(),
    input_kind: "live_d1_read_only",
    source_records: sourceRecords,
    entity_links: entityLinks,
    resolution_runs: resolutionRuns,
    current_records: currentRecords,
    truncated: [sourceRecords, entityLinks, resolutionRuns, currentRecords].some((rows) => rows.length === limit),
  };
}

function readJson(path) {
  const resolved = resolve(path);
  if (!existsSync(resolved)) throw new Error(`input not found: ${path}`);
  return JSON.parse(readFileSync(resolved, "utf8"));
}

function printRate(name, signal) {
  console.log(`${name}_status=${signal.status}`);
  console.log(`${name}_numerator=${signal.numerator}`);
  console.log(`${name}_denominator=${signal.denominator}`);
  console.log(`${name}=${signal.value == null ? "null" : signal.value}`);
}

function repoPath(path) {
  const rel = relative(ROOT, resolve(path));
  return rel.startsWith("..") ? String(path) : rel;
}

export function main(argv = process.argv.slice(2)) {
  try {
    const args = parseArgs(argv);
    if (args.help) return usage();
    const selected = Number(args.fixture) + Number(Boolean(args.input)) + Number(args.live);
    if (selected !== 1) throw new Error("choose exactly one input: --fixture, --input, or --live");
    const input = args.live
      ? liveSnapshot(args.database, args.limit, args.observedAt)
      : readJson(args.fixture ? DEFAULT_FIXTURE : args.input);
    const baseline = args.compare ? readJson(args.compare) : null;
    const receipt = buildShadowMonitorReceipt(input, {
      observedAt: args.observedAt || input.observed_at,
      windowDays: args.windowDays,
      sourceStaleAfterDays: args.sourceStaleAfterDays,
      inputKind: input.input_kind,
      baseline,
    });
    const text = `${JSON.stringify(receipt, null, 2)}\n`;
    if (args.out) {
      const out = resolve(args.out);
      if (args.check) {
        if (!existsSync(out) || readFileSync(out, "utf8") !== text) {
          throw new Error(`${repoPath(out)} is stale; regenerate it with --out`);
        }
        console.log(`checked ${repoPath(out)}`);
      } else {
        mkdirSync(dirname(out), { recursive: true });
        writeFileSync(out, text);
        console.log(`written ${repoPath(out)}`);
      }
    }
    printRate("candidate_recall", receipt.signals.authority.candidate_recall);
    printRate("unresolved_rate", receipt.signals.candidates.unresolved_rate);
    printRate("orphan_rate", receipt.signals.coverage.orphan_rate);
    printRate("contradiction_rate", receipt.signals.contradiction_rate);
    console.log(`source_freshness_status=${receipt.signals.source_freshness.status}`);
    console.log(`stale_sources=${receipt.signals.source_freshness.stale_sources}`);
    console.log(`comparison_status=${receipt.comparison.status}`);
    if (args.json) console.log(text.trimEnd());
    return receipt;
  } catch (error) {
    console.error(`error: ${error.message || error}`);
    process.exitCode = 1;
    return null;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) main();
