import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  SCOPE_SCHEMA,
  SCOPE_VERSION,
  emptyScope,
  lensStateFromScope,
  mapStateFromScope,
  normalizeScope,
  routeHashFromScope,
  scopeFromLensState,
  scopeFromMapState,
  scopeFromRouteHash,
  scopeFromWatch,
  scopeHasConstraints,
  scopeWithMapState,
  watchFromScope,
} from "../site/scope_v0.mjs";
import { nowItemMatchesScope } from "../site/scope_now_adapter.mjs";
import {
  nearYouUrlFromMapHash,
  scopeFromNearYouUrl,
} from "../site/near_you_scope_runtime.mjs";

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

test("every current browse lens preserves its existing route grammar", () => {
  const routes = [
    "#money?mode=award&agency=Buildings&q=roofing&sort=amount&min=1000000&max=5000000&category=Construction&months=3&standard=1&m=sealed_bid",
    "#people?view=guide&interest=technology&eligibility=promotion&window=open&format=mixed&salary=80k_plus&fee=none&experience=yes",
    "#land?boro=Queens&cd=Q04&council=25&q=rezoning&status=hearings&attendance=in_person",
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
