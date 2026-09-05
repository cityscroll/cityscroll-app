/**
 * Actor-aware observed outcomes for Land ZAP dispositions (LDP-10).
 *
 *   node --test test/land_actor_outcome.test.mjs
 */
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";

import {
  ACTOR_KIND_BOROUGH_BOARD,
  ACTOR_KIND_BOROUGH_PRESIDENT,
  ACTOR_KIND_CITY_COUNCIL,
  ACTOR_KIND_COMMUNITY_BOARD,
  ACTOR_KIND_CPC,
  LAND_ACTOR_OUTCOME_SCHEMA,
  OBSERVED_ACTION,
  actorKindFromRepresenting,
  actorRefForOutcome,
  buildActorObservedOutcome,
  buildActorObservedOutcomes,
  legalEffectFromProfile,
  spinePhaseIdForActorKind,
} from "../site/land_actor_outcome.mjs";
import {
  buildLandOutcomesMatrixRows,
  landOutcomesMatrixHTML,
} from "../site/land_outcomes_matrix.mjs";
import { projectAffectedReviewBodies } from "../site/land_affected_review_body.mjs";
import { buildLandPhaseView } from "../site/land_phase_spine.mjs";

const requireJson = createRequire(import.meta.url);
const landDefault = requireJson("../site/data/land_default_ulurp.json");
const geography = requireJson("../site/data/community_board_geography_lookup.json");

function project(projectId) {
  return landDefault.projects.find((row) => row.project_id === projectId);
}
function dispositions(projectId) {
  return landDefault.outcomes.by_project[projectId].dispositions;
}

const CANARY_CB13 = "2023K0183";
const CANARY_CB5_BP = "2025M0252";
const CANARY_DRAFT = "2025K0305";

// ---------------------------------------------------------------------------
// A1 — canonical actor ref/kind, observed action, raw outcome, and
// profile-derived legal effect as separate fields.
// ---------------------------------------------------------------------------

test("A1 CB13 unfavorable on 2023K0183 normalizes to a recommendation, never a decision", () => {
  const rows = dispositions(CANARY_CB13);
  const cb13 = rows.find((row) => /CB13/.test(row.name));
  assert.equal(cb13.id, "e88ccfda-3c19-f011-998b-001dd806079d");
  const outcome = buildActorObservedOutcome(cb13, { projectId: CANARY_CB13, project: project(CANARY_CB13) });
  assert.equal(outcome.schema, LAND_ACTOR_OUTCOME_SCHEMA);
  assert.equal(outcome.actor_kind, ACTOR_KIND_COMMUNITY_BOARD);
  assert.equal(outcome.actor_ref, "community-board:brooklyn-cb-13");
  // The negative rule, structurally: "Unfavorable" reads like a rejection,
  // but CB13 is advisory — it only ever issues a recommendation.
  assert.equal(outcome.observed_action, OBSERVED_ACTION.ISSUES_RECOMMENDATION);
  assert.notEqual(outcome.observed_action, OBSERVED_ACTION.REJECTS);
  assert.equal(outcome.is_advisory, true);
  assert.equal(outcome.raw_outcome, "Unfavorable");
  assert.equal(outcome.observed_at, "2026-03-25");
  assert.deepEqual(outcome.vote_tally, { for: 1, against: 29, abstain: 5 });
  assert.equal(outcome.disposition_id, "e88ccfda-3c19-f011-998b-001dd806079d");
  assert.equal(outcome.action_key, "project:2023K0183:disposition:e88ccfda-3c19-f011-998b-001dd806079d");
  assert.equal(outcome.spine_phase_id, "community_board");
  // Raw source and vote tallies are preserved byte-for-byte, not paraphrased.
  assert.equal(outcome.raw_outcome, cb13.community_board);
  assert.equal(outcome.vote_tally.for, cb13.votes_for);
  assert.equal(outcome.vote_tally.against, cb13.votes_against);
});

