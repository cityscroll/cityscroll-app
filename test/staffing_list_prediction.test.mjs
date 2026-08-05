import { SITE_SOURCE } from "./helpers/site_source.mjs";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { validatePrediction } from "../worker/src/lib/prediction_contract.mjs";
import {
  STAFFING_LIST_COHORT_FLOOR,
  STAFFING_LIST_METHOD,
  attachStaffingListForecast,
  buildScheduleListPairs,
  buildStaffingLagModel,
  buildStaffingListBacktest,
} from "../worker/src/lib/staffing_list_prediction.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const history = JSON.parse(readFileSync(
  join(ROOT, "site/data/exam_sources/annual_schedule_history.json"),
  "utf8",
));
const aggregates = JSON.parse(readFileSync(
  join(ROOT, "site/data/exam_sources/civil_service_list_aggregates.json"),
  "utf8",
));
const artifact = JSON.parse(readFileSync(join(ROOT, "site/data/staffing_exams.json"), "utf8"));
const indexHtml = SITE_SOURCE;
const aboutHtml = readFileSync(join(ROOT, "site/about.html"), "utf8");
const i18n = readFileSync(join(ROOT, "site/i18n.js"), "utf8");

const built = buildScheduleListPairs(history.records, aggregates.records);
const model = buildStaffingLagModel(built.pairs);

test("historical schedule exact-join produces a meaningful aggregate-only corpus", () => {
  assert.equal(built.join.method, "exact_exam_number_zero_pad");
  assert.ok(built.join.matched_pairs >= 200, `matched pairs=${built.join.matched_pairs}`);
  assert.equal(built.join.matched_pairs, built.pairs.length);
  assert.equal(
    built.join.distinct_schedule_exams,
    built.join.matched_pairs + Object.values(built.join.misses).reduce((sum, n) => sum + n, 0),
  );
  assert.ok(built.pairs.every((pair) => pair.application_close <= pair.established_date));
  assert.doesNotMatch(JSON.stringify(built.pairs), /first_name|last_name|list_rank|applicant_name/i);
});

test("nearest-rank ECDF cohorts honor the n>=20 floor and citywide back-off", () => {
  assert.equal(model.floor, STAFFING_LIST_COHORT_FLOOR);
  assert.ok(model.cohorts.citywide.n >= 200);
  assert.ok(model.cohorts.open_competitive.n >= STAFFING_LIST_COHORT_FLOOR);
  assert.ok(model.cohorts.promotion.n >= STAFFING_LIST_COHORT_FLOOR);
  for (const cohort of Object.values(model.cohorts)) {
    assert.ok(cohort.p10_days <= cohort.p50_days);
    assert.ok(cohort.p50_days <= cohort.p90_days);
  }
  assert.equal(model.cohorts.open_competitive.n, 307);
  assert.equal(model.cohorts.open_competitive.median_months, 8);
  assert.equal(model.cohorts.promotion.n, 135);
  assert.equal(model.cohorts.promotion.median_months, 12);
  assert.notEqual(
    model.cohorts.open_competitive.median_months,
    model.cohorts.promotion.median_months,
    "cards must use their exam-type cohort rather than one global median",
  );
});

test("strict 2025 time-split uses the shared scorecard and withholds undercoverage", () => {
  const result = buildStaffingListBacktest(built.pairs);
  assert.ok(result.scorecard.resolved_backtest_predictions >= 50);
  assert.equal(result.scorecard.occurrence_quintiles_monotone, null);
  assert.equal(result.scorecard.ship_bar.checks.occurrence_quintiles_monotone, true);
  assert.equal(result.scorecard.ship_bar.status, "fail");
  assert.equal(result.scorecard.ship_bar.checks.interval_coverage, false);
  assert.equal(result.scorecard.public_projection, "cohort_statistic_only");
});

test("qualified emission uses cityscroll.prediction.v0 and the registered staffing kind", () => {
  const exam = artifact.exams.find((row) => row.exam_number === "7016");
  const stamped = attachStaffingListForecast(exam, model, {
    publicProjection: "per_matter_projection",
    generatedAt: "2026-08-03T00:00:00Z",
  });
  const prediction = stamped.list_establishment_forecast.prediction;
  validatePrediction(prediction);
  assert.equal(prediction.subject_ref, "exam:7016");
  assert.equal(prediction.predicted_event_kind, "staffing.list_established");
  assert.equal(prediction.basis.method, STAFFING_LIST_METHOD);
});

test("materialized staffing artifact exposes only cohort statistics below the ship bar", () => {
  assert.equal(artifact.list_establishment_prediction.join.matched_pairs, built.pairs.length);
  assert.equal(artifact.list_establishment_prediction.backtest.scorecard.public_projection,
    "cohort_statistic_only");
  assert.deepEqual(artifact.list_establishment_predictions, []);
  const withForecast = artifact.exams.filter((exam) => exam.list_establishment_forecast);
  assert.ok(withForecast.length > 20);
  assert.ok(withForecast.every((exam) => exam.list_establishment_forecast.prediction === null));
  for (const exam of artifact.exams) {
    for (const key of Object.keys(exam.list_aggregate || {})) {
      assert.doesNotMatch(key, /first_name|last_name|list_rank|score|applicant/i);
    }
  }
});

test("exam phase spine links to the compact eligible-list timing explainer", () => {
  assert.match(indexHtml, /data-staffing-list-prediction="1"/);
  assert.match(indexHtml, /data-staffing-list-law-context="1"/);
  assert.match(indexHtml, /staffing-list-establishment-formula/);
  assert.match(indexHtml, /data-prediction-subject="eligible-list-establishment"/);
  assert.match(indexHtml, /data-prediction-value=/);
  assert.match(i18n, /If you apply, expect the eligible list for exams like this/);
  assert.doesNotMatch(i18n, /exam_list_prediction_cohort_html:\s*"Predicted based on/);
  assert.match(aboutHtml, /id="staffing-list-establishment-formula"/);
  assert.match(aboutHtml, /never uses applicant names, scores, or ranks/);
  assert.match(aboutHtml, /match exams by exam number and measure from the filing deadline to the date the list was set up/);
});
