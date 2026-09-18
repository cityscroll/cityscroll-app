// Direct NTA boundary crosswalk delivery contract.
//
//   node --test test/geography_navigation_crosswalk.test.mjs

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { overlayCivicGeographies } from "../site/civic_geography_overlay.mjs";
import {
  GEOGRAPHY_CROSSWALK_COMMISSION_PINS,
  GEOGRAPHY_CROSSWALK_FROM_TYPE,
  GEOGRAPHY_CROSSWALK_GENERATOR,
  GEOGRAPHY_CROSSWALK_MANIFEST_PATH,
  GEOGRAPHY_CROSSWALK_MANIFEST_SCHEMA,
  GEOGRAPHY_CROSSWALK_MATERIALITY,
  GEOGRAPHY_CROSSWALK_MIN_AREA_SQFT,
  GEOGRAPHY_CROSSWALK_PARTITION_TOLERANCE_PCT,
  GEOGRAPHY_CROSSWALK_SHARD_SCHEMA,
  GEOGRAPHY_CROSSWALK_TARGET_TYPES,
  assertNoGeometryPayload,
  assertPartitionCoverage,
  geographyCrosswalkShardPath,
  isMaterialForNavigation,
  projectCrosswalkDeliveryRow,
} from "../site/geography_crosswalk_artifacts.mjs";
import { GEOGRAPHY_NAVIGATION_AREA_OVERLAP_EXAMPLE } from "../site/geography_navigation_capability.mjs";

const ROOT = process.cwd();
const BUILDER_PATH = join("tools", "build_geography_crosswalks.mjs");
const OVERLAY_PATH = join("site", "civic_geography_overlay.mjs");
const ARTIFACTS_PATH = join("site", "geography_crosswalk_artifacts.mjs");

function read(relative) {
  return readFileSync(join(ROOT, relative), "utf8");
}

function readJson(relative) {
  return JSON.parse(read(relative));
}

function loadCommitted() {
  const manifest = readJson(GEOGRAPHY_CROSSWALK_MANIFEST_PATH);
  const shards = Object.fromEntries(
    (manifest.shards || []).map((entry) => [entry.pair_id, readJson(entry.path)]),
  );
  return { manifest, shards };
}

test("A1/A3/A4: committed shards carry provenance-complete BK1503 pins and material projection", () => {
  const { manifest, shards } = loadCommitted();
  assert.equal(manifest.schema, GEOGRAPHY_CROSSWALK_MANIFEST_SCHEMA);
  assert.equal(manifest.from_type, GEOGRAPHY_CROSSWALK_FROM_TYPE);
  assert.deepEqual(manifest.target_types, [...GEOGRAPHY_CROSSWALK_TARGET_TYPES]);
  assert.equal(manifest.threshold.min_area_sqft, GEOGRAPHY_CROSSWALK_MIN_AREA_SQFT);
  assert.deepEqual(manifest.materiality, GEOGRAPHY_CROSSWALK_MATERIALITY);
  assert.deepEqual(manifest.generator, GEOGRAPHY_CROSSWALK_GENERATOR);
  assert.deepEqual(
    manifest.partition_check.tolerance_pct,
    GEOGRAPHY_CROSSWALK_PARTITION_TOLERANCE_PCT,
  );

  for (const pin of GEOGRAPHY_CROSSWALK_COMMISSION_PINS.rows) {
    const pairId = `${GEOGRAPHY_CROSSWALK_FROM_TYPE}__${pin.to_type}`;
    const shard = shards[pairId];
    assert.ok(shard, `missing shard ${pairId}`);
    assert.equal(shard.schema, GEOGRAPHY_CROSSWALK_SHARD_SCHEMA);
    assert.equal(shard.source_vintages.from, GEOGRAPHY_CROSSWALK_COMMISSION_PINS.from_vintage);
    assert.equal(shard.source_vintages.to, pin.to_vintage);
    const row = shard.rows.find((candidate) => (
      candidate.from_key === GEOGRAPHY_CROSSWALK_COMMISSION_PINS.selected_key
      && candidate.to_key === pin.to_key
    ));
    assert.ok(row, `missing pin row ${pin.to_key}`);
    assert.equal(row.relation, pin.relation);
    assert.equal(row.pct_from, pin.pct_from);
    assert.equal(row.material_for_navigation, pin.material_for_navigation);
    assert.equal(row.method, "polygon_intersection_epsg2263");
    assert.equal(row.threshold.min_area_sqft, GEOGRAPHY_CROSSWALK_MIN_AREA_SQFT);
    assert.deepEqual(row.generator, GEOGRAPHY_CROSSWALK_GENERATOR);
    assert.equal(row.source_vintages.from, GEOGRAPHY_CROSSWALK_COMMISSION_PINS.from_vintage);
    assert.equal(row.source_vintages.to, pin.to_vintage);
    assert.equal(
      row.material_for_navigation,
      isMaterialForNavigation(row.pct_from),
    );
    if (pin.intersection_area_sqft != null) {
      assert.equal(row.intersection_area_sqft, pin.intersection_area_sqft);
    }
  }

  const fixture = GEOGRAPHY_NAVIGATION_AREA_OVERLAP_EXAMPLE;
  assert.equal(fixture.selected.key, GEOGRAPHY_CROSSWALK_COMMISSION_PINS.selected_key);
  const bk1503Council = shards.nta2020__council_district.rows.filter((row) => (
    row.from_key === GEOGRAPHY_CROSSWALK_COMMISSION_PINS.selected_key
  ));
  assert.equal(
    bk1503Council.find((row) => row.to_key === "geography:council_district:46").pct_from,
    31.008101,
  );
  assert.equal(
    bk1503Council.find((row) => row.to_key === "geography:council_district:48").pct_from,
    68.986772,
  );
});

