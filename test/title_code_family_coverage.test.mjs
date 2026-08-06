import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { parseEntityRef } from "../site/entity_pivot.mjs";
import { buildTitleCodeAliasRegistry } from "../tools/build_title_code_alias_registry.mjs";
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

test("alias registry accepts only exact labels with one canonical identity", () => {
  const registry = buildTitleCodeAliasRegistry({
    jobsRows: [
      { job_id: "1", agency: "AGENCY A", civil_service_title: "Project Manager", title_code_no: "22426" },
      { job_id: "2", agency: "AGENCY B", civil_service_title: "Project Manager", title_code_no: "22426" },
      { job_id: "3", agency: "AGENCY C", civil_service_title: "Shared Title", title_code_no: "10001" },
      { job_id: "4", agency: "AGENCY D", civil_service_title: "Shared Title", title_code_no: "10002" },
      { job_id: "5", agency: "AGENCY E", civil_service_title: "Uncanonical", title_code_no: "99999" },
    ],
    canonicalRows: [
      { title: "22426", descr: "PROJECT MANAGER", asg_lvl: "00", std_hrs: "35" },
      { title: "10001", descr: "SHARED TITLE", asg_lvl: "00", std_hrs: "35" },
      { title: "10002", descr: "SHARED TITLE", asg_lvl: "00", std_hrs: "35" },
    ],
    generatedAt: "2026-08-06",
  });
  assert.equal(registry.measures.exact_alias_pairs, 1);
  assert.deepEqual(registry.alias_index["PROJECT MANAGER"], ["22426"]);
  assert.equal(registry.alias_index["SHARED TITLE"], undefined);
  assert.equal(registry.alias_index.UNCANONICAL, undefined);
});

test("source aliases add coverage while residual FS remains the precision gate", () => {
  const aliasRegistry = buildTitleCodeAliasRegistry({
    jobsRows: [
      { job_id: "1", agency: "AGENCY A", civil_service_title: "Project Manager", title_code_no: "22426" },
    ],
    canonicalRows: [
      { title: "22426", descr: "PROJECT MANAGER", asg_lvl: "00", std_hrs: "35" },
      { title: "70210", descr: "POLICE OFFICER", asg_lvl: "00", std_hrs: "35" },
    ],
    generatedAt: "2026-08-06",
  });
  const measured = measureTitleCodeFamilyCoverage({
    historyRecords: [
      { exam_number: "0001", title_code: null, exam_title: "Project Manager" },
      { exam_number: "0002", title_code: "70210", exam_title: "Police Officer" },
    ],
    titleCrosswalk: [],
    aliasRegistry,
    generatedAt: "2026-08-06",
  });
  assert.equal(measured.historical_exams.alias_registry_exact, 1);
  assert.equal(measured.historical_exams.exact_plus_alias, 2);
  assert.equal(measured.residual_fellegi_sunter.residual_missing_rows, 0);
  assert.equal(measured.promotion.coverage_passed, true);
  assert.equal(measured.promotion.precision_passed, false);
  assert.equal(measured.promotion.publish_family_ui, false);
});

test("committed trial stops below the standing promotion bars", () => {
  assert.equal(coverage.historical_exams.cohort, 1271);
  assert.equal(coverage.historical_exams.exact_title_code, 367);
  assert.equal(coverage.historical_exams.exact_title_code_rate, 0.2887);
  assert.equal(coverage.historical_exams.reviewed_confirmed, 5);
  assert.equal(coverage.historical_exams.exact_plus_confirmed, 372);
  assert.equal(coverage.historical_exams.exact_plus_confirmed_rate, 0.2927);
  assert.equal(coverage.historical_exams.alias_registry_exact, 137);
  assert.equal(coverage.historical_exams.exact_plus_alias, 504);
  assert.equal(coverage.historical_exams.exact_plus_alias_rate, 0.3965);
  assert.equal(coverage.appointments.exact_title_code_rate, 1);
  assert.equal(coverage.promotion.historical_exam_coverage_floor, 0.3);
  assert.equal(coverage.promotion.audit_precision_floor, 0.95);
  assert.equal(coverage.promotion.coverage_passed, true);
  assert.equal(coverage.promotion.publish_family_ui, false);
  assert.equal(coverage.promotion.publish_entity_pivots, false);
  assert.equal(coverage.precision_audit.status, "residual_only_held_out");
  assert.equal(coverage.precision_audit.reviewed, 55);
  assert.equal(coverage.precision_audit.correct, 45);
  assert.equal(coverage.precision_audit.precision, 0.8182);
  assert.equal(coverage.promotion.coverage_rate, 0.3965);
  assert.equal(coverage.promotion.coverage_passed, true);
  assert.equal(coverage.promotion.precision_passed, false);
});

test("closed trial does not widen the public entity-ref allowlist", () => {
  assert.equal(parseEntityRef("title-code:10026"), null);
  assert.equal(parseEntityRef("exam:6003"), null);
});
