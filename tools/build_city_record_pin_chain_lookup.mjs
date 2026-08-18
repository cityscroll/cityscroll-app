#!/usr/bin/env node
/**
 * WH-07: materialize City Record PIN-chain history lookup from the warehouse
 * (DuckDB) for the Worker.
 *
 * Replaces the live SODA miss path in fetchRelatedProcurementNotices for PINs
 * present in the materialization. Misses still fall through to D1 then SODA.
 *
 * Usage:
 *   node tools/build_city_record_pin_chain_lookup.mjs            # warehouse catalog → JSON
 *   node tools/build_city_record_pin_chain_lookup.mjs --fixture  # verified seed offline
 *   node tools/build_city_record_pin_chain_lookup.mjs --check    # fail if committed JSON is stale
 *   node tools/build_city_record_pin_chain_lookup.mjs --limit 5000
 *   node tools/build_city_record_pin_chain_lookup.mjs --bench
 *
 * Does NOT download bulk data (WH-07). If the catalog is empty/missing, --fixture
 * (or bare run without catalog) builds from warehouse/fixtures/city-record-pin-chain.
 * A rebuild that fails the serve gate keeps the last-known-good committed twins.
 */

import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";

import { catalogExists, WAREHOUSE_DIR, REPO_ROOT } from "../warehouse/lib/catalog.mjs";
import {
  assertCityRecordPinChainServeGate,
  buildMaterializationDoc,
  buildPinChainLookupIndex,
  exportPinChainRowsFromWarehouse,
  loadLastKnownGoodDoc,
  loadProductSeedRows,
  lookupPinChainInIndex,
  lookupPinChainRowsFromWarehouse,
} from "../warehouse/lib/city_record_pin_chain_lookup.mjs";
import {
  assertServePublishTwins,
  SERVE_LOOKUP_CONTRACTS,
} from "../warehouse/lib/serve_publish_contract.mjs";
import {
  publicPayloadFindings,
  publicRecords,
} from "./lib/public_payload_integrity.mjs";

const ROOT = REPO_ROOT;
const OUT_SITE = path.join(
  ROOT,
  "site",
  "data",
  "city_record_pin_chain_warehouse_lookup.json",
);
const OUT_WORKER = path.join(
  ROOT,
  "worker",
  "src",
  "data",
  "city_record_pin_chain_warehouse_lookup.json",
);
const BENCH_RECEIPT = path.join(
  ROOT,
  "warehouse",
  "receipts",
  "proof",
  "wh07_city_record_pin_chain_lookup_speed.json",
);
const BULK_PROOF = path.join(
  WAREHOUSE_DIR,
  "receipts",
  "proof",
  "city-record_bulk_latest.json",
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

function readBulkSnapshotDate() {
  if (!existsSync(BULK_PROOF)) return null;
  try {
    const proof = JSON.parse(readFileSync(BULK_PROOF, "utf8"));
    const parquetPath = proof?.parquet?.parquet_path || "";
    const m = String(parquetPath).match(/snapshot_date=(\d{4}-\d{2}-\d{2})/);
    return m ? m[1] : proof?.observed_at?.slice?.(0, 10) || null;
  } catch {
    return null;
  }
}

function dedupeRows(rows) {
  const seen = new Set();
  const out = [];
  for (const row of rows) {
    const key =
      row.request_id ||
      `${row.pin}|${row.start_date}|${row.type_of_notice_description}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(row);
  }
  return out;
}

function collectRows({ fixture, limit }) {
  if (fixture || !catalogExists()) {
    let fromWh = [];
    if (catalogExists() && !fixture) {
      try {
        fromWh = exportPinChainRowsFromWarehouse({ limit: limit || 5000 });
      } catch (e) {
        console.warn(`warehouse export skipped: ${e.message || e}`);
      }
    }
    const seed = loadProductSeedRows();
    const cleanWarehouseRows = publicRecords(fromWh, "city-record pin-chain warehouse export");
    const cleanRows = publicRecords(
      [...fromWh, ...seed],
      "city-record pin-chain public materialization",
    );
    return {
      rows: dedupeRows(cleanRows),
      mode: cleanWarehouseRows.length > 1000
        ? "bulk_warehouse"
        : cleanWarehouseRows.length
          ? "warehouse"
          : "verified_seed",
    };
  }

  const rows = publicRecords(
    exportPinChainRowsFromWarehouse({ limit }),
    "city-record pin-chain warehouse export",
  );
  const seed = loadProductSeedRows();
  return {
    rows: dedupeRows(
      publicRecords([...rows, ...seed], "city-record pin-chain public materialization"),
    ),
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
  const edgeDemo =
    rows.find((r) => r.pin === "81626W0043001") ||
    rows.find((r) => r.pin === "07219P0148001R004") ||
    rows[0];
  if (!edgeDemo) return { error: "no rows to bench" };

  const index = buildPinChainLookupIndex(rows);
  const indexSamples = [];
  for (let i = 0; i < 5; i++) {
    const t0 = performance.now();
    lookupPinChainInIndex(edgeDemo.pin, index);
    indexSamples.push(performance.now() - t0);
  }
  const indexMs = {
    ...statsMs(indexSamples, 4),
    path: "materialized_index",
    pin: edgeDemo.pin,
  };

  let warehouseMs = null;
  if (catalogExists()) {
    try {
      const samples = [];
      let lastCount = 0;
      for (let i = 0; i < 3; i++) {
        const t0 = performance.now();
        const r = lookupPinChainRowsFromWarehouse(edgeDemo.pin);
        samples.push(performance.now() - t0);
        lastCount = r.rows?.length || 0;
      }
      warehouseMs = {
        ...statsMs(samples, 2),
        path: "duckdb",
        rows: lastCount,
        pin: edgeDemo.pin,
      };
    } catch (e) {
      warehouseMs = { error: String(e && e.message ? e.message : e), path: "duckdb" };
    }
  }

  let sodaMs = null;
  try {
    const params = new URLSearchParams({
      $select:
        "request_id,start_date,agency_name,type_of_notice_description,short_title,pin,contract_amount,vendor_name",
      $where: `pin='${String(edgeDemo.pin).replace(/'/g, "''")}'`,
      $limit: "25",
    });
    const url = `https://data.cityofnewyork.us/resource/dg92-zbpx.json?${params}`;
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
      url_class: "socrata_dg92-zbpx_pin",
      pin: edgeDemo.pin,
      note: "Previous live miss path in fetchRelatedProcurementNotices",
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
        `City Record PIN-chain lookup p50: live SODA ${sodaMs.p50_ms}ms → ` +
        `warehouse materialization ${indexMs.p50_ms}ms (sub-ms; removes a SODA RTT)`,
      note: "Edge path is the materialized index; DuckDB spawn is build-time only",
    };
  }

  return {
    phase: "WH-07",
    measured_at: new Date().toISOString(),
    replaced_fetch: {
      function: "fetchRelatedProcurementNotices",
      file: "worker/src/checkbook_lifecycle.mjs",
      soda_dataset: "dg92-zbpx",
      product: "City Record PIN siblings on GET /contract-lifecycle",
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
    pin_count: doc.pin_count,
    mode: doc.mode,
  };
}

