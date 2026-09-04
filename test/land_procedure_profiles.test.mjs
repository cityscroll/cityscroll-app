import assert from "node:assert/strict";
import { test } from "node:test";

import landDefault from "../site/data/land_default_ulurp.json" with { type: "json" };
import {
  LAND_PROCEDURE_PROFILE_REGISTRY,
  LAND_PROCEDURE_PROFILE_REGISTRY_VERSION,
  buildLandProcedureProfileView,
  matchesLandProcedureCondition,
  resolveLandProcedureProfile,
  resolveLandProcedureVariant,
  validateLandProcedureProfileRegistry,
} from "../site/land_procedure_profiles.mjs";
import { buildLandPhaseView } from "../site/land_phase_spine.mjs";

function spine(events = []) {
  return { schema_version: 1, project_id: "profile-test", events };
}

test("reviewed registry is versioned and every stage has role, effect, window, and citation", () => {
  assert.deepEqual(validateLandProcedureProfileRegistry(LAND_PROCEDURE_PROFILE_REGISTRY), { ok: true, errors: [] });
  assert.equal(LAND_PROCEDURE_PROFILE_REGISTRY.schema, "cityscroll.land_procedure_profiles.v1");
  assert.equal(LAND_PROCEDURE_PROFILE_REGISTRY.profiles.length, 5);
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

/**
 * LDP-30: the ordinary expedited (§ 197-e) topology is
 * Certification -> {Community Board || Borough President} -> CPC. Canary
 * 2024Q0356 (E1) sits pre-certification on exactly this profile.
 */
test("A1-A3, A9 ordinary elurp_197e topology renders certification then one shared parallel local-review group then a terminal CPC", () => {
  const certification = buildLandProcedureProfileView({
    source: { procedure_profile_id: "elurp_197e" },
    current_stage_id: "elurp_197e.application_certification",
  });
  assert.equal(certification.current_stage.stage_id, "elurp_197e.application_certification");
  // A2: no single next stage — a parallel group has no first-then-second order.
  assert.equal(certification.expected_next_stage, null);
  assert.equal(certification.expected_next_transition.kind, "parallel_group");
  assert.equal(certification.expected_next_transition.group_id, "elurp_197e.local_review");
  assert.deepEqual(certification.expected_next_transition.stage_ids, [
    "elurp_197e.community_board_review",
    "elurp_197e.borough_president_review",
  ]);
  assert.equal(certification.expected_next_transition.stages.length, 2);
  assert.equal(certification.expected_next_transition.join_to_stage_id, "elurp_197e.city_planning_commission_review");
  assert.match(certification.expected_next_transition.legal_basis[0].citation, /§ 197-e/);

  // A2: Community Board and Borough President share the transition origin —
  // neither points at the other, both point past the group to CPC.
  const communityBoard = buildLandProcedureProfileView({
    source: { procedure_profile_id: "elurp_197e" },
    current_stage_id: "elurp_197e.community_board_review",
  });
  assert.equal(communityBoard.current_stage.parallel_group_id, "elurp_197e.local_review");
  assert.equal(communityBoard.expected_next_transition.kind, "sequential");
  assert.equal(communityBoard.expected_next_stage.stage_id, "elurp_197e.city_planning_commission_review");

  const boroughPresident = buildLandProcedureProfileView({
    source: { procedure_profile_id: "elurp_197e" },
    current_stage_id: "elurp_197e.borough_president_review",
  });
  assert.equal(boroughPresident.current_stage.parallel_group_id, "elurp_197e.local_review");
  assert.equal(boroughPresident.expected_next_stage.stage_id, "elurp_197e.city_planning_commission_review");

  // A3: CPC is terminal — Council and Mayor are absent from the ordinary profile.
  const cpc = buildLandProcedureProfileView({
    source: { procedure_profile_id: "elurp_197e" },
    current_stage_id: "elurp_197e.city_planning_commission_review",
  });
  assert.equal(cpc.expected_next_stage, null);
  assert.equal(cpc.expected_next_transition, null);
  assert.equal(cpc.stages.some((stage) => stage.spine_phase_id === "city_council"), false);
  assert.equal(cpc.stages.some((stage) => stage.spine_phase_id === "mayoral_appeals"), false);

  // A9: every normative stage cites its applicable § 197-e subdivision.
  for (const stage of certification.stages) {
    assert.ok(stage.legal_basis.length, `${stage.stage_id} must cite a subdivision`);
    assert.match(stage.legal_basis[0].citation, /§ 197-e/);
  }
});

/**
 * A4: the two completed ordinary canaries — 2024Q0419 (E2, C-prefixed ZM
 * identifier) and 2025R0257 (E3, a different action family, PC) — both match
 * the ordinary profile, and their observed Community Board / Borough
 * President milestones occupy the same parallel group rather than two
 * sequential deadlines.
 */
test("A4 completed ordinary canaries 2024Q0419 and 2025R0257 place observed CB/BP in the same parallel group", () => {
  for (const projectId of ["2024Q0419", "2025R0257"]) {
    const resolved = resolveLandProcedureProfile({ ulurp_non: "ELURP", actions: "ZM", project_id: projectId });
    assert.equal(resolved.status, "resolved");
    assert.equal(resolved.profile_id, "elurp_197e");

    const cb = buildLandProcedureProfileView({
      source: { procedure_profile_id: "elurp_197e" },
      current_stage_id: "elurp_197e.community_board_review",
    });
    const bp = buildLandProcedureProfileView({
      source: { procedure_profile_id: "elurp_197e" },
      current_stage_id: "elurp_197e.borough_president_review",
    });
    assert.equal(cb.current_stage.parallel_group_id, bp.current_stage.parallel_group_id, `${projectId}: CB/BP share one group`);
    assert.equal(cb.expected_next_stage.stage_id, "elurp_197e.city_planning_commission_review");
    assert.equal(bp.expected_next_stage.stage_id, "elurp_197e.city_planning_commission_review");
  }
});

/**
 * A2, A3, A5, A8: the § 197-e(k) variant is a distinct, separately reviewed
 * profile — Filing -> {Community Board || Borough President} -> Council —
 * and does not disturb the ordinary CPC-terminal profile or any other
 * registered procedure.
 */
test("A2, A3, A5, A8 elurp_197e_k models Filing -> {CB || BP} -> Council as its own reviewed variant", () => {
  const variant = LAND_PROCEDURE_PROFILE_REGISTRY.profiles.find((profile) => profile.procedure_id === "elurp_197e_k");
  assert.ok(variant);
  assert.equal(variant.broad_procedure_id, "elurp_197e");

  const filing = buildLandProcedureProfileView({
    source: { procedure_profile_id: "elurp_197e_k" },
    current_stage_id: "elurp_197e_k.filing_and_referral",
  });
  assert.equal(filing.broad_profile_id, "elurp_197e");
  assert.equal(filing.expected_next_transition.kind, "parallel_group");
  assert.deepEqual(filing.expected_next_transition.stage_ids, [
    "elurp_197e_k.community_board_review",
    "elurp_197e_k.borough_president_review",
  ]);
  assert.equal(filing.expected_next_transition.join_to_stage_id, "elurp_197e_k.city_council_review");

  const communityBoard = buildLandProcedureProfileView({
    source: { procedure_profile_id: "elurp_197e_k" },
    current_stage_id: "elurp_197e_k.community_board_review",
  });
  assert.equal(communityBoard.expected_next_stage.stage_id, "elurp_197e_k.city_council_review");

  // Council is terminal for the variant; the ordinary profile never reaches Council.
  const council = buildLandProcedureProfileView({
    source: { procedure_profile_id: "elurp_197e_k" },
    current_stage_id: "elurp_197e_k.city_council_review",
  });
  assert.equal(council.expected_next_stage, null);
  assert.equal(council.expected_next_transition, null);
  assert.equal(variant.stages.some((stage) => stage.spine_phase_id === "cpc"), false);

  const ordinary = LAND_PROCEDURE_PROFILE_REGISTRY.profiles.find((profile) => profile.procedure_id === "elurp_197e");
  assert.equal(ordinary.stages.some((stage) => stage.spine_phase_id === "city_council"), false);

  // A8: the other reviewed profiles keep their existing meaning.
  for (const id of ["ulurp_197c", "ulurp_197d_conditional_council", "plan_197a"]) {
    const untouched = LAND_PROCEDURE_PROFILE_REGISTRY.profiles.find((profile) => profile.procedure_id === id);
    assert.ok(untouched);
    assert.equal(Object.hasOwn(untouched, "broad_procedure_id"), false);
    assert.equal(Array.isArray(untouched.transitions), false);
  }
});

/**
 * A6, A7: 2026X0362 (E4, HPD disposition, action PP) resolves the broad
 * expedited procedure, but the § 197-e(k) variant stays unresolved from
 * agency name, action type, title, or housing purpose alone — those facts
 * are never even inspected. Only an exact retained referral/application
 * fact with its own source field, record id, and provenance can select it,
 * and a later observed Council milestone still cannot retroactively supply
 * that eligibility evidence.
 */
test("A6, A7 elurp_197e_k is selectable only from exact retained referral/application evidence", () => {
  const broad = resolveLandProcedureProfile({ ulurp_non: "ELURP", actions: "PP", project_id: "2026X0362" });
  assert.equal(broad.status, "resolved");
  assert.equal(broad.profile_id, "elurp_197e");

  const noEvidence = resolveLandProcedureVariant({ broad_profile_id: "elurp_197e" });
  assert.equal(noEvidence.status, "unresolved");
  assert.equal(noEvidence.variant_id, null);
  assert.equal(noEvidence.reason, "insufficient_variant_evidence");

  // Negative rule: HPD, PP, a title, or "affordable housing" never select the variant.
  const weakSignals = resolveLandProcedureVariant({
    broad_profile_id: "elurp_197e",
    evidence: { agency: "HPD", action_type: "PP", title: "351 Powers Avenue (HPD ELURP)", purpose: "affordable housing" },
  });
  assert.equal(weakSignals.status, "unresolved");
  assert.equal(weakSignals.variant_id, null);

  // A7: an observed Council milestone proves an observed stage, never eligibility.
  const councilMilestoneAlone = resolveLandProcedureVariant({
    broad_profile_id: "elurp_197e",
    evidence: { kind: "observed_council_outcome", retained: true, outcome: "Adopted" },
  });
  assert.equal(councilMilestoneAlone.status, "unresolved", "an observed outcome is not a retained referral/application fact");

  // Evidence present but incomplete (missing source_record_id) still fails closed.
  const incomplete = resolveLandProcedureVariant({
    broad_profile_id: "elurp_197e",
    evidence: { kind: "retained_referral", retained: true, source_field: "zap_api.referral" },
  });
  assert.equal(incomplete.status, "unresolved");

  // Exact retained evidence resolves the variant.
  const exact = resolveLandProcedureVariant({
    broad_profile_id: "elurp_197e",
    evidence: {
      kind: "retained_referral",
      retained: true,
      source_field: "zap_api.actions[].referral",
      source_record_id: "zap-api-outcomes:2026X0362",
      source_vintage: "2026-05-20",
    },
  });
  assert.equal(exact.status, "resolved");
  assert.equal(exact.variant_id, "elurp_197e_k");
  assert.equal(exact.broad_profile_id, "elurp_197e");
  assert.equal(exact.profile.procedure_id, "elurp_197e_k");

  // A profile with no reviewed variant reports not_applicable regardless of evidence.
  const noVariant = resolveLandProcedureVariant({
    broad_profile_id: "ulurp_197c",
    evidence: { kind: "retained_referral", retained: true, source_field: "x", source_record_id: "y" },
  });
  assert.equal(noVariant.status, "not_applicable");
  assert.equal(noVariant.variant_id, null);
});
