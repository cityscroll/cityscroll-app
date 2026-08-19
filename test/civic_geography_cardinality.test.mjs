import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import {
  pointRelationToCivicFeature,
  resolveCivicGeographies,
} from "../site/civic_geography.mjs";
import { overlayCivicGeographies } from "../site/civic_geography_overlay.mjs";

const ROOT = new URL("../", import.meta.url);
const readJson = (path) => JSON.parse(readFileSync(new URL(path, ROOT), "utf8"));
const registry = readJson("site/data/geography/layer_registry.json");
const canaries = readJson("data/geography/qa/first_four_point_canaries.json");

function row(type) {
  return registry.layers.find((candidate) => candidate.type === type);
}

function layer(type, fidelity = "simplified") {
  const registered = row(type);
  const path = fidelity === "full"
    ? registered.artifacts.full.path
    : registered.artifacts.simplified.site_path;
  return readJson(path);
}

test("well-inside PIP canaries cover all five boroughs without inventing sparse BID membership", () => {
  assert.deepEqual(canaries.well_inside.map((canary) => canary.borough), [
    "Manhattan",
    "Bronx",
    "Brooklyn",
    "Queens",
    "Staten Island",
  ]);
  const types = Object.keys(canaries.well_inside[0].expected);
  const layers = types.map((type) => layer(type));
  for (const canary of canaries.well_inside) {
    const result = resolveCivicGeographies(canary.lat, canary.lon, { types, layerData: layers });
    for (const type of types) {
      const ids = result.matches.filter((match) => match.type === type).map((match) => match.id).sort();
      assert.deepEqual(ids, [...canary.expected[type]].sort(), `${canary.id}:${type}`);
    }
  }
});

test("near-boundary canaries remain explicit ambiguous boundary observations", () => {
  for (const canary of canaries.near_boundary) {
    const result = resolveCivicGeographies(canary.lat, canary.lon, {
      types: [canary.type],
      layerData: [layer(canary.type, "full")],
    });
    assert.equal(result.layers[0].status, canary.expected_status, canary.type);
    assert.deepEqual(result.matches.map((match) => match.id).sort(), [...canary.expected_ids].sort());
    assert.ok(result.matches.every((match) => match.method === "point_on_polygon_boundary"));
  }
});

test("real source holes exclude points and secondary multipart polygons admit them", () => {
  for (const canary of canaries.hole) {
    const feature = layer(canary.type, "full").features.find((candidate) => candidate.id === canary.feature_id);
    assert.equal(pointRelationToCivicFeature(canary.lon, canary.lat, feature), canary.expected_relation, `${canary.type}:${canary.feature_id}`);
  }
  for (const canary of canaries.multipart) {
    const feature = layer(canary.type, "full").features.find((candidate) => candidate.id === canary.feature_id);
    const isolatedPart = {
      ...feature,
      bbox: null,
      geometry: { type: "MultiPolygon", coordinates: [feature.geometry.coordinates[canary.part_index]] },
    };
    assert.equal(pointRelationToCivicFeature(canary.lon, canary.lat, isolatedPart), canary.expected_relation, `${canary.type}:${canary.feature_id}`);
  }
});

test("BID zero-or-more cardinality admits real overlaps without calling them boundary ambiguity", () => {
  const canary = canaries.allowed_overlap[0];
  const result = resolveCivicGeographies(canary.lat, canary.lon, {
    types: [canary.type],
    layerData: [layer(canary.type, "full")],
  });
  assert.equal(result.layers[0].status, "matched");
  assert.equal(result.layers[0].match_count, 2);
  assert.deepEqual(result.matches.map((match) => match.id).sort(), [...canary.expected_ids].sort());
});

test("DSNY congruence remains an independent equivalence/drift canary", () => {
  const receipt = readJson("data/geography/qa/sanitation_community_district_equivalence.json");
  const sanitation = layer("sanitation_district", "full");
  const community = layer("community_district", "full");
  const prefix = { 1: "M", 2: "X", 3: "K", 4: "Q", 5: "R" };
  assert.equal(sanitation.features.length, receipt.comparison.pair_count);
  assert.equal(community.features.filter((feature) => feature.subtype === "regular").length, 59);
  for (const expected of receipt.largest_observed_drifts) {
    const fromFeature = sanitation.features.find((feature) => feature.id === expected.sanitation_district);
    const expectedCommunityId = `${prefix[fromFeature.id[0]]}${fromFeature.id.slice(1)}`;
    assert.equal(expectedCommunityId, expected.community_district);
    const toFeature = community.features.find((feature) => feature.id === expectedCommunityId);
    const comparison = overlayCivicGeographies({
      fromLayer: sanitation,
      fromFeature,
      toLayer: community,
      toFeature,
    });
    assert.equal(comparison.pct_from, expected.pct_from);
    assert.equal(comparison.pct_to, expected.pct_to);
  }
  assert.equal(receipt.comparison.status, "drift_observed");
});

test("gs-03 layer names do not enter resident scope, Browse, map, or Near You surfaces", () => {
  const residentSurfaces = [
    "site/scope_v0.mjs",
    "site/browse_view.mjs",
    "site/map_exploration.mjs",
    "site/near_you_view.mjs",
    "site/app/feed-actions.mjs",
    "site/app/core.mjs",
  ];
  const prohibited = ["nta2020", "police_precinct", "sanitation_district", "business_improvement_district"];
  for (const path of residentSurfaces) {
    const source = readFileSync(new URL(path, ROOT), "utf8");
    for (const type of prohibited) assert.ok(!source.includes(type), `${path} exposes ${type}`);
  }
  const contracts = readJson("site/data/source_contracts.json");
  for (const type of prohibited) {
    const sourceId = row(type).source.contract_id;
    assert.equal(contracts.contracts.find((contract) => contract.id === sourceId).health_policy.public_visibility, "backstage-only");
  }
});
