import { SITE_SOURCE } from "./helpers/site_source.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";

const require = createRequire(import.meta.url);
const Staffing = require("../site/staffing.js");
const artifact = JSON.parse(readFileSync(new URL("../site/data/staffing_exams.json", import.meta.url)));
const receipt = JSON.parse(
  readFileSync(new URL("../site/data/exam_sources/verification_receipts/dcas_open_competitive_2026-07-29.json", import.meta.url)),
);
const contracts = JSON.parse(readFileSync(new URL("../site/data/source_contracts.json", import.meta.url)));
const html = SITE_SOURCE;
const examSourceReadme = readFileSync(new URL("../site/data/exam_sources/README.md", import.meta.url), "utf8");

/** Five current open exams used as the acceptance set for deadline-first cards. */
const ACCEPTANCE = {
  "6125": {
    title: "Emergency Medical Specialist - EMT (Fire)",
    application_end: "2026-08-07",
    fee: 30,
    fee_waiver:
      "Veterans, unemployed applicants, and applicants receiving public assistance or Supplemental Security Income may qualify under this NOE.",
    qualifications:
      "A high school diploma or equivalent plus a valid New York State EMT-Basic or EMT-Paramedic certificate by the deadline stated in the NOE.",
    notice_url: "https://www.nyc.gov/assets/dcas/downloads/pdf/noes/20266125000.pdf",
    interest_area: "health-care",
  },
  "7006": {
    title: "Assistant Civil Engineer",
    application_end: "2026-08-25",
    fee: 82,
    fee_waiver:
      "Veterans, unemployed applicants, NYC high school students, first-time test takers, and applicants receiving public assistance or Supplemental Security Income may qualify.",
    qualifications:
      "The NOE lists several paths, including a civil engineering degree plus experience or specified graduate study.",
    notice_url: "https://www.nyc.gov/assets/dcas/downloads/pdf/noes/20277006000.pdf",
    interest_area: "engineering-construction",
  },
  "7013": {
    title: "Automotive Service Worker",
    application_end: "2026-08-25",
    fee: 61,
    fee_waiver:
      "Veterans, unemployed applicants, NYC high school students, first-time test takers, and applicants receiving public assistance or Supplemental Security Income may qualify.",
    qualifications:
      "Two years of automotive maintenance experience, relevant trade or technical education, an associate degree in automotive technology, or an allowed combination.",
    notice_url: "https://www.nyc.gov/assets/dcas/downloads/pdf/noes/20277013000.pdf",
    interest_area: "trades-operations",
  },
  "7016": {
    title: "Caseworker",
    application_end: "2026-08-25",
    fee: 68,
    fee_waiver:
      "Veterans, unemployed applicants, NYC high school students, first-time test takers, and applicants receiving public assistance or Supplemental Security Income may qualify.",
    qualifications: "A bachelor's degree from an accredited college or university.",
    notice_url: "https://www.nyc.gov/assets/dcas/downloads/pdf/noes/20277016000.pdf",
    interest_area: "community-social-services",
  },
  "7331": {
    title: "Traffic Enforcement Agent",
    application_end: "2026-08-25",
    fee: 0,
    fee_waiver: "No application fee is charged for this exam.",
    qualifications:
      "A high school diploma or equivalent, plus the license, medical, psychological, and screening requirements in the NOE.",
    notice_url: "https://www.nyc.gov/assets/dcas/downloads/pdf/noes/20277331000.pdf",
    interest_area: "public-safety",
  },
};

const TODAY = "2026-07-29";

test("source contract names the open-competitive schedule and update semantics", () => {
  const contract = contracts.contracts.find(item => item.id === "dcas-exam-notices");
  assert.ok(contract, "dcas-exam-notices contract must exist");
  assert.equal(
    contract.landing_page,
    "https://www.nyc.gov/site/dcas/employment/exam-schedules-open-competitive-exams.page",
  );
  assert.equal(contract.application_handoff, Staffing.OASY_APPLY_URL);
  assert.match(contract.update_semantics, /open-competitive schedule page is authoritative/i);
  assert.match(contract.publisher_cadence, /daily/i);
  assert.ok(contract.related_contract_ids.includes("annual-examination-schedule"));
  assert.ok(contract.related_contract_ids.includes("dcas-annual-exam-outcomes"));
  assert.match(examSourceReadme, /Authoritative feed \(open windows\)/);
  assert.match(examSourceReadme, /verification_receipts/);
});

test("live verification receipt matches the committed open-competitive snapshot", () => {
  assert.equal(receipt.source_contract_id, "dcas-exam-notices");
  assert.equal(receipt.snapshot_match, true);
  assert.equal(receipt.http_status, 200);
  assert.deepEqual(
    receipt.acceptance_exam_numbers.slice().sort(),
    Object.keys(ACCEPTANCE).sort(),
  );
  assert.equal(
    receipt.ingested_by_exam_freshness_work.open_competitive_snapshot,
    "data/exam_sources/dcas_open_competitive.json",
  );
  assert.equal(
    receipt.application_handoff.public_url,
    Staffing.OASY_APPLY_URL,
  );
  for (const observed of receipt.observed_exams) {
    assert.equal(observed.present_on_page, true, observed.exam_number);
    assert.equal(observed.dates_match, true, observed.exam_number);
    assert.equal(observed.noe_path_present, true, observed.exam_number);
  }
});

