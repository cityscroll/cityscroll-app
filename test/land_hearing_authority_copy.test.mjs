/**
 * PHC-06 — plain-language body-role statement in the Land "Where this
 * stands" authority panel and the compressed upcoming-hearing row.
 *
 *   node --test test/land_hearing_authority_copy.test.mjs
 */
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";

import { buildLandAuthoritySummary } from "../site/land_authority_summary.mjs";
import {
  landAuthoritySummaryFor,
  landAuthoritySummaryHTML,
  rememberLandAuthoritySummaries,
} from "../site/land_authority_summary_view.mjs";
import {
  LAND_AUTHORITY_PLAIN_ROLE_LABEL_KEY,
  LAND_HEARING_ROW_ROLE_LABEL_KEY,
  landAuthorityPlainRoleHTML,
  landAuthorityPlainRoleKey,
  landHearingRowRoleHTML,
  landHearingRowRoleKey,
} from "../site/land_hearing_authority_copy.mjs";

const requireJson = createRequire(import.meta.url);
const gold = requireJson("./fixtures/land_authority_summary/gold.v1.json");
const elurpCorpus = requireJson("./fixtures/land_authority_summary/elurp_197e_corpus.v1.json");
const geography = requireJson("../site/data/community_board_geography_lookup.json");
const warehouse = requireJson("../site/data/zap_projects_warehouse_lookup.json");
const landDefault = requireJson("../site/data/land_default_ulurp.json");
const hearings = requireJson("../site/data/land_upcoming_hearings.json");

const COPY = {
  land_authority_heading: "Where this stands",
  land_authority_stand: "At {stage} · {actor}'s role here: {role} · Why: {why}",
  land_authority_stand_unknown: "Where this stands is unknown",
  land_authority_role_here_decision_maker: "decision role",
  land_authority_role_here_conditional_decision_maker: "conditional statutory review",
  land_authority_role_here_administrative_certifier: "administrative certification",
  land_authority_role_here_advisory_reviewer: "advisory review",
  land_authority_why_profile: "This action and procedure profile require it",
  land_authority_why_community_board: "Published community districts for this project are covered by that board",
  land_authority_why_borough_board: "Two or more community districts in the same borough are affected",
  land_authority_not_found: "Not found in checked materializations",
  land_authority_why_unknown: "Unknown — the current stage does not resolve from available evidence",
  land_authority_opportunity_none: "No published next opportunity found as of {date}",
  land_authority_opportunity_unknown: "Upcoming-opportunity source not checked",
  land_authority_opportunity_stale: "Opportunity information is stale as of {date}",
  land_authority_advisory: "Advisory",
  land_authority_follow_next: "Follow next decision",
  next_action_watch_project: "Follow this project",
  land_authority_add_calendar: "Add to calendar",
  land_authority_draft_only: "Draft only — not an observed recommendation",
  land_authority_reason_unresolved_procedure: "The procedure is not resolved from retained project facts",
  land_authority_reason_unresolved_current_stage: "The current milestone does not match a reviewed profile stage",
  land_authority_actor_short_cpc: "CPC",
  land_authority_actor_short_council: "Council",
  land_phase_cpc: "City Planning Commission",
  land_phase_city_council: "City Council review",
  land_phase_pre_application: "Pre-application and filing",
  land_authority_plain_role_advisory_reviewer: "Can recommend, but cannot decide",
  land_authority_plain_role_decision_maker: "Can decide",
  land_authority_plain_role_conditional_decision_maker: "Can decide, conditioned on another body's action",
  land_authority_plain_role_administrative_certifier: "Certifies the filing is complete, but does not decide it",
  land_authority_plain_role_executive_review: "Can object where the Charter provides, but does not decide it",
  land_authority_plain_role_plan_proposer: "Can propose a plan, but does not decide it",
  land_hearing_row_role_advisory_reviewer: "Recommends, doesn't decide",
  land_hearing_row_role_decision_maker: "Decides",
  land_hearing_row_role_conditional_decision_maker: "Decides, conditionally",
  land_hearing_row_role_administrative_certifier: "Certifies only",
  land_hearing_row_role_executive_review: "Can object only",
  land_hearing_row_role_plan_proposer: "Proposes only",
};

function t(key, vars) {
  let text = COPY[key] || key;
  if (vars) {
    text = text.replace(/\{(\w+)\}/g, (match, name) => (
      Object.hasOwn(vars, name) ? String(vars[name] ?? "") : match
    ));
  }
  return text;
}

const escape = (value) => String(value ?? "");

function warehouseRow(projectId) {
  return (warehouse.rows || []).find((row) => row.project_id === projectId);
}

function defaultRow(projectId) {
  return (landDefault.projects || []).find((row) => row.project_id === projectId);
}

function projectHearings(projectId) {
  return (hearings.hearings || []).filter((row) => row.project_id === projectId);
}

