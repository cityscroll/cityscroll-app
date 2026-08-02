// Exam fee/salary integrity: NOE path delivers non-null amounts; schedule-only
// nulls are class (a) not_yet_ingested, never a false city-withhold claim.
//
//   node --test test/exam_fee_salary.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import {
  retainNoeDetailFields,
  feeSalaryGapFor,
  attachFeeSalaryGap,
  buildArtifact,
  applyNoeFeeSalaryFromBody,
  parseNoeFeeSalaryFromBody,
  applyNoeDensifyRecord,
  feeSalaryNonNullStats,
  extractNoeExamNumbers,
  STAFFING_EXAMS_SCHEMA_VERSION,
} from "../tools/build_staffing_exams.mjs";

const require = createRequire(import.meta.url);
const Staffing = require("../site/staffing.js");
const artifact = JSON.parse(readFileSync(new URL("../site/data/staffing_exams.json", import.meta.url)));
const openCompetitive = JSON.parse(
  readFileSync(new URL("../site/data/exam_sources/dcas_open_competitive.json", import.meta.url)),
);
const densify = JSON.parse(
  readFileSync(new URL("../site/data/exam_sources/noe_fee_salary_densify.json", import.meta.url)),
);
const densifyReceipt = JSON.parse(
  readFileSync(new URL("../site/data/exam_sources/verification_receipts/noe_fee_salary_densify_latest.json", import.meta.url)),
);
const html = readFileSync(new URL("../site/index.html", import.meta.url), "utf8");
const i18n = readFileSync(new URL("../site/i18n.js", import.meta.url), "utf8");

test("NOE open-competitive path yields non-null fee and salary (field case 7016 Caseworker)", () => {
  const exam = artifact.exams.find((row) => row.exam_number === "7016");
  assert.ok(exam, "Caseworker 7016 must exist in the precomputed artifact");
  assert.equal(exam.title, "Caseworker");
  assert.equal(exam.fee, 68);
  assert.equal(exam.salary_min, 48206);
  assert.ok(exam.notice_url && exam.notice_url.includes("/noes/"));
  assert.equal(exam.fee_salary_gap, null);

  const view = Staffing.examFeeSalaryView(exam);
  assert.equal(view.kind, "joined");
  assert.equal(view.fee, 68);
  assert.equal(view.salary_min, 48206);
});

test("every open-competitive NOE row has fee and salary_min in the built artifact", () => {
  for (const row of openCompetitive.records) {
    const exam = artifact.exams.find((item) => item.exam_number === String(row.exam_number));
    assert.ok(exam, `missing exam ${row.exam_number}`);
    assert.notEqual(exam.fee, null, `${row.exam_number} fee`);
    assert.notEqual(exam.fee, undefined, `${row.exam_number} fee`);
    assert.ok(exam.salary_min, `${row.exam_number} salary_min`);
    assert.equal(exam.fee_salary_gap, null, `${row.exam_number} must not carry a fee/salary gap`);
    assert.equal(Staffing.examFeeSalaryView(exam).kind, "joined");
  }
});

test("schedule-only exams without NOE stamp class (a) not_yet_ingested, not class (b)", () => {
  const scheduleOnly = artifact.exams.filter((exam) => !exam.notice_url && exam.fee == null);
  assert.ok(scheduleOnly.length > 0, "fixture still has schedule-only rows");
  for (const exam of scheduleOnly.slice(0, 20)) {
    assert.equal(exam.fee_salary_gap?.class, "not_yet_ingested", exam.exam_number);
    const view = Staffing.examFeeSalaryView(exam);
    assert.equal(view.kind, "not_yet_ingested");
    assert.equal(view.class, "not_yet_ingested");
  }
  // Population integrity: class-b fee/salary gaps must be rare (true NOE omit only).
  const classB = artifact.exams.filter((exam) => exam.fee_salary_gap?.class === "not_published");
  assert.equal(classB.length, 0, "no linked-NOE rows should omit fee/salary in current snapshot");
});

