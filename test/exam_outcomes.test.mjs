import { SITE_SOURCE } from "./helpers/site_source.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import {
  assertSourceFresh,
  buildArtifact,
  joinOutcomeOntoExam,
  outcomesByExamNumber,
} from "../tools/build_staffing_exams.mjs";

const require = createRequire(import.meta.url);
const Staffing = require("../site/staffing.js");
const artifact = JSON.parse(readFileSync(new URL("../site/data/staffing_exams.json", import.meta.url)));
const html = SITE_SOURCE;
const i18n = readFileSync(new URL("../site/i18n.js", import.meta.url), "utf8");
const contracts = JSON.parse(readFileSync(new URL("../site/data/source_contracts.json", import.meta.url)));

function source(id = "dcas-annual-schedule", overrides = {}) {
  return {
    id,
    name: id,
    fetched_at: "2026-07-28",
    stale_after_days: 60,
    ...overrides,
  };
}

const outcomeSource = {
  id: "dcas-annual-exam-outcomes",
  name: "DCAS annual outcomes",
  data_publication_date: "2026-07-28",
  fetched_at: "2026-07-28",
  stale_after_days: 365,
};


test("artifact includes a separate aggregate outcomes source", () => {
  assert.equal(artifact.outcomes?.source?.id, "dcas-annual-exam-outcomes");
  assert.equal(Array.isArray(artifact.outcomes.records), true);
  assert.equal(typeof artifact.outcomes.summary?.count, "number");
  assert.equal(artifact.outcomes.summary.count, artifact.outcomes.records.length);

  for (const row of artifact.outcomes.records) {
    assert.equal(typeof row.applicant_count, "number");
    assert.equal(typeof row.list_establishment, "number");
    assert.equal(typeof row.certification_count, "number");
    assert.equal(typeof row.appointment_count, "number");
    assert.equal(typeof row.hire_count, "number");
    assert.match(row.exam_number, /^\d{4}$/);
  }

  assert.deepEqual(
    artifact.outcomes.records.every((row) => Object.keys(row).every((key) => !/name|title|agency|person/i.test(key))),
    true,
    "outcomes records must be aggregate-only and exclude applicant-level identifiers",
  );
});

/** Real field cases from the committed outcomes snapshot (cycle-coherent closed exams). */
const JOINED_FIELD_CASES = {
  "6311": {
    applicant_count: 1280,
    list_establishment: 1010,
    certification_count: 74,
    hire_count: 68,
  },
  "6073": {
    applicant_count: 910,
    list_establishment: 770,
    certification_count: 58,
    hire_count: 40,
  },
};

const PENDING_FIELD_CASES = ["7013", "7016", "7331"];

test("every exam carries a build-time outcome join, list depth, or an explicit class-(a) gap", () => {
  assert.ok(artifact.exams.length > 0);
  for (const exam of artifact.exams) {
    if (exam.outcome) {
      assert.equal(exam.outcome_gap, null, exam.exam_number);
      assert.equal(typeof exam.outcome.list_establishment, "number");
      assert.equal(typeof exam.outcome.certification_count, "number");
      assert.equal(typeof exam.outcome.hire_count, "number");
      assert.equal(
        Object.keys(exam.outcome).some((key) => /name|title|agency|person/i.test(key)),
        false,
        "joined outcome must stay aggregate-only",
      );
    } else if (exam.list_aggregate && Number(exam.list_aggregate.list_count) > 0) {
      assert.equal(exam.outcome, null);
      assert.equal(exam.outcome_gap, null, exam.exam_number);
      assert.equal(typeof exam.list_aggregate.list_count, "number");
    } else {
      assert.equal(exam.outcome, null);
      // Public annual + list sources exist — never class-(b) for aggregate depth.
      assert.equal(exam.outcome_gap?.class, "not_yet_ingested", exam.exam_number);
      assert.equal(exam.outcome_gap?.pending_stage, "list_establishment", exam.exam_number);
    }
  }
});