test("A2/A7: builder uses the full-fidelity overlay engine and delivery omits geometry", () => {
  const builder = read(BUILDER_PATH);
  const overlay = read(OVERLAY_PATH);
  assert.match(builder, /overlayCivicGeographies/);
  assert.match(builder, /requireFullFidelity:\s*true/);
  assert.match(builder, /GEOGRAPHY_CROSSWALK_MIN_AREA_SQFT/);
  assert.doesNotMatch(builder, /centroid|bounding-box|dominant.?district|sequential/i);
  assert.match(overlay, /geography overlay requires full-fidelity layer artifacts/);

  const { manifest, shards } = loadCommitted();
  assertNoGeometryPayload(manifest);
  for (const shard of Object.values(shards)) {
    assertNoGeometryPayload(shard);
    assert.ok(shard.rows.length > 0);
    for (const row of shard.rows) {
      assert.ok(row.from_key.startsWith("geography:nta2020:"));
      assert.ok(row.to_key.startsWith("geography:"));
      assert.ok(["intersects", "below_threshold", "touches"].includes(row.relation));
      assert.equal(typeof row.intersection_area_sqft, "number");
      assert.equal(typeof row.pct_from, "number");
      assert.equal(typeof row.pct_to, "number");
    }
    const expectedPath = geographyCrosswalkShardPath(
      shard.pair.from_type,
      shard.pair.to_type,
      shard.source_vintages.from,
      shard.source_vintages.to,
    );
    assert.ok(
      manifest.shards.some((entry) => entry.path === expectedPath),
      `manifest missing ${expectedPath}`,
    );
  }

  assert.throws(() => overlayCivicGeographies({
    fromLayer: { geometry_fidelity: "simplified", vintage: { id: "x" } },
    fromFeature: { key: "geography:nta2020:BK1503", geometry: { type: "MultiPolygon", coordinates: [] } },
    toLayer: { geometry_fidelity: "full", vintage: { id: "y" } },
    toFeature: { key: "geography:council_district:48", geometry: { type: "MultiPolygon", coordinates: [] } },
  }), /full-fidelity/);
});

