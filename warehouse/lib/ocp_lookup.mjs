/**
 * WH-03: OCP award lookup over the warehouse (DuckDB) + pure materialization index.
 *
 * The edge Worker never opens DuckDB. Host tooling queries here, materializes a
 * compact JSON snapshot (`site/data/ocp_awards_warehouse_lookup.json`), and the
 * Worker serves hits from that snapshot with live SODA as miss fallback.
 *
 *   node warehouse/lib/ocp_lookup.mjs --request-id 20260723031
 *   node warehouse/lib/ocp_lookup.mjs --pin 81626W0043001
 */
import { existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { catalogExists, getDataset, WAREHOUSE_DIR } from "./catalog.mjs";
import { queryWarehouse } from "./query.mjs";

export const OCP_DATASET_KEY = "ocp-recent-contract-awards";
export const OCP_SELECT_COLS = [
  "request_id",
  "start_date",
  "agency_name",
  "type_of_notice_description",
  "short_title",
  "pin",
  "contract_amount",
  "vendor_name",
];

const OCP_PIN_LIMIT = 10;
const OCP_REQUEST_ID_LIMIT = 5;

function sq(s) {
  return String(s || "").replace(/'/g, "''");
}

export function ocpTableName() {
  return getDataset(OCP_DATASET_KEY).table_name;
}

/**
 * Normalize a warehouse/SODA row to the SODA field names joinOcpAward expects.
 * DuckDB may return typed numbers; stringify amount for parity with SODA strings.
 */
export function rowToSodaShape(row) {
  if (!row || typeof row !== "object") return null;
  const out = {
    request_id: row.request_id != null ? String(row.request_id) : null,
    start_date: row.start_date != null ? String(row.start_date) : null,
    agency_name: row.agency_name != null ? String(row.agency_name) : null,
    type_of_notice_description:
      row.type_of_notice_description != null
        ? String(row.type_of_notice_description)
        : null,
    short_title: row.short_title != null ? String(row.short_title) : null,
    pin: row.pin != null ? String(row.pin).trim() : null,
    contract_amount:
      row.contract_amount != null && row.contract_amount !== ""
        ? String(row.contract_amount)
        : null,
    vendor_name: row.vendor_name != null ? String(row.vendor_name) : null,
  };
  // Drop null-only shells
  if (!out.request_id && !out.pin) return null;
  return out;
}

export function sqlOcpByRequestId(requestId, table = ocpTableName()) {
  const id = sq(requestId);
  const cols = OCP_SELECT_COLS.join(", ");
  return (
    `SELECT ${cols} FROM ${table} ` +
    `WHERE CAST(request_id AS VARCHAR) = '${id}' ` +
    `LIMIT ${OCP_REQUEST_ID_LIMIT}`
  );
}

export function sqlOcpByPin(pin, table = ocpTableName()) {
  const p = sq(String(pin).trim());
  const cols = OCP_SELECT_COLS.join(", ");
  return (
    `SELECT ${cols} FROM ${table} ` +
    `WHERE CAST(pin AS VARCHAR) = '${p}' ` +
    `LIMIT ${OCP_PIN_LIMIT}`
  );
}

export function sqlOcpExportAll(table = ocpTableName(), limit = null) {
  const cols = OCP_SELECT_COLS.join(", ");
  const lim =
    limit != null && Number.isFinite(Number(limit)) && Number(limit) > 0
      ? ` LIMIT ${Math.floor(Number(limit))}`
      : "";
  return `SELECT ${cols} FROM ${table} ORDER BY start_date DESC NULLS LAST${lim}`;
}

/**
 * Live DuckDB lookup for one notice — same preference as fetchOcpAwardRows
 * (request_id first, then pin). Host/ops only.
 * @returns {{ ok: boolean, rows: object[], path: "warehouse"|"unavailable", ms: number }}
 */
export function lookupOcpAwardRowsFromWarehouse(noticeRow) {
  const started = performance.now();
  if (!catalogExists()) {
    return {
      ok: false,
      rows: [],
      path: "unavailable",
      ms: performance.now() - started,
      reason: "catalog_missing",
    };
  }
  const r = noticeRow || {};
  try {
    if (r.request_id) {
      const rows = queryWarehouse(sqlOcpByRequestId(r.request_id))
        .map(rowToSodaShape)
        .filter(Boolean);
      if (rows.length) {
        return {
          ok: true,
          rows,
          path: "warehouse",
          ms: performance.now() - started,
          join_key: "request_id",
        };
      }
    }
    if (r.pin) {
      const rows = queryWarehouse(sqlOcpByPin(r.pin))
        .map(rowToSodaShape)
        .filter(Boolean);
      return {
        ok: true,
        rows,
        path: "warehouse",
        ms: performance.now() - started,
        join_key: rows.length ? "pin" : null,
      };
    }
    return {
      ok: true,
      rows: [],
      path: "warehouse",
      ms: performance.now() - started,
      join_key: null,
    };
  } catch (e) {
    return {
      ok: false,
      rows: [],
      path: "unavailable",
      ms: performance.now() - started,
      reason: String(e && e.message ? e.message : e),
    };
  }
}

/**
 * Export all (or limited) OCP rows from the warehouse for materialization.
 */
export function exportOcpRowsFromWarehouse(opts = {}) {
  if (!catalogExists()) {
    throw new Error("DuckDB catalog missing; run warehouse ingest first");
  }
  const limit = opts.limit != null ? opts.limit : null;
  const raw = queryWarehouse(sqlOcpExportAll(ocpTableName(), limit));
  return raw.map(rowToSodaShape).filter(Boolean);
}

/**
 * Pure index over materialized OCP rows (no DuckDB). Used by Worker + tests.
 * @param {object[]} rows SODA-shaped rows
 */
export function buildOcpLookupIndex(rows) {
  const list = Array.isArray(rows) ? rows.map(rowToSodaShape).filter(Boolean) : [];
  /** @type {Map<string, object[]>} */
  const byRequestId = new Map();
  /** @type {Map<string, object[]>} */
  const byPin = new Map();
  for (const row of list) {
    if (row.request_id) {
      const k = String(row.request_id);
      if (!byRequestId.has(k)) byRequestId.set(k, []);
      const bucket = byRequestId.get(k);
      if (bucket.length < OCP_REQUEST_ID_LIMIT) bucket.push(row);
    }
    if (row.pin) {
      const k = String(row.pin).trim();
      if (!byPin.has(k)) byPin.set(k, []);
      const bucket = byPin.get(k);
      if (bucket.length < OCP_PIN_LIMIT) bucket.push(row);
    }
  }
  return { byRequestId, byPin, rowCount: list.length };
}

/**
 * Lookup notice rows against a pure materialization index.
 * @returns {{ hit: boolean, rows: object[], join_key: string|null }}
 */
export function lookupOcpInIndex(noticeRow, index) {
  const r = noticeRow || {};
  if (!index) return { hit: false, rows: [], join_key: null };
  if (r.request_id) {
    const rows = index.byRequestId.get(String(r.request_id)) || [];
    if (rows.length) return { hit: true, rows: rows.slice(), join_key: "request_id" };
  }
  if (r.pin) {
    const rows = index.byPin.get(String(r.pin).trim()) || [];
    if (rows.length) return { hit: true, rows: rows.slice(), join_key: "pin" };
  }
  // Explicit empty hit when neither key present — not a miss requiring SODA.
  if (!r.request_id && !r.pin) {
    return { hit: true, rows: [], join_key: null };
  }
  return { hit: false, rows: [], join_key: null };
}

/**
 * Build the committed materialization document.
 */
export function buildMaterializationDoc(rows, opts = {}) {
  const list = Array.isArray(rows) ? rows.map(rowToSodaShape).filter(Boolean) : [];
  return {
    schema_version: 1,
    phase: "WH-03",
    source: "warehouse",
    dataset_id: getDataset(OCP_DATASET_KEY).dataset_id,
    table_name: ocpTableName(),
    mode: opts.mode || "export",
    materialized_at: opts.now || new Date().toISOString(),
    row_count: list.length,
    replaces_live_fetch: {
      worker: "worker/src/checkbook_lifecycle.mjs#fetchOcpAwardRows",
      soda_dataset: "qyyg-4tf5",
      description:
        "OCP Recent Contract Awards side-car on /contract-lifecycle — warehouse materialization first, live SODA on miss",
    },
    rows: list,
  };
}

/** Load product seed CSV (public field-case rows) without DuckDB — offline CI. */
export function loadProductSeedRows() {
  const path = join(
    WAREHOUSE_DIR,
    "fixtures",
    "ocp-recent-contract-awards",
    "product_seed.csv"
  );
  if (!existsSync(path)) return [];
  const text = readFileSync(path, "utf8").trim();
  if (!text) return [];
  const lines = text.split(/\r?\n/);
  if (lines.length < 2) return [];
  const headers = lines[0].split(",").map((h) => h.trim());
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = splitCsvLine(lines[i]);
    if (!cols.length) continue;
    const obj = {};
    headers.forEach((h, j) => {
      obj[h] = cols[j] != null ? cols[j] : null;
    });
    const shaped = rowToSodaShape(obj);
    if (shaped) rows.push(shaped);
  }
  return rows;
}

function splitCsvLine(line) {
  // Minimal CSV: no embedded commas in product seed (controlled fixture).
  return line.split(",").map((c) => c.trim());
}

function printHelp() {
  console.log(`Usage:
  node warehouse/lib/ocp_lookup.mjs --request-id <id>
  node warehouse/lib/ocp_lookup.mjs --pin <pin>
  node warehouse/lib/ocp_lookup.mjs --export [--limit N]
`);
}

function cli(argv) {
  const args = argv.slice(2);
  let requestId = null;
  let pin = null;
  let doExport = false;
  let limit = null;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--request-id") requestId = args[++i];
    else if (args[i] === "--pin") pin = args[++i];
    else if (args[i] === "--export") doExport = true;
    else if (args[i] === "--limit") limit = Number(args[++i]);
    else if (args[i] === "--help" || args[i] === "-h") {
      printHelp();
      process.exit(0);
    }
  }
  if (doExport) {
    const rows = exportOcpRowsFromWarehouse({ limit });
    console.log(JSON.stringify(buildMaterializationDoc(rows, { mode: "cli_export" }), null, 2));
    return;
  }
  if (!requestId && !pin) {
    printHelp();
    process.exit(2);
  }
  const result = lookupOcpAwardRowsFromWarehouse({
    request_id: requestId,
    pin,
  });
  console.log(JSON.stringify(result, null, 2));
  if (!result.ok) process.exit(1);
}

const entry = process.argv[1] ? pathToFileURL(process.argv[1]).href : "";
if (import.meta.url === entry) {
  cli(process.argv);
}
