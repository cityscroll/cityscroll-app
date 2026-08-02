/**
 * Characterization: civil-service exam process spine
 * (application → list_establishment → certification → appointment).
 *
 * Field cases: full annual-outcome chain; list_joined partial; schedule-only
 * with class-(a) empties; legacy not_published gap remapped to not_yet_ingested.
 * Career guide steps remain static teaching copy, not this spine.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  EXAM_PROCESS_STAGES,
  STAGE_APPLICATION,
  STAGE_APPOINTMENT,
  STAGE_CERTIFICATION,
  STAGE_LIST_ESTABLISHMENT,
  attachExamProcessSpines,
  buildExamProcessSpine,
  buildExamProcessSpines,
  measureExamProcessSpineCompleteness,
  spineForExam,
} from "../worker/src/lib/exam_process_spine.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const fixture = JSON.parse(
  readFileSync(join(ROOT, "test/fixtures/exam_process_spine/field_cases.json"), "utf8"),
);
const artifact = JSON.parse(
  readFileSync(join(ROOT, "site/data/staffing_exams.json"), "utf8"),
);

test("EXAM_PROCESS_STAGES is application → list → certification → appointment", () => {
  assert.deepEqual([...EXAM_PROCESS_STAGES], [
    "application",
    "list_establishment",
    "certification",
    "appointment",
  ]);
});

test("field case: full annual-outcome exam is a four-stage full spine", () => {
  const exam = fixture.exams.find((e) => e.exam_number === "6125");
  const spine = buildExamProcessSpine(exam);

  assert.equal(spine.schema_version, 1);
  assert.equal(spine.subject_ref, "exam:6125");
  assert.equal(spine.join.method, "exam_number_outcomes");
  assert.equal(spine.full, true);
  assert.equal(spine.stage_fill, 1);
  assert.deepEqual(
    spine.stages.map((s) => [s.kind, s.matched, s.count]),
    [
      ["application", true, null],
      ["list_establishment", true, 1010],
      ["certification", true, 74],
      ["appointment", true, 68],
    ],
  );
  assert.equal(spine.gaps.length, 0);
  assert.ok(spine.events.every((e) => e.source?.id && e.stage));
  const app = spine.stages.find((s) => s.kind === STAGE_APPLICATION);
  assert.equal(app.events[0].time.value, "2026-06-15");
  assert.equal(app.events[0].time.value_to, "2026-08-07");
});

test("field case: list_joined exam matches application + list only (honest empties)", () => {
  const exam = fixture.exams.find((e) => e.exam_number === "6311");
  const spine = buildExamProcessSpine(exam);

  assert.equal(spine.join.method, "exam_number_list_aggregate");
  assert.equal(spine.full, false);
  assert.equal(spine.matched_stages, 2);
  assert.equal(spine.stages.find((s) => s.kind === STAGE_LIST_ESTABLISHMENT).matched, true);
  assert.equal(spine.stages.find((s) => s.kind === STAGE_LIST_ESTABLISHMENT).count, 1983);
  assert.equal(
    spine.stages.find((s) => s.kind === STAGE_LIST_ESTABLISHMENT).events[0].time.value,
    "2025-12-03",
  );
  assert.equal(spine.stages.find((s) => s.kind === STAGE_CERTIFICATION).matched, false);
  assert.equal(spine.stages.find((s) => s.kind === STAGE_APPOINTMENT).matched, false);
  assert.ok(
    spine.gaps.every((g) => g.class === "not_yet_ingested"),
    "empty post-list stages must be class-(a), not class-(b)",
  );
  assert.deepEqual(
    spine.gaps.map((g) => g.slot),
    [STAGE_CERTIFICATION, STAGE_APPOINTMENT],
  );
  assert.ok(spine.gaps.every((g) => /outcomes|DCAS/i.test(g.source)));
});

test("field case: schedule-only pending exam keeps application and class-(a) later stages", () => {
  const exam = fixture.exams.find((e) => e.exam_number === "6126");
  const spine = buildExamProcessSpine(exam);

  assert.equal(spine.join.method, "exam_number_schedule");
  assert.equal(spine.matched_stages, 1);
  assert.equal(spine.stages.find((s) => s.kind === STAGE_APPLICATION).matched, true);
  assert.ok(spine.gaps.every((g) => g.class === "not_yet_ingested"));
  assert.deepEqual(
    spine.gaps.map((g) => g.slot),
    [STAGE_LIST_ESTABLISHMENT, STAGE_CERTIFICATION, STAGE_APPOINTMENT],
  );
  // No invented certification/appointment events.
  assert.equal(spine.events.length, 1);
});

test("never reintroduce false not_published labels on aggregate spine gaps", () => {
  const exam = fixture.exams.find((e) => e.exam_number === "legacy-b");
  const spine = buildExamProcessSpine(exam);
  assert.ok(spine.gaps.length >= 1);
  assert.ok(spine.gaps.every((g) => g.class === "not_yet_ingested"));
  assert.equal(spine.outcome_gap?.class, "not_yet_ingested");
  assert.ok(!spine.gaps.some((g) => g.class === "not_published"));
});

test("buildExamProcessSpines + spineForExam index by exam_number", () => {
  const spines = buildExamProcessSpines(fixture.exams);
  assert.equal(spines.length, fixture.exams.length);
  const full = spineForExam(spines, "6125");
  assert.ok(full);
  assert.equal(full.full, true);
  assert.equal(spineForExam(spines, "missing"), null);
});

test("measureExamProcessSpineCompleteness moves with fill", () => {
  const empty = measureExamProcessSpineCompleteness([]);
  assert.equal(empty.metric, "exam_process_spine_completeness_rate");
  assert.equal(empty.exam_process_spine_completeness_rate, 0);

  const spines = buildExamProcessSpines(fixture.exams);
  const metrics = measureExamProcessSpineCompleteness(spines);
  assert.ok(metrics.spine_count >= 4);
  assert.ok(metrics.post_list_spine_count >= 2);
  assert.ok(metrics.exam_process_spine_completeness_rate > 0);
  assert.ok(metrics.exam_process_spine_completeness_rate <= 1);
  assert.ok(metrics.full_spine_rate > 0);
  assert.ok(metrics.stage_rates.application > 0);
});

test("attachExamProcessSpines stamps exams without inventing post-cycle counts", () => {
  const view = attachExamProcessSpines({ schema_version: 1, exams: fixture.exams });
  assert.ok(Array.isArray(view.exam_process_spines));
  assert.equal(view.exam_process_metrics.metric, "exam_process_spine_completeness_rate");
  const stamped = view.exams.find((e) => e.exam_number === "6126");
  assert.equal(stamped.process_spine.matched_stages, 1);
  assert.equal(stamped.process_spine.stages.find((s) => s.kind === STAGE_APPOINTMENT).matched, false);
});

test("live staffing artifact: every exam builds a spine; no class-(b) aggregate gaps", () => {
  assert.ok(Array.isArray(artifact.exams) && artifact.exams.length > 0);
  const spines = buildExamProcessSpines(artifact.exams);
  assert.equal(spines.length, artifact.exams.length);

  for (const spine of spines) {
    assert.match(spine.subject_ref, /^exam:\d{4}$/);
    assert.equal(spine.stages.length, 4);
    assert.ok(spine.gaps.every((g) => g.class === "not_yet_ingested"), spine.exam_number);
  }

  // Known field cases from the committed artifact.
  const full = spineForExam(spines, "6125");
  assert.ok(full?.full, "exam 6125 should be a full outcome spine when present");
  const listJoined = spineForExam(spines, "6311");
  if (listJoined) {
    assert.equal(listJoined.stages.find((s) => s.kind === STAGE_LIST_ESTABLISHMENT).matched, true);
  }

  const metrics = measureExamProcessSpineCompleteness(spines);
  assert.ok(metrics.spine_count === artifact.exams.length);
  assert.ok(metrics.stage_rates.application > 0.9, "almost all exams have an application window");
});

test("public exam detail mounts the process spine; guide steps stay teaching-only", () => {
  const index = readFileSync(join(ROOT, "site/index.html"), "utf8");
  assert.match(index, /function examProcessSpineHTML/);
  assert.match(index, /exam_spine_heading/);
  assert.match(index, /exam_stage_application/);
  assert.match(index, /exam_stage_list_establishment/);
  assert.match(index, /exam_stage_certification/);
  assert.match(index, /exam_stage_appointment/);
  // Static guide steps remain (teaching), distinct from process spine mount.
  assert.match(index, /career_step4_title/);
  assert.match(index, /careerOutcomeHTML/);
});

test("civic-time adapter maps exam spine events without inventing clocks", async () => {
  const { mapExamProcessSpineToCivic, SPINE_KIND_ALIASES } = await import(
    "../worker/src/lib/civic_time.mjs"
  );
  const exam = fixture.exams.find((e) => e.exam_number === "6125");
  const spine = buildExamProcessSpine(exam);
  const civic = mapExamProcessSpineToCivic(spine, { run_id: "test" });
  assert.equal(civic.length, spine.events.length);
  assert.ok(civic.every((ev) => ev.subject_ref === "exam:6125"));
  const knownKinds = new Set(Object.values(SPINE_KIND_ALIASES));
  assert.ok(civic.every((ev) => knownKinds.has(ev.event_kind)));
  assert.ok(civic.some((ev) => ev.event_kind === "staffing.application_window"));
  assert.ok(civic.some((ev) => ev.event_kind === "staffing.list_established"));
  assert.ok(civic.some((ev) => ev.event_kind === "staffing.appointment"));
});
