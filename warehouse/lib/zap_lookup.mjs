/**
 * WH-05: ZAP project lookup over the warehouse (DuckDB) + pure materialization index.
 *
 * The edge Worker never opens DuckDB. Host tooling queries here, materializes a
 * compact JSON snapshot (`site/data/zap_projects_warehouse_lookup.json`), and the
 * Worker serves hits from that snapshot with live SODA as miss fallback.
 *
 *   node warehouse/lib/zap_lookup.mjs --project-id 2022M0258
 *   node warehouse/lib/zap_lookup.mjs --export [--limit N]
 */
import { existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { catalogExists, getDataset, WAREHOUSE_DIR } from "./catalog.mjs";
import { queryWarehouse } from "./query.mjs";

export const ZAP_DATASET_KEY = "zap-projects";

/** Columns used by fetchOpenDataRow / land list join paths. */
export const ZAP_SELECT_COLS = [
  "project_id",
  "project_name",
  "public_status",
  "project_status",
  "approval_date",
  "completed_date",
  "ulurp_numbers",
  "borough",
  "community_district",
  "actions",
  "current_milestone",
  "current_milestone_date",
];

/** Extra list fields useful for land default / prewarm without huge briefs. */
export const ZAP_EXTRA_COLS = [
  "ulurp_non",
  "primary_applicant",
  "mih_flag",
  "app_filed_date",
  "noticed_date",
  "certified_referred",
];

export const ZAP_ALL_COLS = [...ZAP_SELECT_COLS, ...ZAP_EXTRA_COLS];

/** Sell-facing statuses prewarmed for Land detail (matches worker ZAP_PREWARM_STATUSES). */
export const ZAP_SELL_FACING_STATUSES = Object.freeze([
  "In Public Review",
  "Noticed",
  "Active",
  "Filed",
]);

function sq(s) {
  return String(s || "").replace(/'/g, "''");
}

export function zapTableName() {
  return getDataset(ZAP_DATASET_KEY).table_name;
}

/**
 * Normalize a warehouse/SODA row to the SODA field names fetchOpenDataRow returns.
 */
export function rowToSodaShape(row) {
  if (!row || typeof row !== "object") return null;
  const out = {};
  for (const col of ZAP_ALL_COLS) {
    const v = row[col];
    if (v == null || v === "") {
      out[col] = null;
    } else if (typeof v === "boolean") {
      out[col] = v ? "true" : "false";
    } else {
      out[col] = String(v);
    }
  }
  if (!out.project_id) return null;
  out.project_id = String(out.project_id).trim();
  return out;
}

export function sqlZapByProjectId(projectId, table = zapTableName()) {
  const id = sq(String(projectId).trim());
  const cols = ZAP_ALL_COLS.join(", ");
  return (
    `SELECT ${cols} FROM ${table} ` +
    `WHERE CAST(project_id AS VARCHAR) = '${id}' ` +
    `LIMIT 1`
  );
}

/**
 * Export sell-facing + optional demos for materialization (bounded corpus).
 * Full table is ~33k rows — too large for a committed Worker JSON twin.
 */
export function sqlZapExportSellFacing(table = zapTableName(), limit = null) {
  const cols = ZAP_ALL_COLS.join(", ");
  const statuses = ZAP_SELL_FACING_STATUSES.map((s) => `'${sq(s)}'`).join(", ");
  const lim =
    limit != null && Number.isFinite(Number(limit)) && Number(limit) > 0
      ? ` LIMIT ${Math.floor(Number(limit))}`
      : "";
  return (
    `SELECT ${cols} FROM ${table} ` +
    `WHERE CAST(public_status AS VARCHAR) IN (${statuses}) ` +
    `OR CAST(project_id AS VARCHAR) IN ('2022M0258') ` +
    `ORDER BY current_milestone_date DESC NULLS LAST${lim}`
  );
}

export function sqlZapExportAll(table = zapTableName(), limit = null) {
  const cols = ZAP_ALL_COLS.join(", ");
  const lim =
    limit != null && Number.isFinite(Number(limit)) && Number(limit) > 0
      ? ` LIMIT ${Math.floor(Number(limit))}`
      : "";
  return `SELECT ${cols} FROM ${table} ORDER BY current_milestone_date DESC NULLS LAST${lim}`;
}

/**
 * Live DuckDB lookup for one project — host/ops only.
 * @returns {{ ok: boolean, row: object|null, path: "warehouse"|"unavailable", ms: number }}
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
      ok: false,
      row: null,
      path: "unavailable",
      ms: performance.now() - started,
      reason: "missing_project_id",
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
      join_key: rows[0] ? "project_id" : null,
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

/**
 * Export rows from warehouse for materialization.
 * Default: sell-facing universe (+ demo). Pass all:true for full table (ops only).
 */
export function exportZapRowsFromWarehouse(opts = {}) {
  if (!catalogExists()) {
    throw new Error("DuckDB catalog missing; run warehouse ingest first");
  }
  const limit = opts.limit != null ? opts.limit : null;
  const sql = opts.all
    ? sqlZapExportAll(zapTableName(), limit)
    : sqlZapExportSellFacing(zapTableName(), limit);
  return queryWarehouse(sql).map(rowToSodaShape).filter(Boolean);
}

/**
 * Pure index over materialized ZAP rows (no DuckDB). Used by Worker + tests.
 */
export function buildZapLookupIndex(rows) {
  const list = Array.isArray(rows) ? rows.map(rowToSodaShape).filter(Boolean) : [];
  /** @type {Map<string, object>} */
  const byProjectId = new Map();
  for (const row of list) {
    if (!row.project_id) continue;
    const k = String(row.project_id).trim();
    if (!byProjectId.has(k)) byProjectId.set(k, row);
  }
  return { byProjectId, rowCount: list.length };
}

/**
 * Lookup one project against a pure materialization index.
 * @returns {{ hit: boolean, row: object|null, join_key: string|null }}
 */
export function lookupZapInIndex(projectId, index) {
  const id = String(projectId || "").trim();
  if (!index || !id) return { hit: false, row: null, join_key: null };
  const row = index.byProjectId.get(id) || null;
  if (row) return { hit: true, row, join_key: "project_id" };
  return { hit: false, row: null, join_key: null };
}

/**
 * Build the committed materialization document.
 */
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
      description:
        "ZAP Open Data project row on /zap-outcomes — warehouse materialization first, live SODA on miss",
    },
    rows: list,
  };
}

