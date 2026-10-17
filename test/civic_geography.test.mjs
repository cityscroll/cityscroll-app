import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
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
import { writeFirstFour } from "../tools/build_civic_geography.mjs";
import {
  compatibilityDistrictLayer,
  fixtureBundle,
  writeLayerDocument,
} from "../tools/build_district_boundaries.mjs";
import {
  jsonText,
  layerWithoutBuiltAt,
  semanticLayerEqual,
  sha256Text,
} from "../tools/lib/geography_layer_builder.mjs";
import {
  normalizeCommunityDistrictSource,
  normalizeCouncilDistrictSource,
} from "../tools/lib/district_boundary_source_adapters.mjs";
import { withTempDir } from "../tools/lib/with_temp_dir.mjs";

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

test("semantic layer equality ignores built_at restamps only", () => {
  const base = {
    schema: "cityscroll.geography_layer.v1",
    type: "nta2020",
    built_at: "2026-09-30T13:15:20.219Z",
    vintage: { id: "26B" },
    features: [{ id: "MN0401", label: "Chelsea-Hudson Yards" }],
  };
  const restamped = {
    ...base,
    built_at: "2026-10-17T01:53:51.743Z",
  };
  const changed = {
    ...restamped,
    features: [{ id: "MN0401", label: "Chelsea" }],
  };
  assert.deepEqual(layerWithoutBuiltAt(base).built_at, undefined);
  assert.equal(semanticLayerEqual(base, restamped), true);
  assert.equal(semanticLayerEqual(base, changed), false);
});

test("unchanged geography layer rewrite keeps prior bytes when only built_at differs", async () => {
  await withTempDir("geo-layer-preserve", async (dir) => {
    const path = join(dir, "nta2020.json");
    const original = {
      schema: "cityscroll.geography_layer.v1",
      type: "nta2020",
      built_at: "2026-09-30T13:15:20.219Z",
      vintage: { id: "26B" },
      features: [{ id: "MN0401", label: "Chelsea-Hudson Yards" }],
    };
    const first = writeLayerDocument(path, original);
    assert.equal(first.preserved, false);
    const before = readFileSync(path, "utf8");
    assert.equal(before, jsonText(original));

    const restamped = {
      ...original,
      built_at: "2026-10-17T01:53:51.743Z",
    };
    const second = writeLayerDocument(path, restamped);
    assert.equal(second.preserved, true);
    assert.equal(readFileSync(path, "utf8"), before);
    assert.equal(second.text, before);

    const contentChanged = {
      ...restamped,
      features: [{ id: "MN0401", label: "Chelsea" }],
    };
    const third = writeLayerDocument(path, contentChanged);
    assert.equal(third.preserved, false);
    assert.equal(readFileSync(path, "utf8"), jsonText(contentChanged));
  });
});