function summarize(projectId, overrides = {}) {
  const project = defaultRow(projectId) || warehouseRow(projectId);
  const outcome = landDefault.outcomes?.by_project?.[projectId] || {};
  return buildLandAuthoritySummary({
    project,
    geography,
    outcomes: {
      dispositions: outcome.dispositions,
      generated_at: outcome.generated_at || landDefault.generated_at,
    },
    publishedOpportunities: {
      hearings: projectHearings(projectId),
      generated_at: hearings.generated_at,
    },
    asOf: landDefault.generated_at,
    generatedAt: landDefault.generated_at,
    ...overrides,
  });
}

function elurpProjectFixture(shortId) {
  return requireJson(`./fixtures/land_phase_spine/${shortId}.json`);
}

function summarizeElurp(specimenKey, overrides = {}) {
  const specimen = elurpCorpus.specimens[specimenKey];
  const project = elurpProjectFixture(specimen.project_id);
  return buildLandAuthoritySummary({
    ...project,
    geography,
    asOf: elurpCorpus.as_of,
    generatedAt: elurpCorpus.as_of,
    ...overrides,
  });
}

function render(summary) {
  return landAuthoritySummaryHTML(summary, { t, escape });
}

test("A1/A2 2025M0252 CPC decision role renders in plain terms while CB/BP advisory recommendations stay visible and separate", () => {
  const summary = summarize("2025M0252");
  const expected = gold.specimens["cpc-vs-observed-2025M0252"].expect;
  assert.equal(summary.current_role, "decision_maker");
  const html = render(summary);
  assert.match(html, /data-land-authority-plain-role="decision_maker"[^>]*>Can decide</);
  assert.match(html, /data-land-authority-stand="1"/);
  // The plain-role line is additive, sited once inside the existing panel —
  // never a second explainer alongside it.
  assert.equal((html.match(/data-land-authority-plain-role=/g) || []).length, 1);
  assert.equal((html.match(/<section/g) || []).length, 1);
  // Prior CB/BP advisory recommendations remain visible as separate events,
  // each still marked advisory, regardless of the current decision role.
  assert.match(html, /data-land-authority-observed-kind="advisory"/);
  assert.match(html, /community-board:manhattan-cb-05/);
  assert.match(html, /borough-president:manhattan/);
  assert.equal(expected.current_role, "decision_maker");
});

