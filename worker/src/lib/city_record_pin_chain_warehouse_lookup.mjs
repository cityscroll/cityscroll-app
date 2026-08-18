/**
 * WH-07 edge lookup over the warehouse-materialized City Record PIN-chain snapshot.
 *
 * Pure / no network. The materialization is produced by
 * `tools/build_city_record_pin_chain_lookup.mjs` (DuckDB query over WH-07
 * city_record, or verified seed offline) and committed as JSON imported here.
 * Live SODA remains the miss fallback in fetchRelatedProcurementNotices after D1.
 */

import materialization from "../data/city_record_pin_chain_warehouse_lookup.json" with {
  type: "json",
};

const PER_PIN_LIMIT = 25;

let _index = null;

function rowShape(row) {
  if (!row || typeof row !== "object") return null;
  const pin = row.pin != null ? String(row.pin).trim() : "";
  if (!pin) return null;
  return {
    request_id: row.request_id != null ? String(row.request_id) : null,
    start_date: row.start_date != null ? String(row.start_date) : null,
    agency_name: row.agency_name != null ? String(row.agency_name) : null,
    type_of_notice_description:
      row.type_of_notice_description != null
        ? String(row.type_of_notice_description)
        : null,
    short_title: row.short_title != null ? String(row.short_title) : null,
    pin,
    contract_amount:
      row.contract_amount != null && row.contract_amount !== ""
        ? String(row.contract_amount)
        : null,
    vendor_name: row.vendor_name != null ? String(row.vendor_name) : null,
  };
}

/**
 * Build (or return cached) PIN index over the committed materialization.
 * @param {object} [doc] optional override (tests)
 */
export function getCityRecordPinChainWarehouseIndex(doc = materialization) {
  if (_index && doc === materialization) return _index;
  const rows = Array.isArray(doc?.rows) ? doc.rows : [];
  const byPin = new Map();
  for (const raw of rows) {
    const row = rowShape(raw);
    if (!row) continue;
    const k = row.pin;
    if (!byPin.has(k)) byPin.set(k, []);
    const bucket = byPin.get(k);
    if (bucket.length < PER_PIN_LIMIT) bucket.push(row);
  }
  for (const bucket of byPin.values()) {
    bucket.sort(
      (a, b) =>
        String(a.start_date || "").localeCompare(String(b.start_date || "")) ||
        String(a.request_id || "").localeCompare(String(b.request_id || "")),
    );
  }
  const built = {
    byPin,
    rowCount: rows.length,
    pinCount: byPin.size,
    materialized_at: doc?.materialized_at || null,
    mode: doc?.mode || null,
  };
  if (doc === materialization) _index = built;
  return built;
}

/** Reset memoized index (tests). */
export function resetCityRecordPinChainWarehouseIndexCache() {
  _index = null;
}

/**
 * Instant warehouse-materialization lookup for one PIN.
 * @returns {{ hit: boolean, rows: object[], join_key: string|null, path: "warehouse"|null }}
 */
export function lookupPinChainFromWarehouseMaterialization(pin, doc) {
  const index = getCityRecordPinChainWarehouseIndex(doc);
  const key = String(pin || "").trim();
  if (!key) {
    return { hit: false, rows: [], join_key: null, path: null };
  }
  const rows = index.byPin.get(key) || [];
  if (!rows.length) {
    return { hit: false, rows: [], join_key: null, path: null };
  }
  return {
    hit: true,
    rows: rows.slice(),
    join_key: "pin",
    path: "warehouse",
  };
}

export function warehousePinChainMaterializationMeta(doc = materialization) {
  return {
    schema_version: doc?.schema_version ?? null,
    row_count: Array.isArray(doc?.rows) ? doc.rows.length : doc?.row_count ?? 0,
    pin_count: doc?.pin_count ?? null,
    materialized_at: doc?.materialized_at ?? null,
    mode: doc?.mode ?? null,
    coverage: doc?.coverage ?? null,
  };
}
