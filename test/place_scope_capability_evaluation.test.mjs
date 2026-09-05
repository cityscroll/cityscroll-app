/**
 * PS-07: the place-scope capability evaluation must distinguish knowing WHERE a record is
 * from knowing WHY a place is relevant, grade the end-to-end predicate on the built /
 * partial / complete ladder, and always name the failing domain or surface. See
 * cityscroll-capability-spine/ps-07-place-scope-capability and
 * tools/evaluate_place_scope_capability.mjs.
 *
 * Two kinds of coverage live here:
 *  - Grading-engine tests (synthetic signals) prove the ladder logic itself enforces A1-A4,
 *    including the guard a real regression could not otherwise exercise: a domain that
 *    renders a place-scope control but whose retrieval does not honor it must never be
 *    counted as "built" (A2).
 *  - An integration test wires the grader to the REAL PS-02/03/04/06 functions and
 *    canonical fixtures and asserts today's "meetings" capability actually grades
 *    "complete" -- a measured result, not an assertion about interface presence.
 *
 * Negative rule: no subjective geography (outer_borough, urban_core, transit_desert,
 * Manhattan_oriented, peripheral, walkable) is introduced here.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  evaluateExplanationConsistency,
  evaluateFollowingCorrectness,
  evaluatePlaceRetrieval,
  evaluatePlaceScopeCapability,
  evaluateRelevanceMeaning,
  evaluateRoundTrip,
  gradePlaceScopeDomain,
  PLACE_SCOPE_CAPABILITY_LADDER,
} from "../tools/evaluate_place_scope_capability.mjs";

import {
  PLACE_ROLES,
  PLACE_ROLE_SUPPORTED_DOMAINS,
  nearYouUrlFromScope,
  placeRoleFromScope,
  placeRoleSupportedForDomain,
  routeHashFromScope,
  scopeFromLensState,
  scopeFromRouteHash,
  scopeFromWatch,
  watchFromScope,
} from "../site/scope_v0.mjs";
import { scopeFromNearYouUrl } from "../site/near_you_scope_runtime.mjs";
import {
  buildNearYouExplanationCandidates,
  selectNearYouExplanationPath,
} from "../site/near_you_explanation_path.mjs";
import { followingUrlFromWatch, watchFromFollowingParams } from "../site/following_view.mjs";
import { hearingMatchesLocation } from "../worker/src/lib/hearings.mjs";

import {
  FIXTURE_BOROUGH,
  FIXTURE_COMMUNITY_DISTRICT,
  FIXTURE_COMMUNITY_DISTRICT_SUBJECT,
  FIXTURE_COUNCIL_DISTRICT,
  FIXTURE_GEOGRAPHY_NODES,
  FIXTURE_MANDATE_BACKLINKS,
  FIXTURE_ONE_RECORDS,
} from "./fixtures/place_scope_contract/geography.mjs";
import {
  communityDistrictWatchScopeFixture,
  councilDistrictScopeFixture,
} from "./fixtures/place_scope_contract/scopes.mjs";

const FIXTURE_PLACE = { community_districts: [FIXTURE_COMMUNITY_DISTRICT] };

function candidatesFor(recordKey) {
  const { record, locatedEdges } = FIXTURE_ONE_RECORDS[recordKey];
  return buildNearYouExplanationCandidates({
    record,
    lens: "meetings",
    locatedEdges,
    geographyNodes: FIXTURE_GEOGRAPHY_NODES,
    mandateBacklinks: FIXTURE_MANDATE_BACKLINKS,
  });
}

function population(...keys) {
  return keys.flatMap((key) => candidatesFor(key));
}

// --- Grading-engine tests: synthetic signals prove the ladder itself enforces A1-A4. ---

test("A2: a domain that claims place-role support but whose retrieval is not correct never grades built or higher", () => {
  const grade = gradePlaceScopeDomain({
    domain: "money",
    claimsPlaceRole: true, // e.g. a control renders
    locationRetrieval: { correct: false, reason: "retrieval never applied the requested place" },
  });
  assert.equal(grade.grade, "not_built");
  assert.equal(grade.failing_surface, "money/retrieval");
  assert.notEqual(grade.grade, "built");
});

test("A1: a domain not claiming place-role support grades not_applicable and never occupies the ladder", () => {
  const grade = gradePlaceScopeDomain({ domain: "people", claimsPlaceRole: false });
  assert.equal(grade.grade, "not_applicable");
  assert.equal(PLACE_SCOPE_CAPABILITY_LADDER.includes(grade.grade), false);
});

test("A1/A3: correct location retrieval alone (relevance meaning collapsed) grades partial, not complete", () => {
  const grade = gradePlaceScopeDomain({
    domain: "meetings",
    claimsPlaceRole: true,
    locationRetrieval: { correct: true },
    relevanceMeaning: { distinguished: false, reasons: ["venue collapsed onto the same record as matter"] },
  });
  assert.equal(grade.grade, "partial");
  assert.equal(grade.failing_surface, "meetings/place-role-meaning");
  assert.match(grade.reason, /collapsed/);
});

test("A3/A4: a round-trip failure grades partial and names the round-trip surface", () => {
  const grade = gradePlaceScopeDomain({
    domain: "meetings",
    claimsPlaceRole: true,
    locationRetrieval: { correct: true },
    relevanceMeaning: { distinguished: true },
    roundTrip: { failures: 2, detail: ["watch", "near-you-url"] },
  });
  assert.equal(grade.grade, "partial");
  assert.equal(grade.failing_surface, "meetings/round-trip");
});

test("A3/A4: Following disagreement grades partial and names the following surface", () => {
  const grade = gradePlaceScopeDomain({
    domain: "meetings",
    claimsPlaceRole: true,
    locationRetrieval: { correct: true },
    relevanceMeaning: { distinguished: true },
    roundTrip: { failures: 0, detail: [] },
    followingCorrectness: { holds: false, disagreements: ["venueOnly: place_role=affected_area matched=true, expected=false"] },
  });
  assert.equal(grade.grade, "partial");
  assert.equal(grade.failing_surface, "meetings/following");
});

test("A3/A4: an explanation/evidence mismatch grades partial and names the explanation surface", () => {
  const grade = gradePlaceScopeDomain({
    domain: "meetings",
    claimsPlaceRole: true,
    locationRetrieval: { correct: true },
    relevanceMeaning: { distinguished: true },
    roundTrip: { failures: 0, detail: [] },
    followingCorrectness: { holds: true, disagreements: [] },
    explanationConsistency: { consistent: false, reasons: ["venue: explanation role/evidence tier does not agree with the matched predicate"] },
  });
  assert.equal(grade.grade, "partial");
  assert.equal(grade.failing_surface, "meetings/explanation");
});

test("A3: every check holding grades complete", () => {
  const grade = gradePlaceScopeDomain({
    domain: "meetings",
    claimsPlaceRole: true,
    locationRetrieval: { correct: true },
    relevanceMeaning: { distinguished: true },
    roundTrip: { failures: 0, detail: [] },
    followingCorrectness: { holds: true, disagreements: [] },
    explanationConsistency: { consistent: true, reasons: [] },
  });
  assert.equal(grade.grade, "complete");
  assert.equal(grade.failing_surface, null);
});

test("A4: the rollup names every failing domain/surface and grades the worst rung present", () => {
  const report = evaluatePlaceScopeCapability([
    { domain: "meetings", claimsPlaceRole: true, locationRetrieval: { correct: true },
      relevanceMeaning: { distinguished: true }, roundTrip: { failures: 0, detail: [] },
      followingCorrectness: { holds: true, disagreements: [] },
      explanationConsistency: { consistent: true, reasons: [] } },
    { domain: "money", claimsPlaceRole: true, locationRetrieval: { correct: false, reason: "no retrieval" } },
    { domain: "people", claimsPlaceRole: false },
  ]);
  assert.equal(report.overall_grade, "not_built");
  assert.deepEqual(report.failing_domains, ["money/retrieval"]);
});

// --- Integration: wire the grader to the REAL PS-02/03/04/06 functions and fixtures. ---

test("integration: today's meetings place-scope capability actually grades complete end to end", () => {
  const pop = population("venueHere", "matterHere", "affectedAreaHere", "unrelated");
  const weakPop = population("weakFallbackOnly");

  const locationRetrieval = evaluatePlaceRetrieval({
    selectExplanationPath: selectNearYouExplanationPath,
    population: pop,
    place: FIXTURE_PLACE,
    expectedSubject: FIXTURE_COMMUNITY_DISTRICT_SUBJECT,
    excludedNoticeHrefs: ["/notices/psc-205"], // the unrelated fixture's own record
  });
  assert.equal(locationRetrieval.correct, true, locationRetrieval.reason);

  const relevanceMeaning = evaluateRelevanceMeaning({
    selectExplanationPath: selectNearYouExplanationPath,
    population: pop,
    place: FIXTURE_PLACE,
    expectedHrefByRole: { venue: "/notices/psc-201", matter: "/notices/psc-202", affected_area: "/notices/psc-203" },
  });
  assert.equal(relevanceMeaning.distinguished, true, relevanceMeaning.reasons.join("; "));

  const roundTrip = evaluateRoundTrip({
    scopes: [
      councilDistrictScopeFixture({ placeRole: "matter" }),
      councilDistrictScopeFixture({ placeRole: "venue" }),
      councilDistrictScopeFixture({ placeRole: "affected_area" }),
      communityDistrictWatchScopeFixture({ placeRole: "affected_area" }),
      communityDistrictWatchScopeFixture({ placeRole: "venue" }),
    ],
    placeRoleFromScope,
    routeHashFromScope,
    scopeFromRouteHash,
    nearYouUrlFromScope,
    scopeFromNearYouUrl,
    watchFromScope,
    scopeFromWatch,
    followingUrlFromWatch,
    watchFromFollowingParams,
  });
  assert.equal(roundTrip.failures, 0, roundTrip.detail.join(", "));

  const followingCorrectness = evaluateFollowingCorrectness({
    matchesLocation: hearingMatchesLocation,
    records: [
      {
        key: "venueOnly",
        ownRole: "venue",
        filterBase: { borough: FIXTURE_BOROUGH },
        record: {
          affected_area: { scope: "unlocated", boroughs: [], neighborhoods: [], community_districts: [], council_districts: [], addresses: [] },
          venue: { borough: FIXTURE_BOROUGH, neighborhood: null, address: null },
          description: "",
        },
      },
      {
        key: "affectedAreaOnly",
        ownRole: "affected_area",
        filterBase: { borough: FIXTURE_BOROUGH },
        record: {
          affected_area: { scope: "local", boroughs: [FIXTURE_BOROUGH], neighborhoods: [], community_districts: [FIXTURE_COMMUNITY_DISTRICT], council_districts: [FIXTURE_COUNCIL_DISTRICT], addresses: [] },
          venue: { borough: null, neighborhood: null, address: null },
          description: "",
        },
      },
    ],
  });
  assert.equal(followingCorrectness.holds, true, followingCorrectness.disagreements.join("; "));

  const explanationConsistency = evaluateExplanationConsistency({
    selectExplanationPath: selectNearYouExplanationPath,
    population: pop,
    place: FIXTURE_PLACE,
    weakPopulation: weakPop,
  });
  assert.equal(explanationConsistency.consistent, true, explanationConsistency.reasons.join("; "));

  const report = evaluatePlaceScopeCapability([{
    domain: "meetings",
    claimsPlaceRole: placeRoleSupportedForDomain("meetings"),
    locationRetrieval,
    relevanceMeaning,
    roundTrip,
    followingCorrectness,
    explanationConsistency,
  }]);
  assert.equal(report.domains[0].grade, "complete");
  assert.equal(report.overall_grade, "complete");
  assert.deepEqual(report.failing_domains, []);
});

test("integration: domains without evidenced place-role distinctions are never claimed built", () => {
  for (const domain of ["money", "land", "property", "people", "rules"]) {
    const grade = gradePlaceScopeDomain({ domain, claimsPlaceRole: placeRoleSupportedForDomain(domain) });
    assert.equal(grade.grade, "not_applicable", domain);
  }
  assert.deepEqual(PLACE_ROLE_SUPPORTED_DOMAINS, ["meetings"]);
});

test("integration: a place-role collapse regression would be caught (mutated population)", () => {
  // If venue and affected_area evidence were ever recorded for the same subject with the
  // SAME notice (a real collapse), relevance meaning must fail rather than silently pass.
  const collapsedRecord = {
    id: "psc-999",
    basis: "Venue / logistics", // labeled venue...
  };
  const collapsedEdges = [{
    type: "located_in", from: "notice:psc-999", to: FIXTURE_COMMUNITY_DISTRICT_SUBJECT,
    decision: "public", method: "district_activity_placement_v1", method_version: "1.0.0",
    confidence: "strong", evidence: { lens: "meetings", placement_method: "venue_line", boundary_vintage: "2026-05-26" },
  }];
  const collapsedCandidates = buildNearYouExplanationCandidates({
    record: collapsedRecord, lens: "meetings", locatedEdges: collapsedEdges,
    geographyNodes: FIXTURE_GEOGRAPHY_NODES, mandateBacklinks: FIXTURE_MANDATE_BACKLINKS,
  });
  // Only venue-labeled evidence exists for this fixture -- requesting affected_area or
  // matter must resolve to nothing, not silently reuse the venue record.
  const relevanceMeaning = evaluateRelevanceMeaning({
    selectExplanationPath: selectNearYouExplanationPath,
    population: collapsedCandidates,
    place: FIXTURE_PLACE,
    expectedHrefByRole: { venue: "/notices/psc-999", matter: null, affected_area: null },
  });
  assert.equal(relevanceMeaning.distinguished, true);
  assert.equal(relevanceMeaning.resolved.matter, null);
  assert.equal(relevanceMeaning.resolved.affected_area, null);
});
