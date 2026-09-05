/**
 * Procedure-aware "Follow next decision" watch (LDP-16).
 *
 *   node --test test/land_next_decision_watch.test.mjs
 */
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";

import { buildLandAuthoritySummary } from "../site/land_authority_summary.mjs";
import { buildActorObservedOutcomes } from "../site/land_actor_outcome.mjs";
import {
  LAND_NEXT_DECISION_RELIABILITY_SCHEMA,
  NEXT_DECISION_RELIABILITY_THRESHOLD,
  NEXT_DECISION_INELIGIBLE_REASONS,
  NEXT_DECISION_FIRE_TRIGGERS,
  measureNextDecisionReliability,
  nextDecisionEligibility,
  buildTransitionIdentity,
  buildNextDecisionWatchKey,
  buildNextDecisionSnapshot,
  evaluateNextDecisionWatchFiring,
  buildNextDecisionDigestCopy,
} from "../site/land_next_decision_watch.mjs";
import {
  landAuthorityPanelProjection,
  rememberLandAuthoritySummaries,
} from "../site/land_authority_summary_view.mjs";

const requireJson = createRequire(import.meta.url);
const geography = requireJson("../site/data/community_board_geography_lookup.json");
const landDefault = requireJson("../site/data/land_default_ulurp.json");
const hearings = requireJson("../site/data/land_upcoming_hearings.json");
const committedPayload = requireJson("../site/data/land_authority_summary.json");

const COUNCIL_SPECIMEN = "2026Q0210"; // eligible: CB12 favorable vote, BP hearing evidence
const DRAFT_SPECIMEN = "2025K0305"; // ineligible: multi-CD draft-only rows

function defaultRow(projectId) {
  return (landDefault.projects || []).find((row) => row.project_id === projectId);
}

function realDispositions(projectId) {
  return landDefault.outcomes?.by_project?.[projectId]?.dispositions || [];
}

function projectHearings(projectId) {
  return (hearings.hearings || []).filter((row) => row.project_id === projectId);
}

/** Build a real, builder-derived summary for a fixture project with overrides. */
function summarize(projectId, { milestone, dispositions, hearingRows, asOf = "2026-08-23" } = {}) {
  const project = { ...defaultRow(projectId) };
  if (milestone) project.current_milestone = milestone;
  return buildLandAuthoritySummary({
    ...project,
    geography,
    asOf,
    generatedAt: asOf,
    dispositions: dispositions ?? realDispositions(projectId),
    publishedOpportunities: {
      hearings: hearingRows ?? projectHearings(projectId),
      generated_at: asOf,
    },
  });
}

function outcomesFor(projectId, dispositions, { affected } = {}) {
  return buildActorObservedOutcomes(dispositions, {
    projectId,
    project: defaultRow(projectId),
    affected,
  });
}

const GO_RELIABILITY = Object.freeze({ gate: Object.freeze({ result: "GO" }) });
const STOP_RELIABILITY = Object.freeze({ gate: Object.freeze({ result: "STOP" }) });

// ---------------------------------------------------------------------------
// A1 — eligibility gates on a measured reliability threshold, not project id.
// ---------------------------------------------------------------------------

test("A1 measureNextDecisionReliability GOes above threshold and STOPs below it, over the real corpus", () => {
  const real = measureNextDecisionReliability(committedPayload.summaries);
  assert.equal(real.schema, LAND_NEXT_DECISION_RELIABILITY_SCHEMA);
  assert.equal(real.threshold, NEXT_DECISION_RELIABILITY_THRESHOLD);
  assert.equal(real.coverage.universe, 40);
  assert.ok(real.coverage.normalized > 0);
  assert.ok(real.coverage.rate >= NEXT_DECISION_RELIABILITY_THRESHOLD, `real corpus rate ${real.coverage.rate} should clear the bar`);
  assert.equal(real.gate.result, "GO");

  const belowBar = measureNextDecisionReliability({
    a: { status: "unknown" },
    b: { status: "unknown" },
    c: { status: "unknown" },
    d: { status: "unknown" },
    e: { status: "unknown" },
    f: { status: "unknown" },
    g: { status: "unknown" },
    h: { status: "unknown" },
    i: { status: "unknown" },
    j: { status: "resolved", current_actor_refs: ["agency:id:city-council"], current_stage: { stage_id: "s" } },
  });
  assert.equal(belowBar.coverage.rate, 0.1);
  assert.equal(belowBar.gate.result, "STOP");

  const aboveBar = measureNextDecisionReliability({
    a: { status: "resolved", current_actor_refs: ["agency:id:city-council"], current_stage: { stage_id: "s" } },
    b: { status: "resolved", current_actor_refs: ["agency:id:city-planning-commission"], current_stage: { stage_id: "t" } },
    c: { status: "unknown" },
    d: { status: "unknown" },
    e: { status: "unknown" },
  });
  assert.equal(aboveBar.coverage.rate, 0.4);
  assert.equal(aboveBar.gate.result, "GO");

  // A resolved stage with no normalized actor never counts toward coverage.
  const actorless = measureNextDecisionReliability({
    a: { status: "resolved", current_actor_refs: [], current_stage: { stage_id: "s" } },
  });
  assert.equal(actorless.coverage.normalized, 0);
  assert.equal(actorless.gate.result, "STOP");
});

