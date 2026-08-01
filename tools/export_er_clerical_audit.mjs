#!/usr/bin/env node
// Export a read-only ER clerical audit from live D1 observations or an offline
// JSON fixture. A separate promotion mode appends reviewed rows to a new gold
// version and refuses to overwrite any existing gold file.

import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  buildClericalAudit,
  formatAuditJsonl,
  formatLabelSheet,
  promoteLabelsToGold,
} from "../entity_resolution/eval/clerical_audit.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_DATABASE = "crol-notices";
const DEFAULT_LIMIT = 1000;

function usage(message) {
  if (message) console.error(`error: ${message}`);
  console.error(`Usage:
  node tools/export_er_clerical_audit.mjs --live --out-dir <directory> [options]
  node tools/export_er_clerical_audit.mjs --input <rows.json> --out-dir <directory> [options]
  node tools/export_er_clerical_audit.mjs --promote <label_sheet.csv> \\
    --base-gold <gold_vN.jsonl> --gold-out <gold_vN+1.jsonl> [options]

Export options:
  --observed-on YYYY-MM-DD
  --auto-link-size N                 default 30
  --near-miss-size N                 default 60 (false-split priority)
  --near-miss-min-similarity 0..1    default 0.3
  --limit N                          live input row cap; default 1000
  --database NAME                    default crol-notices
  --replace                          replace a differing audit artifact

Promotion options:
  --gold-version vN                  otherwise derived from --gold-out basename
  --promoted-on YYYY-MM-DD
  --promotion-receipt <path>         default beside --gold-out

Live mode executes SELECT queries only. It prefers source_records when populated
and otherwise replays the current checked-in ER policy over live notices.`);
  process.exitCode = message ? 1 : 0;
}

function parseArgs(argv) {
  const args = {
    live: false,
    input: null,
    outDir: null,
    observedOn: new Date().toISOString().slice(0, 10),
    autoLinkSize: undefined,
    nearMissSize: undefined,
    nearMissMinSimilarity: undefined,
    limit: DEFAULT_LIMIT,
    database: DEFAULT_DATABASE,
    replace: false,
    promote: null,
    baseGold: null,
    goldOut: null,
    goldVersion: null,
    promotedOn: new Date().toISOString().slice(0, 10),
    promotionReceipt: null,
    help: false,
  };
  const valueFlags = new Map([
    ["--input", "input"],
    ["--out-dir", "outDir"],
    ["--observed-on", "observedOn"],
    ["--auto-link-size", "autoLinkSize"],
    ["--near-miss-size", "nearMissSize"],
    ["--near-miss-min-similarity", "nearMissMinSimilarity"],
    ["--limit", "limit"],
    ["--database", "database"],
    ["--promote", "promote"],
    ["--base-gold", "baseGold"],
    ["--gold-out", "goldOut"],
    ["--gold-version", "goldVersion"],
    ["--promoted-on", "promotedOn"],
    ["--promotion-receipt", "promotionReceipt"],
  ]);
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--live") args.live = true;
    else if (arg === "--replace") args.replace = true;
    else if (arg === "--help" || arg === "-h") args.help = true;
    else if (valueFlags.has(arg)) {
      const value = argv[++i];
      if (value == null) throw new Error(`${arg} requires a value`);
      args[valueFlags.get(arg)] = value;
    } else {
      throw new Error(`unknown argument ${arg}`);
    }
  }
  for (const key of ["autoLinkSize", "nearMissSize", "limit"]) {
    if (args[key] !== undefined) {
      args[key] = Number(args[key]);
      if (!Number.isInteger(args[key]) || args[key] < 0) {
        throw new Error(`--${key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)} requires a non-negative integer`);
      }
    }
  }
  if (args.limit < 1 || args.limit > 5000) throw new Error("--limit must be between 1 and 5000");
  if (args.nearMissMinSimilarity !== undefined) {
    args.nearMissMinSimilarity = Number(args.nearMissMinSimilarity);
    if (!Number.isFinite(args.nearMissMinSimilarity)
      || args.nearMissMinSimilarity < 0
      || args.nearMissMinSimilarity > 1) {
      throw new Error("--near-miss-min-similarity must be between 0 and 1");
    }
  }
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
  if (!/^SELECT\b/i.test(sql.trim())) throw new Error("live clerical audit accepts SELECT queries only");
  const command = spawnSync(
    "npx",
    [
      "--no-install",
      "wrangler",
      "d1",
      "execute",
      database,
      "--remote",
      "--json",
      "--command",
      sql,
    ],
    {
      cwd: join(ROOT, "worker"),
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
    },
  );
  if (command.status !== 0) {
    throw new Error(`Wrangler SELECT failed: ${String(command.stderr || command.stdout).trim()}`);
  }
  return parseWranglerResults(command.stdout);
}

