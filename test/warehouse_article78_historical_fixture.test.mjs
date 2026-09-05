import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  ARTICLE78_DECISION_FILING_TYPES,
  applyDecisionSupersession,
  challengeWatchValue,
} from "../warehouse/lib/article78_litigation.mjs";
import {
  ARTICLE78_HISTORICAL_FIXTURE_SCHEMA,
  Article78HistoricalFixtureError,
  assertAllMetricsDiagnostic,
  assertFixtureExcluded,
  diagnosticMetric,
  evaluateHistoricalFixtureExpectations,
  HISTORICAL_FIXTURE_ROLE,
  loadHistoricalFixture,
} from "../warehouse/lib/article78_historical_fixture.mjs";

const FIXTURE = loadHistoricalFixture();

function determinationByKey(key) {
  const row = FIXTURE.clean.determinations.find((d) => d.determination_key === key);
  assert.ok(row, `fixture must carry a determination_context for ${key}`);
  return row;
}

function evaluateChallengeWatch(determinationKey) {
  return challengeWatchValue({
    determination: determinationByKey(determinationKey),
    cases: FIXTURE.clean.cases,
    coverage: FIXTURE.clean.coverage,
  });
}

function effectiveDecisionsByCase() {
  const decisions = FIXTURE.clean.filings.filter((row) => ARTICLE78_DECISION_FILING_TYPES.includes(row.filing_type));
  const effective = applyDecisionSupersession(decisions, FIXTURE.clean.supersessions);
  return new Map(effective.map((row) => [row.case_key, row]));
}

function coverageByKey(key) {
  const row = FIXTURE.clean.coverage.find((c) => c.coverage_key === key);
  assert.ok(row, `fixture must carry search_coverage ${key}`);
  return row;
}

function projectByExpectationKey(expectationKey) {
  const project = FIXTURE.projects.find((p) => (p.expectation_keys ?? []).includes(expectationKey));
  assert.ok(project, `index.json must document expectation ${expectationKey}`);
  return project;
}

