/**
 * NOE body fee/salary parse — real DCAS Notice of Examination formats.
 *
 *   node --test test/noe_fee_salary.test.mjs
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  toMoneyAmount,
  parseNoeFeeSalaryFromBody,
  applyNoeFeeSalaryFromBody,
  extractNoeExamNumbers,
} from "../worker/src/lib/noe_fee_salary.mjs";

// Verbatim shapes from pdftotext of live DCAS NOE PDFs (2026-08).
const CASEWORKER_7016 = `
WHEN TO APPLY:           From: July 1, 2026                        APPLICATION FEE: $68.00
                         To:     August 25, 2026                   Candidates paying the application fee
THE SALARY:
  The current minimum salary is $48,206 per annum. This rate is subject to change.
`;

const ASSISTANT_CIVIL_ENGINEER_7006 = `
WHEN TO APPLY:           From: July 1, 2026                        APPLICATION FEE: $82.00
THE SALARY:
  The current minimum salary is $66,330 per annum. This rate is subject to change.
`;

const TRAFFIC_ENFORCEMENT_7331 = `
WHEN TO APPLY:           From: July 1, 2026                       APPLICATION FEE: $0.00
                         To:     August 25, 2026                  When applying, select "No Fee" as
                                                                  your payment method.
THE SALARY:
  The current minimum salary is $48,719 per annum. This rate is subject to change.
`;

const SCHOOL_SAFETY_7323 = `
WHEN TO APPLY:            From: July 1, 2026                        APPLICATION FEE: $61.00
THE SALARY:
  The current minimum salary is $40,480 per annum. This rate is subject to change. Incumbents will receive
  salary increments reaching $58,345 per annum at the completion of five years of employment as a School
`;

// PDF extraction quirk: space after thousands comma (same class as subsidy hearing money).
const SPACED_SEPARATORS = `
APPLICATION FEE: $68. 00
THE SALARY:
  The current minimum salary is $48, 206 per annum. This rate is subject to change.
`;

test("toMoneyAmount handles plain, comma, spaced, and currency forms", () => {
  assert.equal(toMoneyAmount("$68.00"), 68);
  assert.equal(toMoneyAmount("48,206"), 48206);
  assert.equal(toMoneyAmount("48, 206"), 48206);
  assert.equal(toMoneyAmount("$10, 667, 606"), 10667606);
  assert.equal(toMoneyAmount("0"), 0);
  assert.equal(toMoneyAmount("$0.00"), 0);
  assert.equal(toMoneyAmount(""), null);
  assert.equal(toMoneyAmount("not-a-number"), null);
});

test("field case: Caseworker 7016 fee $68 and salary $48,206", () => {
  const parsed = parseNoeFeeSalaryFromBody(CASEWORKER_7016);
  assert.equal(parsed.fee, 68);
  assert.equal(parsed.salary_min, 48206);
  assert.equal(parsed.salary_max, null);
  assert.equal(parsed.salary_note, "Current minimum annual salary");
  assert.match(parsed.fee_excerpt || "", /APPLICATION FEE/i);
  assert.match(parsed.salary_excerpt || "", /minimum salary/i);
});

test("field case: Assistant Civil Engineer 7006 fee $82 / salary $66,330", () => {
  const parsed = parseNoeFeeSalaryFromBody(ASSISTANT_CIVIL_ENGINEER_7006);
  assert.equal(parsed.fee, 82);
  assert.equal(parsed.salary_min, 66330);
});

test("field case: zero application fee ($0.00) is retained, not treated as missing", () => {
  const parsed = parseNoeFeeSalaryFromBody(TRAFFIC_ENFORCEMENT_7331);
  assert.equal(parsed.fee, 0);
  assert.equal(parsed.salary_min, 48719);
});

test("field case: School Safety Agent min + reaching max", () => {
  const parsed = parseNoeFeeSalaryFromBody(SCHOOL_SAFETY_7323);
  assert.equal(parsed.fee, 61);
  assert.equal(parsed.salary_min, 40480);
  assert.equal(parsed.salary_max, 58345);
});

test("spaced thousands separators do not truncate amounts", () => {
  const parsed = parseNoeFeeSalaryFromBody(SPACED_SEPARATORS);
  assert.equal(parsed.fee, 68);
  assert.equal(parsed.salary_min, 48206);
});

test("absent labels yield nulls — never fabricate", () => {
  const parsed = parseNoeFeeSalaryFromBody(
    "NOTICE OF EXAMINATION\nExam No. 9999\nNo fee or salary labels here.",
  );
  assert.equal(parsed.fee, null);
  assert.equal(parsed.salary_min, null);
  assert.equal(parsed.salary_max, null);
  assert.equal(parsed.fee_excerpt, null);
  assert.equal(parsed.salary_excerpt, null);
});

test("applyNoeFeeSalaryFromBody densifies missing structured fields only", () => {
  const densified = applyNoeFeeSalaryFromBody(
    { exam_number: "7016", title: "Caseworker", sources: ["dcas-annual-schedule"] },
    CASEWORKER_7016,
  );
  assert.equal(densified.fee, 68);
  assert.equal(densified.salary_min, 48206);
  assert.ok(densified.sources.includes("dcas-noe"));

  // Does not overwrite an existing structured fee (even when body differs).
  const kept = applyNoeFeeSalaryFromBody(
    { exam_number: "7016", fee: 99, salary_min: 1, sources: [] },
    CASEWORKER_7016,
  );
  assert.equal(kept.fee, 99);
  assert.equal(kept.salary_min, 1);
});

test("applyNoeFeeSalaryFromBody reads exam.noe_body when no override", () => {
  const densified = applyNoeFeeSalaryFromBody({
    exam_number: "7006",
    noe_body: ASSISTANT_CIVIL_ENGINEER_7006,
  });
  assert.equal(densified.fee, 82);
  assert.equal(densified.salary_min, 66330);
});

test("empty body is a no-op", () => {
  const exam = { exam_number: "1", fee: null };
  assert.equal(applyNoeFeeSalaryFromBody(exam, ""), exam);
  assert.equal(applyNoeFeeSalaryFromBody(exam), exam);
});

test("extractNoeExamNumbers handles multi-exam Police Officer header", () => {
  const body = `
POLICE OFFICER
Exam No. 7311, 7312, 7313, 7314, 7315, 7316, 7317, 7318, 7319, 7320, 7321, and 7322
APPLICATION FEE: $0.00
THE SALARY:
  The current minimum salary is $55,942 per annum. Incumbents will receive salary increments reaching
  $109,352 per annum at the completion of five and one-half years employment.
`;
  assert.deepEqual(extractNoeExamNumbers(body), [
    "7311", "7312", "7313", "7314", "7315", "7316",
    "7317", "7318", "7319", "7320", "7321", "7322",
  ]);
  const parsed = parseNoeFeeSalaryFromBody(body);
  assert.equal(parsed.fee, 0);
  assert.equal(parsed.salary_min, 55942);
  assert.equal(parsed.salary_max, 109352);
});

test("assignment-level salary phrasing still densifies (Traffic Enforcement 7331)", () => {
  const body = `
APPLICATION FEE: $0.00
THE SALARY:
  Candidates will be eligible for appointment to Assignment Level II for which the current minimum salary is
  $48,719 per annum. There are two additional Assignment Levels with higher salary steps based on the
`;
  const parsed = parseNoeFeeSalaryFromBody(body);
  assert.equal(parsed.fee, 0);
  assert.equal(parsed.salary_min, 48719);
});
