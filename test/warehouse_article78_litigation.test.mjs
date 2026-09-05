import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

import {
  addMonthsToDate,
  applyDecisionSupersession,
  ARTICLE78_CASE_OUTCOME_FIELDS,
  ARTICLE78_DECISION_FILING_TYPES,
  ARTICLE78_LIMITATIONS_MONTHS,
  ARTICLE78_RECORD_SPECS,
  ARTICLE78_RECORD_TYPES,
  Article78LitigationError,
  assertChallengeWatchResult,
  assertNoCombinedOutcomeScore,
  assertNoForbiddenChallengeWatchWording,
  assessSearchCoverageAdequacy,
  buildDecisionSupersessionKey,
  buildJudicialCaseKey,
  buildSearchCoverageKey,
  buildSearchCoverageRecord,
  challengeWatchValue,
  CHALLENGE_WATCH_UNKNOWN_WORDING,
  CHALLENGE_WATCH_ZERO_WORDING,
  dispositionDisturbsRelief,
  findCombinedOutcomeScoreFields,
  findForbiddenChallengeWatchWording,
  FORBIDDEN_CHALLENGE_WATCH_WORDINGS,
  hashSearchQuery,
  limitationsWindow,
  projectToOntologyEntities,
  renderChallengeWatchValue,
  validateArticle78Record,
  validateArticle78RecordSet,
  validateDeterminationContext,
} from "../warehouse/lib/article78_litigation.mjs";
import { validateOntologyGraph } from "../warehouse/lib/seqra_ontology_graph.mjs";
import {
  buildActionKey,
  buildDeterminationKey,
  buildEnvironmentalReviewKey,
} from "../warehouse/lib/seqra_stable_keys.mjs";
import { runArticle78Backtest } from "../tools/backtest_article78_ontology.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FIXTURE_PATH = path.join(ROOT, "warehouse/fixtures/article78/litigation_backtest_fixture.v1.json");
const EXPECTED_PATH = path.join(ROOT, "warehouse/fixtures/article78/litigation_backtest_expected.v1.json");

const FIXTURE = JSON.parse(readFileSync(FIXTURE_PATH, "utf8"));

const scenario = (id) => {
  const entry = FIXTURE.scenarios.find((row) => row.id === id);
  assert.ok(entry, `fixture must carry the ${id} scenario`);
  return entry;
};
const determinationFor = (scenarioId) => {
  const key = scenario(scenarioId).determination_key;
  const row = FIXTURE.determinations.find((entry) => entry.determination_key === key);
  assert.ok(row, `fixture must carry the determination context for ${scenarioId}`);
  return row;
};
const watchFor = (scenarioId) => challengeWatchValue({
  determination: determinationFor(scenarioId),
  cases: FIXTURE.cases,
  coverage: FIXTURE.coverage,
});
const coverageByKey = (key) => FIXTURE.coverage.find((row) => row.coverage_key === key);
const decisions = () => FIXTURE.filings.filter((row) => ARTICLE78_DECISION_FILING_TYPES.includes(row.filing_type));