test("A1 BP conditional-favorable on 2023K0183 resolves an exact Brooklyn actor ref from the project id", () => {
  const rows = dispositions(CANARY_CB13);
  const bp = rows.find((row) => row.representing === "Borough President");
  const outcome = buildActorObservedOutcome(bp, { projectId: CANARY_CB13, project: project(CANARY_CB13) });
  assert.equal(outcome.actor_kind, ACTOR_KIND_BOROUGH_PRESIDENT);
  assert.equal(outcome.actor_ref, "borough-president:brooklyn");
  assert.equal(outcome.observed_action, OBSERVED_ACTION.ISSUES_RECOMMENDATION);
  assert.equal(outcome.raw_outcome, "Conditional Favorable");
  assert.equal(outcome.vote_tally, null);
  assert.equal(outcome.spine_phase_id, "borough_president");
});

test("A1 CB5/BP conditional-favorable on 2025M0252 carries a profile-derived legal effect kept separate from the raw value", () => {
  const outcomes = buildActorObservedOutcomes(dispositions(CANARY_CB5_BP), {
    projectId: CANARY_CB5_BP,
    project: project(CANARY_CB5_BP),
  });
  assert.equal(outcomes.length, 2);
  const cb5 = outcomes.find((row) => row.actor_kind === ACTOR_KIND_COMMUNITY_BOARD);
  const bp = outcomes.find((row) => row.actor_kind === ACTOR_KIND_BOROUGH_PRESIDENT);
  assert.equal(cb5.actor_ref, "community-board:manhattan-cb-05");
  assert.equal(cb5.raw_outcome, "Conditional Favorable");
  assert.deepEqual(cb5.vote_tally, { for: 31, against: 1, abstain: 1 });
  assert.equal(bp.actor_ref, "borough-president:manhattan");
  assert.equal(bp.raw_outcome, "Conditional Favorable");
  for (const row of [cb5, bp]) {
    assert.equal(row.legal_effect_from_profile.role, "advisory_reviewer");
    assert.match(row.legal_effect_from_profile.effect, /advisory, not binding/);
    assert.equal(row.legal_effect_from_profile.procedure_id, "ulurp_197c");
    // Profile effect never overwrites, and is a distinct field from, the raw value.
    assert.notEqual(row.legal_effect_from_profile.effect, row.raw_outcome);
    assert.equal(row.observed_action, OBSERVED_ACTION.ISSUES_RECOMMENDATION);
  }
});

test("A1 CPC and City Council dispositions normalize institutional actor refs and decision-family actions", () => {
  const cpcAdopt = buildActorObservedOutcome({
    id: "cpc-vote-1",
    status: "Approved",
    representing: "City Planning Commission",
    outcome: "Approved",
    vote_date: "2026-05-01",
    votes_for: 11,
    votes_against: 2,
    n_documents: 3,
  }, { projectId: "2026Q0210", project: project("2026Q0210") });
  assert.equal(cpcAdopt.actor_kind, ACTOR_KIND_CPC);
  assert.equal(cpcAdopt.actor_ref, "agency:id:city-planning-commission");
  assert.equal(cpcAdopt.is_advisory, false);
  assert.equal(cpcAdopt.observed_action, OBSERVED_ACTION.ADOPTS);
  assert.equal(cpcAdopt.raw_outcome, "Approved");
  assert.equal(cpcAdopt.spine_phase_id, "cpc");

  const councilReject = buildActorObservedOutcome({
    id: "council-vote-1",
    status: "Disapproved",
    representing: "City Council",
    outcome: "Disapproved",
    vote_date: "2026-06-15",
  }, { projectId: "2026Q0210" });
  assert.equal(councilReject.actor_kind, ACTOR_KIND_CITY_COUNCIL);
  assert.equal(councilReject.actor_ref, "agency:id:city-council");
  assert.equal(councilReject.is_advisory, false);
  assert.equal(councilReject.observed_action, OBSERVED_ACTION.REJECTS);
  assert.equal(councilReject.spine_phase_id, "city_council");

  const councilModify = buildActorObservedOutcome({
    id: "council-vote-2",
    status: "Modified",
    representing: "City Council",
    outcome: "Modified and Approved",
    vote_date: "2026-06-15",
  }, { projectId: "2026Q0210" });
  assert.equal(councilModify.observed_action, OBSERVED_ACTION.MODIFIES);
});