test("A1 2026Q0210 is eligible only once corpus-wide reliability clears the bar", () => {
  const summary = summarize(COUNCIL_SPECIMEN);
  assert.equal(summary.status, "resolved");

  const belowBar = nextDecisionEligibility({ summary, reliability: STOP_RELIABILITY });
  assert.equal(belowBar.eligible, false);
  assert.equal(belowBar.reason, NEXT_DECISION_INELIGIBLE_REASONS.RELIABILITY_BELOW_THRESHOLD);

  const aboveBar = nextDecisionEligibility({ summary, reliability: GO_RELIABILITY });
  assert.equal(aboveBar.eligible, true);
  assert.equal(aboveBar.reason, null);
});

test("A1/A2 2025K0305's draft-only Borough Board/CB rows never drive eligibility or a fire — only its own materialized DCP stage does", () => {
  const summary = summarize(DRAFT_SPECIMEN);
  // The current stage is DCP's own administrative certification, not the
  // draft future-stage CB/BP/Borough Board rows — those sit on the
  // `affected_actor_refs`/`observed` side, never on `current_actor_refs`.
  assert.equal(summary.status, "resolved");
  assert.deepEqual(summary.current_actor_refs, ["agency:id:city-planning"]);
  assert.equal(summary.observed.status, "draft_only");
  assert.ok(summary.affected_actor_refs.length > 0);

  const eligibility = nextDecisionEligibility({ summary, reliability: GO_RELIABILITY });
  assert.equal(eligibility.eligible, true);

  // A watch subscribed at this baseline must not fire merely because the
  // project is "affected" by several bodies or because their rows are draft.
  const previous = buildNextDecisionSnapshot({
    summary,
    observedOutcomes: outcomesFor(DRAFT_SPECIMEN, realDispositions(DRAFT_SPECIMEN)),
  });
  const result = evaluateNextDecisionWatchFiring({
    previous,
    summary, // nothing changed
    observedOutcomes: outcomesFor(DRAFT_SPECIMEN, realDispositions(DRAFT_SPECIMEN)),
    reliability: GO_RELIABILITY,
  });
  assert.equal(result.fired, false);
  assert.equal(result.reason, "no_change");
  assert.equal(outcomesFor(DRAFT_SPECIMEN, realDispositions(DRAFT_SPECIMEN)).length, 0, "every 2025K0305 disposition is draft-only");
});

test("A1 an unresolved-procedure project shows an explicit ineligible reason on the real Land panel, never a silent absence", () => {
  const UNRESOLVED_SPECIMEN = "2020M0385";
  assert.equal(committedPayload.summaries[UNRESOLVED_SPECIMEN].status, "unknown");
  rememberLandAuthoritySummaries(committedPayload);
  const projection = landAuthorityPanelProjection(committedPayload.summaries[UNRESOLVED_SPECIMEN]);
  assert.equal(projection.watch_target, "project");
  assert.equal(projection.next_decision_ineligible_reason, committedPayload.summaries[UNRESOLVED_SPECIMEN].reason);
});

// ---------------------------------------------------------------------------
// A2 — positive transition/event firing; negative rule (elapsed time,
// profile successor, draft disposition, meeting existence, display text).
// ---------------------------------------------------------------------------