test("acceptance exams carry verbatim qualifications, waivers, fees, and NOE links", () => {
  for (const [examNumber, expected] of Object.entries(ACCEPTANCE)) {
    const exam = artifact.exams.find(item => item.exam_number === examNumber);
    assert.ok(exam, `missing exam ${examNumber}`);
    assert.equal(exam.title, expected.title);
    assert.equal(exam.application_end, expected.application_end);
    assert.equal(exam.fee, expected.fee);
    assert.equal(exam.fee_waiver, expected.fee_waiver);
    assert.equal(exam.qualifications, expected.qualifications);
    assert.equal(exam.notice_url, expected.notice_url);
    assert.equal(exam.interest_area, expected.interest_area);
    assert.equal(Staffing.statusFor(exam, TODAY), "open");
    assert.ok(exam.sources.includes("dcas-open-competitive") || exam.sources.includes("dcas-noe"));
  }
});

test("open exams sort deadline-first, with acceptance set in order", () => {
  const open = Staffing.filterExams(artifact.exams, {
    query: "",
    interest: "all",
    eligibility: "open_competitive",
    window: "open",
  }, TODAY);
  assert.ok(open.length >= 5);
  for (let i = 1; i < open.length; i += 1) {
    assert.ok(
      open[i - 1].application_end <= open[i].application_end,
      `${open[i - 1].exam_number} should not sort after ${open[i].exam_number}`,
    );
  }
  const acceptanceOrder = open
    .map(exam => exam.exam_number)
    .filter(number => ACCEPTANCE[number]);
  assert.deepEqual(acceptanceOrder, ["6125", "7006", "7013", "7016", "7331"]);
  assert.equal(Staffing.applicationDaysLeft("2026-08-07", TODAY), 9);
  assert.equal(Staffing.applicationDaysLeft("2026-08-25", TODAY), 27);
  assert.equal(Staffing.applicationDaysLeft("2026-07-29", TODAY), 0);
});

test("declarative interest routing never invents identity; engineering filter is exact", () => {
  assert.equal(Staffing.isInterestArea("engineering-construction"), true);
  assert.equal(Staffing.isInterestArea("civil-engineering exams"), false);
  assert.equal(Staffing.isInterestArea("profile:james"), false);

  const engineering = Staffing.filterExams(artifact.exams, {
    query: "",
    interest: "engineering-construction",
    eligibility: "open_competitive",
    window: "open",
  }, TODAY);
  assert.ok(engineering.some(exam => exam.exam_number === "7006"));
  assert.ok(engineering.every(exam => exam.interest_area === "engineering-construction"));

  // Variant fixture: interest filter plus keyword still stays attribute-based.
  const civil = Staffing.filterExams(artifact.exams, {
    query: "civil",
    interest: "engineering-construction",
    eligibility: "open_competitive",
    window: "open",
  }, TODAY);
  assert.deepEqual(civil.map(exam => exam.exam_number), ["7006"]);
});

test("deadline-first card markup leads with the deadline and keeps OASys + NOE actions", () => {
  assert.match(html, /class="career-deadline-lead"/);
  assert.match(html, /career-deadline-primary/);
  assert.match(html, /career-deadline-countdown/);
  assert.match(html, /career-action-facts/);
  assert.match(html, /examListForecastHTML/);
  assert.match(html, /applicationDaysLeft/);
  assert.match(html, /CrolStaffing\.OASY_APPLY_URL/);
  assert.match(html, /careerRouteFilters/);
  assert.match(html, /q\.set\("interest"/);
  assert.match(html, /isInterestArea/);
  // Card structure: deadline lead appears before the title block in the template.
  const cardFnStart = html.indexOf("function careerCardHTML(exam)");
  const cardFn = html.slice(cardFnStart, cardFnStart + 4500);
  assert.ok(cardFn.includes("career-deadline-lead"));
  assert.ok(
    cardFn.indexOf("career-deadline-lead") < cardFn.indexOf("career-card-title"),
    "deadline lead must render before the exam title",
  );
  assert.ok(cardFn.includes("career_qualifications"));
  assert.ok(cardFn.includes("career_fee_waiver"));
  assert.ok(cardFn.includes("career_read_noe"));
  assert.ok(cardFn.includes("career_apply_oasys"));
  assert.ok(cardFn.includes("careerOutcomeHTML"), "cards surface precomputed exam outcomes");
});

test("acceptance cards flip outcome slots from gaps to joined aggregates where published", () => {
  const withOutcomes = ["6125", "7006"];
  // Open exams without annual or list depth: class-(a) not-yet-ingested (public sources exist).
  const withoutOutcomes = ["7013", "7016", "7331"];
  for (const examNumber of withOutcomes) {
    const exam = artifact.exams.find(item => item.exam_number === examNumber);
    assert.ok(exam?.outcome, examNumber);
    assert.equal(Staffing.examOutcomeView(exam).kind, "joined");
  }
  for (const examNumber of withoutOutcomes) {
    const exam = artifact.exams.find(item => item.exam_number === examNumber);
    assert.equal(exam.outcome, null, examNumber);
    assert.equal(Staffing.examOutcomeView(exam).kind, "not_yet_ingested");
  }
  // Closed exam with Civil Service List depth lands list_joined (non-null example).
  const listJoined = artifact.exams.find(item => item.exam_number === "6024");
  assert.ok(listJoined?.list_aggregate?.list_count > 0);
  assert.equal(Staffing.examOutcomeView(listJoined).kind, "list_joined");
});
