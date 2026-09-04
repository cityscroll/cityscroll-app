/**
 * PS-06: place-scope contract tests and user-journey regression harness.
 *
 * Establishes the canonical place-scope fixtures and cross-surface journey assertions the
 * later interface cards (Near You role control, Following preservation, evidence-quality
 * contract) are held to. See cityscroll-release-control/ps-06-place-scope-contract-tests and
 * cityscroll-release-control/ps-01-place-role-scope-predicate.
 *
 * Deliberately excludes derived/subjective geography (outer_borough, urban_core,
 * transit_desert, Manhattan_oriented, peripheral, walkable) — every fixture here is
 * administrative geography plus typed, provenance-backed place-role evidence.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  PLACE_ROLES,
  PLACE_ROLE_SUPPORTED_DOMAINS,
  calendarFeedUrlForScope,
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

function fixtureOnePopulation(...keys) {
  return keys.flatMap((key) => candidatesFor(key));
}

test("A1: the three canonical fixture sets exist with all five record kinds", () => {
  assert.deepEqual(
    Object.keys(FIXTURE_ONE_RECORDS).sort(),
    ["affectedAreaHere", "matterHere", "unrelated", "venueHere", "weakFallbackOnly"],
  );

  const venue = candidatesFor("venueHere");
  assert.equal(venue.length, 1);
  assert.equal(venue[0].location.place_role, "venue");
  assert.equal(venue[0].location.subject_ref, FIXTURE_COMMUNITY_DISTRICT_SUBJECT);

  const matter = candidatesFor("matterHere");
  assert.equal(matter.length, 1);
  assert.equal(matter[0].location.place_role, "matter");
  assert.equal(matter[0].location.subject_ref, FIXTURE_COMMUNITY_DISTRICT_SUBJECT);

  const affectedArea = candidatesFor("affectedAreaHere");
  assert.equal(affectedArea.length, 1);
  assert.equal(affectedArea[0].location.place_role, "affected_area");
  assert.equal(affectedArea[0].location.subject_ref, FIXTURE_COMMUNITY_DISTRICT_SUBJECT);

  // D: a weak fallback basis never produces even a candidate for this or any geography.
  assert.deepEqual(candidatesFor("weakFallbackOnly"), []);

  // E: has real place evidence, but for a different geography entirely.
  const unrelated = candidatesFor("unrelated");
  assert.equal(unrelated.length, 1);
  assert.notEqual(unrelated[0].location.subject_ref, FIXTURE_COMMUNITY_DISTRICT_SUBJECT);

  // FIXTURE 2: council-district scope combining keyword, domain, agency, place role, time window.
  const councilScope = councilDistrictScopeFixture();
  assert.equal(councilScope.topic.query, "resiliency");
  assert.equal(councilScope.facets.domains[0], "meetings");
  assert.equal(councilScope.facets.agencies[0], "Parks");
  assert.equal(councilScope.place.council_districts[0], FIXTURE_COUNCIL_DISTRICT);
  assert.equal(councilScope.time_window.preset, "month");
  assert.equal(placeRoleFromScope(councilScope), "matter");

  // FIXTURE 3: community-district scope with place role, built for watch serialization.
  const communityScope = communityDistrictWatchScopeFixture();
  assert.equal(communityScope.place.boroughs[0], FIXTURE_BOROUGH);
  assert.equal(communityScope.place.community_districts[0], FIXTURE_COMMUNITY_DISTRICT);
  assert.equal(placeRoleFromScope(communityScope), "affected_area");
});

test("J1: a scope carried from Near You through a role choice into Following, previewed, and reopened on a browsing surface remains equivalent", () => {
  const nearYouScope = scopeFromLensState("meetings", {
    boro: FIXTURE_BOROUGH,
    communityDistrict: FIXTURE_COMMUNITY_DISTRICT,
    agency: "Transportation",
    q: "hearing",
    place_role: "venue",
  });

  // Results: "Happening here" surfaces only the venue-here fixture record for this place.
  const population = fixtureOnePopulation("venueHere", "matterHere", "affectedAreaHere", "unrelated");
  const results = selectNearYouExplanationPath(population, nearYouScope);
  assert.ok(results);
  assert.equal(results.location.place_role, "venue");
  assert.equal(results.notice_href, "/notices/psc-201");

  // Follow this scope.
  const watch = watchFromScope(nearYouScope, { lens: "meetings" });
  assert.equal(watch.filter.place_role, "venue");

  // Preview: the Following URL round-trips through the shared watch wire unchanged.
  const followingHref = followingUrlFromWatch(watch, { matchCount: 1 });
  const previewedWatch = watchFromFollowingParams(new URL(followingHref).searchParams);
  assert.equal(previewedWatch.lens, "meetings");
  assert.equal(previewedWatch.filter.place_role, "venue");
  assert.equal(previewedWatch.filter.agency, "Transportation");

  // Reopen on a browsing surface.
  const reopenedScope = scopeFromWatch(previewedWatch, { lens: previewedWatch.lens });
  const browseHash = routeHashFromScope(reopenedScope, { surface: "meetings" });
  const finalScope = scopeFromRouteHash(browseHash);

  assert.equal(placeRoleFromScope(finalScope), "venue");
  assert.equal(finalScope.facets.agencies[0], nearYouScope.facets.agencies[0]);
  assert.equal(finalScope.topic.query, nearYouScope.topic.query);
  assert.equal(finalScope.place.boroughs[0], nearYouScope.place.boroughs[0]);
  assert.equal(finalScope.place.community_districts[0], nearYouScope.place.community_districts[0]);
});

test("J2: a scope carried from Near You to another supported surface and back remains equivalent", () => {
  const nearYouScope = councilDistrictScopeFixture({ placeRole: "affected_area" });

  const browseHash = routeHashFromScope(nearYouScope, { surface: "meetings" });
  const browseScope = scopeFromRouteHash(browseHash);
  assert.equal(placeRoleFromScope(browseScope), "affected_area");

  const nearYouUrl = nearYouUrlFromScope(browseScope, { base: "https://cityscroll.org/near-you" });
  const backToNearYou = scopeFromNearYouUrl(nearYouUrl);

  assert.equal(placeRoleFromScope(backToNearYou), "affected_area");
  assert.equal(backToNearYou.facets.agencies[0], nearYouScope.facets.agencies[0]);
  assert.equal(backToNearYou.topic.query, nearYouScope.topic.query);
  assert.equal(backToNearYou.place.council_districts[0], nearYouScope.place.council_districts[0]);
  assert.equal(backToNearYou.time_window.preset, nearYouScope.time_window.preset);
});

test("J3: venue-only and affected-area-only watches evaluated against the same fixture population differ correctly", () => {
  const venueWatchScope = scopeFromLensState("meetings", {
    communityDistrict: FIXTURE_COMMUNITY_DISTRICT,
    place_role: "venue",
  });
  const affectedAreaWatchScope = scopeFromLensState("meetings", {
    communityDistrict: FIXTURE_COMMUNITY_DISTRICT,
    place_role: "affected_area",
  });

  const population = fixtureOnePopulation("venueHere", "matterHere", "affectedAreaHere", "unrelated");

  const venueMatch = selectNearYouExplanationPath(population, venueWatchScope);
  assert.ok(venueMatch);
  assert.equal(venueMatch.location.place_role, "venue");
  assert.equal(venueMatch.notice_href, "/notices/psc-201");

  const affectedAreaMatch = selectNearYouExplanationPath(population, affectedAreaWatchScope);
  assert.ok(affectedAreaMatch);
  assert.equal(affectedAreaMatch.location.place_role, "affected_area");
  assert.equal(affectedAreaMatch.notice_href, "/notices/psc-203");

  // AC7/AC8: a venue-only watch never fires on the affected-area-only fixture and vice versa.
  assert.notEqual(venueMatch.notice_href, affectedAreaMatch.notice_href);
});

test("J4: an existing geographic URL with no place role behaves exactly as today", () => {
  const legacy = `#land?boro=${FIXTURE_BOROUGH}&cd=${FIXTURE_COMMUNITY_DISTRICT}&council=${FIXTURE_COUNCIL_DISTRICT}`
    + "&q=rezoning&stage=public_review&future=hearing&procedure=ulurp&family=acquisition&attendance=in_person";
  const scope = scopeFromRouteHash(legacy);

  assert.equal(placeRoleFromScope(scope), null);
  assert.equal(legacy.includes("facet"), false);
  assert.equal(routeHashFromScope(scope, { surface: "land" }), legacy);

  const watch = watchFromScope(scope, { lens: "land" });
  assert.equal("place_role" in watch.filter, false);
});

test("A6: deterministic fixture precision for place role is one", () => {
  const population = fixtureOnePopulation("venueHere", "matterHere", "affectedAreaHere", "unrelated");
  let correct = 0;
  for (const role of PLACE_ROLES) {
    const scope = {
      place: { community_districts: [FIXTURE_COMMUNITY_DISTRICT] },
      facets: { values: { place_role: role } },
    };
    const selected = selectNearYouExplanationPath(population, scope);
    if (selected
      && selected.location.place_role === role
      && selected.location.subject_ref === FIXTURE_COMMUNITY_DISTRICT_SUBJECT) correct += 1;
  }
  const place_role_fixture_precision = correct / PLACE_ROLES.length;
  assert.equal(place_role_fixture_precision, 1);
});

test("J5: a weak fallback placement never produces a confident exact-place explanation", () => {
  const weak = candidatesFor("weakFallbackOnly");
  assert.deepEqual(weak, []);

  const scope = { place: { community_districts: [FIXTURE_COMMUNITY_DISTRICT] } };
  assert.equal(selectNearYouExplanationPath(weak, scope), null);

  // Mixed into the full population, the weak fixture record still never wins a role match —
  // it simply never entered the candidate pool in the first place.
  const population = fixtureOnePopulation("weakFallbackOnly", "venueHere", "matterHere", "affectedAreaHere");
  for (const role of PLACE_ROLES) {
    const requested = {
      place: { community_districts: [FIXTURE_COMMUNITY_DISTRICT] },
      facets: { values: { place_role: role } },
    };
    const selected = selectNearYouExplanationPath(population, requested);
    assert.notEqual(selected?.notice_href, "/notices/psc-204");
  }
});

test("A4: a surface that cannot honor a place predicate reports it rather than returning broader results", () => {
  let unsupported_surface_silent_drop = 0;
  for (const lens of ["money", "property", "rules", "meetings", "people"]) {
    const withRole = scopeFromLensState(lens, { agency: "Transportation", place_role: "matter" });
    const withoutRole = scopeFromLensState(lens, { agency: "Transportation" });
    const feedWithRole = calendarFeedUrlForScope(withRole);
    const feedWithoutRole = calendarFeedUrlForScope(withoutRole);
    if (feedWithRole !== null) unsupported_surface_silent_drop += 1;
    assert.equal(feedWithRole, null, `${lens}: standing feed must decline rather than silently drop place role`);
    assert.notEqual(feedWithoutRole, null, `${lens}: standing feed stays available without a place role`);
  }
  assert.equal(unsupported_surface_silent_drop, 0);

  // Only meetings has evidenced venue/matter/affected-area distinctions today (see
  // site/near_you_explanation_path.mjs); every other domain must omit the control or report
  // the relation unavailable rather than claim to have applied it.
  assert.deepEqual(PLACE_ROLE_SUPPORTED_DOMAINS, ["meetings"]);
  for (const domain of ["money", "land", "property", "people", "rules"]) {
    assert.equal(placeRoleSupportedForDomain(domain), false, domain);
  }
});

test("Metrics: scope and watch place-role round trips hold at zero failures across both canonical scope fixtures", () => {
  const scopesToCheck = [
    councilDistrictScopeFixture({ placeRole: "matter" }),
    councilDistrictScopeFixture({ placeRole: "venue" }),
    councilDistrictScopeFixture({ placeRole: "affected_area" }),
    communityDistrictWatchScopeFixture({ placeRole: "affected_area" }),
    communityDistrictWatchScopeFixture({ placeRole: "venue" }),
  ];

  let scope_roundtrip_place_role_failures = 0;
  let watch_roundtrip_place_role_failures = 0;

  for (const scope of scopesToCheck) {
    const expectedRole = placeRoleFromScope(scope);
    const lens = scope.facets.domains[0];

    for (const surface of ["meetings", "now", "map"]) {
      const hash = routeHashFromScope(scope, { surface });
      const replay = scopeFromRouteHash(hash);
      if (placeRoleFromScope(replay) !== expectedRole) scope_roundtrip_place_role_failures += 1;
    }

    const nearYouUrl = nearYouUrlFromScope(scope, { base: "https://cityscroll.org/near-you" });
    const backToNearYou = scopeFromNearYouUrl(nearYouUrl);
    if (placeRoleFromScope(backToNearYou) !== expectedRole) scope_roundtrip_place_role_failures += 1;

    const watch = watchFromScope(scope, { lens });
    const reopenedFromWatch = scopeFromWatch(watch, { lens });
    if (placeRoleFromScope(reopenedFromWatch) !== expectedRole) watch_roundtrip_place_role_failures += 1;

    const followingHref = followingUrlFromWatch(watch, { matchCount: 1 });
    const previewedWatch = watchFromFollowingParams(new URL(followingHref).searchParams);
    const reopenedFromFollowing = scopeFromWatch(previewedWatch, { lens: previewedWatch.lens });
    if (placeRoleFromScope(reopenedFromFollowing) !== expectedRole) watch_roundtrip_place_role_failures += 1;
  }

  assert.equal(scope_roundtrip_place_role_failures, 0);
  assert.equal(watch_roundtrip_place_role_failures, 0);
});
