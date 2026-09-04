/**
 * Land detail "Where this stands" authority panel (LDP-08).
 *
 *   node --test test/land_authority_panel.test.mjs
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";

import { buildLandAuthoritySummary } from "../site/land_authority_summary.mjs";
import {
  GEOGRAPHY_LEGAL_BASIS,
  landAuthorityPanelProjection,
  landAuthoritySummaryHTML,
  profileLegalBasis,
} from "../site/land_authority_summary_view.mjs";
import { reconcileDerivedArchitectureEvidence } from "../tools/architecture_evidence_shards.mjs";
import { SITE_SOURCE } from "./helpers/site_source.mjs";

const requireJson = createRequire(import.meta.url);
const gold = requireJson("./fixtures/land_authority_summary/gold.v1.json");
const geography = requireJson("../site/data/community_board_geography_lookup.json");
const warehouse = requireJson("../site/data/zap_projects_warehouse_lookup.json");
const landDefault = requireJson("../site/data/land_default_ulurp.json");
const hearings = requireJson("../site/data/land_upcoming_hearings.json");
const viewSrc = readFileSync(new URL("../site/land_authority_summary_view.mjs", import.meta.url), "utf8");
const landSrc = readFileSync(new URL("../site/app/land.mjs", import.meta.url), "utf8");

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
  land_authority_actor_short_cpc: "CPC",
  land_authority_actor_short_council: "Council",
  land_phase_cpc: "City Planning Commission",
  land_phase_city_council: "City Council review",
  land_phase_pre_application: "Pre-application and filing",
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

function render(summary) {
  return landAuthoritySummaryHTML(summary, { t, escape: (value) => String(value ?? "") });
}

test("A1 2025M0252 first-paint panel answers CPC stage, role, why, and missing published next", () => {
  const summary = summarize("2025M0252");
  const expected = gold.specimens["cpc-vs-observed-2025M0252"].expect;
  const html = render(summary);
  const projection = landAuthorityPanelProjection(summary);
  assert.equal(projection.current_stage_id, expected.current_stage_id);
  assert.equal(projection.current_role, "decision_maker");
  assert.equal(projection.why_kind, "profile");
  assert.equal(projection.published_next_status, "none");
  assert.match(html, /Where this stands/);
  assert.match(html, /data-land-authority-stand="1"/);
  assert.match(html, /At City Planning Commission · CPC's role here: decision role/);
  assert.match(html, /Why: This action and procedure profile require it/);
  assert.match(html, /data-land-authority-role="decision_maker"/);
  assert.match(html, /data-land-authority-why="1"/);
  assert.match(html, /data-land-authority-published-next="none"/);
  assert.match(html, /No published next opportunity found as of 2026-08-23/);
  assert.doesNotMatch(html, /Not found in checked materializations/);
  assert.match(html, /community-board:manhattan-cb-05/);
  assert.equal(html.includes("agency:id:city-planning-commission") && html.includes("data-land-authority-actor"), true);
  assert.doesNotMatch(html, /data-land-authority-observed="1"[^>]*data-body-ref="agency:id:city-planning-commission"/);
  // CPC is terminal (no expected next stage) -> a real project watch, not a
  // placeholder "next decision" target.
  assert.match(html, /data-land-authority-follow="1"/);
  assert.match(html, /data-project-follow="project"/);
  assert.match(html, /Follow this project/);
  assert.doesNotMatch(html, /Follow next decision/);
});

test("A1 2026Q0210 panel keeps Council role/effect separate from expected mayoral successor", () => {
  const summary = summarize("2026Q0210");
  const html = render(summary);
  assert.match(html, /At City Council review · Council's role here: conditional statutory review/);
  assert.match(html, /data-land-authority-role="conditional_decision_maker"/);
  assert.match(html, /data-land-authority-expected-next="ulurp_197c.mayoral_review"/);
  assert.match(html, /data-land-authority-published-next="none"/);
  assert.match(html, /data-land-authority-provenance="profile"[^>]*>[\s\S]*NYC Charter § 197-d/);
  const expectedDd = html.match(/data-land-authority-expected-next="ulurp_197c.mayoral_review"[^<]*/)?.[0] || "";
  const publishedDd = html.match(/data-land-authority-published-next="none"[^<]*/)?.[0] || "";
  assert.match(expectedDd, /ulurp_197c.mayoral_review/);
  assert.doesNotMatch(publishedDd, /mayoral_review/);
});

