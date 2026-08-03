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

test("precomputed district_activity artifact is present and loadable", () => {
  const path = new URL("../site/data/district_activity.json", import.meta.url);
  assert.ok(existsSync(path));
  const doc = JSON.parse(readFileSync(path, "utf8"));
  assert.equal(doc.schema, "cityscroll.district_activity.v1");
  assert.ok(doc.boundary_vintage);
  assert.ok(doc.by_level.borough.Queens);
  assert.ok(Object.keys(doc.by_level.council_district).length >= 51);
});

test("Row 4 retirements: tax-lien panel is not the property list masthead", () => {
  assert.match(index, /id="tax-lien-sale-panel"[^>]*\bhidden\b/);
  assert.match(index, /property\?view=tax-lien/);
  assert.match(index, /property_tax_lien_link/);
  assert.match(index, /property_explore_map_link/);
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