test("A2 positive: a changed materialized stage/actor transition fires once", () => {
  const oldSummary = summarize(COUNCIL_SPECIMEN, {
    milestone: "Community Board Review",
    dispositions: realDispositions(COUNCIL_SPECIMEN).filter((row) => row.representing === "Borough President"),
  });
  assert.equal(oldSummary.current_stage.spine_phase_id, "community_board");

  const newSummary = summarize(COUNCIL_SPECIMEN); // real milestone: MM - City Council Review
  assert.equal(newSummary.current_stage.stage_id, "ulurp_197c.city_council_review");

  const oldOutcomes = outcomesFor(COUNCIL_SPECIMEN, realDispositions(COUNCIL_SPECIMEN).filter((row) => row.representing === "Borough President"));
  const previous = buildNextDecisionSnapshot({ summary: oldSummary, observedOutcomes: oldOutcomes });
  const newOutcomes = outcomesFor(COUNCIL_SPECIMEN, realDispositions(COUNCIL_SPECIMEN));

  const result = evaluateNextDecisionWatchFiring({
    previous,
    summary: newSummary,
    observedOutcomes: newOutcomes,
    reliability: GO_RELIABILITY,
  });
  assert.equal(result.fired, true);
  assert.equal(result.trigger, NEXT_DECISION_FIRE_TRIGGERS.TRANSITION_CHANGE);
  assert.equal(result.receipt.old_stage.stage_id, "ulurp_197c.community_board_review");
  assert.equal(result.receipt.new_stage.stage_id, "ulurp_197c.city_council_review");
  assert.ok(result.receipt.profile_version);
  assert.ok(result.receipt.dedupe_key);

  const copy = buildNextDecisionDigestCopy({ fireResult: result, summary: newSummary });
  assert.equal(copy.trigger, NEXT_DECISION_FIRE_TRIGGERS.TRANSITION_CHANGE);
  assert.equal(copy.role_kind, "decisional"); // conditional_decision_maker, per the council specimen
});

test("A2 positive: a new exact observed event (CB12 favorable vote) fires without a stage change", () => {
  const bpOnly = realDispositions(COUNCIL_SPECIMEN).filter((row) => row.representing === "Borough President");
  const stableMilestone = "Community Board Review";

  const oldSummary = summarize(COUNCIL_SPECIMEN, { milestone: stableMilestone, dispositions: bpOnly });
  const newSummary = summarize(COUNCIL_SPECIMEN, { milestone: stableMilestone, dispositions: realDispositions(COUNCIL_SPECIMEN) });
  assert.equal(oldSummary.current_stage.stage_id, newSummary.current_stage.stage_id);

  const previous = buildNextDecisionSnapshot({ summary: oldSummary, observedOutcomes: outcomesFor(COUNCIL_SPECIMEN, bpOnly) });
  const newOutcomes = outcomesFor(COUNCIL_SPECIMEN, realDispositions(COUNCIL_SPECIMEN));
  const cb12 = newOutcomes.find((row) => row.actor_ref === "community-board:queens-cb-12");
  assert.ok(cb12, "CB12's favorable vote must normalize to an observed outcome");

  const result = evaluateNextDecisionWatchFiring({
    previous,
    summary: newSummary,
    observedOutcomes: newOutcomes,
    reliability: GO_RELIABILITY,
  });
  assert.equal(result.fired, true);
  assert.equal(result.trigger, NEXT_DECISION_FIRE_TRIGGERS.OBSERVED_EVENT);
  assert.equal(result.receipt.event_id, cb12.action_key);
  assert.equal(result.receipt.old_stage.stage_id, result.receipt.new_stage.stage_id);

  const copy = buildNextDecisionDigestCopy({ fireResult: result, summary: newSummary, observedOutcomes: newOutcomes });
  assert.equal(copy.role_kind, "advisory"); // Community Board is always advisory
  // Never calls a CB advisory recommendation a decision.
  assert.match(copy.detail, /recommends.*later statutory reviewer decides/i);
});

