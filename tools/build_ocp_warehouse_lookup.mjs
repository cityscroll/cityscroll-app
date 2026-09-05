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
 * Does NOT download bulk data (WH-02). The default path requires a retained
 * WH-02 catalog. Use --fixture explicitly for the offline fixture proof.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  readdirSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";

import {
  catalogExists,
  warehouseRoot,
  WAREHOUSE_DIR,
  REPO_ROOT,
} from "../warehouse/lib/catalog.mjs";
import {
  buildMaterializationDoc,
  exportOcpRowsFromWarehouse,
  loadProductSeedRows,
  lookupOcpAwardRowsFromWarehouse,
  rowToSodaShape,
  sqlOcpByRequestId,
} from "../warehouse/lib/ocp_lookup.mjs";
import { queryWarehouse } from "../warehouse/lib/query.mjs";
import {
  assertServePublishLookup,
  SERVE_LOOKUP_CONTRACTS,
} from "../warehouse/lib/serve_publish_contract.mjs";
import {
  publicPayloadFindings,
  publicRecords,
} from "./lib/public_payload_integrity.mjs";

const ROOT = REPO_ROOT;
const OUT_SITE = path.join(ROOT, "site", "data", "ocp_awards_warehouse_lookup.json");
const LEGACY_OUT_WORKER = path.join(
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
const SOURCE_CONTRACTS = path.join(ROOT, "site", "data", "source_contracts.json");
const SNAPSHOT_RECEIPT_PATTERN = new RegExp(
  '("warehouse_snapshot": \\{\\s*\n'
  + '\\s*"status": "materialized",\\s*\n'
  + '\\s*"artifact": "site/data/ocp_awards_warehouse_lookup\\.json",\\s*\n'
  + '\\s*"materialized_at": ")[^"]*("[,\\s]*\n\\s*"row_count": )\\d+',
);

/**
 * The registry carries a warehouse_snapshot receipt for this artifact, and the
 * comparative read models refuse to publish unless it matches the artifact's
 * materialized_at and row_count exactly. Only this materializer knows those
 * values, so it restamps the receipt whenever it writes a new artifact.
 */
function stampSourceContractSnapshot(doc) {
  const text = readFileSync(SOURCE_CONTRACTS, "utf8");
  const matches = text.match(new RegExp(SNAPSHOT_RECEIPT_PATTERN, "g")) || [];
  assert.equal(
    matches.length,
    1,
    "expected exactly one OCP warehouse_snapshot receipt in site/data/source_contracts.json",
  );
  const updated = text.replace(
    SNAPSHOT_RECEIPT_PATTERN,
    (_match, head, middle) => `${head}${doc.materialized_at}${middle}${doc.row_count}`,
  );
  if (updated === text) return { status: "current" };
  // determinism-lint: allow write non-check materialization output
  writeFileSync(SOURCE_CONTRACTS, updated);
  return {
    status: "stamped",
    materialized_at: doc.materialized_at,
    row_count: doc.row_count,
  };
}

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

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
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

function loadWarehouseSnapshot() {
  const receiptsDir = path.join(warehouseRoot(), "receipts");
  if (!existsSync(receiptsDir)) {
    throw new Error(
      `WH-02 receipt directory missing at ${receiptsDir}; ` +
      "set CITYSCROLL_WAREHOUSE_ROOT to the retained warehouse root",
    );
  }
  const names = readdirSync(receiptsDir)
    .filter((name) => name.startsWith("ocp-recent-contract-awards_") && name.endsWith(".json"))
    .sort();
  // A fixture proof leaves ..._fixture.json beside the dated bulk receipts, and
  // "fixture" sorts after every date. Selecting by name alone would stamp the
  // five-row fixture's snapshot onto a full export, so read the candidates and
  // keep only genuine bulk runs.
  const candidates = [];
  for (const name of names) {
    let parsed;
    try {
      parsed = JSON.parse(readFileSync(path.join(receiptsDir, name), "utf8"));
    } catch (error) {
      throw new Error(`cannot read WH-02 OCP receipt: ${error.message || error}`);
    }
    if (parsed?.bulk !== true && parsed?.raw?.mode !== "soda_bulk") continue;
    candidates.push({ name, receipt: parsed });
  }
  if (!candidates.length) {
    throw new Error(
      "WH-02 OCP receipt missing; the default WH-03 build refuses to use fixture or seed rows",
    );
  }
  candidates.sort((left, right) => (
    String(left.receipt.observed_at || "").localeCompare(String(right.receipt.observed_at || ""))
    || left.name.localeCompare(right.name)
  ));
  const { name: receiptName, receipt } = candidates.at(-1);
  const raw = receipt?.raw || {};
  const parquet = receipt?.parquet || {};
  const sourceHash = String(raw.sha256 || "").trim();
  const rawRows = Number(raw.row_count);
  const parquetRows = Number(parquet.row_count);
  if (!/^[0-9a-f]{64}$/i.test(sourceHash) || !Number.isInteger(rawRows) || rawRows < 1) {
    throw new Error("WH-02 OCP receipt lacks a valid raw source checksum and row count");
  }
  if (Number.isInteger(parquetRows) && parquetRows !== rawRows) {
    throw new Error(`WH-02 OCP raw/Parquet row-count mismatch: ${rawRows} vs ${parquetRows}`);
  }
  return {
    snapshot_date: receipt.snapshot_date || null,
    source_snapshot_hash: sourceHash.toLowerCase(),
    source_row_count: rawRows,
    source_receipt: receiptName,
  };
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
  if (fixture) {
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
      sourceSnapshot: {
        kind: cleanWarehouseRows.length ? "fixture_catalog" : "fixture_seed",
        source_snapshot_hash: null,
        source_row_count: cleanWarehouseRows.length || cleanRows.length,
        source_receipt: null,
      },
    };
  }

  if (!catalogExists()) {
    throw new Error(
      "WH-02 DuckDB catalog missing; default WH-03 build refuses fixture/seed fallback. " +
      "Set CITYSCROLL_WAREHOUSE_ROOT to the retained warehouse root.",
    );
  }

  const exportedRows = exportOcpRowsFromWarehouse({ limit });
  const rows = publicRecords(exportedRows, "ocp warehouse export");
  const sourceSnapshot = loadWarehouseSnapshot();
  sourceSnapshot.exported_row_count = exportedRows.length;
  sourceSnapshot.limited = limit != null;
  return {
    rows: dedupeRows(rows),
    mode: rows.length > 1000 ? "bulk_warehouse" : "warehouse",
    sourceSnapshot,
  };
}

