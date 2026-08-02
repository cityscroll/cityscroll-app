/**
 * WH-05 edge lookup over warehouse-materialized ZAP projects (Open Data).
 *
 * Pure / no network. Built by tools/build_zap_projects_warehouse_lookup.mjs.
 * fetchOpenDataRow consults this before live SODA hgx4-8ukb.
 */

import materialization from "../data/zap_projects_warehouse_lookup.json" with {
  type: "json",
};

let _index = null;

function rowShape(row) {
  if (!row || typeof row !== "object") return null;
  const project_id = row.project_id != null ? String(row.project_id).trim() : "";
  if (!project_id) return null;
  const out = { project_id };
  for (const [k, v] of Object.entries(row)) {
    if (k === "project_id") continue;
    out[k] = v != null && v !== "" ? String(v) : null;
  }
  return out;
}

/**
 * @param {object} [doc]
 * @returns {{ byProjectId: Map<string, object>, rowCount: number, materialized_at: string|null, mode: string|null }}
 */
export function getZapProjectsWarehouseIndex(doc = materialization) {
  if (_index && doc === materialization) return _index;
  const rows = Array.isArray(doc?.rows) ? doc.rows : [];
  const byProjectId = new Map();
  for (const raw of rows) {
    const row = rowShape(raw);
    if (!row) continue;
    if (!byProjectId.has(row.project_id)) byProjectId.set(row.project_id, row);
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

export function resetZapProjectsWarehouseIndexCache() {
  _index = null;
}

export function warehouseMaterializationMeta(doc = materialization) {
  return {
    schema_version: doc?.schema_version ?? null,
    row_count: Array.isArray(doc?.rows) ? doc.rows.length : 0,
    mode: doc?.mode || null,
    materialized_at: doc?.materialized_at || null,
    phase: doc?.phase || null,
  };
}

/**
 * Instant warehouse-materialization lookup for one project_id.
 * @returns {{ hit: boolean, row: object|null, path: "warehouse"|null }}
 */
export function lookupZapProjectFromWarehouseMaterialization(projectId, doc) {
  const index = getZapProjectsWarehouseIndex(doc);
  const id = String(projectId || "").trim();
  if (!id) {
    return { hit: true, row: null, path: "warehouse" };
  }
  const row = index.byProjectId.get(id) || null;
  if (row) return { hit: true, row: { ...row }, path: "warehouse" };
  return { hit: false, row: null, path: null };
}
