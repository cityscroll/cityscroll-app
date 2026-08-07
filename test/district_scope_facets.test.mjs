import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  communityDistrictFacetOptions,
  communityDistrictKey,
  councilDistrictFacetOptions,
  councilDistrictKey,
  districtFacetRailHTML,
  districtMapPivotHref,
  moneyDistrictScopeHash,
} from "../site/district_scope_facets.mjs";

const locationsPayload = JSON.parse(readFileSync(
  new URL("../site/data/contract_action_address_locations.json", import.meta.url),
  "utf8",
));

// Real logistics pin from site/data/contract_action_address_locations.json
// (City Record Online solicitation 20260625058 @ 1 Liberty Plaza).
const REAL_LIBERTY = {
  request_id: "20260625058", // source: City Record Online request_id; payload site/data/contract_action_address_locations.json
  community_district: "M01", // source: district_boundaries join on geocoded pin; same payload row
  council_district: "1", // source: district_boundaries join on geocoded pin; same payload row
  borough: "Manhattan", // source: GeoSearch borough on same payload row
  basis: "submission_address", // source: address_to_request basis on same payload row
};

test("community district key fails closed without borough disambiguation", () => {
  assert.equal(communityDistrictKey("M01"), "M01");
  assert.equal(communityDistrictKey("k02"), "K02");
  assert.equal(communityDistrictKey("404"), "Q04");
  // Single-digit product form and bare labels without borough never invent a key.
  assert.equal(communityDistrictKey("k2"), null);
  assert.equal(communityDistrictKey("Community District 4"), null);
  assert.equal(communityDistrictKey(""), null);
  assert.equal(communityDistrictKey(null), null);
});

test("council district key fails closed outside the 1–51 registry", () => {
  assert.equal(councilDistrictKey("33"), "33");
  assert.equal(councilDistrictKey(1), "1");
  assert.equal(councilDistrictKey("05"), "5");
  assert.equal(councilDistrictKey("0"), null);
  assert.equal(councilDistrictKey("99"), null);
  assert.equal(councilDistrictKey("Council District 33"), "33");
  assert.equal(councilDistrictKey(""), null);
});

test("facet options count only exact keys and report unknown stamps", () => {
  const community = communityDistrictFacetOptions([
    { community_district: "M01" },
    { community_district: "M01" },
    { community_district: "K02" },
    { community_district: "Community District 4" },
    { community_district: null },
  ]);
  assert.deepEqual(community.options.map((option) => [option.id, option.count]), [
    ["K02", 1],
    ["M01", 2],
  ]);
  assert.equal(community.unknown, 1);

  const council = councilDistrictFacetOptions([
    { council_district: "1" },
    { council_district: "33" },
    { council_district: "99" },
    { council_district: "1" },
  ], { labelFor: (id) => `Council ${id}` });
  assert.deepEqual(council.options.map((option) => [option.id, option.label, option.count]), [
    ["1", "Council 1", 2],
    ["33", "Council 33", 1],
  ]);
  assert.equal(council.unknown, 1);
});

test("money district scope hash is a shareable contract-action edge", () => {
  assert.equal(
    moneyDistrictScopeHash({ communityDistrict: REAL_LIBERTY.community_district }),
    "#money?basis=contract_action_address&cd=M01",
  );
  assert.equal(
    moneyDistrictScopeHash({
      councilDistrict: REAL_LIBERTY.council_district,
      actionBasis: REAL_LIBERTY.basis,
      borough: REAL_LIBERTY.borough,
    }),
    "#money?basis=contract_action_address&actionBasis=submission_address&boro=Manhattan&council=1",
  );
  // Fail closed: unresolved keys do not emit a false place edge.
  assert.equal(moneyDistrictScopeHash({ communityDistrict: "Community District 4" }), null);
  assert.equal(moneyDistrictScopeHash({ councilDistrict: "99" }), null);
});

test("map pivot hrefs use the shared Near-you district scope", () => {
  const community = districtMapPivotHref({
    kind: "community_district",
    id: REAL_LIBERTY.community_district,
    lens: "money",
  });
  assert.ok(community);
  assert.match(community, /\/near-you\/\?/);
  assert.match(community, /cd=M01/);
  assert.match(community, /lens=money/);

  const council = districtMapPivotHref({
    kind: "council_district",
    id: REAL_LIBERTY.council_district,
    lens: "money",
  });
  assert.ok(council);
  assert.match(council, /council=1/);

  assert.equal(districtMapPivotHref({ kind: "community_district", id: "Community District 4" }), null);
  assert.equal(districtMapPivotHref({ kind: "council_district", id: "99" }), null);
});

test("facet rail HTML emits hypertext scope links, not page-local predicates", () => {
  const html = districtFacetRailHTML({
    kind: "community_district",
    options: [{ id: "M01", count: 2, label: "M01" }, { id: "K02", count: 1, label: "K02" }],
    selected: "M01",
    baseFilter: { actionBasis: "submission_address", borough: "Manhattan" },
    anyLabel: "Any district",
    mapPivotLabel: "Map",
  });
  assert.match(html, /aria-pressed="true"[^>]*>M01/);
  assert.match(html, /href="#money\?basis=contract_action_address&amp;actionBasis=submission_address&amp;boro=Manhattan&amp;cd=K02"/);
  assert.match(html, /data-district-map-pivot="community_district:M01"/);
  assert.match(html, /Any district/);
  // Unresolvable option id is omitted.
  const guarded = districtFacetRailHTML({
    kind: "council_district",
    options: [{ id: "99", count: 3, label: "Council 99" }],
    selected: "",
  });
  assert.doesNotMatch(guarded, /data-district-id="99"/);
});

test("real contract-action payload yields only registry district facets", () => {
  const locations = (locationsPayload.rows || []).flatMap((row) => row.locations || []);
  assert.ok(locations.length > 0, "fixture payload has resolved locations");
  const community = communityDistrictFacetOptions(locations);
  const council = councilDistrictFacetOptions(locations);
  assert.ok(community.options.length > 0);
  assert.ok(council.options.length > 0);
  for (const option of community.options) {
    assert.equal(communityDistrictKey(option.id), option.id);
    assert.match(option.id, /^(?:M|X|K|Q|R)\d{2}$/);
  }
  for (const option of council.options) {
    assert.equal(councilDistrictKey(option.id), option.id);
    assert.match(option.id, /^(?:[1-9]|[1-4]\d|5[01])$/);
  }
  // Golden real record stays in the facet inventory.
  assert.ok(community.options.some((option) => option.id === REAL_LIBERTY.community_district));
  assert.ok(council.options.some((option) => option.id === REAL_LIBERTY.council_district));
  assert.equal(community.unknown, 0);
  assert.equal(council.unknown, 0);
});
