import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import model from "../site/data/zoning_statistics.json" with { type: "json" };
import fixture from "./fixtures/land_prediction_baseline/v1.json" with { type: "json" };
import {
  LAND_PREDICTION_BASELINE_CONTRACT,
  LAND_PREDICTION_BASELINE_VERSION,
  evaluateLandPredictionBaseline,
} from "../worker/src/lib/land_prediction_baseline.mjs";
import { classifyProjectOutcome } from "../worker/src/lib/zoning_statistics.mjs";
import { landStageForRow } from "../site/land_status_facets.mjs";
import { resolveLandPublicStatus } from "../site/land_detail_coherence.mjs";
import { buildUlurpStatutoryClockView } from "../site/ulurp_statutory_clock.mjs";

const GENERATED_AT = "2026-08-27T00:00:00Z";
const EXPECTED = {
  "2019K0147-pre-certification": {
    cohort: ["action-type-borough:zm:brooklyn", 85, 78, 0.9294],
    timing: null,
  },
  "2019K0190-cpc-public-review": {
    cohort: ["action-type-borough:zm:brooklyn", 85, 78, 0.9294],
    timing: ["2026-08-06", "2026-09-10", "2026-10-07"],
  },
  "2022M0258-approved": {
    cohort: ["action-type-citywide:ha:citywide", 31, 23, 0.9677],
    timing: ["2024-01-11", "2024-02-22", "2024-03-19"],
  },
  "P2018X0210-approved-legacy": {
    cohort: ["action-type-citywide:all:citywide", 571, 60, 0.944],
    timing: ["2019-01-01", "2019-06-06", "2020-04-06"],
  },
  "2022X0393-community-board": {
    cohort: ["action-type-citywide:zs:citywide", 57, 41, 0.9123],
    timing: null,
  },
  "2024M0158-completed-multi-action": {
    cohort: ["action-type-citywide:zm:citywide", 189, 168, 0.9418],
    timing: null,
  },
  "2024Q0419-elurp": {
    cohort: ["action-type-citywide:all:citywide", 571, 60, 0.944],
    timing: ["2026-04-14", "2026-09-17", "2027-07-19"],
  },
  "withdrawn-ulurp": {
    cohort: ["action-type-citywide:all:citywide", 571, 60, 0.944],
    timing: ["2023-06-30", "2023-12-03", "2024-10-03"],
  },
};

test("CARD 1 fixture set covers retained applications across types, stages, outcomes, and ELURP", () => {
  assert.equal(fixture.contract, LAND_PREDICTION_BASELINE_CONTRACT);
  assert.equal(fixture.version, LAND_PREDICTION_BASELINE_VERSION);
  assert.equal(fixture.cases.length, 8);
  assert.ok(fixture.cases.some((item) => item.id.includes("elurp")));
  assert.ok(fixture.cases.some((item) => item.observed_outcome === "approved"));
  assert.ok(fixture.cases.some((item) => item.observed_outcome === "withdrawn"));
  assert.ok(fixture.cases.some((item) => item.observed_process_outcomes?.includes("conditional_favorable")));
  assert.ok(fixture.cases.some((item) => item.observed_process_outcomes?.includes("approved_with_conditions")));
  assert.ok(new Set(fixture.cases.map((item) => item.record.actions || "none")).size >= 4);
});

test("frozen baseline outputs remain exact for every representative case", () => {
  for (const item of fixture.cases) {
    const output = evaluateLandPredictionBaseline(item.record, model, { generatedAt: GENERATED_AT });
    const expected = EXPECTED[item.id];
    assert.ok(expected, `missing frozen expectation for ${item.id}`);
    assert.equal(output.contract, LAND_PREDICTION_BASELINE_CONTRACT);
    assert.equal(output.version, LAND_PREDICTION_BASELINE_VERSION);
    assert.equal(output.subject_ref, `project:${item.project_id}`);
    assert.deepEqual(
      [output.cohort?.cohort_id, output.cohort?.n, output.cohort?.duration_n, output.cohort?.outcome_rates.approved],
      expected.cohort,
      item.id,
    );
    if (!expected.timing) {
      assert.equal(output.timing_prediction, null, item.id);
    } else {
      assert.deepEqual(
        [output.timing_prediction.predicted_window.p10, output.timing_prediction.predicted_window.p50, output.timing_prediction.predicted_window.p90],
        expected.timing,
        item.id,
      );
      assert.equal(output.timing_prediction.probability, 1, item.id);
      assert.equal(output.timing_prediction.claim, "timing", item.id);
    }
    assert.equal(output.outcome.output_kind, "descriptive_cohort_rate", item.id);
    assert.equal(output.outcome.approval_probability, null, item.id);
    assert.equal(output.outcome.emitted_as_project_prediction, false, item.id);
  }
});

