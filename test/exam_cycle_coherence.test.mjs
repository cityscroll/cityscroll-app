/**
 * Exam cycle temporal coherence — post-list events inside an open application
 * window are a mis-join class unless continuous filing is explicit.
 *
 *   node --test test/exam_cycle_coherence.test.mjs
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  buildExamProcessSpine,
  examTemporalIncoherence,
  isContinuousFilingExam,
  listAggregateBelongsToExamCycle,
  measureExamTemporalIncoherence,
  outcomeBelongsToExamCycle,
  STAGE_APPOINTMENT,
  STAGE_LIST_ESTABLISHMENT,
} from "../site/exam_process_spine.mjs";
import {
  joinOutcomeOntoExam,
  joinOutcomesAndListOntoExam,
  outcomesByExamNumber,
} from "../tools/build_staffing_exams.mjs";
import { evaluateDataIntegrity } from "../ontology/dimensions/data_integrity.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const artifact = JSON.parse(
  readFileSync(join(ROOT, "site/data/staffing_exams.json"), "utf8"),
);

const OPEN_EMT = {
  exam_number: "6125",
  title: "Emergency Medical Specialist - EMT (Fire)",
  application_start: "2026-06-15",
  application_end: "2026-08-07",
  schedule_status: "scheduled",
};

const MID_WINDOW_OUTCOME = {
  exam_number: "6125",
  application_cycle: "2026",
  applicant_count: 1280,
  list_establishment: 1010,
  certification_count: 74,
  appointment_count: 68,
  hire_count: 68,
  published_on: "2026-07-22",
};

test("outcomeBelongsToExamCycle refuses mid-window post-list for standard exams", () => {
  assert.equal(outcomeBelongsToExamCycle(OPEN_EMT, MID_WINDOW_OUTCOME), false);
  assert.equal(
    outcomeBelongsToExamCycle(
      { ...OPEN_EMT, application_end: "2026-06-01" },
      MID_WINDOW_OUTCOME,
    ),
    true,
  );
  assert.equal(
    outcomeBelongsToExamCycle(
      { ...OPEN_EMT, filing_mode: "continuous" },
      MID_WINDOW_OUTCOME,
    ),
    true,
  );
});

test("listAggregateBelongsToExamCycle refuses list established before app end", () => {
  const list = {
    list_count: 100,
    established_date: "2026-07-01",
    source_id: "dcas-active-civil-service-list",
  };
  assert.equal(listAggregateBelongsToExamCycle(OPEN_EMT, list), false);
  assert.equal(
    listAggregateBelongsToExamCycle(OPEN_EMT, {
      ...list,
      established_date: "2026-09-01",
    }),
    true,
  );
});

test("examTemporalIncoherence flags open 6125-shaped mis-join", () => {
  const bad = {
    ...OPEN_EMT,
    outcome: {
      application_cycle: "2026",
      applicant_count: 1280,
      list_establishment: 1010,
      certification_count: 74,
      appointment_count: 68,
      hire_count: 68,
      published_on: "2026-07-22",
    },
  };
  const hit = examTemporalIncoherence(bad);
  assert.ok(hit);
  assert.equal(hit.class, "exam_cycle_temporal_incoherence");
  assert.equal(hit.exam_number, "6125");
  assert.ok(hit.flags.some((f) => f.reason === "post_list_on_or_before_application_end"));

  assert.equal(examTemporalIncoherence(OPEN_EMT), null);
  assert.equal(
    examTemporalIncoherence({ ...bad, filing_mode: "continuous" }),
    null,
  );
});

test("buildExamProcessSpine drops mid-window outcomes (defense in depth)", () => {
  const spine = buildExamProcessSpine({
    ...OPEN_EMT,
    outcome: {
      application_cycle: "2026",
      list_establishment: 1010,
      certification_count: 74,
      appointment_count: 68,
      hire_count: 68,
      published_on: "2026-07-22",
    },
  });
  assert.equal(spine.join.has_outcome, false);
  assert.equal(spine.join.cycle_rejected.outcome, true);
  assert.equal(spine.stages.find((s) => s.kind === STAGE_LIST_ESTABLISHMENT).matched, false);
  assert.equal(spine.stages.find((s) => s.kind === STAGE_APPOINTMENT).matched, false);
  assert.equal(spine.matched_stages, 1);
});

test("build join refuses mid-window outcomes for 6125", () => {
  const map = outcomesByExamNumber([MID_WINDOW_OUTCOME]);
  const joined = joinOutcomeOntoExam(OPEN_EMT, map);
  assert.equal(joined.outcome, null);
  assert.equal(joined.outcome_gap?.reason, "cycle_mismatch");

  const full = joinOutcomesAndListOntoExam(OPEN_EMT, map, new Map());
  assert.equal(full.outcome, null);
  assert.equal(full.outcome_gap?.class, "not_yet_ingested");
});

test("live staffing artifact: exam 6125 is coherent (open apply, no post-list)", () => {
  const exam = artifact.exams.find((e) => e.exam_number === "6125");
  assert.ok(exam, "exam 6125 present");
  assert.equal(exam.outcome, null, "6125 must not carry annual outcomes mid-window");
  assert.equal(exam.list_aggregate, null, "6125 has no Civil Service List row");
  assert.equal(exam.outcome_gap?.class, "not_yet_ingested");

  const spine = buildExamProcessSpine(exam);
  assert.equal(spine.stages.find((s) => s.kind === STAGE_LIST_ESTABLISHMENT).matched, false);
  assert.equal(spine.stages.find((s) => s.kind === STAGE_APPOINTMENT).matched, false);
  assert.ok(spine.stages.find((s) => s.kind === "application").matched);

  const classMeasure = measureExamTemporalIncoherence(artifact.exams);
  assert.equal(
    classMeasure.exam_cycle_temporal_incoherence_count,
    0,
    `expected 0 incoherent exams after cycle-aware join; got ${JSON.stringify(classMeasure.findings)}`,
  );
  assert.equal(artifact.exam_cycle_coherence?.exam_cycle_temporal_incoherence_count, 0);
});

test("class measurement reports pre-fix shape when mid-window outcomes are present", () => {
  const poisoned = artifact.exams.map((e) =>
    e.exam_number === "6125"
      ? {
          ...e,
          outcome: {
            application_cycle: "2026",
            list_establishment: 1010,
            certification_count: 74,
            hire_count: 68,
            published_on: "2026-07-22",
          },
          outcome_gap: null,
        }
      : e,
  );
  const before = measureExamTemporalIncoherence(poisoned);
  assert.ok(before.exam_cycle_temporal_incoherence_count >= 1);
  assert.ok(before.findings.some((f) => f.exam_number === "6125"));

  const after = measureExamTemporalIncoherence(artifact.exams);
  assert.equal(after.exam_cycle_temporal_incoherence_count, 0);
  assert.ok(
    before.exam_cycle_temporal_incoherence_count > after.exam_cycle_temporal_incoherence_count,
  );
});

test("flywheel data-integrity emits a card for incoherent exams", () => {
  const quiet = evaluateDataIntegrity({ exams: artifact.exams });
  assert.equal(quiet.metrics.exam_cycle_temporal_incoherence_count, 0);
  assert.ok(!quiet.cards.some((c) => c.evidence?.kind === "exam_cycle_temporal_incoherence"));

  const noisy = evaluateDataIntegrity({
    exams: [
      {
        ...OPEN_EMT,
        outcome: {
          list_establishment: 1010,
          certification_count: 74,
          hire_count: 68,
          published_on: "2026-07-22",
        },
      },
    ],
  });
  assert.equal(noisy.metrics.exam_cycle_temporal_incoherence_count, 1);
  const card = noisy.cards.find((c) => c.evidence?.kind === "exam_cycle_temporal_incoherence");
  assert.ok(card);
  assert.match(card.id, /exam-cycle-temporal-incoherence/);
  assert.ok(card.evidence.sample_exam_numbers.includes("6125"));
});

test("isContinuousFilingExam only honors explicit continuous labels", () => {
  assert.equal(isContinuousFilingExam(OPEN_EMT), false);
  assert.equal(isContinuousFilingExam({ filing_mode: "continuous" }), true);
  assert.equal(isContinuousFilingExam({ application_mode: "walk-in" }), true);
});
