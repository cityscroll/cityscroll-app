import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { parseEntityRef } from "../site/entity_pivot.mjs";
import {
  appointmentTitleCode,
  measureTitleCodeFamilyCoverage,
  publisherTitleCode,
} from "../tools/build_title_code_family_coverage.mjs";

const coverage = JSON.parse(readFileSync(
  new URL("../site/data/exam_sources/title_code_family_coverage.json", import.meta.url),
  "utf8",
));

test("measurement joins exams and appointments only through exact title codes", () => {
  const measured = measureTitleCodeFamilyCoverage({
    historyRecords: [
      { exam_number: "0001", title_code: "10026", exam_title: "Administrative Staff Analyst" },
      { exam_number: "0002", title_code: null, exam_title: "Administrative Staff Analyst" },
    ],
    appointmentRows: [
      { additional_description_1: "Title Code: 10026; Reason For Change: APPOINTED" },
      { additional_description_1: "Reason For Change: APPOINTED" },
    ],
    titleCrosswalk: [{ title_code: "10026", official_title: "ADMINISTRATIVE STAFF ANALYST" }],
    generatedAt: "2026-08-05",
  });
  assert.equal(appointmentTitleCode({ additional_description_1: "Title Code: 10026; X" }), "10026");
  assert.equal(publisherTitleCode({ list_title_code: " 10026 " }), "10026");
  assert.equal(measured.historical_exams.exact_title_code, 1);
  assert.equal(measured.historical_exams.exact_title_code_rate, 0.5);
  assert.equal(measured.appointments.exact_title_code, 1);
  assert.deepEqual(measured.constellation.shared_title_codes, ["10026"]);
  assert.equal(measured.method.title_text_matching, false);
});

test("reviewed confirmations add measured coverage without hand-flipping promotion", () => {
  const measured = measureTitleCodeFamilyCoverage({
    historyRecords: [
      { exam_number: "0001", title_code: "10026", exam_title: "Analyst" },
      { exam_number: "0002", title_code: null, exam_title: "Police Officer" },
      { exam_number: "0003", title_code: null, exam_title: "Correction Officer" },
    ],
    titleCrosswalk: [],
    reviewedRegistry: {
      confirmations: [{ exam_number: "0002", title_code: "70210" }],
      rejections: [{ exam_number: "0003", title_code: "70210" }],
    },
    generatedAt: "2026-08-05",
  });
  assert.equal(measured.historical_exams.exact_plus_confirmed, 2);
  assert.equal(measured.historical_exams.exact_plus_confirmed_rate, 0.6667);
  assert.equal(measured.precision_audit.reviewed, 2);
  assert.equal(measured.precision_audit.precision, 0.5);
  assert.equal(measured.promotion.coverage_passed, true);
  assert.equal(measured.promotion.precision_passed, false);
  assert.equal(measured.promotion.passed, false);
  assert.equal(measured.promotion.publish_family_ui, false);
  assert.equal(measured.promotion.publish_entity_pivots, false);
});

test("publisher candidates do not become reviewed audit labels", () => {
  const measured = measureTitleCodeFamilyCoverage({
    historyRecords: [
      { exam_number: "0001", title_code: null, exam_title: "Command Officer" },
    ],
    annualScheduleRows: [
      { exam_number: "0001", list_title_code: "53054" },
    ],
    reviewedRegistry: {
      confirmations: [],
      rejections: [],
    },
    generatedAt: "2026-08-05",
  });
  assert.equal(measured.backfill.candidate_rows_found, 1);
  assert.equal(measured.backfill.reviewed_rows, 0);
  assert.equal(measured.precision_audit.reviewed, 0);
  assert.equal(measured.historical_exams.exact_plus_confirmed, 0);
  assert.equal(measured.promotion.passed, false);
});

test("committed trial stops below the standing promotion bars", () => {
  assert.equal(coverage.historical_exams.cohort, 1271);
  assert.equal(coverage.historical_exams.exact_title_code, 367);
  assert.equal(coverage.historical_exams.exact_title_code_rate, 0.2887);
  assert.equal(coverage.historical_exams.reviewed_confirmed, 5);
  assert.equal(coverage.historical_exams.exact_plus_confirmed, 372);
  assert.equal(coverage.historical_exams.exact_plus_confirmed_rate, 0.2927);
  assert.equal(coverage.appointments.exact_title_code_rate, 1);
  assert.equal(coverage.promotion.historical_exam_coverage_floor, 0.3);
  assert.equal(coverage.promotion.audit_precision_floor, 0.95);
  assert.equal(coverage.promotion.coverage_passed, false);
  assert.equal(coverage.promotion.publish_family_ui, false);
  assert.equal(coverage.promotion.publish_entity_pivots, false);
  assert.equal(coverage.precision_audit.reviewed, 18);
  assert.equal(coverage.precision_audit.correct, 5);
  assert.equal(coverage.precision_audit.precision, 0.2778);
});

test("closed trial does not widen the public entity-ref allowlist", () => {
  assert.equal(parseEntityRef("title-code:10026"), null);
  assert.equal(parseEntityRef("exam:6003"), null);
});
