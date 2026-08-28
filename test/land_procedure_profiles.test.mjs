import assert from "node:assert/strict";
import { test } from "node:test";

import landDefault from "../site/data/land_default_ulurp.json" with { type: "json" };
import {
  LAND_PROCEDURE_PROFILE_REGISTRY,
  LAND_PROCEDURE_PROFILE_REGISTRY_VERSION,
  buildLandProcedureProfileView,
  matchesLandProcedureCondition,
  resolveLandProcedureProfile,
  validateLandProcedureProfileRegistry,
} from "../site/land_procedure_profiles.mjs";
import { buildLandPhaseView } from "../site/land_phase_spine.mjs";

function spine(events = []) {
  return { schema_version: 1, project_id: "profile-test", events };
}

test("reviewed registry is versioned and every stage has role, effect, window, and citation", () => {
  assert.deepEqual(validateLandProcedureProfileRegistry(LAND_PROCEDURE_PROFILE_REGISTRY), { ok: true, errors: [] });
  assert.equal(LAND_PROCEDURE_PROFILE_REGISTRY.schema, "cityscroll.land_procedure_profiles.v1");
  assert.equal(LAND_PROCEDURE_PROFILE_REGISTRY.profiles.length, 4);
  for (const profile of LAND_PROCEDURE_PROFILE_REGISTRY.profiles) {
    assert.ok(profile.effective_from);
    assert.ok(profile.legal_basis.every((basis) => /^https:\/\//.test(basis.source_url)));
    for (const stage of profile.stages) {
      assert.ok(stage.stage_id);
      assert.ok(stage.actor_selector.kind);
      assert.ok(stage.actor_selector.source_field);
      assert.ok(stage.role);
      assert.ok(stage.effect);
      assert.ok(stage.permitted_actions.length);
      assert.ok(stage.time_window);
      assert.ok(stage.legal_basis.length);
      assert.ok(stage.legal_basis.every((basis) => /^https:\/\//.test(basis.source_url)));
      const view = buildLandProcedureProfileView({
        source: { procedure_profile_id: profile.procedure_id },
        current_stage_id: stage.stage_id,
      });
      assert.equal(view.stages.find((candidate) => candidate.stage_id === stage.stage_id).effective_from, profile.effective_from);
      assert.equal(view.stages.find((candidate) => candidate.stage_id === stage.stage_id).registry_version, LAND_PROCEDURE_PROFILE_REGISTRY_VERSION);
    }
  }
});

test("real 2025K0305 specimen consumes ordinary profile and conditional Borough Board stage", () => {
  const project = landDefault.projects.find((row) => row.project_id === "2025K0305");
  assert.ok(project, "the census specimen must remain in the default Land artifact");
  const resolved = resolveLandProcedureProfile(project);
  assert.equal(resolved.status, "resolved");
  assert.equal(resolved.profile_id, "ulurp_197c");

  const view = buildLandPhaseView(spine([
    {
      id: "obs-cb-1",
      kind: "zap_milestone",
      title: "Community Board Review",
      detail: "Community Board 11",
      time: { value: "2026-07-02", certainty: "actual" },
      source: { id: "zap", url: "https://zap.planning.nyc.gov/projects/2025K0305" },
    },
  ]), {
    open_data: project,
    procedure_facts: {
      affected_review_bodies: { borough_board: true },
    },
  });

  assert.equal(view.event_count, 1);
  assert.equal(view.procedure_profile.status, "resolved");
  assert.equal(view.procedure_profile.profile_id, "ulurp_197c");
  assert.equal(view.procedure_profile.current_stage.stage_id, "ulurp_197c.community_board_review");
  assert.equal(view.procedure_profile.expected_next_stage.stage_id, "ulurp_197c.borough_board_review");
  assert.equal(view.procedure_profile.current_stage.role, "advisory_reviewer");
  assert.match(view.procedure_profile.current_stage.effect, /advisory/i);
  assert.equal(view.procedure_profile.current_stage.registry_version, LAND_PROCEDURE_PROFILE_REGISTRY_VERSION);
  assert.equal(view.procedure_profile.current_stage.effective_from, "2025-12-02");
  assert.equal(view.procedure_profile.current_stage.legal_basis[0].citation, "NYC Charter § 197-c(c)");
  assert.equal(Object.hasOwn(view.procedure_profile, "observed_event_id"), false);

  const withoutBoroughBoard = buildLandProcedureProfileView({
    source: { procedure_profile_id: "ulurp_197c", affected_review_bodies: { borough_board: false } },
    current_phase_id: "borough_president",
  });
  assert.equal(withoutBoroughBoard.current_stage.stage_id, "ulurp_197c.borough_president_review");
});

test("conditional Council, expedited, and 197-a profiles expose distinct roles and successors", () => {
  const conditional = buildLandProcedureProfileView({
    source: { procedure_profile_id: "ulurp_197d_conditional_council", council_review: "called_up" },
    current_phase_id: "cpc",
  });
  assert.equal(conditional.current_stage.role, "decision_maker");
  assert.equal(conditional.expected_next_stage.stage_id, "ulurp_197d.city_council_review");
  assert.equal(conditional.expected_next_stage.role, "conditional_decision_maker");
  assert.equal(conditional.expected_next_stage.time_window.days, 50);

  const noCouncil = buildLandProcedureProfileView({
    source: { procedure_profile_id: "ulurp_197d_conditional_council" },
    current_phase_id: "cpc",
  });
  assert.equal(noCouncil.expected_next_stage, null, "unknown Council applicability stays unknown");

  const unsupportedCouncilStage = buildLandProcedureProfileView({
    source: { procedure_profile_id: "ulurp_197d_conditional_council" },
    current_phase_id: "city_council",
  });
  assert.equal(unsupportedCouncilStage.current_stage, null, "a Council milestone cannot establish conditional applicability");

  const supportedCouncilStage = buildLandProcedureProfileView({
    source: { procedure_profile_id: "ulurp_197d_conditional_council", council_review: "called_up" },
    current_phase_id: "city_council",
  });
  assert.equal(supportedCouncilStage.current_stage.stage_id, "ulurp_197d.city_council_review");

  const expedited = buildLandProcedureProfileView({
    source: { procedure_profile_id: "elurp_197e" },
    current_phase_id: "borough_president",
  });
  assert.equal(expedited.current_stage.role, "advisory_reviewer");
  assert.equal(expedited.expected_next_stage.stage_id, "elurp_197e.city_planning_commission_review");
  assert.equal(expedited.stages.some((stage) => stage.spine_phase_id === "city_council"), false);

  const plan = buildLandProcedureProfileView({
    source: { procedure_profile_id: "plan_197a", cpc_disposition: "approve_with_modifications" },
    current_phase_id: "cpc",
  });
  assert.equal(plan.current_stage.stage_id, "plan_197a.city_planning_commission_review");
  assert.equal(plan.expected_next_stage.stage_id, "plan_197a.city_council_review");
  assert.equal(plan.current_stage.role, "decision_maker");
});

test("profile evaluation is normative only and never creates an observed event", () => {
  const events = [{
    id: "observed-1",
    kind: "city_record_hearing",
    title: "Community Board hearing",
    time: { value: "2026-08-01", certainty: "actual" },
    source: { id: "city-record", url: "https://a856-cityrecord.nyc.gov/RequestDetail/1" },
  }];
  const before = JSON.stringify(events);
  const view = buildLandPhaseView(spine(events), {
    procedure_facts: { procedure_profile_id: "ulurp_197c", council_review: "automatic" },
  });

  assert.equal(JSON.stringify(events), before);
  assert.equal(view.event_count, 1);
  assert.equal(view.chronological.length, 1);
  assert.equal(view.procedure_profile.layer, "normative");
  assert.equal(view.procedure_profile.expected_next_stage.stage_id, "ulurp_197c.borough_president_review");
  assert.equal(Object.hasOwn(view.procedure_profile, "events"), false);
  assert.equal(Object.hasOwn(view.procedure_profile, "observed_event_id"), false);
  assert.equal(Object.hasOwn(view.procedure_profile.current_stage || {}, "observed_event_id"), false);
});

test("milestone-only, mixed-action, and absent-procedure inputs fail closed", () => {
  const milestoneOnly = buildLandProcedureProfileView({
    source: { current_milestone: "City Council Review" },
    current_phase_id: "city_council",
  });
  assert.equal(milestoneOnly.status, "unresolved");
  assert.equal(milestoneOnly.reason, "unsupported_or_missing_procedure");
  assert.equal(milestoneOnly.profile_id, null);
  assert.equal(Object.hasOwn(milestoneOnly, "observed_event_id"), false);

  const mixedProject = landDefault.projects.find((row) => row.project_id === "2026K0123");
  assert.ok(mixedProject);
  const mixed = resolveLandProcedureProfile(mixedProject);
  assert.equal(mixed.status, "unresolved");
  assert.equal(mixed.reason, "mixed_action_set");

  const absent = buildLandProcedureProfileView({ source: {} });
  assert.equal(absent, null);
});

test("successor conditions are closed and source-fact-only", () => {
  assert.equal(matchesLandProcedureCondition({ fact: "council_review", in: ["called_up"] }, { council_review: "called_up" }), true);
  assert.equal(matchesLandProcedureCondition({ fact: "council_review", in: ["called_up"] }, { current_milestone: "City Council Review" }), false);
  assert.equal(matchesLandProcedureCondition({ fact: "affected.borough_board", equals: true }, { affected: { borough_board: true } }), true);
  assert.equal(matchesLandProcedureCondition({ fact: "missing", exists: false }, {}), true);
});
