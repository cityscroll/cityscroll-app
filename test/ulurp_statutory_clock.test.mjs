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
  buildUlurpStatutoryClockView,
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
