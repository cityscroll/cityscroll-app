import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { STAFFING_EXAMS_SCHEMA_VERSION } from "../tools/build_staffing_exams.mjs";

const require = createRequire(import.meta.url);
const Staffing = require("../site/staffing.js");
const artifact = JSON.parse(readFileSync(new URL("../site/data/staffing_exams.json", import.meta.url)));
const html = readFileSync(new URL("../site/index.html", import.meta.url), "utf8");
const FIXTURE_TODAY = "2026-08-02";

test("precomputed staffing artifact is reproducible from committed source snapshots", () => {
  execFileSync(process.execPath, ["tools/build_staffing_exams.mjs", "--check", `--today=${FIXTURE_TODAY}`], {
    cwd: new URL("..", import.meta.url),
    stdio: "pipe",
  });
});

test("every exam has a unique shareable identity and official provenance", () => {
  assert.equal(artifact.schema_version, STAFFING_EXAMS_SCHEMA_VERSION);
  // Current FY schedule (~151) plus closed list-depth exams with Civil Service List joins.
  assert.ok(artifact.exams.length >= 151, `expected full schedule, got ${artifact.exams.length}`);
  const listDepth = artifact.exams.filter((exam) => exam.list_depth || exam.sources?.includes("dcas-annual-closed-list-depth"));
  assert.ok(listDepth.length >= 10, "closed list-depth exams keep post-list joins after FY roll-forward");
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
  // Open-competitive snapshot NOEs (live DCAS page) plus densify-only NOE URLs
  // for body-parsed fee/salary on annual-schedule exams (Police Officer multi-exam, etc.).
  const openCompetitiveNoe = artifact.exams.filter(
    (exam) => exam.notice_url && (exam.sources || []).includes("dcas-open-competitive"),
  );
  assert.equal(openCompetitiveNoe.length, 8);
  assert.ok(openCompetitiveNoe.every(exam => Staffing.statusFor(exam, today) === "open"));
  assert.ok(openCompetitiveNoe.every(exam => exam.fee != null && exam.salary_min && exam.qualifications));
  const withNoe = artifact.exams.filter(exam => exam.notice_url);
  assert.ok(withNoe.length >= 8, "densify may attach additional NOE URLs");
  assert.ok(withNoe.every(exam => exam.fee != null && exam.salary_min != null));
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

test("new-hire notices parse, sort newest-first, and refine without a gatekeeping search", () => {
  const rows = [
    {
      request_id: "2",
      start_date: "2026-07-29T00:00:00.000",
      agency_name: "Sanitation",
      additional_description_1: "Effective Date: 07/20/2026; Provisional Status: Yes; Title Code: 53053; Reason For Change: APPOINTED; Salary: 49047.00; Employee Name: RIVERA,ANA",
    },
    {
      request_id: "1",
      start_date: "2026-07-28T00:00:00.000",
      agency_name: "Health",
      additional_description_1: "Effective Date: 07/19/2026; Provisional Status: No; Title Code: 10026; Reason For Change: APPOINTED; Salary: 77744.00; Employee Name: RODRIGUEZ,LUIS",
    },
  ];
  const notices = Staffing.hireNotices(rows, [
    { title_code: "53053", official_title: "EMERGENCY MEDICAL SPECIALIST-EMT" },
    { title_code: "10026", official_title: "ADMINISTRATIVE STAFF ANALYST" },
  ]);
  assert.deepEqual(notices.map(item => item.request_id), ["2", "1"]);
  assert.equal(Staffing.filterHireNotices(notices, {}).length, 2);
  assert.deepEqual(
    Staffing.filterHireNotices(notices, { query: "Rodriguez" }).map(item => item.request_id),
    ["1"],
  );
  assert.deepEqual(Staffing.topValues(notices, "agency", 1), ["Health"]);
});

test("the Staffing lens features the next actionable exams without runtime data fan-out", () => {
  const today = "2026-07-28";
  const featured = Staffing.featuredExams(artifact.exams, today, 4);
  assert.deepEqual(featured.map(exam => exam.exam_number), ["6125", "6126", "7006", "7013"]);
  assert.ok(featured.every(exam => exam.eligibility === "open_competitive"));
  assert.ok(featured.every(exam => ["open", "upcoming"].includes(Staffing.statusFor(exam, today))));
  assert.match(html, /id="staffing-upcoming-list"/);
  assert.match(html, /href="#people\?view=guide"/);
  assert.match(html, /id="staffing-feed"/);
});

test("the Staffing landing is a notice feed, with search and filters refining visible postings", () => {
  const feed = html.indexOf('id="staffing-feed"');
  const guide = html.indexOf('id="career-guide"');
  assert.ok(feed >= 0, "Staffing needs a first-class newest-notices feed");
  assert.ok(guide > feed, "the exam guide must follow the live notice feed");
  assert.match(html, /id="staffing-query"/);
  assert.match(html, /data-staffing-type="hire"/);
  assert.match(html, /data-staffing-type="exam"/);
  assert.match(html, /id="staffing-role-filters"/);
  assert.match(html, /id="staffing-agency-filters"/);
  assert.match(html, /id="staffing-notice-list"/);
  assert.match(html, /id="staffing-exam-help"/);
  assert.match(html, /<div class="career-guide" id="career-guide" hidden>/);
});

test("actionable exam titles connect Staffing role rows to exact exam details", () => {
  const today = "2026-07-28";
  assert.equal(Staffing.examForTitle(artifact.exams, "CASEWORKER", today)?.exam_number, "7016");
  assert.equal(Staffing.examForTitle(artifact.exams, "Emergency Medical Specialist - EMT", today)?.exam_number, "6125");
  assert.equal(Staffing.examForTitle(artifact.exams, "Unrelated title", today), null);
  assert.match(html, /class="staffing-exam-link" href="#exam\//);
  assert.match(html, /staffing_view_exam_detail/);
});

test("exam mode renders staffingExamCardHTML when items exist (not a redirect-only panel)", () => {
  // Role chips + staffingVisibleItems() can yield N exams while export still shipped N rows;
  // the list must map those items to exam cards, never staffing-exam-redirect when N>0.
  assert.match(html, /function staffingExamCardHTML\s*\(/);
  assert.match(
    html,
    /items\.map\(item=>item\.kind==="exam"\?staffingExamCardHTML\(item\):staffingHireRowHTML\(item\)\)/,
  );
  assert.match(html, /staffing-notice-card" data-kind="exam"/);
  assert.match(html, /#exam\/\$\{encodeURIComponent\(exam\.exam_number\)\}/);
  // Non-empty results must never take the redirect-only path.
  assert.doesNotMatch(
    html,
    /staffing-notice-list"\)\.innerHTML=`<div class="staffing-exam-redirect"/,
  );
  assert.doesNotMatch(
    html,
    /if\(isExam\)\{\s*const items=staffingVisibleItems\(\);\s*\$\("#staffing-result-count"\)\.textContent=t\("staffing_exam_count"/,
  );

  const today = "2026-07-28";
  const title = "Police Communications Technician";
  const featured = Staffing.featuredExams(artifact.exams, today, artifact.exams.length);
  const roleMatches = featured.filter((exam) => exam.title === title);
  assert.equal(roleMatches.length, 4, "fixture role used by deep-link repro must stay discoverable");
  assert.ok(roleMatches.every((exam) => exam.exam_number));
});

test("source staleness is derived from the recorded cadence", () => {
  const current = artifact.sources.find(source => source.id === "dcas-open-competitive");
  assert.equal(Staffing.sourceIsStale(current, "2026-08-31"), false);
  assert.equal(Staffing.sourceIsStale(current, "2026-09-02"), true);
});
