import { SITE_SOURCE } from "./helpers/site_source.mjs";
/**
 * ULURP statutory-clock deadlines (cs-pred-03).
 * Verify gate: certified on D → CB/BP/CPC/Council at D+60/90/150/200 with
 * statute_ref; withdrawn project open predictions resolve to withdrawn.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  ULURP_STATUTORY_STATUTE_REF,
  ULURP_STATUTORY_STAGES,
  ULURP_STATUTORY_TOTAL_DAYS,
  addCalendarDays,
  buildUlurpPipelinePosition,
  buildUlurpStatutoryClockView,
  detectStaleOpenStatutoryClock,
  normalizeLandOutcomeRecord,
  projectStatutoryDeadlines,
  resolveCertificationDate,
} from "../site/ulurp_statutory_clock.mjs";
import {
  attachUlurpStatutoryPredictions,
  emitUlurpStatutoryPredictions,
  stageModelName,
  statutoryDeadlinesFromCertification,
} from "../worker/src/lib/ulurp_statutory_predictions.mjs";
import { validatePrediction } from "../worker/src/lib/prediction_contract.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

test("versioned statutory table encodes Charter §197-c cumulative windows", () => {
  assert.equal(ULURP_STATUTORY_STATUTE_REF, "NYC Charter §197-c");
  assert.equal(ULURP_STATUTORY_TOTAL_DAYS, 205);
  assert.deepEqual(
    ULURP_STATUTORY_STAGES.map((s) => [s.phase_id, s.days, s.cumulative_days]),
    [
      ["community_board", 60, 60],
      ["borough_president", 30, 90],
      ["cpc", 60, 150],
      ["city_council", 50, 200],
      ["mayoral_appeals", 5, 205],
    ],
  );
});

test("fixture project certified on D renders CB/BP/CPC/Council due dates D+60/90/150/200", () => {
  const D = "2024-01-15";
  const expected = {
    community_board: addCalendarDays(D, 60),
    borough_president: addCalendarDays(D, 90),
    cpc: addCalendarDays(D, 150),
    city_council: addCalendarDays(D, 200),
  };
  assert.equal(expected.community_board, "2024-03-15");
  assert.equal(expected.borough_president, "2024-04-14");
  assert.equal(expected.cpc, "2024-06-13");
  assert.equal(expected.city_council, "2024-08-02");

  const byPhase = Object.fromEntries(
    projectStatutoryDeadlines(D).map((p) => [p.phase_id, p]),
  );
  for (const [phaseId, due] of Object.entries(expected)) {
    assert.equal(byPhase[phaseId].due_date, due);
    assert.equal(byPhase[phaseId].statute_ref, "NYC Charter §197-c");
  }

  const record = JSON.parse(
    readFileSync(join(ROOT, "test/fixtures/ulurp_statutory_clock/certified_d.json"), "utf8"),
  );
  assert.equal(resolveCertificationDate(record), D);

  const clock = buildUlurpStatutoryClockView(record, {
    generatedAt: "2024-01-16T12:00:00Z",
  });
  assert.equal(clock.status, "open");
  assert.equal(clock.statute_ref, "NYC Charter §197-c");
  assert.equal(clock.certified_date, D);
  const map = Object.fromEntries(clock.phases.map((p) => [p.phase_id, p.due_date]));
  assert.equal(map.community_board, expected.community_board);
  assert.equal(map.borough_president, expected.borough_president);
  assert.equal(map.cpc, expected.cpc);
  assert.equal(map.city_council, expected.city_council);
  assert.equal(map.mayoral_appeals, addCalendarDays(D, 205));

  const predictions = emitUlurpStatutoryPredictions(record, {
    generatedAt: "2024-01-16T12:00:00Z",
  });
  assert.ok(predictions.length >= 5);
  for (const p of predictions) {
    validatePrediction(p);
    assert.equal(p.basis.method, "statutory_clock");
    assert.equal(p.basis.statute_ref, "NYC Charter §197-c");
    assert.equal(p.status, "open");
    assert.equal(p.subject_ref, "project:FIXTURED0001");
  }

  const byStage = Object.fromEntries(
    predictions
      .filter((p) => p.predicted_event_kind === "land.zap_milestone")
      .map((p) => [p.model_name, p.predicted_window.p50]),
  );
  assert.equal(byStage[stageModelName("community_board")], expected.community_board);
  assert.equal(byStage[stageModelName("borough_president")], expected.borough_president);
  assert.equal(byStage[stageModelName("cpc")], expected.cpc);
  assert.equal(byStage[stageModelName("city_council")], expected.city_council);

  const disposition = predictions.find((p) => p.predicted_event_kind === "land.zap_disposition");
  assert.ok(disposition);
  assert.equal(disposition.predicted_window.p50, addCalendarDays(D, 205));
  assert.equal(disposition.basis.method, "statutory_clock");

  const attached = attachUlurpStatutoryPredictions(record, {
    generatedAt: "2024-01-16T12:00:00Z",
  });
  assert.equal(attached.statutory_clock.phases[0].due_date, expected.community_board);
  assert.equal(attached.predictions.length, predictions.length);
});

test("withdrawn fixture project's open predictions resolve to withdrawn", () => {
  const record = JSON.parse(
    readFileSync(join(ROOT, "test/fixtures/ulurp_statutory_clock/withdrawn.json"), "utf8"),
  );

  const clock = buildUlurpStatutoryClockView(record, {
    generatedAt: "2023-08-16T00:00:00Z",
  });
  assert.equal(clock.status, "withdrawn");
  assert.ok(clock.phases.every((p) => p.status === "withdrawn"));

  const predictions = emitUlurpStatutoryPredictions(record, {
    generatedAt: "2023-08-16T00:00:00Z",
  });
  assert.ok(predictions.length >= 5);
  for (const p of predictions) {
    assert.equal(p.status, "withdrawn");
    assert.equal(p.resolved_by_event_id, null);
    assert.equal(p.basis.statute_ref, "NYC Charter §197-c");
    validatePrediction(p);
  }

  const openCount = predictions.filter((p) => p.status === "open").length;
  assert.equal(openCount, 0);
});

test("uncertified projects do not invent statutory due dates", () => {
  const record = {
    project_id: "PRECERT001",
    public_status: "Noticed",
    spine: { events: [] },
  };
  const clock = buildUlurpStatutoryClockView(record);
  assert.equal(clock.status, "ineligible");
  assert.equal(clock.phases.length, 0);
  assert.deepEqual(emitUlurpStatutoryPredictions(record), []);
});

test("statutoryDeadlinesFromCertification matches verify matrix", () => {
  const d = statutoryDeadlinesFromCertification("2024-01-15");
  assert.equal(d.community_board, "2024-03-15");
  assert.equal(d.borough_president, "2024-04-14");
  assert.equal(d.cpc, "2024-06-13");
  assert.equal(d.city_council, "2024-08-02");
  assert.equal(d.mayoral_appeals, "2024-08-07");
  assert.equal(d.disposition, "2024-08-07");
});

test("public land template and methodology cite Charter statutory clocks", () => {
  const index = SITE_SOURCE;
  assert.match(index, /function landStatutoryDeadlineHTML/);
  assert.match(index, /land_spine_statutory_deadline_html/);
  assert.match(index, /land-statutory-deadline/);
  assert.match(index, /statutory_clock/);

  const i18n = readFileSync(join(ROOT, "site/i18n.js"), "utf8");
  assert.match(i18n, /NYC Charter §197-c/);
  assert.match(i18n, /land_spine_statutory_deadline_html/);
  assert.match(i18n, /\{stage\} must conclude within \{n\} days/);
});

test("zap outcome materialization attaches statutory predictions batch-side", () => {
  const src = readFileSync(join(ROOT, "worker/src/zap_outcomes.mjs"), "utf8");
  assert.match(src, /attachUlurpStatutoryPredictions/);
  assert.match(src, /ulurp_statutory_predictions/);
});

test("completed project closes statutory phases and resolves predictions", () => {
  const record = JSON.parse(
    readFileSync(join(ROOT, "test/fixtures/ulurp_statutory_clock/completed_project.json"), "utf8"),
  );

  const clock = buildUlurpStatutoryClockView(record, {
    generatedAt: "2026-08-03T12:00:00Z",
  });
  assert.equal(clock.status, "completed");
  assert.ok(clock.phases.length >= 5);
  assert.ok(clock.phases.every((p) => p.status === "completed"));
  assert.equal(clock.disposition.status, "completed");
  assert.ok(clock.phases.some((p) => p.phase_id === "community_board" && p.completed_at === "2023-10-26"));

  const predictions = emitUlurpStatutoryPredictions(record, {
    generatedAt: "2026-08-03T12:00:00Z",
  });
  assert.ok(predictions.length >= 5);
  const open = predictions.filter((p) => p.status === "open");
  assert.equal(open.length, 0, "completed project must not leave open statutory predictions");
  for (const p of predictions) {
    validatePrediction(p);
    assert.ok(
      p.status === "resolved_hit" || p.status === "resolved_miss",
      `unexpected status ${p.status} for ${p.model_name}`,
    );
    assert.ok(p.resolved_by_event_id);
  }

  // Detector: a hand-stale clock with all-open phases on this record must flag.
  const staleClock = {
    status: "open",
    phases: clock.phases.map((p) => ({ ...p, status: "open", completed_at: null })),
  };
  const finding = detectStaleOpenStatutoryClock(record, staleClock);
  assert.ok(finding);
  assert.equal(finding.rule_id, "statutory_clock_stale_open");
  // Fixed clock on the same record must not flag.
  assert.equal(detectStaleOpenStatutoryClock(record, clock), null);
});

test("in-progress project closes only completed statutory phases", () => {
  const record = {
    project_id: "2024Q0292",
    public_status: "In Public Review",
    certified_referred: "2026-05-11",
    milestones: [
      { id: "cb", title: "Community Board Review", status: "Completed", date: "2026-06-25" },
      { id: "bp", title: "Borough President Review", status: "In Progress", date: null },
    ],
    spine: {
      events: [
        {
          id: "zap-milestone:cb",
          title: "Community Board Review",
          status: "Completed",
          detail: "Completed",
          time: { value: "2026-06-25", precision: "day", certainty: "actual" },
        },
      ],
    },
  };
  const clock = buildUlurpStatutoryClockView(record, {
    generatedAt: "2026-08-03T12:00:00Z",
  });
  assert.equal(clock.status, "open");
  const byId = Object.fromEntries(clock.phases.map((p) => [p.phase_id, p]));
  assert.equal(byId.community_board.status, "completed");
  assert.equal(byId.borough_president.status, "open");
  assert.equal(byId.cpc.status, "open");

  const predictions = emitUlurpStatutoryPredictions(record, {
    generatedAt: "2026-08-03T12:00:00Z",
  });
  const cbPred = predictions.find((p) => p.model_name === stageModelName("community_board"));
  assert.ok(cbPred);
  assert.ok(cbPred.status === "resolved_hit" || cbPred.status === "resolved_miss");
  const bpPred = predictions.find((p) => p.model_name === stageModelName("borough_president"));
  assert.equal(bpPred.status, "open");
});

test("completed project with stale-open edge clock does not claim overdue public-review step", () => {
  const record = JSON.parse(
    readFileSync(join(ROOT, "test/fixtures/ulurp_statutory_clock/completed_project.json"), "utf8"),
  );
  // Simulate lagging materialization: all phases still open on a Completed project.
  const staleClock = {
    status: "open",
    certified_date: "2023-08-21",
    phases: [
      { phase_id: "community_board", status: "open", due_date: "2023-10-20", days: 60 },
      { phase_id: "borough_president", status: "open", due_date: "2023-11-19", days: 30 },
      { phase_id: "cpc", status: "open", due_date: "2024-01-18", days: 60 },
      { phase_id: "city_council", status: "open", due_date: "2024-03-08", days: 50 },
      { phase_id: "mayoral_appeals", status: "open", due_date: "2024-03-13", days: 5 },
    ],
  };
  const bad = buildUlurpPipelinePosition({
    phaseView: { current: { phase_id: "city_council", public_status: "Completed" } },
    clock: staleClock,
    publicStatus: "Completed",
    today: "2026-08-04",
  });
  assert.equal(bad, null, "terminal public_status must not emit public-review pipeline sentence");

  const normalized = normalizeLandOutcomeRecord({ ...record, statutory_clock: staleClock });
  assert.equal(normalized.statutory_clock.status, "completed");
  assert.ok(normalized.statutory_clock.phases.every((p) => p.status === "completed"));
  const good = buildUlurpPipelinePosition({
    phaseView: { current: { phase_id: "city_council", public_status: "Completed" } },
    clock: normalized.statutory_clock,
    publicStatus: "Completed",
    today: "2026-08-04",
  });
  assert.equal(good, null);

  // Still in public review with a real open step keeps days-left.
  const openPos = buildUlurpPipelinePosition({
    phaseView: {
      current: { phase_id: "borough_president", public_status: "In Public Review", in_public_review: true },
    },
    clock: {
      status: "open",
      certified_date: "2026-05-11",
      phases: [
        { phase_id: "community_board", status: "completed", due_date: "2026-07-10", days: 60 },
        { phase_id: "borough_president", status: "open", due_date: "2026-08-09", days: 30 },
        { phase_id: "cpc", status: "open", due_date: "2026-10-08", days: 60 },
        { phase_id: "city_council", status: "open", due_date: "2026-11-27", days: 50 },
        { phase_id: "mayoral_appeals", status: "open", due_date: "2026-12-02", days: 5 },
      ],
    },
    publicStatus: "In Public Review",
    today: "2026-08-04",
  });
  assert.ok(openPos);
  assert.equal(openPos.step_phase_id, "borough_president");
  assert.equal(openPos.step_n, 2);
  assert.ok(Number.isFinite(openPos.days_left));
});
