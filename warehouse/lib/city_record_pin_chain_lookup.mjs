/**
 * WH-07: City Record PIN-chain history lookup over the warehouse (DuckDB) +
 * pure materialization index.
 *
 * Highest-value first history serve: exact PIN → procurement notice siblings
 * for notice-context /contract-lifecycle related-notice recovery. The edge
 * Worker never opens DuckDB — host tooling materializes a compact JSON twin
 * (`site/data/city_record_pin_chain_warehouse_lookup.json`) and the Worker
 * prefers that snapshot before D1 / live SODA.
 *
 *   node warehouse/lib/city_record_pin_chain_lookup.mjs --pin 81626W0043001
 *   node warehouse/lib/city_record_pin_chain_lookup.mjs --export [--limit N]
 */
import { existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { catalogExists, getDataset, WAREHOUSE_DIR } from "./catalog.mjs";
import { queryWarehouse } from "./query.mjs";
import {
  SERVE_LOOKUP_CONTRACTS,
  servePublishFindings,
} from "./serve_publish_contract.mjs";

export const CITY_RECORD_DATASET_KEY = "city-record";
export const CITY_RECORD_PIN_CHAIN_SELECT_COLS = Object.freeze([
  "request_id",
  "start_date",
  "agency_name",
  "type_of_notice_description",
  "short_title",
  "pin",
  "contract_amount",
  "vendor_name",
]);

/** Same procurement notice types as worker fetchRelatedProcurementNotices. */
export const CITY_RECORD_PIN_CHAIN_NOTICE_TYPES = Object.freeze([
  "Solicitation",
  "Intent to Negotiate",
  "Vendor List",
  "Intent to Award",
  "Award",
]);

/** Per-PIN row cap in the committed serve (matches RELATED_NOTICE_LIMIT). */
export const CITY_RECORD_PIN_CHAIN_PER_PIN_LIMIT = 25;

/** WH-07 bulk Procurement section count from city-record_bulk_latest (2026-08-05). */
export const CITY_RECORD_BULK_PROCUREMENT_SECTION_ROWS = 105158;

/** Refuse empty / zero-pin materializations that would re-open live SODA. */
export const CITY_RECORD_PIN_CHAIN_MIN_ROW_COUNT = 3;

/** Warehouse-scale floor once DuckDB export is the committed mode. */
export const CITY_RECORD_PIN_CHAIN_BULK_MIN_ROW_COUNT = 10000;

export const CITY_RECORD_PIN_CHAIN_FULL_MODES = Object.freeze([
  "bulk_warehouse",
]);

export const CITY_RECORD_PIN_CHAIN_MAX_AGE_DAYS =
  SERVE_LOOKUP_CONTRACTS.city_record_pin_chain.max_age_days;

function sq(s) {
  return String(s || "").replace(/'/g, "''");
}

export function cityRecordTableName() {
  return getDataset(CITY_RECORD_DATASET_KEY).table_name;
}

/**
 * Normalize a warehouse/SODA row to the related-notice field set.
 */
export function rowToSodaShape(row) {
  if (!row || typeof row !== "object") return null;
  const pin = row.pin != null ? String(row.pin).trim() : "";
  if (!pin) return null;
  const type = row.type_of_notice_description != null
    ? String(row.type_of_notice_description)
    : null;
  if (
    type &&
    !CITY_RECORD_PIN_CHAIN_NOTICE_TYPES.includes(type)
  ) {
    return null;
  }
  const out = {
    request_id: row.request_id != null ? String(row.request_id) : null,
    start_date: row.start_date != null ? String(row.start_date) : null,
    agency_name: row.agency_name != null ? String(row.agency_name) : null,
    type_of_notice_description: type,
    short_title: row.short_title != null ? String(row.short_title) : null,
    pin,
    contract_amount:
      row.contract_amount != null && row.contract_amount !== ""
        ? String(row.contract_amount)
        : null,
    vendor_name: row.vendor_name != null ? String(row.vendor_name) : null,
  };
  if (!out.request_id) return null;
  return out;
}

function noticeTypeSqlList() {
  return CITY_RECORD_PIN_CHAIN_NOTICE_TYPES.map((t) => `'${sq(t)}'`).join(", ");
}

export function sqlPinChainByPin(pin, table = cityRecordTableName()) {
  const p = sq(String(pin).trim());
  const cols = CITY_RECORD_PIN_CHAIN_SELECT_COLS.join(", ");
  return (
    `SELECT ${cols} FROM ${table} ` +
    `WHERE CAST(pin AS VARCHAR) = '${p}' ` +
    `AND type_of_notice_description IN (${noticeTypeSqlList()}) ` +
    `ORDER BY start_date ASC NULLS LAST ` +
    `LIMIT ${CITY_RECORD_PIN_CHAIN_PER_PIN_LIMIT}`
  );
}

export function sqlPinChainExportAll(table = cityRecordTableName(), limit = null) {
  const cols = CITY_RECORD_PIN_CHAIN_SELECT_COLS.join(", ");
  const lim =
    limit != null && Number.isFinite(Number(limit)) && Number(limit) > 0
      ? ` LIMIT ${Math.floor(Number(limit))}`
      : "";
  return (
    `SELECT ${cols} FROM ${table} ` +
    `WHERE pin IS NOT NULL AND CAST(pin AS VARCHAR) <> '' ` +
    `AND type_of_notice_description IN (${noticeTypeSqlList()}) ` +
    `ORDER BY start_date DESC NULLS LAST, CAST(request_id AS VARCHAR) DESC${lim}`
  );
}

/**
 * Export procurement-with-pin rows from the WH-07 warehouse for materialization.
 */
export function exportPinChainRowsFromWarehouse(opts = {}) {
  if (!catalogExists()) {
    throw new Error("DuckDB catalog missing; run warehouse City Record ingest first");
  }
  const limit = opts.limit != null ? opts.limit : null;
  const raw = queryWarehouse(sqlPinChainExportAll(cityRecordTableName(), limit));
  return raw.map(rowToSodaShape).filter(Boolean);
}

/**
 * Pure index over materialized PIN-chain rows (no DuckDB).
 * @param {object[]} rows SODA-shaped rows
 */
export function buildPinChainLookupIndex(rows) {
  const list = Array.isArray(rows) ? rows.map(rowToSodaShape).filter(Boolean) : [];
  /** @type {Map<string, object[]>} */
  const byPin = new Map();
  for (const row of list) {
    const k = String(row.pin).trim();
    if (!byPin.has(k)) byPin.set(k, []);
    const bucket = byPin.get(k);
    if (bucket.length < CITY_RECORD_PIN_CHAIN_PER_PIN_LIMIT) bucket.push(row);
  }
  for (const bucket of byPin.values()) {
    bucket.sort(
      (a, b) =>
        String(a.start_date || "").localeCompare(String(b.start_date || "")) ||
        String(a.request_id || "").localeCompare(String(b.request_id || "")),
    );
  }
  return { byPin, rowCount: list.length, pinCount: byPin.size };
}

/**
 * Lookup notice siblings by exact PIN against a pure materialization index.
 * @returns {{ hit: boolean, rows: object[], join_key: string|null }}
 */
export function lookupPinChainInIndex(pin, index) {
  if (!index) return { hit: false, rows: [], join_key: null };
  const key = String(pin || "").trim();
  if (!key) return { hit: false, rows: [], join_key: null };
  const rows = index.byPin.get(key) || [];
  if (!rows.length) return { hit: false, rows: [], join_key: null };
  return { hit: true, rows: rows.slice(), join_key: "pin" };
}

/**
 * Live DuckDB lookup for one PIN — host/ops only.
 */
export function lookupPinChainRowsFromWarehouse(pin) {
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
  try {
    const rows = queryWarehouse(sqlPinChainByPin(pin))
      .map(rowToSodaShape)
      .filter(Boolean);
    return {
      ok: true,
      rows,
      path: "warehouse",
      ms: performance.now() - started,
      join_key: rows.length ? "pin" : null,
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
 * Age / canary / row-count drift gate for the committed WH-07 PIN-chain serve.
 * Empty materializations fail closed. verified_seed is allowed for the offline
 * CI path; bulk_warehouse requires the warehouse-scale floor.
 */
export function cityRecordPinChainServeGateFindings(doc, opts = {}) {
  const findings = servePublishFindings(
    doc,
    SERVE_LOOKUP_CONTRACTS.city_record_pin_chain,
    opts,
  );
  const rows = Array.isArray(doc?.rows) ? doc.rows : [];
  const rowCount = Number.isFinite(Number(doc?.row_count))
    ? Number(doc.row_count)
    : rows.length;
  const mode = String(doc?.mode || "");
  const index = buildPinChainLookupIndex(rows);
  const pinCount = Number.isFinite(Number(doc?.pin_count))
    ? Number(doc.pin_count)
    : index.pinCount;

  if (rowCount === 0 || pinCount === 0) {
    findings.push(
      `City Record PIN-chain serve is empty (row_count=${rowCount}, pin_count=${pinCount}); rebuild from WH-07 warehouse or verified seed`,
    );
  }
  if (rowCount < CITY_RECORD_PIN_CHAIN_MIN_ROW_COUNT) {
    findings.push(
      `City Record PIN-chain serve row_count ${rowCount} below floor ${CITY_RECORD_PIN_CHAIN_MIN_ROW_COUNT}`,
    );
  }
  if (
    CITY_RECORD_PIN_CHAIN_FULL_MODES.includes(mode) &&
    rowCount < CITY_RECORD_PIN_CHAIN_BULK_MIN_ROW_COUNT
  ) {
    findings.push(
      `City Record PIN-chain bulk mode row_count ${rowCount} below warehouse floor ${CITY_RECORD_PIN_CHAIN_BULK_MIN_ROW_COUNT}`,
    );
  }
  if (
    !CITY_RECORD_PIN_CHAIN_FULL_MODES.includes(mode) &&
    mode !== "verified_seed" &&
    mode !== "warehouse"
  ) {
    findings.push(
      `City Record PIN-chain serve mode ${JSON.stringify(mode)} is not verified_seed|warehouse|bulk_warehouse`,
    );
  }
  return findings;
}

export function assertCityRecordPinChainServeGate(doc, opts = {}) {
  const findings = cityRecordPinChainServeGateFindings(doc, opts);
  if (findings.length) throw new Error(findings.join("; "));
  return true;
}

/**
 * Build the committed materialization document.
 */
export function buildMaterializationDoc(rows, opts = {}) {
  const list = Array.isArray(rows) ? rows.map(rowToSodaShape).filter(Boolean) : [];
  const index = buildPinChainLookupIndex(list);
  const bulkProcurement =
    opts.bulkProcurementSectionRows ?? CITY_RECORD_BULK_PROCUREMENT_SECTION_ROWS;
  return {
    schema_version: 1,
    phase: "WH-07",
    source: "warehouse",
    dataset_id: getDataset(CITY_RECORD_DATASET_KEY).dataset_id,
    table_name: cityRecordTableName(),
    mode: opts.mode || "export",
    materialized_at: opts.now || new Date().toISOString(),
    row_count: list.length,
    pin_count: index.pinCount,
    bulk_snapshot_date: opts.bulkSnapshotDate || null,
    coverage: {
      bulk_procurement_section_rows: bulkProcurement,
      selected_rows: list.length,
      selected_pins: index.pinCount,
      note:
        "Selected rows are procurement notice types with a non-empty pin from WH-07 (or verified seed).",
    },
    window: {
      kind: "procurement_pin_chain",
      notice_types: [...CITY_RECORD_PIN_CHAIN_NOTICE_TYPES],
      require_pin: true,
      per_pin_limit: CITY_RECORD_PIN_CHAIN_PER_PIN_LIMIT,
    },
    replaces_live_fetch: {
      worker: "worker/src/checkbook_lifecycle.mjs#fetchRelatedProcurementNotices",
      soda_dataset: "dg92-zbpx",
      description:
        "City Record PIN siblings on /contract-lifecycle — warehouse materialization first, then D1, then live SODA on miss",
    },
    rows: list,
  };
}

/** Load verified product seed JSON — offline CI without DuckDB. */
export function loadProductSeedRows() {
  const path = join(
    WAREHOUSE_DIR,
    "fixtures",
    "city-record-pin-chain",
    "product_seed.json",
  );
  if (!existsSync(path)) return [];
  const doc = JSON.parse(readFileSync(path, "utf8"));
  const rows = Array.isArray(doc?.rows) ? doc.rows : [];
  return rows.map(rowToSodaShape).filter(Boolean);
}

/**
 * Read last-known-good committed twins when a rebuild fails the serve gate.
 * Returns null when no usable previous document exists.
 */
export function loadLastKnownGoodDoc(sitePath, workerPath) {
  for (const filePath of [sitePath, workerPath].filter(Boolean)) {
    if (!existsSync(filePath)) continue;
    try {
      const doc = JSON.parse(readFileSync(filePath, "utf8"));
      const findings = cityRecordPinChainServeGateFindings(doc);
      if (findings.length === 0) return doc;
    } catch {
      /* try next */
    }
  }
  return null;
}

function printHelp() {
  console.log(`Usage:
  node warehouse/lib/city_record_pin_chain_lookup.mjs --pin <pin>
  node warehouse/lib/city_record_pin_chain_lookup.mjs --export [--limit N]
`);
}

function cli(argv) {
  const args = argv.slice(2);
  let pin = null;
  let doExport = false;
  let limit = null;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--pin") pin = args[++i];
    else if (args[i] === "--export") doExport = true;
    else if (args[i] === "--limit") limit = Number(args[++i]);
    else if (args[i] === "--help" || args[i] === "-h") {
      printHelp();
      process.exit(0);
    }
  }
  if (doExport) {
    const rows = exportPinChainRowsFromWarehouse({ limit });
    console.log(
      JSON.stringify(buildMaterializationDoc(rows, { mode: "cli_export" }), null, 2),
    );
    return;
  }
  if (!pin) {
    printHelp();
    process.exit(2);
  }
  const result = lookupPinChainRowsFromWarehouse(pin);
  console.log(JSON.stringify(result, null, 2));
  if (!result.ok) process.exit(1);
}

const entry = process.argv[1] ? pathToFileURL(process.argv[1]).href : "";
if (import.meta.url === entry) {
  cli(process.argv);
}
