/**
 * Bounded Land authority summary.
 *
 *   node --test test/land_authority_summary.test.mjs
 */
import assert from "node:assert/strict";
import { readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";

import { LAND_PROCEDURE_PROFILE_REGISTRY_VERSION } from "../site/land_procedure_profiles.mjs";
import { buildLandPhaseView } from "../site/land_phase_spine.mjs";
import { resolveLandActionProcedures } from "../site/land_action_procedure_resolution.mjs";
import { buildUlurpStatutoryClockView } from "../site/ulurp_statutory_clock.mjs";
import {
  LAND_AUTHORITY_SUMMARY_JOIN_VERSION,
  LAND_AUTHORITY_SUMMARY_MAX_BYTES,
  LAND_AUTHORITY_SUMMARY_RECEIPT_SCHEMA,
  LAND_AUTHORITY_SUMMARY_SCHEMA,
  LAND_AUTHORITY_SUMMARY_SPECIMENS,
  assertLandAuthoritySummaries,
  buildLandAuthoritySummary,
  materializeLandAuthoritySummaries,
  stampLandAuthoritySummary,
} from "../site/land_authority_summary.mjs";
import {
  landAuthoritySummaryHTML,
  landAuthorityPanelProjection,
  rememberLandAuthoritySummaries,
} from "../site/land_authority_summary_view.mjs";
import { rowToSodaShape } from "../warehouse/lib/zap_lookup.mjs";
import { shapeZapLookupRow } from "../worker/src/lib/zap_projects_lookup_kv.mjs";
import {
  PAYLOAD_JSON,
  RECEIPT_JSON,
  buildLandAuthoritySummaryFromRepo,
} from "../tools/build_land_authority_summary.mjs";
import { reconcileDerivedArchitectureEvidence } from "../tools/architecture_evidence_shards.mjs";
import { SITE_SOURCE } from "./helpers/site_source.mjs";

const requireJson = createRequire(import.meta.url);
const gold = requireJson("./fixtures/land_authority_summary/gold.v1.json");
const elurpCorpus = requireJson("./fixtures/land_authority_summary/elurp_197e_corpus.v1.json");
const geography = requireJson("../site/data/community_board_geography_lookup.json");
const warehouse = requireJson("../site/data/zap_projects_warehouse_lookup.json");
const landDefault = requireJson("../site/data/land_default_ulurp.json");
const hearings = requireJson("../site/data/land_upcoming_hearings.json");
// LDP-16: "Follow next decision" gates on the corpus-wide reliability
// measurement, which in turn depends on a loaded authority-summary corpus.
// Load the real committed corpus once, matching how site/app/land.mjs loads
// it before rendering any panel, so this file's affordance assertions
// measure the actual materialized reliability rather than an empty corpus.
rememberLandAuthoritySummaries(requireJson("../site/data/land_authority_summary.json"));
const materializerSrc = readFileSync(new URL("../site/land_authority_summary.mjs", import.meta.url), "utf8");
const builderSrc = readFileSync(new URL("../tools/build_land_authority_summary.mjs", import.meta.url), "utf8");
const viewSrc = readFileSync(new URL("../site/land_authority_summary_view.mjs", import.meta.url), "utf8");

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

function affectedRefs(summary) {
  return (summary.affected_actor_refs || []).map((row) => row.body_ref);
}

test("A1 2026Q0210 first paint keeps Council, CB12 observation, and published next separate", () => {
  const summary = summarize("2026Q0210");
  const expected = gold.specimens["council-2026Q0210"].expect;
  assert.equal(summary.schema, LAND_AUTHORITY_SUMMARY_SCHEMA);
  assert.equal(summary.status, expected.status);
  assert.equal(summary.procedure_id, expected.procedure_id);
  assert.equal(summary.procedure_resolution, expected.procedure_resolution);
  assert.equal(summary.current_stage.stage_id, expected.current_stage_id);
  assert.equal(summary.current_stage.spine_phase_id, expected.current_phase_id);
  assert.deepEqual(summary.current_actor_refs, expected.current_actor_refs);
  assert.equal(summary.current_role, expected.current_role);
  assert.match(summary.effect, /approve|disapprove/i);
  assert.equal(summary.source_basis.profile.registry_version, LAND_PROCEDURE_PROFILE_REGISTRY_VERSION);
  assert.equal(summary.source_basis.phase.source_field, "current_milestone");
  assert.equal(summary.source_basis.geography.source_type, "affected_review_body_for");
  assert.ok(affectedRefs(summary).includes(expected.observed_cb));
  const observed = summary.observed.recommendations.find((row) => row.body_ref === expected.observed_cb);
  assert.equal(observed.value, expected.observed_value);
  assert.equal(observed.votes_for, 29);
  assert.equal(observed.votes_against, 1);
  assert.equal(summary.published_next_opportunity.status, expected.published_next_status);
  assert.equal(summary.next_procedural_body, null);
  assert.equal(summary.expected_next_stage.stage_id, "ulurp_197c.mayoral_review");
  assert.notEqual(summary.expected_next_stage?.stage_id, summary.published_next_opportunity?.source_id);

  const html = landAuthoritySummaryHTML(summary, { t: (key) => key, escape: (value) => String(value ?? "") });
  assert.match(html, /data-land-authority-summary-first-paint="1"/);
  assert.match(html, /data-land-authority-stage="ulurp_197c.city_council_review"/);
  assert.match(html, /data-land-authority-role="conditional_decision_maker"/);
  assert.match(html, /data-land-authority-effect="1"/);
  assert.match(html, /data-land-authority-expected-next="ulurp_197c.mayoral_review"/);
  assert.match(html, /data-land-authority-published-next="none"/);
  assert.match(html, /community-board:queens-cb-12/);
  assert.match(html, /Favorable/);
});

test("A1 2025K0305 keeps multi-CD bodies, draft-only observation, and source-explicit CPC next", () => {
  const summary = summarize("2025K0305");
  const expected = gold.specimens["multi-cd-draft-2025K0305"].expect;
  assert.equal(summary.status, expected.status);
  assert.equal(summary.current_stage.stage_id, expected.current_stage_id);
  assert.equal(summary.current_role, expected.current_role);
  assert.deepEqual(affectedRefs(summary), expected.affected_body_refs);
  assert.equal(summary.observed.status, expected.observed_status);
  assert.equal(summary.observed.recommendations.length, 0);
  assert.equal(summary.expected_next_stage.stage_id, expected.expected_next_stage_id);
  assert.equal(summary.published_next_opportunity.status, expected.published_next_status);
  assert.equal(summary.published_next_opportunity.body_ref, expected.published_next_body);
  assert.equal(summary.next_procedural_body.body_ref, expected.published_next_body);
  assert.ok(summary.next_procedural_body.source_id);
  assert.notEqual(summary.next_procedural_body.body_ref, "community-board:brooklyn-cb-11");
  assert.notEqual(
    summary.published_next_opportunity.source_id,
    summary.expected_next_stage.stage_id,
    "published next stays source-explicit and is not the profile successor",
  );
});

test("A1 2025M0252 keeps CPC current-stage interpretation off observed CB5/BP outcomes", () => {
  const summary = summarize("2025M0252");
  const expected = gold.specimens["cpc-vs-observed-2025M0252"].expect;
  assert.equal(summary.current_stage.stage_id, expected.current_stage_id);
  assert.deepEqual(summary.current_actor_refs, expected.current_actor_refs);
  assert.equal(summary.current_role, expected.current_role);
  assert.equal(summary.current_actor_refs.includes("community-board:manhattan-cb-05"), false);
  assert.equal(summary.current_actor_refs.includes("borough-president:manhattan"), false);
  const observedRefs = summary.observed.recommendations.map((row) => row.body_ref);
  assert.ok(observedRefs.includes("community-board:manhattan-cb-05"));
  assert.ok(observedRefs.includes("borough-president:manhattan"));
  assert.equal(summary.expected_next_stage, null);
});

test("A2 mixed, unknown, draft-only, stale, and unresolved stay explicit", () => {
  const mixed = summarize("2024M0244");
  assert.equal(mixed.status, "unknown");
  assert.equal(mixed.reason, "mixed_procedure");
  assert.equal(mixed.current_role, null);
  assert.equal(mixed.effect, null);
  assert.equal(mixed.current_stage.spine_phase_id, "cpc");

  const unknown = summarize("2026K0123");
  assert.equal(unknown.status, "unknown");
  assert.equal(unknown.reason, "unresolved_procedure");

  const missingStage = buildLandAuthoritySummary({
    project: { ...warehouseRow("2025K0305"), current_milestone: null },
    geography,
  });
  assert.equal(missingStage.status, "unknown");
  assert.equal(missingStage.reason, "missing_current_stage");

  const stale = summarize("2026Q0210", { stale: true });
  assert.equal(stale.status, "unknown");
  assert.equal(stale.reason, "stale_source");
  assert.equal(stale.freshness.stale, true);

  const titleOnly = buildLandAuthoritySummary({
    project: {
      project_id: "TITLEONLY",
      project_name: "Community Board 12 mapping",
      current_milestone: "Community Board Review",
    },
    geography,
  });
  assert.equal(titleOnly.status, "unknown");
});

test("A3 provenance distinguishes profile, phase, geography, and publisher sources", () => {
  const summary = summarize("2026Q0210");
  assert.equal(summary.source_basis.profile.source_type, "reviewed_static_registry");
  assert.equal(summary.source_basis.profile.effect_source, "reviewed_static_registry");
  assert.equal(summary.source_basis.phase.source_type, "publisher_current_milestone");
  assert.equal(summary.source_basis.geography.source_type, "affected_review_body_for");
  assert.equal(summary.source_basis.publisher.source_type, "published_hearing");
  assert.equal(summary.source_basis.publisher.checked, true);
});

test("A4 materializer is bounded, fetch-free, and settles inside the first-paint budget", () => {
  for (const src of [materializerSrc, builderSrc]) {
    assert.equal(/\bfetch\s*\(/.test(src), false);
    assert.equal(/zap-api-production|hgx4-8ukb|socrata/i.test(src), false);
  }
  assert.equal(/zap-api-production|hgx4-8ukb/i.test(viewSrc), false);
  assert.match(viewSrc, /data\/land_authority_summary\.json/);
  const built = buildLandAuthoritySummaryFromRepo();
  const payload = JSON.parse(readFileSync(new URL(`../${PAYLOAD_JSON}`, import.meta.url), "utf8"));
  const receipt = JSON.parse(readFileSync(new URL(`../${RECEIPT_JSON}`, import.meta.url), "utf8"));
  assert.deepEqual(built.payload, payload);
  assert.deepEqual(built.receipt, receipt);
  assertLandAuthoritySummaries(payload, receipt, { payloadBytes: receipt.generation.payload_bytes });
  assert.equal(payload.schema, LAND_AUTHORITY_SUMMARY_SCHEMA);
  assert.equal(receipt.schema, LAND_AUTHORITY_SUMMARY_RECEIPT_SCHEMA);
  assert.equal(receipt.join_version, LAND_AUTHORITY_SUMMARY_JOIN_VERSION);
  assert.equal(receipt.counts.universe, 40);
  assert.equal(Buffer.byteLength(JSON.stringify(payload)) < LAND_AUTHORITY_SUMMARY_MAX_BYTES, true);
  assert.ok(payload.summaries[LAND_AUTHORITY_SUMMARY_SPECIMENS.council]);
  assert.match(SITE_SOURCE, /authHTML\(|landAuthoritySummaryHTML\(/);
  assert.doesNotMatch(SITE_SOURCE, /zap-api-production\.herokuapp\.com\/projects/);
});

test("A4 stamping is additive and existing land row/phase/outcome contracts stay intact", () => {
  const original = warehouseRow("2025K0305");
  const shaped = rowToSodaShape({ ...original }, { asOf: "2026-08-30T00:00:00.000Z" });
  assert.equal(shaped.actions, original.actions);
  assert.equal(shaped.procedure_resolution, "uniform");
  assert.equal(shaped.affected_review_bodies.borough_board, true);
  assert.equal(shaped.authority_summary.procedure_id, "ulurp_197c");
  assert.equal(shaped.authority_summary.published_next_opportunity.status, "unknown");

  const workerShaped = shapeZapLookupRow({ ...original }, { asOf: "2026-08-30T00:00:00.000Z" });
  assert.equal(workerShaped.authority_summary.current_stage.spine_phase_id, "pre_application");

  const stamped = stampLandAuthoritySummary({ ...original }, { geography });
  assert.equal(stamped.actions, original.actions);
  assert.equal(stamped.community_district, original.community_district);

  const view = buildLandPhaseView({
    schema_version: 1,
    project_id: "2025M0252",
    events: [{
      id: "obs-cpc",
      kind: "zap_milestone",
      title: "CPC Public Meeting - Vote",
      time: { value: "2026-06-30", certainty: "actual" },
      source: { id: "zap", url: "https://zap.planning.nyc.gov/projects/2025M0252" },
    }],
  }, { open_data: warehouseRow("2025M0252"), geography });
  assert.equal(view.current.phase_id, "cpc");
  assert.equal(view.procedure_resolution, "uniform");
  assert.equal(view.affected_review_bodies.borough_board, false);
});

test("architecture-evidence projections reconcile the materializer card", () => {
  const result = reconcileDerivedArchitectureEvidence();
  assert.equal(result.status, "PASS", result.findings.join("; "));
  assert.equal(
    result.evidence.projections["site/data/land_authority_summary.json"].represented_card_ids.includes(
      "cityscroll-land-decision-path/ldp-05-authority-summary-materializer",
    ),
    true,
  );
});

test("fixture materializer does not copy expected next into next_procedural_body", () => {
  const { payload } = materializeLandAuthoritySummaries({
    landDefault: {
      generated_at: "2026-08-23T00:00:00.000Z",
      projects: [defaultRow("2025K0305")],
      outcomes: { by_project: { "2025K0305": landDefault.outcomes.by_project["2025K0305"] } },
    },
    geography,
    publishedOpportunities: hearings,
    artifactHashes: { land_default: "a".repeat(64), geography: "b".repeat(64), upcoming_hearings: "c".repeat(64) },
  });
  const summary = payload.summaries["2025K0305"];
  assert.equal(summary.expected_next_stage.stage_id, "ulurp_197c.community_board_review");
  assert.equal(summary.next_procedural_body.body_ref, "agency:id:city-planning-commission");
  assert.ok(statSync(new URL("../site/land_authority_summary.mjs", import.meta.url)).size > 0);
});

// ---------------------------------------------------------------------------
// LDP-32: authority evidence-state and affordance gating over the real ELURP
// regression corpus (E1-E4). Project fixtures are LDP-31's own phase-spine
// specimens (they already carry the exact ZAP API vs. Open Data evidence
// this resolver needs) — reused here rather than duplicated.
// ---------------------------------------------------------------------------

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

test("LDP-32 A1/A2 2024Q0356 (E1) renders DCP certification stage with a parallel CB/BP expected transition", () => {
  const expected = elurpCorpus.specimens["E1-2024Q0356"].expect;
  const summary = summarizeElurp("E1-2024Q0356");
  assert.equal(summary.status, expected.status);
  assert.equal(summary.procedure_id, expected.procedure_id);
  assert.equal(summary.procedure_resolution, expected.procedure_resolution);
  assert.equal(summary.current_stage.stage_id, expected.current_stage_id);
  assert.equal(summary.current_stage.spine_phase_id, expected.current_phase_id);
  assert.equal(summary.current_role, expected.current_role);
  assert.deepEqual(summary.current_actor_refs, expected.current_actor_refs);
  assert.match(summary.effect, /certifies.*complete/i);
  // The two distinct observed phases the corpus calls for: the CEQR-track
  // milestone mapping (environmental) and the review-track authority phase
  // (pre_application) that DCP still holds because no certification/local
  // review has started.
  assert.equal(summary.source_basis.phase.milestone_phase_id, expected.milestone_phase_id);
  assert.equal(summary.source_basis.phase.phase_id, expected.current_phase_id);
  assert.equal(summary.expected_next_stage.group_id, expected.expected_next_group_id);
  assert.deepEqual(summary.expected_next_stage.stage_ids, expected.expected_next_stage_ids);
  assert.equal(summary.next_procedural_body, null);

  const resolution = resolveLandActionProcedures(elurpProjectFixture("2024Q0356"));
  assert.equal(resolution.land_actions[0].application_id, expected.canonical_application_id);
  assert.equal(resolution.land_actions[0].action_type, expected.action_type);

  const html = landAuthoritySummaryHTML(summary, { t: (key) => key, escape: (value) => String(value ?? "") });
  assert.doesNotMatch(html, /formal ULURP/i);
  assert.doesNotMatch(html, /not found in checked materializations/i);
});

for (const [key, id] of [["E2-2024Q0419", "2024Q0419"], ["E3-2025R0257", "2025R0257"]]) {
  test(`LDP-32 A1 ${id} keeps the C-prefixed exact identifier, retains the Open Data alias, and terminates at CPC`, () => {
    const expected = elurpCorpus.specimens[key].expect;
    const summary = summarizeElurp(key);
    assert.equal(summary.status, expected.status);
    assert.equal(summary.procedure_id, expected.procedure_id);
    assert.equal(summary.procedure_resolution, expected.procedure_resolution);
    assert.equal(summary.current_stage.stage_id, expected.current_stage_id);
    assert.equal(summary.current_stage.spine_phase_id, expected.current_phase_id);
    assert.equal(summary.current_role, expected.current_role);
    assert.deepEqual(summary.current_actor_refs, expected.current_actor_refs);
    assert.equal(summary.expected_next_stage, expected.expected_next_stage_id);

    const resolution = resolveLandActionProcedures(elurpProjectFixture(id));
    const action = resolution.land_actions[0];
    assert.equal(action.action_type, expected.action_type);
    assert.equal(action.application_id, expected.canonical_application_id, "the C-prefix never converts this to ordinary ULURP");
    assert.equal(action.procedure_id, "elurp_197e");
    assert.equal(action.aliases[0].application_id, expected.open_data_alias, "the narrower Open Data id is retained as a provenance-tagged alias, not discarded");

    const clock = buildUlurpStatutoryClockView({ ...elurpProjectFixture(id).open_data, ulurp_non: "ELURP" });
    assert.equal(clock.status, "ineligible");
    assert.equal(clock.reason, "wrong_procedure");
  });
}

test("LDP-32 A8 2026X0362 (E4) exposes the observed Council path without inferring the §197-e(k) variant", () => {
  const expected = elurpCorpus.specimens["E4-2026X0362"].expect;
  const project = elurpProjectFixture("2026X0362");
  const summary = summarizeElurp("E4-2026X0362");
  // The broad procedure and canonical application id are source-observed and
  // uniform; nothing here selects the agency housing variant.
  assert.equal(summary.procedure_id, expected.procedure_id);
  assert.equal(summary.procedure_resolution, expected.procedure_resolution);
  assert.notEqual(summary.procedure_id, "elurp_197e_k");
  // The broad § 197-e profile has no city_council stage — a Council-terminal
  // observed outcome under an unresolved variant honestly stays unknown
  // rather than manufacturing a certification or CPC stage for it.
  assert.equal(summary.status, expected.status);
  assert.equal(summary.reason, expected.reason);
  assert.equal(summary.current_stage.stage_id, expected.current_stage_id);
  assert.equal(summary.current_stage.spine_phase_id, expected.observed_current_phase_id);
  assert.equal(summary.current_role, null);
  assert.equal(summary.effect, null);

  const resolution = resolveLandActionProcedures(project);
  assert.equal(resolution.land_actions[0].application_id, expected.canonical_application_id);
  assert.equal(resolution.land_actions[0].action_type, expected.action_type);

  const html = landAuthoritySummaryHTML(summary, { t: (key) => key, escape: (value) => String(value ?? "") });
  assert.doesNotMatch(html, /city planning commission/i, "no synthetic CPC stage for an observed Council-only route");
});

test("A3/A4 published_next_opportunity: published/none/unknown/stale evidence states", () => {
  const project = { ...elurpProjectFixture("2024Q0419") };

  // unknown: no hearings source supplied at all.
  const unknownSummary = buildLandAuthoritySummary({ ...project, geography, asOf: "2026-08-23" });
  assert.equal(unknownSummary.published_next_opportunity.status, "unknown");
  assert.equal(unknownSummary.published_next_opportunity.checked, false);

  // none: a checked, empty hearings source with a vintage.
  const noneSummary = buildLandAuthoritySummary({
    ...project,
    geography,
    asOf: "2026-08-23",
    publishedOpportunities: { hearings: [], generated_at: "2026-08-20T00:00:00.000Z" },
  });
  assert.equal(noneSummary.published_next_opportunity.status, "none");
  assert.equal(noneSummary.published_next_opportunity.checked, true);
  assert.equal(noneSummary.published_next_opportunity.checked_vintage, "2026-08-20");

  // published: a checked hearings source with a future dated row for this project.
  const publishedSummary = buildLandAuthoritySummary({
    ...project,
    geography,
    asOf: "2026-08-23",
    publishedOpportunities: {
      hearings: [{ project_id: "2024Q0419", hearing_date: "2026-09-15", representing: "City Planning Commission", milestone_title: "CPC Public Hearing" }],
      generated_at: "2026-08-20T00:00:00.000Z",
    },
  });
  assert.equal(publishedSummary.published_next_opportunity.status, "published");
  assert.equal(publishedSummary.published_next_opportunity.checked, true);
  assert.equal(publishedSummary.published_next_opportunity.date, "2026-09-15");

  // stale: a checked hearings source whose vintage is outside the freshness contract.
  const staleSummary = buildLandAuthoritySummary({
    ...project,
    geography,
    asOf: "2026-08-23",
    publishedOpportunities: { hearings: [], generated_at: "2026-01-01T00:00:00.000Z" },
  });
  assert.equal(staleSummary.published_next_opportunity.status, "stale");
  assert.equal(staleSummary.published_next_opportunity.checked, true);

  for (const [summary, key] of [
    [unknownSummary, "land_authority_opportunity_unknown"],
    [noneSummary, "land_authority_opportunity_none"],
    [publishedSummary, null],
    [staleSummary, "land_authority_opportunity_stale"],
  ]) {
    const html = landAuthoritySummaryHTML(summary, { t: (k, vars) => (vars ? `${k}:${JSON.stringify(vars)}` : k), escape: (v) => String(v ?? "") });
    assert.doesNotMatch(html, /not found in checked materializations/i);
    if (key) assert.match(html, new RegExp(key));
  }
});

test("A5/A6 calendar and watch affordances gate on real inputs, not project id alone", () => {
  const project = elurpProjectFixture("2025R0257");
  const esc = (value) => String(value ?? "");
  const t = (key, vars) => (vars ? `${key}:${JSON.stringify(vars)}` : key);

  // No published date -> no calendar button, ever.
  const noDate = buildLandAuthoritySummary({ ...project, geography, asOf: "2026-08-23" });
  assert.equal(noDate.published_next_opportunity.date, null);
  const noDateHtml = landAuthoritySummaryHTML(noDate, { t, escape: esc });
  assert.doesNotMatch(noDateHtml, /data-land-authority-calendar="1"/);

  // A published, dated opportunity earns the calendar button.
  const dated = buildLandAuthoritySummary({
    ...project,
    geography,
    asOf: "2026-08-23",
    publishedOpportunities: {
      hearings: [{ project_id: "2025R0257", hearing_date: "2026-09-01", representing: "City Planning Commission" }],
      generated_at: "2026-08-20T00:00:00.000Z",
    },
  });
  const datedHtml = landAuthoritySummaryHTML(dated, { t, escape: esc });
  assert.match(datedHtml, /data-land-authority-calendar="1"/);

  // 2025R0257 (E3) is CPC-terminal: no materialized next decision -> "Follow this project", not "Follow next decision".
  const terminal = summarizeElurp("E3-2025R0257");
  assert.equal(terminal.expected_next_stage, null);
  const terminalHtml = landAuthoritySummaryHTML(terminal, { t, escape: esc });
  assert.match(terminalHtml, /data-project-follow="project"/);
  assert.doesNotMatch(terminalHtml, /data-project-follow="next_decision"/);

  // 2024Q0356 (E1) has a materialized parallel CB/BP transition -> "Follow next decision".
  const nextDecision = summarizeElurp("E1-2024Q0356");
  const nextDecisionHtml = landAuthoritySummaryHTML(nextDecision, { t, escape: esc });
  assert.match(nextDecisionHtml, /data-project-follow="next_decision"/);

  const projection = landAuthorityPanelProjection(terminal);
  assert.equal(projection.watch_target, "project");
  assert.equal(projection.calendar_eligible, false);
  const nextDecisionProjection = landAuthorityPanelProjection(nextDecision);
  assert.equal(nextDecisionProjection.watch_target, "next_decision");
});

test("LDP-32 negative corpus: no forbidden state ever coexists with its counterpart", () => {
  const specimenIds = ["2024Q0356", "2024Q0419", "2025R0257", "2026X0362"];
  for (const id of specimenIds) {
    const project = elurpProjectFixture(id);
    const summary = buildLandAuthoritySummary({ ...project, geography, asOf: "2026-08-23" });
    const html = landAuthoritySummaryHTML(summary, { t: (key) => key, escape: (value) => String(value ?? "") });
    const isExplicitElurp = summary.procedure_id === "elurp_197e" || summary.procedure_id === "elurp_197e_k";

    // 1. explicit ELURP and visible "formal ULURP" never coexist.
    if (isExplicitElurp) assert.doesNotMatch(html, /formal ULURP/i, `${id}: ELURP must not read as formal ULURP`);

    // 2. a resolved procedure profile and an unknown procedure_resolution never coexist.
    if (summary.source_basis.profile) {
      assert.notEqual(summary.procedure_resolution, "unknown", `${id}: a resolved profile implies a resolved action set`);
    }

    // 3. explicit ELURP and a live §197-c statutory clock never coexist.
    if (isExplicitElurp) {
      const clock = buildUlurpStatutoryClockView({ ...project.open_data, ulurp_non: "ELURP" });
      assert.equal(clock.status, "ineligible", `${id}: ELURP never gets a §197-c clock`);
      assert.equal(clock.reason, "wrong_procedure");
    }

    // 4. the ordinary (broad, non-variant) ELURP profile and a Council/Mayor stage never coexist.
    if (summary.procedure_id === "elurp_197e") {
      assert.notEqual(summary.current_stage?.stage_id, "city_council", `${id}: broad elurp_197e has no Council stage`);
      assert.doesNotMatch(String(summary.expected_next_stage?.stage_id || ""), /city_council|mayoral/i);
    }

    // 5. an unchecked source and a "not found" copy never coexist.
    if (summary.published_next_opportunity.checked !== true) {
      assert.equal(summary.published_next_opportunity.status, "unknown", `${id}: unchecked always reads as unknown, never a checked-and-empty result`);
      assert.doesNotMatch(html, /No published next opportunity found/i);
    }

    // 6. no published date and an active calendar action never coexist.
    if (!summary.published_next_opportunity.date) {
      assert.doesNotMatch(html, /data-land-authority-calendar="1"/, `${id}: no dated event means no calendar button`);
    }
  }
});