test("A1 Borough Board disposition resolves an exact borough ref via LDP-04 identity, with its own profile stage", () => {
  const boroughBoard = buildActorObservedOutcome({
    id: "bb-vote-1",
    status: "Submitted",
    representing: "Borough Board",
    borough_board: "Favorable",
    vote_date: "2026-02-01",
  }, { projectId: CANARY_DRAFT, project: project(CANARY_DRAFT) });
  assert.equal(boroughBoard.actor_kind, ACTOR_KIND_BOROUGH_BOARD);
  assert.equal(boroughBoard.actor_ref, "borough-board:brooklyn");
  assert.equal(boroughBoard.is_advisory, true);
  assert.equal(boroughBoard.observed_action, OBSERVED_ACTION.ISSUES_RECOMMENDATION);
  assert.equal(boroughBoard.raw_outcome, "Favorable");
  // ulurp_197c models Borough Board review as its own advisory stage.
  assert.equal(boroughBoard.legal_effect_from_profile.role, "advisory_reviewer");
  assert.equal(boroughBoard.legal_effect_from_profile.procedure_id, "ulurp_197c");
});

// ---------------------------------------------------------------------------
// A2 — one normalized object powers both the matrix and timeline evidence.
// ---------------------------------------------------------------------------

test("A2 the matrix and the phase-spine timeline consume the identical observed_outcomes[] array", () => {
  const outcomes = buildActorObservedOutcomes(dispositions(CANARY_CB13), {
    projectId: CANARY_CB13,
    project: project(CANARY_CB13),
  });
  const matrixRows = buildLandOutcomesMatrixRows(outcomes, { affectedEdges: [] });
  const spine = buildLandPhaseView({ project_id: CANARY_CB13, events: [] }, {
    observed_outcomes: outcomes,
  });
  const cbPhase = spine.all_phases.find((phase) => phase.id === "community_board");
  const bpPhase = spine.all_phases.find((phase) => phase.id === "borough_president");
  assert.equal(spine.observed_outcomes, outcomes, "the exact same array reference, not a re-derived copy");
  assert.equal(cbPhase.observed_outcomes.length, 1);
  assert.equal(cbPhase.observed_outcomes[0], outcomes[0], "same object, not a paraphrase");
  assert.equal(bpPhase.observed_outcomes.length, 1);
  assert.equal(bpPhase.observed_outcomes[0], outcomes[1]);
  const matrixCbRow = matrixRows.find((row) => row.body_ref === "community-board:brooklyn-cb-13");
  assert.equal(matrixCbRow.raw_outcome, outcomes[0].raw_outcome);
  assert.equal(matrixCbRow.observed_action, outcomes[0].observed_action);
  assert.equal(matrixCbRow.action_key, outcomes[0].action_key);
});

test("A2 buildLandPhaseView derives observed_outcomes from opts.dispositions when not precomputed", () => {
  const spine = buildLandPhaseView({ project_id: CANARY_CB5_BP, events: [] }, {
    dispositions: dispositions(CANARY_CB5_BP),
    project_id: CANARY_CB5_BP,
    open_data: project(CANARY_CB5_BP),
  });
  assert.equal(spine.observed_outcomes.length, 2);
  assert.ok(spine.observed_outcomes.every((row) => row.legal_effect_from_profile?.procedure_id === "ulurp_197c"));
});

// ---------------------------------------------------------------------------
// A3 — draft, missing, ambiguous, meeting-only, and affected-role-only
// records never become observed recommendations or decisions.
// ---------------------------------------------------------------------------

