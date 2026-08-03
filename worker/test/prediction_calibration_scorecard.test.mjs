/**
 * Characterization: domain-generic prediction backtests and public ship bar.
 *
 * verify:
 *   node --test worker/test/prediction_calibration_scorecard.test.mjs
 *   node worker/scripts/prediction-calibration-scorecard.mjs --fixtures worker/test/fixtures/predictions --check
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  evaluatePredictionBacktest,
  probabilityQuintile,
} from "../src/lib/prediction_calibration.mjs";
import { buildPredictionCalibrationFixtures } from "./fixtures/predictions/build_cases.mjs";

const fixtures = buildPredictionCalibrationFixtures();
const fixtureById = new Map(fixtures.map((fixture) => [fixture.id, fixture]));

test("probabilities use five fixed, closed-upper probability quintiles", () => {
  assert.equal(probabilityQuintile(0), 1);
  assert.equal(probabilityQuintile(0.1999), 1);
  assert.equal(probabilityQuintile(0.2), 2);
  assert.equal(probabilityQuintile(0.8), 5);
  assert.equal(probabilityQuintile(1), 5);
  assert.throws(() => probabilityQuintile(1.01), /between 0 and 1/);
});

test("the calibrated fixture clears every public ship-bar check", () => {
  const scorecard = evaluatePredictionBacktest(fixtureById.get("well_calibrated").backtest);

  assert.equal(scorecard.ship_bar.status, "pass");
  assert.deepEqual(scorecard.ship_bar.checks, {
    minimum_resolved: true,
    interval_coverage: true,
    occurrence_quintiles_monotone: true,
  });
  assert.equal(scorecard.resolved_backtest_predictions, 100);
  assert.equal(scorecard.interval_coverage, 0.8);
  assert.equal(scorecard.interval_coverage_count, 50);
  assert.equal(scorecard.occurrence_quintiles_monotone, true);
  assert.deepEqual(
    scorecard.occurrence_calibration.map((row) => row.realized_frequency),
    [0.1, 0.3, 0.5, 0.7, 0.9],
  );
  assert.equal(scorecard.resolution_rate, 1);
});

test("the deliberately miscalibrated fixture is withheld", () => {
  const scorecard = evaluatePredictionBacktest(fixtureById.get("miscalibrated").backtest);

  assert.equal(scorecard.ship_bar.status, "fail");
  assert.equal(scorecard.ship_bar.checks.minimum_resolved, true);
  assert.equal(scorecard.ship_bar.checks.interval_coverage, false);
  assert.equal(scorecard.ship_bar.checks.occurrence_quintiles_monotone, false);
  assert.equal(scorecard.interval_coverage, 0.5);
  assert.deepEqual(
    scorecard.occurrence_calibration.map((row) => row.realized_frequency),
    [0.9, 0.7, 0.5, 0.3, 0.1],
  );
  assert.equal(scorecard.public_projection, "cohort_statistic_only");
});

test("fewer than 50 resolved predictions cannot clear the ship bar", () => {
  const fixture = structuredClone(fixtureById.get("well_calibrated").backtest);
  fixture.predictions = fixture.predictions.slice(0, 49);

  const scorecard = evaluatePredictionBacktest(fixture);
  assert.equal(scorecard.resolved_backtest_predictions, 49);
  assert.equal(scorecard.ship_bar.checks.minimum_resolved, false);
  assert.equal(scorecard.ship_bar.status, "fail");
  assert.equal(scorecard.public_projection, "cohort_statistic_only");
});

test("timing-only domains treat occurrence monotonicity as not applicable", () => {
  const fixture = structuredClone(fixtureById.get("well_calibrated").backtest);
  const timingSubjects = new Set(
    fixture.predictions.filter((row) => row.claim === "timing").map((row) => row.subject_ref),
  );
  fixture.predictions = fixture.predictions.filter((row) => row.claim === "timing");
  const evidenceIds = new Set(fixture.predictions.flatMap((row) => row.basis.evidence_event_ids));
  fixture.events = fixture.events.filter((row) => timingSubjects.has(row.subject_ref)
    || evidenceIds.has(row.event_id));

  const scorecard = evaluatePredictionBacktest(fixture);
  assert.equal(scorecard.occurrence_prediction_count, 0);
  assert.equal(scorecard.occurrence_quintiles_monotone, null);
  assert.equal(scorecard.ship_bar.checks.occurrence_quintiles_monotone, true);
});

test("backtests fail closed on post-split training evidence", () => {
  const fixture = structuredClone(fixtureById.get("well_calibrated").backtest);
  const leakedId = fixture.predictions[0].basis.evidence_event_ids[0];
  const leaked = fixture.events.find((event) => event.event_id === leakedId);
  leaked.valid_at = fixture.split_date;

  assert.throws(
    () => evaluatePredictionBacktest(fixture),
    /training evidence .* must have valid_at before split_date/,
  );
});

test("backtests fail closed when a prediction was not emitted for a matter open at T", () => {
  const fixture = structuredClone(fixtureById.get("well_calibrated").backtest);
  const subjectRef = fixture.predictions[0].subject_ref;
  fixture.events = fixture.events.filter((event) => event.subject_ref !== subjectRef
    || event.event_kind !== fixture.open_event_kinds[0]);

  assert.throws(
    () => evaluatePredictionBacktest(fixture),
    /was not open at split_date/,
  );
});

test("only post-split exact subject and event-kind joins resolve a prediction", () => {
  const fixture = structuredClone(fixtureById.get("well_calibrated").backtest);
  const prediction = fixture.predictions.find((row) => row.claim === "timing");
  const exact = fixture.events.find((event) => event.subject_ref === prediction.subject_ref
    && event.event_kind === prediction.predicted_event_kind
    && event.valid_at >= fixture.split_date);
  exact.subject_ref = "rules:not-the-predicted-matter";

  const scorecard = evaluatePredictionBacktest(fixture);
  assert.equal(scorecard.resolved_backtest_predictions, 99);
  assert.equal(scorecard.interval_coverage_count, 49);
  assert.equal(scorecard.resolution_rate, 0.99);
});

test("an exact occurrence join remains realized alongside another terminal event", () => {
  const fixture = structuredClone(fixtureById.get("well_calibrated").backtest);
  const prediction = fixture.predictions.find((row) => row.claim === "occurrence"
    && row.probability === 0.1
    && fixture.events.some((event) => event.subject_ref === row.subject_ref
      && event.event_kind === "meetings.agenda_item_action"));
  const terminal = fixture.events.find((event) => event.subject_ref === prediction.subject_ref
    && event.event_kind === "meetings.agenda_item_action");
  fixture.events.push({
    event_id: "cte:coexisting-exact-roll-call",
    subject_ref: prediction.subject_ref,
    event_kind: prediction.predicted_event_kind,
    valid_at: terminal.valid_at,
  });

  const scorecard = evaluatePredictionBacktest(fixture);
  assert.equal(scorecard.occurrence_calibration[0].realized_frequency, 0.2);
  assert.equal(scorecard.resolved_backtest_predictions, 100);
});

test("timing grace changes resolution hits but not nominal interval coverage", () => {
  const fixture = structuredClone(fixtureById.get("well_calibrated").backtest);
  const prediction = fixture.predictions.find((row) => row.claim === "timing");
  const exact = fixture.events.find((event) => event.subject_ref === prediction.subject_ref
    && event.event_kind === prediction.predicted_event_kind
    && event.valid_at >= fixture.split_date);
  exact.valid_at = "2025-03-24";
  fixture.grace_days = 2;

  const scorecard = evaluatePredictionBacktest(fixture);
  assert.ok(scorecard.timing_resolution_hits > scorecard.interval_coverage_hits);
  assert.equal(scorecard.interval_nominal, 0.8);
});

test("scorecard CLI is byte-stable and verifies both positive and negative fixtures", () => {
  const scriptPath = fileURLToPath(
    new URL("../scripts/prediction-calibration-scorecard.mjs", import.meta.url),
  );
  const fixturePath = fileURLToPath(new URL("./fixtures/predictions", import.meta.url));
  const args = [
    scriptPath,
    "--fixtures",
    fixturePath,
  ];
  const first = spawnSync(process.execPath, args, { encoding: "utf8" });
  const second = spawnSync(process.execPath, args, { encoding: "utf8" });
  assert.equal(first.status, 0, first.stderr);
  assert.equal(second.status, 0, second.stderr);
  assert.equal(first.stdout, second.stdout);
  assert.equal(
    first.stdout,
    readFileSync(new URL("./fixtures/predictions/expected_calibration.json", import.meta.url), "utf8"),
  );

  const checked = spawnSync(process.execPath, [...args, "--check"], { encoding: "utf8" });
  assert.equal(checked.status, 0, checked.stderr);
  assert.match(checked.stdout, /well_calibrated=pass/);
  assert.match(checked.stdout, /miscalibrated=fail/);
});