test("A2 CB and BP recommendations stay advisory; draft and milestone-only never decide", () => {
  const cpc = render(summarize("2025M0252"));
  assert.match(cpc, /data-land-authority-advisory="1"/);
  assert.match(cpc, /data-land-authority-observed-kind="advisory"/);
  assert.match(cpc, /community-board:manhattan-cb-05/);
  assert.match(cpc, /borough-president:manhattan/);

  const draft = render(summarize("2025K0305"));
  assert.match(draft, /data-land-authority-observed="draft_only"/);
  assert.match(draft, /Draft only — not an observed recommendation/);
  assert.doesNotMatch(draft, /data-land-authority-observed="1"/);
  assert.match(draft, /community-board:brooklyn-cb-11/);
  assert.match(draft, /community-board:brooklyn-cb-13/);
  assert.match(draft, /borough-board:brooklyn/);
  assert.doesNotMatch(draft, /data-land-authority-observed-kind="observed"/);

  const milestoneOnly = buildLandAuthoritySummary({
    project: {
      ...warehouseRow("2025M0252"),
      current_milestone: "MC - CPC Public Meeting - Vote",
    },
    geography,
    dispositions: [],
    publishedOpportunities: { hearings: [] },
  });
  const milestoneHtml = render(milestoneOnly);
  assert.match(milestoneHtml, /data-land-authority-stage="ulurp_197c.city_planning_commission_review"/);
  assert.doesNotMatch(milestoneHtml, /data-land-authority-observed="1"/);
  assert.doesNotMatch(milestoneHtml, /CPC Public Meeting - Vote[^<]*(approved|recommended|decided)/i);

  const meetingOnly = landAuthoritySummaryHTML({
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
  }, { t, escape: (value) => String(value ?? "") });
  assert.match(meetingOnly, /data-land-authority-observed="no_observation"/);
  assert.doesNotMatch(meetingOnly, /data-land-authority-observed="1"/);
  assert.doesNotMatch(meetingOnly, /decided this project/i);
});

test("A3 provenance DOM keeps profile, phase, geography, and published opportunity distinct", () => {
  const summary = summarize("2025K0305");
  const html = render(summary);
  const citation = profileLegalBasis(summary);
  assert.equal(citation.procedure_id, "ulurp_197c");
  assert.equal(citation.stage_id, "ulurp_197c.application_certification");
  assert.match(citation.citation, /NYC Charter/);
  assert.match(html, /data-land-authority-provenance="profile"/);
  assert.match(html, /data-land-authority-provenance="phase"/);
  assert.match(html, /data-land-authority-provenance="geography"/);
  assert.match(html, /data-land-authority-provenance="publisher"/);
  assert.match(html, /data-registry-version="2026-08-27\.v1"/);
  assert.match(html, /data-source-field="current_milestone"/);
  assert.match(html, /MM - Review Filed Land Use Application/);
  assert.match(html, /data-source-type="affected_review_body_for"/);
  assert.match(html, new RegExp(GEOGRAPHY_LEGAL_BASIS.citation.replace("§", "§")));
  assert.match(html, /data-land-authority-published-next="published"/);
  assert.match(html, /data-source-id="7cfc36ab-cecd-ef11-b8e9-001dd809b68c"/);
  assert.match(html, /Review Session - Pre-Hearing Review \/ Post Referral \(2026-11-30\)/);
  const profileItems = html.match(/data-land-authority-provenance="profile"/g) || [];
  const phaseItems = html.match(/data-land-authority-provenance="phase"/g) || [];
  const geoItems = html.match(/data-land-authority-provenance="geography"/g) || [];
  const pubItems = html.match(/data-land-authority-provenance="publisher"/g) || [];
  assert.ok(profileItems.length >= 2);
  assert.ok(phaseItems.length >= 2);
  assert.ok(geoItems.length >= 2);
  assert.ok(pubItems.length >= 2);
});

test("A4 unknown copy, no publisher fetch, and legacy Land detail seams stay intact", () => {
  const unknown = render(summarize("2026K0123"));
  assert.match(unknown, /Where this stands is unknown/);
  assert.match(unknown, /The procedure is not resolved from retained project facts/);
  assert.match(unknown, /data-status="unknown"/);
  assert.match(unknown, /The procedure is not resolved from retained project facts/);
  // 2026K0123 has a real published next opportunity even though its
  // procedure is unresolved — "unchecked" and "not found" never coexist.
  assert.match(unknown, /data-land-authority-published-next="published"/);
  assert.doesNotMatch(unknown, /land_authority_provenance_publisher: Not found in checked materializations/);

  assert.equal(/zap-api-production|hgx4-8ukb|socrata/i.test(viewSrc), false);
  assert.doesNotMatch(viewSrc, /openai|anthropic|generateContent|chat\.completions/i);
  assert.match(viewSrc, /data\/land_authority_summary\.json/);
  assert.match(landSrc, /authHTML\(r\.authority_summary/);
  assert.match(landSrc, /id="land-brief"/);
  assert.match(landSrc, /id="land-actions"/);
  assert.match(landSrc, /id="project-connections"/);
  assert.match(landSrc, /id="land-outcomes"/);
  assert.match(landSrc, /projectCalendarActions\(\{projectId:r\.project_id\}\)/);
  assert.match(SITE_SOURCE, /authHTML\(|landAuthoritySummaryHTML\(/);
  assert.match(SITE_SOURCE, /id="land-brief"[\s\S]*authHTML\(/);

  const result = reconcileDerivedArchitectureEvidence();
  assert.equal(result.status, "PASS", result.findings.join("; "));
  assert.equal(
    result.evidence.projections["site/land_authority_summary_view.mjs"].represented_card_ids.includes(
      "cityscroll-land-decision-path/ldp-08-land-detail-authority-panel",
    ),
    true,
  );
});
