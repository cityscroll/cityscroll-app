/**
 * PS-03: Following preserves place MEANING, not just place name.
 *
 * Extends preview, watch serialization, watch evaluation, watch display, and email/digest
 * rendering so the shared place-role predicate (site/scope_v0.mjs PLACE_ROLES, landed by
 * cityscroll-kraken/ps-01-place-role-scope-predicate) survives end to end. Round-trip
 * preservation across scope/browse surfaces is covered by cityscroll-kraken/ps-06's
 * test/place_scope_contract.test.mjs; this file covers the acceptance criteria specific to
 * Following: serialization + reopening (A1/A6), preview/evaluation parity (A2), plain-language
 * display (A3), edit-preserves-role (A4/A5), venue-vs-affected-area evaluation boundaries
 * (A7/A8), legacy role-less watches (A9), and email/digest context (A10/A8).
 *
 * Negative rule: no subjective geography (outer_borough, urban_core, transit_desert,
 * Manhattan_oriented, peripheral, walkable) is introduced here.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  PLACE_ROLES,
  placeRoleFromScope,
  placeRoleSupportedForDomain,
  routeHashFromScope,
  scopeFromLensState,
  scopeFromRouteHash,
  scopeFromWatch,
  watchFromScope,
} from "../site/scope_v0.mjs";
import {
  buildFollowingViewModel,
  composeWatchRuleSentence,
  followingUrlFromWatch,
  renderFollowingDocument,
  watchFromFollowingParams,
} from "../site/following_view.mjs";
import { compileSub } from "../worker/src/lib/compile.mjs";
import { hearingMatchesLocation } from "../worker/src/lib/hearings.mjs";
import { describeFilter } from "../worker/src/lib/confirm_email.mjs";
import { applyWatchPatch } from "../worker/src/lib/prefs.mjs";
import { sanitize } from "../worker/src/lib/filter.mjs";

// --- A1 / A6: serialization retains the predicate; reopening reconstructs the same scope. ---

test("A1/A6: a place-role scope survives Follow -> preview URL -> reopen on a browsing surface", () => {
  const nearYouScope = scopeFromLensState("meetings", {
    councilDistrict: "33",
    place_role: "affected_area",
  });
  assert.equal(placeRoleFromScope(nearYouScope), "affected_area");

  const watch = watchFromScope(nearYouScope, { lens: "meetings" });
  assert.equal(watch.filter.place_role, "affected_area");

  // Preview: the Following URL round-trips through the shared watch wire unchanged.
  const followingHref = followingUrlFromWatch(watch, { matchCount: 3 });
  const previewedWatch = watchFromFollowingParams(new URL(followingHref).searchParams);
  assert.equal(previewedWatch.filter.place_role, "affected_area");

  // Reopen on a browsing surface (e.g. Near You / Browse).
  const reopenedScope = scopeFromWatch(previewedWatch, { lens: previewedWatch.lens });
  const browseHash = routeHashFromScope(reopenedScope, { surface: "meetings" });
  const finalScope = scopeFromRouteHash(browseHash);
  assert.equal(placeRoleFromScope(finalScope), "affected_area");
  assert.equal(finalScope.place.council_districts[0], "33");
});

test("A9: an existing watch without a place role is untouched by round-tripping", () => {
  const legacyWatch = { lens: "meetings", filter: { borough: "Queens", keywords: ["curb"] } };
  const followingHref = followingUrlFromWatch(legacyWatch, {});
  const previewedWatch = watchFromFollowingParams(new URL(followingHref).searchParams);
  assert.equal("place_role" in previewedWatch.filter, false);
  assert.equal(previewedWatch.filter.borough, "Queens");
});

// --- A3: plain-language rendering, not a raw predicate name. ---

test("A3: composeWatchRuleSentence renders each place role in plain language", () => {
  const venue = composeWatchRuleSentence("meetings", { councilDistrict: "33", place_role: "venue" });
  assert.match(venue, /happening in City Council District 33/);
  assert.doesNotMatch(venue, /place_role|venue"|"venue/);

  const matter = composeWatchRuleSentence("meetings", { communityDistrict: "M01", place_role: "matter" });
  assert.match(matter, /about Community District M01/);

  const affectedArea = composeWatchRuleSentence("meetings", { councilDistrict: "33", place_role: "affected_area" });
  assert.match(affectedArea, /affecting City Council District 33/);
  assert.doesNotMatch(affectedArea, /affected_area/);
});

test("A3: the rendered Following document shows the plain-language rule, not the raw predicate", () => {
  const html = renderFollowingDocument(buildFollowingViewModel({
    lens: "meetings",
    filter: { councilDistrict: "33", place_role: "affected_area" },
    frequency: "weekly",
    requested: true,
  }));
  const rule = html.match(/data-following-identity-rule>([^<]*)</)?.[1];
  assert.equal(rule, "Notify me when hearings and meetings affecting City Council District 33 are published.");
  // The raw predicate is legitimate machinery in a data-* hydration attribute / query string,
  // but must never leak into the user-facing rule sentence itself.
  assert.doesNotMatch(rule || "", /place_role|affected_area/);
});

test("a place role never renders for a domain whose evaluation cannot honor it", () => {
  assert.equal(placeRoleSupportedForDomain("money"), false);
  const sentence = composeWatchRuleSentence("money", { borough: "Queens", place_role: "affected_area" });
  // Falls back to the plain geographic phrasing rather than claiming an unenforced match reason.
  assert.match(sentence, /published in Queens/);
  assert.doesNotMatch(sentence, /affecting|happening/);
});

// --- A4/A5: editing frequency, or another filter field, never silently drops the role. ---

test("A4: editing frequency alone does not remove the saved place role", () => {
  const record = { lens: "meetings", filter: { councilDistrict: "33", place_role: "venue" }, freq: "daily" };
  const applied = applyWatchPatch(record, { freq: "weekly" });
  assert.equal(applied.ok, true);
  assert.equal(applied.record.filter.place_role, "venue");
  assert.equal(applied.record.freq, "weekly");
});

test("A5: editing another filter field merges in rather than replacing, so the role survives", () => {
  const record = { lens: "meetings", filter: { councilDistrict: "33", place_role: "affected_area" } };
  const applied = applyWatchPatch(record, { filter: { keywords: ["rezoning"] } });
  assert.equal(applied.ok, true);
  assert.equal(applied.record.filter.place_role, "affected_area");
  assert.equal(applied.record.filter.councilDistrict, "33");
  assert.deepEqual(applied.record.filter.keywords, ["rezoning"]);
});

test("A5: sanitize() keeps place_role for every domain that carries the field", () => {
  for (const lens of ["money", "land", "property", "rules", "meetings"]) {
    for (const role of PLACE_ROLES) {
      const clamped = sanitize(lens, { place_role: role });
      assert.equal(clamped.place_role, role, `${lens}/${role}`);
    }
    assert.equal("place_role" in sanitize(lens, { place_role: "not-a-role" }), false);
  }
});

// --- A7/A8: venue-only and affected-area-only evidence must not cross-trigger. ---

function venueRecord({ borough = null, neighborhood = null, address = null, description = "" } = {}) {
  return {
    affected_area: {
      scope: "unlocated",
      boroughs: [],
      neighborhoods: [],
      community_districts: [],
      council_districts: [],
      addresses: [],
    },
    venue: { borough, neighborhood, address },
    description,
  };
}

function affectedAreaRecord({ borough, neighborhood, communityDistrict, councilDistrict, description = "" } = {}) {
  return {
    affected_area: {
      scope: "local",
      boroughs: borough ? [borough] : [],
      neighborhoods: neighborhood ? [neighborhood] : [],
      community_districts: communityDistrict ? [communityDistrict] : [],
      council_districts: councilDistrict ? [councilDistrict] : [],
      addresses: [],
    },
    venue: { borough: null, neighborhood: null, address: null },
    description,
  };
}

test("A7: a venue-only fixture does not trigger an affected-area-only watch", () => {
  const venueOnly = venueRecord({ borough: "Manhattan", neighborhood: "Tribeca", address: "22 Reade Street" });
  assert.equal(hearingMatchesLocation(venueOnly, { borough: "Manhattan", place_role: "affected_area" }), false);
  assert.equal(hearingMatchesLocation(venueOnly, { communityDistrict: "M01", place_role: "affected_area" }), false);
  // The same fixture matches a venue-role watch on the same borough.
  assert.equal(hearingMatchesLocation(venueOnly, { borough: "Manhattan", place_role: "venue" }), true);
});

test("A8: an affected-area-only fixture does not trigger a venue-only watch", () => {
  const affectedAreaOnly = affectedAreaRecord({
    borough: "Manhattan", neighborhood: "Tribeca", communityDistrict: "M01", councilDistrict: "1",
  });
  assert.equal(hearingMatchesLocation(affectedAreaOnly, { borough: "Manhattan", place_role: "venue" }), false);
  assert.equal(hearingMatchesLocation(affectedAreaOnly, { communityDistrict: "M01", place_role: "venue" }), false);
  // The same fixture matches an affected-area-role watch on the same borough.
  assert.equal(hearingMatchesLocation(affectedAreaOnly, { borough: "Manhattan", place_role: "affected_area" }), true);
});

test("A7/A8: a venue-role neighborhood watch never falls back to affected-area free text", () => {
  // The record's own free-text description mentions the neighborhood, but only as
  // affected-area/matter evidence (subjectText() pulls from "subject property" language) --
  // the meeting's venue itself carries no neighborhood evidence at all.
  const noVenueEvidence = venueRecord({ description: "Matter regarding Tribeca community improvements." });
  assert.equal(hearingMatchesLocation(noVenueEvidence, { neighborhood: "tribeca", place_role: "venue" }), false);
  // The identical text still satisfies an affected-area-role (or role-less legacy) watch.
  assert.equal(hearingMatchesLocation(noVenueEvidence, { neighborhood: "tribeca", place_role: "affected_area" }), true);
  assert.equal(hearingMatchesLocation(noVenueEvidence, { neighborhood: "tribeca" }), true);
});

test("A9: a role-less filter keeps today's broad affected-area behavior", () => {
  const record = affectedAreaRecord({ borough: "Brooklyn", neighborhood: "Canarsie" });
  assert.equal(hearingMatchesLocation(record, { borough: "Brooklyn" }), true);
  assert.equal(hearingMatchesLocation(record, { neighborhood: "canarsie" }), true);
  // An unrecognized place_role value is treated exactly like no place_role at all.
  assert.equal(hearingMatchesLocation(record, { borough: "Brooklyn", place_role: "bogus" }), true);
});

// --- A2: preview and eventual alert evaluation replay the identical compiled query. ---

test("A2: the meetings watch compiler applies the same place-role postFilter preview and digest evaluation both call", () => {
  // worker/src/following.mjs's interactive preview and worker/src/alerts.mjs's cron digest
  // both call compileSub() then rowsForCompiledQuery() -- there is exactly one meetings
  // location postFilter (hearingMatchesLocation), so "preview" and "evaluation" cannot drift
  // apart. The committed local floor row (worker/src/data/route_read_model_floor.mjs) has
  // affected-area evidence for Manhattan but no venue evidence at all.
  const today = "2026-06-30";

  const noRole = compileSub({ lens: "meetings", filter: { borough: "Manhattan" } }, today);
  assert.equal(noRole.readRows().length, 1);

  const affectedArea = compileSub({
    lens: "meetings", filter: { borough: "Manhattan", place_role: "affected_area" },
  }, today);
  assert.equal(affectedArea.readRows().length, 1);

  const venue = compileSub({
    lens: "meetings", filter: { borough: "Manhattan", place_role: "venue" },
  }, today);
  // Fails closed: the floor fixture never claimed venue evidence for Manhattan, so a
  // venue-role watch must not inherit the affected-area match.
  assert.equal(venue.readRows().length, 0);
});

test("A2: place_role alone (no borough) still routes through the location postFilter", () => {
  const today = "2026-06-30";
  const q = compileSub({ lens: "meetings", filter: { place_role: "venue" } }, today);
  // Present because the compiled query still carries the routeReadModel filter through to
  // materializedMeetingRows -- confirmed indirectly: the query never treats an unrecognized
  // filter shape as "no location constraint at all".
  assert.equal(q.routeReadModel.filter.place_role, "venue");
});

// --- A10 / A8: email/digest rendering carries enough context to explain the match. ---

test("A10: describeFilter renders the place role for the domain that evaluates it", () => {
  assert.equal(
    describeFilter("meetings", { councilDistrict: "33", place_role: "affected_area" }),
    "Hearings and meetings — affecting City Council District 33",
  );
  assert.equal(
    describeFilter("meetings", { communityDistrict: "M01", place_role: "venue" }),
    "Hearings and meetings — happening in Community District M01",
  );
  assert.equal(
    describeFilter("meetings", { councilDistrict: "33", place_role: "matter" }),
    "Hearings and meetings — about City Council District 33",
  );
});

test("A10: describeFilter never claims a place-role match reason for an unsupported domain", () => {
  assert.equal(placeRoleSupportedForDomain("land"), false);
  const label = describeFilter("land", { boro: "Queens", place_role: "affected_area" });
  assert.match(label, /in Queens/);
  assert.doesNotMatch(label, /affecting|happening|about Queens/);
});

test("A10: a role-less watch keeps the plain geographic label (backward compatible)", () => {
  assert.equal(
    describeFilter("meetings", { borough: "Queens", keywords: ["curb"] }),
    'Hearings and meetings — about “curb” · in Queens',
  );
});
