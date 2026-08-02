#!/usr/bin/env node
/**
 * WH-05: materialize ZAP project lookup from the warehouse (DuckDB) for the Worker.
 *
 * Replaces the live SODA fetch in fetchOpenDataRow for project_ids present in the
 * warehouse snapshot. Misses still fall through to live SODA at request time.
 *
 * Usage:
 *   node tools/build_zap_warehouse_lookup.mjs            # warehouse catalog → JSON
 *   node tools/build_zap_warehouse_lookup.mjs --fixture  # seed + WH sample offline
 *   node tools/build_zap_warehouse_lookup.mjs --check    # fail if committed JSON is stale
 *   node tools/build_zap_warehouse_lookup.mjs --limit 500
 *   node tools/build_zap_warehouse_lookup.mjs --bench    # print warehouse vs SODA timing
 *
 * Does NOT download bulk data. If the catalog is empty/missing, --fixture builds
 * from warehouse fixtures (product_seed + sample) after a tiny offline ingest.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";

import { catalogExists, WAREHOUSE_DIR, REPO_ROOT } from "../warehouse/lib/catalog.mjs";
import {
  buildMaterializationDoc,
  buildZapLookupIndex,
  exportZapRowsFromWarehouse,
  loadProductSeedRows,
  lookupZapInIndex,
  lookupZapProjectFromWarehouse,
  parseCsv,
  rowToSodaShape,
} from "../warehouse/lib/zap_lookup.mjs";

const ROOT = REPO_ROOT;
const OUT_SITE = path.join(ROOT, "site", "data", "zap_projects_warehouse_lookup.json");
const OUT_WORKER = path.join(
  ROOT,
  "worker",
  "src",
  "data",
  "zap_projects_warehouse_lookup.json"
);
const BENCH_RECEIPT = path.join(
  ROOT,
  "warehouse",
  "receipts",
  "proof",
  "wh05_zap_lookup_speed.json"
);
const SAMPLE_CSV = path.join(WAREHOUSE_DIR, "fixtures", "zap-projects", "sample.csv");

function parseArgs(argv) {
  const out = { fixture: false, check: false, bench: false, limit: null, all: false };
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === "--fixture") out.fixture = true;
    else if (argv[i] === "--check") out.check = true;
    else if (argv[i] === "--bench") out.bench = true;
    else if (argv[i] === "--all") out.all = true;
    else if (argv[i] === "--limit") out.limit = Number(argv[++i]);
  }
  return out;
}

function stableStringify(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function loadSampleCsvRows() {
  if (!existsSync(SAMPLE_CSV)) return [];
  return parseCsv(readFileSync(SAMPLE_CSV, "utf8")).map(rowToSodaShape).filter(Boolean);
}

function ensureFixtureCatalog() {
  const py = path.join(WAREHOUSE_DIR, ".venv", "bin", "python");
  if (!existsSync(py)) {
    throw new Error(
      "warehouse/.venv missing — create it (see warehouse/README.md) for --fixture ingest"
    );
  }
  const r = spawnSync(
    py,
    [
      path.join(WAREHOUSE_DIR, "scripts", "ingest.py"),
      "--dataset",
      "zap-projects",
      "--from-fixture",
      "--limit",
      "5",
      "--force-headroom",
    ],
    { cwd: ROOT, encoding: "utf8" }
  );
  if (r.status !== 0) {
    throw new Error(`fixture ingest failed: ${(r.stderr || r.stdout || "").trim()}`);
  }
}

function dedupeRows(rows) {
  const seen = new Set();
  const out = [];
  for (const row of rows) {
    const key = row.project_id;
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(row);
  }
  return out;
}

function collectRows({ fixture, limit, all }) {
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
        // Prefer sell-facing export when bulk is present; fixture-only is fine.
        fromWh = exportZapRowsFromWarehouse({
          limit: limit || (all ? null : 500),
          all: !!all,
        });
      } catch (e) {
        console.warn(`warehouse export skipped: ${e.message || e}`);
      }
    }
    const seed = loadProductSeedRows();
    const sample = loadSampleCsvRows();
    return {
      rows: dedupeRows([...fromWh, ...seed, ...sample]),
      mode: catalogExists() ? "fixture_warehouse" : "fixture_csv",
    };
  }

  const rows = exportZapRowsFromWarehouse({ limit, all: !!all });
  const seed = loadProductSeedRows();
  return {
    rows: dedupeRows([...rows, ...seed]),
    mode: rows.length > 100 ? "bulk_warehouse" : "warehouse",
  };
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
  const edgeDemo =
    rows.find((r) => r.project_id === "2022M0258") ||
    rows.find((r) => r.project_id === "FIXZAP001") ||
    rows[0];
  const duckDemo =
    rows.find((r) => r.project_id === "FIXZAP001") ||
    rows.find((r) => r.project_id === "2022M0258") ||
    edgeDemo;
  if (!edgeDemo) return { error: "no rows to bench" };

  let warehouseMs = null;
  if (catalogExists()) {
    const samples = [];
    let last = null;
    for (let i = 0; i < 5; i++) {
      last = lookupZapProjectFromWarehouse(duckDemo.project_id);
      samples.push(last.ms);
    }
    warehouseMs = {
      ...statsMs(samples, 2),
      path: last.path,
      hit: !!last.row,
      project_id: duckDemo.project_id,
      note: "Python DuckDB CLI spawn per query — build/ops only, not Worker request path",
    };
  }

  const index = buildZapLookupIndex(rows);
  lookupZapInIndex(edgeDemo.project_id, index);
  const indexSamples = [];
  for (let i = 0; i < 200; i++) {
    const t0 = performance.now();
    lookupZapInIndex(edgeDemo.project_id, index);
    indexSamples.push(performance.now() - t0);
  }
  const hit = lookupZapInIndex(edgeDemo.project_id, index);
  const indexMs = {
    ...statsMs(indexSamples, 4),
    path: "materialized_index",
    hit: hit.hit,
    project_id: edgeDemo.project_id,
    note: "Worker hot path after warehouse materialization import",
  };

  let sodaMs = null;
  try {
    const where = `project_id='${String(edgeDemo.project_id).replace(/'/g, "''")}'`;
    const params = new URLSearchParams({
      $select:
        "project_id,project_name,public_status,project_status,approval_date,completed_date,ulurp_numbers,borough,community_district,actions,current_milestone,current_milestone_date",
      $where: where,
      $limit: "1",
    });
    const url = `https://data.cityofnewyork.us/resource/hgx4-8ukb.json?${params}`;
    const samples = [];
    let lastCount = 0;
    for (let i = 0; i < 3; i++) {
      const t0 = performance.now();
      const resp = await fetch(url);
      const data = resp.ok ? await resp.json() : [];
      samples.push(performance.now() - t0);
      lastCount = Array.isArray(data) ? data.length : 0;
    }
    sodaMs = {
      ...statsMs(samples, 2),
      path: "soda_live",
      rows: lastCount,
      url_class: "socrata_hgx4-8ukb_project_id",
      project_id: edgeDemo.project_id,
      note: "Previous live path in fetchOpenDataRow",
    };
  } catch (e) {
    sodaMs = { error: String(e && e.message ? e.message : e), path: "soda_live" };
  }

  let speedup = null;
  if (sodaMs && sodaMs.p50_ms != null && indexMs.p50_ms != null) {
    const floor = Math.max(indexMs.p50_ms, 0.01);
    const ratio = sodaMs.p50_ms / floor;
    speedup = {
      soda_p50_ms: sodaMs.p50_ms,
      warehouse_materialized_p50_ms: indexMs.p50_ms,
      ratio_vs_0_01ms_floor: Math.round(ratio * 10) / 10,
      summary:
        `ZAP Open Data lookup p50: live SODA ${sodaMs.p50_ms}ms → ` +
        `warehouse materialization ${indexMs.p50_ms}ms (sub-ms; removes a SODA RTT)`,
      note: "Edge path is the materialized index; DuckDB spawn is build-time only",
    };
  }

  return {
    phase: "WH-05",
    measured_at: new Date().toISOString(),
    replaced_fetch: {
      function: "fetchOpenDataRow",
      file: "worker/src/zap_outcomes.mjs",
      soda_dataset: "hgx4-8ukb",
      product: "ZAP Open Data project row on GET /zap-outcomes",
    },
    warehouse_duckdb_build_path: warehouseMs,
    materialized_index_edge_path: indexMs,
    soda_live_previous_path: sodaMs,
    speedup,
  };
}

function writeOutputs(doc, check) {
  const rendered = stableStringify(doc);
  const targets = [OUT_SITE, OUT_WORKER];
  if (check) {
    for (const filePath of targets) {
      let existing = null;
      try {
        existing = readFileSync(filePath, "utf8");
      } catch {
        existing = null;
      }
      const existingDoc = existing ? JSON.parse(existing) : null;
      assert.ok(existingDoc, `missing ${path.relative(ROOT, filePath)}`);
      assert.equal(existingDoc.schema_version, doc.schema_version);
      assert.equal(existingDoc.row_count, doc.row_count);
      assert.deepEqual(existingDoc.rows, doc.rows);
    }
    return { status: "ok", targets };
  }
  for (const filePath of targets) {
    mkdirSync(path.dirname(filePath), { recursive: true });
    writeFileSync(filePath, rendered);
  }
  return {
    status: "wrote",
    targets: targets.map((t) => path.relative(ROOT, t)),
    bytes: Buffer.byteLength(rendered),
    row_count: doc.row_count,
    mode: doc.mode,
  };
}

async function main() {
  const args = parseArgs(process.argv);
  const { rows, mode } = collectRows({
    fixture: args.fixture,
    limit: args.limit,
    all: args.all,
  });
  assert.ok(rows.length >= 1, "expected at least one ZAP row to materialize");

  let now = new Date().toISOString();
  if (args.check && existsSync(OUT_WORKER)) {
    try {
      now = JSON.parse(readFileSync(OUT_WORKER, "utf8")).materialized_at || now;
    } catch {
      /* keep now */
    }
  }

  const doc = buildMaterializationDoc(rows, { mode, now });
  doc.rows.sort((a, b) =>
    String(a.project_id || "").localeCompare(String(b.project_id || ""))
  );
  doc.row_count = doc.rows.length;

  const written = writeOutputs(doc, args.check);
  console.log(JSON.stringify(written, null, 2));

  if (args.bench) {
    const receipt = await bench(doc.rows);
    mkdirSync(path.dirname(BENCH_RECEIPT), { recursive: true });
    writeFileSync(BENCH_RECEIPT, stableStringify(receipt));
    console.log(`bench receipt → ${path.relative(ROOT, BENCH_RECEIPT)}`);
    if (receipt.speedup?.summary) console.log(receipt.speedup.summary);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