test("A1/A2 2026Q0210 conditional decision-maker renders its own plain role, never the plain 'Can decide' of an unconditional decider", () => {
  const summary = summarize("2026Q0210");
  assert.equal(summary.current_role, "conditional_decision_maker");
  const html = render(summary);
  assert.match(html, /data-land-authority-plain-role="conditional_decision_maker"[^>]*>Can decide, conditioned on another body's action</);
  assert.doesNotMatch(html, />Can decide</);
});

test("A2 an advisory-only body is never described as the final decider", () => {
  const meetingOnly = {
    schema: "cityscroll.land_authority_summary.v1",
    status: "resolved",
    project_id: "MEETINGONLY",
    procedure_id: "ulurp_197c",
    current_stage: { stage_id: "ulurp_197c.community_board_review", spine_phase_id: "community_board", status: "known" },
    current_actor_refs: ["community-board:brooklyn-cb-11"],
    current_role: "advisory_reviewer",
    effect: "May hold a public hearing and submit a written recommendation; the recommendation is advisory, not binding.",
    source_basis: {
      profile: { source_type: "reviewed_static_registry", procedure_id: "ulurp_197c", stage_id: "ulurp_197c.community_board_review", registry_version: "2026-08-27.v1" },
      phase: { source_type: "publisher_current_milestone", source_field: "current_milestone", current_milestone: "Community Board hearing" },
      geography: { source_type: "affected_review_body_for", status: "resolved" },
      publisher: { source_type: "published_hearing", checked: true },
    },
    expected_next_stage: { stage_id: "ulurp_197c.borough_president_review", spine_phase_id: "borough_president", status: "known" },
    published_next_opportunity: { status: "none" },
    observed: { status: "no_observation", recommendations: [] },
    affected_actor_refs: [{ body_ref: "community-board:brooklyn-cb-11", role: "affected_community_board" }],
  };
  const html = render(meetingOnly);
  assert.match(html, /data-land-authority-plain-role="advisory_reviewer"[^>]*>Can recommend, but cannot decide</);
  assert.doesNotMatch(html, />Can decide</i);
  assert.doesNotMatch(html, /final decider/i);
  assert.equal(landHearingRowRoleKey(meetingOnly), "land_hearing_row_role_advisory_reviewer");
  assert.equal(landHearingRowRoleHTML(meetingOnly, { t, escape }), '<span class="land-hearing-row-role" data-land-hearing-row-role="advisory_reviewer">Recommends, doesn\'t decide</span>');
});

test("A3 2024Q0356 (E1) pre-application/certification stage never acquires a public-review vote", () => {
  const expected = elurpCorpus.specimens["E1-2024Q0356"].expect;
  const summary = summarizeElurp("E1-2024Q0356");
  assert.equal(summary.current_role, expected.current_role);
  assert.equal(summary.current_role, "administrative_certifier");
  const html = render(summary);
  assert.match(html, /data-land-authority-plain-role="administrative_certifier"[^>]*>Certifies the filing is complete, but does not decide it</);
  assert.doesNotMatch(html, /public.review vote/i);
  assert.doesNotMatch(html, /\bvote\b/i);
  assert.equal(landHearingRowRoleKey(summary), "land_hearing_row_role_administrative_certifier");
  assert.match(landHearingRowRoleHTML(summary, { t, escape }), /Certifies only/);
});

test("A4 2024Q0419 and 2025R0257 (E2/E3) expedited terminal-at-CPC role reads plainly without inventing an ordinary-route Council stage", () => {
  for (const [key] of [["E2-2024Q0419"], ["E3-2025R0257"]]) {
    const expected = elurpCorpus.specimens[key].expect;
    const summary = summarizeElurp(key);
    assert.equal(summary.procedure_id, "elurp_197e");
    assert.equal(summary.current_role, expected.current_role);
    assert.equal(summary.current_role, "decision_maker");
    assert.equal(summary.expected_next_stage, expected.expected_next_stage_id);
    const html = render(summary);
    assert.match(html, /data-land-authority-plain-role="decision_maker"[^>]*>Can decide</);
    // The expedited path terminates at CPC; this role statement never implies
    // an ordinary-route Council stage that this record's own profile omits.
    assert.doesNotMatch(html, /city council/i);
  }
});

test("A5/A6 2026X0362 (E4) unresolved current stage shows an honest gap: no plain role, no invented disposition", () => {
  const expected = elurpCorpus.specimens["E4-2026X0362"].expect;
  const summary = summarizeElurp("E4-2026X0362");
  assert.equal(summary.status, expected.status);
  assert.equal(summary.current_role, null);
  assert.equal(landAuthorityPlainRoleKey(summary), null);
  assert.equal(landAuthorityPlainRoleHTML(summary, { t, escape }), "");
  assert.equal(landHearingRowRoleKey(summary), null);
  assert.equal(landHearingRowRoleHTML(summary, { t, escape }), "");
  const html = render(summary);
  assert.doesNotMatch(html, /data-land-authority-plain-role/);
  assert.doesNotMatch(html, /Can decide|Can recommend|Certifies|Can object|Can propose/);
});

test("A6 a hearing row referencing a project with no attached or looked-up authority summary shows no recommendation or decision", () => {
  rememberLandAuthoritySummaries({ summaries: {} });
  const orphanRow = { project_id: "NO-SUMMARY-ATTACHED" };
  assert.equal(landAuthoritySummaryFor(orphanRow), null);
  assert.equal(landHearingRowRoleHTML(landAuthoritySummaryFor(orphanRow), { t, escape }), "");
});

test("A7 existing follow, calendar, source, and observed-recommendation affordances remain intact beside the new plain-role line", () => {
  const html = render(summarize("2025M0252"));
  assert.match(html, /data-land-authority-follow="1"/);
  assert.match(html, /data-project-follow="project"/);
  assert.match(html, /Follow this project/);
  assert.match(html, /data-land-authority-sources="1"/);
  assert.match(html, /data-land-authority-provenance="profile"/);
  assert.match(html, /data-land-authority-provenance="geography"/);
  assert.match(html, /data-land-authority-observed="1"/);
});

test("Negative rule: an unresolved role never renders any plain-role text, on the panel or the compressed row", () => {
  const unknown = summarize("2026K0123");
  assert.equal(unknown.status, "unknown");
  assert.equal(landAuthorityPlainRoleKey(unknown), null);
  assert.equal(landHearingRowRoleKey(unknown), null);
  const html = render(unknown);
  assert.match(html, /Where this stands is unknown/);
  assert.doesNotMatch(html, /data-land-authority-plain-role/);
});

test("Vocabulary: every mapped current_role has both a panel key and a distinct compressed row key", () => {
  const roles = Object.keys(LAND_AUTHORITY_PLAIN_ROLE_LABEL_KEY);
  assert.deepEqual(roles.sort(), Object.keys(LAND_HEARING_ROW_ROLE_LABEL_KEY).sort());
  for (const role of roles) {
    assert.notEqual(
      COPY[LAND_AUTHORITY_PLAIN_ROLE_LABEL_KEY[role]],
      COPY[LAND_HEARING_ROW_ROLE_LABEL_KEY[role]],
      `${role}: the compressed row label should read differently from the full panel sentence`,
    );
  }
});