test("retainNoeDetailFields keeps fee and salary when annual schedule overwrites an open exam", () => {
  const prior = {
    exam_number: "9001",
    title: "Sample Retained Exam",
    notice_url: "https://www.nyc.gov/assets/dcas/downloads/pdf/noes/example.pdf",
    fee: 54,
    salary_min: 50000,
    qualifications: "Bachelor's degree",
    sources: ["dcas-open-competitive", "dcas-noe"],
  };
  const annualOnly = {
    exam_number: "9001",
    title: "Sample Retained Exam",
    application_start: "2026-01-01",
    application_end: "2026-01-21",
    sources: ["dcas-annual-schedule"],
  };
  const retained = retainNoeDetailFields(annualOnly, prior);
  assert.equal(retained.fee, 54);
  assert.equal(retained.salary_min, 50000);
  assert.equal(retained.notice_url, prior.notice_url);
  assert.ok(retained.sources.includes("dcas-noe"));
  assert.equal(feeSalaryGapFor(retained), null);
  assert.equal(attachFeeSalaryGap(retained).fee_salary_gap, null);
});

test("fee 0 (no application fee) is retained and renders as joined, not not-published", () => {
  const prior = {
    exam_number: "7331",
    fee: 0,
    salary_min: 48719,
    notice_url: "https://www.nyc.gov/assets/dcas/downloads/pdf/noes/20277331000.pdf",
    sources: ["dcas-noe"],
  };
  const annualOnly = { exam_number: "7331", title: "Traffic Enforcement Agent", sources: ["dcas-annual-schedule"] };
  const retained = retainNoeDetailFields(annualOnly, prior);
  assert.equal(retained.fee, 0);
  assert.equal(Staffing.examFeeSalaryView(retained).kind, "joined");
  assert.equal(Staffing.examFeeSalaryView(retained).fee, 0);
});

