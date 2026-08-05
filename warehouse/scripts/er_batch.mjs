#!/usr/bin/env node
/**
 * WH-04 ER batch CLI (identity work). Prefer the capped Python entrypoint:
 *   warehouse/.venv/bin/python warehouse/scripts/er_batch_run.py --from-fixture --limit 25
 *
 * Direct (still needs a prior headroom check for non-fixture):
 *   node warehouse/scripts/er_batch.mjs --from-fixture --limit 25
 *   node warehouse/scripts/er_batch.mjs --limit 200
 */

import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  readdirSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  catalogExists,
  getDataset,
  warehouseRoot,
  WAREHOUSE_DIR,
  REPO_ROOT,
} from "../lib/catalog.mjs";
import { queryWarehouse } from "../lib/query.mjs";
import {
  runErBatch,
  OCP_SOURCE_SYSTEM,
  DOING_BUSINESS_SOURCE_SYSTEM,
  ER_BATCH_VERSION,
  sqlVerifyVendorResolution,
} from "../lib/er_batch.mjs";

const ROOT = REPO_ROOT;
export const MAX_LIVE_OCP_ROWS = 200;
const OCP_SAMPLE = path.join(
  WAREHOUSE_DIR,
  "fixtures",
  "ocp-recent-contract-awards",
  "sample.csv"
);
const ER_VARIANTS = path.join(
  WAREHOUSE_DIR,
  "fixtures",
  "er-batch",
  "ocp_vendor_variants.csv"
);
const DB_FIXTURE = path.join(
  WAREHOUSE_DIR,
  "fixtures",
  "er-batch",
  "doing_business_sample.csv"
);

function parseArgs(argv) {
  const out = {
    fromFixture: false,
    limit: 200,
    force: false,
    skipMaterialize: false,
    snapshotDate: null,
    reviewReceipt: null,
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--from-fixture") out.fromFixture = true;
    else if (a === "--force-headroom") out.force = true;
    else if (a === "--skip-materialize") out.skipMaterialize = true;
    else if (a === "--limit") out.limit = Number(argv[++i]);
    else if (a === "--snapshot-date") out.snapshotDate = String(argv[++i]);
    else if (a === "--review-receipt") out.reviewReceipt = String(argv[++i]);
    else if (a === "--help" || a === "-h") out.help = true;
  }
  if (!Number.isFinite(out.limit) || out.limit < 1) {
    throw new Error("--limit must be a positive number");
  }
  if (!out.fromFixture && out.limit > MAX_LIVE_OCP_ROWS) {
    throw new Error(
      `--limit ${out.limit} exceeds the WH-04 live OCP cap of ${MAX_LIVE_OCP_ROWS}`
    );
  }
  return out;
}

/** Minimal CSV parser for fixture files (no quoted commas in our fixtures). */
function parseSimpleCsv(text) {
  const lines = String(text || "")
    .trim()
    .split(/\r?\n/)
    .filter(Boolean);
  if (lines.length < 2) return [];
  const headers = lines[0].split(",").map((h) => h.trim());
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(",").map((c) => c.trim());
    const obj = {};
    headers.forEach((h, j) => {
      obj[h] = cols[j] != null && cols[j] !== "" ? cols[j] : null;
    });
    rows.push(obj);
  }
  return rows;
}

function loadFixtureOcpRows() {
  const base = existsSync(OCP_SAMPLE)
    ? parseSimpleCsv(readFileSync(OCP_SAMPLE, "utf8"))
    : [];
  const variants = existsSync(ER_VARIANTS)
    ? parseSimpleCsv(readFileSync(ER_VARIANTS, "utf8"))
    : [];
  return [...base, ...variants];
}

function loadFixtureDoingBusiness() {
  if (!existsSync(DB_FIXTURE)) return [];
  return parseSimpleCsv(readFileSync(DB_FIXTURE, "utf8"));
}

