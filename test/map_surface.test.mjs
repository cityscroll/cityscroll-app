import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { test } from "node:test";
import { SITE_SOURCE } from "./helpers/site_source.mjs";
import { buildNearYouViewModel, renderNearYouBody } from "../site/near_you_view.mjs";
import { scopeFromLensState } from "../site/scope_v0.mjs";

const index = readFileSync(new URL("../site/index.html", import.meta.url), "utf8");
const i18n = readFileSync(new URL("../site/i18n.js", import.meta.url), "utf8");
const demo = JSON.parse(
  readFileSync(new URL("../site/demo/demo-links.json", import.meta.url), "utf8"),
);
const source = SITE_SOURCE;
const near = readFileSync(new URL("../site/near-you/index.html", import.meta.url), "utf8");
const island = readFileSync(new URL("../site/app/map.mjs", import.meta.url), "utf8");
const routing = readFileSync(new URL("../site/app/routing.mjs", import.meta.url), "utf8");
const boundaries = JSON.parse(readFileSync(new URL("../site/data/district_boundaries.json", import.meta.url), "utf8"));
const activity = JSON.parse(readFileSync(new URL("../site/data/district_activity.json", import.meta.url), "utf8"));

test("the map is a route-owned Near-you facet without a proprietary SDK", () => {
  assert.doesNotMatch(index, /data-tab="map"|id="tab-map"|id="mapSvg"/);
  assert.match(near, /data-near-you-root/);
  assert.match(near, /id="nearMapSvg"/);
  assert.match(near, /class="near-area-list"/);
  assert.match(near, /<script type="module" src="\/app\/map\.mjs"/);
  assert.match(island, /import[^;]+map_exploration\.mjs/);
  assert.match(island, /data\/district_boundaries\.json/);
  assert.doesNotMatch(`${island}\n${near}`, /mapbox|google\.maps|Mapbox/i);
  assert.match(i18n, /tab_map:\s*"Map"/);
  assert.match(i18n, /map_boundary_vintage/);
  assert.doesNotMatch(readFileSync(new URL("../site/app/main.mjs", import.meta.url), "utf8"), /map\.mjs/);
});

test("every rendered borough and community-district polygon has a matching server label and area-list name", () => {
  const boroughs = ["Manhattan", "Bronx", "Brooklyn", "Queens", "Staten Island"];
  const scopes = [scopeFromLensState("land", {})];
  for (const borough of boroughs) {
    const scope = scopeFromLensState("land", { borough, communityDistrict: null });
    scope.place.viewport = {
      level: "community_district", id: null, parent: borough, basis: "performance", view_box: null,
    };
    scopes.push(scope);
  }
  for (const scope of scopes) {
    const view = buildNearYouViewModel(scope, activity, boundaries);
    const html = renderNearYouBody(view);
    assert.ok(view.features.length > 0, `${view.level}:${view.parent || "citywide"} polygons`);
    for (const feature of view.features) {
      assert.match(html, new RegExp(`data-map-id="${feature.id}"`), `${feature.id} polygon`);
      assert.match(html, new RegExp(`data-map-label="${feature.id}"[^>]+data-area-name="${feature.label}"`), `${feature.id} visible label`);
      assert.match(html, new RegExp(`data-map-area="${feature.id}"[^>]*>[\\s\\S]*?<span>${feature.label}</span>`), `${feature.id} list name`);
    }
  }
});

test("legacy map hashes forward and no-JavaScript area paths stay keyboard native", () => {
  assert.match(routing, /raw==="map"\|\|raw\.startsWith\("map" \+ "\?"\)/);
  assert.match(routing, /location\.replace\(target\)/);
  assert.match(near, /data-map-zoom="in"/);
  assert.match(near, /data-map-pan="west"/);
  assert.doesNotMatch(near, /class="map-district"[^>]+tabindex/);
  assert.match(island, /path\.setAttribute\("role", "link"\)/);
  assert.match(island, /path\.tabIndex = 0/);
  assert.match(island, /svg\.setAttribute\("role", "group"\)/);
  assert.match(near, /<form class="near-form"[^>]+method="get"/);
  assert.match(near, /<a data-map-area=/);
});

