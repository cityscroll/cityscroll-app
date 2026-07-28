import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const require = createRequire(import.meta.url);
const Staffing = require("../staffing.js");
const artifact = JSON.parse(readFileSync(new URL("../data/staffing_exams.json", import.meta.url)));

test("precomputed staffing artifact is reproducible from committed source snapshots", () => {
  execFileSync(process.execPath, ["tools/build_staffing_exams.mjs", "--check"], {
    cwd: new URL("..", import.meta.url),
    stdio: "pipe",
  });
});

test("every exam has a unique shareable identity and official provenance", () => {
  assert.equal(artifact.schema_version, 1);
  assert.equal(artifact.exams.length, 151);
  assert.equal(new Set(artifact.exams.map(exam => exam.exam_number)).size, artifact.exams.length);
  for (const exam of artifact.exams) {
    assert.match(exam.exam_number, /^\d{4}$/);
    assert.ok(exam.title);
    assert.ok(exam.sources.length);
    assert.match(Staffing.examUrl(exam.exam_number), new RegExp(`#exam/${exam.exam_number}$`));
  }
});

test("the current DCAS page contributes eight actionable NOEs without inventing City Record exams", () => {
  const today = "2026-07-28";
  const withNoe = artifact.exams.filter(exam => exam.notice_url);
  assert.equal(withNoe.length, 8);
  assert.ok(withNoe.every(exam => Staffing.statusFor(exam, today) === "open"));
  assert.ok(withNoe.every(exam => exam.fee != null && exam.salary_min && exam.qualifications));
  assert.equal(artifact.source_checks.city_record.accepted_exam_announcements, 0);
  assert.ok(Number(artifact.source_checks.city_record.candidate_rows) > 0);
});

test("interest, eligibility, and application-window filters are deterministic", () => {
  const today = "2026-07-28";
  const publicSafety = Staffing.filterExams(artifact.exams, {
    query: "", interest: "public-safety", eligibility: "open_competitive", window: "actionable",
  }, today);
  assert.ok(publicSafety.length > 0);
  assert.ok(publicSafety.every(exam => exam.interest_area === "public-safety"));
  assert.ok(publicSafety.every(exam => ["open", "upcoming"].includes(Staffing.statusFor(exam, today))));

  const exact = Staffing.filterExams(artifact.exams, {
    query: "7016", interest: "all", eligibility: "all", window: "all",
  }, today);
  assert.deepEqual(exact.map(exam => exam.exam_number), ["7016"]);
});

test("source staleness is derived from the recorded cadence", () => {
  const current = artifact.sources.find(source => source.id === "dcas-open-competitive");
  assert.equal(Staffing.sourceIsStale(current, "2026-08-31"), false);
  assert.equal(Staffing.sourceIsStale(current, "2026-09-02"), true);
});
