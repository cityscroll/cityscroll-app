/**
 * WH-05: Doing Business Search Entities lookup over the warehouse (DuckDB)
 * + pure materialization index.
 *
 * Replaces multi-page live SODA (`72mk-a8z7`) in vendor-profile cron attach when
 * the materialization is present. Misses / empty materialization keep live SODA.
 *
 *   node warehouse/lib/doing_business_lookup.mjs --export [--limit N]
 */
import { existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { catalogExists, getDataset, WAREHOUSE_DIR } from "./catalog.mjs";
import { queryWarehouse } from "./query.mjs";

export const DB_DATASET_KEY = "doing-business-entities";
export const DB_SELECT_COLS = [
  "organization_name",
  "ownership_structure_code",
  "organization_phone",
  "doing_business_start_date",
];

function sq(s) {
  return String(s || "").replace(/'/g, "''");
}

export function doingBusinessTableName() {
  return getDataset(DB_DATASET_KEY).table_name;
}

/** Normalize a warehouse/SODA row to the four product columns. */
export function rowToSodaShape(row) {
  if (!row || typeof row !== "object") return null;
  const organization_name =
    row.organization_name != null ? String(row.organization_name).trim() : "";
  if (!organization_name) return null;
  return {
    organization_name,
    ownership_structure_code:
      row.ownership_structure_code != null
        ? String(row.ownership_structure_code).trim()
        : null,
    organization_phone:
      row.organization_phone != null ? String(row.organization_phone).trim() : null,
    doing_business_start_date:
      row.doing_business_start_date != null
        ? String(row.doing_business_start_date).trim()
        : null,
  };
}

export function sqlDoingBusinessExportAll(table = doingBusinessTableName(), limit = null) {
  const cols = DB_SELECT_COLS.join(", ");
  const lim =
    limit != null && Number.isFinite(Number(limit)) && Number(limit) > 0
      ? ` LIMIT ${Math.floor(Number(limit))}`
      : "";
  return `SELECT ${cols} FROM ${table} ORDER BY organization_name ASC NULLS LAST${lim}`;
}

export function sqlDoingBusinessByName(name, table = doingBusinessTableName()) {
  const n = sq(String(name || "").trim());
  const cols = DB_SELECT_COLS.join(", ");
  return (
    `SELECT ${cols} FROM ${table} ` +
    `WHERE upper(trim(CAST(organization_name AS VARCHAR))) = upper('${n}') ` +
    `LIMIT 5`
  );
}

/**
 * Export entities from DuckDB for materialization.
 */
export function exportDoingBusinessRowsFromWarehouse(opts = {}) {
  if (!catalogExists()) {
    throw new Error("DuckDB catalog missing; run warehouse ingest first");
  }
  const limit = opts.limit != null ? opts.limit : null;
  // Table may be absent until this dataset is packed — surface a clear error.
  try {
    const raw = queryWarehouse(sqlDoingBusinessExportAll(doingBusinessTableName(), limit));
    return raw.map(rowToSodaShape).filter(Boolean);
  } catch (e) {
    const msg = String(e && e.message ? e.message : e);
    if (/does not exist|Catalog Error|Table with name/i.test(msg)) {
      throw new Error(
        `warehouse table ${doingBusinessTableName()} missing — ingest doing-business-entities first`,
      );
    }
    throw e;
  }
}

/**
 * Build the committed materialization document (full entity rows for stem index).
 */
export function buildMaterializationDoc(rows, opts = {}) {
  const list = Array.isArray(rows) ? rows.map(rowToSodaShape).filter(Boolean) : [];
  return {
    schema_version: 1,
    phase: "WH-05",
    source: "warehouse",
    dataset_id: getDataset(DB_DATASET_KEY).dataset_id,
    table_name: doingBusinessTableName(),
    mode: opts.mode || "export",
    materialized_at: opts.now || new Date().toISOString(),
    row_count: list.length,
    replaces_live_fetch: {
      worker: "worker/src/vendor_profile.mjs#attachDoingBusiness",
      soda_dataset: "72mk-a8z7",
      description:
        "Doing Business Search Entities attach on daily vendor-profile refresh — warehouse materialization first, live multi-page SODA when materialization empty",
    },
    rows: list,
  };
}

/** Load product seed CSV without DuckDB — offline CI. */
export function loadProductSeedRows() {
  const path = join(
    WAREHOUSE_DIR,
    "fixtures",
    "doing-business-entities",
    "product_seed.csv",
  );
  if (!existsSync(path)) return [];
  const text = readFileSync(path, "utf8").trim();
  if (!text) return [];
  const lines = text.split(/\r?\n/);
  if (lines.length < 2) return [];
  const headers = lines[0].split(",").map((h) => h.trim());
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(",").map((c) => c.trim());
    if (!cols.length || !cols[0]) continue;
    const obj = {};
    headers.forEach((h, j) => {
      obj[h] = cols[j] != null && cols[j] !== "" ? cols[j] : null;
    });
    const shaped = rowToSodaShape(obj);
    if (shaped) rows.push(shaped);
  }
  return rows;
}

function printHelp() {
  console.log(`Usage:
  node warehouse/lib/doing_business_lookup.mjs --export [--limit N]
`);
}

function cli(argv) {
  const args = argv.slice(2);
  let doExport = false;
  let limit = null;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--export") doExport = true;
    else if (args[i] === "--limit") limit = Number(args[++i]);
    else if (args[i] === "--help" || args[i] === "-h") {
      printHelp();
      process.exit(0);
    }
  }
  if (!doExport) {
    printHelp();
    process.exit(1);
  }
  const rows = exportDoingBusinessRowsFromWarehouse({ limit });
  console.log(JSON.stringify({ row_count: rows.length, sample: rows.slice(0, 3) }, null, 2));
}

const isMain =
  process.argv[1] &&
  pathToFileURL(process.argv[1]).href === import.meta.url;
if (isMain) cli(process.argv);