function statsMs(samples, digits = 3) {
  const sorted = [...samples].sort((a, b) => a - b);
  const mean = samples.reduce((a, b) => a + b, 0) / samples.length;
  const p50 = sorted[Math.floor(sorted.length / 2)];
  const p95 = sorted[Math.max(0, Math.ceil(sorted.length * 0.95) - 1)];
  const round = (n) => Math.round(n * 10 ** digits) / 10 ** digits;
  return {
    samples_ms: samples.slice(0, 5).map((n) => round(n)),
    p50_ms: round(p50),
    p95_ms: round(p95),
    mean_ms: round(mean),
    n: samples.length,
  };
}

async function bench(rows, sourceSnapshot) {
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
      query: sqlOcpByRequestId(duckDemo.request_id),
      source_snapshot_hash: sourceSnapshot?.source_snapshot_hash || null,
      source_row_count: sourceSnapshot?.source_row_count || null,
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
      // determinism-lint: allow network live benchmark runs only outside --check
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
    // determinism-lint: allow clock benchmark receipt timestamp only outside --check
    measured_at: new Date().toISOString(),
    replaced_fetch: {
      function: "fetchOcpAwardRows",
      file: "worker/src/checkbook_lifecycle.mjs",
      soda_dataset: "qyyg-4tf5",
      product: "OCP award side-car on GET /contract-lifecycle",
    },
    query: sqlOcpByRequestId(edgeDemo.request_id),
    source_snapshot_hash: sourceSnapshot?.source_snapshot_hash || null,
    source_row_count: sourceSnapshot?.source_row_count || null,
    row_count: rows.length,
    excluded_row_count: sourceSnapshot?.limited
      ? null
      : Math.max(0, Number(sourceSnapshot?.source_row_count || rows.length) - rows.length),
    excluded_reason: sourceSnapshot?.limited
      ? null
      : "public payload integrity filter rejected test-only rows",
    p50_ms: warehouseMs?.p50_ms ?? null,
    p95_ms: warehouseMs?.p95_ms ?? null,
    warehouse_duckdb_build_path: warehouseMs,
    materialized_index_edge_path: indexMs,
    soda_live_previous_path: sodaMs,
    speedup,
  };
}

