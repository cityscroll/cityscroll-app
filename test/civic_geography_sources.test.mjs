import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import {
  CIVIC_GEOGRAPHY_LAYERS,
  civicGeographyKey,
} from "../site/civic_geography_registry.mjs";
import { buildFirstFourLayers } from "../tools/build_civic_geography.mjs";
import { sha256Text } from "../tools/lib/geography_layer_builder.mjs";
import {
  normalizeBusinessImprovementDistrictSource,
  normalizeNta2020Source,
} from "../tools/lib/civic_geography_source_adapters.mjs";

const ROOT = new URL("../", import.meta.url);
const readJson = (path) => JSON.parse(readFileSync(new URL(path, ROOT), "utf8"));
const registry = readJson("site/data/geography/layer_registry.json");
const firstFour = [
  "nta2020",
  "police_precinct",
  "sanitation_district",
  "business_improvement_district",
];

function square(x = 0, y = 0) {
  return [[x, y], [x + 0.01, y], [x + 0.01, y + 0.01], [x, y + 0.01], [x, y]];
}

test("registry adds four ingestion-only layer identities with independent clocks", () => {
  assert.deepEqual(CIVIC_GEOGRAPHY_LAYERS.map((layer) => layer.type), [
    "borough",
    "community_district",
    "council_district",
    ...firstFour,
  ]);
  assert.equal(civicGeographyKey("nta2020", "MN0101"), "geography:nta2020:MN0101");
  assert.equal(civicGeographyKey("police_precinct", "110"), "geography:police_precinct:110");
  assert.equal(civicGeographyKey("sanitation_district", "402"), "geography:sanitation_district:402");
  assert.equal(
    civicGeographyKey("business_improvement_district", "alliance-for-downtown-new-york"),
    "geography:business_improvement_district:alliance-for-downtown-new-york",
  );

  const rows = firstFour.map((type) => registry.layers.find((row) => row.type === type));
  assert.deepEqual(rows.map((row) => row.boundary_vintage), ["26B", "26B", "2024-04-10", "2024-10-08"]);
  assert.ok(rows.every((row) => row.public_relations.length === 0));
  assert.ok(rows.every((row) => !row.declared_uses.includes("filter")));
});

test("every new layer has unique IDs, separate fidelity artifacts, and a fingerprinted receipt", () => {
  for (const type of firstFour) {
    const row = registry.layers.find((candidate) => candidate.type === type);
    const fullText = readFileSync(new URL(row.artifacts.full.path, ROOT), "utf8");
    const simplifiedText = readFileSync(new URL(row.artifacts.simplified.site_path, ROOT), "utf8");
    const workerText = readFileSync(new URL(row.artifacts.simplified.worker_path, ROOT), "utf8");
    const receiptText = readFileSync(new URL(row.receipt.path, ROOT), "utf8");
    const full = JSON.parse(fullText);
    const simplified = JSON.parse(simplifiedText);
    const receipt = JSON.parse(receiptText);
    assert.equal(full.geometry_fidelity, "full");
    assert.equal(simplified.geometry_fidelity, "simplified");
    assert.notEqual(sha256Text(fullText), sha256Text(simplifiedText));
    assert.equal(simplifiedText, workerText);
    assert.equal(sha256Text(fullText), row.artifacts.full.sha256);
    assert.equal(sha256Text(simplifiedText), row.artifacts.simplified.sha256);
    assert.equal(sha256Text(receiptText), row.receipt.sha256);
    assert.equal(receipt.boundary_vintage, row.boundary_vintage);
    assert.equal(new Set(full.features.map((feature) => feature.id)).size, full.features.length);
    assert.deepEqual(full.features.map((feature) => feature.key), simplified.features.map((feature) => feature.key));
  }
});

test("NTA special statistical areas retain closed subtypes and are not neighborhood aliases", () => {
  const row = registry.layers.find((candidate) => candidate.type === "nta2020");
  const layer = readJson(row.artifacts.full.path);
  const counts = {};
  for (const feature of layer.features) counts[feature.subtype] = (counts[feature.subtype] || 0) + 1;
  assert.deepEqual(counts, {
    residential: 197,
    rikers_island: 1,
    special_use: 8,
    cemetery: 14,
    airport: 2,
    park: 40,
  });
  assert.ok(!row.declared_uses.includes("canonical_neighborhood_identity"));
});

test("BID identity is reviewed, source-bound, and rejects zero source rows", () => {
  const reviewed = readJson("ontology/geography/bid_reviewed_ids.json");
  const row = registry.layers.find((candidate) => candidate.type === "business_improvement_district");
  const layer = readJson(row.artifacts.full.path);
  const receipt = readJson(row.receipt.path);
  assert.equal(reviewed.entries.length, 74);
  assert.equal(layer.feature_count, 74);
  assert.deepEqual(receipt.admission.rejected_features.map((entry) => entry.source_name), [
    "Long Island City Partnership",
    "Cypress Hills Fulton",
  ]);
  const reviewedBindings = new Set(reviewed.entries.map((entry) =>
    `${entry.source_row_id}\u0000${entry.source_name}\u0000${entry.canonical_slug}`));
  assert.ok(layer.features.every((feature) => reviewedBindings.has(
    `${feature.source_properties.source_row_id}\u0000${feature.source_properties.source_name}\u0000${feature.id}`,
  )));
});

test("source adapters reject duplicate IDs and unreviewed BID bindings", () => {
  const nta = { properties: { NTA2020: "MN0101", NTAName: "Financial District-Seaport", NTAType: "0" }, geometry: { type: "Polygon", coordinates: [square()] } };
  assert.throws(() => normalizeNta2020Source({ features: [nta, structuredClone(nta)] }), /duplicate canonical id/);

  const bidSource = {
    features: [{
      properties: { objectid_2: "1", f_all_bi_2: "Unexpected Publisher Rename", f_all_bids: "0.0" },
      geometry: { type: "Polygon", coordinates: [square()] },
    }],
  };
  assert.throws(() => normalizeBusinessImprovementDistrictSource(bidSource, {
    schema: "cityscroll.reviewed_bid_identity_registry.v1",
    entries: [{ source_row_id: "1", source_name: "Union Square Partnership", canonical_slug: "union-square-partnership" }],
  }), /lacks reviewed canonical slug/);
});

test("first-four generation is deterministic for fixed sources and build clock", () => {
  const sources = {
    nta2020: { features: [{ properties: { NTA2020: "MN0101", NTAName: "Financial District-Seaport", NTAType: "0", BoroCode: "1", CDTA2020: "MN01" }, geometry: { type: "Polygon", coordinates: [square()] } }] },
    police_precinct: { features: [{ properties: { Precinct: 1 }, geometry: { type: "Polygon", coordinates: [square()] } }] },
    sanitation_district: { features: [{ properties: { districtcode: "101", district: "MN01", objectid: "72" }, geometry: { type: "Polygon", coordinates: [square()] } }] },
    business_improvement_district: { features: [{ properties: { objectid_2: "1", f_all_bi_2: "Union Square Partnership", f_all_bids: "0.0" }, geometry: { type: "Polygon", coordinates: [square()] } }] },
  };
  const reviewedBidIds = {
    schema: "cityscroll.reviewed_bid_identity_registry.v1",
    entries: [{ source_row_id: "1", source_name: "Union Square Partnership", canonical_slug: "union-square-partnership" }],
  };
  const options = { sources, reviewedBidIds, builtAt: "2026-08-18T16:00:00.000Z" };
  assert.deepEqual(buildFirstFourLayers(options), buildFirstFourLayers(structuredClone(options)));
});
