/**
 * Bounded shared read model for observation-fed procurement objects.
 *
 * Object identity and lifecycle detail are materialized independently of
 * source health. A source failure changes only its coverage envelope; retained
 * observations continue to resolve to the same canonical objects.
 */

import {
  PROCUREMENT_SOURCE_SYSTEMS,
  buildProcurementObjects,
} from "./procurement_object_contract.mjs";

export const SHARED_PROCUREMENT_READ_MODEL_SCHEMA = "cityscroll.shared_procurement_read_model.v1";
export const SHARED_PROCUREMENT_READ_MODEL_VERSION = 1;

const SOURCE_STATUSES = new Set(["available", "stale", "unavailable", "partial"]);

function text(value) {
  const result = String(value ?? "").trim();
  return result || null;
}

function normalizedSourceStatus(value) {
  const status = text(typeof value === "object" ? value?.status : value)?.toLowerCase();
  return SOURCE_STATUSES.has(status) ? status : "available";
}

function sourceEnvelope(source, records, override, generatedAt) {
  const rows = records.filter((record) => String(record?.source_system || "").toLowerCase() === source);
  const status = normalizedSourceStatus(override);
  return {
    source_system: source,
    status,
    available: status === "available",
    generated_at: text(typeof override === "object" ? override?.generated_at : null) || generatedAt || null,
    row_count: rows.length,
    reason: text(typeof override === "object" ? override?.reason : null),
  };
}

/** Build one source-enveloped aggregate read model without fetching fallbacks. */
export function buildSharedProcurementReadModel({
  sourceRecords = [],
  lifecycleRows = [],
  sourceStatus = {},
  generatedAt = null,
  now = generatedAt || new Date().toISOString(),
} = {}) {
  const records = Array.isArray(sourceRecords) ? sourceRecords.filter(Boolean) : [];
  const built = buildProcurementObjects({ sourceRecords: records, lifecycleRows });
  const sources = Object.fromEntries(PROCUREMENT_SOURCE_SYSTEMS.map((source) => [
    source,
    sourceEnvelope(source, records, sourceStatus?.[source], generatedAt),
  ]));
  const rows = built.objects;
  return {
    schema: SHARED_PROCUREMENT_READ_MODEL_SCHEMA,
    version: SHARED_PROCUREMENT_READ_MODEL_VERSION,
    generated_at: generatedAt,
    freshness: {
      generated_at: generatedAt,
      checked_at: now,
      sources: Object.fromEntries(Object.entries(sources).map(([source, envelope]) => [source, envelope.status])),
    },
    sources,
    identity_gate: built.identity_gate,
    identity_edges: built.identity_edges,
    cross_source_identity_joins: built.cross_source_identity_joins,
    counts: {
      total: rows.length,
      source_observations: records.length,
      identity_edges: built.identity_edges.length,
      cross_source_identity_joins: built.cross_source_identity_joins.length,
      lifecycle_rows: Array.isArray(lifecycleRows) ? lifecycleRows.length : 0,
    },
    rows,
  };
}

export function procurementReadModelRows(value) {
  return Array.isArray(value?.rows) ? value.rows : [];
}

export function procurementReadModelSourceStatus(value, source) {
  return value?.sources?.[source]?.status || "unavailable";
}
