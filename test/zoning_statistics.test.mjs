/**
 * cs-pred-08: transparent ZAP phase-duration and outcome base rates.
 * cs-pred-11: applicant-conditioned outcome rates on the same cohort engine.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { readFileSync } from "node:fs";

import {
  MIN_ZONING_COHORT,
  MAX_ZONING_DURATION_DAYS,
  buildZoningCohortModel,
  buildApplicantConditionedCohorts,
  chooseZoningCohort,
  chooseApplicantCohort,
  classifyProjectOutcome,
  emitZoningStatisticalPrediction,
  emitApplicantOutcomePrediction,
  applicantConditionedCopy,
  resolveZoningApplicant,
  scoreApplicantConditioning,
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

function applicantTrainingRows(applicant, count, overrides = {}) {
  return Array.from({ length: count }, (_, index) => {
    const certified = addDays("2019-01-01", index * 14);
    const outcome = index % 5 === 0 ? "modified" : "approved";
    return {
      project_id: `${applicant.slice(0, 4).toUpperCase()}${String(index).padStart(3, "0")}`,
      actions: "ZM",
      borough: "Queens",
      primary_applicant: applicant,
      certified_referred: certified,
      disposition_date: addDays(certified, 100 + (index % 30)),
      approval_date: outcome === "approved" ? addDays(certified, 100 + (index % 30)) : null,
      outcome,
      ...overrides,
    };
  });
}

test("entity resolution merges ZAP agency acronyms and Calvanico stems", () => {
  const hpdBare = resolveZoningApplicant("HPD");
  const hpdFull = resolveZoningApplicant(
    "HPD - NYC Dept of Housing Preservation & Development",
  );
  assert.equal(hpdBare.entity_key, hpdFull.entity_key);
  assert.equal(hpdBare.entity_kind, "agency");
  assert.equal(hpdBare.link_confidence.status, "strong");

  const a = resolveZoningApplicant("CALVANICO ASSOC.");
  const b = resolveZoningApplicant("Calvanico Associates");
  assert.equal(a.entity_key, b.entity_key);
  assert.equal(a.entity_kind, "vendor");
  assert.equal(a.link_confidence.status, "tentative");
});

test("applicant-conditioned cohorts require n>=20 and stay off thinner applicants", () => {
  const rows = [
    ...applicantTrainingRows("Repeat Applicant LLC", MIN_ZONING_COHORT + 5),
    ...applicantTrainingRows("Thin Applicant LLC", 8),
  ];
  const model = buildApplicantConditionedCohorts(rows, { trainTo: "2024-12-31" });
  assert.equal(model.conditioned_on_applicant, true);
  assert.equal(model.minimum_cohort_n, MIN_ZONING_COHORT);
  assert.ok(model.cohorts.every((cohort) => cohort.n >= MIN_ZONING_COHORT));
  assert.ok(chooseApplicantCohort(model, { primary_applicant: "Repeat Applicant LLC" }));
  assert.equal(chooseApplicantCohort(model, { primary_applicant: "Thin Applicant LLC" }), null);
});

test("conditioned copy always names the unconditioned base rate alongside", () => {
  const rows = applicantTrainingRows("Repeat Applicant LLC", 25);
  const conditionedModel = buildApplicantConditionedCohorts(rows);
  const baseModel = buildZoningCohortModel(rows);
  const conditioned = chooseApplicantCohort(conditionedModel, {
    primary_applicant: "Repeat Applicant LLC",
  });
  const base = chooseZoningCohort(baseModel, { actions: "ZM", borough: "Queens" });
  const copy = applicantConditionedCopy(conditioned, base, {
    publicProjection: "descriptive_history",
  });
  assert.match(copy, /Based on 25 applications by this applicant since 2019/);
  assert.match(copy, /% approved, vs \d+% overall/);
  assert.doesNotMatch(copy, /^Predicted based on/);
});

test("occurrence emission requires n>=20, base rate, and predictive projection", () => {
  const rows = applicantTrainingRows("Repeat Applicant LLC", 25);
  const conditionedModel = buildApplicantConditionedCohorts(rows);
  const baseModel = buildZoningCohortModel(rows);
  const conditioned = chooseApplicantCohort(conditionedModel, {
    primary_applicant: "Repeat Applicant LLC",
  });
  const base = chooseZoningCohort(baseModel, { actions: "ZM", borough: "Queens" });
  const record = {
    project_id: "LIVE001",
    actions: "ZM",
    borough: "Queens",
    primary_applicant: "Repeat Applicant LLC",
    certified_referred: "2025-03-01",
  };

  assert.equal(
    emitApplicantOutcomePrediction(record, conditioned, base, {
      publicProjection: "descriptive_history",
      generatedAt: "2025-04-01T00:00:00Z",
    }),
    null,
  );

  const prediction = emitApplicantOutcomePrediction(record, conditioned, base, {
    publicProjection: "per_matter_projection",
    generatedAt: "2025-04-01T00:00:00Z",
  });
  validatePrediction(prediction);
  assert.equal(prediction.claim, "occurrence");
  assert.equal(prediction.basis.method, "base_rate");
  assert.equal(prediction.predicted_event_kind, "land.zap_disposition");
  assert.equal(prediction.probability, conditioned.outcome_rates.approved);
  assert.equal(prediction.basis.n, conditioned.n);
});

test("attach surfaces conditioned rates with base rate and blocks thin cohorts", () => {
  const rows = applicantTrainingRows("Repeat Applicant LLC", 30);
  const baseModel = buildZoningCohortModel(rows, { trainTo: "2024-12-31" });
  const applicantModel = buildApplicantConditionedCohorts(rows, { trainTo: "2024-12-31" });
  const model = {
    ...baseModel,
    backtest: { ship_bar: { status: "pass" } },
    applicant_conditioning: {
      ...applicantModel,
      public_projection: "descriptive_history",
      backtest: { public_projection: "descriptive_history", beats_base_rate: false },
    },
  };
  const attached = attachZoningStatistics({
    project_id: "LIVE002",
    generated_at: "2026-01-01T00:00:00Z",
    open_data: {
      project_id: "LIVE002",
      actions: "ZM",
      borough: "Queens",
      primary_applicant: "Repeat Applicant LLC",
      certified_referred: "2025-12-01",
    },
    predictions: [],
  }, model, { generatedAt: "2026-01-01T00:00:00Z" });

  assert.ok(attached.zoning_statistics.applicant_conditioned);
  assert.equal(attached.zoning_statistics.applicant_conditioned.n, 30);
  assert.ok(attached.zoning_statistics.applicant_conditioned.base_rate);
  assert.match(
    attached.zoning_statistics.applicant_conditioned.copy,
    /vs \d+% overall/,
  );
  // descriptive_history: no occurrence prediction emitted
  assert.ok(!attached.predictions.some((row) => row.model_name === "zap_applicant_outcome_rate"));
});

test("backtest labels descriptive history when conditioning does not beat the base rate", () => {
  // Same rate for all applicants → conditioning cannot beat the base rate.
  const rows = [
    ...applicantTrainingRows("Firm A LLC", 40),
    ...applicantTrainingRows("Firm B LLC", 40),
  ];
  const score = scoreApplicantConditioning(rows, { splitDate: "2022-01-01" });
  assert.equal(typeof score.beats_base_rate, "boolean");
  assert.ok(["descriptive_history", "per_matter_projection"].includes(score.public_projection));
  if (!score.beats_base_rate) {
    assert.equal(score.public_projection, "descriptive_history");
  }
});

test("committed materialization ships applicant conditioning with n>=20 and false-positive modes", () => {
  const materialization = JSON.parse(readFileSync(
    new URL("../site/data/zoning_statistics.json", import.meta.url),
    "utf8",
  ));
  assert.equal(materialization.conditioned_on_applicant, false);
  const applicant = materialization.applicant_conditioning;
  assert.ok(applicant);
  assert.ok(applicant.minimum_cohort_n >= 20);
  assert.ok(applicant.cohorts.length >= 1);
  assert.ok(applicant.cohorts.every((cohort) => cohort.n >= applicant.minimum_cohort_n));
  assert.ok(applicant.formula.false_positive_modes.length >= 3);
  assert.match(
    applicant.formula.false_positive_modes.join(" "),
    /entity-resolution|mislink/i,
  );
  assert.match(applicant.formula.false_positive_modes.join(" "), /small-cohort|noise/i);
  assert.match(applicant.formula.false_positive_modes.join(" "), /era effect/i);
  assert.ok(["descriptive_history", "per_matter_projection"].includes(applicant.public_projection));
});

test("formula page and land UI name applicant conditioning constraints", () => {
  const index = readFileSync(new URL("../site/index.html", import.meta.url), "utf8");
  const about = readFileSync(new URL("../site/about.html", import.meta.url), "utf8");
  const i18n = readFileSync(new URL("../site/i18n.js", import.meta.url), "utf8");
  assert.match(index, /function landApplicantConditionedHTML/);
  assert.match(index, /data-applicant-conditioned/);
  assert.match(about, /id="applicant-conditioned-ulurp"/);
  assert.match(about, /False-positive modes/);
  assert.match(about, /entity-resolution mislinks/i);
  assert.match(about, /Small-cohort noise/);
  assert.match(about, /Era effects/);
  assert.match(about, /at least <b>20<\/b>/);
  assert.match(i18n, /land_applicant_conditioned_predict_html/);
  assert.match(i18n, /vs \{p0\}% overall/);
});

test("before/after applicant-entity evidence is committed and checksum-pinned", () => {
  const evidenceRoot = new URL(
    "../docs/screenshots/applicant-conditioned-ulurp/",
    import.meta.url,
  );
  const manifest = JSON.parse(readFileSync(new URL("manifest.json", evidenceRoot), "utf8"));
  assert.equal(manifest.feature, "applicant-conditioned-ulurp-outcome-rates");
  assert.deepEqual(
    manifest.files.map((file) => file.name).sort(),
    [
      "applicant-entity-after-1440.png",
      "applicant-entity-after-390.png",
      "applicant-entity-before-1440.png",
      "applicant-entity-before-390.png",
    ],
  );
  for (const file of manifest.files) {
    const bytes = readFileSync(new URL(file.name, evidenceRoot));
    assert.equal(bytes.length, file.bytes);
    assert.equal(createHash("sha256").update(bytes).digest("hex"), file.sha256);
  }
});