test("characterization: acceptance exams join real outcomes by exam_number", () => {
  for (const [examNumber, expected] of Object.entries(JOINED_FIELD_CASES)) {
    const exam = artifact.exams.find((row) => row.exam_number === examNumber);
    assert.ok(exam, `missing exam ${examNumber}`);
    assert.ok(exam.outcome, `${examNumber} must join outcomes`);
    assert.equal(exam.outcome.applicant_count, expected.applicant_count);
    assert.equal(exam.outcome.list_establishment, expected.list_establishment);
    assert.equal(exam.outcome.certification_count, expected.certification_count);
    assert.equal(exam.outcome.hire_count, expected.hire_count);
    const view = Staffing.examOutcomeView(exam);
    assert.equal(view.kind, "joined");
    assert.equal(view.list_establishment, expected.list_establishment);
    assert.equal(view.certification_count, expected.certification_count);
  }
});

test("characterization: open exams without annual or list rows use class-(a) not-yet-ingested", () => {
  for (const examNumber of PENDING_FIELD_CASES) {
    const exam = artifact.exams.find((row) => row.exam_number === examNumber);
    assert.ok(exam, `missing exam ${examNumber}`);
    assert.equal(exam.outcome, null);
    assert.equal(exam.list_aggregate, null);
    assert.equal(exam.outcome_gap.class, "not_yet_ingested");
    assert.equal(exam.outcome_gap.pending_stage, "list_establishment");
    const view = Staffing.examOutcomeView(exam);
    assert.equal(view.kind, "not_yet_ingested");
    assert.equal(view.pending_stage, "list_establishment");
  }
});

test("characterization: closed exam has non-null list_aggregate from Civil Service List", () => {
  const withList = artifact.exams.filter(
    (row) => row.list_aggregate && Number(row.list_aggregate.list_count) > 0,
  );
  assert.ok(withList.length >= 1, "at least one exam must join list aggregates");
  // Field case: Auto Body Worker (6024) — closed FY26 exam with measured list presence.
  const exam = artifact.exams.find((row) => row.exam_number === "6024") || withList[0];
  assert.ok(exam.list_aggregate.list_count > 0);
  assert.equal(exam.outcome_gap, null);
  const view = Staffing.examOutcomeView(exam);
  assert.equal(view.kind, "list_joined");
  assert.equal(view.list_count, exam.list_aggregate.list_count);
  assert.equal(
    Object.keys(exam.list_aggregate).some((key) => /name|person|rank/i.test(key)),
    false,
    "list aggregate must stay privacy-safe",
  );
});

test("join helpers prefer the latest published_on when exam_number collides across cycles", () => {
  const map = outcomesByExamNumber([
    {
      exam_number: "9001",
      application_cycle: "2025",
      applicant_count: 10,
      list_establishment: 8,
      certification_count: 2,
      appointment_count: 1,
      hire_count: 1,
      published_on: "2025-01-01",
    },
    {
      exam_number: "9001",
      application_cycle: "2026",
      applicant_count: 20,
      list_establishment: 15,
      certification_count: 4,
      appointment_count: 3,
      hire_count: 3,
      published_on: "2026-07-01",
    },
  ]);
  assert.equal(map.get("9001").application_cycle, "2026");
  assert.equal(map.get("9001").hire_count, 3);
  const joined = joinOutcomeOntoExam({ exam_number: "9001", title: "Sample" }, map);
  assert.equal(joined.outcome.hire_count, 3);
  assert.equal(joined.outcome_gap, null);
  const missing = joinOutcomeOntoExam({ exam_number: "9999", title: "Open" }, map);
  assert.equal(missing.outcome, null);
  // Standalone annual miss is provisional class-(a); full path uses list join first.
  assert.equal(missing.outcome_gap.class, "not_yet_ingested");
});