function writeJsonFile(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function squareRing(x, y) {
  return [[x, y], [x + 0.01, y], [x + 0.01, y + 0.01], [x, y + 0.01], [x, y]];
}

function polygonFeature(properties, x = 0, y = 0) {
  return {
    type: "Feature",
    properties,
    geometry: { type: "Polygon", coordinates: [squareRing(x, y)] },
  };
}

/** Seed a temp repo root + source dir for a hermetic writeFirstFour pass. */
function seedWriteFirstFourFixture(root, sourceDir, { ntaLabel = "Financial District-Seaport" } = {}) {
  const baseline = JSON.parse(
    readFileSync(new URL("../site/data/geography/layer_registry.json", import.meta.url), "utf8"),
  );
  // Keep the three baseline rows; first-four rows are replaced by the writer.
  const seedRegistry = {
    ...baseline,
    layers: baseline.layers.filter((row) => (
      row.type === "borough"
      || row.type === "community_district"
      || row.type === "council_district"
    )),
  };
  writeJsonFile(join(root, "site/data/geography/layer_registry.json"), seedRegistry);
  writeJsonFile(join(root, "worker/src/data/geography/layer_registry.json"), seedRegistry);
  writeJsonFile(join(root, "ontology/geography/bid_reviewed_ids.json"), {
    schema: "cityscroll.reviewed_bid_identity_registry.v1",
    entries: [{
      source_row_id: "1",
      source_name: "Alliance for Downtown New York",
      canonical_slug: "alliance-for-downtown-new-york",
    }],
  });

  mkdirSync(sourceDir, { recursive: true });
  writeJsonFile(join(sourceDir, "nta.geojson"), {
    type: "FeatureCollection",
    features: [polygonFeature({
      NTA2020: "MN0101",
      NTAName: ntaLabel,
      NTAType: "0",
      BoroCode: "1",
      CDTA2020: "MN01",
    })],
  });
  writeFileSync(join(sourceDir, "nynta2020_26b.zip"), "nta-acquisition-bytes");
  writeJsonFile(join(sourceDir, "pp.geojson"), {
    type: "FeatureCollection",
    features: [polygonFeature({ Precinct: "1" }, 0.02, 0)],
  });
  writeFileSync(join(sourceDir, "nypp_26b.zip"), "pp-acquisition-bytes");
  writeJsonFile(join(sourceDir, "dsny.geojson"), {
    type: "FeatureCollection",
    features: [polygonFeature({
      districtcode: "101",
      district: "Manhattan 1",
      objectid: "9",
    }, 0.04, 0)],
  });
  writeJsonFile(join(sourceDir, "bid.geojson"), {
    type: "FeatureCollection",
    features: [polygonFeature({
      objectid_2: "1",
      f_all_bi_2: "Alliance for Downtown New York",
      f_all_bids: "0.0",
    }, 0.06, 0)],
  });
}

function assertReceiptRegistryDiskAgree(root, type) {
  const registry = JSON.parse(readFileSync(join(root, "site/data/geography/layer_registry.json"), "utf8"));
  const row = registry.layers.find((candidate) => candidate.type === type);
  assert.ok(row, `${type} registry row`);
  const fullText = readFileSync(join(root, row.artifacts.full.path), "utf8");
  const siteText = readFileSync(join(root, row.artifacts.simplified.site_path), "utf8");
  const receipt = JSON.parse(readFileSync(join(root, row.receipt.path), "utf8"));
  assert.equal(row.artifacts.full.sha256, sha256Text(fullText), `${type} registry full digest`);
  assert.equal(row.artifacts.simplified.sha256, sha256Text(siteText), `${type} registry simplified digest`);
  assert.equal(receipt.artifacts.full.sha256, sha256Text(fullText), `${type} receipt full digest`);
  assert.equal(receipt.artifacts.simplified.sha256, sha256Text(siteText), `${type} receipt simplified digest`);
  return { row, fullText, siteText, receipt };
}

test("writeFirstFour preserves bytes and keeps receipt+registry digests aligned on built_at-only rebuild", async () => {
  await withTempDir("civic-geo-write-first-four", async (dir) => {
    const root = join(dir, "repo");
    const sourceDir = join(dir, "sources");
    seedWriteFirstFourFixture(root, sourceDir);

    const first = writeFirstFour({
      sourceDir,
      builtAt: "2026-09-30T13:15:20.219Z",
      root,
    });
    assert.equal(first.layers.length, 7);
    const before = assertReceiptRegistryDiskAgree(root, "nta2020");

    const second = writeFirstFour({
      sourceDir,
      builtAt: "2026-10-17T01:53:51.743Z",
      root,
    });
    assert.equal(second.layers.length, 7);
    const after = assertReceiptRegistryDiskAgree(root, "nta2020");
    assert.equal(after.fullText, before.fullText, "full layer bytes must stay preserved");
    assert.equal(after.siteText, before.siteText, "simplified layer bytes must stay preserved");
    assert.equal(after.receipt.artifacts.full.sha256, before.receipt.artifacts.full.sha256);
    assert.equal(after.row.artifacts.full.sha256, before.row.artifacts.full.sha256);
    assert.notEqual(
      JSON.parse(after.fullText).built_at,
      "2026-10-17T01:53:51.743Z",
      "preserved layer must keep the original built_at",
    );

    // Real content change must rewrite bytes and advance every digest together.
    seedWriteFirstFourFixture(root, sourceDir, { ntaLabel: "Financial District" });
    const third = writeFirstFour({
      sourceDir,
      builtAt: "2026-10-17T02:00:00.000Z",
      root,
    });
    assert.equal(third.layers.length, 7);
    const changed = assertReceiptRegistryDiskAgree(root, "nta2020");
    assert.notEqual(changed.fullText, before.fullText);
    assert.notEqual(changed.receipt.artifacts.full.sha256, before.receipt.artifacts.full.sha256);
    assert.notEqual(changed.row.artifacts.full.sha256, before.row.artifacts.full.sha256);
    assert.match(changed.fullText, /Financial District/);
  });
});
