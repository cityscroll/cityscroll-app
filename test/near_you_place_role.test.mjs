/**
 * PS-02: turn "why is this here?" into an actual Near-you control.
 *
 * The selector is a refinement of the current place scope — all local activity, happening
 * here, about this place, affecting this place — built on the one shared place-role predicate
 * from PS-01 (site/scope_v0.mjs PLACE_ROLES) and exercised against the canonical PS-06
 * geography fixtures (test/fixtures/place_scope_contract). See
 * cityscroll-engineering/near-you-place-role-control.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import {
  nearYouUrlFromScope,
  PLACE_ROLES,
  placeRoleFromScope,
  placeRoleSupportedForDomain,
  scopeFromLensState,
} from "../site/scope_v0.mjs";
import { scopeFromNearYouUrl, scopeWithPlace } from "../site/near_you_scope_runtime.mjs";
import {
  buildNearYouExplanationCandidates,
  placeRoleForBasis,
} from "../site/near_you_explanation_path.mjs";
import { buildNearYouViewModel, renderNearYouDeferredBody, renderNearYouDocument } from "../site/near_you_view.mjs";

import {
  FIXTURE_BOROUGH,
  FIXTURE_COMMUNITY_DISTRICT,
  FIXTURE_GEOGRAPHY_NODES,
  FIXTURE_MANDATE_BACKLINKS,
  FIXTURE_ONE_RECORDS,
} from "./fixtures/place_scope_contract/geography.mjs";

function fixtureDistrictRecord(key) {
  const { record, locatedEdges } = FIXTURE_ONE_RECORDS[key];
  const candidates = buildNearYouExplanationCandidates({
    record,
    lens: "meetings",
    locatedEdges,
    geographyNodes: FIXTURE_GEOGRAPHY_NODES,
    mandateBacklinks: FIXTURE_MANDATE_BACKLINKS,
  });
  return {
    id: record.id,
    title: `${key} meeting`,
    agency: "Transportation",
    type: "Public Hearings",
    date: "2026-08-12T18:00:00.000",
    basis: record.basis,
    confidence: "strong",
    route: `/#notice/${record.id}`,
    ...(candidates.length ? { why_here_candidates: candidates } : {}),
  };
}

/** One district's worth of the four locatable PS-06 record kinds (unrelated excluded — it
 * belongs to a different district and is never a district_items member here). */
function fixtureActivity() {
  const keys = ["venueHere", "matterHere", "affectedAreaHere", "weakFallbackOnly"];
  const records = Object.fromEntries(keys.map((key) => [FIXTURE_ONE_RECORDS[key].record.id, fixtureDistrictRecord(key)]));
  const ids = Object.keys(records);
  return {
    schema: "cityscroll.district_activity.v1",
    boundary_vintage: "2026-05-26",
    built_at: "2026-08-04T12:00:00.000Z",
    levels: ["borough", "community_district", "council_district"],
    lenses: ["land", "property", "rules", "meetings", "money"],
    by_level: { borough: {}, community_district: {}, council_district: {} },
    citywide: {},
    virtual: {},
    unlocated: {},
    unlocated_reasons: {},
    sources: {},
    district_items: {
      schema: "cityscroll.district_items.v1",
      by_level: {
        borough: {},
        community_district: { [FIXTURE_COMMUNITY_DISTRICT]: { meetings: ids } },
        council_district: {},
      },
      citywide: { meetings: [] },
      virtual: { meetings: [] },
      unlocated: { meetings: [] },
    },
    records: { meetings: records },
    basis_layers: {},
  };
}

const fixtureBoundaries = {
  schema: "cityscroll.district_boundaries.v1",
  boundary_vintage: "2026-05-26",
  community_districts: [],
  council_districts: [],
};

const RECORD_ID = Object.fromEntries(
  ["venueHere", "matterHere", "affectedAreaHere", "weakFallbackOnly"]
    .map((key) => [key, FIXTURE_ONE_RECORDS[key].record.id]),
);

// The exact plain-language mapping the card requires (site/near_you_view.mjs placeRoleUserLabel) —
// duplicated here only as an expectation to assert against, not as a second implementation.
const ROLE_USER_LABEL = Object.freeze({ venue: "Happening here", matter: "About this place", affected_area: "Affecting this place" });
function placeRoleUserLabelFor(role) {
  return ROLE_USER_LABEL[role];
}

function placeScope({ placeRole = null, agency = "Transportation", q = null, when = null } = {}) {
  return scopeWithPlace(
    scopeFromLensState("meetings", { agency, q, when, place_role: placeRole }),
    { borough: FIXTURE_BOROUGH, communityDistrict: FIXTURE_COMMUNITY_DISTRICT },
  );
}