test("exam cards and detail render joined, list_joined, or class-(a) not-yet-ingested", () => {
  assert.match(html, /function careerOutcomeHTML\(exam/);
  assert.match(html, /function examProcessSpineHTML/);
  assert.match(html, /career-outcomes/);
  assert.match(html, /data-outcome="joined"/);
  assert.match(html, /data-outcome="list_joined"/);
  assert.match(html, /data-outcome="not_yet_ingested"/);
  assert.match(html, /career_outcomes_not_yet_ingested_html/);
  assert.match(html, /career_outcome_list_established/);
  assert.match(html, /career_outcome_hiring_pool/);
  assert.match(html, /CrolStaffing\.examOutcomeView/);
  // Outcome block + process spine are inside the card template (list + detail share careerCardHTML).
  const cardFnStart = html.indexOf("function careerCardHTML(exam)");
  const cardFnEnd = html.indexOf("function careerInterestContextHTML", cardFnStart);
  const cardFn = html.slice(cardFnStart, cardFnEnd);
  assert.ok(cardFn.includes("careerOutcomeHTML(exam"));
  assert.ok(cardFn.includes("examProcessSpineHTML"));
  assert.match(i18n, /career_outcomes_not_yet_ingested_html:/);
  assert.match(i18n, /Not yet shown here — post-cycle aggregates/);
  // Must not render the false class-(b) city-withhold register for aggregate gaps.
  assert.doesNotMatch(html, /data-outcome="not_published"/);
});

test("source contract documents the exam_number join and card surfaces", () => {
  const contract = contracts.contracts.find((item) => item.id === "dcas-annual-exam-outcomes");
  assert.ok(contract);
  assert.deepEqual(contract.join_keys, ["exam_number"]);
  assert.match(contract.used_for, /exam cards/i);
  assert.equal(contract.delivery_tier, "inline-at-build");
  assert.ok(contract.code_references.some((ref) => ref.path === "staffing.js"));
  assert.ok(contract.code_references.some((ref) => ref.path === "site/app/people.mjs"));
});

test("contracted outcome source freshness must fail after staleness window", () => {
  assert.doesNotThrow(() => assertSourceFresh(outcomeSource, "2026-08-15"));
  assert.throws(
    () => assertSourceFresh({ ...outcomeSource, fetched_at: "2024-01-01" }, "2026-08-15"),
    /is stale/, 
  );
});

test("annual/current updates detect amendments and withdrawals", () => {
  const annual = {
    source: source("dcas-annual-schedule"),
    records: [{
      exam_title: "EMT Sample",
      exam_number: "9000",
      application_period_start: "2026-06-01",
      application_period_end_date: "2026-07-01",
      title_code: "53053",
      open_competitive_promotion: "",
      application_notes: "",
    }],
  };

  const current = {
    source: source("dcas-open-competitive"),
    records: [{
      exam_number: "9000",
      title_code: "53053",
      title: "EMT Sample",
      application_start: "2026-06-01",
      application_end: "2026-08-01",
      notice_url: "https://example.com/noe-9000",
      fee: 1,
      salary_min: 1,
    }],
  };

  const unchangedWithdrawn = buildArtifact({
    annual: {
      ...annual,
      source: source("dcas-annual-schedule", {
        stale_after_days: 365,
      }),
    },
    current,
    activeList: {
      source: source("dcas-active-civil-service-list", { stale_after_days: 3 }),
      summary: {},
    },
    cityRecord: {
      source: source("city-record-exam-check", { stale_after_days: 3 }),
      summary: {},
    },
    outcomes: {
      source: { ...outcomeSource, fetched_at: "2026-07-28", data_publication_date: "2026-07-28" },
      records: [{
        exam_number: "9000",
        application_cycle: "2026",
        applicant_count: 1,
        list_establishment: 1,
        certification_count: 1,
        appointment_count: 1,
        hire_count: 1,
      }],
    },
    priorArtifact: {
      exams: [
        {
          exam_number: "9000",
          title: "EMT Sample",
          application_start: "2026-06-01",
          application_end: "2026-07-01",
          schedule_status: "scheduled",
          title_code: "53053",
          sources: ["dcas-annual-schedule"],
          interest_area: "other",
          eligibility: "open_competitive",
        },
        {
          exam_number: "8000",
          title: "Disappeared Exam",
          application_start: "2026-06-01",
          application_end: "2026-12-31",
        schedule_status: "scheduled",
        title_code: "90001",
          sources: ["dcas-annual-schedule"],
          interest_area: "other",
          eligibility: "open_competitive",
        },
      ],
    },
    today: "2026-07-28",
  });

  const withdrawn = unchangedWithdrawn.exams.find((exam) => exam.exam_number === "8000");
  assert.equal(withdrawn.schedule_status, "canceled");
  assert.match(withdrawn.amendment, /withdrawn/);

  const amended = unchangedWithdrawn.exams.find((exam) => exam.exam_number === "9000");
  assert.match(amended.amendment || "", /application end date changed from 2026-07-01 to 2026-08-01/);
});
