import { SITE_SOURCE } from "./helpers/site_source.mjs";
/**
 * Exam process phase presentation (compact stepper + current/next).
 *
 *   node --test test/exam_phase_spine.test.mjs
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import {
  EXAM_PHASES,
  buildExamPhaseView,
  examStageToPhase,
  aggregatePhaseEvents,
  dedupePhaseSourceLinks,
} from "../site/exam_phase_spine.mjs";
import {
  EXAM_PROCESS_STAGES,
  buildExamProcessSpine,
} from "../worker/src/lib/exam_process_spine.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const fixture = JSON.parse(
  readFileSync(join(ROOT, "test/fixtures/exam_process_spine/field_cases.json"), "utf8"),
);

test("EXAM_PHASES matches process stage order 1:1", () => {
  assert.deepEqual([...EXAM_PHASES], [...EXAM_PROCESS_STAGES]);
  assert.equal(examStageToPhase("list_establishment"), "list_establishment");
  assert.equal(examStageToPhase("nope"), null);
});

test("buildExamPhaseView marks current as last matched and next as first unmatched after", () => {
  const exam = fixture.exams.find((e) => e.exam_number === "6311");
  const spine = buildExamProcessSpine(exam);
  const view = buildExamPhaseView(spine);
  assert.ok(view);
  assert.equal(view.phases.length, 4);
  assert.ok(view.current);
  assert.ok(view.action?.action_key);
  // Full annual-outcome chain ends on appointment.
  assert.equal(view.current.id, "appointment");
  assert.equal(view.current.matched, true);
  assert.equal(view.action.action_key, "exam_phase_action_appointment");
  assert.equal(view.next, null);
  assert.equal(view.metrics.matched_count, 4);
});

test("open exam 6125: current is application (no mid-window post-list)", () => {
  const exam = fixture.exams.find((e) => e.exam_number === "6125");
  const spine = buildExamProcessSpine(exam);
  const view = buildExamPhaseView(spine);
  assert.equal(view.current.id, "application");
  assert.equal(view.action.action_key, "exam_phase_action_application");
  assert.equal(view.next?.id, "list_establishment");
  assert.equal(view.phases.find((p) => p.id === "appointment").matched, false);
  assert.equal(view.metrics.matched_count, 1);
});

test("schedule-only pending exam: current is application", () => {
  const exam = fixture.exams.find((e) => e.exam_number === "6126");
  const spine = buildExamProcessSpine(exam);
  const view = buildExamPhaseView(spine);
  assert.equal(view.current.id, "application");
  assert.equal(view.action.action_key, "exam_phase_action_application");
  assert.equal(view.next?.id, "list_establishment");
  assert.equal(view.metrics.matched_count, 1);
});

test("aggregatePhaseEvents collapses verbatim title repeats", () => {
  const groups = aggregatePhaseEvents([
    { title: "Same title", time: { value: "2025-10-01" }, exam_number: "a" },
    { title: "Same title", time: { value: "2025-10-02" }, exam_number: "b" },
    { title: "Other", time: { value: "2025-10-03" }, exam_number: "c" },
  ]);
  assert.equal(groups.length, 2);
  const same = groups.find((g) => g.title === "Same title");
  assert.equal(same.count, 2);
  assert.equal(same.first, "2025-10-01");
  assert.equal(same.last, "2025-10-02");
});

test("dedupePhaseSourceLinks collapses identical URLs", () => {
  const out = dedupePhaseSourceLinks([
    { source: { url: "https://www.nyc.gov/assets/dcas/downloads/pdf/noes/20277016000.pdf" } },
    { source: { url: "https://www.nyc.gov/assets/dcas/downloads/pdf/noes/20277016000.pdf/" } },
    { source_url: "https://data.cityofnewyork.us/d/vx8i-nprf" },
  ]);
  assert.equal(out.count, 2);
  assert.equal(out.candidates, 3);
  assert.ok(out.url);
});

test("public exam detail uses exam phase spine surface", () => {
  const index = SITE_SOURCE;
  assert.match(index, /buildExamPhaseView|exam_phase_spine/);
  assert.match(index, /exam-phase-stepper|exam_phase_now_html/);
  assert.match(index, /function examProcessSpineHTML/);
  // Empty future phases collapse to stepper chips — not per-stage gap cards only.
  assert.match(index, /data-exam-phase="1"/);
});
