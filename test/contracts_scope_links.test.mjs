import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  moneyActionLocationHash,
  moneyClosingWeekHash,
  moneyLocationBasisHref,
} from "../site/money_scope_links.mjs";
import { boroughScopeLinksHTML } from "../site/borough_scope_links.mjs";
import {
  contractActionBoroughInventory,
  rowMatchesContractActionFilter,
} from "../site/contract_action_location.mjs";
import { districtFacetRailHTML } from "../site/district_scope_facets.mjs";
import { routeHashFromScope, scopeFromRouteHash } from "../site/scope_v0.mjs";

const html = readFileSync(new URL("../site/index.html", import.meta.url), "utf8");
const baseHash = "#money?mode=allrfp&agency=Housing+Authority&q=bridge&sort=newest&closing=week&m=RFP&basis=contract_action_address&actionBasis=submission_address&boro=Manhattan&cd=M01&council=1";
const baseScope = scopeFromRouteHash(baseHash);

function scopeFromNearYouHref(href) {
  const url = new URL(href, "https://cityscroll.org");
  return scopeFromRouteHash(`#money${url.search}`);
}

test("Contracts exposes the four remaining controls as typed filter chips", () => {
  const section = html.slice(html.indexOf('<section id="tab-money"'), html.indexOf("<!-- ============ PEOPLE"));
  for (const edge of [
    "money.location.contract_action_address",
    "money.location.submission_address",
    "money.location.pre_bid_venue",
    "money.location.document_pickup",
    "money.time.closing_week",
  ]) assert.match(section, new RegExp(`data-scope-edge="${edge.replaceAll(".", "\\.")}"`));
  assert.match(section, /class="ui-filter-chip"[^>]+id="closingweek"/);
  assert.match(section, /class="ui-filter-chip"[^>]+id="closingweek"[^>]+[^>]*aria-pressed="(?:true|false)"/);
  assert.doesNotMatch(section, /<select[^>]+id="moneycd"(?![^>]*hidden)/);
  assert.doesNotMatch(section, /<select[^>]+id="moneycouncil"(?![^>]*hidden)/);
  assert.match(section, /id="money-borough-rail"/);
  assert.doesNotMatch(section, /<select[^>]+id="moneyboro"/);
});

test("Contracts borough links come only from basis-labeled response locations", () => {
  const inventory = contractActionBoroughInventory({ rows: [
    { request_id: "one", locations: [
      { basis: "submission_address", basis_label: "Located by submission address", borough: "Manhattan", is_place_of_performance: false },
      { basis: "submission_address", basis_label: "Located by submission address", borough: "Manhattan", is_place_of_performance: false },
    ] },
    { request_id: "two", locations: [
      { basis: "pre_bid_venue", basis_label: "Located by pre-bid venue", borough: "Bronx", is_place_of_performance: false },
    ] },
    { request_id: "uncovered", locations: [] },
  ] });

  assert.deepEqual(inventory.options, [
    { id: "Manhattan", count: 1 },
    { id: "Bronx", count: 1 },
  ]);
  assert.equal(inventory.located, 2);
  assert.equal(inventory.uncovered, 1);
  assert.deepEqual(
    contractActionBoroughInventory({ rows: [
      { locations: [{ basis: "submission_address", borough: "Manhattan", is_place_of_performance: false }] },
      { locations: [{ basis: "pre_bid_venue", borough: "Bronx", is_place_of_performance: false }] },
    ] }, { basis: "pre_bid_venue" }).options,
    [{ id: "Bronx", count: 1 }],
  );

  const rail = boroughScopeLinksHTML({
    surface: "money",
    selected: "Manhattan",
    currentHash: baseHash,
    options: inventory.options,
    total: inventory.located,
    uncoveredCount: inventory.uncovered,
  });
  assert.match(rail, /data-borough-scope-link="Manhattan"/);
  assert.match(rail, /data-borough-scope-link="Bronx"/);
  assert.doesNotMatch(rail, /data-borough-scope-link="Brooklyn"/);
  assert.match(rail, /data-borough-scope-uncovered="1"/);
  const bronxHref = rail.match(/data-borough-scope-link="Bronx"[^>]+data-filter-href="([^"]+)"/)?.[1]
    .replaceAll("&amp;", "&");
  const bronxScope = scopeFromRouteHash(bronxHref);
  assert.deepEqual(bronxScope.place.boroughs, ["Bronx"]);
  assert.deepEqual(bronxScope.place.community_districts, ["M01"]);
  assert.deepEqual(bronxScope.place.council_districts, ["1"]);
  assert.deepEqual(bronxScope.facets.agencies, ["Housing Authority"]);
  assert.equal(bronxScope.facets.values.actionBasis, "submission_address");
  assert.equal(bronxScope.facets.values.mode, "allrfp");
  assert.equal(bronxScope.facets.values.method, "RFP");
  assert.equal(bronxScope.facets.values.sort, "newest");
  assert.equal(bronxScope.time_window.preset, "closing:week");
  assert.match(rail, /data-borough-map-pivot="money"/);
  assert.doesNotMatch(rail, /data-borough-map-pivot="money"[^>]+data-near-you-link/);
  assert.match(rail, /href="\/near-you\/\?v=0&amp;lens=money&amp;q=bridge&amp;agency=Housing\+Authority&amp;boro=Manhattan&amp;cd=M01&amp;council=1&amp;basis=contract_action_address/);
});

