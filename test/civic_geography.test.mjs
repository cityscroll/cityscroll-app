import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { test } from "node:test";

import {
  CIVIC_GEOGRAPHY_LAYERS,
  GEOGRAPHY_LAYER_REGISTRY_SCHEMA,
  civicGeographyKey,
  validateCivicGeographyRegistry,
} from "../site/civic_geography_registry.mjs";
import {
  loadCivicGeographyLayer,
  resolveCivicGeographies,
} from "../site/civic_geography.mjs";
import {
  compatibilityDistrictLayer,
  fixtureBundle,
} from "../tools/build_district_boundaries.mjs";
import {
  normalizeCommunityDistrictSource,
  normalizeCouncilDistrictSource,
} from "../tools/lib/district_boundary_source_adapters.mjs";

test("the registry is closed to the three baseline and four independently acquired layers", () => {
  assert.deepEqual(
    CIVIC_GEOGRAPHY_LAYERS.map((layer) => layer.type),
    [
      "borough",
      "community_district",
      "council_district",
      "nta2020",
      "police_precinct",
      "sanitation_district",
      "business_improvement_district",
    ],
  );
  assert.deepEqual(CIVIC_GEOGRAPHY_LAYERS.map((layer) => layer.class), [
    "administrative",
    "community_administrative",
    "political",
    "statistical",
    "service_administrative",
    "service_administrative",
    "economic_institutional",
  ]);
  assert.equal(civicGeographyKey("borough", "4"), "geography:borough:4");
  assert.equal(civicGeographyKey("community_district", "Q04"), "geography:community_district:Q04");
  assert.equal(civicGeographyKey("council_district", "25"), "geography:council_district:25");
  assert.equal(civicGeographyKey("police_precinct", "110"), "geography:police_precinct:110");
  assert.deepEqual(
    CIVIC_GEOGRAPHY_LAYERS.filter((layer) => layer.declared_uses.includes("near_you_scope")).map((layer) => layer.type),
    ["borough", "community_district", "council_district", "nta2020", "police_precinct"],
  );
  assert.ok(CIVIC_GEOGRAPHY_LAYERS
    .filter((layer) => layer.declared_uses.includes("near_you_scope"))
    .every((layer) => layer.declared_uses.includes("watch_scope")));
});

test("source-specific adapters stop source-native column names at the boundary", () => {
  const square = [[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]];
  const community = normalizeCommunityDistrictSource({
    features: [{ properties: { boro_cd: "404" }, geometry: { type: "Polygon", coordinates: [square] } }],
  });
  const council = normalizeCouncilDistrictSource({
    features: [{ properties: { coundist: "025" }, geometry: { type: "Polygon", coordinates: [square] } }],
  });
  assert.equal(community[0].id, "Q04");
  assert.deepEqual(community[0].source_properties, { boro_cd: "404" });
  assert.equal(council[0].id, "25");
  assert.deepEqual(council[0].source_properties, { coundist: "25" });
});

test("generic point resolution returns typed matches with independent layer clocks", () => {
  const bundle = fixtureBundle();
  bundle.layers.community_district.simplified.vintage.id = "2025-01-02";
  bundle.layers.council_district.simplified.vintage.id = "2026-03-04";
  const result = resolveCivicGeographies(40.7473, -73.8832, {
    types: ["borough", "community_district", "council_district"],
    layerData: Object.values(bundle.layers).map((pair) => pair.simplified),
  });
  assert.deepEqual(result.matches.map(({ type, id, boundary_vintage }) => ({ type, id, boundary_vintage })), [
    { type: "borough", id: "4", boundary_vintage: "2026-05-26" },
    { type: "community_district", id: "Q04", boundary_vintage: "2025-01-02" },
    { type: "council_district", id: "25", boundary_vintage: "2026-03-04" },
  ]);
  assert.ok(result.layers.every((layer) => layer.status === "matched"));
});

test("one unavailable layer does not erase healthy matches", () => {
  const bundle = fixtureBundle();
  const result = resolveCivicGeographies(40.7473, -73.8832, {
    types: ["borough", "community_district", "council_district"],
    layerData: [bundle.layers.community_district.simplified],
  });
  assert.deepEqual(result.matches.map((match) => [match.type, match.id]), [["community_district", "Q04"]]);
  assert.equal(result.layers.find((layer) => layer.type === "borough").status, "source_unavailable");
  assert.equal(result.layers.find((layer) => layer.type === "community_district").status, "matched");
  assert.equal(result.layers.find((layer) => layer.type === "council_district").status, "source_unavailable");
});

test("the compatibility view alone retains the conservative minimum clock", () => {
  const bundle = fixtureBundle();
  bundle.layers.community_district.simplified.vintage.id = "2025-01-02";
  bundle.layers.council_district.simplified.vintage.id = "2026-03-04";
  const compatibility = compatibilityDistrictLayer(bundle.layers, bundle.builtAt);
  assert.equal(compatibility.boundary_vintage, "2025-01-02");
  assert.equal(compatibility.sources.community_district.boundary_vintage, "2025-01-02");
  assert.equal(compatibility.sources.council_district.boundary_vintage, "2026-03-04");
  assert.deepEqual(Object.keys(compatibility).sort(), [
    "boundary_vintage",
    "built_at",
    "community_district_count",
    "community_districts",
    "council_district_count",
    "council_districts",
    "crs",
    "schema",
    "simplify_tolerance_deg",
    "sources",
  ]);
});

test("committed registry points to full and simplified artifacts for every layer", () => {
  const path = new URL("../site/data/geography/layer_registry.json", import.meta.url);
  assert.ok(existsSync(path), "run: node tools/build_district_boundaries.mjs");
  const registry = JSON.parse(readFileSync(path, "utf8"));
  assert.equal(registry.schema, GEOGRAPHY_LAYER_REGISTRY_SCHEMA);
  assert.deepEqual(validateCivicGeographyRegistry(registry), []);
  assert.equal(registry.layers.length, 7);
  for (const row of registry.layers) {
    const fullPath = new URL(`../${row.artifacts.full.path}`, import.meta.url);
    const simplifiedPath = new URL(`../${row.artifacts.simplified.site_path}`, import.meta.url);
    assert.ok(existsSync(fullPath));
    assert.ok(existsSync(simplifiedPath));
    const full = loadCivicGeographyLayer(JSON.parse(readFileSync(fullPath, "utf8")));
    const simplified = loadCivicGeographyLayer(JSON.parse(readFileSync(simplifiedPath, "utf8")));
    assert.equal(full.geometry_fidelity, "full");
    assert.equal(simplified.geometry_fidelity, "simplified");
    assert.equal(full.vintage.id, row.boundary_vintage);
    assert.equal(simplified.vintage.id, row.boundary_vintage);
    assert.deepEqual(full.features.map((feature) => feature.key), simplified.features.map((feature) => feature.key));
  }
});