test("frozen baseline preserves categorical status and stage contracts", () => {
  for (const item of fixture.cases) {
    const expected = item.expected_surface;
    assert.equal(resolveLandPublicStatus(item.record, null).public_status, expected.public_status, item.id);
    assert.equal(landStageForRow(item.record), expected.stage, item.id);
    const clock = buildUlurpStatutoryClockView(item.record, { generatedAt: GENERATED_AT });
    assert.equal(clock.status === "ineligible" ? clock.reason : clock.status, expected.statutory_clock, item.id);
  }
});

test("existing outcome classifier distinguishes approval from excluded withdrawal", () => {
  assert.equal(classifyProjectOutcome({ action_statuses: ["Approved"] }), "approved");
  assert.equal(classifyProjectOutcome({ action_statuses: ["Approved", "Disapproved"] }), "modified");
  assert.equal(classifyProjectOutcome({ action_statuses: ["Disapproved"] }), "disapproved");
  assert.equal(classifyProjectOutcome({ action_statuses: ["Withdrawn"] }), null);
  assert.equal(classifyProjectOutcome({ action_statuses: ["Terminated"] }), null);
});

test("ELURP is not silently treated as a Charter-clock procedure", () => {
  const item = fixture.cases.find((candidate) => candidate.id === "2024Q0419-elurp");
  const output = evaluateLandPredictionBaseline(item.record, model, { generatedAt: GENERATED_AT });
  const clock = buildUlurpStatutoryClockView(item.record, { generatedAt: GENERATED_AT });
  assert.equal(clock.status, "ineligible");
  assert.equal(clock.reason, "wrong_procedure");
  // The existing cohort timing heuristic is procedure-agnostic; this is frozen
  // as a limitation for V2 to measure, not silently corrected in CARD 1.
  assert.equal(output.timing_prediction.probability, 1);
});

test("baseline module is version-pinned to the existing v1 materialization", () => {
  const source = readFileSync(new URL("../worker/src/lib/land_prediction_baseline.mjs", import.meta.url), "utf8");
  assert.match(source, /LAND_PREDICTION_BASELINE_CONTRACT = "land_prediction_baseline_v1"/);
  assert.match(source, /ZONING_STATISTICS_MODEL_VERSION/);
  assert.doesNotMatch(source, /stance|member_stance|logistic|institutional_power/i);
});

test("baseline report is generated from the frozen fixture replay", () => {
  const report = JSON.parse(readFileSync(new URL("../warehouse/receipts/proof/land-prediction-baseline-v1.json", import.meta.url), "utf8"));
  assert.equal(report.contract, LAND_PREDICTION_BASELINE_CONTRACT);
  assert.equal(report.version, LAND_PREDICTION_BASELINE_VERSION);
  assert.equal(report.fixture_set.case_count, 8);
  assert.equal(report.metrics.existing_materialization_backtest.resolved_prediction_count, 63);
  assert.equal(report.metrics.existing_materialization_backtest.interval_coverage, 0.7778);
  assert.equal(report.metrics.outcome.project_probability_predictions, 0);
  assert.equal(report.metrics.outcome.brier_score, null);
  assert.equal(report.metrics.status.accuracy, null);
  assert.equal(report.replay.find((item) => item.id === "2022M0258-approved").interval_hit, true);
  assert.equal(report.replay.find((item) => item.id === "2024Q0419-elurp").timing_prediction.probability, 1);
});
