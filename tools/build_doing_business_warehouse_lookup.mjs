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
 *   node tools/build_doing_business_warehouse_lookup.mjs --from-soda # build-time SODA page (refresh loop)
 *   node tools/build_doing_business_warehouse_lookup.mjs --check    # byte-stable + serve gate
 *   node tools/build_doing_business_warehouse_lookup.mjs --bench
 *   node tools/build_doing_business_warehouse_lookup.mjs --limit 5000
 *
 * Refresh→publish loop: materialize (WH-02 bulk or --from-soda) → commit twins →
 * `--check` fails on age / row-count drift / missing canaries so the serve cannot
 * re-freeze as live_fallback.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";

import { catalogExists, WAREHOUSE_DIR, REPO_ROOT } from "../warehouse/lib/catalog.mjs";
import {
  assertDoingBusinessServeGate,
  buildMaterializationDoc,
  DOING_BUSINESS_PUBLISHER_ROW_COUNT,
  exportDoingBusinessRowsFromWarehouse,
  loadProductSeedRows,
  rowToSodaShape,
} from "../warehouse/lib/doing_business_lookup.mjs";
import {
  DOING_BUSINESS_SODA,
} from "../worker/src/lib/doing_business_join.mjs";
import {
  publicPayloadFindings,
  publicRecords,
} from "./lib/public_payload_integrity.mjs";

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
const SODA_PAGE = 5000;
const SODA_MAX_PAGES = 50;

function parseArgs(argv) {
  const out = { fixture: false, check: false, bench: false, fromSoda: false, limit: null };
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === "--fixture") out.fixture = true;
    else if (argv[i] === "--check") out.check = true;
    else if (argv[i] === "--bench") out.bench = true;
    else if (argv[i] === "--from-soda") out.fromSoda = true;
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

async function fetchPublisherRowCount(fetchImpl = fetch) {
  try {
    const res = await fetchImpl(
      `${DOING_BUSINESS_SODA}?$select=${encodeURIComponent("count(*)")}`,
    );
    if (!res.ok) return DOING_BUSINESS_PUBLISHER_ROW_COUNT;
    const body = await res.json();
    const n = Number(body?.[0]?.count ?? body?.[0]?.count_star);
    return Number.isFinite(n) && n > 0 ? n : DOING_BUSINESS_PUBLISHER_ROW_COUNT;
  } catch {
    return DOING_BUSINESS_PUBLISHER_ROW_COUNT;
  }
}

/** Build-time SODA paging for the refresh→publish loop (not a resident hot path). */
async function fetchDoingBusinessFromSoda({ limit = null, fetchImpl = fetch } = {}) {
  const rows = [];
  const pageLimit =
    limit != null && Number.isFinite(Number(limit)) && Number(limit) > 0
      ? Math.min(SODA_PAGE, Math.floor(Number(limit)))
      : SODA_PAGE;
  for (let page = 0; page < SODA_MAX_PAGES; page++) {
    if (limit != null && rows.length >= limit) break;
    const params = new URLSearchParams({
      $limit: String(pageLimit),
      $offset: String(page * pageLimit),
      $order: "organization_name",
    });
    const res = await fetchImpl(`${DOING_BUSINESS_SODA}?${params}`);
    if (!res.ok) {
      throw new Error(`Doing Business SODA ${res.status} during --from-soda materialization`);
    }
    const pageRows = await res.json();
    if (!Array.isArray(pageRows)) {
      throw new Error("Doing Business SODA returned a non-array response");
    }
    for (const raw of pageRows) {
      const shaped = rowToSodaShape(raw);
      if (shaped) rows.push(shaped);
      if (limit != null && rows.length >= limit) break;
    }
    if (pageRows.length < pageLimit) break;
  }
  return rows;
}