function loadWarehouseOcp(limit) {
  if (!catalogExists()) {
    throw new Error(
      "DuckDB catalog missing. Run WH-01/WH-02 ingest or use --from-fixture."
    );
  }
  const table = getDataset(OCP_SOURCE_SYSTEM).table_name;
  const sql =
    `SELECT request_id, start_date, agency_name, type_of_notice_description, ` +
    `pin, contract_amount, vendor_name, short_title ` +
    `FROM ${table} ` +
    `WHERE vendor_name IS NOT NULL AND CAST(vendor_name AS VARCHAR) <> '' ` +
    `LIMIT ${Number(limit)}`;
  return queryWarehouse(sql);
}

function loadWarehouseDoingBusiness(limit) {
  if (!catalogExists()) return [];
  let table;
  try {
    table = getDataset(DOING_BUSINESS_SOURCE_SYSTEM).table_name;
  } catch {
    return [];
  }
  // Probe existence: empty / missing view → skip quietly.
  try {
    const probe = queryWarehouse(
      `SELECT organization_name FROM ${table} LIMIT 1`
    );
    if (!probe.length) return [];
  } catch {
    return [];
  }
  const sql =
    `SELECT organization_name, ownership_structure_code, ` +
    `organization_phone, doing_business_start_date ` +
    `FROM ${table} ` +
    `WHERE organization_name IS NOT NULL AND CAST(organization_name AS VARCHAR) <> '' ` +
    `LIMIT ${Math.min(Number(limit) * 2, 2000)}`;
  try {
    return queryWarehouse(sql);
  } catch {
    return [];
  }
}

function snapshotDateUtc() {
  return new Date().toISOString().slice(0, 10);
}

function writeJsonl(filePath, rows) {
  const body = rows.map((r) => JSON.stringify(r)).join("\n") + (rows.length ? "\n" : "");
  writeFileSync(filePath, body, "utf8");
}

function materializeWithPython(stageDir, snap) {
  const py = path.join(WAREHOUSE_DIR, ".venv", "bin", "python");
  if (!existsSync(py)) {
    throw new Error(
      "warehouse/.venv missing — create it (see warehouse/README.md) to materialize parquet"
    );
  }
  const script = path.join(WAREHOUSE_DIR, "scripts", "materialize_er_batch.py");
  const r = spawnSync(
    py,
    [script, "--stage-dir", stageDir, "--snapshot-date", snap],
    { cwd: ROOT, encoding: "utf8" }
  );
  if (r.status !== 0) {
    throw new Error(
      `materialize_er_batch failed: ${(r.stderr || r.stdout || "").trim()}`
    );
  }
  return r.stdout.trim();
}

function writeProofReceipt(payload) {
  const dir = path.join(WAREHOUSE_DIR, "receipts", "proof");
  mkdirSync(dir, { recursive: true });
  const dest = path.join(dir, "wh04_er_batch_latest.json");
  writeFileSync(dest, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  return dest;
}

function relativeRepoPath(filePath) {
  if (!filePath) return null;
  const absolute = path.resolve(String(filePath));
  const relative = path.relative(ROOT, absolute);
  return relative.startsWith("..") ? null : relative;
}

function loadSourceFetchReceipt(snapshotDate) {
  const candidates = [
    path.join(
      WAREHOUSE_DIR,
      "receipts",
      `${OCP_SOURCE_SYSTEM}_${snapshotDate}.json`
    ),
    path.join(
      WAREHOUSE_DIR,
      "receipts",
      "proof",
      `${OCP_SOURCE_SYSTEM}_bulk_latest.json`
    ),
  ];
  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue;
    const source = JSON.parse(readFileSync(candidate, "utf8"));
    if (source.snapshot_date !== snapshotDate) continue;
    return {
      receipt: path.relative(ROOT, candidate),
      observed_at: source.observed_at || null,
      snapshot_date: source.snapshot_date || null,
      source_contract_id: source.source_contract_id || OCP_SOURCE_SYSTEM,
      socrata_dataset_id: source.socrata_dataset_id || null,
      mode: source.raw?.mode || null,
      requested_row_cap: source.limit,
      fetched_row_count: source.raw?.row_count ?? null,
      http_status: source.raw?.http_status ?? null,
      elapsed_s: source.raw?.elapsed_s ?? null,
      last_modified: source.raw?.last_modified || null,
      bytes: source.raw?.bytes ?? null,
      sha256: source.raw?.sha256 || null,
      request_url: source.raw?.url || null,
      raw_path: relativeRepoPath(source.raw?.path),
    };
  }
  return null;
}