test("A2 positive: a new exact published opportunity fires without a stage or observed-event change", () => {
  const stableMilestone = "Community Board Review";
  const bpOnly = realDispositions(COUNCIL_SPECIMEN).filter((row) => row.representing === "Borough President");
  const oldSummary = summarize(COUNCIL_SPECIMEN, { milestone: stableMilestone, dispositions: bpOnly, hearingRows: [] });
  const newSummary = summarize(COUNCIL_SPECIMEN, {
    milestone: stableMilestone,
    dispositions: bpOnly,
    hearingRows: [{
      project_id: COUNCIL_SPECIMEN,
      hearing_date: "2026-09-30",
      representing: "City Planning Commission",
      milestone_title: "CPC Public Hearing",
      milestone_id: "cpc-hearing-2026-09-30",
    }],
  });
  assert.equal(oldSummary.published_next_opportunity.status, "none");
  assert.equal(newSummary.published_next_opportunity.status, "published");

  const previous = buildNextDecisionSnapshot({ summary: oldSummary, observedOutcomes: outcomesFor(COUNCIL_SPECIMEN, bpOnly) });
  const result = evaluateNextDecisionWatchFiring({
    previous,
    summary: newSummary,
    observedOutcomes: outcomesFor(COUNCIL_SPECIMEN, bpOnly),
    reliability: GO_RELIABILITY,
  });
  assert.equal(result.fired, true);
  assert.equal(result.trigger, NEXT_DECISION_FIRE_TRIGGERS.PUBLISHED_EVENT);
  assert.equal(result.receipt.event_id, newSummary.published_next_opportunity.source_id);

  const copy = buildNextDecisionDigestCopy({ fireResult: result, summary: newSummary });
  assert.equal(copy.role_kind, "published_event");
  // A published (scheduled) opportunity is never described as an outcome.
  assert.match(copy.detail, /no outcome has been recorded yet/i);
});

test("negative rule: elapsed time alone never fires", () => {
  const summaryAtT1 = summarize(COUNCIL_SPECIMEN, { asOf: "2026-08-23" });
  const summaryAtT2 = summarize(COUNCIL_SPECIMEN, { asOf: "2026-09-05" }); // two weeks later, nothing else changed
  const outcomes = outcomesFor(COUNCIL_SPECIMEN, realDispositions(COUNCIL_SPECIMEN));

  const previous = buildNextDecisionSnapshot({ summary: summaryAtT1, observedOutcomes: outcomes });
  const result = evaluateNextDecisionWatchFiring({
    previous,
    summary: summaryAtT2,
    observedOutcomes: outcomes,
    reliability: GO_RELIABILITY,
  });
  assert.equal(result.fired, false);
  assert.equal(result.reason, "no_change");
  // The vintage still moves even though nothing fires — it is captured, not ignored.
  assert.notEqual(result.snapshot.snapshot_vintage, previous.snapshot_vintage);
});

test("negative rule: a changed profile-expected successor alone never fires (kept separate from the event trigger)", () => {
  const base = {
    schema: "cityscroll.land_authority_summary.v1",
    status: "resolved",
    project_id: "2099Z0001",
    procedure_id: "ulurp_197c",
    current_stage: { stage_id: "ulurp_197c.city_council_review", spine_phase_id: "city_council", status: "known" },
    current_actor_refs: ["agency:id:city-council"],
    current_role: "conditional_decision_maker",
    source_basis: { profile: { registry_version: "2026-08-27.v1" } },
    published_next_opportunity: { status: "unknown" },
    freshness: { generated_at: "2026-08-23", as_of: "2026-08-23" },
  };
  const before = { ...base, expected_next_stage: null };
  const afterGuessedSuccessor = { ...base, expected_next_stage: { stage_id: "ulurp_197c.mayoral_review", spine_phase_id: "mayoral_appeals", status: "known" } };

  const previous = buildNextDecisionSnapshot({ summary: before, observedOutcomes: [] });
  const result = evaluateNextDecisionWatchFiring({
    previous,
    summary: afterGuessedSuccessor,
    observedOutcomes: [],
    reliability: GO_RELIABILITY,
  });
  assert.equal(result.fired, false);
  assert.equal(result.reason, "no_change");
  // buildTransitionIdentity never reads expected_next_stage at all.
  assert.equal(buildTransitionIdentity(before).transition_key, buildTransitionIdentity(afterGuessedSuccessor).transition_key);
});