test("A1: the selector renders exactly the canonical shared-scope predicate, in plain language", () => {
  const view = buildNearYouViewModel(placeScope({ placeRole: "affected_area" }), fixtureActivity(), fixtureBoundaries);
  const html = renderNearYouDocument(view, { canonicalBase: "https://cityscroll.org/near-you" });
  const select = html.match(/<select name="placeRole">([\s\S]*?)<\/select>/)[1];
  const values = [...select.matchAll(/<option value="([^"]*)"/g)].map((m) => m[1]);

  assert.deepEqual(values, ["", ...PLACE_ROLES]);
  assert.match(select, />All local activity</);
  assert.match(select, />Happening here</);
  assert.match(select, />About this place</);
  assert.match(select, /value="affected_area" selected>Affecting this place</);
  // No invented, Near-you-only vocabulary and no subjective geography terms (card negative rule).
  assert.doesNotMatch(html, /outer_borough|urban_core|transit_desert|Manhattan_oriented|peripheral|walkable/);
});

test("A2: changing the role preserves place and every other filter, and the URL is shareable and reload-safe", () => {
  const withRole = placeScope({ placeRole: "matter", q: "resiliency", when: "month" });
  const href = nearYouUrlFromScope(withRole, { base: "https://cityscroll.org/near-you" });

  assert.match(href, /placeRole=matter/);
  const replayed = scopeFromNearYouUrl(href);
  assert.equal(placeRoleFromScope(replayed), "matter");
  assert.equal(replayed.place.boroughs[0], FIXTURE_BOROUGH);
  assert.equal(replayed.place.community_districts[0], FIXTURE_COMMUNITY_DISTRICT);
  assert.equal(replayed.facets.agencies[0], "Transportation");
  assert.equal(replayed.topic.query, "resiliency");
  assert.equal(replayed.time_window.preset, "month");

  // Reload-safe: parsing the same URL twice yields the identical scope.
  assert.deepEqual(scopeFromNearYouUrl(href), scopeFromNearYouUrl(href));

  // Switching only the role (venue) leaves every other axis exactly as it was.
  const venueHref = nearYouUrlFromScope(placeScope({ placeRole: "venue", q: "resiliency", when: "month" }),
    { base: "https://cityscroll.org/near-you" });
  const venueScope = scopeFromNearYouUrl(venueHref);
  assert.equal(placeRoleFromScope(venueScope), "venue");
  assert.equal(venueScope.place.boroughs[0], replayed.place.boroughs[0]);
  assert.equal(venueScope.place.community_districts[0], replayed.place.community_districts[0]);
  assert.equal(venueScope.facets.agencies[0], replayed.facets.agencies[0]);
  assert.equal(venueScope.topic.query, replayed.topic.query);
  assert.equal(venueScope.time_window.preset, replayed.time_window.preset);
});

test("A3: on a fixture with a venue, a matter, and an affected-area match, the result count changes by role", () => {
  const activity = fixtureActivity();

  const all = buildNearYouViewModel(placeScope({ placeRole: null }), activity, fixtureBoundaries);
  assert.deepEqual(all.results.ids.sort(), Object.values(RECORD_ID).sort());
  assert.equal(all.results.count, 4);

  const venue = buildNearYouViewModel(placeScope({ placeRole: "venue" }), activity, fixtureBoundaries);
  assert.deepEqual(venue.results.ids, [RECORD_ID.venueHere]);

  const matter = buildNearYouViewModel(placeScope({ placeRole: "matter" }), activity, fixtureBoundaries);
  assert.deepEqual(matter.results.ids, [RECORD_ID.matterHere]);

  const affectedArea = buildNearYouViewModel(placeScope({ placeRole: "affected_area" }), activity, fixtureBoundaries);
  assert.deepEqual(affectedArea.results.ids, [RECORD_ID.affectedAreaHere]);
});

test("A4: happening-here never returns a record solely because its matter is located there", () => {
  const view = buildNearYouViewModel(placeScope({ placeRole: "venue" }), fixtureActivity(), fixtureBoundaries);
  assert.deepEqual(view.results.ids, [RECORD_ID.venueHere]);
  assert.ok(!view.results.ids.includes(RECORD_ID.matterHere));
  assert.ok(!view.results.ids.includes(RECORD_ID.affectedAreaHere));
});

