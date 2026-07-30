import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  assertSourceFresh,
  buildArtifact,
} from "../tools/build_staffing_exams.mjs";

const artifact = JSON.parse(readFileSync(new URL("../data/staffing_exams.json", import.meta.url)));

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