test("negative rule: a draft-only disposition never mints a firing event (LDP-10 never gives it an action_key)", () => {
  const stableMilestone = "Community Board Review";
  const bpOnly = realDispositions(COUNCIL_SPECIMEN).filter((row) => row.representing === "Borough President");
  const draftCb = {
    id: "draft-cb-fixture-1",
    status: "Draft",
    representing: "Community Board",
    board_id: "queens-cb-12",
    community_board: "Favorable",
    votes_for: 20,
    votes_against: 0,
    votes_abstain: 0,
  };

  const oldSummary = summarize(COUNCIL_SPECIMEN, { milestone: stableMilestone, dispositions: bpOnly });
  const newSummary = summarize(COUNCIL_SPECIMEN, { milestone: stableMilestone, dispositions: [...bpOnly, draftCb] });
  const newOutcomes = outcomesFor(COUNCIL_SPECIMEN, [...bpOnly, draftCb]);
  // Confirms the fixture actually exercises the draft path: no outcome for it.
  assert.equal(newOutcomes.some((row) => row.disposition_id === draftCb.id), false);

  const previous = buildNextDecisionSnapshot({ summary: oldSummary, observedOutcomes: outcomesFor(COUNCIL_SPECIMEN, bpOnly) });
  const result = evaluateNextDecisionWatchFiring({
    previous,
    summary: newSummary,
    observedOutcomes: newOutcomes,
    reliability: GO_RELIABILITY,
  });
  assert.equal(result.fired, false);
  assert.equal(result.reason, "no_change");
});

test("negative rule: a meeting/hearing not tied to this project by exact identifier never fires", () => {
  const stableMilestone = "Community Board Review";
  const bpOnly = realDispositions(COUNCIL_SPECIMEN).filter((row) => row.representing === "Borough President");
  const oldSummary = summarize(COUNCIL_SPECIMEN, { milestone: stableMilestone, dispositions: bpOnly, hearingRows: [] });
  // A real hearing exists in the corpus, but for a different project id.
  const newSummary = summarize(COUNCIL_SPECIMEN, {
    milestone: stableMilestone,
    dispositions: bpOnly,
    hearingRows: [{ project_id: "2099Z9999", hearing_date: "2026-09-30", representing: "City Planning Commission" }],
  });
  assert.equal(newSummary.published_next_opportunity.status, "none");

  const previous = buildNextDecisionSnapshot({ summary: oldSummary, observedOutcomes: outcomesFor(COUNCIL_SPECIMEN, bpOnly) });
  const result = evaluateNextDecisionWatchFiring({
    previous,
    summary: newSummary,
    observedOutcomes: outcomesFor(COUNCIL_SPECIMEN, bpOnly),
    reliability: GO_RELIABILITY,
  });
  assert.equal(result.fired, false);
  assert.equal(result.reason, "no_change");
});

test("negative rule: a changed display string alone (milestone/hearing label text) never fires", () => {
  const base = {
    schema: "cityscroll.land_authority_summary.v1",
    status: "resolved",
    project_id: "2099Z0002",
    procedure_id: "ulurp_197c",
    current_stage: { stage_id: "ulurp_197c.community_board_review", spine_phase_id: "community_board", status: "known" },
    current_actor_refs: ["community-board:queens-cb-12"],
    current_role: "advisory_reviewer",
    source_basis: {
      profile: { registry_version: "2026-08-27.v1" },
      phase: { current_milestone: "Community Board Review" },
    },
    published_next_opportunity: { status: "published", source_id: "hearing-abc", label: "CB12 Public Hearing" },
    expected_next_stage: { stage_id: "ulurp_197c.borough_president_review" },
    freshness: { generated_at: "2026-08-23", as_of: "2026-08-23" },
  };
  const relabeled = {
    ...base,
    source_basis: { ...base.source_basis, phase: { current_milestone: "Community Board Review (updated wording)" } },
    published_next_opportunity: { ...base.published_next_opportunity, label: "CB12 Public Hearing — rescheduled room" },
  };

  const previous = buildNextDecisionSnapshot({ summary: base, observedOutcomes: [] });
  const result = evaluateNextDecisionWatchFiring({
    previous,
    summary: relabeled,
    observedOutcomes: [],
    reliability: GO_RELIABILITY,
  });
  assert.equal(result.fired, false);
  assert.equal(result.reason, "no_change");
});

// ---------------------------------------------------------------------------
// A4 — deduplication and snapshot vintage.
// ---------------------------------------------------------------------------

