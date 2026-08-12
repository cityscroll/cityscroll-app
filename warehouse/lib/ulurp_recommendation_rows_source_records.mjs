// Host retention and dated gate for the existing ULURP recommendation feed.

import {
  normalizeUlurpRecommendationRow,
  ulurpRecommendationSourceSystemId,
  ULURP_RECOMMENDATION_SOURCE_SYSTEM,
} from "../../worker/src/lib/ulurp_recommendation_rows_source_records.mjs";

export const USEFULNESS_FLOOR = 0.3;
export const PRECISION_FLOOR = 0.95;

export function retainUlurpRecommendationRows(inputRows) {
  const rows = [];
  const seen = new Set();
  const blocked = { missing_identity: 0, duplicate_source_ids: 0 };
  for (const row of Array.isArray(inputRows) ? inputRows : []) {
    const normalized = normalizeUlurpRecommendationRow(row);
    const id = normalized && ulurpRecommendationSourceSystemId(normalized);
    if (!normalized || !id) {
      blocked.missing_identity += 1;
      continue;
    }
    if (seen.has(id)) {
      blocked.duplicate_source_ids += 1;
      continue;
    }
    seen.add(id);
    rows.push(normalized);
  }
  return { rows, blocked, counts: { input_rows: Array.isArray(inputRows) ? inputRows.length : 0, retained: rows.length } };
}

export function rowToSourceRecord(row, ingestedAt) {
  const { source_system, source_system_id, ...payload } = row;
  return {
    source_system: source_system || ULURP_RECOMMENDATION_SOURCE_SYSTEM,
    source_system_id: source_system_id || null,
    payload_json: payload,
    normalized_json: payload,
    ingested_at: ingestedAt || null,
  };
}

export function measureUlurpRecommendationJoin(retainedRows, priorMeasurement = null) {
  const rows = Array.isArray(retainedRows) ? retainedRows : [];
  const prior = priorMeasurement?.rates?.recommendation_rows_hit_zap;
  const usefulness = prior || { joined: 0, total: rows.length, rate: 0 };
  const precision = Number(priorMeasurement?.precision || 0);
  const gates = {
    usefulness_floor: USEFULNESS_FLOOR,
    precision_floor: PRECISION_FLOOR,
    usefulness_cleared: usefulness.rate >= USEFULNESS_FLOOR,
    precision_cleared: precision >= PRECISION_FLOOR,
  };
  gates.materialize = gates.usefulness_cleared && gates.precision_cleared;
  return {
    source: "4j6i-9rmr",
    usefulness: {
      ...usefulness,
      denominator: "full publisher recommendation catalog rows (dated receipt)",
      numerator: "rows whose ULURP number has an exact token in the ZAP corpus",
    },
    precision: {
      rate: precision,
      true_positives: null,
      false_positives: null,
      attempts: null,
      basis: "dated full-corpus receipt; exact_ulurp_token review",
    },
    provenance: "site/data/ulurp_recommendation_sources/verification_receipts/ulurp_recommendations_2026-08-11.json",
    gates,
  };
}

export function retainAndMeasureUlurpRecommendations({ rows, ingestedAt, priorMeasurement }) {
  const retained = retainUlurpRecommendationRows(rows);
  const measurement = measureUlurpRecommendationJoin(retained.rows, priorMeasurement);
  return {
    ...retained,
    measurement,
    source_records: retained.rows.map((row) => rowToSourceRecord(row, ingestedAt)),
    counts: { ...retained.counts, source_records: retained.rows.length, joined: measurement.usefulness.joined },
  };
}
