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

/** Publisher census for SODA 72mk-a8z7 (scout 2026-08-17: 10 787). */
export const DOING_BUSINESS_PUBLISHER_ROW_COUNT = 10787;
/** Absolute drift allowed vs publisher after org-name dedupe (±). */
export const DOING_BUSINESS_ROW_COUNT_DRIFT_ABS = 250;
/** Refuse empty / fixture-sized snapshots that would re-open live SODA. */
export const DOING_BUSINESS_MIN_ROW_COUNT = 10000;
/** Serve lookup must be republished within this window (refresh→publish loop). */
export const DOING_BUSINESS_MAX_AGE_DAYS = 180;
/** Exact organization_name canaries that must remain in the committed serve. */
export const DOING_BUSINESS_CANARIES = Object.freeze(["CAMBA  INC"]);
export const DOING_BUSINESS_FULL_CATALOG_MODES = Object.freeze([
  "bulk_warehouse",
  "bulk_soda",
]);

/**
 * Age/row-count/canary drift gate for the committed WH-05 serve lookup.
 * Keeps the refresh→publish loop from re-freezing on an empty live_fallback.
 *
 * @param {object} doc committed or freshly built materialization
 * @param {{ now?: Date|string|number, publisherRowCount?: number }} [opts]
 * @returns {string[]} finding messages (empty ⇒ pass)
 */
export function doingBusinessServeGateFindings(doc, opts = {}) {
  const findings = [];
  const rows = Array.isArray(doc?.rows) ? doc.rows : [];
  const rowCount =
    Number.isFinite(Number(doc?.row_count)) ? Number(doc.row_count) : rows.length;
  const publisher = Number.isFinite(Number(opts.publisherRowCount))
    ? Number(opts.publisherRowCount)
    : DOING_BUSINESS_PUBLISHER_ROW_COUNT;
  const mode = String(doc?.mode || "");

  if (mode === "live_fallback" || rowCount === 0) {
    findings.push(
      `Doing Business serve is empty/live_fallback (row_count=${rowCount}); rebuild via WH-02 bulk or --from-soda`,
    );
  }
  if (rowCount < DOING_BUSINESS_MIN_ROW_COUNT) {
    findings.push(
      `Doing Business serve row_count ${rowCount} below floor ${DOING_BUSINESS_MIN_ROW_COUNT}`,
    );
  }
  const drift = Math.abs(rowCount - publisher);
  if (drift > DOING_BUSINESS_ROW_COUNT_DRIFT_ABS) {
    findings.push(
      `Doing Business serve row_count ${rowCount} drifts ${drift} from publisher ${publisher} (max ${DOING_BUSINESS_ROW_COUNT_DRIFT_ABS})`,
    );
  }
  if (!DOING_BUSINESS_FULL_CATALOG_MODES.includes(mode) && rowCount >= DOING_BUSINESS_MIN_ROW_COUNT) {
    findings.push(
      `Doing Business serve mode ${JSON.stringify(mode)} is not a full-catalog mode (${DOING_BUSINESS_FULL_CATALOG_MODES.join("|")})`,
    );
  }

  const names = new Set(
    rows.map((r) => String(r?.organization_name || "").trim()).filter(Boolean),
  );
  for (const canary of DOING_BUSINESS_CANARIES) {
    if (!names.has(canary)) {
      findings.push(`Doing Business serve missing canary organization_name ${JSON.stringify(canary)}`);
    }
  }

  const stamped = doc?.materialized_at ? Date.parse(String(doc.materialized_at)) : NaN;
  const nowMs = Date.parse(String(opts.now || new Date().toISOString()));
  if (!Number.isFinite(stamped)) {
    findings.push("Doing Business serve missing materialized_at");
  } else if (Number.isFinite(nowMs)) {
    const ageDays = (nowMs - stamped) / 86_400_000;
    if (ageDays > DOING_BUSINESS_MAX_AGE_DAYS) {
      findings.push(
        `Doing Business serve age ${ageDays.toFixed(1)}d exceeds max ${DOING_BUSINESS_MAX_AGE_DAYS}d — refresh and republish`,
      );
    }
    if (ageDays < -1) {
      findings.push("Doing Business serve materialized_at is in the future");
    }
  }
  return findings;
}

export function assertDoingBusinessServeGate(doc, opts = {}) {
  const findings = doingBusinessServeGateFindings(doc, opts);
  if (findings.length) {
    throw new Error(findings.join("; "));
  }
  return true;
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
    publisher_row_count: opts.publisherRowCount ?? DOING_BUSINESS_PUBLISHER_ROW_COUNT,
    replaces_live_fetch: {
      worker: "worker/src/vendor_profile.mjs#attachDoingBusiness",
      soda_dataset: "72mk-a8z7",
      description:
        "Doing Business Search Entities attach on daily vendor-profile refresh — committed full-catalog materialization first (no resident multi-page SODA); live SODA only when the serve lookup is empty or partial",
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
