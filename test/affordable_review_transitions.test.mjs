/**
 * Source-qualified affordable-housing review transitions (LDP-20).
 *
 *   node --test test/affordable_review_transitions.test.mjs
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  AFFORDABLE_REVIEW_TRANSITIONS_SCHEMA,
  APPEALS_IMPLEMENTING_RULE_VERSIONS,
  APPEALS_TRANSITION_KINDS,
  TARGETED_PROJECT_TRANSITION_KINDS,
  materializeAppealsReviewTransitions,
  materializeTargetedProjectTransitions,
} from "../site/affordable_review_transitions.mjs";

// 164th Street Rezoning, project_id 2024Q0164 (site/data/zap_projects_warehouse_lookup.json),
// the same fixture LDP-19's suite uses as "the 164th Street C250290 ZMQ application".
const STREET_164_PROJECT_ID = "2024Q0164";
// 50-20 108th Street Rezoning, project_id 2024Q0113, ulurp_numbers
// "250253ZMQ; N250254ZRQ" (site/data/zap_projects_warehouse_lookup.json) — the
// real project the card names as "the 50-20 108th Street application".
const STREET_108TH_PROJECT_ID = "2024Q0113";
const BASE_PROCEDURE_ID = "ulurp_197c";
const BASE_STAGE_ID = "ulurp_197c.city_council_review";

const CLASS_SOURCE = (overrides = {}) => ({
  kind: "official_application_classification",
  value: true,
  record_id: "cpc-class:fixture",
  observed_at: "2026-05-15T00:00:00.000Z",
  ...overrides,
});

const CONFIRMED_SOURCE = (overrides = {}) => ({
  source_id: "src:fixture",
  url: "https://example.gov/record/fixture",
  status: "confirmed",
  ...overrides,
});

function callUpClaim(projectId, overrides = {}) {
  return {
    kind: "called_up_by_members",
    application_id: projectId,
    actor: { kind: "board_of_standards_and_appeals" },
    observed_at: "2026-07-10T00:00:00.000Z",
    source: CONFIRMED_SOURCE({ source_id: "council-record:call-up" }),
    join_method: "application_id_exact_match",
    members: [
      { member_id: "member-1", source: CONFIRMED_SOURCE({ source_id: "member-1-statement" }) },
      { member_id: "member-2", source: CONFIRMED_SOURCE({ source_id: "member-2-statement" }) },
    ],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// A1-A3: eligibility alone never creates a proceeding; 164th Street vs. 50-20 108th Street
// ---------------------------------------------------------------------------

test("A1 an eligible application with no qualifying Council disposition emits no events, even though the branch is eligible", () => {
  const result = materializeAppealsReviewTransitions({
    project_id: STREET_164_PROJECT_ID,
    base_procedure_id: BASE_PROCEDURE_ID,
    base_stage_id: BASE_STAGE_ID,
    council_disposition: null,
    eligible_application_class_source: CLASS_SOURCE(),
    prediction_as_of: "2026-06-01",
  });
  assert.equal(result.potential_review_eligibility.status, "eligible");
  assert.equal(result.events.length, 0);
  assert.equal(result.status, "no_trigger");
});

test("A2 the 164th Street application produces no appeals review event after its unchanged Council approval", () => {
  const result = materializeAppealsReviewTransitions({
    project_id: STREET_164_PROJECT_ID,
    base_procedure_id: BASE_PROCEDURE_ID,
    base_stage_id: BASE_STAGE_ID,
    council_disposition: "approve",
    eligible_application_class_source: CLASS_SOURCE(),
    prediction_as_of: "2026-07-01",
    // Even if a claim were somehow supplied, an unchanged approval never
    // reaches the invocation path because the trigger itself is "none".
    invocation_claims: [callUpClaim(STREET_164_PROJECT_ID)],
  });
  assert.equal(result.trigger.status, "none");
  assert.equal(result.status, "no_trigger");
  assert.equal(result.events.length, 0);
  assert.equal(result.review_available.available, false);
});

test("A3 the 50-20 108th Street application exposes the Council modification and a potential review state, but no request, meeting, or decision without an exact source", () => {
  const result = materializeAppealsReviewTransitions({
    project_id: STREET_108TH_PROJECT_ID,
    base_procedure_id: BASE_PROCEDURE_ID,
    base_stage_id: BASE_STAGE_ID,
    council_disposition: "approve_with_modifications",
    eligible_application_class_source: CLASS_SOURCE(),
    prediction_as_of: "2026-07-01",
  });
  // The Council modification is exposed via the trigger/review_available state ...
  assert.equal(result.trigger.status, "confirmed");
  assert.equal(result.review_available.available, true);
  assert.equal(result.review_available.to_stage_id, "affordable_housing_appeals_197g.board_review");
  // ... but with no claims supplied, no request/meeting/decision event exists,
  // and the absence reads as unchecked coverage, not as "no appeal occurred".
  assert.equal(result.events.length, 0);
  assert.equal(result.status, "not_observed");
});

test("A3b once coverage is explicitly checked and nothing is found, the state is eligible_but_not_invoked rather than not_observed", () => {
  const result = materializeAppealsReviewTransitions({
    project_id: STREET_108TH_PROJECT_ID,
    base_procedure_id: BASE_PROCEDURE_ID,
    base_stage_id: BASE_STAGE_ID,
    council_disposition: "approve_with_modifications",
    eligible_application_class_source: CLASS_SOURCE(),
    prediction_as_of: "2026-07-01",
    coverage: { checked: true, source_ids: ["city-record:2026-07-searched"], note: "City Record and Board docket searched; no filing found." },
  });
  assert.equal(result.status, "eligible_but_not_invoked");
  assert.equal(result.events.length, 0);
});

// ---------------------------------------------------------------------------
// A4-A5: applicant request vs. call-up, and the two-member requirement
// ---------------------------------------------------------------------------

test("A4 an exact applicant request within the statutory window creates a review-requested-by-applicant event", () => {
  const result = materializeAppealsReviewTransitions({
    project_id: STREET_108TH_PROJECT_ID,
    base_procedure_id: BASE_PROCEDURE_ID,
    base_stage_id: BASE_STAGE_ID,
    council_disposition: "approve_with_modifications",
    eligible_application_class_source: CLASS_SOURCE(),
    prediction_as_of: "2026-07-15",
    invocation_claims: [{
      kind: "review_requested_by_applicant",
      application_id: STREET_108TH_PROJECT_ID,
      actor: { kind: "applicant", entity_ref: "Federici Builders Corp." },
      observed_at: "2026-07-08T00:00:00.000Z",
      source: CONFIRMED_SOURCE({ source_id: "board-docket:2024Q0113-request" }),
      join_method: "application_id_exact_match",
      within_statutory_window: true,
    }],
  });
  assert.equal(result.status, "invoked_unresolved");
  assert.equal(result.events.length, 1);
  assert.equal(result.events[0].kind, "review_requested_by_applicant");
  assert.equal(result.events[0].application_id, STREET_108TH_PROJECT_ID);
});

test("a request not asserted within the statutory window is rejected rather than materialized", () => {
  const result = materializeAppealsReviewTransitions({
    project_id: STREET_108TH_PROJECT_ID,
    base_procedure_id: BASE_PROCEDURE_ID,
    base_stage_id: BASE_STAGE_ID,
    council_disposition: "approve_with_modifications",
    eligible_application_class_source: CLASS_SOURCE(),
    prediction_as_of: "2026-07-15",
    invocation_claims: [{
      kind: "review_requested_by_applicant",
      application_id: STREET_108TH_PROJECT_ID,
      actor: { kind: "applicant" },
      observed_at: "2026-07-08T00:00:00.000Z",
      source: CONFIRMED_SOURCE(),
      join_method: "application_id_exact_match",
      within_statutory_window: false,
    }],
  });
  assert.equal(result.events.length, 0);
  assert.equal(result.rejected_claims.length, 1);
  assert.equal(result.rejected_claims[0].reason, "not_asserted_within_statutory_window");
  assert.equal(result.status, "not_observed");
});

test("A5 a call-up requires separate source evidence from at least two board members; one statement is insufficient", () => {
  const oneMember = materializeAppealsReviewTransitions({
    project_id: STREET_108TH_PROJECT_ID,
    base_procedure_id: BASE_PROCEDURE_ID,
    base_stage_id: BASE_STAGE_ID,
    council_disposition: "approve_with_modifications",
    eligible_application_class_source: CLASS_SOURCE(),
    prediction_as_of: "2026-07-15",
    invocation_claims: [callUpClaim(STREET_108TH_PROJECT_ID, {
      members: [{ member_id: "member-1", source: CONFIRMED_SOURCE({ source_id: "member-1-statement" }) }],
    })],
  });
  assert.equal(oneMember.events.length, 0);
  assert.equal(oneMember.rejected_claims[0].reason, "insufficient_call_up_evidence");
  assert.equal(oneMember.status, "not_observed");

  // Two members named, but backed by one shared source — generic political
  // support attributed to both, not two independent pieces of evidence.
  const sharedSource = materializeAppealsReviewTransitions({
    project_id: STREET_108TH_PROJECT_ID,
    base_procedure_id: BASE_PROCEDURE_ID,
    base_stage_id: BASE_STAGE_ID,
    council_disposition: "approve_with_modifications",
    eligible_application_class_source: CLASS_SOURCE(),
    prediction_as_of: "2026-07-15",
    invocation_claims: [callUpClaim(STREET_108TH_PROJECT_ID, {
      members: [
        { member_id: "member-1", source: CONFIRMED_SOURCE({ source_id: "joint-statement" }) },
        { member_id: "member-2", source: CONFIRMED_SOURCE({ source_id: "joint-statement" }) },
      ],
    })],
  });
  assert.equal(sharedSource.events.length, 0);
  assert.equal(sharedSource.rejected_claims[0].reason, "insufficient_call_up_evidence");

  const twoMembers = materializeAppealsReviewTransitions({
    project_id: STREET_108TH_PROJECT_ID,
    base_procedure_id: BASE_PROCEDURE_ID,
    base_stage_id: BASE_STAGE_ID,
    council_disposition: "approve_with_modifications",
    eligible_application_class_source: CLASS_SOURCE(),
    prediction_as_of: "2026-07-15",
    invocation_claims: [callUpClaim(STREET_108TH_PROJECT_ID)],
  });
  assert.equal(twoMembers.events.length, 1);
  assert.equal(twoMembers.events[0].kind, "called_up_by_members");
  assert.equal(twoMembers.events[0].members.length, 2);
});

test("a public meeting is materialized once invoked, and requires the same exact-source shape as any other event", () => {
  const result = materializeAppealsReviewTransitions({
    project_id: STREET_108TH_PROJECT_ID,
    base_procedure_id: BASE_PROCEDURE_ID,
    base_stage_id: BASE_STAGE_ID,
    council_disposition: "approve_with_modifications",
    eligible_application_class_source: CLASS_SOURCE(),
    prediction_as_of: "2026-08-01",
    invocation_claims: [callUpClaim(STREET_108TH_PROJECT_ID)],
    meeting_claims: [{
      kind: "public_meeting",
      application_id: STREET_108TH_PROJECT_ID,
      actor: { kind: "board_of_standards_and_appeals" },
      observed_at: "2026-08-05T00:00:00.000Z",
      source: CONFIRMED_SOURCE({ source_id: "bsa-hearing-notice:2024Q0113" }),
      join_method: "application_id_exact_match",
    }],
  });
  assert.equal(result.events.some((e) => e.kind === "public_meeting"), true);
  assert.equal(result.status, "invoked_unresolved");
});

// ---------------------------------------------------------------------------
// A6: decisions record affirm/reverse/remove explicitly; never invent a modification
// ---------------------------------------------------------------------------

test("A6 a decision records whether it affirmed, reversed, or removed particular modifications, and requires source-named modifications", () => {
  const invocation = callUpClaim(STREET_108TH_PROJECT_ID);
  const affirmed = materializeAppealsReviewTransitions({
    project_id: STREET_108TH_PROJECT_ID,
    base_procedure_id: BASE_PROCEDURE_ID,
    base_stage_id: BASE_STAGE_ID,
    council_disposition: "approve_with_modifications",
    eligible_application_class_source: CLASS_SOURCE(),
    prediction_as_of: "2026-08-01",
    invocation_claims: [invocation],
    decision_claims: [{
      kind: "affirms_council",
      application_id: STREET_108TH_PROJECT_ID,
      actor: { kind: "board_of_standards_and_appeals" },
      observed_at: "2026-08-10T00:00:00.000Z",
      source: CONFIRMED_SOURCE({ source_id: "bsa-decision:2024Q0113" }),
      join_method: "application_id_exact_match",
    }],
  });
  assert.equal(affirmed.status, "resolved");
  assert.equal(affirmed.events.at(-1).kind, "affirms_council");

  const noModificationsNamed = materializeAppealsReviewTransitions({
    project_id: STREET_108TH_PROJECT_ID,
    base_procedure_id: BASE_PROCEDURE_ID,
    base_stage_id: BASE_STAGE_ID,
    council_disposition: "approve_with_modifications",
    eligible_application_class_source: CLASS_SOURCE(),
    prediction_as_of: "2026-08-01",
    invocation_claims: [invocation],
    decision_claims: [{
      kind: "removes_council_modification",
      application_id: STREET_108TH_PROJECT_ID,
      actor: { kind: "board_of_standards_and_appeals" },
      observed_at: "2026-08-10T00:00:00.000Z",
      source: CONFIRMED_SOURCE({ source_id: "bsa-decision:2024Q0113" }),
      join_method: "application_id_exact_match",
      // no modifications_removed supplied — must not invent one
    }],
  });
  assert.equal(noModificationsNamed.events.filter((e) => e.kind === "removes_council_modification").length, 0);
  assert.ok(noModificationsNamed.rejected_claims.some((r) => r.reason === "no_source_backed_modifications_named"));

  const named = materializeAppealsReviewTransitions({
    project_id: STREET_108TH_PROJECT_ID,
    base_procedure_id: BASE_PROCEDURE_ID,
    base_stage_id: BASE_STAGE_ID,
    council_disposition: "approve_with_modifications",
    eligible_application_class_source: CLASS_SOURCE(),
    prediction_as_of: "2026-08-01",
    invocation_claims: [invocation],
    decision_claims: [{
      kind: "removes_council_modification",
      application_id: STREET_108TH_PROJECT_ID,
      actor: { kind: "board_of_standards_and_appeals" },
      observed_at: "2026-08-10T00:00:00.000Z",
      source: CONFIRMED_SOURCE({ source_id: "bsa-decision:2024Q0113" }),
      join_method: "application_id_exact_match",
      modifications_removed: [{ modification_id: "mod-1", description: "Height limit condition removed per decision text." }],
    }],
  });
  const decision = named.events.find((e) => e.kind === "removes_council_modification");
  assert.ok(decision);
  assert.equal(decision.modifications_removed.length, 1);
  assert.equal(decision.modifications_removed[0].modification_id, "mod-1");
});

test("a decision without a preceding invocation event is rejected rather than materialized", () => {
  const result = materializeAppealsReviewTransitions({
    project_id: STREET_108TH_PROJECT_ID,
    base_procedure_id: BASE_PROCEDURE_ID,
    base_stage_id: BASE_STAGE_ID,
    council_disposition: "approve_with_modifications",
    eligible_application_class_source: CLASS_SOURCE(),
    prediction_as_of: "2026-08-01",
    decision_claims: [{
      kind: "affirms_council",
      application_id: STREET_108TH_PROJECT_ID,
      actor: { kind: "board_of_standards_and_appeals" },
      observed_at: "2026-08-10T00:00:00.000Z",
      source: CONFIRMED_SOURCE(),
      join_method: "application_id_exact_match",
    }],
  });
  assert.equal(result.events.length, 0);
  assert.equal(result.rejected_claims[0].reason, "no_invocation_precedes_this_decision");
});

// ---------------------------------------------------------------------------
// A7: absence of evidence is source coverage, never proof of non-occurrence
// ---------------------------------------------------------------------------

test("A7 failure to find an appeal record is represented as source coverage or not observed, not automatically not-appealed", () => {
  const uncheckedResult = materializeAppealsReviewTransitions({
    project_id: STREET_108TH_PROJECT_ID,
    base_procedure_id: BASE_PROCEDURE_ID,
    base_stage_id: BASE_STAGE_ID,
    council_disposition: "approve_with_modifications",
    eligible_application_class_source: CLASS_SOURCE(),
    prediction_as_of: "2026-07-01",
  });
  assert.equal(uncheckedResult.status, "not_observed");
  assert.notEqual(uncheckedResult.status, "eligible_but_not_invoked");

  const checkedResult = materializeAppealsReviewTransitions({
    project_id: STREET_108TH_PROJECT_ID,
    base_procedure_id: BASE_PROCEDURE_ID,
    base_stage_id: BASE_STAGE_ID,
    council_disposition: "approve_with_modifications",
    eligible_application_class_source: CLASS_SOURCE(),
    prediction_as_of: "2026-07-01",
    coverage: { checked: true, source_ids: ["city-record:searched"] },
  });
  assert.equal(checkedResult.status, "eligible_but_not_invoked");
});

// ---------------------------------------------------------------------------
// A8: fixtures dated before December 2, 2025 cannot emit appeals-board events
// ---------------------------------------------------------------------------

test("A8 fixtures dated before December 2, 2025 cannot emit appeals-board events", () => {
  const beforeEffective = materializeAppealsReviewTransitions({
    project_id: STREET_108TH_PROJECT_ID,
    base_procedure_id: BASE_PROCEDURE_ID,
    base_stage_id: BASE_STAGE_ID,
    council_disposition: "approve_with_modifications",
    eligible_application_class_source: CLASS_SOURCE(),
    prediction_as_of: "2025-12-01",
    invocation_claims: [callUpClaim(STREET_108TH_PROJECT_ID)],
  });
  assert.equal(beforeEffective.status, "no_trigger");
  assert.equal(beforeEffective.events.length, 0);
  assert.equal(beforeEffective.review_available.available, false);
  assert.equal(beforeEffective.review_available.reason, "not_yet_effective");

  // Even once the regime is in force, a claim dated before the effective
  // date is rejected rather than silently accepted (a backdated or
  // misdated source record must not manufacture a pre-regime event).
  const backdatedClaim = materializeAppealsReviewTransitions({
    project_id: STREET_108TH_PROJECT_ID,
    base_procedure_id: BASE_PROCEDURE_ID,
    base_stage_id: BASE_STAGE_ID,
    council_disposition: "approve_with_modifications",
    eligible_application_class_source: CLASS_SOURCE(),
    prediction_as_of: "2026-07-01",
    invocation_claims: [callUpClaim(STREET_108TH_PROJECT_ID, { observed_at: "2025-11-15T00:00:00.000Z" })],
  });
  assert.equal(backdatedClaim.events.length, 0);
  assert.ok(backdatedClaim.rejected_claims.some((r) => r.reason === "observed_before_regime_effective_date"));
});

// ---------------------------------------------------------------------------
// A9: exact board application identity for the targeted-project (§666-a) path
// ---------------------------------------------------------------------------

test("A9 materializeTargetedProjectTransitions requires an exact board_application_id and never inherits a project identity", () => {
  assert.throws(() => materializeTargetedProjectTransitions({ prediction_as_of: "2026-07-01" }));
  assert.throws(() => materializeTargetedProjectTransitions({ board_application_id: "", prediction_as_of: "2026-07-01" }));

  const result = materializeTargetedProjectTransitions({
    board_application_id: "bsa-cal:2026-0042",
    prediction_as_of: "2026-07-01",
    filing_claim: {
      kind: "filed",
      application_id: "bsa-cal:2026-0042",
      actor: { kind: "applicant" },
      observed_at: "2026-06-01T00:00:00.000Z",
      source: CONFIRMED_SOURCE({ source_id: "bsa-cal:2026-0042-filing" }),
      join_method: "board_application_id_exact_match",
    },
  });
  assert.equal(result.status, "invoked_unresolved");
  assert.equal(result.events[0].application_id, "bsa-cal:2026-0042");

  // A filing claim joined on a project_id-shaped or address-shaped value
  // never satisfies the exact join, even if it happens to be supplied.
  const mismatched = materializeTargetedProjectTransitions({
    board_application_id: "bsa-cal:2026-0042",
    prediction_as_of: "2026-07-01",
    filing_claim: {
      kind: "filed",
      application_id: "2024Q0113",
      actor: { kind: "applicant" },
      observed_at: "2026-06-01T00:00:00.000Z",
      source: CONFIRMED_SOURCE(),
      join_method: "board_application_id_exact_match",
    },
  });
  assert.equal(mismatched.events.length, 0);
  assert.equal(mismatched.rejected_claims[0].reason, "application_id_not_exact_match");
});

test("targeted-project transitions progress from filed through a hearing to a decision, each exactly joined", () => {
  const boardApplicationId = "bsa-cal:2026-0099";
  const result = materializeTargetedProjectTransitions({
    board_application_id: boardApplicationId,
    prediction_as_of: "2026-08-01",
    filing_claim: {
      kind: "filed",
      application_id: boardApplicationId,
      actor: { kind: "applicant" },
      observed_at: "2026-06-01T00:00:00.000Z",
      source: CONFIRMED_SOURCE({ source_id: "filing" }),
      join_method: "board_application_id_exact_match",
    },
    process_claims: [{
      kind: "board_hearing",
      application_id: boardApplicationId,
      actor: { kind: "board_of_standards_and_appeals" },
      observed_at: "2026-07-01T00:00:00.000Z",
      source: CONFIRMED_SOURCE({ source_id: "hearing-notice" }),
      join_method: "board_application_id_exact_match",
    }],
    decision_claim: {
      kind: "approved",
      application_id: boardApplicationId,
      actor: { kind: "board_of_standards_and_appeals" },
      observed_at: "2026-07-20T00:00:00.000Z",
      source: CONFIRMED_SOURCE({ source_id: "decision" }),
      join_method: "board_application_id_exact_match",
    },
  });
  assert.equal(result.status, "resolved");
  assert.deepEqual(result.events.map((e) => e.kind), ["filed", "board_hearing", "approved"]);
});

test("a targeted-project decision without a preceding filing is rejected", () => {
  const result = materializeTargetedProjectTransitions({
    board_application_id: "bsa-cal:2026-0100",
    prediction_as_of: "2026-08-01",
    decision_claim: {
      kind: "approved",
      application_id: "bsa-cal:2026-0100",
      actor: { kind: "board_of_standards_and_appeals" },
      observed_at: "2026-07-20T00:00:00.000Z",
      source: CONFIRMED_SOURCE(),
      join_method: "board_application_id_exact_match",
    },
  });
  assert.equal(result.events.length, 0);
  assert.equal(result.rejected_claims[0].reason, "no_filing_precedes_this_decision");
});

// ---------------------------------------------------------------------------
// A10: proposed implementing rules stay separate from adopted ones
// ---------------------------------------------------------------------------

test("A10 a proposed implementing-rule version never governs a materialized event, even appended with an earlier date", () => {
  assert.ok(APPEALS_IMPLEMENTING_RULE_VERSIONS.every((rule) => rule.source_status !== "proposed-rule"));
  const invocation = callUpClaim(STREET_108TH_PROJECT_ID);
  const result = materializeAppealsReviewTransitions({
    project_id: STREET_108TH_PROJECT_ID,
    base_procedure_id: BASE_PROCEDURE_ID,
    base_stage_id: BASE_STAGE_ID,
    council_disposition: "approve_with_modifications",
    eligible_application_class_source: CLASS_SOURCE(),
    prediction_as_of: "2026-07-15",
    invocation_claims: [invocation],
  });
  assert.equal(result.events[0].rule_version.source_status, "adopted-rule");
  assert.equal(result.events[0].rule_version.rule_version_id, "bsa_197g_procedures_v1");
});

// ---------------------------------------------------------------------------
// A11: no request-time dependency anywhere in this module
// ---------------------------------------------------------------------------

test("A11 no new resident request-time dependency: identical inputs always produce identical output", () => {
  const input = {
    project_id: STREET_108TH_PROJECT_ID,
    base_procedure_id: BASE_PROCEDURE_ID,
    base_stage_id: BASE_STAGE_ID,
    council_disposition: "approve_with_modifications",
    eligible_application_class_source: CLASS_SOURCE(),
    prediction_as_of: "2026-07-15",
    invocation_claims: [callUpClaim(STREET_108TH_PROJECT_ID)],
  };
  const first = materializeAppealsReviewTransitions(input);
  const second = materializeAppealsReviewTransitions(input);
  assert.deepEqual(first, second);
});

// ---------------------------------------------------------------------------
// Negative rule + schema shape
// ---------------------------------------------------------------------------

test("negative rule: no procedure or eligibility shortcuts leak into this module", () => {
  const dump = JSON.stringify({
    appeals: APPEALS_TRANSITION_KINDS,
    targeted: TARGETED_PROJECT_TRANSITION_KINDS,
    example: materializeAppealsReviewTransitions({
      project_id: STREET_108TH_PROJECT_ID,
      base_procedure_id: BASE_PROCEDURE_ID,
      base_stage_id: BASE_STAGE_ID,
      council_disposition: "approve_with_modifications",
      eligible_application_class_source: CLASS_SOURCE(),
      prediction_as_of: "2026-07-15",
      invocation_claims: [callUpClaim(STREET_108TH_PROJECT_ID)],
    }),
  });
  assert.equal(/"procedure(_id)?"\s*:\s*"(ahab|affordable|fast_track)"/.test(dump), false);
  assert.equal(dump.includes("qualifying_affordable"), false);
});

test("schema is versioned and stable", () => {
  assert.equal(AFFORDABLE_REVIEW_TRANSITIONS_SCHEMA, "cityscroll.affordable_review_transitions.v1");
  assert.equal(APPEALS_TRANSITION_KINDS.includes("review_available"), false);
  assert.equal(TARGETED_PROJECT_TRANSITION_KINDS.length, 6);
});