async function collectRows({ fixture, fromSoda, limit }) {
  if (fromSoda) {
    const sodaRows = publicRecords(
      await fetchDoingBusinessFromSoda({ limit }),
      "Doing Business SODA materialization",
    );
    const rows = dedupeRows(sodaRows);
    return {
      rows,
      mode: rows.length > 1000 ? "bulk_soda" : rows.length ? "warehouse" : "live_fallback",
      publisherRowCount: await fetchPublisherRowCount(),
    };
  }

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
    const rows = dedupeRows(
      publicRecords([...fromWh, ...seed, ...sample], "Doing Business public materialization"),
    );
    return { rows, mode: rows.length ? "warehouse" : "live_fallback" };
  }

  try {
    const rows = publicRecords(
      exportDoingBusinessRowsFromWarehouse({ limit }),
      "Doing Business warehouse export",
    );
    const seed = loadProductSeedRows();
    const cleanRows = dedupeRows(
      publicRecords([...rows, ...seed], "Doing Business public materialization"),
    );
    return {
      rows: cleanRows,
      mode: rows.length > 1000 ? "bulk_warehouse" : cleanRows.length ? "warehouse" : "live_fallback",
    };
  } catch (e) {
    console.warn(`warehouse export failed; keeping the live fallback: ${e.message || e}`);
    return { rows: [], mode: "live_fallback" };
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

  // Prior multi-page SODA cost model for the receipt (not a measured network sample):
  // Open Data publishes ~11k entities; page size 5000 ⇒ 3 pages × 180ms RTT floor.
  const sodaPageMsFloor = 180;
  const sodaPages = Math.max(1, Math.ceil(Math.max(rows.length, 11000) / 5000));
  const sodaCatalogMsFloor = sodaPageMsFloor * sodaPages;

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
    prior_live_soda_catalog: {
      page_size: 5000,
      pages: sodaPages,
      p50_ms_floor: sodaCatalogMsFloor,
      provenance: "derived",
      note: "Derived floor from page count × 180ms RTT; multi-page catalog fetch before stem join",
    },
    summary:
      `Doing Business attach p50: live multi-page SODA floor ${sodaCatalogMsFloor}ms → ` +
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

function readCommittedDoc(filePath) {
  return JSON.parse(readFileSync(filePath, "utf8"));
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.fromSoda && args.fixture) {
    throw new Error("Cannot combine --from-soda and --fixture");
  }

  // Serve gate always runs against the committed twins so CI catches empty/stale
  // snapshots without requiring a local DuckDB catalog.
  if (args.check) {
    for (const filePath of [OUT_SITE, OUT_WORKER]) {
      assert.ok(existsSync(filePath), `${path.relative(ROOT, filePath)} missing`);
      assertDoingBusinessServeGate(readCommittedDoc(filePath));
      console.log(`ok serve-gate ${path.relative(ROOT, filePath)}`);
    }
  }

  const { rows, mode, publisherRowCount } = await collectRows(args);
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
    publisherRowCount,
  });
  assert.deepEqual(
    publicPayloadFindings(doc, { source: "site/data/doing_business_warehouse_lookup.json" }),
    [],
    "Doing Business public materialization contains test-only records",
  );
  if (!args.check && (mode === "bulk_warehouse" || mode === "bulk_soda")) {
    assertDoingBusinessServeGate(doc);
  }
  // Byte-stable rebuild check only when the local catalog (or --from-soda) can
  // reproduce a full snapshot; fixture-sized rebuilds would false-fail against
  // the committed bulk serve.
  const canByteCheck =
    args.check &&
    (args.fromSoda || (catalogExists() && (mode === "bulk_warehouse" || mode === "bulk_soda")));
  if (args.check && !canByteCheck) {
    console.log(
      "ok skip byte-stable rebuild (no full catalog in this environment; serve-gate already checked)",
    );
  } else {
    const outs = [
      writeOrCheck(OUT_SITE, doc, args.check && canByteCheck),
      writeOrCheck(OUT_WORKER, doc, args.check && canByteCheck),
    ];
    for (const row of outs) {
      console.log(
        args.check
          ? `ok ${path.relative(ROOT, row.path)}`
          : `wrote ${path.relative(ROOT, row.path)} (${row.bytes} bytes, ${doc.row_count} rows, mode=${mode})`,
      );
    }
  }
  if (args.bench) {
    const receipt = await bench(rows.length ? rows : readCommittedDoc(OUT_WORKER).rows || []);
    console.log(receipt.summary);
    console.log("receipt:", path.relative(ROOT, BENCH_RECEIPT));
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
