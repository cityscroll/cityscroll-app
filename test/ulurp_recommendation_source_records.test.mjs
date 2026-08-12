import assert from "node:assert/strict";
import test from "node:test";

import {
  retainAndMeasureUlurpRecommendationPdfs,
  retainUlurpRecommendationPdfRows,
} from "../warehouse/lib/ulurp_recommendation_source_records.mjs";

test("retains publisher nulls and measures exact ULURP-token joins", () => {
  const result = retainAndMeasureUlurpRecommendationPdfs({
    pdfRows: [
      {
        ulurp_application_number: "C 180066 ZSM",
        date: null,
        project: null,
        pdf_download: null,
      },
      {
        ulurp_application_number: "C 999999 ZSM",
        date: "2019-01-01T00:00:00.000",
        project: "Unmatched project",
        pdf_download: "https://example.test/missing.pdf",
      },
    ],
    zapRows: [{ ulurp_numbers: "C180066ZSM" }],
    ingestedAt: "2026-08-12T00:00:00.000Z",
  });

  assert.equal(result.counts.source_records, 2);
  assert.equal(result.measurement.usefulness.joined, 1);
  assert.equal(result.measurement.usefulness.rate, 0.5);
  assert.equal(result.measurement.precision.rate, 1);
  assert.equal(result.measurement.gates.materialize, true);
  assert.equal(result.source_records[0].payload_json.date, null);
  assert.equal(result.source_records[0].payload_json.project, null);
  assert.equal(result.source_records[0].payload_json.pdf_download, null);
});

test("drops duplicate source identities without fabricating a replacement", () => {
  const result = retainUlurpRecommendationPdfRows([
    { ulurp_application_number: "C 180066 ZSM", date: null, project: null },
    { ulurp_application_number: "C 180066 ZSM", date: null, project: null },
    { ulurp_application_number: null, date: "2020-01-01", project: "Unknown" },
  ]);

  assert.equal(result.counts.input_rows, 3);
  assert.equal(result.counts.retained, 1);
  assert.equal(result.blocked.duplicate_source_ids, 1);
  assert.equal(result.blocked.missing_identity, 1);
});