/** Load product seed CSV (public field-case rows) without DuckDB — offline CI. */
export function loadProductSeedRows() {
  const path = join(WAREHOUSE_DIR, "fixtures", "zap-projects", "product_seed.csv");
  return loadCsvRows(path);
}

function loadCsvRows(path) {
  if (!existsSync(path)) return [];
  const text = readFileSync(path, "utf8");
  if (!text.trim()) return [];
  const rows = parseCsv(text);
  return rows.map(rowToSodaShape).filter(Boolean);
}

/** RFC4180-ish CSV parse (handles quoted fields with commas). */
export function parseCsv(text) {
  const lines = [];
  let i = 0;
  const s = String(text).replace(/^\uFEFF/, "");
  while (i < s.length) {
    const row = [];
    while (i < s.length) {
      if (s[i] === '"') {
        i++;
        let cell = "";
        while (i < s.length) {
          if (s[i] === '"') {
            if (s[i + 1] === '"') {
              cell += '"';
              i += 2;
              continue;
            }
            i++;
            break;
          }
          cell += s[i++];
        }
        row.push(cell);
      } else {
        let cell = "";
        while (i < s.length && s[i] !== "," && s[i] !== "\n" && s[i] !== "\r") {
          cell += s[i++];
        }
        row.push(cell);
      }
      if (s[i] === ",") {
        i++;
        continue;
      }
      if (s[i] === "\r") i++;
      if (s[i] === "\n") i++;
      break;
    }
    if (row.length === 1 && row[0] === "" && i >= s.length) break;
    lines.push(row);
  }
  if (lines.length < 2) return [];
  const headers = lines[0].map((h) => h.trim());
  const out = [];
  for (let r = 1; r < lines.length; r++) {
    const cols = lines[r];
    if (!cols.length || (cols.length === 1 && cols[0] === "")) continue;
    const obj = {};
    headers.forEach((h, j) => {
      const v = cols[j] != null ? cols[j].trim() : "";
      obj[h] = v === "" ? null : v;
    });
    out.push(obj);
  }
  return out;
}

function printHelp() {
  console.log(`Usage:
  node warehouse/lib/zap_lookup.mjs --project-id <id>
  node warehouse/lib/zap_lookup.mjs --export [--limit N] [--all]
`);
}

function cli(argv) {
  const args = argv.slice(2);
  let projectId = null;
  let doExport = false;
  let limit = null;
  let all = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--project-id") projectId = args[++i];
    else if (args[i] === "--export") doExport = true;
    else if (args[i] === "--all") all = true;
    else if (args[i] === "--limit") limit = Number(args[++i]);
    else if (args[i] === "--help" || args[i] === "-h") {
      printHelp();
      process.exit(0);
    }
  }
  if (doExport) {
    const rows = exportZapRowsFromWarehouse({ limit, all });
    console.log(
      JSON.stringify(buildMaterializationDoc(rows, { mode: "cli_export" }), null, 2)
    );
    return;
  }
  if (!projectId) {
    printHelp();
    process.exit(2);
  }
  const result = lookupZapProjectFromWarehouse(projectId);
  console.log(JSON.stringify(result, null, 2));
  if (!result.ok) process.exit(1);
}

const entry = process.argv[1] ? pathToFileURL(process.argv[1]).href : "";
if (import.meta.url === entry) {
  cli(process.argv);
}
