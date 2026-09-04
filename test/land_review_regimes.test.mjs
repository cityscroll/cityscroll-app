/**
 * Affordable-housing review-regime registry (LDP-18).
 *
 *   node --test test/land_review_regimes.test.mjs
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  LAND_REVIEW_REGIME_KINDS,
  LAND_REVIEW_REGIME_REGISTRY,
  LAND_REVIEW_REGIME_REGISTRY_VERSION,
  LAND_REVIEW_REGIME_SCHEMA,
  LAND_REVIEW_REGIME_SOURCE_STATUSES,
  landReviewRegimeById,
  resolveAppealsRegimeSuccessor,
  resolveLandAuthorityRegime,
  resolveLandFastTrackDecoration,
  resolveLandReviewRegimeEligibility,
  validateLandReviewRegimeRegistry,
} from "../site/land_review_regimes.mjs";
import {
  LAND_PROCEDURE_PROFILE_REGISTRY,
  buildLandProcedureProfileView,
  resolveLandProcedureProfile,
} from "../site/land_procedure_profiles.mjs";
import { resolveLandProcedure } from "../site/land_procedure_facet.mjs";
import { resolveLandActionProcedures } from "../site/land_action_procedure_resolution.mjs";
import { LAND_USE_PROCEDURE_KINDS } from "../worker/src/lib/subject_registry.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const warehouse = JSON.parse(
  readFileSync(join(ROOT, "site/data/zap_projects_warehouse_lookup.json"), "utf8"),
);

const POWERS_AVE_PROJECT_ID = "2026X0362"; // 351 Powers Avenue, HPD, actions=PP, ulurp_non=ELURP

function warehouseRow(projectId) {
  return (warehouse.projects || warehouse.rows || []).find((row) => row.project_id === projectId);
}

// ---------------------------------------------------------------------------
// Registry shape
// ---------------------------------------------------------------------------

test("registry is structurally valid and versioned", () => {
  const validation = validateLandReviewRegimeRegistry();
  assert.deepEqual(validation.errors, []);
  assert.equal(validation.ok, true);
  assert.equal(LAND_REVIEW_REGIME_REGISTRY.schema, LAND_REVIEW_REGIME_SCHEMA);
  assert.equal(LAND_REVIEW_REGIME_REGISTRY.registry_status, "reviewed_static");
  assert.ok(LAND_REVIEW_REGIME_REGISTRY_VERSION);
  assert.deepEqual(
    LAND_REVIEW_REGIME_REGISTRY.regimes.map((regime) => regime.regime_id).sort(),
    [
      "affordable_housing_appeals_197g",
      "affordable_housing_fast_track_197f",
      "targeted_affordable_housing_project_666a",
    ],
  );
});

test("A8 every regime carries source status, effective dates, and legal basis", () => {
  for (const regime of LAND_REVIEW_REGIME_REGISTRY.regimes) {
    assert.ok(LAND_REVIEW_REGIME_SOURCE_STATUSES.includes(regime.source_status), regime.regime_id);
    assert.ok(regime.effective_from, regime.regime_id);
    assert.ok(Array.isArray(regime.legal_basis) && regime.legal_basis.length, regime.regime_id);
    assert.ok(LAND_REVIEW_REGIME_KINDS.includes(regime.kind), regime.regime_id);
    assert.ok(Array.isArray(regime.eligibility_fact_keys) && regime.eligibility_fact_keys.length, regime.regime_id);
    assert.ok(regime.entry_stage && typeof regime.entry_stage === "object", regime.regime_id);
    assert.ok(regime.terminal_actor?.entity_ref, regime.regime_id);
    assert.ok(Array.isArray(regime.conditional_successors), regime.regime_id);
  }
});

test("negative rule: no procedure or eligibility shortcuts leak into the registry", () => {
  const serialized = JSON.stringify(LAND_REVIEW_REGIME_REGISTRY);
  assert.equal(/"procedure(_id)?"\s*:\s*"(ahab|affordable|fast_track)"/.test(serialized), false);
  assert.equal(serialized.includes("qualifying_affordable"), false);
  // The shared procedure vocabulary is untouched by this card.
  assert.deepEqual(LAND_USE_PROCEDURE_KINDS, ["ulurp", "elurp", "non_ulurp"]);
});

// ---------------------------------------------------------------------------
// A1: the real 351 Powers Avenue canary
// ---------------------------------------------------------------------------

test("A1 351 Powers Avenue (real ELURP canary) stays ELURP and gains no regime label", () => {
  const row = warehouseRow(POWERS_AVE_PROJECT_ID);
  assert.ok(row, "warehouse must retain HPD 351 Powers Avenue");
  assert.equal(row.primary_applicant, "HPD - NYC Dept of Housing Preservation & Development");
  assert.equal(row.ulurp_non, "ELURP");
  assert.equal(resolveLandProcedure(row), "ELURP");

  const profileResolution = resolveLandProcedureProfile({ source: row });
  assert.equal(profileResolution.status, "resolved");
  assert.equal(profileResolution.profile_id, "elurp_197e");

  // No section 197-f, 666-a, or 197-g eligibility facts exist for this real
  // project: it must not resolve as fast-tracked, targeted, or appealable
  // merely because it is affordable housing.
  const fastTrack = resolveLandFastTrackDecoration({ procedure_id: profileResolution.profile_id, facts: {} });
  assert.equal(fastTrack.applicable, false);
  assert.equal(fastTrack.eligibility.status, "unknown");

  const targeted = resolveLandAuthorityRegime({
    regime_id: "targeted_affordable_housing_project_666a",
    facts: {},
  });
  assert.equal(targeted.eligibility.status, "unknown");
  assert.notEqual(targeted.eligibility.status, "eligible");

  const appeals = resolveAppealsRegimeSuccessor({
    procedure_id: profileResolution.profile_id,
    stage_id: "elurp_197e.city_planning_commission_review",
    facts: {},
  });
  assert.equal(appeals.status, "none");
  assert.equal(appeals.reason, "not_a_qualifying_stage");

  const actionResolution = resolveLandActionProcedures(row);
  assert.ok(["uniform", "unknown"].includes(actionResolution.procedure_resolution));
  assert.ok(actionResolution.land_actions.every((action) => action.procedure_id !== "ahab"));
  assert.ok(actionResolution.land_actions.every((action) => action.procedure_id !== "affordable_housing_fast_track_197f"));
});

// ---------------------------------------------------------------------------
// A2: section 197-f fast track
// ---------------------------------------------------------------------------

test("A2 an eligible section 197-f fixture resolves to procedure elurp plus the fast-track regime", () => {
  const fixture = {
    project_id: "2026X9001",
    ulurp_non: "ELURP",
    actions: "PP",
  };
  const profileResolution = resolveLandProcedureProfile({ source: fixture });
  assert.equal(profileResolution.status, "resolved");
  assert.equal(profileResolution.profile_id, "elurp_197e");

  const decoration = resolveLandFastTrackDecoration({
    procedure_id: profileResolution.profile_id,
    facts: {
      "affordable_housing.section_197f.commission_cycle_listed": true,
      "affordable_housing.section_197f.qualifying_action_code": true,
    },
  });
  assert.equal(decoration.applicable, true);
  assert.equal(decoration.regime_id, "affordable_housing_fast_track_197f");
  assert.equal(decoration.procedure_id, "elurp_197e");

  // No second, pseudo-ELURP procedure exists anywhere in the base registry.
  assert.equal(LAND_PROCEDURE_PROFILE_REGISTRY.profiles.filter((p) => /elurp/i.test(p.procedure_id)).length, 1);
  assert.equal(landReviewRegimeById("affordable_housing_fast_track_197f").selects_procedure_id, "elurp_197e");
});

test("197-f is inapplicable to a procedure it does not select", () => {
  const decoration = resolveLandFastTrackDecoration({
    procedure_id: "ulurp_197c",
    facts: {
      "affordable_housing.section_197f.commission_cycle_listed": true,
      "affordable_housing.section_197f.qualifying_action_code": true,
    },
  });
  assert.equal(decoration.applicable, false);
  assert.equal(decoration.reason, "procedure_not_selected_by_regime");
});

// ---------------------------------------------------------------------------
// A3: section 666-a targeted affordable housing project (BSA authority path)
// ---------------------------------------------------------------------------

test("A3 an eligible section 666-a fixture terminates at BSA with no Commission or Council stage", () => {
  const resolved = resolveLandAuthorityRegime({
    regime_id: "targeted_affordable_housing_project_666a",
    facts: {
      "affordable_housing.section_666a.hpd_sponsorship_certified": true,
      "affordable_housing.section_666a.affordability_covenant_recorded": true,
    },
  });
  assert.equal(resolved.eligibility.status, "eligible");
  assert.equal(resolved.terminal_actor.entity_ref, "agency:id:board-of-standards-and-appeals");
  assert.ok(resolved.stages.length >= 1);
  for (const stage of resolved.stages) {
    assert.equal(stage.actor_selector.kind, "board_of_standards_and_appeals");
    assert.notEqual(stage.actor_selector.kind, "city_planning_commission");
    assert.notEqual(stage.actor_selector.kind, "city_council");
  }
  const serializedStages = JSON.stringify(resolved.stages);
  assert.equal(/city_planning_commission|city_council/.test(serializedStages), false);
});

// ---------------------------------------------------------------------------
// A4-A6: section 197-g appeals as a conditional successor of Council review
// ---------------------------------------------------------------------------

test("A4 an ordinary appeals-capable ULURP stays procedure ulurp; the appeals board is only a conditional successor", () => {
  const row = { ulurp_non: "ULURP", actions: "ZM" };
  const profileResolution = resolveLandProcedureProfile({ source: row });
  assert.equal(profileResolution.status, "resolved");
  assert.equal(profileResolution.profile_id, "ulurp_197c");
  assert.equal(resolveLandProcedure({ ulurp_non: "ULURP" }), "ULURP");

  const view = buildLandProcedureProfileView({
    source: row,
    facts: { council_review: "automatic" },
    profile: { procedure_id: "ulurp_197c" },
    current_stage_id: "ulurp_197c.city_council_review",
  });
  assert.equal(view.profile_id, "ulurp_197c");
  assert.equal(view.current_stage.stage_id, "ulurp_197c.city_council_review");
  // The base profile view carries no §197-g stage of its own.
  assert.ok(!JSON.stringify(view).includes("affordable_housing_appeals_197g"));

  const successor = resolveAppealsRegimeSuccessor({
    procedure_id: "ulurp_197c",
    stage_id: "ulurp_197c.city_council_review",
    facts: {
      council_disposition: "disapprove",
      "affordable_housing.section_197g.eligible_application_class": true,
    },
  });
  assert.equal(successor.status, "confirmed");
  assert.equal(successor.regime_id, "affordable_housing_appeals_197g");
  // Still procedure ulurp_197c: the successor is additive, not a substitution.
  assert.equal(profileResolution.profile_id, "ulurp_197c");
});

test("A5 an unchanged Council approval has no appeals-board successor", () => {
  for (const procedureId of ["ulurp_197c", "ulurp_197d_conditional_council", "plan_197a"]) {
    const stageId = procedureId === "plan_197a" ? "plan_197a.city_council_review"
      : procedureId === "ulurp_197d_conditional_council" ? "ulurp_197d.city_council_review"
      : "ulurp_197c.city_council_review";
    const successor = resolveAppealsRegimeSuccessor({
      procedure_id: procedureId,
      stage_id: stageId,
      facts: {
        council_disposition: "approve",
        "affordable_housing.section_197g.eligible_application_class": true,
      },
    });
    assert.equal(successor.status, "none");
    assert.equal(successor.reason, "no_qualifying_council_disposition");
  }
});

test("A6 a Council disapproval or modification has only a potential successor until eligibility is established", () => {
  for (const disposition of ["disapprove", "approve_with_modifications"]) {
    const unknownEligibility = resolveAppealsRegimeSuccessor({
      procedure_id: "ulurp_197c",
      stage_id: "ulurp_197c.city_council_review",
      facts: { council_disposition: disposition },
    });
    assert.equal(unknownEligibility.status, "potential");
    assert.equal(unknownEligibility.reason, "eligibility_not_yet_established");
    assert.equal(unknownEligibility.to_stage_id, "affordable_housing_appeals_197g.board_review");

    const ineligible = resolveAppealsRegimeSuccessor({
      procedure_id: "ulurp_197c",
      stage_id: "ulurp_197c.city_council_review",
      facts: {
        council_disposition: disposition,
        "affordable_housing.section_197g.eligible_application_class": false,
      },
    });
    assert.equal(ineligible.status, "none");
    assert.equal(ineligible.reason, "ineligible");
  }
});

test("197-g attaches to the conditional §197-d and plan §197-a Council stages too", () => {
  const conditionalCouncil = resolveAppealsRegimeSuccessor({
    procedure_id: "ulurp_197d_conditional_council",
    stage_id: "ulurp_197d.city_council_review",
    facts: {
      council_disposition: "disapprove",
      "affordable_housing.section_197g.eligible_application_class": true,
    },
  });
  assert.equal(conditionalCouncil.status, "confirmed");

  const planPath = resolveAppealsRegimeSuccessor({
    procedure_id: "plan_197a",
    stage_id: "plan_197a.city_council_review",
    facts: {
      council_disposition: "approve_with_modifications",
      "affordable_housing.section_197g.eligible_application_class": true,
    },
  });
  assert.equal(planPath.status, "confirmed");

  // A stage from an unrelated procedure is never a qualifying attachment point.
  const wrongStage = resolveAppealsRegimeSuccessor({
    procedure_id: "ulurp_197c",
    stage_id: "ulurp_197c.city_planning_commission_review",
    facts: { council_disposition: "disapprove" },
  });
  assert.equal(wrongStage.status, "none");
  assert.equal(wrongStage.reason, "not_a_qualifying_stage");
});

// ---------------------------------------------------------------------------
// A7: non-regression of ULURP, ELURP, §197-a, mixed-procedure, and
// authority-summary/phase-spine behavior (nothing in this card touches them)
// ---------------------------------------------------------------------------

test("A7 base procedure profiles and vocabulary are unchanged by this card", () => {
  assert.deepEqual(
    LAND_PROCEDURE_PROFILE_REGISTRY.profiles.map((profile) => profile.procedure_id).sort(),
    ["elurp_197e", "plan_197a", "ulurp_197c", "ulurp_197d_conditional_council"],
  );
  const mixedRow = { ulurp_non: "ULURP", actions: "ZS;ZM" };
  assert.equal(resolveLandProcedureProfile({ source: mixedRow }).status, "unresolved");
  assert.equal(resolveLandProcedureProfile({ source: mixedRow }).reason, "mixed_action_set");
});

// ---------------------------------------------------------------------------
// Additional coverage: source-status boundaries, temporal cutoffs, unknown
// eligibility, and the colloquial "fast track" collision.
// ---------------------------------------------------------------------------

test("do not collapse §197-f AHFT and §666-a TAHP despite the shared 'fast track' nickname", () => {
  const ahft = landReviewRegimeById("affordable_housing_fast_track_197f");
  const tahp = landReviewRegimeById("targeted_affordable_housing_project_666a");
  assert.notEqual(ahft.regime_id, tahp.regime_id);
  assert.notEqual(ahft.kind, tahp.kind);
  assert.equal(ahft.selects_procedure_id, "elurp_197e");
  assert.equal(tahp.selects_procedure_id, null);
  assert.notEqual(ahft.terminal_actor.entity_ref, undefined);
  assert.equal(ahft.terminal_actor.entity_ref, "agency:id:city-planning-commission");
  assert.equal(tahp.terminal_actor.entity_ref, "agency:id:board-of-standards-and-appeals");
  assert.notDeepEqual(ahft.eligibility_fact_keys, tahp.eligibility_fact_keys);
});

test("unknown eligibility never silently reads as eligible or ineligible", () => {
  const result = resolveLandReviewRegimeEligibility({
    regime_id: "targeted_affordable_housing_project_666a",
    facts: { "affordable_housing.section_666a.hpd_sponsorship_certified": true },
  });
  assert.equal(result.status, "unknown");
  assert.deepEqual(result.missing_facts, ["affordable_housing.section_666a.affordability_covenant_recorded"]);
});

test("temporal rule: a prediction_as_of before the effective date is not_yet_effective, never eligible or ineligible", () => {
  for (const historicalDate of ["2016-01-01", "2018-06-15", "2022-03-01", "2023-11-30", "2024-12-31"]) {
    const eligibility = resolveLandReviewRegimeEligibility({
      regime_id: "affordable_housing_fast_track_197f",
      facts: {
        "affordable_housing.section_197f.commission_cycle_listed": true,
        "affordable_housing.section_197f.qualifying_action_code": true,
      },
      prediction_as_of: historicalDate,
    });
    assert.equal(eligibility.status, "not_yet_effective");

    const successor = resolveAppealsRegimeSuccessor({
      procedure_id: "ulurp_197c",
      stage_id: "ulurp_197c.city_council_review",
      facts: {
        council_disposition: "disapprove",
        "affordable_housing.section_197g.eligible_application_class": true,
      },
      prediction_as_of: historicalDate,
    });
    assert.equal(successor.status, "none");
    assert.equal(successor.reason, "not_yet_effective");
  }

  const current = resolveLandReviewRegimeEligibility({
    regime_id: "affordable_housing_fast_track_197f",
    facts: {
      "affordable_housing.section_197f.commission_cycle_listed": true,
      "affordable_housing.section_197f.qualifying_action_code": true,
    },
    prediction_as_of: "2026-08-30",
  });
  assert.equal(current.status, "eligible");
});

test("proposed-rule and adopted-rule source statuses are representable and never silently promoted to enacted", () => {
  const fixtureRegistry = {
    ...LAND_REVIEW_REGIME_REGISTRY,
    regimes: [
      {
        ...LAND_REVIEW_REGIME_REGISTRY.regimes[0],
        regime_id: "affordable_housing_fast_track_197f_proposed_fixture",
        source_status: "proposed-rule",
      },
      {
        ...LAND_REVIEW_REGIME_REGISTRY.regimes[1],
        regime_id: "targeted_affordable_housing_project_666a_adopted_fixture",
        source_status: "adopted-rule",
      },
    ],
  };
  const validation = validateLandReviewRegimeRegistry(fixtureRegistry);
  assert.equal(validation.ok, true);
  const proposed = fixtureRegistry.regimes.find((r) => r.source_status === "proposed-rule");
  const adopted = fixtureRegistry.regimes.find((r) => r.source_status === "adopted-rule");
  assert.notEqual(proposed.source_status, "enacted");
  assert.notEqual(adopted.source_status, "enacted");
});

test("an unsupported source status fails registry validation", () => {
  const badRegistry = {
    ...LAND_REVIEW_REGIME_REGISTRY,
    regimes: [{ ...LAND_REVIEW_REGIME_REGISTRY.regimes[0], source_status: "enacted-by-vibes" }],
  };
  const validation = validateLandReviewRegimeRegistry(badRegistry);
  assert.equal(validation.ok, false);
  assert.ok(validation.errors.some((e) => e.includes("source_status")));
});

test("unresolved base procedure blocks the fast-track decoration rather than guessing", () => {
  const decoration = resolveLandFastTrackDecoration({ procedure_id: null, facts: {} });
  assert.equal(decoration.applicable, false);
  assert.equal(decoration.reason, "procedure_not_selected_by_regime");
});
