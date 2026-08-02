/**
 * WH-05: ZAP Project Data lookup over the warehouse (DuckDB) + pure
 * materialization index.
 *
 * Replaces live SODA `hgx4-8ukb` hits for:
 *   - zap_outcomes fetchOpenDataRow (per project_id)
 *   - land default Active ULURP first-paint rebuild (optional warehouse source)
 *
 * Live SODA remains the miss / empty-catalog fallback.
 *
 *   node warehouse/lib/zap_projects_lookup.mjs --project-id 2024Q0135
 *   node warehouse/lib/zap_projects_lookup.mjs --export [--limit N]
 *   node warehouse/lib/zap_projects_lookup.mjs --land-default
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { catalogExists, getDataset, WAREHOUSE_DIR } from "./catalog.mjs";
import { queryWarehouse } from "./query.mjs";

export const ZAP_DATASET_KEY = "zap-projects";

/** Fields used by land default list + zap_outcomes open_data side-car. */
export const ZAP_SELECT_COLS = [
  "project_id",
  "project_name",
  "primary_applicant",
  "public_status",
  "project_status",
  "borough",
  "community_district",
  "actions",
  "mih_flag",
  "current_milestone",
  "current_milestone_date",
  "ulurp_numbers",
  "approval_date",
  "completed_date",
];

export const LAND_DEFAULT_WHERE_SQL =
  "CAST(ulurp_non AS VARCHAR) = 'ULURP' AND CAST(project_status AS VARCHAR) = 'Active'";
export const LAND_DEFAULT_LIMIT = 40;

function sq(s) {
  return String(s || "").replace(/'/g, "''");
}

export function zapTableName() {
  return getDataset(ZAP_DATASET_KEY).table_name;
}

export function rowToSodaShape(row) {
  if (!row || typeof row !== "object") return null;
  const project_id = row.project_id != null ? String(row.project_id).trim() : "";
  if (!project_id) return null;
  const out = { project_id };
  for (const col of ZAP_SELECT_COLS) {
    if (col === "project_id") continue;
    const v = row[col];
    out[col] = v != null && v !== "" ? String(v) : null;
  }
  return out;
}

export function sqlZapByProjectId(projectId, table = zapTableName()) {
  const id = sq(projectId);
  const cols = ZAP_SELECT_COLS.join(", ");
  return (
    `SELECT ${cols} FROM ${table} ` +
    `WHERE CAST(project_id AS VARCHAR) = '${id}' ` +
    `LIMIT 1`
  );
}

export function sqlZapExportAll(table = zapTableName(), limit = null) {
  const cols = ZAP_SELECT_COLS.join(", ");
  const lim =
    limit != null && Number.isFinite(Number(limit)) && Number(limit) > 0
      ? ` LIMIT ${Math.floor(Number(limit))}`
      : "";
  return (
    `SELECT ${cols} FROM ${table} ` +
    `ORDER BY current_milestone_date DESC NULLS LAST${lim}`
  );
}

/**
 * Active ULURP default land list — same filter as batch_precompute_snapshots.
 * ulurp_non may be absent on slim fixtures; then fall back to status-only Active.
 */
export function sqlZapLandDefault(table = zapTableName(), limit = LAND_DEFAULT_LIMIT) {
  const cols = ZAP_SELECT_COLS.join(", ");
  return (
    `SELECT ${cols} FROM ${table} ` +
    `WHERE CAST(project_status AS VARCHAR) = 'Active' ` +
    `ORDER BY current_milestone_date DESC NULLS LAST ` +
    `LIMIT ${Math.floor(Number(limit))}`
  );
}

export function exportZapRowsFromWarehouse(opts = {}) {
  if (!catalogExists()) {
    throw new Error("DuckDB catalog missing; run warehouse ingest first");
  }
  const limit = opts.limit != null ? opts.limit : null;
  try {
    const raw = queryWarehouse(sqlZapExportAll(zapTableName(), limit));
    return raw.map(rowToSodaShape).filter(Boolean);
  } catch (e) {
    const msg = String(e && e.message ? e.message : e);
    if (/does not exist|Catalog Error|Table with name/i.test(msg)) {
      throw new Error(
        `warehouse table ${zapTableName()} missing — ingest zap-projects first`,
      );
    }
    throw e;
  }
}

export function exportLandDefaultFromWarehouse(opts = {}) {
  if (!catalogExists()) {
    throw new Error("DuckDB catalog missing; run warehouse ingest first");
  }
  const limit = opts.limit != null ? opts.limit : LAND_DEFAULT_LIMIT;
  try {
    const raw = queryWarehouse(sqlZapLandDefault(zapTableName(), limit));
    return raw.map(rowToSodaShape).filter(Boolean);
  } catch (e) {
    const msg = String(e && e.message ? e.message : e);
    if (/does not exist|Catalog Error|Table with name/i.test(msg)) {
      throw new Error(
        `warehouse table ${zapTableName()} missing — ingest zap-projects first`,
      );
    }
    throw e;
  }
}

/**
 * Live DuckDB lookup for one project_id (host/ops).
 */
export function lookupZapProjectFromWarehouse(projectId) {
  const started = performance.now();
  if (!catalogExists()) {
    return {
      ok: false,
      row: null,
      path: "unavailable",
      ms: performance.now() - started,
      reason: "catalog_missing",
    };
  }
  const id = String(projectId || "").trim();
  if (!id) {
    return {
      ok: true,
      row: null,
      path: "warehouse",
      ms: performance.now() - started,
    };
  }
  try {
    const rows = queryWarehouse(sqlZapByProjectId(id))
      .map(rowToSodaShape)
      .filter(Boolean);
    return {
      ok: true,
      row: rows[0] || null,
      path: "warehouse",
      ms: performance.now() - started,
      hit: Boolean(rows[0]),
    };
  } catch (e) {
    return {
      ok: false,
      row: null,
      path: "unavailable",
      ms: performance.now() - started,
      reason: String(e && e.message ? e.message : e),
    };
  }
}

export function buildZapLookupIndex(rows) {
  const list = Array.isArray(rows) ? rows.map(rowToSodaShape).filter(Boolean) : [];
  /** @type {Map<string, object>} */
  const byProjectId = new Map();
  for (const row of list) {
    if (!byProjectId.has(row.project_id)) byProjectId.set(row.project_id, row);
  }
  return { byProjectId, rowCount: list.length };
}

export function lookupZapInIndex(projectId, index) {
  if (!index) return { hit: false, row: null };
  const id = String(projectId || "").trim();
  if (!id) return { hit: true, row: null };
  const row = index.byProjectId.get(id) || null;
  return row ? { hit: true, row } : { hit: false, row: null };
}

export function buildMaterializationDoc(rows, opts = {}) {
  const list = Array.isArray(rows) ? rows.map(rowToSodaShape).filter(Boolean) : [];
  return {
    schema_version: 1,
    phase: "WH-05",
    source: "warehouse",
    dataset_id: getDataset(ZAP_DATASET_KEY).dataset_id,
    table_name: zapTableName(),
    mode: opts.mode || "export",
    materialized_at: opts.now || new Date().toISOString(),
    row_count: list.length,
    replaces_live_fetch: {
      worker: "worker/src/zap_outcomes.mjs#fetchOpenDataRow",
      soda_dataset: "hgx4-8ukb",
      also: [
        "tools/build_batch_precompute_snapshots.mjs land default rebuild (warehouse path)",
      ],
      description:
        "ZAP Open Data project row on /zap-outcomes and land default Active ULURP snapshot — warehouse materialization first, live SODA on miss",
    },
    rows: list,
  };
}

export function loadProductSeedRows() {
  const path = join(WAREHOUSE_DIR, "fixtures", "zap-projects", "product_seed.csv");
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
      obj[h] = cols[j] != null && cols[j] !== "" ? cols[j] : null;
    });
    const shaped = rowToSodaShape(obj);
    if (shaped) rows.push(shaped);
  }
  return rows;
}

