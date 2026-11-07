/**
 * Normative affected-review-body projection.
 *
 *   node --test test/land_affected_review_body.test.mjs
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  AFFECTED_REVIEW_BODY_DERIVATION,
  AFFECTED_REVIEW_BODY_LEGAL_BASIS,
  AFFECTED_REVIEW_BODY_SCHEMA,
  observedRecommendationFromDisposition,
  projectAffectedReviewBodies,
  stampAffectedReviewBodies,
} from "../site/land_affected_review_body.mjs";
import { REVIEWED_BOROUGH_BOARDS, boroughBoardIdentity } from "../site/borough_board_identity.mjs";
import { communityBoardIdFromCommunityDistrict } from "../site/community_board_geography.mjs";
import { LAND_PROCEDURE_PROFILE_REGISTRY_VERSION } from "../site/land_procedure_profiles.mjs";
import { buildLandPhaseView } from "../site/land_phase_spine.mjs";
import { rowToSodaShape } from "../warehouse/lib/zap_lookup.mjs";
import { shapeZapLookupRow } from "../worker/src/lib/zap_projects_lookup_kv.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const gold = JSON.parse(
  readFileSync(join(ROOT, "test/fixtures/land_affected_review_body/gold.v1.json"), "utf8"),
);
const geography = JSON.parse(
  readFileSync(join(ROOT, "site/data/community_board_geography_lookup.json"), "utf8"),
);
// The four specimens below (2025K0305, 2023K0357, 2019K0219, 2026Q0184) are
// frozen from the live warehouse/outcomes data rather than read live: each
// demonstrates a specific resolution shape (cross-CD same-borough, draft-only
// multi-body, single-CD, unresolved-procedure) that the daily refresh is free
// to rotate out of the live population, as it has already done once for this
// file's prior specimens. Freezing keeps the real, once-measured shape under
// test instead of re-pinning to a new live id every time the population moves.
const frozen = JSON.parse(
  readFileSync(join(ROOT, "test/fixtures/land_affected_review_body/frozen_rows.v1.json"), "utf8"),
);

function outcomesFor(projectId) {
  const found = frozen.outcomes?.[projectId];
  if (found) return found;
  throw new Error(`no frozen outcomes for ${projectId}`);
}

function warehouseRow(projectId) {
  const row = frozen.rows?.[projectId];
  if (!row) throw new Error(`no frozen warehouse row for ${projectId}`);
  return row;
}

function project(row) {
  return projectAffectedReviewBodies(row, { geography });
}

function bodyRefs(projection) {
  return projection.edges.map((edge) => edge.body_ref);
}

function spine(projectId, events = []) {
  return { schema_version: 1, project_id: projectId, events };
}

test("reviewed civic-institution table has exactly five Borough Board identities", () => {
  assert.equal(REVIEWED_BOROUGH_BOARDS.length, 5);
  assert.deepEqual(REVIEWED_BOROUGH_BOARDS.map((row) => row.id), [
    "borough-board:bronx",
    "borough-board:brooklyn",
    "borough-board:manhattan",
    "borough-board:queens",
    "borough-board:staten-island",
  ]);
  assert.equal(boroughBoardIdentity("brooklyn").civic_institution_id, "civic-institution:brooklyn-borough-board");
  assert.equal(boroughBoardIdentity("Brooklyn").id, "borough-board:brooklyn");
  assert.equal(REVIEWED_BOROUGH_BOARDS.every((row) => row.civic_institution_id.startsWith("civic-institution:")), true);
});

test("covers inverse resolves K11 and M05 without inventing a district", () => {
  assert.equal(communityBoardIdFromCommunityDistrict("K11", geography), "brooklyn-cb-11");
  assert.equal(communityBoardIdFromCommunityDistrict("K13", geography), "brooklyn-cb-13");
  assert.equal(communityBoardIdFromCommunityDistrict("M05", geography), "manhattan-cb-05");
  assert.equal(communityBoardIdFromCommunityDistrict("Brooklyn 11", geography), null);
});

test("A1 2025K0305 explains CB11, CB13, Brooklyn Borough Board, and Borough President", () => {
  const row = warehouseRow("2025K0305");
  assert.equal(row.community_district, "K13,K11");
  assert.equal(row.actions, "MM");
  assert.equal(row.ulurp_numbers, "250308MMK");
  const projection = project(row);
  const expected = gold.specimens["positive-2025K0305"].expect;
  assert.equal(projection.schema, AFFECTED_REVIEW_BODY_SCHEMA);
  assert.equal(projection.layer, "normative");
  assert.equal(projection.status, expected.status);
  assert.equal(projection.linking, true);
  assert.deepEqual(bodyRefs(projection), expected.body_refs);
  assert.equal(projection.facts.borough_board, true);
  assert.deepEqual(projection.facts.community_boards, [
    "community-board:brooklyn-cb-11",
    "community-board:brooklyn-cb-13",
  ]);
  assert.equal(projection.facts.borough_president, "borough-president:brooklyn");

  for (const edge of projection.edges) {
    assert.equal(edge.project_id, "2025K0305");
    assert.equal(edge.observed, false);
    assert.equal(edge.source_borough, "Brooklyn");
    assert.equal(edge.boundary_vintage, geography.boundary_vintage);
    assert.equal(edge.profile_version, LAND_PROCEDURE_PROFILE_REGISTRY_VERSION);
    assert.deepEqual(edge.legal_basis, AFFECTED_REVIEW_BODY_LEGAL_BASIS);
    assert.ok(Object.values(AFFECTED_REVIEW_BODY_DERIVATION).includes(edge.derivation_rule));
    assert.ok(edge.source_community_districts.every((cd) => ["K11", "K13"].includes(cd)));
    assert.match(edge.explanation, /review role/i);
  }
  assert.equal(
    projection.edges.find((edge) => edge.body_ref === "borough-board:brooklyn").derivation_rule,
    "same_borough_distinct_community_districts",
  );

  const view = buildLandPhaseView(spine("2025K0305", [{
    id: "obs-cb-1",
    kind: "zap_milestone",
    title: "Community Board Review",
    time: { value: "2026-07-02", certainty: "actual" },
    source: { id: "zap", url: "https://zap.planning.nyc.gov/projects/2025K0305" },
  }]), { open_data: row, geography });
  assert.equal(view.affected_review_bodies.borough_board, true);
  assert.equal(view.procedure_profile.expected_next_stage.stage_id, "ulurp_197c.borough_board_review");
});

test("A2 draft Borough Board dispositions never become an observed recommendation", () => {
  // 2023K0357 is a frozen all-draft, multi-body (including Borough Board)
  // specimen, same one used for this purpose in test/land_actor_outcome.test.mjs.
  const dispositions = outcomesFor("2023K0357").dispositions || [];
  assert.equal(dispositions.length, 4);
  assert.equal(dispositions.every((row) => row.status === "Draft"), true);
  assert.ok(dispositions.some((row) => row.representing === "Borough Board"));
  assert.equal(dispositions.every((row) => observedRecommendationFromDisposition(row) == null), true);
  const projection = project(warehouseRow("2023K0357"));
  assert.equal(projection.status, "resolved");
  assert.equal(projection.edges.every((edge) => edge.observed === false), true);
  assert.equal(projection.edges.some((edge) => edge.relation === "issues_recommendation"), false);
});

test("A3 each accepted edge retains geography, vintage, profile version, rule, and §196", () => {
  const projection = project(warehouseRow("2025K0305"));
  for (const edge of projection.edges) {
    assert.ok(edge.source_community_districts.length);
    assert.equal(edge.boundary_vintage, "2026-05-26");
    assert.equal(edge.profile_version, LAND_PROCEDURE_PROFILE_REGISTRY_VERSION);
    assert.equal(edge.legal_basis.citation, "NYC Charter § 196");
    assert.ok(edge.derivation_rule);
    assert.ok(edge.body_ref);
  }
});

test("A4 single-CD 2019K0219 has no Borough Board role", () => {
  // 2019K0219 is a frozen single-CD specimen with a resolved, non-Borough-Board shape.
  const row = warehouseRow("2019K0219");
  assert.equal(row.community_district, "K01");
  const projection = project(row);
  assert.equal(projection.status, "resolved");
  assert.deepEqual(bodyRefs(projection), ["community-board:brooklyn-cb-01", "borough-president:brooklyn"]);
  assert.equal(projection.facts.borough_board, false);
  assert.equal(projection.edges.some((edge) => edge.role === "affected_borough_board"), false);
});

test("A4 cross-borough, missing-CD, and title-only fixtures stay free of unsupported Borough Board edges", () => {
  for (const entry of gold.negatives.filter((item) => item.id !== "draft-only")) {
    const projection = project({
      ...entry.row,
      project_name: entry.row.project_name || "Borough Board mapping",
      primary_applicant: entry.row.primary_applicant || "City Planning",
      street_address: "120 Borough Hall",
    });
    assert.equal(projection.status, entry.expect.status, entry.id);
    assert.equal(projection.facts.borough_board, entry.expect.borough_board, entry.id);
    if (entry.expect.reason) assert.equal(projection.reason, entry.expect.reason, entry.id);
    if (entry.expect.body_refs) assert.deepEqual(bodyRefs(projection), entry.expect.body_refs, entry.id);
    assert.equal(projection.linking, projection.status === "resolved", entry.id);
    if (projection.status === "unresolved") {
      assert.equal(projection.edges.length, 0, entry.id);
    }
  }
});

test("A4 mixed and unknown procedures remain unresolved and non-linking", () => {
  // 2024M0244 left the live ZAP warehouse during a refresh; its input is
  // frozen here the same way it is in test/land_action_procedure_resolution.test.mjs.
  const mixed = project({
    project_id: "2024M0244",
    actions: "ZS; ZM; ZR; LD; LD",
    ulurp_numbers: "C260015ZSM; C260013ZMM; N260014ZRM; 260201LDM; 260202LDM",
    ulurp_non: "ULURP",
    // Location fields are not pinned elsewhere for this frozen specimen, so
    // this is a plausible Manhattan placeholder (the "M" in the project id),
    // only to get past the location check; the assertions below are about
    // procedure resolution, not this specific geography.
    borough: "Manhattan",
    community_district: "M04",
  });
  assert.equal(mixed.status, "unresolved");
  assert.equal(mixed.reason, "mixed_procedure");
  assert.equal(mixed.linking, false);
  assert.equal(mixed.edges.length, 0);

  // 2026Q0184 is a frozen unresolved_procedure specimen.
  const unknown = project(warehouseRow("2026Q0184"));
  assert.equal(unknown.status, "unresolved");
  assert.equal(unknown.reason, "unresolved_procedure");
  assert.equal(unknown.edges.length, 0);
});

test("A4 stamping is additive and existing geography gates still publish", () => {
  const original = warehouseRow("2025K0305");
  const shaped = rowToSodaShape({ ...original }, { asOf: "2026-08-30T00:00:00.000Z" });
  assert.equal(shaped.community_district, original.community_district);
  assert.equal(shaped.procedure_resolution, "uniform");
  assert.equal(shaped.affected_review_bodies.borough_board, true);
  assert.equal(shaped.affected_review_body_for.edges.length, 4);

  const workerShaped = shapeZapLookupRow({ ...original }, { asOf: "2026-08-30T00:00:00.000Z" });
  assert.equal(workerShaped.affected_review_bodies.borough_board, true);

  const stamped = stampAffectedReviewBodies({ ...original }, { geography });
  assert.equal(stamped.actions, original.actions);
  assert.equal(geography.gate.publication_allowed, true);
  assert.equal(geography.gate.observed_pair_count, 237);
});
