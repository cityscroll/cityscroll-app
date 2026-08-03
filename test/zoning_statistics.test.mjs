/**
 * cs-pred-08: transparent ZAP phase-duration and outcome base rates.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { readFileSync } from "node:fs";

import {
  MIN_ZONING_COHORT,
  MAX_ZONING_DURATION_DAYS,
  buildZoningCohortModel,
  chooseZoningCohort,
  classifyProjectOutcome,
  emitZoningStatisticalPrediction,
  zoningStatisticCopy,
  attachZoningStatistics,
} from "../worker/src/lib/zoning_statistics.mjs";
import { validatePrediction } from "../worker/src/lib/prediction_contract.mjs";

const DAY_MS = 86_400_000;

function addDays(value, days) {
  return new Date(Date.parse(`${value}T00:00:00Z`) + days * DAY_MS)
    .toISOString()
    .slice(0, 10);
}

function trainingRow(index, overrides = {}) {
  const certified = addDays("2020-01-01", index * 7);
  const outcome = index % 10 === 0 ? "modified" : index % 20 === 0 ? "disapproved" : "approved";
  return {
    project_id: `TRAIN${String(index).padStart(3, "0")}`,
    actions: "ZM",
    borough: "Queens",
    certified_referred: certified,
    disposition_date: addDays(certified, 120 + (index % 40)),
    outcome,
    ...overrides,
  };
}

test("final action statuses map to approved / modified / disapproved without treating withdrawals as denials", () => {
  assert.equal(classifyProjectOutcome({ action_statuses: ["Approved"] }), "approved");
  assert.equal(
    classifyProjectOutcome({ action_statuses: ["Approved", "Disapproved"] }),
    "modified",
  );
  assert.equal(classifyProjectOutcome({ action_statuses: ["Disapproved"] }), "disapproved");
  assert.equal(classifyProjectOutcome({ action_statuses: ["Withdrawn"] }), null);
  assert.equal(classifyProjectOutcome({ action_statuses: ["Terminated"] }), null);
});

test("action type + borough cohorts require n>=20 and back off deterministically", () => {
  const rows = Array.from({ length: MIN_ZONING_COHORT + 5 }, (_, index) => trainingRow(index));
  rows.push(...Array.from({ length: 7 }, (_, index) => trainingRow(100 + index, {
    project_id: `THIN${index}`,
    borough: "Bronx",
  })));
  const model = buildZoningCohortModel(rows, { trainTo: "2024-12-31" });

  const exact = chooseZoningCohort(model, { actions: "ZM", borough: "Queens" });
  assert.equal(exact.level, "action_type_borough");
  assert.equal(exact.action_type, "ZM");
  assert.equal(exact.borough, "Queens");
  assert.ok(exact.n >= MIN_ZONING_COHORT);

  const backedOff = chooseZoningCohort(model, { actions: "ZM", borough: "Bronx" });
  assert.equal(backedOff.level, "action_type_citywide");
  assert.equal(backedOff.action_type, "ZM");
  assert.equal(backedOff.borough, null);
  assert.ok(backedOff.n >= MIN_ZONING_COHORT);
});

test("cohort model publishes ECDF duration quantiles and three-way outcome rates", () => {
  const rows = Array.from({ length: 40 }, (_, index) => trainingRow(index, {
    outcome: index < 30 ? "approved" : index < 36 ? "modified" : "disapproved",
  }));
  const model = buildZoningCohortModel(rows, { trainTo: "2024-12-31" });
  const cohort = chooseZoningCohort(model, { actions: "ZM", borough: "Queens" });

  assert.equal(cohort.n, 40);
  assert.equal(cohort.outcome_counts.approved, 30);
  assert.equal(cohort.outcome_counts.modified, 6);
  assert.equal(cohort.outcome_counts.disapproved, 4);
  assert.equal(cohort.outcome_rates.approved, 0.75);
  assert.ok(cohort.duration_days.p10 <= cohort.duration_days.p50);
  assert.ok(cohort.duration_days.p50 <= cohort.duration_days.p90);
  assert.ok(cohort.typical_months.low <= cohort.typical_months.high);
  assert.equal(cohort.train_from, "2020-01-01");
});

test("statistical timing emits through cityscroll.prediction.v0 and copy names its sample", () => {
  const rows = Array.from({ length: 40 }, (_, index) => trainingRow(index));
  const model = buildZoningCohortModel(rows, { trainTo: "2024-12-31" });
  const cohort = chooseZoningCohort(model, { actions: "ZM", borough: "Queens" });
  const record = {
    project_id: "ACTIVE001",
    actions: "ZM",
    borough: "Queens",
    certified_referred: "2025-01-15",
  };
  const prediction = emitZoningStatisticalPrediction(record, cohort, {
    generatedAt: "2025-02-01T00:00:00Z",
  });

  validatePrediction(prediction);
  assert.equal(prediction.predicted_event_kind, "land.zap_disposition");
  assert.equal(prediction.claim, "timing");
  assert.equal(prediction.basis.method, "phase_duration_ecdf");
  assert.equal(prediction.basis.n, cohort.duration_n);
  assert.equal(prediction.predicted_window.p50, addDays("2025-01-15", cohort.duration_days.p50));

  const copy = zoningStatisticCopy(cohort);
  assert.match(copy, /^Based on 40 past zoning map amendment cases since 2020\./);
  assert.match(copy, /% were approved\. Final action usually came .* months after certification\.$/);
});

test("unconditioned cohorts contain no applicant dimension", () => {
  const rows = Array.from({ length: 25 }, (_, index) => trainingRow(index, {
    primary_applicant: index % 2 ? "Applicant A" : "Applicant B",
  }));
  const model = buildZoningCohortModel(rows, { trainTo: "2024-12-31" });
  const serialized = JSON.stringify(model);
  assert.doesNotMatch(serialized, /Applicant A|Applicant B|primary_applicant/);
});

test("implausible multi-year spans do not distort the two-year duration distribution", () => {
  const rows = Array.from({ length: 25 }, (_, index) => trainingRow(index));
  rows.push(trainingRow(99, {
    project_id: "STALEDATE",
    certified_referred: "1970-01-01",
    disposition_date: "2025-01-01",
  }));
  const model = buildZoningCohortModel(rows, { trainTo: "2025-01-01" });
  const cohort = chooseZoningCohort(model, { actions: "ZM", borough: "Queens" });
  assert.equal(cohort.duration_n, 25);
  assert.ok(cohort.duration_days.p90 <= MAX_ZONING_DURATION_DAYS);
});

test("committed materialization passes the ship bar and attaches an unconditioned base rate", () => {
  const materialization = JSON.parse(readFileSync(
    new URL("../site/data/zoning_statistics.json", import.meta.url),
    "utf8",
  ));
  assert.equal(materialization.backtest.ship_bar.status, "pass");
  assert.equal(materialization.backtest.resolved_backtest_predictions, 63);
  assert.equal(materialization.conditioned_on_applicant, false);
  assert.ok(materialization.cohorts.every((cohort) => cohort.n >= MIN_ZONING_COHORT));

  const attached = attachZoningStatistics({
    project_id: "CURRENT001",
    generated_at: "2026-01-01T00:00:00Z",
    open_data: {
      project_id: "CURRENT001",
      actions: "ZM",
      borough: "Queens",
      certified_referred: "2025-12-01",
    },
    predictions: [],
  }, materialization, { generatedAt: "2026-01-01T00:00:00Z" });
  assert.ok(attached.zoning_statistics);
  assert.equal(attached.zoning_statistics.display_mode, "cohort_statistic_and_timing");
  assert.equal(attached.predictions.at(-1).basis.method, "phase_duration_ecdf");
});

test("land timeline renders the base-rate register and formula page publishes every equation", () => {
  const index = readFileSync(new URL("../site/index.html", import.meta.url), "utf8");
  const about = readFileSync(new URL("../site/about.html", import.meta.url), "utf8");
  const worker = readFileSync(new URL("../worker/src/zap_outcomes.mjs", import.meta.url), "utf8");
  assert.match(index, /function landZoningStatisticsHTML/);
  assert.match(index, /data-zoning-base-rate/);
  assert.match(index, /land_zoning_base_rate_authority_html/);
  assert.match(about, /id="zoning-base-rates"/);
  assert.match(about, /take p25 and p75 by nearest rank/);
  assert.match(about, /Each rate is its count divided by the total of those three results/);
  assert.match(about, /It resolved 63 cases/);
  assert.match(about, /77\.78%/);
  assert.match(worker, /attachZoningStatistics/);
  assert.match(worker, /zoning_statistics\.json/);
});

test("before/after land-timeline evidence is committed and checksum-pinned", () => {
  const evidenceRoot = new URL("../docs/screenshots/zoning-statistics/", import.meta.url);
  const manifest = JSON.parse(readFileSync(new URL("manifest.json", evidenceRoot), "utf8"));
  assert.equal(manifest.feature, "zoning-duration-outcome-base-rates");
  assert.deepEqual(
    manifest.files.map((file) => file.name).sort(),
    [
      "land-timeline-after-1440.png",
      "land-timeline-after-390.png",
      "land-timeline-before-1440.png",
      "land-timeline-before-390.png",
    ],
  );
  for (const file of manifest.files) {
    const bytes = readFileSync(new URL(file.name, evidenceRoot));
    assert.equal(bytes.length, file.bytes);
    assert.equal(createHash("sha256").update(bytes).digest("hex"), file.sha256);
  }
});
