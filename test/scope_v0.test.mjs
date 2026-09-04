import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  SCOPE_SCHEMA,
  SCOPE_VERSION,
  PLACE_ROLES,
  PLACE_ROLE_SUPPORTED_DOMAINS,
  calendarFeedUrlForScope,
  emptyScope,
  intersectScopes,
  lensStateFromScope,
  mapStateFromScope,
  normalizeScope,
  nearYouUrlFromScope,
  placeRoleFromScope,
  placeRoleSupportedForDomain,
  routeHashFromScope,
  scopeFromGeographyWatch,
  scopeFromLensState,
  scopeFromMapState,
  scopeFromRouteHash,
  scopeFromWatch,
  scopeHasConstraints,
  scopeWithGeographies,
  scopeWithMapState,
  watchFromScope,
  watchFromGeographyScope,
} from "../site/scope_v0.mjs";
import { nowItemMatchesScope } from "../site/scope_now_adapter.mjs";
import {
  nearYouUrlFromMapHash,
  scopeFromNearYouUrl,
} from "../site/near_you_scope_runtime.mjs";
import {
  buildNearYouExplanationCandidates,
  selectNearYouExplanationPath,
} from "../site/near_you_explanation_path.mjs";

test("scope v0 has one inspectable contract and no mutable store", () => {
  const scope = emptyScope("es");
  assert.equal(scope.schema, SCOPE_SCHEMA);
  assert.equal(scope.version, SCOPE_VERSION);
  assert.deepEqual(Object.keys(scope), ["schema", "version", "place", "time_window", "topic", "facets", "language"]);
  assert.equal(scope.language, "es");
  assert.equal(scopeHasConstraints(scope), false);
  assert.equal("state" in scope, false);
  assert.equal("subscription" in scope, false);
});

test("Browse scope identity keeps source domains distinct from surface owners", async () => {
  const { browseScopeIdentity } = await import("../site/scope_v0.mjs");
  assert.deepEqual(browseScopeIdentity("people-organizations"), {
    surfaceId: "people-organizations",
    sourceDomain: "people",
  });
  assert.deepEqual(browseScopeIdentity("staffing"), {
    surfaceId: "staffing",
    sourceDomain: "staffing",
  });
  assert.deepEqual(browseScopeIdentity("exams"), {
    surfaceId: "exams",
    sourceDomain: "staffing",
  });
  assert.notEqual(
    browseScopeIdentity("exams").surfaceId,
    browseScopeIdentity("exams").sourceDomain,
  );
});

test("search and applied facets round-trip through the same scope axes", () => {
  const hash = "#meetings?agency=Transportation&q=dining&when=month&boro=Brooklyn&neighborhood=Red+Hook&process=scheduled";
  const scope = scopeFromRouteHash(hash, { language: "zh-Hans" });
  assert.deepEqual(scope.facets.domains, ["meetings"]);
  assert.deepEqual(scope.facets.agencies, ["Transportation"]);
  assert.deepEqual(scope.topic, { query: "dining", keywords: ["dining"] });
  assert.deepEqual(scope.place.boroughs, ["Brooklyn"]);
  assert.equal(scope.place.neighborhood, "Red Hook");
  assert.equal(scope.time_window.preset, "month");
  assert.equal(scope.facets.values.process, "scheduled");
  assert.equal(scope.language, "zh-Hans");
  assert.equal(routeHashFromScope(scope, { surface: "meetings" }), hash);

  const facets = lensStateFromScope(scope, "meetings");
  assert.deepEqual(facets.keywords, ["dining"]);
  assert.equal(facets.agency, "Transportation");
  assert.equal(facets.borough, "Brooklyn");
  assert.equal(facets.when, "month");
  assert.equal(facets.process, "scheduled");
});

