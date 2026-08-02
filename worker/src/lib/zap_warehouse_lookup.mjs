/**
 * WH-05 edge lookup over the warehouse-materialized ZAP projects snapshot.
 *
 * Pure / no network. The materialization is produced by
 * `tools/build_zap_warehouse_lookup.mjs` (DuckDB query over warehouse tables)
 * and committed as JSON imported here. Live SODA remains the miss fallback in
 * `fetchOpenDataRow`.
 */

import materialization from "../data/zap_projects_warehouse_lookup.json" with { type: "json" };

let _index = null;

/** Columns aligned with fetchOpenDataRow SODA select. */
const ZAP_OPEN_DATA_COLS = [
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

function rowShape(row) {
  if (!row || typeof row !== "object") return null;
  const out = {};
  for (const col of ZAP_OPEN_DATA_COLS) {
    const v = row[col];
    out[col] = v == null || v === "" ? null : String(v);
  }
  // Keep optional extras when present (ulurp_non, primary_applicant, …).
  for (const [k, v] of Object.entries(row)) {
    if (out[k] !== undefined) continue;
    if (v == null || v === "") continue;
    out[k] = typeof v === "boolean" ? (v ? "true" : "false") : String(v);
  }
  if (!out.project_id) return null;
  out.project_id = String(out.project_id).trim();
  return out;
}

/**
 * Build (or return cached) project_id index over the committed materialization.
 * @param {object} [doc] optional override (tests)
 */
export function getZapWarehouseIndex(doc = materialization) {
  if (_index && doc === materialization) return _index;
  const rows = Array.isArray(doc?.rows) ? doc.rows : [];
  const byProjectId = new Map();
  for (const raw of rows) {
    const row = rowShape(raw);
    if (!row) continue;
    const k = row.project_id;
    if (!byProjectId.has(k)) byProjectId.set(k, row);
  }
  const built = {
    byProjectId,
    rowCount: rows.length,
    materialized_at: doc?.materialized_at || null,
    mode: doc?.mode || null,
  };
  if (doc === materialization) _index = built;
  return built;
}

/** Reset memoized index (tests). */
export function resetZapWarehouseIndexCache() {
  _index = null;
}

/**
 * Instant warehouse-materialization lookup for one project_id.
 * @returns {{ hit: boolean, row: object|null, join_key: string|null, path: "warehouse"|null }}
 */
export function lookupZapFromWarehouseMaterialization(projectId, doc) {
  const index = getZapWarehouseIndex(doc);
  const id = String(projectId || "").trim();
  if (!id) {
    return { hit: false, row: null, join_key: null, path: null };
  }
  const row = index.byProjectId.get(id) || null;
  if (row) {
    return {
      hit: true,
      row: { ...row },
      join_key: "project_id",
      path: "warehouse",
    };
  }
  return { hit: false, row: null, join_key: null, path: null };
}

export function warehouseZapMaterializationMeta(doc = materialization) {
  return {
    schema_version: doc?.schema_version ?? null,
    row_count: Array.isArray(doc?.rows) ? doc.rows.length : 0,
    materialized_at: doc?.materialized_at || null,
    mode: doc?.mode || null,
    dataset_id: doc?.dataset_id || null,
    phase: doc?.phase || null,
  };
}
