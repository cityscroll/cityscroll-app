import assert from "node:assert/strict";
import test from "node:test";

import {
  dualWriteUlurpRecommendationObservations,
  normalizeUlurpRecommendationRow,
} from "../src/lib/ulurp_recommendation_rows_source_records.mjs";

function fakeDb() {
  const state = { batches: 0, statements: 0 };
  return {
    state,
    prepare() { return { bind(...args) { state.statements += args.length ? 1 : 0; return { args }; } }; },
    async batch(statements) { state.batches += 1; state.statements += statements.length; },
  };
}

test("normalizes recommendation rows while preserving publisher nulls", () => {
  const row = normalizeUlurpRecommendationRow({ ulurp_number_s: "210033 ZMK", borough_president: null, recommendation_date: null });
  assert.equal(row.source_system, "ulurp_recommendations");
  assert.equal(row.source_system_id, "ulurp-recommendation:210033 ZMK:no-date:no-borough-president");
  assert.equal(row.borough_president, null);
  assert.equal(row.recommendation_date, null);
});

test("dual-write remains off by default and fail-soft", async () => {
  const rows = [normalizeUlurpRecommendationRow({ ulurp_number_s: "210033 ZMK" })];
  const offDb = fakeDb();
  const off = await dualWriteUlurpRecommendationObservations({ DB: offDb, ULURP_RECOMMENDATION_SOURCE_RECORD_DUAL_WRITE: "false" }, rows, "2026-08-12T00:00:00.000Z");
  assert.equal(off.written, 0);
  assert.equal(offDb.state.batches, 0);
  const onDb = fakeDb();
  const on = await dualWriteUlurpRecommendationObservations({ DB: onDb, ULURP_RECOMMENDATION_SOURCE_RECORD_DUAL_WRITE: "true" }, rows, "2026-08-12T00:00:00.000Z");
  assert.equal(on.written, 1);
  assert.equal(onDb.state.batches, 1);
});