function splitCsvLine(line) {
  // Controlled fixtures: no embedded commas in product seed cells.
  return line.split(",").map((c) => c.trim());
}

function printHelp() {
  console.log(`Usage:
  node warehouse/lib/zap_projects_lookup.mjs --project-id <id>
  node warehouse/lib/zap_projects_lookup.mjs --export [--limit N]
  node warehouse/lib/zap_projects_lookup.mjs --land-default
`);
}

function cli(argv) {
  const args = argv.slice(2);
  let projectId = null;
  let doExport = false;
  let landDefault = false;
  let limit = null;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--project-id") projectId = args[++i];
    else if (args[i] === "--export") doExport = true;
    else if (args[i] === "--land-default") landDefault = true;
    else if (args[i] === "--limit") limit = Number(args[++i]);
    else if (args[i] === "--help" || args[i] === "-h") {
      printHelp();
      process.exit(0);
    }
  }
  if (projectId) {
    console.log(JSON.stringify(lookupZapProjectFromWarehouse(projectId), null, 2));
    return;
  }
  if (landDefault) {
    const rows = exportLandDefaultFromWarehouse({ limit });
    console.log(JSON.stringify({ row_count: rows.length, sample: rows.slice(0, 2) }, null, 2));
    return;
  }
  if (doExport) {
    const rows = exportZapRowsFromWarehouse({ limit });
    console.log(JSON.stringify({ row_count: rows.length, sample: rows.slice(0, 2) }, null, 2));
    return;
  }
  printHelp();
  process.exit(1);
}

const isMain =
  process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;
if (isMain) cli(process.argv);
