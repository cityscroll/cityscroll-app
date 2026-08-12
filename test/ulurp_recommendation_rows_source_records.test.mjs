import assert from "node:assert/strict";
import test from "node:test";

import {
  retainAndMeasureUlurpRecommendations,
  retainUlurpRecommendationRows,
} from "../warehouse/lib/ulurp_recommendation_rows_source_records.mjs";

test("retains recommendation nulls and uses the exact-token receipt gate", () => {
  const result = retainAndMeasureUlurpRecommendations({
    rows: [
      { ulurp_number_s: "210033 ZMK", borough_president: null, recommendation_date: null, community_board_s: null, council_district_s: "33", ulurp_application_name: null },
      { ulurp_number_s: "999999 ZMK", borough_president: "Approved", recommendation_date: "2020-01-01", community_board_s: null, council_district_s: null, ulurp_application_name: "Unmatched" },
    ],
    priorMeasurement: { rates: { recommendation_rows_hit_zap: { joined: 80, total: 91, rate: 0.8791 } }, precision: 1 },
    ingestedAt: "2026-08-12T00:00:00.000Z",
  });

  assert.equal(result.counts.source_records, 2);
  assert.equal(result.counts.joined, 80);
  assert.equal(result.measurement.usefulness.rate, 0.8791);
  assert.equal(result.measurement.precision.rate, 1);
  assert.equal(result.measurement.gates.materialize, true);
  assert.equal(result.source_records[0].payload_json.borough_president, null);
  assert.equal(result.source_records[0].payload_json.recommendation_date, null);
});

test("duplicate recommendation identities are dropped without filling missing values", () => {
  const result = retainUlurpRecommendationRows([
    { ulurp_number_s: "210033 ZMK", recommendation_date: null },
    { ulurp_number_s: "210033 ZMK", recommendation_date: null },
    { ulurp_number_s: null, recommendation_date: "2020-01-01" },
  ]);
  assert.equal(result.counts.retained, 1);
  assert.equal(result.blocked.duplicate_source_ids, 1);
  assert.equal(result.blocked.missing_identity, 1);
});