function loadQualityReview(reviewPath, { metrics, sourceFetch }) {
  if (!reviewPath) return null;
  const absolute = path.resolve(ROOT, reviewPath);
  if (!existsSync(absolute)) {
    throw new Error(`Quality review receipt not found: ${reviewPath}`);
  }
  const review = JSON.parse(readFileSync(absolute, "utf8"));
  if (review.source_raw_sha256 !== sourceFetch?.sha256) {
    throw new Error("Quality review source_raw_sha256 does not match the live source receipt");
  }
  if (review.candidate_pairs !== metrics.pair_candidates) {
    throw new Error("Quality review candidate_pairs does not match this ER run");
  }
  if (review.accepted_pair_candidates !== metrics.pair_same) {
    throw new Error("Quality review accepted_pair_candidates does not match this ER run");
  }
  if (review.ambiguous_pair_candidates !== metrics.pair_unresolved) {
    throw new Error("Quality review ambiguous_pair_candidates does not match this ER run");
  }
  return {
    receipt: path.relative(ROOT, absolute),
    ...review,
  };
}

function main(argv = process.argv) {
  const startedNs = process.hrtime.bigint();
  const args = parseArgs(argv);
  if (args.help) {
    console.log(`WH-04 batch ER over warehouse tables

Usage:
  node warehouse/scripts/er_batch.mjs --from-fixture --limit 25
  node warehouse/scripts/er_batch.mjs --limit 200

Prefer the capped runner:
  warehouse/.venv/bin/python warehouse/scripts/er_batch_run.py --from-fixture --limit 25
`);
    return 0;
  }

  const snap = args.snapshotDate || snapshotDateUtc();
  const mode = args.fromFixture ? "fixture" : "warehouse";

  let ocpRows;
  let doingBusinessRows = [];
  if (args.fromFixture) {
    ocpRows = loadFixtureOcpRows();
    doingBusinessRows = loadFixtureDoingBusiness();
  } else {
    ocpRows = loadWarehouseOcp(args.limit);
    doingBusinessRows = loadWarehouseDoingBusiness(args.limit);
  }

  const batch = runErBatch({
    ocpRows,
    doingBusinessRows,
    limit: args.fromFixture ? args.limit : null, // warehouse path already LIMITed
    scopeNote:
      mode === "fixture"
        ? "WH-04 fixture proof (OCP sample + vendor variants + optional DB sample)"
        : `WH-04 warehouse slice limit=${args.limit}`,
  });
  const sourceFetch = args.fromFixture ? null : loadSourceFetchReceipt(snap);
  const qualityReview = loadQualityReview(args.reviewReceipt, {
    metrics: batch.metrics,
    sourceFetch,
  });

  const root = warehouseRoot();
  const stageDir = path.join(
    root,
    "raw",
    "er-batch",
    `snapshot_date=${snap}`
  );
  mkdirSync(stageDir, { recursive: true });

  writeJsonl(path.join(stageDir, "entity_link.jsonl"), batch.entity_links);
  writeJsonl(
    path.join(stageDir, "canonical_entity.jsonl"),
    batch.canonical_entities
  );
  writeJsonl(path.join(stageDir, "resolution_run.jsonl"), [
    batch.resolution_run,
  ]);
  writeJsonl(path.join(stageDir, "pair_receipt.jsonl"), batch.pair_receipts);
  writeFileSync(
    path.join(stageDir, "metrics.json"),
    `${JSON.stringify(batch.metrics, null, 2)}\n`,
    "utf8"
  );

  let materialize = null;
  if (!args.skipMaterialize) {
    const out = materializeWithPython(stageDir, snap);
    try {
      materialize = JSON.parse(out);
    } catch {
      materialize = { raw: out };
    }
  }

  // Derive multi-record stems for the proof summary (fixture / slice evidence).
  const stemCounts = new Map();
  for (const link of batch.entity_links) {
    if (link.entity_type !== "vendor" || link.decision !== "auto_link") continue;
    const id = link.canonical_entity_id;
    if (!id) continue;
    stemCounts.set(id, (stemCounts.get(id) || 0) + 1);
  }
  const multiSourceStems = {}; // code structure (not a sourced data table)
  for (const [id, n] of stemCounts) {
    if (n >= 2) {
      const short = String(id).replace(/^vendor:stem:/, "");
      multiSourceStems[short] = `${n} source_records → ${id}`;
    }
  }

  const receipt = {
    schema_version: 1,
    phase: "WH-04",
    title: "Batch entity-resolution over warehouse tables",
    er_batch_version: ER_BATCH_VERSION,
    mode,
    snapshot_date: snap,
    observed_at: new Date().toISOString(),
    limit: args.limit,
    live_ocp_cap: MAX_LIVE_OCP_ROWS,
    runtime_ms: Number(process.hrtime.bigint() - startedNs) / 1_000_000,
    source_fetch: sourceFetch,
    metrics: batch.metrics,
    resolution_run_id: batch.resolution_run.id,
    stage_dir: path.relative(ROOT, stageDir),
    materialize,
    verify_sql: "warehouse/sql/examples/er_entity_links_verify.sql",
    verify_sql_inline: sqlVerifyVendorResolution({ limit: 20 }),
    cpu_discipline: {
      single_job_lock: true,
      headroom_gate: true,
      taskpolicy_or_nice_wrap: true,
      duckdb_threads: 1,
      default_limit: 200,
      live_ocp_hard_cap: MAX_LIVE_OCP_ROWS,
      incremental: true,
    },
    reuse: {
      entity_resolution: [
        "vendorStem / VENDOR_STEM_METHOD",
        "generateCandidates (token_v0)",
        "scorePair (conventional_v1)",
        "canonicalAgency",
      ],
      worker_entity_link: ["buildExactStemAutoCase", "canonicalVendorIdForStem"],
    },
    what_resolved: {
      vendor_entities: batch.metrics.unique_vendor_entities,
      agency_entities: batch.metrics.unique_agency_entities,
      entity_link_rows: batch.metrics.entity_link_rows,
      pair_candidates: batch.metrics.pair_candidates,
      pair_same: batch.metrics.pair_same,
      multi_source_stems: multiSourceStems,
      cross_source_stem_hits: batch.metrics.cross_source_stem_hits,
    },
    quality_review: qualityReview,
    residual: args.fromFixture
      ? "Fixture evidence only; live-slice quality remains unmeasured."
      : "This receipt characterizes one bounded 200-row OCP slice only. Unresolved candidates remain unlinked, optional Doing Business rows reflect the currently registered warehouse snapshot, and no full-corpus safety or precision claim is inferred.",
    next_step:
      "Keep the 200-row cap. A wider or full-corpus ER run requires a separate decision and new resource and precision evidence.",
  };

  const proofPath = writeProofReceipt(receipt);
  console.log(
    JSON.stringify(
      {
        ok: true,
        mode,
        snapshot_date: snap,
        metrics: batch.metrics,
        proof: path.relative(ROOT, proofPath),
        materialize,
      },
      null,
      2
    )
  );
  console.log("OK");
  return 0;
}

const isMain =
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  try {
    process.exitCode = main();
  } catch (err) {
    console.error(err?.stack || String(err));
    process.exitCode = 1;
  }
}

export { main, parseArgs, loadFixtureOcpRows, parseSimpleCsv };