test("UI careerMoney uses class-a copy for never-ingested fee/salary nulls", () => {
  assert.match(html, /function careerMoney\s*\(/);
  assert.match(html, /career_fee_salary_not_yet_ingested_html/);
  assert.match(html, /examFeeSalaryView/);
  assert.match(html, /data-fee-salary=/);
  assert.match(html, /function careerSalaryHTML/);
  assert.match(i18n, /career_fee_salary_not_yet_ingested_html:\s*"Not yet shown here/);
  assert.match(i18n, /career_noe_source_name:/);
});

test("NOE body densify raises fee/salary non-null rate with stamped receipt", () => {
  assert.equal(artifact.schema_version, STAFFING_EXAMS_SCHEMA_VERSION);
  const stats = feeSalaryNonNullStats(artifact.exams);
  assert.equal(stats.total, 228);
  assert.ok(stats.both >= 21, `expected densified both>=21, got ${stats.both}`);
  assert.ok(
    densifyReceipt.fee_salary_non_null_after.both > densifyReceipt.fee_salary_non_null_before.both,
    "receipt must show densify raised the non-null count",
  );
  assert.equal(densifyReceipt.fee_salary_non_null_before.both, 8);
  assert.equal(densifyReceipt.fee_salary_non_null_after.both, stats.both);
  assert.equal(densifyReceipt.policy.never_fabricate, true);
  assert.equal(densifyReceipt.policy.public_noe_path_only, true);

  // Field cases from multi-exam Police Officer NOE + Assistant Electrical Engineer.
  const po = artifact.exams.find((row) => row.exam_number === "7311");
  assert.ok(po);
  assert.equal(po.fee, 0);
  assert.equal(po.salary_min, 55942);
  assert.equal(po.salary_max, 109352);
  assert.ok(po.notice_url && po.notice_url.includes("20277311000"));
  assert.equal(Staffing.examFeeSalaryView(po).kind, "joined");

  const laterWindow = artifact.exams.find((row) => row.exam_number === "7322");
  assert.ok(laterWindow);
  assert.equal(laterWindow.fee, 0);
  assert.equal(laterWindow.salary_min, 55942);

  const aee = artifact.exams.find((row) => row.exam_number === "7007");
  assert.ok(aee);
  assert.equal(aee.fee, 82);
  assert.equal(aee.salary_min, 66330);
  assert.equal(aee.fee_salary_gap, null);
});

test("applyNoeDensifyRecord never overwrites structured fee and multi-exam numbers extract", () => {
  const kept = applyNoeDensifyRecord(
    { exam_number: "7016", fee: 68, salary_min: 48206, sources: ["dcas-open-competitive"] },
    densify.records.find((r) => r.exam_number === "7007"),
  );
  assert.equal(kept.fee, 68);
  assert.equal(kept.salary_min, 48206);

  const multiHeader =
    "Exam No. 7311, 7312, 7313, 7314, 7315, 7316, 7317, 7318, 7319, 7320, 7321, and 7322";
  const nums = extractNoeExamNumbers(multiHeader);
  assert.equal(nums.length, 12);
  assert.equal(nums[0], "7311");
  assert.equal(nums.at(-1), "7322");
});

test("#exam deep-link preserves detail hash and paints detail shell before list", () => {
  assert.match(html, /function showExam\s*\(/);
  assert.match(html, /function paintExamDetailShell\s*\(/);
  assert.match(html, /Preserve #exam\/<id>/);
  assert.match(html, /careerSelected && \/\^\\d\{4\}\$\//);
  assert.match(html, /feed\.hidden\s*=\s*examDetail/);
  assert.match(html, /data-exam-loading/);
  // serializeState must not rewrite an open exam detail into #people?view=guide.
  assert.match(html, /return "#exam\/"\+encodeURIComponent/);
});

test("build densifies fee/salary from raw NOE body when structured fields are missing", () => {
  const body = `
WHEN TO APPLY: From: July 1, 2026 APPLICATION FEE: $68.00
THE SALARY:
  The current minimum salary is $48,206 per annum. This rate is subject to change.
`;
  const parsed = parseNoeFeeSalaryFromBody(body);
  assert.equal(parsed.fee, 68);
  assert.equal(parsed.salary_min, 48206);

  const densified = applyNoeFeeSalaryFromBody({
    exam_number: "7016",
    title: "Caseworker",
    notice_url: "https://www.nyc.gov/assets/dcas/downloads/pdf/noes/20277016000.pdf",
    sources: ["dcas-open-competitive"],
    noe_body: body,
  });
  assert.equal(densified.fee, 68);
  assert.equal(densified.salary_min, 48206);
  assert.equal(attachFeeSalaryGap(densified).fee_salary_gap, null);
  assert.equal(Staffing.examFeeSalaryView(densified).kind, "joined");
});

test("buildArtifact retains prior NOE amounts for annual-only survivors", () => {
  const annual = {
    source: {
      id: "dcas-annual-schedule",
      name: "Annual",
      fetched_at: "2026-07-29",
      data_current_as_of: "2026-07-22",
      stale_after_days: 95,
    },
    records: [{
      title_code: "52304",
      exam_title: "Caseworker",
      exam_number: "7016",
      application_period_start: "2026-07-01T00:00:00.000",
      application_period_end_date: "2026-07-21T00:00:00.000",
      open_competitive_promotion: "Open Competitive",
      data_current_as_of: "2026-07-22T00:00:00.000",
    }],
  };
  const current = {
    source: {
      id: "dcas-open-competitive",
      name: "Open",
      verified_at: "2026-07-28",
      stale_after_days: 35,
    },
    records: [],
  };
  const emptySide = {
    source: {
      id: "side",
      name: "side",
      fetched_at: "2026-07-29",
      stale_after_days: 3,
    },
    summary: {},
    records: [],
  };
  const outcomes = {
    source: {
      id: "dcas-annual-exam-outcomes",
      name: "Outcomes",
      fetched_at: "2026-07-29",
      data_publication_date: "2026-07-29",
      stale_after_days: 365,
    },
    records: [],
  };
  const priorArtifact = {
    exams: [{
      exam_number: "7016",
      title: "Caseworker",
      application_start: "2026-07-01",
      application_end: "2026-08-25",
      notice_url: "https://www.nyc.gov/assets/dcas/downloads/pdf/noes/20277016000.pdf",
      fee: 68,
      salary_min: 48206,
      qualifications: "A bachelor's degree from an accredited college or university.",
      sources: ["dcas-open-competitive", "dcas-noe"],
    }],
  };
  const built = buildArtifact({
    annual,
    current,
    activeList: emptySide,
    cityRecord: emptySide,
    outcomes,
    listAggregates: null,
    priorArtifact,
    today: "2026-07-29",
  });
  const exam = built.exams.find((row) => row.exam_number === "7016");
  assert.ok(exam);
  assert.equal(exam.fee, 68);
  assert.equal(exam.salary_min, 48206);
  assert.equal(exam.fee_salary_gap, null);
  assert.ok(exam.notice_url);
});