test("map drill-throughs carry the shared scope into server-owned area documents", () => {
  for (const lens of ["land", "property"]) {
    assert.match(index, new RegExp(`data-near-you-link[^>]+data-lens="${lens}"|data-lens="${lens}"[^>]+data-near-you-link`));
  }
  for (const lens of ["money", "people", "rules", "meetings"]) {
    assert.doesNotMatch(index, new RegExp(`data-near-you-link[^>]+data-lens="${lens}"|data-lens="${lens}"[^>]+data-near-you-link`));
  }
  assert.match(island, /fetch\(href, \{ headers: \{ Accept: "text\/html" \} \}\)/);
  assert.match(island, /current\.replaceWith\(document\.importNode\(replacement, true\)\)/);
  assert.doesNotMatch(island, /root\.(?:innerHTML|replaceChildren)/);
  const pure = readFileSync(new URL("../site/map_exploration.mjs", import.meta.url), "utf8");
  assert.match(pure, /export function mapDrillListHash/);
  assert.match(pure, /export function bucketFeedLinks/);
  assert.match(pure, /export function districtBagItemIds/);
  assert.match(pure, /export function materializeDistrictBagRows/);
  assert.match(pure, /export async function materializeDistrictBagRowsFromFiles/);
  assert.match(pure, /scope=virtual|locationScope === "virtual"/);
});

test("contract response geography is visibly distinct from performance geography", () => {
  const activity = JSON.parse(readFileSync(new URL("../site/data/district_activity.json", import.meta.url), "utf8"));
  const layer = activity.basis_layers.contract_action_address;
  assert.equal(layer.is_place_of_performance, false);
  assert.match(layer.note, /never merged into performance-place density/);
  for (const [borough, counts] of Object.entries(layer.by_level.borough)) {
    assert.equal(layer.district_items.by_level.borough[borough]?.money?.length || 0, counts.money, borough);
  }
  assert.match(readFileSync(new URL("../site/near_you_view.mjs", import.meta.url), "utf8"), /does not say where the contract work will happen/);
});

test("precomputed district_activity artifact is present and loadable", () => {
  const path = new URL("../site/data/district_activity.json", import.meta.url);
  assert.ok(existsSync(path));
  const doc = JSON.parse(readFileSync(path, "utf8"));
  assert.equal(doc.schema, "cityscroll.district_activity.v1");
  assert.ok(doc.boundary_vintage);
  assert.ok(doc.by_level.borough.Queens);
  assert.ok(Object.keys(doc.by_level.council_district).length >= 51);
  assert.equal(doc.district_items.boundary_vintage, doc.boundary_vintage);
  assert.equal(doc.district_items.built_at, doc.built_at);
  assert.equal(doc.district_items.corpora.property.collection, "property_rows");
  assert.equal(doc.district_items.corpora.meetings.collection, "rows");
  for (const lens of ["land", "property", "rules", "meetings", "money"]) {
    const ids = doc.district_items.by_level.council_district["1"]?.[lens] || [];
    assert.equal(ids.length, doc.by_level.council_district["1"][lens]);
  }
});

test("Row 4 retirements: tax-lien panel is archive-only, not the property list masthead", () => {
  assert.match(index, /id="tax-lien-sale-panel"[^>]*\bhidden\b/);
  assert.match(index, /data-tax-lien-archive="1"/);
  // Stats link removed from property lens header (demote-don't-delete); map explore remains.
  assert.doesNotMatch(index, /property-tax-lien-link"><a href="#property\?view=tax-lien"/);
  assert.match(index, /property_explore_map_link/);
  // Deep link route still paints the archive panel when requested.
  assert.match(source, /["']tax-lien["']/);
  assert.match(source, /paintTaxLienSalePanel|tax-lien-sale-panel/);
});

test("Row 4 retirements: list cards no longer emit per-card mini-steppers", () => {
  assert.doesNotMatch(source, /const miniStepper=`/);
  assert.doesNotMatch(source, /\$\{miniStepper\}/);
  assert.doesNotMatch(source, /class="property-mini-stepper/);
  assert.doesNotMatch(source, /class="rules-mini-stepper/);
  assert.doesNotMatch(source, /class="meetings-mini-stepper/);
  assert.match(index, /property-domain-stepper/);
});

test("demo links cover the map exploration surface", () => {
  const ids = demo.entries.map((e) => e.id);
  assert.ok(ids.includes("map-exploration-boroughs"));
  assert.ok(ids.includes("map-exploration-queens-cd"));
});
