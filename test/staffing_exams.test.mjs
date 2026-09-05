import { SITE_SOURCE } from "./helpers/site_source.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { STAFFING_EXAMS_SCHEMA_VERSION, staffingSourcesRetrievedAsOf } from "../tools/build_staffing_exams.mjs";

const require = createRequire(import.meta.url);
const Staffing = require("../site/staffing.js");
const artifact = JSON.parse(readFileSync(new URL("../site/data/staffing_exams.json", import.meta.url)));
const openCompetitive = JSON.parse(readFileSync(new URL("../site/data/exam_sources/dcas_open_competitive.json", import.meta.url)));
const html = SITE_SOURCE;
// Hermetic byte-stable rebuild must use the same open-window clock the artifact was built with.
const FIXTURE_TODAY = artifact.open_window_as_of || artifact.generated_at || "2026-08-02";

test("precomputed staffing artifact is reproducible from committed source snapshots", () => {
  execFileSync(process.execPath, ["tools/build_staffing_exams.mjs", "--check", `--today=${FIXTURE_TODAY}`], {
    cwd: new URL("..", import.meta.url),
    stdio: "pipe",
  });
});

test("staffing artifact stamps honest list and open-window freshness clocks", () => {
  assert.ok(artifact.open_window_as_of || artifact.generated_at);
  // After refresh tooling lands, both stamps are required; tolerate one rebuild cycle
  // for branches that only carry the gate helpers before materializing.
  if (artifact.list_current_as_of) {
    assert.match(artifact.list_current_as_of, /^\d{4}-\d{2}-\d{2}$/);
    assert.match(String(artifact.data_current_as_of || ""), /^\d{4}-\d{2}-\d{2}$/);
  }
});

test("the acquisition vintage equals the newest retrieval stamp among the disclosed sources", () => {
  assert.equal(
    artifact.sources_retrieved_as_of,
    staffingSourcesRetrievedAsOf(artifact.sources),
    "the stamped vintage must be derivable from the artifact's own source list",
  );
  assert.match(String(artifact.sources_retrieved_as_of), /^\d{4}-\d{2}-\d{2}$/);

  const retrievalStamps = artifact.sources
    .flatMap((source) => [source.fetched_at, source.verified_at, source.observed_on])
    .filter(Boolean)
    .map((value) => String(value).slice(0, 10));
  assert.ok(retrievalStamps.length, "sources must disclose retrieval stamps");
  assert.equal(artifact.sources_retrieved_as_of, retrievalStamps.sort().at(-1));

  // Publisher claims about the data are not records of when the project fetched it.
  const publisherClaims = [
    ...artifact.sources.map((source) => source.data_publication_date),
    ...artifact.sources.map((source) => source.data_current_as_of),
  ].filter(Boolean);
  const fabricated = [...artifact.sources.map((s) => ({ ...s })), {
    id: "hypothetical-future-publication",
    data_publication_date: "2099-01-01",
    data_current_as_of: "2099-01-01",
  }];
  assert.equal(
    staffingSourcesRetrievedAsOf(fabricated),
    artifact.sources_retrieved_as_of,
    `publisher dates (${publisherClaims.length} present) must never advance the acquisition vintage`,
  );
});

test("the acquisition vintage moves with a refresh while the upstream publication clocks hold", () => {
  const refreshed = artifact.sources.map((source) => (
    source.fetched_at ? { ...source, fetched_at: "2027-03-04" } : source
  ));
  assert.equal(staffingSourcesRetrievedAsOf(refreshed), "2027-03-04");
  // data_current_as_of / list_current_as_of track DCAS establishing an eligible list,
  // which can pause for weeks. A refresh cannot move them, so they can only ever lag
  // the retrieval vintage — never lead it — and cannot measure refresh freshness.
  assert.ok(
    artifact.data_current_as_of <= artifact.sources_retrieved_as_of,
    "an upstream publication clock can never be newer than the fetch that observed it",
  );
  assert.ok(
    artifact.annual_schedule_current_as_of <= artifact.sources_retrieved_as_of,
  );
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
    assert.match(Staffing.examUrl(exam.exam_number), new RegExp(`/exams/${exam.exam_number}/$`));
  }
});

