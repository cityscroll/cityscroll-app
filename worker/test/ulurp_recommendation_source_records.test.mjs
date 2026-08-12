import assert from "node:assert/strict";
import test from "node:test";

import {
  dualWriteUlurpRecommendationPdfObservations,
  normalizeUlurpRecommendationPdfRow,
} from "../src/lib/ulurp_recommendation_source_records.mjs";

function fakeDb() {
  const state = { batches: 0, statements: 0 };
  return {
    state,
    prepare() {
      return {
        bind(...args) {
          state.statements += args.length > 0 ? 1 : 0;
          return { args };
        },
      };
    },
    async batch(statements) {
      state.batches += 1;
      state.statements += statements.length;
    },
  };
}

test("normalizes recommendation PDF rows without replacing null publisher fields", () => {
  const row = normalizeUlurpRecommendationPdfRow({
    ulurp_application_number: "C 180066 ZSM",
    date: null,
    project: null,
    pdf_download: null,
  });

  assert.equal(row.source_system, "ulurp_recommendation_pdfs");
  assert.equal(row.source_system_id, "ulurp-pdf:C 180066 ZSM:no-date:no-project");
  assert.equal(row.date, null);
  assert.equal(row.project, null);
  assert.equal(row.pdf_download, null);
});

test("dual-write is fail-closed when disabled and writes when explicitly enabled", async () => {
  const rows = [{
    ulurp_application_number: "C 180066 ZSM",
    date: null,
    project: null,
    pdf_download: null,
  }];
  const disabledDb = fakeDb();
  const disabled = await dualWriteUlurpRecommendationPdfObservations(
    { DB: disabledDb, ULURP_RECOMMENDATION_PDF_SOURCE_RECORD_DUAL_WRITE: "false" },
    rows,
    "2026-08-12T00:00:00.000Z",
  );
  assert.equal(disabled.written, 0);
  assert.equal(disabledDb.state.batches, 0);

  const enabledDb = fakeDb();
  const enabled = await dualWriteUlurpRecommendationPdfObservations(
    { DB: enabledDb, ULURP_RECOMMENDATION_PDF_SOURCE_RECORD_DUAL_WRITE: "true" },
    rows,
    "2026-08-12T00:00:00.000Z",
  );
  assert.equal(enabled.written, 1);
  assert.equal(enabledDb.state.batches, 1);
});
