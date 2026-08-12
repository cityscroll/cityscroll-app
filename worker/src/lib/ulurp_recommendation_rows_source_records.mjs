// Shadow-only immutable observations for the existing Borough President
// recommendation feed. Public Land delivery remains on its current lookup.

import {
  computeSourceRecordHash,
  SOURCE_RECORD_INSERT_SQL,
  sourceRecordDualWriteEnabled,
} from "./source_records.mjs";

export const ULURP_RECOMMENDATION_SOURCE_SYSTEM = "ulurp_recommendations";
export const ULURP_RECOMMENDATION_SOURCE_RECORD_DUAL_WRITE_FLAG =
  "ULURP_RECOMMENDATION_SOURCE_RECORD_DUAL_WRITE";
export const ULURP_RECOMMENDATION_SOURCE_RECORD_BATCH = 40;

const text = (value) => String(value ?? "").replace(/\s+/g, " ").trim();
const part = (value, fallback) => text(value) || fallback;

export function ulurpRecommendationSourceSystemId(row) {
  if (!row || !text(row.ulurp_number_s)) return null;
  return `ulurp-recommendation:${text(row.ulurp_number_s)}:${part(row.recommendation_date, "no-date")}:${part(row.borough_president, "no-borough-president")}`;
}

export function normalizeUlurpRecommendationRow(row) {
  if (!row || typeof row !== "object") return null;
  const normalized = {
    ulurp_number_s: text(row.ulurp_number_s) || null,
    borough_president: text(row.borough_president) || null,
    recommendation_date: text(row.recommendation_date) || null,
    community_board_s: text(row.community_board_s) || null,
    council_district_s: text(row.council_district_s) || null,
    ulurp_application_name: text(row.ulurp_application_name) || null,
  };
  const source_system_id = ulurpRecommendationSourceSystemId(normalized);
  return source_system_id
    ? { ...normalized, source_system: ULURP_RECOMMENDATION_SOURCE_SYSTEM, source_system_id }
    : null;
}

export async function dualWriteUlurpRecommendationObservations(env, rows = [], ingestedAt) {
  if (!sourceRecordDualWriteEnabled(env, ULURP_RECOMMENDATION_SOURCE_RECORD_DUAL_WRITE_FLAG)) {
    return { written: 0, skipped: "flag-off", failed: false };
  }
  if (!env?.DB) return { written: 0, skipped: "no-db", failed: false };
  const list = Array.isArray(rows) ? rows.filter(Boolean) : [];
  if (!list.length) return { written: 0, skipped: "empty", failed: false };
  let written = 0;
  try {
    const insert = env.DB.prepare(SOURCE_RECORD_INSERT_SQL);
    for (let i = 0; i < list.length; i += ULURP_RECOMMENDATION_SOURCE_RECORD_BATCH) {
      const chunk = list.slice(i, i + ULURP_RECOMMENDATION_SOURCE_RECORD_BATCH);
      const statements = await Promise.all(chunk.map(async (row) => {
        const snapshot = { ...row };
        return insert.bind(
          ULURP_RECOMMENDATION_SOURCE_SYSTEM,
          row.source_system_id,
          await computeSourceRecordHash(snapshot),
          JSON.stringify(snapshot),
          JSON.stringify(snapshot),
          ingestedAt || null,
        );
      }));
      await env.DB.batch(statements);
      written += chunk.length;
    }
    return { written, skipped: null, failed: false };
  } catch (error) {
    return { written, skipped: null, failed: true, error: String(error?.message || error) };
  }
}