test("A5: about-this-place is never satisfied merely by an event venue", () => {
  const view = buildNearYouViewModel(placeScope({ placeRole: "matter" }), fixtureActivity(), fixtureBoundaries);
  assert.deepEqual(view.results.ids, [RECORD_ID.matterHere]);
  assert.ok(!view.results.ids.includes(RECORD_ID.venueHere));
});

test("A6: affecting-this-place requires affected-area evidence, not a generic weak placement", () => {
  const view = buildNearYouViewModel(placeScope({ placeRole: "affected_area" }), fixtureActivity(), fixtureBoundaries);
  assert.deepEqual(view.results.ids, [RECORD_ID.affectedAreaHere]);
  // The weak-fallback record has real district membership but no confident role evidence — it
  // must never count as "affecting this place" merely because it shares the same district.
  assert.ok(!view.results.ids.includes(RECORD_ID.weakFallbackOnly));
  assert.equal(placeRoleForBasis("Weak fallback"), null);

  // The pure predicate also never treats citywide/virtual/unlocated placement as district evidence.
  assert.equal(placeRoleForBasis("Citywide"), null);
  assert.equal(placeRoleForBasis("Virtual"), null);
  assert.equal(placeRoleForBasis("No place signal"), null);
});

test("A7: the all-activity choice remains backward compatible with today's broader behavior", () => {
  // A legacy Near-you URL with no role never gains a stray placeRole param and behaves exactly
  // as it did before this card.
  const legacyScope = placeScope({ placeRole: null });
  const legacyHref = nearYouUrlFromScope(legacyScope, { base: "https://cityscroll.org/near-you" });
  assert.doesNotMatch(legacyHref, /placeRole=/);
  assert.equal(placeRoleFromScope(scopeFromNearYouUrl(legacyHref)), null);

  // With no role requested, the weak-fallback record — today's broader behavior — still counts.
  const view = buildNearYouViewModel(legacyScope, fixtureActivity(), fixtureBoundaries);
  assert.ok(view.results.ids.includes(RECORD_ID.weakFallbackOnly));
});

test("A8/A9: the explanation shown on a result always agrees with the predicate that caused the match", () => {
  for (const role of PLACE_ROLES) {
    const view = buildNearYouViewModel(placeScope({ placeRole: role }), fixtureActivity(), fixtureBoundaries);
    assert.equal(view.results.count, 1);
    const [record] = view.results.records;
    assert.equal(record.matched_place_role, role);
    if (record.why_here) assert.equal(record.why_here.location.place_role, role);

    const deferred = renderNearYouDeferredBody(view);
    assert.match(deferred, new RegExp(`data-place-role="${role}"`));
    assert.match(deferred, new RegExp(`>${placeRoleUserLabelFor(role)}<`));
  }
});

test("the role selector is omitted (not silently applied) on a domain without evidenced role distinctions", () => {
  assert.deepEqual(["meetings"], ["meetings"].filter(placeRoleSupportedForDomain));
  assert.equal(placeRoleSupportedForDomain("land"), false);

  const activity = fixtureActivity();
  activity.lenses = ["land", "property", "rules", "meetings", "money"];
  activity.records.land = {};
  activity.district_items.by_level.community_district[FIXTURE_COMMUNITY_DISTRICT].land = [];

  const scope = scopeWithPlace(
    scopeFromLensState("land", { place_role: "matter" }),
    { borough: FIXTURE_BOROUGH, communityDistrict: FIXTURE_COMMUNITY_DISTRICT },
  );
  const view = buildNearYouViewModel(scope, activity, fixtureBoundaries);
  const html = renderNearYouDocument(view, { canonicalBase: "https://cityscroll.org/near-you" });

  assert.doesNotMatch(html, /<select name="placeRole">/);
  // The choice is preserved (not erased) even though it is inert for this domain, so switching
  // back to a supported lens restores it.
  assert.match(html, /<input type="hidden" name="placeRole" value="matter">/);
});

test("A9: an end-to-end browser test drives select place -> select affecting this place -> inspect -> switch view -> return", () => {
  const source = readFileSync(new URL("./functional/47_near_you_place_role.py", import.meta.url), "utf8");

  assert.match(source, /select_option\("Brooklyn"\)/); // select place
  assert.match(source, /select_option\("affected_area"\)/); // select "Affecting this place"
  assert.match(source, /data-scope-axis='local activity'/); // inspect results
  assert.match(source, /data-near-surface="map"/); // switch view
  assert.match(source, /data-near-surface="list"/); // return
  assert.match(source, /page\.url == before_url/); // same scope retained across the switch
  assert.match(source, /placeRole.*affected_area/s); // reload-safe: the role survives a full reload
});