function checkCommittedServe() {
  assert.ok(existsSync(OUT_SITE), `missing ${path.relative(ROOT, OUT_SITE)}`);
  assert.ok(existsSync(OUT_WORKER), `missing ${path.relative(ROOT, OUT_WORKER)}`);
  const site = JSON.parse(readFileSync(OUT_SITE, "utf8"));
  const worker = JSON.parse(readFileSync(OUT_WORKER, "utf8"));
  assertServePublishTwins(site, worker, SERVE_LOOKUP_CONTRACTS.city_record_pin_chain);
  assertCityRecordPinChainServeGate(site);
  assertCityRecordPinChainServeGate(worker);
  return site;
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.check && !args.fixture && !args.bench) {
    const committed = checkCommittedServe();
    console.log(JSON.stringify({
      status: "ok",
      check: "serve_publish_contract",
      row_count: committed.row_count,
      pin_count: committed.pin_count,
      mode: committed.mode,
      materialized_at: committed.materialized_at,
      coverage: committed.coverage,
    }, null, 2));
    return;
  }

  const { rows, mode } = collectRows({
    fixture: args.fixture,
    limit: args.limit,
  });
  assert.ok(rows.length >= 1, "expected at least one City Record PIN-chain row to materialize");

  let now = new Date().toISOString();
  if (args.check && existsSync(OUT_WORKER)) {
    try {
      now = JSON.parse(readFileSync(OUT_WORKER, "utf8")).materialized_at || now;
    } catch {
      /* keep now */
    }
  }

  const doc = buildMaterializationDoc(rows, {
    mode,
    now,
    bulkSnapshotDate: readBulkSnapshotDate(),
  });
  doc.rows.sort(
    (a, b) =>
      String(a.pin || "").localeCompare(String(b.pin || "")) ||
      String(a.start_date || "").localeCompare(String(b.start_date || "")) ||
      String(a.request_id || "").localeCompare(String(b.request_id || "")),
  );
  doc.row_count = doc.rows.length;
  doc.pin_count = buildPinChainLookupIndex(doc.rows).pinCount;
  doc.coverage.selected_rows = doc.row_count;
  doc.coverage.selected_pins = doc.pin_count;

  assert.deepEqual(
    publicPayloadFindings(doc, {
      source: "site/data/city_record_pin_chain_warehouse_lookup.json",
    }),
    [],
    "City Record PIN-chain public materialization contains test-only records",
  );

  try {
    assertCityRecordPinChainServeGate(doc);
  } catch (e) {
    const lkg = loadLastKnownGoodDoc(OUT_SITE, OUT_WORKER);
    if (lkg) {
      console.error(
        `rebuild failed serve gate (${e.message}); retaining last-known-good ` +
          `(row_count=${lkg.row_count}, materialized_at=${lkg.materialized_at})`,
      );
      process.exitCode = 2;
      console.log(JSON.stringify({
        status: "retained_last_known_good",
        reason: String(e.message || e),
        last_known_good: {
          row_count: lkg.row_count,
          pin_count: lkg.pin_count,
          mode: lkg.mode,
          materialized_at: lkg.materialized_at,
        },
      }, null, 2));
      return;
    }
    throw e;
  }

  const result = writeOutputs(doc, args.check);
  console.log(JSON.stringify(result, null, 2));

  if (args.bench || !args.check) {
    const receipt = await bench(doc.rows);
    mkdirSync(path.dirname(BENCH_RECEIPT), { recursive: true });
    writeFileSync(BENCH_RECEIPT, stableStringify(receipt));
    console.log("bench:", JSON.stringify(receipt, null, 2));
    console.log("bench_receipt:", path.relative(ROOT, BENCH_RECEIPT));
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
