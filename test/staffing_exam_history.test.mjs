import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { canonicalHistoricalSchedule } from "../worker/src/lib/staffing_list_prediction.mjs";

const history = JSON.parse(readFileSync(
  new URL("../site/data/exam_sources/annual_schedule_history.json", import.meta.url),
  "utf8",
));

test("historical exam revisions preserve publisher title codes without title inference", () => {
  const rows = canonicalHistoricalSchedule([
    {
      exam_number: "42",
      title_code: "10026",
      exam_title: "Administrative Staff Analyst",
      application_period_end_date: "2025-01-01",
      data_current_as_of: "2025-01-02",
    },
    {
      exam_number: "42",
      exam_title: "A later title-only revision",
      application_period_end_date: "2025-02-01",
      data_current_as_of: "2025-02-02",
    },
  ]);
  assert.deepEqual(rows, [{
    exam_number: "0042",
    exam_title: "A later title-only revision",
    application_start: null,
    application_close: "2025-02-01",
    exam_type: "open_competitive",
    data_current_as_of: "2025-02-02",
  }]);
});

test("committed historical cohort carries the exact-key coverage fields", () => {
  assert.equal(history.summary.distinct_exams, 1271);
  assert.equal(history.records.length, history.summary.distinct_exams);
  assert.equal(
    history.records.filter((row) => row.title_code).length,
    history.summary.exact_title_code_exams,
  );
  assert.ok(history.records.some((row) => row.title_code && row.exam_title));
});
