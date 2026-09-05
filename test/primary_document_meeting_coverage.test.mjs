import assert from "node:assert/strict";
import test from "node:test";

import { assertMeetingCoverage } from "../tools/build_primary_documents.mjs";

const SILENT = { warn() {} };

function materializedRow(index, { body = true, rich = true } = {}) {
  const requestId = `2026090${String(index).padStart(4, "0")}`;
  return {
    request_id: requestId,
    ...(body ? { additional_description_1: `<p>Notice body ${index}</p>` } : {}),
    ...(rich ? { street_address_1: `${index} Civic Plaza` } : {}),
  };
}

function readModelFor(rows, extraRows = []) {
  const modelRows = [
    ...rows.map((row) => ({ ...row, meeting_id: `meeting:city_record:${row.request_id}` })),
    ...extraRows,
  ];
  return { counts: { city_record: modelRows.length }, rows: modelRows };
}

test("meeting coverage accepts a materialized City Record population above the richness floor", () => {
  const materialized = Array.from({ length: 20 }, (_, index) => materializedRow(index));
  const model = readModelFor(materialized);
  const summary = assertMeetingCoverage(model, materialized, materialized, SILENT);
  assert.deepEqual(summary, { materialized: 20, rich: 20 });
});

test("meeting coverage rejects a City Record count that drifted from the eligible input", () => {
  const materialized = Array.from({ length: 20 }, (_, index) => materializedRow(index));
  const model = readModelFor(materialized);
  model.counts.city_record = 19;
  assert.throws(
    () => assertMeetingCoverage(model, materialized, materialized, SILENT),
    /materialized 19\/20 eligible City Record meetings/,
  );
});

test("meeting coverage rejects a materialized population below the absolute richness floor", () => {
  const materialized = Array.from({ length: 9 }, (_, index) => materializedRow(index));
  const model = readModelFor(materialized);
  assert.throws(
    () => assertMeetingCoverage(model, materialized, materialized, SILENT),
    /notice richness for only 9 of 9 materialized City Record meetings \(floor 10\)/,
  );
});

test("meeting coverage rejects a collapse in the share of rich materialized notices", () => {
  const rich = Array.from({ length: 12 }, (_, index) => materializedRow(index));
  const bare = Array.from({ length: 20 }, (_, index) => materializedRow(100 + index, { body: false, rich: false }));
  const materialized = [...rich, ...bare];
  const model = readModelFor(materialized);
  assert.throws(
    () => assertMeetingCoverage(model, materialized, materialized, SILENT),
    /only 12 of 32 materialized City Record meetings carry notice richness \(floor 50%\)/,
  );
});

test("meeting coverage reports the retired request-id sentinels instead of failing on them", () => {
  const materialized = Array.from({ length: 20 }, (_, index) => materializedRow(index));
  const retained = { meeting_id: "meeting:city_record:20260713006", request_id: "20260713006" };
  const model = readModelFor(materialized, [retained]);
  model.counts.city_record = 21;
  const warnings = [];
  const summary = assertMeetingCoverage(
    model,
    [...materialized, retained],
    materialized,
    { warn: (message) => warnings.push(message) },
  );
  assert.deepEqual(summary, { materialized: 20, rich: 20 });
  assert.deepEqual(warnings, [
    "City Record meeting 20260810053 is outside the current notice window",
    "City Record meeting 20260713006 is retained without materialized notice richness",
  ]);
});