describe("A78-02 historical QA fixture (A1, A2, A3, negative rule)", () => {
  it("loads exactly thirteen documented projects and thirty-six events, every row tagged qa_historical", () => {
    assert.equal(FIXTURE.schema, ARTICLE78_HISTORICAL_FIXTURE_SCHEMA);
    assert.equal(FIXTURE.fixture_role, HISTORICAL_FIXTURE_ROLE);
    assert.equal(FIXTURE.projects.length, 13);
    const eventCount = FIXTURE.coverage.length + FIXTURE.cases.length + FIXTURE.filings.length
      + FIXTURE.claims.length + FIXTURE.supersessions.length;
    assert.equal(eventCount, 36);
    const allRows = [...FIXTURE.determinations, ...FIXTURE.coverage, ...FIXTURE.cases, ...FIXTURE.filings, ...FIXTURE.claims, ...FIXTURE.supersessions];
    for (const row of allRows) assert.equal(row.fixture_role, "qa_historical");
  });

  it("A2: every documented expectation across all thirteen projects runs and passes", () => {
    assert.ok(FIXTURE.expectations.length > 0, "the index must document at least one expectation");
    const report = evaluateHistoricalFixtureExpectations(FIXTURE);
    assert.equal(report.diagnostic_only, true);
    assert.equal(report.scope, "fixture");
    assert.equal(report.expectation_count, FIXTURE.expectations.length);
    if (report.failed_count > 0) {
      assert.fail(`historical fixture expectations failed: ${JSON.stringify(report.expectations.filter((row) => !row.ok), null, 2)}`);
    }
  });

  it("Gowanus keeps filing watch high with a service-of-process failure recorded separately from the merits", () => {
    const project = projectByExpectationKey("gowanus_filing_watch_high_service_failure_separate_from_merits");
    const watch = evaluateChallengeWatch(project.determination_key);
    assert.equal(watch.value, 2, "both petitions are counted regardless of how either was disposed of");
    assert.equal(watch.basis.reason, "counted_under_recorded_search");

    const effectiveByCase = effectiveDecisionsByCase();
    const dismissedCase = project.cases[0];
    const effective = effectiveByCase.get(dismissedCase);
    assert.equal(effective.case_outcome.procedural_survival, "dismissed_other_threshold");
    // The service defect is a threshold/procedural fact. It must not be
    // reported as a merits loss or as any remedy having been reached.
    assert.equal(effective.case_outcome.durable_petitioner_relief, "none");
    assert.equal(effective.case_outcome.remedy_exposure, "no_remedy_ordered");
  });

  it("City Point keeps filing watch high while a wage-only SEQRA theory stays weak, and labor is never recorded as misconduct", () => {
    const project = projectByExpectationKey("city_point_filing_watch_high_wage_only_theory_weak_labor_not_misconduct");
    const watch = evaluateChallengeWatch(project.determination_key);
    assert.equal(watch.value, 2, "both petitions are counted");
    assert.equal(watch.basis.reason, "counted_under_recorded_search");

    const wageCaseKey = project.cases[1];
    const claim = FIXTURE.clean.claims.find((row) => row.case_key === wageCaseKey);
    assert.ok(claim, "the wage-only theory must be recorded as a claim_theory");
    assert.equal(claim.theory_category, "substantive_seqra_ceqr");
    assert.doesNotMatch(claim.description.toLowerCase(), /misconduct/, "labor advocacy is never characterized as misconduct");

    const effectiveByCase = effectiveDecisionsByCase();
    const effective = effectiveByCase.get(wageCaseKey);
    assert.equal(effective.case_outcome.durable_petitioner_relief, "none", "the wage-only theory stayed weak and did not win");
  });

  it("200 Amsterdam Avenue has a prior administrative challenge that affects the watch value, and construction affects the remedy", () => {
    const project = projectByExpectationKey("200_amsterdam_prior_administrative_challenge_affects_watch_construction_affects_remedy");
    const watch = evaluateChallengeWatch(project.determination_key);
    assert.equal(watch.value, 2, "the prior administrative challenge, carried into Article 78 review, counts toward the watch value");
    assert.equal(watch.basis.reason, "counted_under_recorded_search");

    const adminCaseKey = project.cases[0];
    const adminClaim = FIXTURE.clean.claims.find((row) => row.case_key === adminCaseKey);
    assert.ok(adminClaim, "the prior administrative challenge must be recorded as a claim_theory");
    assert.match(adminClaim.description.toLowerCase(), /administrative appeal/);

    const effectiveByCase = effectiveDecisionsByCase();
    const mainCaseKey = project.cases[1];
    const effective = effectiveByCase.get(mainCaseKey);
    assert.equal(effective.case_outcome.remedy_exposure, "construction_restrained", "construction affects remedy, kept separate from relief");
    assert.equal(effective.case_outcome.durable_petitioner_relief, "injunctive_relief");
  });

  it("Mott Haven's missing essential monitoring search supports an elevated durable-relief diagnostic, marked diagnostic-only", () => {
    const project = projectByExpectationKey("mott_haven_missing_monitoring_elevates_durable_relief_diagnostic");
    const watch = evaluateChallengeWatch(project.determination_key);
    assert.equal(watch.value, null, "no adequate search covers whether the monitoring commitment was ever challenged");
    assert.equal(watch.basis.reason, "recorded_search_does_not_cover_this_determination");

    const monitoringCoverage = FIXTURE.clean.coverage.find((row) => row.determination_key === project.determination_key);
    assert.equal(monitoringCoverage.coverage_grade, "U");

    const metric = diagnosticMetric("mott_haven_durable_relief_risk", "elevated");
    assert.deepEqual(metric, { name: "mott_haven_durable_relief_risk", value: "elevated", scope: "fixture", diagnostic_only: true });
    assertAllMetricsDiagnostic([metric], "mott haven diagnostic");
  });

  it("Innovation QNS retains and explains a deliberate false positive rather than dropping it", () => {
    const project = projectByExpectationKey("innovation_qns_retains_and_explains_a_deliberate_false_positive");
    const watch = evaluateChallengeWatch(project.determination_key);
    assert.equal(watch.value, 0, "the false positive does not name this determination, so it does not inflate the count");
    assert.equal(watch.basis.reason, "counted_under_recorded_search");

    const coverage = FIXTURE.clean.coverage.find((row) => row.determination_key === project.determination_key);
    assert.equal(coverage.result_count, 2, "the raw search still returned both hits");
    assert.deepEqual(coverage.located_case_keys, project.cases, "the false positive is retained in located_case_keys, not scrubbed out");
    assert.match(coverage.coverage_note.toLowerCase(), /false positive/, "the coverage note explains the false positive rather than hiding it");
  });

  it("Bronx Metro-North proves that an EIS covering multiple actions is still insufficient for a high watch value", () => {
    const project = projectByExpectationKey("bronx_metro_north_eis_multiple_actions_still_insufficient_for_high_watch");
    const watch = evaluateChallengeWatch(project.determination_key);
    assert.equal(watch.value, null, "environmental review breadth does not substitute for adequate court-record search coverage");
    assert.equal(watch.basis.reason, "recorded_search_does_not_cover_this_determination");

    const coverage = FIXTURE.clean.coverage.find((row) => row.determination_key === project.determination_key);
    assert.match(coverage.coverage_note.toLowerCase(), /environmental impact statement/);
    assert.match(coverage.coverage_note.toLowerCase(), /rezoning.*disposition.*capital|bundled action/);
  });

  it("a trial win reversed on appeal does not remain a durable win", () => {
    const project = projectByExpectationKey("trial_win_reversed_on_appeal_is_not_durable");
    const effectiveByCase = effectiveDecisionsByCase();
    const caseKey = project.cases[0];
    const effective = effectiveByCase.get(caseKey);
    assert.equal(effective.unresolved, null);
    assert.equal(effective.superseded_decision_keys.length, 1, "the trial decision is recorded as superseded, not overwritten");
    assert.equal(effective.case_outcome.durable_petitioner_relief, "none");
    assert.equal(effective.case_outcome.remedy_exposure, "no_remedy_ordered");
    assert.equal(effective.supersession_chain[0].disposition, "reversed");
    assert.equal(effective.supersession_chain[0].disturbs_relief, true);
  });

  it("A1: assertFixtureExcluded passes on a clean corpus and fails, naming the offending row, when a fixture row is injected into a fold", () => {
    const cleanCorpus = {
      rows: [{ row_key: "baseline_row:review:demo-1", review_key: "review:demo-1", project_key: "project:demo" }],
      fold_assignments: [{ fold_id: 0, review_key: "review:demo-1", split: "train" }],
    };
    const clean = assertFixtureExcluded(cleanCorpus, { context: "test clean corpus" });
    assert.equal(clean.ok, true);

    const fixtureCaseKey = FIXTURE.cases[0].case_key;
    const dirtyCorpus = {
      rows: [{ row_key: "baseline_row:review:demo-1", review_key: "review:demo-1", project_key: "project:demo" }],
      fold_assignments: [{ fold_id: 0, review_key: fixtureCaseKey, split: "train" }],
    };
    assert.throws(
      () => assertFixtureExcluded(dirtyCorpus, { context: "test dirty corpus" }),
      (error) => {
        assert.ok(error instanceof Article78HistoricalFixtureError);
        assert.match(error.message, /must never enter a training corpus or fold/);
        assert.match(error.message, /fold_assignments\[0\]/);
        return true;
      },
    );
  });

  it("A3: every metric emitted over the fixture carries diagnostic_only: true, and an unwrapped metric is refused", () => {
    const metrics = FIXTURE.projects.map((project) => diagnosticMetric(`${project.project_id}_case_count`, project.cases.length));
    assertAllMetricsDiagnostic(metrics, "per-project case counts");
    for (const metric of metrics) {
      assert.equal(metric.diagnostic_only, true);
      assert.equal(metric.scope, "fixture");
    }

    const unwrapped = { name: "sneaky_metric", value: 1 };
    assert.throws(
      () => assertAllMetricsDiagnostic([...metrics, unwrapped], "with an unwrapped metric"),
      Article78HistoricalFixtureError,
    );
  });
});
