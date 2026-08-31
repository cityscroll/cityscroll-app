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
import { landAuthoritySummaryHTML } from "../site/land_authority_summary_view.mjs";
import { rowToSodaShape } from "../warehouse/lib/zap_lookup.mjs";
import { shapeZapLookupRow } from "../worker/src/lib/zap_projects_lookup_kv.mjs";
import {
  PAYLOAD_JSON,
  RECEIPT_JSON,
  buildLandAuthoritySummaryFromRepo,
} from "../tools/build_land_authority_summary.mjs";
import { evaluateCardReconciliationFromPaths } from "../tools/card_reconciliation_guard.mjs";
import { SITE_SOURCE } from "./helpers/site_source.mjs";

const requireJson = createRequire(import.meta.url);
const gold = requireJson("./fixtures/land_authority_summary/gold.v1.json");
const geography = requireJson("../site/data/community_board_geography_lookup.json");
const warehouse = requireJson("../site/data/zap_projects_warehouse_lookup.json");
const landDefault = requireJson("../site/data/land_default_ulurp.json");
const hearings = requireJson("../site/data/land_upcoming_hearings.json");
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
  const result = evaluateCardReconciliationFromPaths({
    sourceCardsPath: "architecture-evidence/source-cards.json",
    projectionsPath: "architecture-evidence/projections.json",
  });
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