test("A3 2025K0305 draft-only rows produce zero observed outcomes; the affected Borough Board shows not-found in the matrix", () => {
  const outcomes = buildActorObservedOutcomes(dispositions(CANARY_DRAFT), {
    projectId: CANARY_DRAFT,
    project: project(CANARY_DRAFT),
  });
  assert.deepEqual(outcomes, []);

  const affected = projectAffectedReviewBodies(project(CANARY_DRAFT), { geography });
  assert.equal(affected.status, "resolved");
  assert.ok(affected.facts.borough_boards.includes("borough-board:brooklyn"));

  const matrixRows = buildLandOutcomesMatrixRows(outcomes, { affectedEdges: affected.edges });
  const boroughBoardRow = matrixRows.find((row) => row.body_ref === "borough-board:brooklyn");
  assert.ok(boroughBoardRow, "affected Borough Board still appears in the matrix");
  assert.equal(boroughBoardRow.status, "recommendation_not_found");
  assert.equal(boroughBoardRow.observed_action, null);
  assert.equal(boroughBoardRow.raw_outcome, null);
  // Every affected body (CB11, CB13, BP, Borough Board) reads not-found — none invented.
  assert.equal(matrixRows.length, affected.edges.length);
  assert.ok(matrixRows.every((row) => row.status === "recommendation_not_found"));

  const html = landOutcomesMatrixHTML(matrixRows, { t: (key) => key, escape: (v) => String(v ?? "") });
  assert.match(html, /borough-board:brooklyn/);
  assert.match(html, /land_outcomes_matrix_not_found/);
});

test("A3 missing, pending, and meeting-only dispositions never mint an observed outcome", () => {
  const missing = buildActorObservedOutcome({
    id: "missing-1",
    status: "Submitted",
    representing: "Community Board",
    board_id: "brooklyn-cb-13",
  }, { projectId: CANARY_CB13 });
  assert.equal(missing, null, "no outcome text at all");

  const pending = buildActorObservedOutcome({
    id: "pending-1",
    status: "Submitted",
    representing: "Community Board",
    board_id: "brooklyn-cb-13",
    community_board: "Pending",
    vote_date: "2026-09-22",
  }, { projectId: CANARY_CB13 });
  assert.equal(pending, null, "a pending label with a future date is calendar evidence, not an observed outcome");

  const meetingOnly = buildActorObservedOutcome({
    id: "meeting-only-1",
    status: "Submitted",
    representing: "Community Board",
    board_id: "brooklyn-cb-13",
    hearing_date: "2026-01-29",
  }, { projectId: CANARY_CB13 });
  assert.equal(meetingOnly, null, "a hearing date alone never observes an outcome");
});

test("A3 actor-ambiguous representing text and missing board_id never mint an observed outcome", () => {
  const unknownBody = buildActorObservedOutcome({
    id: "unknown-body-1",
    status: "Submitted",
    representing: "Zoning Task Force",
    outcome: "Favorable",
    vote_date: "2026-01-01",
  }, { projectId: CANARY_CB13 });
  assert.equal(unknownBody, null, "representing text outside the reviewed vocabulary stays ambiguous");
  assert.equal(actorKindFromRepresenting("Zoning Task Force"), null);

  const boardNameAlone = buildActorObservedOutcome({
    id: "no-board-id-1",
    status: "Submitted",
    representing: "Community Board",
    community_board: "Favorable",
    vote_date: "2026-01-01",
  }, { projectId: CANARY_CB13 });
  assert.equal(boardNameAlone, null, "a bare actor name with no exact board_id never resolves a ref");
  const ref = actorRefForOutcome({ representing: "Community Board" }, { projectId: CANARY_CB13 });
  assert.equal(ref.ref, null);
  assert.equal(ref.reason, "actor_ambiguous");
});

test("A3 draft status excludes an otherwise-authoritative-looking raw value", () => {
  const draftFavorable = buildActorObservedOutcome({
    id: "draft-favorable-1",
    status: "Draft",
    representing: "Community Board",
    board_id: "brooklyn-cb-13",
    community_board: "Favorable",
    vote_date: "2026-01-01",
  }, { projectId: CANARY_CB13 });
  assert.equal(draftFavorable, null);
});

test("A3 profile/phase evidence alone — with no disposition row — never fabricates an observed outcome", () => {
  // A resolved procedure profile and current-milestone evidence both say the
  // Community Board has a role right now; that alone must never manufacture
  // an observed_outcomes[] entry. Only an actual disposition row can.
  const outcomes = buildActorObservedOutcomes([], {
    projectId: CANARY_CB5_BP,
    project: project(CANARY_CB5_BP),
  });
  assert.deepEqual(outcomes, []);
  const effect = legalEffectFromProfile(project(CANARY_CB5_BP), ACTOR_KIND_COMMUNITY_BOARD);
  assert.equal(effect.role, "advisory_reviewer", "the profile does resolve a role for this actor kind");
  // ...yet with zero dispositions, that role never becomes an observed outcome.
  assert.equal(outcomes.length, 0);
});