function writeOutputs(doc, check) {
  const rendered = stableStringify(doc);
  const targets = [OUT_SITE];
  if (check) {
    let existing = null;
    try {
      existing = readFileSync(OUT_SITE, "utf8");
    } catch {
      existing = null;
    }
    // Compare row set + meta without brittle timestamp equality.
    const existingDoc = existing ? JSON.parse(existing) : null;
    assert.ok(existingDoc, `missing ${path.relative(ROOT, OUT_SITE)}`);
    assert.equal(existingDoc.schema_version, doc.schema_version);
    assert.equal(existingDoc.row_count, doc.row_count);
    assert.deepEqual(existingDoc.rows, doc.rows);
    assertLegacyOutputParity(existing);
    return { status: "ok", targets };
  }
  // determinism-lint: allow write non-check materialization output
  mkdirSync(path.dirname(OUT_SITE), { recursive: true });
  // determinism-lint: allow write non-check materialization output
  writeFileSync(OUT_SITE, rendered);
  return {
    status: "wrote",
    targets: targets.map((t) => path.relative(ROOT, t)),
    bytes: Buffer.byteLength(rendered),
    row_count: doc.row_count,
    mode: doc.mode,
  };
}

function assertLegacyOutputParity(canonicalText) {
  if (!existsSync(LEGACY_OUT_WORKER)) return;
  const legacyText = readFileSync(LEGACY_OUT_WORKER, "utf8");
  assert.equal(
    legacyText,
    canonicalText,
    `OCP legacy Worker copy diverges from canonical output (canonical sha256=${sha256(canonicalText)}, legacy sha256=${sha256(legacyText)})`,
  );
}

function checkCommittedServe() {
  assert.ok(existsSync(OUT_SITE), `missing ${path.relative(ROOT, OUT_SITE)}`);
  const siteText = readFileSync(OUT_SITE, "utf8");
  const site = JSON.parse(siteText);
  assert.equal(site.mode, "bulk_warehouse", "committed OCP lookup must come from the WH-02 bulk catalog");
  assert.match(
    String(site.source_snapshot?.source_snapshot_hash || ""),
    /^[0-9a-f]{64}$/i,
    "committed OCP lookup must record the WH-02 source snapshot hash",
  );
  assert.ok(
    Number(site.source_snapshot?.source_row_count) >= Number(site.row_count),
    "committed OCP lookup source row count must cover materialized rows",
  );
  assert.equal(
    site.source_snapshot?.exported_row_count,
    site.source_snapshot?.source_row_count,
    "committed OCP lookup must export the complete WH-02 snapshot",
  );
  assert.equal(site.source_snapshot?.limited, false, "committed OCP lookup must not be limited");
  assertServePublishLookup(site, SERVE_LOOKUP_CONTRACTS.ocp_awards, {
    now: site.materialized_at,
  });
  assertLegacyOutputParity(siteText);
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
      materialized_at: committed.materialized_at,
    }, null, 2));
    return;
  }
  const { rows, mode, sourceSnapshot } = collectRows({
    fixture: args.fixture,
    limit: args.limit,
  });
  assert.ok(rows.length >= 1, "expected at least one OCP row to materialize");

  // Freeze materialized_at when --check by reading the canonical site copy.
  // determinism-lint: allow clock fixture/benchmark materialization timestamp
  let now = new Date().toISOString();
  if (args.check && existsSync(OUT_SITE)) {
    try {
      now = JSON.parse(readFileSync(OUT_SITE, "utf8")).materialized_at || now;
    } catch {
      /* keep now */
    }
  }

  const doc = buildMaterializationDoc(rows, {
    mode,
    now,
    source_snapshot: sourceSnapshot,
  });
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
  if (!args.check) {
    console.log("source_contract_snapshot:", JSON.stringify(stampSourceContractSnapshot(doc)));
  }

  if (args.bench || !args.check) {
    const receipt = await bench(doc.rows, sourceSnapshot);
    // determinism-lint: allow write benchmark receipt outside --check
    mkdirSync(path.dirname(BENCH_RECEIPT), { recursive: true });
    // determinism-lint: allow write benchmark receipt outside --check
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
