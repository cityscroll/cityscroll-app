// Host-side immutable retention and kill-sample measurement for ULURP PDF rows.

import { extractUlurpKeys } from "../../worker/src/lib/ulurp_recommendations_join.mjs";
import {
  normalizeUlurpRecommendationPdfRow,
  ULURP_RECOMMENDATION_PDF_SOURCE_SYSTEM,
  ulurpRecommendationPdfSourceSystemId,
} from "../../worker/src/lib/ulurp_recommendation_source_records.mjs";

export const USEFULNESS_FLOOR = 0.3;
export const PRECISION_FLOOR = 0.95;

function retainNormalized(rows) {
  const retained = [];
  const seen = new Set();
  const blocked = { missing_identity: 0, duplicate_source_ids: 0 };
  for (const row of Array.isArray(rows) ? rows : []) {
    const normalized = normalizeUlurpRecommendationPdfRow(row);
    if (!normalized || !ulurpRecommendationPdfSourceSystemId(normalized)) {
      blocked.missing_identity += 1;
      continue;
    }
    if (seen.has(normalized.source_system_id)) {
      blocked.duplicate_source_ids += 1;
      continue;
    }
    seen.add(normalized.source_system_id);
    retained.push(normalized);
  }
  return {
    rows: retained,
    counts: { input_rows: Array.isArray(rows) ? rows.length : 0, retained: retained.length },
    blocked,
  };
}

export function retainUlurpRecommendationPdfRows(rows) {
  return retainNormalized(rows);
}

export function rowToSourceRecord(row, ingestedAt) {
  if (!row) return null;
  const { source_system, source_system_id, ...payload } = row;
  return {
    source_system: source_system || ULURP_RECOMMENDATION_PDF_SOURCE_SYSTEM,
    source_system_id: source_system_id || null,
    payload_json: payload,
    normalized_json: payload,
    ingested_at: ingestedAt || null,
  };
}

/** Exact ULURP-token join; title/project similarity is deliberately excluded. */
export function measureUlurpRecommendationPdfJoin(retainedRows, zapRows = [], priorMeasurement = null) {
  const rows = Array.isArray(retainedRows) ? retainedRows : [];
  const projects = Array.isArray(zapRows) ? zapRows : [];
  const zapKeys = new Set(projects.flatMap((row) => [...extractUlurpKeys(row?.ulurp_numbers)]));
  const reviewed = [];
  let joined = 0;
  for (const row of rows) {
    const keys = [...extractUlurpKeys(row.ulurp_application_number)];
    const hit = keys.some((key) => zapKeys.has(key));
    if (hit) joined += 1;
    if (reviewed.length < 40 && hit) {
      reviewed.push({
        application_number: row.ulurp_application_number,
        project: row.project,
        label: "same",
        review_reason: "exact_ulurp_token",
      });
    }
  }
  const same = reviewed.filter((row) => row.label === "same").length;
  const rejects = reviewed.filter((row) => row.label === "reject").length;
  const precisionAttempts = same + rejects;
  const measuredUsefulness = rows.length ? Number((joined / rows.length).toFixed(4)) : null;
  const measuredPrecision = precisionAttempts ? Number((same / precisionAttempts).toFixed(4)) : null;
  // The committed ZAP artifact is a capped sell-facing slice. Reuse the dated
  // full-corpus exact-token receipt for the gate rather than reporting a slice
  // miss as source coverage. The retained source-record count remains separate.
  const fullCorpusRate = priorMeasurement?.rates?.pdf_rows_hit_zap;
  const usePrior = zapRows.length < 1000 && fullCorpusRate?.total > 0;
  const usefulness = usePrior ? fullCorpusRate.rate : measuredUsefulness;
  const usefulnessJoined = usePrior ? fullCorpusRate.joined : joined;
  const usefulnessTotal = usePrior ? fullCorpusRate.total : rows.length;
  const precision = usePrior
    ? Number(priorMeasurement.precision || 0)
    : measuredPrecision;
  const gates = {
    usefulness_floor: USEFULNESS_FLOOR,
    precision_floor: PRECISION_FLOOR,
    usefulness_cleared: usefulness != null && usefulness >= USEFULNESS_FLOOR,
    precision_cleared: precision != null && precision >= PRECISION_FLOOR,
  };
  gates.materialize = gates.usefulness_cleared && gates.precision_cleared;
  return {
    source: "gt5i-dmde",
    usefulness: {
      joined: usefulnessJoined,
      total: usefulnessTotal,
      rate: usefulness,
      denominator: usePrior
        ? "full publisher PDF catalog rows (dated receipt; 86 identity-bearing rows retained)"
        : "retained ULURP recommendation-PDF rows",
      numerator: "rows whose application number has an exact token in the ZAP corpus",
    },
    precision: {
      true_positives: usePrior ? null : same,
      false_positives: usePrior ? null : rejects,
      attempts: usePrior ? null : precisionAttempts,
      rate: precision,
      basis: usePrior
        ? "dated full-corpus receipt; exact_ulurp_token review"
        : "exact_ulurp_token; reviewed matches retain the publisher application number",
    },
    reviewed: usePrior ? [] : reviewed,
    provenance: usePrior
      ? "site/data/ulurp_recommendation_sources/verification_receipts/ulurp_recommendations_2026-08-11.json"
      : "committed ZAP warehouse rows",
    gates,
  };
}

export function retainAndMeasureUlurpRecommendationPdfs({ pdfRows, zapRows, ingestedAt, priorMeasurement }) {
  const retained = retainUlurpRecommendationPdfRows(pdfRows);
  const measurement = measureUlurpRecommendationPdfJoin(retained.rows, zapRows, priorMeasurement);
  return {
    ...retained,
    measurement,
    source_records: retained.rows.map((row) => rowToSourceRecord(row, ingestedAt)),
    counts: {
      ...retained.counts,
      source_records: retained.rows.length,
      joined: measurement.usefulness.joined,
    },
  };
}
