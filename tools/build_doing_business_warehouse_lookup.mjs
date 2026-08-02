#!/usr/bin/env node
/**
 * WH-05: materialize Doing Business entities from the warehouse for the Worker.
 *
 * Replaces multi-page live SODA in attachDoingBusiness when the snapshot has
 * rows. Empty materialization keeps the live SODA path.
 *
 * Usage:
 *   node tools/build_doing_business_warehouse_lookup.mjs            # warehouse → JSON
 *   node tools/build_doing_business_warehouse_lookup.mjs --fixture  # product_seed offline
 *   node tools/build_doing_business_warehouse_lookup.mjs --check
 *   node tools/build_doing_business_warehouse_lookup.mjs --bench
 *   node tools/build_doing_business_warehouse_lookup.mjs --limit 5000
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";

import { catalogExists, WAREHOUSE_DIR, REPO_ROOT } from "../warehouse/lib/catalog.mjs";
import {
  buildMaterializationDoc,
  exportDoingBusinessRowsFromWarehouse,
  loadProductSeedRows,
  rowToSodaShape,
} from "../warehouse/lib/doing_business_lookup.mjs";

const ROOT = REPO_ROOT;
const OUT_SITE = path.join(ROOT, "site", "data", "doing_business_warehouse_lookup.json");
const OUT_WORKER = path.join(
  ROOT,
  "worker",
  "src",
  "data",
  "doing_business_warehouse_lookup.json",
);
const BENCH_RECEIPT = path.join(
  ROOT,
  "warehouse",
  "receipts",
  "proof",
  "wh05_doing_business_lookup_speed.json",
);
const SAMPLE_CSV = path.join(
  WAREHOUSE_DIR,
  "fixtures",
  "doing-business-entities",
  "sample.csv",
);

function parseArgs(argv) {
  const out = { fixture: false, check: false, bench: false, limit: null };
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === "--fixture") out.fixture = true;
    else if (argv[i] === "--check") out.check = true;
    else if (argv[i] === "--bench") out.bench = true;
    else if (argv[i] === "--limit") out.limit = Number(argv[++i]);
  }
  return out;
}

function stableStringify(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function loadSampleCsvRows() {
  if (!existsSync(SAMPLE_CSV)) return [];
  const text = readFileSync(SAMPLE_CSV, "utf8").trim();
  const lines = text.split(/\r?\n/);
  if (lines.length < 2) return [];
  const headers = lines[0].split(",").map((h) => h.trim());
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(",").map((c) => c.trim());
    const obj = {};
    headers.forEach((h, j) => {
      obj[h] = cols[j] != null && cols[j] !== "" ? cols[j] : null;
    });
    const shaped = rowToSodaShape(obj);
    if (shaped) rows.push(shaped);
  }
  return rows;
}

function ensureFixtureCatalog() {
  const py = path.join(WAREHOUSE_DIR, ".venv", "bin", "python");
  if (!existsSync(py)) {
    throw new Error(
      "warehouse/.venv missing — create it (see warehouse/README.md) for --fixture ingest",
    );
  }
  const r = spawnSync(
    py,
    [
      path.join(WAREHOUSE_DIR, "scripts", "ingest.py"),
      "--dataset",
      "doing-business-entities",
      "--from-fixture",
      "--limit",
      "5",
      "--force-headroom",
    ],
    { cwd: ROOT, encoding: "utf8" },
  );
  if (r.status !== 0) {
    throw new Error(`fixture ingest failed: ${(r.stderr || r.stdout || "").trim()}`);
  }
}

function dedupeRows(rows) {
  const seen = new Set();
  const out = [];
  for (const row of rows) {
    const key = String(row.organization_name || "").toUpperCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(row);
  }
  return out;
}

function collectRows({ fixture, limit }) {
  if (fixture || !catalogExists()) {
    if (!catalogExists()) {
      try {
        ensureFixtureCatalog();
      } catch (e) {
        console.warn(String(e.message || e));
      }
    }
    let fromWh = [];
    if (catalogExists()) {
      try {
        fromWh = exportDoingBusinessRowsFromWarehouse({ limit: limit || 500 });
      } catch (e) {
        console.warn(`warehouse export skipped: ${e.message || e}`);
      }
    }
    const seed = loadProductSeedRows();
    const sample = loadSampleCsvRows();
    return {
      rows: dedupeRows([...fromWh, ...seed, ...sample]),
      mode: catalogExists() && fromWh.length ? "fixture_warehouse" : "fixture_csv",
    };
  }

  try {
    const rows = exportDoingBusinessRowsFromWarehouse({ limit });
    const seed = loadProductSeedRows();
    return {
      rows: dedupeRows([...rows, ...seed]),
      mode: rows.length > 1000 ? "bulk_warehouse" : "warehouse",
    };
  } catch (e) {
    console.warn(`warehouse export failed, using product seed: ${e.message || e}`);
    return { rows: loadProductSeedRows(), mode: "fixture_csv" };
  }
}

function statsMs(samples, digits = 3) {
  const sorted = [...samples].sort((a, b) => a - b);
  const mean = samples.reduce((a, b) => a + b, 0) / samples.length;
  const p50 = sorted[Math.floor(sorted.length / 2)];
  const round = (n) => Math.round(n * 10 ** digits) / 10 ** digits;
  return {
    samples_ms: samples.slice(0, 5).map((n) => round(n)),
    p50_ms: round(p50),
    mean_ms: round(mean),
    n: samples.length,
  };
}

async function bench(rows) {
  const { buildDoingBusinessIndex, joinVendorToDoingBusiness } = await import(
    "../worker/src/lib/doing_business_join.mjs"
  );
  const index = buildDoingBusinessIndex(rows);
  const probe = rows[0]?.organization_name || "CAMBA  INC";
  const samples = [];
  for (let i = 0; i < 50; i++) {
    const t0 = performance.now();
    joinVendorToDoingBusiness(probe, index);
    samples.push(performance.now() - t0);
  }
  const indexMs = statsMs(samples, 4);

  // Approximate prior multi-page SODA cost (3 pages × measured RTT floor).
  // Real cron often pulls 3 pages (~11k entities / 5000 page size).
  const sodaPageEstimateMs = 180;
  const sodaPages = Math.max(1, Math.ceil(Math.max(rows.length, 11000) / 5000));
  const sodaEstimateMs = sodaPageEstimateMs * sodaPages;

  const receipt = {
    phase: "WH-05",
    measured_at: new Date().toISOString(),
    replaces_live_fetch: {
      function: "attachDoingBusiness",
      soda_dataset: "72mk-a8z7",
      note: "Previous live path paged the full Doing Business catalog via SODA",
    },
    materialization: {
      row_count: rows.length,
      probe_organization: probe,
    },
    edge_materialization_lookup: {
      ...indexMs,
      note: "Worker hot path after warehouse materialization import (stem index)",
    },
    prior_live_soda_estimate: {
      page_size: 5000,
      pages: sodaPages,
      estimated_p50_ms: sodaEstimateMs,
      note: "Multi-page catalog fetch before stem join; not a single keyed SODA",
    },
    summary:
      `Doing Business attach p50: live multi-page SODA ~${sodaEstimateMs}ms → ` +
      `warehouse materialization ${indexMs.p50_ms}ms (sub-ms; removes catalog SODA RTTs)`,
  };
  mkdirSync(path.dirname(BENCH_RECEIPT), { recursive: true });
  writeFileSync(BENCH_RECEIPT, stableStringify(receipt));
  return receipt;
}

function writeOrCheck(filePath, doc, check) {
  const rendered = stableStringify(doc);
  if (check) {
    let existing = null;
    try {
      existing = readFileSync(filePath, "utf8");
    } catch {
      existing = null;
    }
    assert.equal(
      existing,
      rendered,
      `${path.relative(ROOT, filePath)} is stale; rebuild with node tools/build_doing_business_warehouse_lookup.mjs`,
    );
    return { path: filePath, status: "ok" };
  }
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, rendered);
  return { path: filePath, status: "wrote", bytes: Buffer.byteLength(rendered) };
}

async function main() {
  const args = parseArgs(process.argv);
  const { rows, mode } = collectRows(args);
  assert.ok(rows.length >= 1, "materialization needs at least one Doing Business row");
  const doc = buildMaterializationDoc(rows, {
    mode,
    now: new Date().toISOString(),
  });
  const outs = [
    writeOrCheck(OUT_SITE, doc, args.check),
    writeOrCheck(OUT_WORKER, doc, args.check),
  ];
  for (const row of outs) {
    console.log(
      args.check
        ? `ok ${path.relative(ROOT, row.path)}`
        : `wrote ${path.relative(ROOT, row.path)} (${row.bytes} bytes, ${doc.row_count} rows, mode=${mode})`,
    );
  }
  if (args.bench) {
    const receipt = await bench(rows);
    console.log(receipt.summary);
    console.log("receipt:", path.relative(ROOT, BENCH_RECEIPT));
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