test("the current DCAS page contributes actionable NOEs without inventing City Record exams", () => {
  // The published cohort rolls monthly, so the assertions describe the join
  // rather than one release: every exam the schedule page links must reach the
  // artifact carrying that notice, and nothing may arrive from the negative
  // control instead.
  const openCompetitiveNoe = artifact.exams.filter(
    (exam) => exam.notice_url && (exam.sources || []).includes("dcas-open-competitive"),
  );
  const linkedOnPage = openCompetitive.records.filter((row) => row.notice_url);
  assert.ok(linkedOnPage.length > 0, "the schedule page still links Notices of Examination");
  for (const row of linkedOnPage) {
    assert.ok(
      openCompetitiveNoe.some((exam) => exam.exam_number === String(row.exam_number)),
      `${row.exam_number} must reach the artifact with its notice`,
    );
  }
  assert.ok(openCompetitiveNoe.every(exam => exam.fee != null));
  const withNoe = artifact.exams.filter(exam => exam.notice_url);
  assert.ok(withNoe.length >= linkedOnPage.length, "densify may attach additional NOE URLs");
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

test("continuous and walk-in exams follow open and upcoming windows", () => {
  const fixture = [
    { exam_number: "1", title: "Open", application_start: "2026-08-01", application_end: "2026-08-10" },
    { exam_number: "2", title: "Upcoming", application_start: "2026-09-01", application_end: "2026-09-10" },
    { exam_number: "3", title: "Walk-in", application_mode: "walk-in" },
    { exam_number: "4", title: "Continuous", filing_method: "continuous" },
  ];
  const rows = Staffing.filterExams(fixture, { window: "actionable" }, "2026-08-03");
  assert.deepEqual(rows.map(exam => exam.exam_number), ["1", "2", "4", "3"]);
  assert.equal(Staffing.isContinuousExam(fixture[2]), true);
});

test("exam cards reuse the approved open-window bands and thresholds", () => {
  const today="2026-08-03";
  assert.equal(Staffing.openWindowBand({application_start:"2026-08-10",application_end:"2026-08-20"},today),"imminent");
  assert.equal(Staffing.openWindowBand({application_start:"2026-10-01",application_end:"2026-10-15"},today),"approaching");
  assert.equal(Staffing.openWindowBand({application_start:"2026-11-02",application_end:"2026-11-16"},today),"far");
  assert.match(html,/data-open-window-band/);
  assert.match(html,/data-noe-state="posted"/);
  assert.match(html,/data-follow-exam-area/);
  assert.doesNotMatch(html,/career_noe_pending/);
  assert.doesNotMatch(html,/no NOE|NOE.*not available/i);
  assert.deepEqual(Staffing.titleCodeFamilyView({ title_code: "20210" }), {
    code: "20210",
    confidence: "publisher",
    label: "Publisher-issued title code",
    marker: null,
  });
  assert.deepEqual(Staffing.titleCodeFamilyView({ title_code_family: "20210" }), {
    code: "20210",
    confidence: "inferred",
    label: "Likely title family",
    marker: "quiet",
  });
  assert.match(html, /data-title-code-confidence/);
  assert.match(html, /career-confidence-marker/);
});

test("the interest filter owns one compact subscribe context", () => {
  assert.doesNotMatch(html, /id="career-area-watches"|class="career-area-watch"/);
  assert.match(html, /id="career-interest-context"/);
  assert.match(html, /data-interest-context/);
  assert.match(html, /data-follow-exam-area/);
  assert.match(html, /data-open-window-band/);
  assert.match(html, /data-noe-state="posted"/);
});

test("the Staffing source line omits refresh-policy debug copy", () => {
  const sourceStart = html.indexOf("function careerSourceHTML()");
  const sourceEnd = html.indexOf("function careerCount", sourceStart);
  const source = html.slice(sourceStart, sourceEnd);
  assert.doesNotMatch(source, /<details>|refresh_cadence|career_source_details|career_city_record_finding/);
  assert.doesNotMatch(html, /Sources and refresh rules/);
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

test("the Staffing lens ranks actionable exams without runtime data fan-out", () => {
  const today = FIXTURE_TODAY;
  const featured = Staffing.featuredExams(artifact.exams, today, 4);
  assert.equal(featured.length, 4);
  // Ranking is a pure function of the artifact, so the same input must give
  // the same order every time rather than a particular release's exam numbers.
  assert.deepEqual(
    featured.map(exam => exam.exam_number),
    Staffing.featuredExams(artifact.exams, today, 4).map(exam => exam.exam_number),
  );
  assert.equal(new Set(featured.map(exam => exam.exam_number)).size, featured.length);
  assert.ok(featured.every(exam => exam.eligibility === "open_competitive"));
  assert.ok(featured.every(exam => ["open", "upcoming"].includes(Staffing.statusFor(exam, today))));
  assert.match(html, /id="career-results"/);
  assert.match(html, /function careerResultsHTML\(exams\)/);
  assert.match(html, /id="staffing-feed"/);
});

test("the exam guide paints core rows independently of optional spine enrichment", () => {
  const loader = html.slice(html.indexOf("async function loadCareerGuide()"), html.indexOf("function paintExamDetailShell"));
  assert.match(loader, /data=await fetchCareerData\(\)/);
  assert.match(loader, /await paintCareerData\(data\)/);
  assert.match(loader, /await hydrateCareerSpineTools\(data\)/);
  assert.ok(
    loader.indexOf("await paintCareerData(data)") < loader.indexOf("await hydrateCareerSpineTools(data)"),
    "real exam rows must paint before optional process-spine modules hydrate",
  );
  assert.match(html, /const CAREER_LOAD_ATTEMPTS = 2/);
  assert.match(loader, /careerLoadPromise=null/);
});

test("Exams owns its guide and Staffing keeps the appointment ledger reachable", () => {
  const exams = html.slice(html.indexOf('id="tab-exams"'), html.indexOf('id="tab-alerts"'));
  const staffing = html.slice(html.indexOf('id="tab-staffing"'), html.indexOf('id="tab-land"'));
  assert.match(exams, /<div class="career-guide" id="career-guide">/);
  assert.doesNotMatch(staffing, /id="career-guide"/);
  assert.match(staffing, /id="staffing-feed"/);
  assert.match(staffing, /id="staffing-query"/);
  assert.match(staffing, /id="staffing-role-filters"/);
  assert.match(staffing, /id="staffing-agency-filters"/);
  assert.match(staffing, /id="staffing-notice-list"/);
  assert.match(staffing, /<details class="staffing-ledger" id="staffing-ledger" open>/);
});

test("actionable exam titles connect Staffing role rows to exact exam details", () => {
  const today = FIXTURE_TODAY;
  const actionable = Staffing.featuredExams(artifact.exams, today, artifact.exams.length);
  assert.ok(actionable.length > 0, "the schedule still has actionable exams");
  const sample = actionable[0];
  // The title lookup is case-insensitive and must resolve to an actionable exam.
  const matched = Staffing.examForTitle(artifact.exams, sample.title.toUpperCase(), today);
  assert.ok(matched, `${sample.title} must resolve to an exam`);
  assert.equal(matched.title, sample.title);
  assert.ok(["open", "upcoming"].includes(Staffing.statusFor(matched, today)));
  assert.equal(Staffing.examForTitle(artifact.exams, "Unrelated title", today), null);
  assert.match(html, /class="staffing-exam-link" href="\$\{CrolStaffing\.examUrl\(/);
  assert.match(html, /staffing_view_exam_detail/);
});

test("repeated actionable titles retain distinct exam deep links", () => {
  const today = "2026-07-28";
  const title = "Police Communications Technician";
  const featured = Staffing.featuredExams(artifact.exams, today, artifact.exams.length);
  const roleMatches = featured.filter((exam) => exam.title === title);
  assert.equal(roleMatches.length, 4, "fixture role used by deep-link repro must stay discoverable");
  assert.ok(roleMatches.every((exam) => exam.exam_number));
});

test("source staleness is derived from the recorded cadence", () => {
  const current = artifact.sources.find(source => source.id === "dcas-open-competitive");
  const verified = Date.parse(`${current.verified_at}T00:00:00Z`);
  const day = (offset) => new Date(verified + offset * 86_400_000).toISOString().slice(0, 10);
  // The window is read from the source's own cadence, not a fixed calendar date.
  assert.ok(current.stale_after_days > 0);
  assert.equal(Staffing.sourceIsStale(current, day(current.stale_after_days - 1)), false);
  assert.equal(Staffing.sourceIsStale(current, day(current.stale_after_days + 1)), true);
});