function fetchLiveObservations(database, limit) {
  const status = wranglerSelect(
    database,
    `SELECT
       (SELECT COUNT(*) FROM notices) AS notices,
       (SELECT COUNT(*) FROM notices WHERE TRIM(COALESCE(vendor_name,'')) <> '') AS vendor_notices,
       (SELECT COUNT(*) FROM source_records) AS source_records,
       (SELECT COUNT(*) FROM entity_link) AS entity_links,
       (SELECT COUNT(*) FROM entity_link WHERE decision = 'auto_link') AS stored_auto_links`,
  )[0] || {};
  const useShadow = Number(status.source_records) > 0;
  const sql = useShadow
    ? `SELECT recent.source_system, recent.source_system_id, recent.content_hash,
              recent.normalized_snapshot, recent.ingested_at,
              GROUP_CONCAT(DISTINCT CASE
                WHEN link.decision = 'auto_link' THEN link.canonical_entity_id
              END) AS canonical_entity_ids,
              1 AS link_state_available
         FROM (
           SELECT source_system, source_system_id, content_hash,
                  normalized_snapshot, ingested_at
             FROM source_records
            ORDER BY ingested_at DESC, source_system_id DESC
            LIMIT ${limit}
         ) AS recent
         LEFT JOIN entity_link AS link
           ON link.source_record_id = (
             recent.source_system || ':' || recent.source_system_id || ':' || recent.content_hash
           )
        GROUP BY recent.source_system, recent.source_system_id, recent.content_hash,
                 recent.normalized_snapshot, recent.ingested_at
        ORDER BY recent.ingested_at DESC, recent.source_system_id DESC`
    : `SELECT 'city_record' AS source_system, request_id AS source_system_id,
              request_id AS source_record_id, vendor_name, pin, ingested_at,
              0 AS link_state_available
         FROM notices
        WHERE TRIM(COALESCE(vendor_name,'')) <> ''
        ORDER BY ingested_at DESC, request_id DESC
        LIMIT ${limit}`;
  const rows = wranglerSelect(database, sql);
  return {
    rows,
    provenance: {
      kind: "live_d1_read_only",
      database,
      input_relation: useShadow ? "source_records" : "notices_replay",
      replay_reason: useShadow ? null : "source_records_empty",
      relation_counts: {
        notices: Number(status.notices) || 0,
        vendor_notices: Number(status.vendor_notices) || 0,
        source_records: Number(status.source_records) || 0,
        entity_links: Number(status.entity_links) || 0,
        stored_auto_links: Number(status.stored_auto_links) || 0,
      },
      selected_rows: rows.length,
      row_limit: limit,
    },
  };
}

function readOfflineObservations(path) {
  const payload = JSON.parse(readFileSync(resolve(path), "utf8"));
  if (Array.isArray(payload) && payload.every((item) => item?.success !== undefined)) {
    return parseWranglerResults(JSON.stringify(payload));
  }
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.rows)) return payload.rows;
  throw new Error("--input must contain a JSON array, Wrangler JSON output, or {rows:[...]}");
}

function digest(text) {
  return createHash("sha256").update(text).digest("hex");
}

function repoPath(path) {
  const rel = relative(ROOT, path);
  return rel.startsWith("..") ? basename(path) : rel;
}

