/**
 * WH-06: ZAP BBL lookup over the warehouse (DuckDB) + pure materialization index.
 *
 * The edge Worker never opens DuckDB. Host tooling queries here, materializes a
 * compact JSON snapshot (`site/data/zap_bbl_warehouse_lookup.json`), and the
 * Worker serves hits from that snapshot with live SODA as miss fallback.
 *
 *   node warehouse/lib/zap_bbl_lookup.mjs --project-id 2022M0258
 *   node warehouse/lib/zap_bbl_lookup.mjs --export [--limit N]
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { catalogExists, getDataset, WAREHOUSE_DIR } from "./catalog.mjs";
import { queryWarehouse } from "./query.mjs";
import { ZAP_SELL_FACING_STATUSES } from "./zap_lookup.mjs";

export const ZAP_BBL_DATASET_KEY = "zap-bbl";

/** Columns used by fetchBbls / land tax-lot side path. */
export const ZAP_BBL_SELECT_COLS = [
  "project_id",
  "bbl",
  "validated_borough",
  "validated_block",
  "validated_lot",
  "validated",
  "validated_date",
];

function sq(s) {
  return String(s || "").replace(/'/g, "''");
}

export function zapBblTableName() {
  return getDataset(ZAP_BBL_DATASET_KEY).table_name;
}

/** Normalize one warehouse/SODA BBL row. */
export function rowToBblShape(row) {
  if (!row || typeof row !== "object") return null;
  const project_id = String(row.project_id || "").trim();
  let bbl = String(row.bbl ?? "").trim().replace(/\.0$/, "");
  if (bbl && /^\d+$/.test(bbl) && bbl.length < 10) bbl = bbl.padStart(10, "0");
  if (!project_id || !bbl || !/^\d{10}$/.test(bbl)) return null;
  const out = {
    project_id,
    bbl,
    validated_borough: row.validated_borough != null && row.validated_borough !== ""
      ? String(row.validated_borough)
      : null,
    validated_block: row.validated_block != null && row.validated_block !== ""
      ? String(row.validated_block)
      : null,
    validated_lot: row.validated_lot != null && row.validated_lot !== ""
      ? String(row.validated_lot)
      : null,
    validated: row.validated != null && row.validated !== ""
      ? String(row.validated)
      : null,
    validated_date: row.validated_date != null && row.validated_date !== ""
      ? String(row.validated_date)
      : null,
  };
  return out;
}

export function sqlBblsByProjectId(projectId, table = zapBblTableName()) {
  const id = sq(String(projectId).trim());
  return (
    `SELECT project_id, CAST(bbl AS VARCHAR) AS bbl, ` +
    `validated_borough, validated_block, validated_lot, validated, validated_date ` +
    `FROM ${table} ` +
    `WHERE CAST(project_id AS VARCHAR) = '${id}' ` +
    `AND bbl IS NOT NULL ` +
    `ORDER BY CAST(bbl AS VARCHAR) ` +
    `LIMIT 40`
  );
}

/**
 * Export BBL rows for sell-facing ZAP projects (+ demos) when zap_projects is
 * present; otherwise export a bounded full-table sample.
 */
export function sqlBblExportSellFacing(bblTable = zapBblTableName(), limit = null) {
  const statuses = ZAP_SELL_FACING_STATUSES.map((s) => `'${sq(s)}'`).join(", ");
  const lim =
    limit != null && Number.isFinite(Number(limit)) && Number(limit) > 0
      ? ` LIMIT ${Math.floor(Number(limit))}`
      : "";
  // Prefer join against zap_projects when registered; fall back to demo ids only.
  return (
    `SELECT b.project_id AS project_id, CAST(b.bbl AS VARCHAR) AS bbl, ` +
    `b.validated_borough AS validated_borough, b.validated_block AS validated_block, ` +
    `b.validated_lot AS validated_lot, b.validated AS validated, b.validated_date AS validated_date ` +
    `FROM ${bblTable} b ` +
    `WHERE b.bbl IS NOT NULL AND ( ` +
    `  CAST(b.project_id AS VARCHAR) IN ('2022M0258','FIXZAP001','FIXZAP002') ` +
    `  OR CAST(b.project_id AS VARCHAR) IN ( ` +
    `    SELECT CAST(p.project_id AS VARCHAR) FROM zap_projects p ` +
    `    WHERE CAST(p.public_status AS VARCHAR) IN (${statuses}) ` +
    `  ) ` +
    `) ` +
    `ORDER BY CAST(b.project_id AS VARCHAR), CAST(b.bbl AS VARCHAR)${lim}`
  );
}

export function sqlBblExportAll(bblTable = zapBblTableName(), limit = null) {
  const lim =
    limit != null && Number.isFinite(Number(limit)) && Number(limit) > 0
      ? ` LIMIT ${Math.floor(Number(limit))}`
      : "";
  return (
    `SELECT project_id, CAST(bbl AS VARCHAR) AS bbl, ` +
    `validated_borough, validated_block, validated_lot, validated, validated_date ` +
    `FROM ${bblTable} WHERE bbl IS NOT NULL ` +
    `ORDER BY CAST(project_id AS VARCHAR), CAST(bbl AS VARCHAR)${lim}`
  );
}

/**
 * Live DuckDB lookup for one project — host/ops only.
 * @returns {{ ok: boolean, bbls: string[], rows: object[], path: "warehouse"|"unavailable", ms: number }}
 */
export function lookupZapBblsFromWarehouse(projectId) {
  const started = performance.now();
  if (!catalogExists()) {
    return {
      ok: false,
      bbls: [],
      rows: [],
      path: "unavailable",
      ms: performance.now() - started,
      reason: "catalog_missing",
    };
  }
  const id = String(projectId || "").trim();
  if (!id) {
    return {
      ok: false,
      bbls: [],
      rows: [],
      path: "unavailable",
      ms: performance.now() - started,
      reason: "missing_project_id",
    };
  }
  try {
    const rows = queryWarehouse(sqlBblsByProjectId(id)).map(rowToBblShape).filter(Boolean);
    const bbls = [...new Set(rows.map((r) => r.bbl))].slice(0, 25);
    return {
      ok: true,
      bbls,
      rows,
      path: "warehouse",
      ms: performance.now() - started,
      join_key: bbls.length ? "project_id" : null,
    };
  } catch (e) {
    return {
      ok: false,
      bbls: [],
      rows: [],
      path: "unavailable",
      ms: performance.now() - started,
      reason: String(e && e.message ? e.message : e),
    };
  }
}

/**
 * Export BBL rows for a fixed list of project_ids (product seeds / demos).
 */
export function sqlBblExportByProjectIds(projectIds, table = zapBblTableName(), limit = null) {
  const ids = [...new Set((projectIds || []).map((id) => String(id || "").trim()).filter(Boolean))];
  if (!ids.length) return sqlBblExportAll(table, limit || 500);
  const inList = ids.map((id) => `'${sq(id)}'`).join(", ");
  const lim =
    limit != null && Number.isFinite(Number(limit)) && Number(limit) > 0
      ? ` LIMIT ${Math.floor(Number(limit))}`
      : "";
  return (
    `SELECT project_id, CAST(bbl AS VARCHAR) AS bbl, ` +
    `validated_borough, validated_block, validated_lot, validated, validated_date ` +
    `FROM ${table} WHERE bbl IS NOT NULL AND CAST(project_id AS VARCHAR) IN (${inList}) ` +
    `ORDER BY CAST(project_id AS VARCHAR), CAST(bbl AS VARCHAR)${lim}`
  );
}

/**
 * Export BBL rows from warehouse for materialization.
 * Default: sell-facing universe (+ demos). Pass all:true for full table (ops).
 */
export function exportZapBblRowsFromWarehouse(opts = {}) {
  if (!catalogExists()) {
    throw new Error("DuckDB catalog missing; run warehouse ingest first");
  }
  const limit = opts.limit != null ? opts.limit : null;
  if (opts.all) {
    return queryWarehouse(sqlBblExportAll(zapBblTableName(), limit))
      .map(rowToBblShape)
      .filter(Boolean);
  }
  try {
    return queryWarehouse(sqlBblExportSellFacing(zapBblTableName(), limit))
      .map(rowToBblShape)
      .filter(Boolean);
  } catch (e) {
    // zap_projects may be missing — fall back to product-seed project_ids from bulk.
    const msg = String(e && e.message ? e.message : e);
    if (!/zap_projects|Catalog Error|does not exist/i.test(msg)) throw e;
    const seedIds = [
      ...new Set(loadBblProductSeedRows().map((r) => r.project_id).filter(Boolean)),
      "2022M0258",
      "FIXZAP001",
      "FIXZAP002",
    ];
    return queryWarehouse(sqlBblExportByProjectIds(seedIds, zapBblTableName(), limit))
      .map(rowToBblShape)
      .filter(Boolean);
  }
}

/**
 * Collapse flat BBL rows into project_id → bbls[] entries for the edge index.
 */
export function groupBblRowsByProject(rows) {
  /** @type {Map<string, { project_id: string, bbls: string[], rows: object[] }>} */
  const byProject = new Map();
  for (const raw of rows || []) {
    const row = rowToBblShape(raw);
    if (!row) continue;
    let bucket = byProject.get(row.project_id);
    if (!bucket) {
      bucket = { project_id: row.project_id, bbls: [], rows: [] };
      byProject.set(row.project_id, bucket);
    }
    if (!bucket.bbls.includes(row.bbl) && bucket.bbls.length < 25) {
      bucket.bbls.push(row.bbl);
      bucket.rows.push(row);
    }
  }
  return [...byProject.values()].map((b) => ({
    project_id: b.project_id,
    bbls: b.bbls.slice().sort(),
  }));
}

/**
 * Pure index over materialized project→bbls rows (no DuckDB).
 */
export function buildZapBblLookupIndex(projectRows) {
  const list = Array.isArray(projectRows) ? projectRows : [];
  /** @type {Map<string, string[]>} */
  const byProjectId = new Map();
  for (const entry of list) {
    const id = String(entry?.project_id || "").trim();
    if (!id) continue;
    const bbls = [
      ...new Set(
        (entry.bbls || [])
          .map((b) => {
            let s = String(b || "").trim().replace(/\.0$/, "");
            if (s && /^\d+$/.test(s) && s.length < 10) s = s.padStart(10, "0");
            return /^\d{10}$/.test(s) ? s : null;
          })
          .filter(Boolean)
      ),
    ]
      .sort()
      .slice(0, 25);
    if (!byProjectId.has(id)) byProjectId.set(id, bbls);
  }
  return { byProjectId, projectCount: byProjectId.size };
}

/**
 * Lookup BBLs for one project against a pure materialization index.
 * @returns {{ hit: boolean, bbls: string[], join_key: string|null }}
 */
export function lookupZapBblsInIndex(projectId, index) {
  const id = String(projectId || "").trim();
  if (!index || !id) return { hit: false, bbls: [], join_key: null };
  if (!index.byProjectId.has(id)) return { hit: false, bbls: [], join_key: null };
  const bbls = index.byProjectId.get(id) || [];
  return { hit: true, bbls: [...bbls], join_key: "project_id" };
}

/**
 * Build the committed materialization document (project-level, not every BBL row).
 */
export function buildBblMaterializationDoc(projectRows, opts = {}) {
  const list = Array.isArray(projectRows)
    ? projectRows
        .map((e) => {
          const id = String(e?.project_id || "").trim();
          if (!id) return null;
          const bbls = [
            ...new Set(
              (e.bbls || [])
                .map((b) => {
                  let s = String(b || "").trim().replace(/\.0$/, "");
                  if (s && /^\d+$/.test(s) && s.length < 10) s = s.padStart(10, "0");
                  return /^\d{10}$/.test(s) ? s : null;
                })
                .filter(Boolean)
            ),
          ]
            .sort()
            .slice(0, 25);
          return { project_id: id, bbls };
        })
        .filter(Boolean)
    : [];
  const bbl_row_count = list.reduce((n, e) => n + e.bbls.length, 0);
  return {
    schema_version: 1,
    phase: "WH-06",
    source: "warehouse",
    dataset_id: getDataset(ZAP_BBL_DATASET_KEY).dataset_id,
    table_name: zapBblTableName(),
    mode: opts.mode || "export",
    materialized_at: opts.now || new Date().toISOString(),
    project_count: list.length,
    bbl_row_count,
    replaces_live_fetch: {
      worker: "worker/src/zap_outcomes.mjs#fetchBbls",
      soda_dataset: "2iga-a6mk",
      description:
        "ZAP BBL tax lots on /zap-outcomes DOB side-car — warehouse materialization first, live SODA on miss",
    },
    rows: list,
  };
}

/** Load product seed CSV (public field-case BBL rows) without DuckDB — offline CI. */
export function loadBblProductSeedRows() {
  return loadCsvRows(join(WAREHOUSE_DIR, "fixtures", "zap-bbl", "product_seed.csv"));
}

export function loadBblSampleRows() {
  return loadCsvRows(join(WAREHOUSE_DIR, "fixtures", "zap-bbl", "sample.csv"));
}

function loadCsvRows(path) {
  if (!existsSync(path)) return [];
  const text = readFileSync(path, "utf8");
  if (!text.trim()) return [];
  return parseCsv(text).map(rowToBblShape).filter(Boolean);
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
  node warehouse/lib/zap_bbl_lookup.mjs --project-id <id>
  node warehouse/lib/zap_bbl_lookup.mjs --export [--limit N] [--all]
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
    const flat = exportZapBblRowsFromWarehouse({ limit, all });
    const grouped = groupBblRowsByProject(flat);
    console.log(
      JSON.stringify(buildBblMaterializationDoc(grouped, { mode: "cli_export" }), null, 2)
    );
    return;
  }
  if (!projectId) {
    printHelp();
    process.exit(2);
  }
  const result = lookupZapBblsFromWarehouse(projectId);
  console.log(JSON.stringify(result, null, 2));
  if (!result.ok) process.exit(1);
}

const entry = process.argv[1] ? pathToFileURL(process.argv[1]).href : "";
if (import.meta.url === entry) {
  cli(process.argv);
}