test("every advertised Contracts borough is the exact non-empty response-location subset", () => {
  const payload = JSON.parse(readFileSync(
    new URL("../site/data/contract_action_address_locations.json", import.meta.url),
    "utf8",
  ));
  const inventory = contractActionBoroughInventory(payload);
  assert.ok(inventory.options.length > 0);
  for (const option of inventory.options) {
    const matches = payload.rows.filter((row) => rowMatchesContractActionFilter(row, {
      borough: option.id,
    }));
    assert.equal(matches.length, option.count, `${option.id} advertises its exact row count`);
    assert.ok(matches.length > 0, `${option.id} is non-empty`);
    assert.ok(matches.length < inventory.located, `${option.id} is a strict subset`);
    assert.ok(matches.every((row) => row.locations.some((location) => (
      location.borough === option.id
      && location.is_place_of_performance === false
      && Boolean(location.basis_label)
    ))), `${option.id} retains basis-labeled response-location evidence`);
  }
});

test("location basis links re-emit the shared scope and retain unrelated facets", () => {
  const href = moneyLocationBasisHref(baseScope, "pre_bid_venue");
  const replay = scopeFromNearYouHref(href);
  assert.deepEqual(replay.place.boroughs, ["Manhattan"]);
  assert.deepEqual(replay.place.community_districts, ["M01"]);
  assert.deepEqual(replay.place.council_districts, ["1"]);
  assert.deepEqual(replay.facets.agencies, ["Housing Authority"]);
  assert.equal(replay.topic.query, "bridge");
  assert.equal(replay.facets.values.actionBasis, "pre_bid_venue");
  assert.equal(replay.facets.values.mode, "allrfp");
  assert.equal(replay.facets.values.sort, "newest");
  assert.equal(replay.time_window.preset, "closing:week");
});

test("district chips intersect the current scope instead of replacing it", () => {
  const rail = districtFacetRailHTML({
    kind: "community_district",
    options: [{ id: "Q04", count: 2, label: "Q04" }],
    selected: "M01",
    baseFilter: {
      actionBasis: "submission_address",
      borough: "Manhattan",
      communityDistrict: "M01",
      councilDistrict: "1",
    },
    scope: baseScope,
    anyLabel: "Any district",
    mapPivotLabel: "Map",
  });
  assert.match(rail, /href="#money\?mode=allrfp&amp;agency=Housing\+Authority&amp;q=bridge&amp;sort=newest&amp;closing=week&amp;m=RFP&amp;basis=contract_action_address&amp;actionBasis=submission_address&amp;boro=Manhattan&amp;cd=Q04&amp;council=1"/);
  assert.match(rail, /data-district-map-pivot="community_district:Q04"/);
});

test("closing-week chip is a temporal scope that round-trips and can clear itself", () => {
  const active = moneyClosingWeekHash(baseScope, true);
  const replay = scopeFromRouteHash(active);
  assert.equal(replay.time_window.preset, "closing:week");
  assert.deepEqual(replay.facets.agencies, ["Housing Authority"]);
  assert.equal(replay.facets.values.actionBasis, "submission_address");
  const cleared = scopeFromRouteHash(moneyClosingWeekHash(replay, false));
  assert.equal(cleared.time_window.preset, null);
  assert.deepEqual(cleared.place.community_districts, ["M01"]);
  assert.equal(routeHashFromScope(cleared, { surface: "money" }).includes("closing="), false);
});

test("unresolved district keys fail closed while resolved keys emit a scope", () => {
  assert.equal(moneyActionLocationHash(baseScope, { communityDistrict: "Community District 4" }), null);
  assert.match(moneyActionLocationHash(baseScope, { councilDistrict: "33" }), /council=33/);
});