// ---------------------------------------------------------------------------
// A4 — exact disposition/document provenance and raw values survive
// regression across outcome, connection, phase, and snapshot fixtures.
// ---------------------------------------------------------------------------

test("A4 legal effect is null with an honest reason when the procedure does not resolve to one profile", () => {
  // 2023K0183 carries five actions (ZM/ZR/ZS/LD/ZS) that do not resolve to a
  // single uniform procedure id — legal effect must stay null, never guess.
  const outcomes = buildActorObservedOutcomes(dispositions(CANARY_CB13), {
    projectId: CANARY_CB13,
    project: project(CANARY_CB13),
  });
  for (const outcome of outcomes) {
    assert.equal(outcome.legal_effect_from_profile, null);
    assert.equal(outcome.legal_effect_reason, "procedure_unresolved");
    // The raw value is preserved regardless of whether the profile resolved.
    assert.ok(outcome.raw_outcome);
  }
});

test("A4 no_matching_stage_in_profile is the honest reason for an actor kind the profile never models", () => {
  // The broad § 197-e (ELURP) profile has no Borough Board review stage at
  // all — unlike ulurp_197c, which does (see the A1 Borough Board test).
  const elurpProject = requireJson("./fixtures/land_phase_spine/2024Q0356.json");
  const effect = legalEffectFromProfile(elurpProject, ACTOR_KIND_BOROUGH_BOARD);
  assert.equal(effect.role, null);
  assert.equal(effect.effect, null);
  assert.equal(effect.reason, "no_matching_stage_in_profile");
  assert.equal(effect.procedure_id, "elurp_197e");
});

test("A4 exact disposition ids, source ids, and vote tallies survive normalization byte-for-byte", () => {
  const raw = dispositions(CANARY_CB13);
  const outcomes = buildActorObservedOutcomes(raw, { projectId: CANARY_CB13, project: project(CANARY_CB13) });
  for (const outcome of outcomes) {
    const source = raw.find((row) => row.id === outcome.disposition_id);
    assert.ok(source, outcome.disposition_id);
    assert.deepEqual(outcome.source_ids, source.source_ids);
    assert.equal(outcome.document_count, source.n_documents);
  }
});

test("A4 spinePhaseIdForActorKind and ACTOR_KIND coverage matches the five reviewed actor kinds", () => {
  assert.equal(spinePhaseIdForActorKind(ACTOR_KIND_COMMUNITY_BOARD), "community_board");
  assert.equal(spinePhaseIdForActorKind(ACTOR_KIND_BOROUGH_PRESIDENT), "borough_president");
  assert.equal(spinePhaseIdForActorKind(ACTOR_KIND_BOROUGH_BOARD), "borough_president");
  assert.equal(spinePhaseIdForActorKind(ACTOR_KIND_CPC), "cpc");
  assert.equal(spinePhaseIdForActorKind(ACTOR_KIND_CITY_COUNCIL), "city_council");
  assert.equal(spinePhaseIdForActorKind("unknown"), null);
});

test("A4 the matrix table renders Body, observed action, raw value, date, vote/document, and profile effect columns", () => {
  const outcomes = buildActorObservedOutcomes(dispositions(CANARY_CB5_BP), {
    projectId: CANARY_CB5_BP,
    project: project(CANARY_CB5_BP),
  });
  const rows = buildLandOutcomesMatrixRows(outcomes, { affectedEdges: [] });
  const html = landOutcomesMatrixHTML(rows, { t: (key, vars) => (vars ? `${key}:${JSON.stringify(vars)}` : key), escape: (v) => String(v ?? "") });
  assert.match(html, /data-land-outcomes-matrix="1"/);
  assert.match(html, /community-board:manhattan-cb-05/);
  assert.match(html, /borough-president:manhattan/);
  assert.match(html, /Conditional Favorable/);
  assert.match(html, /2026-04-09/);
  assert.match(html, /land_outcomes_matrix_action_issues_recommendation/);
  assert.match(html, /advisory, not binding/);
  assert.match(html, /land_authority_advisory/);
});