test("typed search handoff remains inside the canonical route scope", () => {
  const handoff = {
    schema: "cityscroll.search_lens_handoff.v1",
    raw_query: "mosquitos",
    normalized_terms: ["mosquito"],
    family: "meetings",
    record_ref: "meeting:city_record:20260816001",
    evidence: {
      status: "matched",
      field: "description",
      source_identifier: "city-record:20260816001",
      snippet: {
        text: "A hearing about mosquito control in Brooklyn.",
        mark_start: 16,
        mark_end: 24,
      },
    },
    search_params: { q: "mosquitos", boro: "Brooklyn", when: "month" },
    destination: { surface: "meetings", pathname: "/browse/meetings/" },
  };
  const facet = encodeURIComponent(JSON.stringify({ search_handoff: handoff }));
  const original = `#meetings?q=mosquitos&boro=Brooklyn&when=month&facet=${facet}`;
  const scope = scopeFromRouteHash(original);

  assert.deepEqual(scope.facets.values.search_handoff, handoff);
  const replay = routeHashFromScope(scope, { surface: "meetings" });
  assert.deepEqual(scopeFromRouteHash(replay), scope);
  assert.equal(new URLSearchParams(replay.split("?", 2)[1]).get("q"), "mosquitos");
});

test("every current browse lens preserves its existing route grammar", () => {
  const routes = [
    "#money?mode=award&agency=Buildings&q=roofing&sort=amount&min=1000000&max=5000000&category=Construction&months=3&standard=1&m=sealed_bid",
    "#people?view=guide&interest=technology&eligibility=promotion&window=open&format=mixed&salary=80k_plus&fee=none&experience=yes",
    "#land?boro=Queens&cd=Q04&council=25&q=rezoning&stage=public_review&future=hearing&procedure=ulurp&family=acquisition&attendance=in_person",
    "#property?agency=DCAS&q=auction&boro=Bronx&neighborhood=Morrisania&cd=X03&asset=vehicle&method=online_auction&price=priced&sort=price_desc&process=auction_or_rfp&stage=open&view=tax-lien",
    "#property?council=25",
    "#rules?agency=Buildings&q=energy&process=public_process&scope=citywide",
    "#meetings?when=all&council=25",
  ];
  for (const hash of routes) {
    const surface = hash.slice(1).split("?", 1)[0];
    assert.equal(routeHashFromScope(scopeFromRouteHash(hash), { surface }), hash, hash);
  }
});

test("Zoning stage and future action survive Browse, Near-you, and watch adapters", () => {
  const original = "#land?boro=Queens&stage=community_board&future=hearing&procedure=ulurp&family=disposition";
  const scope = scopeFromRouteHash(original);
  assert.equal(scope.facets.values.stage, "community_board");
  assert.equal(scope.facets.values.futureAction, "hearing");
  assert.equal(scope.facets.values.procedure, "ulurp");
  assert.equal(scope.facets.values.family, "disposition");
  assert.equal(routeHashFromScope(scope, { surface: "land" }), original);

  const mapHash = routeHashFromScope(scope, { surface: "map" });
  const nowHash = routeHashFromScope(scope, { surface: "now" });
  assert.equal(routeHashFromScope(scopeFromRouteHash(mapHash), { surface: "land" }), original);
  assert.equal(routeHashFromScope(scopeFromRouteHash(nowHash), { surface: "land" }), original);

  const watch = watchFromScope(scope, { lens: "land" });
  assert.equal(watch.filter.stage, "community_board");
  assert.equal(watch.filter.futureAction, "hearing");
  assert.equal(watch.filter.procedure, "ulurp");
  assert.equal(watch.filter.family, "disposition");
  assert.equal(routeHashFromScope(scopeFromWatch(watch), { surface: "land" }), original);
});

test("legacy Zoning status URLs remain lossless at the scope boundary", () => {
  const legacy = "#land?status=public%3AIn+Public+Review";
  assert.equal(routeHashFromScope(scopeFromRouteHash(legacy), { surface: "land" }), legacy);
});

test("map adapts selected place, basis, and viewport without becoming a second store", () => {
  const state = {
    level: "community_district",
    id: "Q04",
    parent: "Queens",
    lens: "money",
    basis: "contract_action_address",
  };
  const scope = scopeFromMapState(state, { language: "en", viewBox: [10, 20, 300, 400] });
  assert.deepEqual(scope.place.boroughs, ["Queens"]);
  assert.deepEqual(scope.place.community_districts, ["Q04"]);
  assert.deepEqual(scope.place.viewport.view_box, [10, 20, 300, 400]);
  assert.deepEqual(scope.facets.domains, ["money"]);
  assert.deepEqual(mapStateFromScope(scope), { ...state, viewBox: [10, 20, 300, 400] });

  const hash = "#map?level=community_district&id=Q04&parent=Queens&lens=money&basis=contract_action_address";
  assert.equal(routeHashFromScope(scopeFromRouteHash(hash), { surface: "map" }), hash);
});

