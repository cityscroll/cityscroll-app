/**
 * WH-06 edge lookup over the warehouse-materialized ZAP BBL snapshot.
 *
 * Pure / no network. The materialization is produced by
 * `tools/build_zap_bbl_warehouse_lookup.mjs` (DuckDB query over warehouse tables)
 * and committed as JSON imported here. Live SODA remains the miss fallback in
 * `fetchBbls`.
 */

import materialization from "../data/zap_bbl_warehouse_lookup.json" with { type: "json" };

let _index = null;

function normalizeBbl(value) {
  let s = String(value ?? "").trim().replace(/\.0$/, "");
  if (s && /^\d+$/.test(s) && s.length < 10) s = s.padStart(10, "0");
  return /^\d{10}$/.test(s) ? s : null;
}

/**
 * Build (or return cached) project_id → bbls index over the committed materialization.
 * @param {object} [doc] optional override (tests)
 */
export function getZapBblWarehouseIndex(doc = materialization) {
  if (_index && doc === materialization) return _index;
  const rows = Array.isArray(doc?.rows) ? doc.rows : [];
  const byProjectId = new Map();
  for (const entry of rows) {
    const id = String(entry?.project_id || "").trim();
    if (!id) continue;
    const bbls = [
      ...new Set((entry.bbls || []).map(normalizeBbl).filter(Boolean)),
    ]
      .sort()
      .slice(0, 25);
    if (!byProjectId.has(id)) byProjectId.set(id, bbls);
  }
  const built = {
    byProjectId,
    projectCount: byProjectId.size,
    materialized_at: doc?.materialized_at || null,
    mode: doc?.mode || null,
  };
  if (doc === materialization) _index = built;
  return built;
}

/** Reset memoized index (tests). */
export function resetZapBblWarehouseIndexCache() {
  _index = null;
}

/**
 * Instant warehouse-materialization lookup for one project_id.
 * @returns {{ hit: boolean, bbls: string[], join_key: string|null, path: "warehouse"|null }}
 */
export function lookupZapBblsFromWarehouseMaterialization(projectId, doc) {
  const index = getZapBblWarehouseIndex(doc);
  const id = String(projectId || "").trim();
  if (!id) {
    return { hit: false, bbls: [], join_key: null, path: null };
  }
  if (!index.byProjectId.has(id)) {
    return { hit: false, bbls: [], join_key: null, path: null };
  }
  const bbls = index.byProjectId.get(id) || [];
  return {
    hit: true,
    bbls: [...bbls],
    join_key: "project_id",
    path: "warehouse",
  };
}

export function warehouseZapBblMaterializationMeta(doc = materialization) {
  return {
    schema_version: doc?.schema_version ?? null,
    project_count: Array.isArray(doc?.rows) ? doc.rows.length : 0,
    bbl_row_count: doc?.bbl_row_count ?? null,
    materialized_at: doc?.materialized_at || null,
    mode: doc?.mode || null,
    dataset_id: doc?.dataset_id || null,
    phase: doc?.phase || null,
  };
}
