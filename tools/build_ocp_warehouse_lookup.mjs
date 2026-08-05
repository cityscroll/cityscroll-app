#!/usr/bin/env node
/**
 * WH-03: materialize OCP awards lookup from the warehouse (DuckDB) for the Worker.
 *
 * Replaces the live SODA fetch in fetchOcpAwardRows for rows present in the
 * warehouse snapshot. Misses still fall through to live SODA at request time.
 *
 * Usage:
 *   node tools/build_ocp_warehouse_lookup.mjs            # warehouse catalog → JSON
 *   node tools/build_ocp_warehouse_lookup.mjs --fixture  # seed + WH-01 sample offline
 *   node tools/build_ocp_warehouse_lookup.mjs --check    # fail if committed JSON is stale
 *   node tools/build_ocp_warehouse_lookup.mjs --limit 5000
 *   node tools/build_ocp_warehouse_lookup.mjs --bench    # print warehouse vs SODA timing
 *
 * Does NOT download bulk data (WH-02). If the catalog is empty/missing, --fixture
 * builds from warehouse fixtures (product_seed + sample) after a tiny offline ingest.
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
  exportOcpRowsFromWarehouse,
  loadProductSeedRows,
  lookupOcpAwardRowsFromWarehouse,
  rowToSodaShape,
} from "../warehouse/lib/ocp_lookup.mjs";
import { queryWarehouse } from "../warehouse/lib/query.mjs";
import {
  publicPayloadFindings,
  publicRecords,
} from "./lib/public_payload_integrity.mjs";

const ROOT = REPO_ROOT;
const OUT_SITE = path.join(ROOT, "site", "data", "ocp_awards_warehouse_lookup.json");
const OUT_WORKER = path.join(
  ROOT,
  "worker",
  "src",
  "data",
  "ocp_awards_warehouse_lookup.json"
);
const BENCH_RECEIPT = path.join(
  ROOT,
  "warehouse",
  "receipts",
  "proof",
  "wh03_ocp_lookup_speed.json"
);
const SAMPLE_CSV = path.join(
  WAREHOUSE_DIR,
  "fixtures",
  "ocp-recent-contract-awards",
  "sample.csv"
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
      obj[h] = cols[j] != null ? cols[j] : null;
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
      "warehouse/.venv missing — create it (see warehouse/README.md) for --fixture ingest"
    );
  }
  const r = spawnSync(
    py,
    [
      path.join(WAREHOUSE_DIR, "scripts", "ingest.py"),
      "--dataset",
      "ocp-recent-contract-awards",
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
    const key = row.request_id || `${row.pin}|${row.start_date}|${row.contract_amount}`;
    if (seen.has(key)) continue;
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
        // Offline without venv: pure CSV path still builds a usable artifact.
        console.warn(String(e.message || e));
      }
    }
    let fromWh = [];
    if (catalogExists()) {
      try {
        fromWh = exportOcpRowsFromWarehouse({ limit: limit || 500 });
      } catch (e) {
        console.warn(`warehouse export skipped: ${e.message || e}`);
      }
    }
    const seed = loadProductSeedRows();
    const sample = loadSampleCsvRows();
    const cleanWarehouseRows = publicRecords(fromWh, "ocp warehouse export");
    const cleanRows = publicRecords(
      [...fromWh, ...seed, ...sample],
      "ocp public materialization",
    );
    return {
      rows: dedupeRows(cleanRows),
      mode: cleanWarehouseRows.length ? "warehouse" : "verified_seed",
    };
  }

  const rows = publicRecords(
    exportOcpRowsFromWarehouse({ limit }),
    "ocp warehouse export",
  );
  // Keep product demos even if bulk snapshot is older than those request_ids.
  const seed = loadProductSeedRows();
  return {
    rows: dedupeRows(publicRecords([...rows, ...seed], "ocp public materialization")),
    mode: rows.length > 1000 ? "bulk_warehouse" : "warehouse",
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
  // Edge demo id lives in the verified product seed.
  const edgeDemo = rows.find((r) => r.request_id === "20260723031") || rows[0];
  const duckDemo = edgeDemo;
  if (!edgeDemo) return { error: "no rows to bench" };

  const edgeNotice = { request_id: edgeDemo.request_id, pin: edgeDemo.pin };

  // DuckDB spawn path (factory / ops). Not the edge hot path — process spawn dominates.
  let warehouseMs = null;
  if (catalogExists()) {
    const samples = [];
    let last = null;
    for (let i = 0; i < 5; i++) {
      last = lookupOcpAwardRowsFromWarehouse({
        request_id: duckDemo.request_id,
        pin: duckDemo.pin,
      });
      samples.push(last.ms);
    }
    warehouseMs = {
      ...statsMs(samples, 2),
      path: last.path,
      rows: last.rows.length,
      notice_request_id: duckDemo.request_id,
      note: "Python DuckDB CLI spawn per query — build/ops only, not Worker request path",
    };
  }

  // Pure in-process index (what the Worker does on a materialization hit)
  const { buildOcpLookupIndex, lookupOcpInIndex } = await import(
    "../warehouse/lib/ocp_lookup.mjs"
  );
  const index = buildOcpLookupIndex(rows);
  // Warm once, then measure
  lookupOcpInIndex(edgeNotice, index);
  const indexSamples = [];
  for (let i = 0; i < 200; i++) {
    const t0 = performance.now();
    lookupOcpInIndex(edgeNotice, index);
    indexSamples.push(performance.now() - t0);
  }
  const hit = lookupOcpInIndex(edgeNotice, index);
  const indexMs = {
    ...statsMs(indexSamples, 4),
    path: "materialized_index",
    rows: hit.rows.length,
    notice_request_id: edgeDemo.request_id,
    note: "Worker hot path after warehouse materialization import",
  };

  // Live SODA (optional — network). Fail-soft when offline.
  let sodaMs = null;
  try {
    const params = new URLSearchParams({
      $select:
        "request_id,start_date,agency_name,type_of_notice_description,short_title,pin,contract_amount,vendor_name",
      $where: `request_id='${String(edgeDemo.request_id).replace(/'/g, "''")}'`,
      $limit: "5",
    });
    const url = `https://data.cityofnewyork.us/resource/qyyg-4tf5.json?${params}`;
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
      url_class: "socrata_qyyg-4tf5_request_id",
      notice_request_id: edgeDemo.request_id,
      note: "Previous live path in fetchOcpAwardRows",
    };
  } catch (e) {
    sodaMs = { error: String(e && e.message ? e.message : e), path: "soda_live" };
  }

  let speedup = null;
  if (sodaMs && sodaMs.p50_ms != null && indexMs.p50_ms != null) {
    // Floor tiny index times so ratio is readable; edge is effectively free vs network.
    const floor = Math.max(indexMs.p50_ms, 0.01);
    const ratio = sodaMs.p50_ms / floor;
    speedup = {
      soda_p50_ms: sodaMs.p50_ms,
      warehouse_materialized_p50_ms: indexMs.p50_ms,
      ratio_vs_0_01ms_floor: Math.round(ratio * 10) / 10,
      summary:
        `OCP side-car lookup p50: live SODA ${sodaMs.p50_ms}ms → ` +
        `warehouse materialization ${indexMs.p50_ms}ms (sub-ms; removes a SODA RTT)`,
      note: "Edge path is the materialized index; DuckDB spawn is build-time only",
    };
  }

  return {
    phase: "WH-03",
    measured_at: new Date().toISOString(),
    replaced_fetch: {
      function: "fetchOcpAwardRows",
      file: "worker/src/checkbook_lifecycle.mjs",
      soda_dataset: "qyyg-4tf5",
      product: "OCP award side-car on GET /contract-lifecycle",
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
      // Compare row set + meta without brittle timestamp equality
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
  });
  assert.ok(rows.length >= 1, "expected at least one OCP row to materialize");

  // Freeze materialized_at when --check by reading existing worker copy if present
  let now = new Date().toISOString();
  if (args.check && existsSync(OUT_WORKER)) {
    try {
      now = JSON.parse(readFileSync(OUT_WORKER, "utf8")).materialized_at || now;
    } catch {
      /* keep now */
    }
  }

  const doc = buildMaterializationDoc(rows, { mode, now });
  // Stable sort for deterministic commits
  doc.rows.sort((a, b) =>
    String(a.request_id || "").localeCompare(String(b.request_id || ""))
  );
  doc.row_count = doc.rows.length;
  assert.deepEqual(
    publicPayloadFindings(doc, { source: "site/data/ocp_awards_warehouse_lookup.json" }),
    [],
    "OCP public materialization contains test-only records",
  );

  const result = writeOutputs(doc, args.check);
  console.log(JSON.stringify(result, null, 2));

  if (args.bench || !args.check) {
    const receipt = await bench(doc.rows);
    mkdirSync(path.dirname(BENCH_RECEIPT), { recursive: true });
    writeFileSync(BENCH_RECEIPT, stableStringify(receipt));
    console.log("bench:", JSON.stringify(receipt, null, 2));
    console.log("bench_receipt:", path.relative(ROOT, BENCH_RECEIPT));
  }

  // Touch queryWarehouse so catalog path is exercised when present (characterization).
  if (catalogExists() && !args.check) {
    try {
      const n = queryWarehouse(
        "SELECT COUNT(*) AS n FROM ocp_recent_contract_awards"
      );
      console.log("warehouse_count:", n[0]?.n);
    } catch {
      /* optional */
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
