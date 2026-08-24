/**
 * WH-03 edge lookup over the warehouse-materialized OCP awards snapshot.
 *
 * Pure / no network. The materialization is produced by
 * `tools/build_ocp_warehouse_lookup.mjs` (DuckDB query over warehouse tables)
 * and loaded into the Worker D1 read model during deployment. The pure index
 * helpers below remain useful for offline characterization tests.
 */

// Keep limits aligned with checkbook_lifecycle fetchOcpAwardRows / warehouse lib.
const OCP_PIN_LIMIT = 10;
const OCP_REQUEST_ID_LIMIT = 5;

let _index = null;

function rowShape(row) {
  if (!row || typeof row !== "object") return null;
  return {
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
}

/**
 * Build (or return cached) dual index over the committed materialization.
 * @param {object} [doc] optional override (tests)
 */
export function getOcpWarehouseIndex(doc = { rows: [] }) {
  const rows = Array.isArray(doc?.rows) ? doc.rows : [];
  const byRequestId = new Map();
  const byPin = new Map();
  for (const raw of rows) {
    const row = rowShape(raw);
    if (!row) continue;
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
  const built = {
    byRequestId,
    byPin,
    rowCount: rows.length,
    materialized_at: doc?.materialized_at || null,
    mode: doc?.mode || null,
  };
  if (arguments.length === 0) _index = built;
  return built;
}

/** Reset memoized index (tests). */
export function resetOcpWarehouseIndexCache() {
  _index = null;
}

/** Query the bounded D1 OCP table by its two publisher join keys. */
export async function lookupOcpFromD1(db, noticeRow = {}) {
  if (!db) return { status: "unavailable", hit: false, rows: [], join_key: null, path: null };
  const requestId = noticeRow?.request_id ? String(noticeRow.request_id) : null;
  const pin = noticeRow?.pin ? String(noticeRow.pin).trim() : null;
  if (!requestId && !pin) return { status: "ok", hit: true, rows: [], join_key: null, path: "d1" };
  try {
    let rows = [];
    let joinKey = null;
    if (requestId) {
      const result = await db.prepare(
        "SELECT request_id, start_date, agency_name, type_of_notice_description, short_title, pin, contract_amount, vendor_name FROM ocp_awards_warehouse WHERE request_id = ? ORDER BY start_date DESC LIMIT 5",
      ).bind(requestId).all();
      rows = (result?.results || []).map(rowShape);
      if (rows.length) joinKey = "request_id";
    }
    if (!rows.length && pin) {
      const result = await db.prepare(
        "SELECT request_id, start_date, agency_name, type_of_notice_description, short_title, pin, contract_amount, vendor_name FROM ocp_awards_warehouse WHERE pin = ? OR pin = ? OR pin = ? ORDER BY start_date DESC LIMIT 10",
      ).bind(pin, pin.toLowerCase(), pin.toUpperCase()).all();
      rows = (result?.results || []).map(rowShape);
      if (rows.length) joinKey = "pin";
    }
    return { status: "ok", hit: true, rows, join_key: joinKey, path: "d1" };
  } catch (error) {
    return { status: "unavailable", hit: false, rows: [], join_key: null, path: null, error };
  }
}

/** Bounded OCP keyword candidates for the universal search route. */
export async function searchOcpFromD1(db, query, { limit = 40 } = {}) {
  if (!db) throw new Error("OCP read model unavailable");
  const value = String(query || "").trim();
  if (!value) return { status: "ok", rows: [] };
  const max = Math.max(1, Math.min(160, Number(limit) || 40));
  const like = `%${value.replaceAll("%", "\\%").replaceAll("_", "\\_")}%`;
  const result = await db.prepare(`
    SELECT request_id, start_date, agency_name, type_of_notice_description, short_title, pin, contract_amount, vendor_name
    FROM ocp_awards_warehouse
    WHERE request_id = ? OR pin = ? OR short_title LIKE ? ESCAPE '\\' OR vendor_name LIKE ? ESCAPE '\\' OR agency_name LIKE ? ESCAPE '\\'
    ORDER BY start_date DESC, request_id ASC
    LIMIT ?
  `).bind(value, value, like, like, like, max).all();
  return { status: "ok", rows: (result?.results || []).map(rowShape) };
}

/**
 * Instant warehouse-materialization lookup for one notice.
 * @returns {{ hit: boolean, rows: object[], join_key: string|null, path: "warehouse"|null }}
 */
export function lookupOcpFromWarehouseMaterialization(noticeRow, doc) {
  const index = getOcpWarehouseIndex(doc);
  const r = noticeRow || {};

  if (!r.request_id && !r.pin) {
    // No key → nothing to look up; treat as empty success (matches SODA path).
    return { hit: true, rows: [], join_key: null, path: "warehouse" };
  }

  if (r.request_id) {
    const rows = index.byRequestId.get(String(r.request_id)) || [];
    if (rows.length) {
      return {
        hit: true,
        rows: rows.slice(),
        join_key: "request_id",
        path: "warehouse",
      };
    }
  }
  if (r.pin) {
    const rows = index.byPin.get(String(r.pin).trim()) || [];
    if (rows.length) {
      return {
        hit: true,
        rows: rows.slice(),
        join_key: "pin",
        path: "warehouse",
      };
    }
  }
  return { hit: false, rows: [], join_key: null, path: null };
}

export function warehouseMaterializationMeta(doc = { rows: [] }) {
  return {
    schema_version: doc?.schema_version ?? null,
    row_count: Array.isArray(doc?.rows) ? doc.rows.length : 0,
    materialized_at: doc?.materialized_at || null,
    mode: doc?.mode || null,
    dataset_id: doc?.dataset_id || null,
  };
}