function writeAuditArtifact(path, text, replace) {
  if (existsSync(path)) {
    const prior = readFileSync(path, "utf8");
    if (prior === text) return "unchanged";
    if (!replace) throw new Error(`${repoPath(path)} exists with different content; pass --replace explicitly`);
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
  return "written";
}

function exportAudit(args) {
  if (args.live === Boolean(args.input)) {
    throw new Error("choose exactly one input: --live or --input");
  }
  if (!args.outDir) throw new Error("--out-dir is required for export");
  const live = args.live ? fetchLiveObservations(args.database, args.limit) : null;
  const rows = live?.rows || readOfflineObservations(args.input);
  const { sample, receipt: baseReceipt } = buildClericalAudit(rows, {
    observedOn: args.observedOn,
    autoLinkSize: args.autoLinkSize,
    nearMissSize: args.nearMissSize,
    nearMissMinSimilarity: args.nearMissMinSimilarity,
  });
  const outDir = resolve(args.outDir);
  const samplePath = join(outDir, "audit_sample.jsonl");
  const sheetPath = join(outDir, "label_sheet.csv");
  const receiptPath = join(outDir, "receipt.json");
  const sampleText = formatAuditJsonl(sample, baseReceipt);
  const sheetText = formatLabelSheet(sample);
  const receipt = {
    ...baseReceipt,
    input: live?.provenance || {
      kind: "offline_json",
      selected_rows: rows.length,
      source_name: basename(args.input),
    },
    artifacts: {
      sample: { path: repoPath(samplePath), sha256: digest(sampleText) },
      label_sheet: { path: repoPath(sheetPath), sha256: digest(sheetText) },
      receipt: { path: repoPath(receiptPath) },
    },
  };
  const receiptText = `${JSON.stringify(receipt, null, 2)}\n`;
  const states = [
    [samplePath, writeAuditArtifact(samplePath, sampleText, args.replace)],
    [sheetPath, writeAuditArtifact(sheetPath, sheetText, args.replace)],
    [receiptPath, writeAuditArtifact(receiptPath, receiptText, args.replace)],
  ];
  for (const [path, state] of states) console.log(`${state} ${repoPath(path)}`);
  console.log(
    `sampled near_miss=${receipt.strata.near_miss.sampled}/${receipt.strata.near_miss.eligible}`
      + ` auto_link=${receipt.strata.auto_link.sampled}/${receipt.strata.auto_link.eligible}`,
  );
}

function deriveGoldVersion(path) {
  const match = /^gold_(v\d+)\.jsonl$/.exec(basename(path));
  if (!match) throw new Error("--gold-out basename must be gold_vN.jsonl");
  return match[1];
}

function promoteGold(args) {
  if (!args.promote || !args.baseGold || !args.goldOut) {
    throw new Error("promotion requires --promote, --base-gold, and --gold-out");
  }
  const goldOut = resolve(args.goldOut);
  if (existsSync(goldOut)) {
    throw new Error(`${repoPath(goldOut)} already exists; gold versions are immutable`);
  }
  const goldVersion = args.goldVersion || deriveGoldVersion(goldOut);
  if (basename(goldOut) !== `gold_${goldVersion}.jsonl`) {
    throw new Error(`--gold-out must end in gold_${goldVersion}.jsonl`);
  }
  const result = promoteLabelsToGold({
    baseGoldText: readFileSync(resolve(args.baseGold), "utf8"),
    labelSheetText: readFileSync(resolve(args.promote), "utf8"),
    goldVersion,
    promotedOn: args.promotedOn,
  });
  const receiptPath = resolve(
    args.promotionReceipt || join(dirname(goldOut), `${basename(goldOut, ".jsonl")}_promotion_receipt.json`),
  );
  if (existsSync(receiptPath)) {
    throw new Error(`${repoPath(receiptPath)} already exists; choose a new promotion receipt path`);
  }
  const receipt = {
    ...result.receipt,
    base_gold_path: repoPath(resolve(args.baseGold)),
    label_sheet_path: repoPath(resolve(args.promote)),
    gold_path: repoPath(goldOut),
  };
  mkdirSync(dirname(goldOut), { recursive: true });
  mkdirSync(dirname(receiptPath), { recursive: true });
  writeFileSync(goldOut, result.text, { flag: "wx" });
  writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, { flag: "wx" });
  console.log(`written ${repoPath(goldOut)}`);
  console.log(`written ${repoPath(receiptPath)}`);
  console.log(`promoted ${receipt.promoted_cases} reviewed cases to ${receipt.gold_version}`);
}

export function main(argv = process.argv.slice(2)) {
  let args;
  try {
    args = parseArgs(argv);
    if (args.help) return usage();
    if (args.promote) promoteGold(args);
    else exportAudit(args);
  } catch (error) {
    console.error(`error: ${error.message || error}`);
    process.exitCode = 1;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) main();