describe("A78-01 Article 78 litigation ontology (A1, A2, A3, A4, A5, negative rule)", () => {
  it("the committed fixture validates as a record set, with every foreign key resolving", () => {
    assert.deepEqual(validateArticle78RecordSet(FIXTURE), []);
    for (const determination of FIXTURE.determinations) {
      assert.deepEqual(validateDeterminationContext(determination), []);
    }
  });

  // -- A1 ------------------------------------------------------------------

  it("A1: search coverage is a stored entity carrying its whole bounded scope", () => {
    assert.ok(ARTICLE78_RECORD_TYPES.includes("search_coverage"));
    for (const [index, coverage] of FIXTURE.coverage.entries()) {
      assert.deepEqual(validateArticle78Record("search_coverage", coverage, `coverage[${index}]`), []);
      assert.ok(Array.isArray(coverage.scope.courts) && coverage.scope.courts.length > 0, "courts are recorded");
      assert.match(coverage.scope.date_window.from, /^\d{4}-\d{2}-\d{2}$/, "the searched window is recorded");
      assert.match(coverage.scope.date_window.to, /^\d{4}-\d{2}-\d{2}$/);
      assert.ok(Array.isArray(coverage.scope.party_filters), "party filters are recorded");
      assert.ok(Array.isArray(coverage.scope.determination_filters), "determination filters are recorded");
      assert.ok(Number.isInteger(coverage.result_count), "the result count is recorded");
      assert.match(coverage.searched_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/, "the search instant is recorded");
    }
  });

  it("A1: the coverage key is a function of the scope, so a search cannot be renamed away from its own bounds", () => {
    const coverage = FIXTURE.coverage[0];
    assert.equal(coverage.query_hash, hashSearchQuery(coverage.scope));
    assert.equal(
      coverage.coverage_key,
      buildSearchCoverageKey({ source: coverage.source, queryHash: coverage.query_hash, searchedAt: coverage.searched_at }),
    );
    // Widening the courts is a different query, not the same one with a new note.
    const widened = { ...coverage.scope, courts: [...coverage.scope.courts, "NY Supreme Court, Kings County"] };
    assert.notEqual(hashSearchQuery(widened), coverage.query_hash);
    // Re-ordering the same courts is the same query.
    const reordered = { ...coverage.scope, courts: [...coverage.scope.courts].reverse() };
    assert.equal(hashSearchQuery(reordered), coverage.query_hash);
    // A scope that no longer matches its own recorded hash is a finding.
    const tampered = { ...coverage, scope: widened };
    assert.ok(validateArticle78Record("search_coverage", tampered).some((finding) => /query_hash is not the digest/.test(finding)));
  });

  it("A1: a challenge-watch value of zero resolves to the bounded search that produced it", () => {
    const result = watchFor("adequate_search_zero_challenges");
    assert.equal(result.value, 0);
    assert.equal(result.basis.reason, "counted_under_recorded_search");
    assert.ok(result.basis.coverage_keys.length > 0, "a zero must name its search");
    for (const key of result.basis.coverage_keys) {
      const coverage = coverageByKey(key);
      assert.ok(coverage, `basis names a stored search_coverage record: ${key}`);
      assert.deepEqual(assessSearchCoverageAdequacy({ determination: determinationFor("adequate_search_zero_challenges"), coverage }).reasons, []);
    }
    assert.equal(result.basis.as_of, coverageByKey(result.basis.coverage_keys[0]).searched_at);
  });

  it("A1: a located challenge is counted only through the recorded search that found it", () => {
    const result = watchFor("located_challenge");
    assert.equal(result.value, 1);
    assert.deepEqual(result.basis.located_case_keys, [FIXTURE.cases[0].case_key]);
    assert.equal(FIXTURE.cases[0].located_by_coverage_key, result.basis.coverage_keys[0]);

    // A case nobody's recorded search located does not raise the count, because
    // the count is a statement about what the search found.
    const unlocated = { ...FIXTURE.cases[0], case_key: `${FIXTURE.cases[0].case_key}_b`, located_by_coverage_key: null };
    const withUnlocated = challengeWatchValue({
      determination: determinationFor("located_challenge"),
      cases: [...FIXTURE.cases, unlocated],
      coverage: FIXTURE.coverage,
    });
    assert.equal(withUnlocated.value, 1);
  });

  it("A1: a zero with no coverage record is a validation error, not a zero", () => {
    assert.throws(
      () => assertChallengeWatchResult({
        schema: "cityscroll.article78_challenge_watch.v1",
        determination_key: determinationFor("adequate_search_zero_challenges").determination_key,
        value: 0,
        basis: { reason: "counted_under_recorded_search", coverage_keys: [] },
      }),
      (error) => error instanceof Article78LitigationError && /with no coverage record is a validation error/.test(error.message),
    );
    // And the derivation itself never produces one: with the searches removed,
    // the answer is null with a stated reason, not a zero.
    const withoutCoverage = challengeWatchValue({
      determination: determinationFor("adequate_search_zero_challenges"),
      cases: FIXTURE.cases,
      coverage: [],
    });
    assert.equal(withoutCoverage.value, null);
    assert.equal(withoutCoverage.basis.reason, "no_recorded_search");
  });

  // -- A2 ------------------------------------------------------------------

  it("A2: a zero renders as \"no challenge found after the recorded search\"", () => {
    const result = watchFor("adequate_search_zero_challenges");
    assert.equal(CHALLENGE_WATCH_ZERO_WORDING, "no challenge found after the recorded search");
    assert.equal(renderChallengeWatchValue(result), CHALLENGE_WATCH_ZERO_WORDING);
    assert.equal(result.basis.statement, CHALLENGE_WATCH_ZERO_WORDING);
  });

  it("A2: a zero never renders as \"no lawsuit was filed\" (negative test on the exported wording)", () => {
    const forbidden = "no lawsuit was filed";
    assert.ok(FORBIDDEN_CHALLENGE_WATCH_WORDINGS.includes(forbidden));
    assert.deepEqual(findForbiddenChallengeWatchWording(forbidden), [forbidden]);
    assert.deepEqual(findForbiddenChallengeWatchWording("This project: no lawsuit was filed."), [forbidden]);
    assert.throws(
      () => assertNoForbiddenChallengeWatchWording(["No lawsuit was filed against this approval."]),
      (error) => error instanceof Article78LitigationError && /never proof that no case was filed/.test(error.message),
    );
    // Every sentence this module is willing to emit survives its own scan.
    const emitted = [
      CHALLENGE_WATCH_ZERO_WORDING,
      ...Object.values(CHALLENGE_WATCH_UNKNOWN_WORDING),
      ...FIXTURE.determinations.map((determination) => renderChallengeWatchValue(
        challengeWatchValue({ determination, cases: FIXTURE.cases, coverage: FIXTURE.coverage }),
      )),
    ];
    for (const text of emitted) assert.deepEqual(findForbiddenChallengeWatchWording(text), [], text);
    assert.deepEqual(assertNoForbiddenChallengeWatchWording(emitted), { ok: true, checked_count: emitted.length });
  });

  it("A2: every null renders as an absence in the record rather than a fact about the world", () => {
    for (const scenarioId of ["nonfinal_determination", "inadequate_coverage", "open_limitations_window"]) {
      const result = watchFor(scenarioId);
      assert.equal(result.value, null);
      const rendered = renderChallengeWatchValue(result);
      assert.equal(rendered, CHALLENGE_WATCH_UNKNOWN_WORDING[result.basis.reason]);
      assert.match(rendered, /^not established: /);
    }
  });

  // -- A3 ------------------------------------------------------------------

  it("A3: procedural survival, durable petitioner relief and remedy exposure are three separate, independently nullable fields", () => {
    assert.deepEqual(ARTICLE78_CASE_OUTCOME_FIELDS, ["procedural_survival", "durable_petitioner_relief", "remedy_exposure"]);
    const outcomeSpec = ARTICLE78_RECORD_SPECS.case_filing.properties.decision.nested;
    for (const field of ARTICLE78_CASE_OUTCOME_FIELDS) {
      assert.ok(outcomeSpec.required.includes(field), `${field} is a required field of the case outcome`);
      assert.ok(outcomeSpec.properties[field].type.includes("null"), `${field} is independently nullable`);
    }
    // Each one nulls out on its own without touching the others.
    const decision = decisions()[0];
    const partial = {
      ...decision,
      decision: { ...decision.decision, durable_petitioner_relief: null },
    };
    assert.deepEqual(validateArticle78Record("case_filing", partial), []);
  });

  it("A3: no combined score passes validation, under any of its usual names", () => {
    const decision = decisions()[0];
    for (const field of ["score", "outcome_score", "caseStrength", "overall_rating", "litigation_risk_index", "outcomeIndex"]) {
      const scored = { ...decision, decision: { ...decision.decision, [field]: 0.7 } };
      const findings = validateArticle78Record("case_filing", scored);
      assert.ok(
        findings.some((finding) => finding.includes(field) && /combined outcome score/.test(finding)),
        `${field} must be rejected as a combined outcome score, got ${JSON.stringify(findings)}`,
      );
    }
    assert.deepEqual(findCombinedOutcomeScoreFields(ARTICLE78_CASE_OUTCOME_FIELDS), []);
    assert.throws(
      () => assertNoCombinedOutcomeScore(["procedural_survival", "case_outcome_score"]),
      (error) => error instanceof Article78LitigationError && /never combined into one number/.test(error.message),
    );
  });

  it("A3: no record contract anywhere in the module carries a combined outcome score", () => {
    for (const recordType of ARTICLE78_RECORD_TYPES) {
      const spec = ARTICLE78_RECORD_SPECS[recordType];
      const fields = Object.keys(spec.properties);
      for (const [field, fieldSpec] of Object.entries(spec.properties)) {
        if (fieldSpec.nested) fields.push(...Object.keys(fieldSpec.nested.properties).map((nested) => `${field}.${nested}`));
      }
      assert.deepEqual(findCombinedOutcomeScoreFields(fields), [], `${recordType} declares no combined score`);
    }
  });

  it("A3: filing is kept separate from outcome -- a procedural filing may not carry a decision block", () => {
    const petition = FIXTURE.filings.find((row) => row.filing_type === "petition");
    assert.equal(petition.decision, null);
    const smuggled = { ...petition, decision: decisions()[0].decision };
    assert.ok(validateArticle78Record("case_filing", smuggled).some((finding) => /procedural and must not carry a decision block/.test(finding)));
    const emptyDecision = { ...decisions()[0], decision: null };
    assert.ok(validateArticle78Record("case_filing", emptyDecision).some((finding) => /must carry a decision block/.test(finding)));
  });

  // -- A4 ------------------------------------------------------------------

  it("A4: a trial win reversed on appeal does not remain a durable win", () => {
    const [resolved] = applyDecisionSupersession(decisions(), FIXTURE.supersessions);
    const trial = decisions().find((row) => row.decision.court_level === "supreme_court");
    const appellate = decisions().find((row) => row.decision.court_level === "appellate_division");

    assert.equal(trial.decision.durable_petitioner_relief, "annulment", "the trial court did grant relief");
    assert.equal(resolved.effective_decision_key, appellate.filing_key);
    assert.deepEqual(resolved.superseded_decision_keys, [trial.filing_key]);
    assert.equal(resolved.case_outcome.durable_petitioner_relief, "none", "the reversed annulment is not durable relief");
    assert.equal(resolved.case_outcome.remedy_exposure, "no_remedy_ordered");
    assert.equal(resolved.case_outcome.procedural_survival, "survived", "the three fields move independently");
    assert.equal(resolved.unresolved, null);
    assert.deepEqual(resolved.supersession_chain.map((edge) => edge.disposition), ["reversed"]);
    assert.equal(resolved.supersession_chain[0].procedural_posture, "appeal_as_of_right");
    assert.equal(resolved.supersession_chain[0].disturbs_relief, true);

    // The trial decision is still in the store, unaltered. Supersession does
    // not overwrite; it records.
    assert.equal(trial.decision.durable_petitioner_relief, "annulment");
  });

  it("A4: supersession is explicit and is never inferred from dates", () => {
    const [withoutEdges] = applyDecisionSupersession(decisions(), []);
    assert.equal(withoutEdges.effective_decision_key, null);
    assert.match(withoutEdges.unresolved, /2 decisions are unsuperseded/);
    assert.deepEqual(withoutEdges.case_outcome, {
      procedural_survival: null,
      durable_petitioner_relief: null,
      remedy_exposure: null,
    });
  });

  it("A4: an affirmance leaves the earlier relief standing; a reversal, vacatur, modification or remand disturbs it", () => {
    assert.equal(dispositionDisturbsRelief("affirmed"), false);
    assert.equal(dispositionDisturbsRelief("appeal_dismissed"), false);
    for (const disposition of ["reversed", "vacated", "modified", "remanded"]) {
      assert.equal(dispositionDisturbsRelief(disposition), true, disposition);
    }
    assert.throws(() => dispositionDisturbsRelief("upheld"), Article78LitigationError);

    const trial = decisions().find((row) => row.decision.court_level === "supreme_court");
    const appellate = decisions().find((row) => row.decision.court_level === "appellate_division");
    const affirming = {
      ...appellate,
      decision: { ...trial.decision, court_level: "appellate_division", decided_date: appellate.decision.decided_date },
    };
    const edge = { ...FIXTURE.supersessions[0], disposition: "affirmed" };
    const [resolved] = applyDecisionSupersession([trial, affirming], [edge]);
    assert.equal(resolved.effective_decision_key, affirming.filing_key);
    assert.equal(resolved.case_outcome.durable_petitioner_relief, "annulment", "an affirmed annulment is still relief");
    assert.equal(resolved.supersession_chain[0].disturbs_relief, false);
  });

  it("A4: a contradictory decision graph is reported unresolved rather than silently resolved", () => {
    const [trial, appellate] = decisions();
    const cyclic = [
      FIXTURE.supersessions[0],
      {
        ...FIXTURE.supersessions[0],
        supersession_key: buildDecisionSupersessionKey({ supersedingDecisionKey: trial.filing_key, supersededDecisionKey: appellate.filing_key }),
        superseding_decision_key: trial.filing_key,
        superseded_decision_key: appellate.filing_key,
      },
    ];
    const [resolved] = applyDecisionSupersession(decisions(), cyclic);
    assert.equal(resolved.effective_decision_key, null);
    assert.match(resolved.unresolved, /cycle|unsuperseded|every recorded decision/);

    assert.throws(
      () => applyDecisionSupersession([FIXTURE.filings.find((row) => row.filing_type === "petition")], []),
      (error) => error instanceof Article78LitigationError && /not a decision or order/.test(error.message),
    );
    assert.throws(
      () => applyDecisionSupersession([], FIXTURE.supersessions),
      (error) => error instanceof Article78LitigationError && /names an unknown decision/.test(error.message),
    );
  });

  // -- A5 ------------------------------------------------------------------

  it("A5: a nonfinal determination yields null rather than zero", () => {
    const result = watchFor("nonfinal_determination");
    assert.equal(result.value, null);
    assert.equal(result.basis.reason, "determination_not_final");
    assert.equal(limitationsWindow(determinationFor("nonfinal_determination")), null);
  });

  it("A5: an unrecorded finality is its own null, not a nonfinal determination", () => {
    const unknown = { ...determinationFor("located_challenge"), finality: "unknown", final_and_binding_date: null };
    const result = challengeWatchValue({ determination: unknown, cases: FIXTURE.cases, coverage: FIXTURE.coverage });
    assert.equal(result.value, null);
    assert.equal(result.basis.reason, "determination_finality_unknown");
    assert.match(renderChallengeWatchValue(result), /^not established: nobody has recorded whether/);
  });

  it("A5: an open limitations window yields null rather than zero, even under an adequate search", () => {
    const determination = determinationFor("open_limitations_window");
    const result = watchFor("open_limitations_window");
    assert.equal(result.value, null);
    assert.equal(result.basis.reason, "limitations_window_open");
    assert.ok(result.basis.coverage_keys.length > 0, "the premature search is still named");
    const window = limitationsWindow(determination);
    assert.equal(window.opens_on, determination.final_and_binding_date);
    assert.equal(window.closes_on, addMonthsToDate(determination.final_and_binding_date, ARTICLE78_LIMITATIONS_MONTHS));
    assert.ok(result.basis.searched_at[0].slice(0, 10) <= window.closes_on, "the search ran before the window closed");

    // The same search, re-run after the window closes, does produce a zero.
    const later = buildSearchCoverageRecord({
      determinationKey: determination.determination_key,
      source: coverageByKey(result.basis.coverage_keys[0]).source,
      scope: coverageByKey(result.basis.coverage_keys[0]).scope,
      searchedAt: "2027-01-04T00:00:00Z",
      resultCount: 0,
      locatedCaseKeys: [],
      coverageGrade: "A",
      coverageNote: "Same query, re-run after the limitations window closed.",
      observedAt: "2027-01-04T00:00:00Z",
      sourceId: "synthetic_court_record_fixture",
      sourceRecordId: "coverage/synthetic/0004-rerun",
    });
    const reRun = challengeWatchValue({ determination, cases: FIXTURE.cases, coverage: [...FIXTURE.coverage, later] });
    assert.equal(reRun.value, 0);
    assert.ok(reRun.basis.coverage_keys.includes(later.coverage_key));
  });

  it("A5: inadequate coverage yields null rather than zero, and says which bound failed", () => {
    const determination = determinationFor("inadequate_coverage");
    const result = watchFor("inadequate_coverage");
    assert.equal(result.value, null);
    assert.equal(result.basis.reason, "recorded_search_does_not_cover_this_determination");
    const assessment = result.basis.coverage_assessments[0];
    assert.equal(assessment.adequate, false);
    assert.equal(assessment.grade_countable, false);
    assert.equal(assessment.spans_limitations_window, false);
    assert.ok(assessment.reasons.length >= 2, "each failing bound is named separately");
  });

  it("A5/negative rule: a court-search miss under thin coverage is never reported as a zero", () => {
    const determination = determinationFor("inadequate_coverage");
    const thin = FIXTURE.coverage.find((row) => row.determination_key === determination.determination_key);
    assert.equal(thin.result_count, 0, "the search really did come back empty");
    assert.equal(watchFor("inadequate_coverage").value, null, "and it still is not a zero");
  });

  // -- keys, contracts and the SEQRA-02 projection -------------------------

  it("stable keys are deterministic, collision-safe, and refuse to be unstable", () => {
    const key = buildJudicialCaseKey({ court: "NY Supreme Court, New York County", indexNumber: "150001/2024" });
    assert.equal(key, buildJudicialCaseKey({ court: " ny supreme court, new york county ", indexNumber: "150001/2024" }));
    assert.notEqual(key, buildJudicialCaseKey({ court: "NY Supreme Court, Kings County", indexNumber: "150001/2024" }));
    const hashed = buildJudicialCaseKey({ court: "NY Supreme Court, New York County", indexNumberHashSeed: "caption|2024-07-01" });
    assert.match(hashed, /^judicial_case:ny_supreme_court_new_york_county:h[a-f0-9]{16}$/);
    assert.notEqual(hashed, key);
    assert.throws(() => buildJudicialCaseKey({ court: "NY Supreme Court, New York County" }), /indexNumber or indexNumberHashSeed/);
    assert.throws(
      () => buildDecisionSupersessionKey({ supersedingDecisionKey: "case_filing:a", supersededDecisionKey: "case_filing:a" }),
      /cannot supersede itself/,
    );
  });

  it("the limitations window clamps month arithmetic instead of overflowing", () => {
    assert.equal(ARTICLE78_LIMITATIONS_MONTHS, 4);
    assert.equal(addMonthsToDate("2024-10-31", 4), "2025-02-28");
    assert.equal(addMonthsToDate("2023-10-31", 4), "2024-02-29");
    assert.equal(addMonthsToDate("2024-09-15", 4), "2025-01-15");
    // A determination may carry its own shorter window; the default is only a
    // default.
    const overridden = { ...determinationFor("located_challenge"), limitations_window_closes_on: "2024-04-13" };
    assert.equal(limitationsWindow(overridden).closes_on, "2024-04-13");
  });

  it("a final determination that does not say when it became final and binding is a finding", () => {
    const findings = validateDeterminationContext({
      record_schema: "cityscroll.article78_litigation.determination_context.v1",
      determination_key: determinationFor("located_challenge").determination_key,
      finality: "final",
      final_and_binding_date: null,
      limitations_window_closes_on: null,
    });
    assert.ok(findings.some((finding) => /must record the date it became final and binding/.test(finding)));
  });

  it("the records project onto SEQRA-02's frozen entity shapes and the relation graph resolves", () => {
    const projected = projectToOntologyEntities(FIXTURE);
    // Build the upstream slice these entities point at, using SEQRA-02's own
    // key builders, so the projection is checked against the ontology rather
    // than beside it.
    const projectKey = "project:synthetic:a78_01_fixture";
    const actionKey = buildActionKey({ agency: "City Planning Commission", sourceSystem: "synthetic", sourceActionId: "a78-01-fixture" });
    const reviewKey = buildEnvironmentalReviewKey({ environmentalRegime: "CEQR", ceqrNumber: "24DCP001M" });
    const provenance = { observed_at: "2026-02-01T00:00:00Z", source_id: "synthetic_court_record_fixture", source_record_id: "graph/synthetic/0001" };
    const entities = {
      ...projected,
      project: [{
        project_key: projectKey,
        title: "Synthetic fixture project",
        source_system: "synthetic",
        source_project_id: "a78-01-fixture",
        bbl_list: [],
        borough: "Manhattan",
        ...provenance,
      }],
      government_action: [{
        action_key: actionKey,
        project_key: projectKey,
        agency: "City Planning Commission",
        action_type: "zoning_map_amendment",
        source_system: "synthetic",
        source_action_id: "a78-01-fixture",
        ...provenance,
      }],
      environmental_review: [{
        review_key: reviewKey,
        action_key: actionKey,
        environmental_regime: "CEQR",
        jurisdiction_level: "NYC",
        lead_agency: "City Planning Commission",
        ceqr_number: "24DCP001M",
        review_label_as_published: "Synthetic fixture environmental review",
        source_review_id: "a78-01-fixture",
        judicial_review_regime: "NY_ARTICLE_78",
        ...provenance,
      }],
      land_use_determination: FIXTURE.determinations.map((determination) => {
        const [, agency, actionId, date] = determination.determination_key.split(":");
        return {
          determination_key: buildDeterminationKey({ agency, actionId, date }),
          action_key: actionKey,
          review_key: reviewKey,
          agency,
          date,
          outcome: "approved",
          supersedes_determination_key: null,
          ...provenance,
        };
      }),
    };
    const findings = validateOntologyGraph(entities);
    const litigationFindings = findings.filter((finding) => /^(judicial_case|case_filing|claim_theory|search_coverage)\[/.test(finding));
    assert.deepEqual(litigationFindings, [], "the litigation slice resolves against SEQRA-02's entities");
    assert.deepEqual(findings, [], JSON.stringify(findings, null, 2));
  });

  // -- the committed backtest ---------------------------------------------

  it("the backtest reproduces the committed expectation from the committed fixture", () => {
    const expected = JSON.parse(readFileSync(EXPECTED_PATH, "utf8"));
    const receipt = runArticle78Backtest(FIXTURE);
    for (const [key, value] of Object.entries(receipt)) {
      assert.deepEqual(value, expected[key], `${key} must reproduce`);
    }
    assert.deepEqual(receipt.record_set_findings, []);
    assert.equal(receipt.challenge_watch.filter((row) => row.value === null).length, 3, "three of the five paths are null");
    assert.equal(receipt.challenge_watch.filter((row) => row.value === 0).length, 1, "exactly one honest zero");
  });
});
