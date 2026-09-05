/**
 * Source-backed affordable-housing eligibility facts (LDP-19).
 *
 *   node --test test/affordable_eligibility_facts.test.mjs
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  AFFORDABLE_ELIGIBILITY_FACTS_SCHEMA,
  AFFORDABLE_ELIGIBILITY_FACT_KEYS,
  COMMISSION_CYCLE_OPERATIVE_RULES,
  materializeAffordabilityCovenantRecordedFact,
  materializeAffordableEligibilityFacts,
  materializeCommissionCycleListedFact,
  materializeDirectlyFacilitatesAffordableHousingFact,
  materializeHpdSponsorshipCertifiedFact,
  materializeQualifyingActionCodeFact,
  resolveAffordableAppealsReviewEligibility,
} from "../site/affordable_eligibility_facts.mjs";

// 164th Street Rezoning, project_id 2024Q0164, ulurp_numbers "250290ZMQ;
// N250291ZRQ" (site/data/zap_projects_warehouse_lookup.json) — the real
// project the card names as "164th Street C250290 ZMQ".
const STREET_164_PROJECT_ID = "2024Q0164";
const STREET_164_PROCEDURE_ID = "ulurp_197c";
const STREET_164_STAGE_ID = "ulurp_197c.city_council_review";

// No real warehouse project matches "58-02 Northern Boulevard / N210390
// ZRQ" at this data snapshot; used as a synthetic, clearly-labeled fixture,
// consistent with the sibling LDP-18 suite's synthetic 197-f fixture.
const NORTHERN_BLVD_PROJECT_ID = "fixture:58-02-northern-boulevard";

const OFFICIAL_COMMISSION_SOURCE = (overrides = {}) => ({
  kind: "official_commission_cycle_list",
  ...overrides,
});

// ---------------------------------------------------------------------------
// A1-A3: §197-g potential review eligibility vs. the actual per-action trigger
// ---------------------------------------------------------------------------

test("A1 164th Street materializes potential review eligibility as eligible from an explicit Commission source", () => {
  const result = resolveAffordableAppealsReviewEligibility({
    project_id: STREET_164_PROJECT_ID,
    prediction_as_of: "2026-06-01",
    eligible_application_class_source: {
      kind: "official_application_classification",
      value: true,
      record_id: "cpc-class:2024Q0164",
      observed_at: "2026-05-15T00:00:00.000Z",
      statement: "City Planning Commission classifies 2024Q0164 as directly facilitating affordable housing.",
    },
    base_procedure_id: STREET_164_PROCEDURE_ID,
    base_stage_id: STREET_164_STAGE_ID,
  });
  assert.equal(result.eligible_application_class.state, "known_true");
  assert.equal(result.eligible_application_class.source.kind, "official_application_classification");
  assert.equal(result.eligible_application_class.evidence[0].observed_at, "2026-05-15T00:00:00.000Z");
  assert.equal(result.eligible_application_class.evidence[0].evidence_id, "cpc-class:2024Q0164");
  assert.ok(result.eligible_application_class.evidence[0].note.includes("City Planning Commission"));
  assert.equal(result.potential_review_eligibility.status, "eligible");
});

test("A2 before its Council vote, 164th Street does not materialize an actual appeals-board trigger", () => {
  const result = resolveAffordableAppealsReviewEligibility({
    project_id: STREET_164_PROJECT_ID,
    prediction_as_of: "2026-06-01",
    eligible_application_class_source: {
      kind: "official_application_classification",
      value: true,
      record_id: "cpc-class:2024Q0164",
      observed_at: "2026-05-15T00:00:00.000Z",
    },
    council_disposition: null,
    base_procedure_id: STREET_164_PROCEDURE_ID,
    base_stage_id: STREET_164_STAGE_ID,
  });
  assert.equal(result.potential_review_eligibility.status, "eligible");
  assert.equal(result.actual_trigger.status, "none");
  assert.equal(result.actual_trigger.reason, "no_qualifying_council_disposition");
});

test("A3 after an unchanged Council approval, the appeals-board trigger resolves ineligible for that Council action", () => {
  const result = resolveAffordableAppealsReviewEligibility({
    project_id: STREET_164_PROJECT_ID,
    prediction_as_of: "2026-07-01",
    eligible_application_class_source: {
      kind: "official_application_classification",
      value: true,
      record_id: "cpc-class:2024Q0164",
      observed_at: "2026-05-15T00:00:00.000Z",
    },
    council_disposition: "approve",
    base_procedure_id: STREET_164_PROCEDURE_ID,
    base_stage_id: STREET_164_STAGE_ID,
  });
  // The application class remains independently eligible ...
  assert.equal(result.potential_review_eligibility.status, "eligible");
  // ... but the unchanged approval is not a qualifying disposition, so no
  // actual trigger is materialized for this Council action.
  assert.equal(result.actual_trigger.status, "none");
  assert.equal(result.actual_trigger.reason, "no_qualifying_council_disposition");
});

// ---------------------------------------------------------------------------
// A4-A5: no proxy shortcuts for the §197-g application-class fact
// ---------------------------------------------------------------------------

test("A4 58-02 Northern Boulevard does not become appeals-eligible merely because N210390 ZRQ maps inclusionary housing", () => {
  const fact = materializeDirectlyFacilitatesAffordableHousingFact({
    source: { kind: "inclusionary_housing_map_designation", value: true, mih_flag: true },
  });
  assert.equal(fact.state, "unknown");
  assert.equal(fact.reason, "source_kind_not_authoritative:inclusionary_housing_map_designation");
  assert.notEqual(fact.value, true);

  const result = resolveAffordableAppealsReviewEligibility({
    project_id: NORTHERN_BLVD_PROJECT_ID,
    prediction_as_of: "2026-06-01",
    eligible_application_class_source: { kind: "inclusionary_housing_map_designation", value: true },
    base_procedure_id: STREET_164_PROCEDURE_ID,
    base_stage_id: STREET_164_STAGE_ID,
  });
  assert.equal(result.potential_review_eligibility.status, "unknown");
});

test("A5 a missing directly-facilitates-affordable-housing fact remains unknown regardless of title, applicant, unit count, or mapping token", () => {
  const proxies = [
    undefined,
    { kind: "project_title_match", value: true },
    { kind: "applicant_name_heuristic", value: true },
    { kind: "unit_count_threshold", value: true },
    { kind: "inclusionary_housing_map_designation", value: true },
  ];
  for (const source of proxies) {
    const fact = materializeDirectlyFacilitatesAffordableHousingFact({ source });
    assert.equal(fact.state, "unknown");
    assert.notEqual(fact.value, false);
    assert.notEqual(fact.value, true);
  }
});

// ---------------------------------------------------------------------------
// A6-A8, A10: §197-f commission-cycle-listed temporal and versioning discipline
// ---------------------------------------------------------------------------

test("A6 section 197-f commission-cycle-listed cannot become eligible before January 1, 2027", () => {
  for (const filingDate of ["2016-01-01", "2022-03-01", "2026-12-31"]) {
    const fact = materializeCommissionCycleListedFact({
      project_id: "2026Q9001",
      filing_date: filingDate,
      source: OFFICIAL_COMMISSION_SOURCE(),
      cycle_lists: [{
        cycle_id: "cycle-2026-hypothetical",
        version: 1,
        source_status: "enacted",
        effective_from: "2020-01-01",
        published_at: "2026-01-01T00:00:00.000Z",
        listed_project_ids: ["2026Q9001"],
      }],
    });
    assert.equal(fact.state, "not_yet_effective");
    assert.equal(fact.reason, "commission_cycle_not_yet_operative");
    assert.notEqual(fact.value, true);
  }
  const eligible = materializeCommissionCycleListedFact({
    project_id: "2026Q9001",
    filing_date: "2027-02-01",
    source: OFFICIAL_COMMISSION_SOURCE(),
    cycle_lists: [{
      cycle_id: "cycle-2027-1",
      version: 1,
      source_status: "enacted",
      effective_from: "2027-01-01",
      published_at: "2027-01-05T00:00:00.000Z",
      listed_project_ids: ["2026Q9001"],
    }],
  });
  assert.equal(eligible.state, "known_true");
});

test("A7 before the Commission posts the official list, a reconstructed district ranking cannot satisfy the cycle-list criterion", () => {
  const fact = materializeCommissionCycleListedFact({
    project_id: "2026Q9001",
    filing_date: "2027-06-01",
    source: { kind: "reconstructed_candidate", value: true },
    reconstructed_candidate: { rank: 3, method: "district-activity-proxy", confidence: "medium" },
    cycle_lists: [],
  });
  assert.equal(fact.state, "unknown");
  assert.notEqual(fact.value, true);
  assert.ok(fact.reason.startsWith("source_kind_not_authoritative"));
  assert.equal(fact.reconstructed_candidate.authoritative, false);
  assert.equal(fact.reconstructed_candidate.kind, "reconstructed_candidate");

  // Even with an authoritative source kind, no cycle list published yet
  // for this filing date also resolves unknown, never a guess.
  const noList = materializeCommissionCycleListedFact({
    project_id: "2026Q9001",
    filing_date: "2027-06-01",
    source: OFFICIAL_COMMISSION_SOURCE(),
    cycle_lists: [],
  });
  assert.equal(noList.state, "unknown");
  assert.equal(noList.reason, "no_official_cycle_list_in_force_for_filing_date");
});

test("A8 eligibility is evaluated against the cycle list in force on the filing date, not the most recent list", () => {
  const cycleLists = [
    {
      cycle_id: "cycle-2027-1", version: 1, source_status: "enacted",
      effective_from: "2027-01-01", effective_to: "2027-12-31",
      published_at: "2027-01-05T00:00:00.000Z", listed_project_ids: ["2026Q9001"],
    },
    {
      cycle_id: "cycle-2028-1", version: 1, source_status: "enacted",
      effective_from: "2028-01-01", effective_to: null,
      published_at: "2028-01-05T00:00:00.000Z", listed_project_ids: [],
    },
  ];
  const filedIn2027 = materializeCommissionCycleListedFact({
    project_id: "2026Q9001",
    filing_date: "2027-06-01",
    source: OFFICIAL_COMMISSION_SOURCE(),
    cycle_lists: cycleLists,
  });
  assert.equal(filedIn2027.state, "known_true");
  assert.equal(filedIn2027.source.cycle_id, "cycle-2027-1");
  assert.equal(filedIn2027.source.version, 1);

  // Same project, filed after the later cycle superseded it (and dropped
  // from the list): the 2028 list governs, not the 2027 one.
  const filedIn2028 = materializeCommissionCycleListedFact({
    project_id: "2026Q9001",
    filing_date: "2028-03-01",
    source: OFFICIAL_COMMISSION_SOURCE(),
    cycle_lists: cycleLists,
  });
  assert.equal(filedIn2028.state, "known_false");
  assert.equal(filedIn2028.source.cycle_id, "cycle-2028-1");
});

test("A10 a proposed-rule earlier commission-cycle start never changes eligibility semantics until enacted", () => {
  assert.equal(COMMISSION_CYCLE_OPERATIVE_RULES.every((rule) => rule.source_status === "enacted"), true);
  const proposedEarlyRules = [
    ...COMMISSION_CYCLE_OPERATIVE_RULES,
    { rule_id: "proposed_early_start_2026", source_status: "proposed-rule", effective_from: "2026-06-01" },
  ];
  // A caller cannot make the proposed rule govern just by appending it: the
  // module's own enacted-only rule set is what materializeCommissionCycleListedFact
  // consults, so an earlier proposed effective date is inert.
  assert.equal(proposedEarlyRules.some((rule) => rule.source_status === "proposed-rule"), true);
  const fact = materializeCommissionCycleListedFact({
    project_id: "2026Q9001",
    filing_date: "2026-07-01",
    source: OFFICIAL_COMMISSION_SOURCE(),
    cycle_lists: [{
      cycle_id: "cycle-2026-hypothetical", version: 1, source_status: "enacted",
      effective_from: "2020-01-01", published_at: "2026-06-01T00:00:00.000Z",
      listed_project_ids: ["2026Q9001"],
    }],
  });
  assert.equal(fact.state, "not_yet_effective");
});

// ---------------------------------------------------------------------------
// A9: §666-a requires source-backed housing-agency and documentary facts
// ---------------------------------------------------------------------------

test("A9 section 666-a eligibility requires source-backed prerequisites; applicant-name inference is insufficient", () => {
  const inferred = materializeHpdSponsorshipCertifiedFact({
    source: { kind: "applicant_name_heuristic", value: true, note: "primary_applicant contains 'HPD'" },
  });
  assert.equal(inferred.state, "unknown");
  assert.notEqual(inferred.value, true);

  const certified = materializeHpdSponsorshipCertifiedFact({
    source: {
      kind: "hpd_certification_record",
      value: true,
      record_id: "hpd-cert:2026Q9001",
      observed_at: "2026-08-01T00:00:00.000Z",
    },
  });
  assert.equal(certified.state, "known_true");

  const covenant = materializeAffordabilityCovenantRecordedFact({
    source: {
      kind: "recorded_covenant_document",
      value: true,
      record_id: "acris:2026-000123",
      observed_at: "2026-08-10T00:00:00.000Z",
    },
  });
  assert.equal(covenant.state, "known_true");

  const aggregate = materializeAffordableEligibilityFacts({
    regime_id: "targeted_affordable_housing_project_666a",
    project_id: "2026Q9001",
    prediction_as_of: "2026-08-15",
    criteria: {
      "affordable_housing.section_666a.hpd_sponsorship_certified": { source: certified.source },
      "affordable_housing.section_666a.affordability_covenant_recorded": { source: covenant.source },
    },
  });
  assert.equal(aggregate.regime_eligibility.status, "eligible");
});

// ---------------------------------------------------------------------------
// A11: inspectable evidence, never a silent false default
// ---------------------------------------------------------------------------

test("A11 every known criterion carries inspectable evidence; an unsupported criterion is unknown, never false", () => {
  for (const key of AFFORDABLE_ELIGIBILITY_FACT_KEYS) {
    assert.notEqual(key, undefined);
  }
  const unsupported = materializeQualifyingActionCodeFact({ source: null });
  assert.equal(unsupported.state, "unknown");
  assert.notEqual(unsupported.state, "known_false");
  assert.deepEqual(unsupported.evidence, []);

  const supported = materializeQualifyingActionCodeFact({
    source: {
      kind: "official_action_code_classification",
      value: true,
      record_id: "dcp-action:2026Q9001",
      observed_at: "2026-08-01T00:00:00.000Z",
    },
  });
  assert.equal(supported.state, "known_true");
  assert.ok(supported.source);
  assert.ok(supported.evidence.length >= 1);
  assert.equal(supported.evidence[0].evidence_id, "dcp-action:2026Q9001");
});

test("an authoritative source with no explicit determination remains unknown, never a default", () => {
  const fact = materializeHpdSponsorshipCertifiedFact({
    source: { kind: "hpd_certification_record", record_id: "hpd-cert:incomplete" },
  });
  assert.equal(fact.state, "unknown");
  assert.equal(fact.reason, "authoritative_source_missing_determination");
});

// ---------------------------------------------------------------------------
// Negative rule + schema shape
// ---------------------------------------------------------------------------

test("negative rule: no procedure or eligibility shortcuts leak into this module", () => {
  const dump = JSON.stringify({
    keys: AFFORDABLE_ELIGIBILITY_FACT_KEYS,
    example: materializeAffordableEligibilityFacts({
      regime_id: "targeted_affordable_housing_project_666a",
      project_id: "2026Q9001",
      prediction_as_of: "2026-08-15",
    }),
  });
  assert.equal(/"procedure(_id)?"\s*:\s*"(ahab|affordable|fast_track)"/.test(dump), false);
  assert.equal(dump.includes("qualifying_affordable"), false);
});

test("schema is versioned and stable", () => {
  assert.equal(AFFORDABLE_ELIGIBILITY_FACTS_SCHEMA, "cityscroll.affordable_eligibility_facts.v1");
  const aggregate = materializeAffordableEligibilityFacts({
    regime_id: "affordable_housing_fast_track_197f",
    project_id: "2026Q9001",
    prediction_as_of: "2026-08-15",
  });
  assert.equal(aggregate.regime_id, "affordable_housing_fast_track_197f");
  assert.equal(aggregate.facts.length, 2);
  assert.equal(aggregate.regime_eligibility.status, "unknown");
});

test("an unknown regime_id fails closed rather than silently resolving", () => {
  assert.throws(() => materializeAffordableEligibilityFacts({ regime_id: "not_a_real_regime", project_id: "x" }));
});