test("Near-you map hashes canonicalize direct loads and hash changes to the same district scope", () => {
  const directHash = "#map?level=community_district&parent=Manhattan&id=M03&lens=meetings";
  const changedHash = "#map?level=community_district&parent=Manhattan&id=M04&lens=meetings";
  const directUrl = nearYouUrlFromMapHash(directHash);
  const changedUrl = nearYouUrlFromMapHash(changedHash);

  assert.equal(
    directUrl,
    "/near-you/?v=0&lens=meetings&boro=Manhattan&cd=M03&level=community_district&id=M03&parent=Manhattan",
  );
  assert.equal(
    changedUrl,
    "/near-you/?v=0&lens=meetings&boro=Manhattan&cd=M04&level=community_district&id=M04&parent=Manhattan",
  );
  assert.deepEqual(
    scopeFromNearYouUrl(directUrl),
    scopeFromRouteHash(directHash),
  );
  assert.deepEqual(
    scopeFromNearYouUrl("/near-you/?v=0&lens=meetings&level=community_district&parent=Manhattan&id=M03"),
    scopeFromNearYouUrl(directUrl),
  );
  assert.deepEqual(
    scopeFromNearYouUrl(changedUrl),
    scopeFromRouteHash(changedHash),
  );

  const mapSource = readFileSync(new URL("../site/app/map.mjs", import.meta.url), "utf8");
  assert.match(mapSource, /void adoptMapHashRoute\(\)/);
  assert.match(mapSource, /addEventListener\("hashchange"/);
  assert.match(mapSource, /async function adoptDocument\(href, \{ replaceHistory = false \} = \{\}\)/);
  assert.match(mapSource, /const updateHistory = replaceHistory \? history\.replaceState : history\.pushState/);
  assert.match(mapSource, /await adoptDocument\(target\.toString\(\), \{ replaceHistory: true \}\)/);
});

test("Now geography socket narrows existing compiled items and empty scope stays inert", () => {
  const bronx = scopeFromRouteHash("#now?boro=Bronx");
  const item = {
    domain: "property",
    kind: "auction",
    agency: "DCAS",
    title: "Vehicle auction",
    place: { scope: "local", boroughs: ["Bronx"], community_districts: [], council_districts: [] },
  };
  assert.equal(nowItemMatchesScope(item, bronx), true);
  assert.equal(nowItemMatchesScope({ ...item, place: { ...item.place, boroughs: ["Queens"] } }, bronx), false);
  assert.equal(nowItemMatchesScope(item, emptyScope()), true);
  assert.equal(routeHashFromScope(bronx, { surface: "now" }), "#now?boro=Bronx");
});

test("one qualifying scope survives Now, Map, and civic-domain Browse view switches", () => {
  const browseScope = scopeFromRouteHash("#property?boro=Bronx&q=auction&asset=vehicle");
  const nowHash = routeHashFromScope(browseScope, { surface: "now" });
  const mapHash = routeHashFromScope(browseScope, { surface: "map" });
  assert.equal(nowHash, "#now?lens=property&boro=Bronx&q=auction&facet=%7B%22asset%22%3A%22vehicle%22%7D");
  assert.equal(mapHash, "#map?id=Bronx&lens=property&q=auction&facet=%7B%22asset%22%3A%22vehicle%22%7D");

  const fromMap = scopeFromRouteHash(mapHash);
  assert.deepEqual(fromMap.place.boroughs, ["Bronx"]);
  assert.equal(routeHashFromScope(fromMap, { surface: "property" }), "#property?q=auction&boro=Bronx&asset=vehicle");
  assert.equal(routeHashFromScope(scopeFromRouteHash(nowHash), { surface: "property" }), "#property?q=auction&boro=Bronx&asset=vehicle");

  const moved = scopeWithMapState(fromMap, {
    level: "borough", id: "Queens", parent: null, lens: "property", basis: "performance",
  });
  assert.equal(routeHashFromScope(moved, { surface: "property" }), "#property?q=auction&boro=Queens&asset=vehicle");
});

test("internal round-trip task keeps district, agency, action, share, and Watch scope", () => {
  const scope = scopeFromLensState("property", {
    q: "auction",
    agency: "DCAS",
    boro: "Queens",
    communityDistrict: "Q04",
    action: "bid",
    asset: "vehicle",
  }, { language: "es" });
  const now = routeHashFromScope(scope, { surface: "now" });
  const map = routeHashFromScope(scope, { surface: "map" });
  const browse = routeHashFromScope(scope, { surface: "property" });
  assert.match(now, /^#now\?/);
  assert.match(map, /^#map\?/);
  assert.equal(browse, "#property?agency=DCAS&q=auction&boro=Queens&cd=Q04&asset=vehicle&action=bid");

  for (const [hash, surface] of [[now, "now"], [map, "map"], [browse, "property"]]) {
    const replay = scopeFromRouteHash(hash, { language: "es" });
    assert.deepEqual(replay.place.community_districts, ["Q04"], surface);
    assert.deepEqual(replay.facets.agencies, ["DCAS"], surface);
    assert.deepEqual(replay.facets.actions, ["bid"], surface);
    assert.equal(replay.language, "es", surface);
  }

  const sharedScope = scopeFromRouteHash(browse, { language: "es" });
  const watch = watchFromScope(sharedScope, { lens: "property" });
  assert.equal(watch.filter.communityDistrict, "Q04");
  assert.equal(watch.filter.agency, "DCAS");
  assert.equal(watch.filter.action, "bid");
});

test("shared links and Back replay canonical scope without a history sidecar copy", () => {
  const original = "#land?boro=Manhattan&cd=M04&council=3&q=SoHo&status=all";
  const scope = scopeFromRouteHash(original, { language: "fr" });
  const shared = routeHashFromScope(scope, { surface: "land" });
  const restored = routeHashFromScope(scopeFromRouteHash(shared, { language: scope.language }), { surface: "land" });
  assert.equal(shared, original);
  assert.equal(restored, original);
  assert.equal(scope.language, "fr");
  assert.equal("history" in scope, false);
});

test("device presets serialize scope while retaining the legacy local-storage shape", () => {
  const legacy = { label: "Bronx auctions", hash: "#property?boro=Bronx&asset=vehicle&method=online_auction" };
  const scope = scopeFromRouteHash(legacy.hash, { language: "ko" });
  const preset = { label: legacy.label, hash: routeHashFromScope(scope, { surface: "property" }) };
  assert.deepEqual(preset, legacy);
  assert.equal(Object.keys(preset).sort().join(","), "hash,label");
});

test("watches and subscription metadata translate through scope without joining the contract", () => {
  const watch = {
    lens: "meetings",
    filter: {
      keywords: ["dining"],
      agency: "Transportation",
      borough: "Brooklyn",
      neighborhood: "Red Hook",
      when: "month",
      dateWindow: "month",
      process: "scheduled",
    },
  };
  const scope = scopeFromWatch(watch, { language: "es" });
  assert.deepEqual(watchFromScope(scope, { lens: "meetings" }), watch);
  assert.deepEqual({ freq: "weekly", ...watchFromScope(scope), lang: scope.language }, {
    freq: "weekly",
    lens: "meetings",
    filter: watch.filter,
    lang: "es",
  });
  assert.equal("email" in scope, false);
  assert.equal("freq" in scope, false);
});

test("generic geography keys round-trip through Near You and watches without changing legacy wires", () => {
  const key = "geography:nta2020:QN0201";
  const legacy = scopeFromRouteHash("#property?boro=Queens&cd=Q04");
  const scoped = scopeWithGeographies(legacy, [key, "geography:sanitation_district:404"]);
  assert.deepEqual(scoped.place.geographies, [key]);
  assert.equal(routeHashFromScope(scoped, { surface: "property" }), "#property?boro=Queens&cd=Q04");

  const href = nearYouUrlFromScope(scoped);
  assert.match(href, /geo=geography%3Anta2020%3AQN0201/);
  const replayed = scopeFromNearYouUrl(href);
  assert.deepEqual(replayed.place.geographies, [key]);
  assert.deepEqual(replayed.place.boroughs, scoped.place.boroughs);
  assert.deepEqual(replayed.place.community_districts, scoped.place.community_districts);

  const watch = watchFromGeographyScope(scoped, { lens: "property" });
  assert.deepEqual(watch.filter.geographies, [key]);
  assert.deepEqual(scopeFromGeographyWatch(watch).place.geographies, [key]);
  assert.equal(watch.filter.borough, "Queens");
  assert.equal(watch.filter.communityDistrict, "Q04");
});

test("exact Administrative Code provision watch round-trips through scope", () => {
  const watch = {
    lens: "legal_code",
    filter: { provision_id: "nyc-administrative-code:16-120" },
  };
  const scope = scopeFromWatch(watch);
  assert.equal(scope.facets.values.provision_id, "nyc-administrative-code:16-120");
  assert.deepEqual(watchFromScope(scope, { lens: "legal_code" }), watch);
});

test("exact mandate_id free-watch filter round-trips through scope", () => {
  const watch = {
    lens: "mandates",
    filter: {
      agency_id: "homeless-services",
      agency: "Homeless Services",
      mandate_id: "66056-006",
    },
  };
  const scope = scopeFromWatch(watch);
  assert.equal(scope.facets.values.mandate_id, "66056-006");
  assert.equal(scope.facets.values.agency_id, "homeless-services");
  assert.deepEqual(watchFromScope(scope, { lens: "mandates" }), watch);
});

test("lens state aliases normalize to the same scope instead of duplicating state", () => {
  const scope = scopeFromLensState("land", {
    q: "LIC",
    boro: "Queens",
    communityDistrict: "Q02",
    councilDistrict: "26",
    status: "all",
  });
  assert.deepEqual(scope.place.boroughs, ["Queens"]);
  assert.deepEqual(scope.place.community_districts, ["Q02"]);
  assert.deepEqual(scope.place.council_districts, ["26"]);
  assert.equal(scope.facets.values.status, "all");
  assert.equal(routeHashFromScope(normalizeScope(scope), { surface: "land" }), "#land?boro=Queens&cd=Q02&council=26&q=LIC&status=all");
});

test("place role normalizes to the canonical vocabulary and stays absent by default", () => {
  assert.deepEqual(PLACE_ROLES, ["venue", "matter", "affected_area"]);
  const empty = emptyScope();
  assert.equal(placeRoleFromScope(empty), null);
  assert.equal(scopeHasConstraints(empty), false);
  assert.equal("place_role" in empty.facets.values, false);

  for (const role of PLACE_ROLES) {
    const scope = normalizeScope({ facets: { values: { place_role: role } } });
    assert.equal(scope.facets.values.place_role, role);
    assert.equal(placeRoleFromScope(scope), role);
    assert.equal(scopeHasConstraints(scope), true);
  }

  // Never fabricate a subjective-geography role: an unrecognized value is dropped, not
  // silently coerced, so an absent-role caller keeps today's broader behavior (A6).
  for (const bogus of ["outer_borough", "urban_core", "walkable", ""]) {
    const scope = normalizeScope({ facets: { values: { place_role: bogus } } });
    assert.equal("place_role" in scope.facets.values, false, bogus);
    assert.equal(placeRoleFromScope(scope), null, bogus);
  }
});

test("place role rides the existing generic facet transport through every browse surface", () => {
  for (const role of PLACE_ROLES) {
    const facet = encodeURIComponent(JSON.stringify({ place_role: role }));
    for (const [hash, surface] of [
      [`#meetings?q=hearing&boro=Brooklyn&facet=${facet}`, "meetings"],
      [`#land?boro=Queens&cd=Q04&facet=${facet}`, "land"],
      [`#money?agency=Buildings&facet=${facet}`, "money"],
      [`#property?boro=Bronx&asset=vehicle&facet=${facet}`, "property"],
      [`#rules?agency=Buildings&facet=${facet}`, "rules"],
    ]) {
      const scope = scopeFromRouteHash(hash);
      assert.equal(scope.facets.values.place_role, role, surface);
      assert.equal(routeHashFromScope(scope, { surface }), hash, surface);
    }
  }
});

test("place role combines with a supported neighbourhood, keyword, and agency on meetings", () => {
  const facet = encodeURIComponent(JSON.stringify({ place_role: "affected_area" }));
  const hash = `#meetings?agency=Transportation&q=dining&boro=Brooklyn&neighborhood=Red+Hook&facet=${facet}`;
  const scope = scopeFromRouteHash(hash);
  assert.equal(scope.facets.values.place_role, "affected_area");
  assert.equal(scope.place.neighborhood, "Red Hook");
  assert.deepEqual(scope.place.boroughs, ["Brooklyn"]);
  assert.equal(scope.facets.agencies[0], "Transportation");
  assert.equal(scope.topic.query, "dining");
  assert.equal(routeHashFromScope(scope, { surface: "meetings" }), hash);
});

test("place role combines with district, agency, keyword, domain, and time, and survives Browse, Near-you, Map, and Watch", () => {
  const scope = scopeFromLensState("meetings", {
    q: "resiliency",
    agency: "Parks",
    boro: "Queens",
    communityDistrict: "Q04",
    councilDistrict: "26",
    neighborhood: "Astoria",
    when: "month",
    place_role: "matter",
  });
  assert.equal(scope.facets.domains[0], "meetings");
  assert.equal(scope.facets.values.place_role, "matter");

  const browse = routeHashFromScope(scope, { surface: "meetings" });
  const now = routeHashFromScope(scope, { surface: "now" });
  const map = routeHashFromScope(scope, { surface: "map" });
  for (const [hash, surface] of [[browse, "meetings"], [now, "now"], [map, "map"]]) {
    const replay = scopeFromRouteHash(hash);
    assert.equal(replay.facets.values.place_role, "matter", surface);
    assert.equal(replay.facets.agencies[0], "Parks", surface);
  }
  // The map viewport represents one place level at a time (existing behavior, unrelated
  // to place role); district/council precision only round-trips on the non-map surfaces.
  for (const [hash, surface] of [[browse, "meetings"], [now, "now"]]) {
    const replay = scopeFromRouteHash(hash);
    assert.equal(replay.place.community_districts[0], "Q04", surface);
    assert.equal(replay.place.council_districts[0], "26", surface);
    assert.equal(replay.time_window.preset, "month", surface);
  }

  const watch = watchFromScope(scope, { lens: "meetings" });
  assert.equal(watch.filter.place_role, "matter");
  const reopened = scopeFromWatch(watch, { lens: "meetings" });
  assert.equal(reopened.facets.values.place_role, "matter");
  assert.deepEqual(watchFromScope(reopened, { lens: "meetings" }), watch);
});

test("place role travels through the generic geography-watch wire unchanged", () => {
  const scope = scopeWithGeographies(
    scopeFromLensState("meetings", { boro: "Brooklyn", place_role: "venue" }),
    ["geography:nta2020:BK0201"],
  );
  const watch = watchFromGeographyScope(scope, { lens: "meetings" });
  assert.equal(watch.filter.place_role, "venue");
  assert.deepEqual(watch.filter.geographies, ["geography:nta2020:BK0201"]);
  const restored = scopeFromGeographyWatch(watch);
  assert.equal(restored.facets.values.place_role, "venue");
  assert.deepEqual(restored.place.geographies, ["geography:nta2020:BK0201"]);
});

test("place role composition: agreeing scopes keep it, contradicting scopes fall to match_none", () => {
  const venue = normalizeScope({ facets: { values: { place_role: "venue" } } });
  const alsoVenue = normalizeScope({ place: { boroughs: ["Brooklyn"] }, facets: { values: { place_role: "venue" } } });
  const agree = intersectScopes(venue, alsoVenue);
  assert.equal(agree.facets.values.place_role, "venue");
  assert.deepEqual(agree.place.boroughs, ["Brooklyn"]);

  const matter = normalizeScope({ facets: { values: { place_role: "matter" } } });
  const conflict = intersectScopes(venue, matter);
  assert.equal(conflict.facets.values.match_none, true);

  // An absent role on one side never narrows — it takes the other side's role (A6).
  const unset = emptyScope();
  const inherited = intersectScopes(unset, venue);
  assert.equal(inherited.facets.values.place_role, "venue");
});

test("an unsupported domain never claims the place-role constraint was applied", () => {
  assert.equal(placeRoleSupportedForDomain("meetings"), true);
  assert.ok(PLACE_ROLE_SUPPORTED_DOMAINS.includes("meetings"));
  for (const domain of ["money", "land", "property", "people", "rules"]) {
    assert.equal(placeRoleSupportedForDomain(domain), false, domain);
  }

  // The standing calendar feed replays a watch verbatim or not at all (fail-closed): a
  // place-role filter it cannot honor must omit the affordance rather than silently
  // publish a feed that quietly drops the constraint.
  const scope = scopeFromLensState("meetings", { boro: "Brooklyn", place_role: "venue" });
  assert.equal(calendarFeedUrlForScope(scope), null);
  assert.notEqual(calendarFeedUrlForScope(scopeFromLensState("meetings", { boro: "Brooklyn" })), null);
});

test("no duplicate place-role vocabulary: Near-you explanation paths only ever emit the canonical predicate", () => {
  const nodes = [{ subject_ref: "borough:queens", kind: "borough", label: "Queens" }];
  const locatedEdges = [{
    type: "located_in", from: "notice:n-9", to: "borough:queens", decision: "public",
    method: "district_activity_placement_v1", method_version: "1.0.0",
    evidence: { lens: "meetings", placement_method: "matter_title_place", boundary_vintage: "2026-05-26" },
  }];
  const backlinks = [{
    duty_text: "Publish the annual district safety plan.", citation: "Local Law § 1",
    relation: "requires_public_hearing", agency_id: "transportation", agency_name: "Transportation",
    agency_href: "/agencies/transportation/", publication_tier: "deterministic",
  }];
  for (const basis of ["Venue / logistics", "Matter place", "Affected area", "Community board district"]) {
    const candidates = buildNearYouExplanationCandidates({
      record: { id: "n-9", basis }, lens: "meetings", locatedEdges, geographyNodes: nodes, mandateBacklinks: backlinks,
    });
    for (const candidate of candidates) assert.ok(PLACE_ROLES.includes(candidate.location.place_role), basis);
  }

  // A requested role that has no evidence on the candidate set finds nothing rather than
  // fabricating a match (A3/A5): the constraint is preserved, never silently broadened.
  const matterCandidates = buildNearYouExplanationCandidates({
    record: { id: "n-9", basis: "Matter place" }, lens: "meetings", locatedEdges, geographyNodes: nodes, mandateBacklinks: backlinks,
  });
  const wantsVenue = { place: { boroughs: ["Queens"] }, facets: { values: { place_role: "venue" } } };
  assert.equal(selectNearYouExplanationPath(matterCandidates, wantsVenue), null);
  const wantsMatter = { place: { boroughs: ["Queens"] }, facets: { values: { place_role: "matter" } } };
  assert.equal(selectNearYouExplanationPath(matterCandidates, wantsMatter).location.place_role, "matter");
  const noRole = { place: { boroughs: ["Queens"] } };
  assert.equal(selectNearYouExplanationPath(matterCandidates, noRole).location.place_role, "matter");
});

test("legacy scopes and URLs without a place role keep today's exact broader behavior", () => {
  const legacy = "#land?boro=Queens&cd=Q04&council=25&q=rezoning&stage=public_review&future=hearing&procedure=ulurp&family=acquisition&attendance=in_person";
  const scope = scopeFromRouteHash(legacy);
  assert.equal(placeRoleFromScope(scope), null);
  assert.equal("facet" in Object.fromEntries(new URLSearchParams(legacy.split("?", 2)[1])), false);
  assert.equal(routeHashFromScope(scope, { surface: "land" }), legacy);

  const watch = watchFromScope(scope, { lens: "land" });
  assert.equal("place_role" in watch.filter, false);
});

test("runtime boundaries all invoke the scope adapter", () => {
  const files = {
    main: readFileSync(new URL("../site/app/main.mjs", import.meta.url), "utf8"),
    routing: readFileSync(new URL("../site/app/routing.mjs", import.meta.url), "utf8"),
    search: readFileSync(new URL("../site/app/search-share.mjs", import.meta.url), "utf8"),
    now: readFileSync(new URL("../site/now_view.mjs", import.meta.url), "utf8"),
    alerts: readFileSync(new URL("../site/app/alerts.mjs", import.meta.url), "utf8"),
    carry: readFileSync(new URL("../site/alerts_context_carry.mjs", import.meta.url), "utf8"),
    templates: readFileSync(new URL("../site/watch_templates.mjs", import.meta.url), "utf8"),
  };
  assert.match(files.main, /scope_v0\.mjs/);
  assert.match(files.routing, /scopeFromRouteHash|scopeFromMapState/);
  assert.match(files.search, /scopeHash/);
  assert.match(files.now, /nowItemMatchesScope/);
  assert.match(files.alerts, /scopeFromWatch/);
  assert.match(files.carry, /watchFromScope/);
  assert.match(files.templates, /scopeFromWatch|watchFromScope/);
});