test("A4 deduplication: the same transition never fires twice, and dedupe_key is stable for the same input", () => {
  const oldSummary = summarize(COUNCIL_SPECIMEN, {
    milestone: "Community Board Review",
    dispositions: realDispositions(COUNCIL_SPECIMEN).filter((row) => row.representing === "Borough President"),
  });
  const newSummary = summarize(COUNCIL_SPECIMEN);
  const oldOutcomes = outcomesFor(COUNCIL_SPECIMEN, realDispositions(COUNCIL_SPECIMEN).filter((row) => row.representing === "Borough President"));
  const newOutcomes = outcomesFor(COUNCIL_SPECIMEN, realDispositions(COUNCIL_SPECIMEN));
  const previous = buildNextDecisionSnapshot({ summary: oldSummary, observedOutcomes: oldOutcomes });

  const firstFire = evaluateNextDecisionWatchFiring({ previous, summary: newSummary, observedOutcomes: newOutcomes, reliability: GO_RELIABILITY });
  assert.equal(firstFire.fired, true);

  // A second evaluation using the just-fired snapshot as `previous` must not
  // fire again for the identical current state.
  const secondEval = evaluateNextDecisionWatchFiring({
    previous: firstFire.snapshot,
    summary: newSummary,
    observedOutcomes: newOutcomes,
    reliability: GO_RELIABILITY,
  });
  assert.equal(secondEval.fired, false);
  assert.equal(secondEval.reason, "no_change");

  // Recomputing the same fire from scratch produces the same dedupe key.
  const recomputed = evaluateNextDecisionWatchFiring({ previous, summary: newSummary, observedOutcomes: newOutcomes, reliability: GO_RELIABILITY });
  assert.equal(recomputed.receipt.dedupe_key, firstFire.receipt.dedupe_key);
});

test("A4 snapshot vintage: the receipt and snapshot carry the summary's own freshness vintage, not wall-clock time", () => {
  const oldSummary = summarize(COUNCIL_SPECIMEN, {
    milestone: "Community Board Review",
    dispositions: realDispositions(COUNCIL_SPECIMEN).filter((row) => row.representing === "Borough President"),
    asOf: "2026-08-01",
  });
  const newSummary = summarize(COUNCIL_SPECIMEN, { asOf: "2026-08-23" });
  const previous = buildNextDecisionSnapshot({
    summary: oldSummary,
    observedOutcomes: outcomesFor(COUNCIL_SPECIMEN, realDispositions(COUNCIL_SPECIMEN).filter((row) => row.representing === "Borough President")),
  });
  const result = evaluateNextDecisionWatchFiring({
    previous,
    summary: newSummary,
    observedOutcomes: outcomesFor(COUNCIL_SPECIMEN, realDispositions(COUNCIL_SPECIMEN)),
    reliability: GO_RELIABILITY,
  });
  assert.equal(result.fired, true);
  assert.equal(result.receipt.snapshot_vintage, newSummary.freshness.generated_at || newSummary.freshness.as_of);
  assert.equal(previous.snapshot_vintage, oldSummary.freshness.generated_at || oldSummary.freshness.as_of);
  assert.notEqual(result.receipt.snapshot_vintage, previous.snapshot_vintage);
});

test("A4 the watch key carries project/action id, normalized stage, actor ref, transition version, and event id where applicable", () => {
  const summary = summarize(COUNCIL_SPECIMEN);
  const key = buildNextDecisionWatchKey({ summary, eventId: "project:2026Q0210:disposition:x" });
  assert.equal(key.project_id, "2026Q0210");
  assert.equal(key.stage_id, "ulurp_197c.city_council_review");
  assert.deepEqual(key.actor_refs, ["agency:id:city-council"]);
  assert.ok(key.transition_version);
  assert.equal(key.event_id, "project:2026Q0210:disposition:x");
  assert.ok(key.dedupe_key.includes("2026Q0210"));

  const withoutEvent = buildNextDecisionWatchKey({ summary });
  assert.equal(withoutEvent.event_id, null);
  assert.notEqual(withoutEvent.dedupe_key, key.dedupe_key);
});

// ---------------------------------------------------------------------------
// baseline behavior: subscribing never itself reads as a fired notification.
// ---------------------------------------------------------------------------

test("first evaluation (no prior snapshot) never fires — it only establishes the baseline", () => {
  const summary = summarize(COUNCIL_SPECIMEN);
  const outcomes = outcomesFor(COUNCIL_SPECIMEN, realDispositions(COUNCIL_SPECIMEN));
  const result = evaluateNextDecisionWatchFiring({ previous: null, summary, observedOutcomes: outcomes, reliability: GO_RELIABILITY });
  assert.equal(result.fired, false);
  assert.equal(result.reason, "baseline_snapshot");
  assert.equal(result.snapshot.transition_key, buildTransitionIdentity(summary).transition_key);
});
