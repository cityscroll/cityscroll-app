/**
 * WH-05 edge lookup over warehouse-materialized Doing Business entities.
 *
 * Pure / no network. Built by tools/build_doing_business_warehouse_lookup.mjs.
 * Vendor-profile cron uses this index before multi-page live SODA.
 */

import materialization from "../data/doing_business_warehouse_lookup.json" with {
  type: "json",
};
import {
  buildDoingBusinessIndex,
  joinVendorToDoingBusiness,
  doingBusinessProfilePayload,
} from "./doing_business_join.mjs";

let _index = null;
let _meta = null;

/**
 * @param {object} [doc] optional override (tests)
 * @returns {Map<string, object>} stem → normalized entity
 */
export function getDoingBusinessWarehouseIndex(doc = materialization) {
  if (_index && doc === materialization) return _index;
  const rows = Array.isArray(doc?.rows) ? doc.rows : [];
  const built = buildDoingBusinessIndex(rows);
  if (doc === materialization) _index = built;
  return built;
}

export function resetDoingBusinessWarehouseIndexCache() {
  _index = null;
  _meta = null;
}

export function warehouseMaterializationMeta(doc = materialization) {
  if (_meta && doc === materialization) return _meta;
  const meta = {
    schema_version: doc?.schema_version ?? null,
    row_count: Array.isArray(doc?.rows) ? doc.rows.length : 0,
    mode: doc?.mode || null,
    materialized_at: doc?.materialized_at || null,
    phase: doc?.phase || null,
  };
  if (doc === materialization) _meta = meta;
  return meta;
}

/**
 * True when the committed materialization has at least one usable entity.
 * Empty materialization means "fall through to live SODA."
 */
export function doingBusinessWarehouseReady(doc = materialization) {
  return warehouseMaterializationMeta(doc).row_count > 0;
}

/**
 * Join one vendor display/stem against the warehouse materialization index.
 * @returns {{ hit: boolean, payload: object|null, path: "warehouse"|null }}
 */
export function lookupDoingBusinessFromWarehouse(vendorName, doc = materialization) {
  if (!doingBusinessWarehouseReady(doc)) {
    return { hit: false, payload: null, path: null };
  }
  const index = getDoingBusinessWarehouseIndex(doc);
  const match = joinVendorToDoingBusiness(vendorName, index);
  if (!match) return { hit: false, payload: null, path: null };
  return {
    hit: true,
    payload: doingBusinessProfilePayload(match),
    path: "warehouse",
    method: match.method,
  };
}

/**
 * Attach Doing Business payloads to vendor profiles from warehouse only.
 * Does not network. Caller falls back to live SODA when ready=false.
 *
 * @returns {{
 *   used: boolean,
 *   path: "warehouse"|null,
 *   requests: number,
 *   rows: number,
 *   matched: number,
 *   indexSize: number,
 * }}
 */
export function attachDoingBusinessFromWarehouse(profiles, doc = materialization) {
  if (!doingBusinessWarehouseReady(doc)) {
    return {
      used: false,
      path: null,
      requests: 0,
      rows: 0,
      matched: 0,
      indexSize: 0,
    };
  }
  const index = getDoingBusinessWarehouseIndex(doc);
  let matched = 0;
  for (const profile of Object.values(profiles || {})) {
    profile.doingBusiness = null;
    let best =
      joinVendorToDoingBusiness(profile.display || profile.stem, index) ||
      joinVendorToDoingBusiness(profile.stem, index);
    for (const variant of profile.variants || []) {
      const vHit = joinVendorToDoingBusiness(variant.name, index);
      if (vHit) {
        best = vHit;
        break;
      }
    }
    if (!best) continue;
    profile.doingBusiness = doingBusinessProfilePayload(best);
    matched++;
  }
  return {
    used: true,
    path: "warehouse",
    requests: 0,
    rows: warehouseMaterializationMeta(doc).row_count,
    matched,
    indexSize: index.size,
  };
}
