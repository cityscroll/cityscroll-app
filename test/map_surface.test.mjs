import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { test } from "node:test";
import { SITE_SOURCE } from "./helpers/site_source.mjs";

const index = readFileSync(new URL("../site/index.html", import.meta.url), "utf8");
const i18n = readFileSync(new URL("../site/i18n.js", import.meta.url), "utf8");
const demo = JSON.parse(
  readFileSync(new URL("../site/demo/demo-links.json", import.meta.url), "utf8"),
);
const source = SITE_SOURCE;

test("map tab surface is wired without a proprietary map SDK", () => {
  assert.match(index, /data-tab="map"/);
  assert.match(index, /id="tab-map"/);
  assert.match(index, /id="mapSvg"/);
  assert.match(source, /function paintMapExploration/);
  assert.match(source, /import\("\.\.\/map_exploration\.mjs"\)/);
  assert.match(source, /data\/district_activity\.json/);
  assert.match(source, /data\/district_boundaries\.json/);
  assert.doesNotMatch(source, /mapbox|google\.maps|Mapbox/i);
  assert.match(i18n, /tab_map:\s*"Map"/);
  assert.match(i18n, /map_boundary_vintage/);
  assert.match(readFileSync(new URL("../site/app/main.mjs", import.meta.url), "utf8"), /map\.mjs/);
});

test("map hash grammar and keyboard district paths exist", () => {
  assert.match(source, /tab === "map"/);
  assert.match(index, /data-map-zoom="in"/);
  assert.match(index, /data-map-pan="west"/);
  assert.match(source, /tabindex="0"/);
  assert.match(index, /id="mapAreaList"/);
});

test("map drill-throughs carry scope into list hashes (not bare lens tabs)", () => {
  // Map detail uses pure bucketFeedLinks / areaFeedLinks (dynamic import).
  assert.match(source, /bucketFeedLinks\(bucketSel\.kind/);
  assert.match(source, /areaFeedLinks\(sel\.level, sel\.id/);
  assert.match(source, /map-count-link/);
  // Virtual bag must not link to bare #meetings.
  assert.doesNotMatch(source, /bucketSel\.kind==="virtual"\?`<a class="act" href="#meetings"/);
  // Scope tokens land in meetings / rules list grammar.
  assert.match(index, /value="virtual"/);
  assert.match(index, /id="rulesboro"/);
  assert.match(source, /scopePlaces|locationScope.*virtual|place==="virtual"/);
  const pure = readFileSync(new URL("../site/map_exploration.mjs", import.meta.url), "utf8");
  assert.match(pure, /export function mapDrillListHash/);
  assert.match(pure, /export function bucketFeedLinks/);
  assert.match(pure, /export function districtBagItemIds/);
  assert.match(pure, /export function materializeDistrictBagRows/);
  assert.match(pure, /export async function materializeDistrictBagRowsFromFiles/);
  assert.match(source, /filterFeedRowsToDistrictBag\("property",rows\)/);
  assert.match(source, /filterFeedRowsToDistrictBag\("meetings",/);
  assert.match(source, /setMeetingsResultCount\(uniqueRows\.length\)/);
  assert.match(source, /const totalCount=feedVisible\.property\.length/);
  assert.match(pure, /scope=virtual|locationScope === "virtual"/);
});

test("contract response geography is visibly distinct from performance geography", () => {
  assert.match(index, /id="mapMoneyBasisRow"/);
  assert.match(index, /id="mapMoneyBasisNote"/);
  assert.match(index, /id="moneylocationbasis"/);
  assert.match(index, /value="submission_address"/);
  assert.match(index, /value="pre_bid_venue"/);
  assert.match(index, /value="document_pickup"/);
  assert.match(i18n, /map_money_basis_performance:\s*"Where work may affect a district"/);
  assert.match(i18n, /money_location_basis_submission:\s*"Located by submission address"/);
  assert.match(i18n, /not where the contracted work will happen/);
  assert.match(source, /basis_layers\.contract_action_address/);
  assert.match(source, /basis:\s*mapState\.basis/);
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
  for (const lens of ["property", "meetings"]) {
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