test("A4/A8: sliver suppression is a presentation projection; below_threshold rows stay retained", () => {
  const { shards } = loadCommitted();
  const community = shards.nta2020__community_district.rows.filter((row) => (
    row.from_key === "geography:nta2020:BK1503"
  ));
  const precinct = shards.nta2020__police_precinct.rows.filter((row) => (
    row.from_key === "geography:nta2020:BK1503"
  ));

  const k13 = community.find((row) => row.to_key === "geography:community_district:K13");
  const k15 = community.find((row) => row.to_key === "geography:community_district:K15");
  const k18 = community.find((row) => row.to_key === "geography:community_district:K18");
  const p60 = precinct.find((row) => row.to_key === "geography:police_precinct:60");
  const p61 = precinct.find((row) => row.to_key === "geography:police_precinct:61");

  assert.equal(k13.relation, "intersects");
  assert.equal(k13.pct_from, 0.000327);
  assert.equal(k13.material_for_navigation, false);
  assert.equal(k15.material_for_navigation, true);
  assert.equal(k18.relation, "below_threshold");
  assert.equal(k18.material_for_navigation, false);
  assert.equal(p60.relation, "below_threshold");
  assert.equal(p60.material_for_navigation, false);
  assert.equal(p61.material_for_navigation, true);

  const projected = projectCrosswalkDeliveryRow({
    schema: "cityscroll.geography_crosswalk.v1",
    from_key: "geography:nta2020:BK1503",
    to_key: "geography:community_district:K13",
    relation: "intersects",
    method: "polygon_intersection_epsg2263",
    intersection_area_sqft: 207.012,
    pct_from: 0.000327,
    pct_to: 0.001,
    source_vintages: { from: "26B", to: "2026-05-26" },
    threshold: { min_area_sqft: GEOGRAPHY_CROSSWALK_MIN_AREA_SQFT },
    generator: GEOGRAPHY_CROSSWALK_GENERATOR,
  }, { toType: "community_district" });
  assert.equal(projected.material_for_navigation, false);
});

test("A5: partition totals fail closed on unexplained excess instead of renormalizing", () => {
  assert.throws(() => assertPartitionCoverage([
    { pct_from: 60 },
    { pct_from: 60 },
  ], {
    fromKey: "geography:nta2020:BK1503",
    toType: "council_district",
    subtype: "residential",
  }), /exceeds 100|refusing silent renormalization/);

  assert.throws(() => assertPartitionCoverage([
    { pct_from: 50 },
  ], {
    fromKey: "geography:nta2020:BK1503",
    toType: "council_district",
    subtype: "residential",
  }), /unexplained gap|refusing silent renormalization/);

  assert.doesNotThrow(() => assertPartitionCoverage([
    { pct_from: 31.008101 },
    { pct_from: 68.986772 },
  ], {
    fromKey: "geography:nta2020:BK1503",
    toType: "council_district",
    subtype: "residential",
  }));
});

test("A6: source vintage or hash drift fails check binding for the affected layer", async () => {
  const { assertRegistryBinding } = await import("../tools/build_geography_crosswalks.mjs");
  const { manifest } = loadCommitted();
  const registry = readJson("site/data/geography/layer_registry.json");

  assert.doesNotThrow(() => assertRegistryBinding(manifest, registry));

  const driftedVintage = structuredClone(manifest);
  driftedVintage.source_layers.nta2020.boundary_vintage = "99Z";
  assert.throws(
    () => assertRegistryBinding(driftedVintage, registry),
    /crosswalk vintage drift for nta2020/,
  );

  const driftedHash = structuredClone(manifest);
  driftedHash.source_layers.council_district.full_sha256 = "0".repeat(64);
  assert.throws(
    () => assertRegistryBinding(driftedHash, registry),
    /crosswalk source-hash drift for council_district/,
  );
});

test("A8 hard negative: sequential NTA→community-district→Council lookup is unused", () => {
  const builder = read(BUILDER_PATH);
  assert.doesNotMatch(builder, /resolveCivicGeographies/);
  assert.doesNotMatch(builder, /dominant/i);
  assert.doesNotMatch(builder, /NTA\s*→\s*CD\s*→\s*Council|nta.*community_district.*council_district.*infer/i);

  const { shards } = loadCommitted();
  const community = shards.nta2020__community_district.rows.filter((row) => (
    row.from_key === "geography:nta2020:BK1503" && row.material_for_navigation
  ));
  const council = shards.nta2020__council_district.rows.filter((row) => (
    row.from_key === "geography:nta2020:BK1503" && row.material_for_navigation
  ));

  // A sequential NTA→CD→Council shortcut would collapse BK1503 onto the single
  // material community district (K15) and invent one Council home. Direct
  // overlay keeps both Council 46 and 48.
  assert.deepEqual(community.map((row) => row.to_key), ["geography:community_district:K15"]);
  assert.deepEqual(
    council.map((row) => row.to_key).sort(),
    ["geography:council_district:46", "geography:council_district:48"],
  );
  assert.equal(council.length, 2);
});

test("A9: check mode is wired into repository verification", () => {
  const preflight = read(join("tools", "preflight-required-checks.sh"));
  assert.match(preflight, /build_geography_crosswalks\.mjs --check/);
  assert.match(read(BUILDER_PATH), /--check/);
});
