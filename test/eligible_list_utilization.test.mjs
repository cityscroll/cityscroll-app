import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildEligibleListUtilizationSlice,
  utilizationRowsForExam,
} from "../worker/src/lib/eligible_list_utilization.mjs";
import { readFileSync } from "node:fs";

test("LL50 slice uses exact exam keys and preserves source-row provenance", () => {
  const slice = buildEligibleListUtilizationSlice(
    [{ exam_number: "8050", title: "Owner title" }, { exam_number: "08051" }],
    [
      { exam_no: "8050", title_description: "ACCOUNTANT", appt_cnt: "30" },
      { exam_no: "8050", title_description: "ACCOUNTANT II", appt_cnt: "2" },
      { exam_no: "8051", title_description: "Not linked by zero-padding" },
      { exam_no: "9999", title_description: "Outside graph" },
    ],
  );

  assert.deepEqual(slice.coverage, { eligible: 2, linked: 1, rate: 0.5 });
  assert.equal(slice.records.length, 2);
  assert.equal(slice.records[0].source_row.title_description, "ACCOUNTANT");
  assert.equal(slice.records[0].provenance.join, "exact");
  assert.equal(slice.records[0].provenance.dataset_id, "qjzt-ytn9");
  assert.equal(utilizationRowsForExam(slice, "8050").length, 2);
  assert.equal(utilizationRowsForExam(slice, "08050").length, 0);
});

test("staffing artifact and surface expose only strong LL50 edges", () => {
  const artifact = JSON.parse(readFileSync(new URL("../site/data/staffing_exams.json", import.meta.url)));
  const source = readFileSync(new URL("../site/app/people.mjs", import.meta.url), "utf8");
  assert.deepEqual(artifact.source_checks.eligible_list_utilization, {
    eligible: 228,
    linked: 98,
    rate: 98 / 228,
    rows: 656,
    source_id: "dcas-eligible-list-utilization",
    dataset_id: "qjzt-ytn9",
    vintage: "2026-08-05",
  });
  assert.equal(artifact.exams.filter((exam) => exam.eligible_list_utilization?.status === "linked").length, 98);
  assert.match(source, /data-evidence-group="eligible-list-utilization"/);
  assert.match(source, /summary\.status !== "linked"/);
});
