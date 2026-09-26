/**
 * Land project-lot place membership — all published lots join.
 *
 *   node --test test/land_place_membership.test.mjs
 */

import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { normalizeBbl } from "../site/bbl_mappluto_centroids.mjs";
import {
  LAND_PROJECT_CATALOG_SCHEMA,
  buildLandProjectCatalog,
} from "../site/land_project_catalog.mjs";
import {
  LAND_PLACE_ASSOCIATION_KIND,
  LAND_PLACE_BBL_ASSOCIATION_STATES,
  LAND_PLACE_EVIDENCE_DIR,
  LAND_PLACE_EVIDENCE_SHARD_COUNT,
  LAND_PLACE_EVIDENCE_SHARD_SCHEMA,
  LAND_PLACE_LAYERS,
  LAND_PLACE_MEMBERSHIP_PATH,
  LAND_PLACE_MEMBERSHIP_SCHEMA,
  buildLandPlaceMembership,
  indexProjectBblAssociations,
  landPlaceEvidenceShardKey,
  landPlaceLayerCountFindings,
  landPlaceLayerCoverage,
  projectsForGeography,
} from "../site/land_place_membership.mjs";
import {
  PARCEL_GEOGRAPHY_SHARD_SCHEMA,
  PARCEL_MEMBERSHIP_SCHEMA,
  parcelShardKey,
} from "../site/parcel_geography.mjs";
import { buildLandPlaceMembershipFromRepo } from "../tools/build_land_place_membership.mjs";
import { withTempDir } from "../tools/lib/with_temp_dir.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CATALOG_PATH = join(ROOT, "site/data/land_project_catalog.json");
const BBL_PATH = join(ROOT, "site/data/zap_bbl_warehouse_lookup.json");
const INDEX_PATH = join(ROOT, LAND_PLACE_MEMBERSHIP_PATH);
const EVIDENCE_DIR = join(ROOT, LAND_PLACE_EVIDENCE_DIR);

const ANCHORS = Object.freeze({
  fdny: "2026R0127",
  westshore: "2025K0305",
  dewitt: "2023M0213",
  noBblManhattan: "2025M0252",
  citywide: "2022Y0395",
});

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function fixtureCatalog(projects, contentId = "fnv1a32:test:catalog") {
  return {
    schema: LAND_PROJECT_CATALOG_SCHEMA,
    project_count: projects.length,
    projects,
    source_dates: {
      warehouse_materialized_at: "2026-09-09T06:54:36.054Z",
      defaults_generated_at: "2026-09-09T06:46:42.537Z",
    },
    generation: { content_id: contentId, derivation: "test" },
  };
}

function fixtureBblIndex(rows, materializedAt = "2026-09-09T06:54:36.054Z") {
  return {
    schema_version: "test.bbl",
    materialized_at: materializedAt,
    project_count: rows.length,
    bbl_row_count: rows.length,
    rows,
  };
}

function membershipHeader(vintages = {}) {
  const layers = {};
  for (const type of LAND_PLACE_LAYERS) {
    layers[type] = {
      status: "resolved",
      vintage: vintages[type] || (type.startsWith("nta") || type === "police_precinct" ? "26B" : "2026-05-26"),
      geometry_fidelity: "full",
      sha256: "a".repeat(64),
    };
  }
  return { schema: PARCEL_MEMBERSHIP_SCHEMA, layers };
}

function shardDoc(key, parcels) {
  return {
    schema: PARCEL_GEOGRAPHY_SHARD_SCHEMA,
    key,
    parcels,
    memberships: membershipHeader(),
  };
}

function parcelEntry(lat, lon, memberships) {
  return { lat, lon, memberships };
}

describe("land_place_membership", () => {
  it("A1 committed generation resolves FDNY, Westshore, and Dewitt Clinton anchors", () => {
    assert.ok(existsSync(CATALOG_PATH), "catalog present");
    assert.ok(existsSync(BBL_PATH), "bbl index present");
    assert.ok(existsSync(INDEX_PATH), "membership index present");

    const index = readJson(INDEX_PATH);
    assert.equal(index.schema, LAND_PLACE_MEMBERSHIP_SCHEMA);
    assert.equal(index.association_kind, LAND_PLACE_ASSOCIATION_KIND);
    assert.equal(index.project_count, 244);

    const fdny = index.by_project[ANCHORS.fdny];
    assert.ok(fdny, "FDNY project present");
    assert.deepEqual(fdny.layers.nta2020.places, ["SI0105"]);
    assert.deepEqual(fdny.layers.community_district.places, ["R01"]);
    assert.deepEqual(fdny.layers.council_district.places, ["49"]);
    assert.ok(projectsForGeography(index, "nta2020", "SI0105").includes(ANCHORS.fdny));
    assert.ok(projectsForGeography(index, "community_district", "R01").includes(ANCHORS.fdny));
    assert.ok(projectsForGeography(index, "council_district", "49").includes(ANCHORS.fdny));

    const westshore = index.by_project[ANCHORS.westshore];
    assert.ok(westshore);
    assert.deepEqual(westshore.layers.nta2020.places, ["BK1301", "BK1391"]);
    const westCoverage = landPlaceLayerCoverage(westshore, "nta2020");
    assert.equal(westCoverage.fraction, "14/25");
    assert.equal(westCoverage.matched, 14);
    assert.equal(westCoverage.total, 25);
    assert.equal(
      projectsForGeography(index, "nta2020", "BK1301").filter((id) => id === ANCHORS.westshore).length,
      1,
    );
    assert.equal(
      projectsForGeography(index, "nta2020", "BK1391").filter((id) => id === ANCHORS.westshore).length,
      1,
    );

    const dewitt = index.by_project[ANCHORS.dewitt];
    assert.ok(dewitt);
    assert.deepEqual(dewitt.layers.nta2020.places, ["MN0401", "MN0402"]);
    const dewittCoverage = landPlaceLayerCoverage(dewitt, "nta2020");
    assert.equal(dewittCoverage.fraction, "5/7");
    assert.ok(projectsForGeography(index, "nta2020", "MN0401").includes(ANCHORS.dewitt));
    assert.ok(projectsForGeography(index, "nta2020", "MN0402").includes(ANCHORS.dewitt));
  });

  it("A2 evidence shards list contributing BBLs; duplicates do not inflate; multi-area once per area", () => {
    const index = readJson(INDEX_PATH);
    const bblIndex = readJson(BBL_PATH);
    const byProject = indexProjectBblAssociations(bblIndex);

    for (const projectId of [ANCHORS.westshore, ANCHORS.dewitt, ANCHORS.fdny]) {
      const entry = index.by_project[projectId];
      const shardPath = join(EVIDENCE_DIR, `${entry.evidence_shard}.json`);
      assert.ok(existsSync(shardPath), `evidence shard for ${projectId}`);
      const shard = readJson(shardPath);
      assert.equal(shard.schema, LAND_PLACE_EVIDENCE_SHARD_SCHEMA);
      assert.equal(shard.key, entry.evidence_shard);
      assert.equal(landPlaceEvidenceShardKey(projectId), entry.evidence_shard);

      const evidence = shard.projects[projectId];
      assert.ok(evidence, `evidence row for ${projectId}`);
      assert.equal(evidence.association_kind, LAND_PLACE_ASSOCIATION_KIND);

      const expectedValid = byProject.get(projectId).valid;
      assert.deepEqual(evidence.valid_bbls, expectedValid);
      assert.equal(evidence.valid_bbls.length, new Set(evidence.valid_bbls).size);

      // Injected duplicate raw rows must not change distinct counts.
      const duped = fixtureBblIndex([
        {
          project_id: projectId,
          bbls: [...expectedValid, ...expectedValid],
        },
      ]);
      const catalog = fixtureCatalog([
        {
          project_id: projectId,
          borough: "Test",
          community_district: "X00",
          cc_district: "1",
        },
      ]);
      const parcelByKey = new Map();
      for (const bbl of expectedValid) {
        const key = parcelShardKey(bbl);
        const realShard = readJson(join(ROOT, "site/data/parcel-geography", `${key}.json`));
        parcelByKey.set(key, realShard);
      }
      const rebuilt = buildLandPlaceMembership({
        catalog,
        bblIndex: duped,
        loadParcelShard: (key) => parcelByKey.get(key) || null,
        parcelManifest: readJson(join(ROOT, "site/data/parcel-geography/manifest.json")),
      });
      const rebuiltEntry = rebuilt.index.by_project[projectId];
      assert.equal(rebuiltEntry.valid_bbl_count, expectedValid.length);
      assert.equal(rebuiltEntry.layers.nta2020.total_bbls, expectedValid.length);
      assert.equal(
        rebuiltEntry.layers.nta2020.matched_bbls,
        entry.layers.nta2020.matched_bbls,
      );

      for (const placeId of entry.layers.nta2020.places) {
        const contributing = evidence.places.nta2020[placeId];
        assert.ok(Array.isArray(contributing) && contributing.length > 0, `${projectId} ${placeId}`);
        assert.equal(contributing.length, new Set(contributing).size);
        for (const bbl of contributing) {
          assert.equal(evidence.bbls[bbl].layers.nta2020.status, "matched");
          assert.ok(evidence.bbls[bbl].layers.nta2020.ids.includes(placeId));
        }
      }
    }

    // Multi-area projects appear once per area in reverse indexes.
    const indexWest = projectsForGeography(readJson(INDEX_PATH), "nta2020", "BK1301")
      .filter((id) => id === ANCHORS.westshore);
    assert.deepEqual(indexWest, [ANCHORS.westshore]);
  });

  it("A3 no-BBL projects receive no physical NTA membership; publisher districts stay separate", () => {
    const index = readJson(INDEX_PATH);
    for (const projectId of [ANCHORS.noBblManhattan, ANCHORS.citywide]) {
      const entry = index.by_project[projectId];
      assert.ok(entry, projectId);
      assert.ok(
        entry.bbl_association_state === LAND_PLACE_BBL_ASSOCIATION_STATES.ABSENT_FROM_INDEX
          || entry.bbl_association_state === LAND_PLACE_BBL_ASSOCIATION_STATES.EMPTY,
      );
      assert.equal(entry.valid_bbl_count, 0);
      assert.deepEqual(entry.layers.nta2020.places, []);
      assert.equal(entry.layers.nta2020.matched_bbls, 0);
      assert.equal(entry.layers.nta2020.total_bbls, 0);

      // Publisher geography is retained and never copied into by_geography.
      assert.ok(entry.publisher_geography);
      if (projectId === ANCHORS.noBblManhattan) {
        assert.equal(entry.publisher_geography.community_district, "M05");
      }
      if (projectId === ANCHORS.citywide) {
        assert.equal(entry.publisher_geography.borough, "Citywide");
      }
    }

    for (const [type, places] of Object.entries(index.by_geography)) {
      for (const [placeId, projectIds] of Object.entries(places)) {
        assert.ok(!projectIds.includes(ANCHORS.noBblManhattan), `${type}:${placeId}`);
        assert.ok(!projectIds.includes(ANCHORS.citywide), `${type}:${placeId}`);
      }
    }

    // Ambiguous vs missing parcel states remain distinct under injection.
    const bblMatched = "1000010001";
    const bblAmbiguous = "1000010002";
    const bblMissing = "1000010003";
    const catalog = fixtureCatalog([
      { project_id: "TESTAMBIG", community_district: "M01", cc_district: "1", borough: "Manhattan" },
    ]);
    const bblIndex = fixtureBblIndex([
      { project_id: "TESTAMBIG", bbls: [bblMatched, bblAmbiguous, bblMissing] },
    ]);
    const shards = new Map([
      [
        parcelShardKey(bblMatched),
        shardDoc(parcelShardKey(bblMatched), {
          [bblMatched]: parcelEntry(40.75, -73.98, {
            borough: "1",
            community_district: "M01",
            council_district: "1",
            nta2020: "MN0101",
            police_precinct: "1",
          }),
        }),
      ],
      [
        parcelShardKey(bblAmbiguous),
        shardDoc(parcelShardKey(bblAmbiguous), {
          [bblAmbiguous]: parcelEntry(40.75, -73.98, {
            borough: "1",
            community_district: "M01",
            council_district: "1",
            nta2020: { ids: ["MN0101", "MN0102"], status: "ambiguous_boundary" },
            police_precinct: "1",
          }),
        }),
      ],
      // bblMissing intentionally omitted from every shard
    ]);
    // Ensure matched/ambiguous shard keys don't accidentally serve missing.
    const built = buildLandPlaceMembership({
      catalog,
      bblIndex,
      loadParcelShard: (key) => shards.get(key) || null,
      parcelManifest: {
        coordinate_vintage: "test",
        membership: { layers: Object.fromEntries(LAND_PLACE_LAYERS.map((type) => [type, { vintage: "test" }])) },
      },
    });
    const entry = built.index.by_project.TESTAMBIG;
    assert.equal(entry.layers.nta2020.matched_bbls, 1);
    assert.equal(entry.layers.nta2020.ambiguous_bbls, 1);
    assert.equal(entry.layers.nta2020.unavailable_bbls, 1);
    assert.equal(entry.layers.nta2020.uncovered_bbls, 0);
    assert.deepEqual(entry.layers.nta2020.places, ["MN0101"]);
    assert.equal(entry.publisher_geography.community_district, "M01");
    // Ambiguous ids never enter by_geography.
    assert.equal(projectsForGeography(built.index, "nta2020", "MN0102").length, 0);
  });

  it("A4 fixture builder covers 25-lot, seven-lot, single-lot, no-BBL, and missing-shard injection", async () => {
    const realBbl = readJson(BBL_PATH);
    const byProject = indexProjectBblAssociations(realBbl);
    const westBbls = byProject.get(ANCHORS.westshore).valid;
    const dewittBbls = byProject.get(ANCHORS.dewitt).valid;
    const fdnyBbls = byProject.get(ANCHORS.fdny).valid;
    assert.equal(westBbls.length, 25);
    assert.equal(dewittBbls.length, 7);
    assert.equal(fdnyBbls.length, 1);

    await withTempDir("cityscroll-land-place-membership-", async (dir) => {
      const catalog = fixtureCatalog([
        { project_id: ANCHORS.westshore, borough: "Brooklyn", community_district: "K13,K11", cc_district: "47" },
        { project_id: ANCHORS.dewitt, borough: "Manhattan", community_district: "M04", cc_district: "36" },
        { project_id: ANCHORS.fdny, borough: "Staten Island", community_district: "R01", cc_district: "49" },
        { project_id: ANCHORS.noBblManhattan, borough: "Manhattan", community_district: "M05", cc_district: "3" },
        { project_id: ANCHORS.citywide, borough: "Citywide", community_district: null, cc_district: null },
        { project_id: "MISSINGSHARD", borough: "Queens", community_district: "Q01", cc_district: "21" },
      ]);
      const bblIndex = fixtureBblIndex([
        { project_id: ANCHORS.westshore, bbls: westBbls },
        { project_id: ANCHORS.dewitt, bbls: dewittBbls },
        { project_id: ANCHORS.fdny, bbls: fdnyBbls },
        { project_id: ANCHORS.noBblManhattan, bbls: [] },
        // citywide absent from index
        { project_id: "MISSINGSHARD", bbls: ["4010000001"] },
      ]);

      const needed = new Set([...westBbls, ...dewittBbls, ...fdnyBbls].map((bbl) => parcelShardKey(bbl)));
      const shardCache = new Map();
      for (const key of needed) {
        shardCache.set(key, readJson(join(ROOT, "site/data/parcel-geography", `${key}.json`)));
      }

      const built = buildLandPlaceMembership({
        catalog,
        bblIndex,
        loadParcelShard: (key) => shardCache.get(key) || null,
        parcelManifest: readJson(join(ROOT, "site/data/parcel-geography/manifest.json")),
      });

      assert.equal(built.index.by_project[ANCHORS.westshore].layers.nta2020.places.length, 2);
      assert.equal(landPlaceLayerCoverage(built.index.by_project[ANCHORS.westshore], "nta2020").fraction, "14/25");
      assert.equal(landPlaceLayerCoverage(built.index.by_project[ANCHORS.dewitt], "nta2020").fraction, "5/7");
      assert.deepEqual(built.index.by_project[ANCHORS.fdny].layers.nta2020.places, ["SI0105"]);

      assert.equal(
        built.index.by_project[ANCHORS.noBblManhattan].bbl_association_state,
        LAND_PLACE_BBL_ASSOCIATION_STATES.EMPTY,
      );
      assert.equal(
        built.index.by_project[ANCHORS.citywide].bbl_association_state,
        LAND_PLACE_BBL_ASSOCIATION_STATES.ABSENT_FROM_INDEX,
      );
      assert.deepEqual(built.index.by_project[ANCHORS.noBblManhattan].layers.nta2020.places, []);
      assert.deepEqual(built.index.by_project[ANCHORS.citywide].layers.nta2020.places, []);

      const missing = built.index.by_project.MISSINGSHARD;
      assert.equal(missing.layers.nta2020.unavailable_bbls, 1);
      assert.equal(missing.layers.nta2020.matched_bbls, 0);
      assert.deepEqual(missing.layers.nta2020.places, []);

      // Empty vs missing BBL source file remain different document states.
      const emptyListBuilt = built;
      assert.equal(emptyListBuilt.index.bbl_source.status, "present");
      const missingSource = buildLandPlaceMembership({
        catalog,
        bblIndex: null,
        loadParcelShard: () => null,
        parcelManifest: null,
      });
      assert.equal(missingSource.index.bbl_source.status, "missing");
      assert.equal(
        missingSource.index.by_project[ANCHORS.fdny].bbl_association_state,
        LAND_PLACE_BBL_ASSOCIATION_STATES.SOURCE_MISSING,
      );

      // Write evidence shard files into the temp dir to prove shard fan-out.
      const evidenceDir = join(dir, "land-place-evidence");
      mkdirSync(evidenceDir, { recursive: true });
      let written = 0;
      for (const [key, shard] of Object.entries(built.evidenceShards)) {
        if (shard.project_count === 0) continue;
        writeFileSync(join(evidenceDir, `${key}.json`), `${JSON.stringify(shard, null, 2)}\n`);
        written += 1;
      }
      assert.ok(written >= 4);
    });
  });

  it("A5 per-layer counts partition distinct valid BBLs; invalid inputs stay outside the denominator", () => {
    const index = readJson(INDEX_PATH);
    for (const [projectId, entry] of Object.entries(index.by_project)) {
      const findings = landPlaceLayerCountFindings(entry);
      assert.deepEqual(findings, [], `${projectId}: ${findings.join("; ")}`);
    }

    const catalog = fixtureCatalog([
      { project_id: "INVALTEST", borough: "Brooklyn", community_district: "K01", cc_district: "33" },
    ]);
    const good = "3000010001";
    const bblIndex = fixtureBblIndex([
      { project_id: "INVALTEST", bbls: [good, "not-a-bbl", "", good] },
    ]);
    const key = parcelShardKey(good);
    const built = buildLandPlaceMembership({
      catalog,
      bblIndex,
      loadParcelShard: (shardKey) => {
        if (shardKey !== key) return null;
        return shardDoc(key, {
          [normalizeBbl(good)]: parcelEntry(40.7, -73.9, {
            borough: "3",
            community_district: "K01",
            council_district: "33",
            nta2020: { ids: [], status: "not_covered" },
            police_precinct: "90",
          }),
        });
      },
      parcelManifest: {
        coordinate_vintage: "test",
        membership: { layers: Object.fromEntries(LAND_PLACE_LAYERS.map((type) => [type, { vintage: "test" }])) },
      },
    });
    const entry = built.index.by_project.INVALTEST;
    assert.equal(entry.valid_bbl_count, 1);
    assert.equal(entry.invalid_bbl_count, 2);
    assert.equal(entry.layers.nta2020.total_bbls, 1);
    assert.equal(entry.layers.nta2020.uncovered_bbls, 1);
    const evidence = built.evidenceShards[entry.evidence_shard].projects.INVALTEST;
    assert.deepEqual(landPlaceLayerCountFindings(entry), []);
    assert.deepEqual(landPlaceLayerCountFindings(entry, evidence), []);
    assert.deepEqual(evidence.invalid_bbls.sort(), ["", "not-a-bbl"].sort());
    // Invalid inputs never create a complete-coverage claim.
    assert.equal(entry.layers.nta2020.matched_bbls, 0);
    assert.notEqual(entry.layers.nta2020.matched_bbls, entry.layers.nta2020.total_bbls + entry.invalid_bbl_count);
  });

  it("A5 positive control: checker reports partition break, double-counted lot, and dropped invalid", () => {
    const baseLayers = Object.fromEntries(
      LAND_PLACE_LAYERS.map((type) => [
        type,
        {
          total_bbls: 1,
          matched_bbls: 1,
          uncovered_bbls: 0,
          ambiguous_bbls: 0,
          unavailable_bbls: 0,
          places: ["BK0101"],
        },
      ]),
    );
    const cleanEntry = {
      association_kind: LAND_PLACE_ASSOCIATION_KIND,
      bbl_association_state: LAND_PLACE_BBL_ASSOCIATION_STATES.PRESENT,
      valid_bbl_count: 1,
      invalid_bbl_count: 1,
      evidence_shard: "00",
      layers: structuredClone(baseLayers),
      publisher_geography: { borough: "Brooklyn", community_district: "K01", council_district: "33" },
    };
    const cleanEvidence = {
      association_kind: LAND_PLACE_ASSOCIATION_KIND,
      bbl_association_state: LAND_PLACE_BBL_ASSOCIATION_STATES.PRESENT,
      valid_bbls: ["3000010001"],
      invalid_bbls: ["not-a-bbl"],
      bbls: {},
      places: {},
      publisher_geography: cleanEntry.publisher_geography,
    };
    assert.deepEqual(landPlaceLayerCountFindings(cleanEntry, cleanEvidence), []);

    // Partition break: matched + uncovered + ambiguous + unavailable != total.
    const partitionBroken = structuredClone(cleanEntry);
    partitionBroken.layers.nta2020.matched_bbls = 0;
    partitionBroken.layers.nta2020.uncovered_bbls = 0;
    partitionBroken.layers.nta2020.ambiguous_bbls = 0;
    partitionBroken.layers.nta2020.unavailable_bbls = 0;
    // total stays 1 → sum 0 != 1
    const partitionFindings = landPlaceLayerCountFindings(partitionBroken);
    assert.ok(
      partitionFindings.some((line) => line === "layer nta2020 counts 0 != total_bbls 1"),
      `expected partition finding, got: ${partitionFindings.join("; ")}`,
    );

    // Lot counted twice across status buckets (sum 2 > total 1).
    const doubleCounted = structuredClone(cleanEntry);
    doubleCounted.layers.nta2020.matched_bbls = 1;
    doubleCounted.layers.nta2020.uncovered_bbls = 1;
    const doubleFindings = landPlaceLayerCountFindings(doubleCounted);
    assert.ok(
      doubleFindings.some((line) => line === "layer nta2020 counts 2 != total_bbls 1"),
      `expected double-count finding, got: ${doubleFindings.join("; ")}`,
    );

    // Duplicate valid lot retained in evidence.
    const duplicateEvidence = structuredClone(cleanEvidence);
    duplicateEvidence.valid_bbls = ["3000010001", "3000010001"];
    const duplicateFindings = landPlaceLayerCountFindings(cleanEntry, duplicateEvidence);
    assert.ok(
      duplicateFindings.some((line) => line === "evidence valid_bbls contains duplicates"),
      `expected duplicate-lot finding, got: ${duplicateFindings.join("; ")}`,
    );
    assert.ok(
      duplicateFindings.some((line) => line === "valid_bbl_count 1 != evidence valid_bbls 2"),
      `expected valid-count mismatch finding, got: ${duplicateFindings.join("; ")}`,
    );

    // Invalid value dropped from the compact count while evidence still lists it.
    const droppedInvalid = structuredClone(cleanEntry);
    droppedInvalid.invalid_bbl_count = 0;
    const droppedFindings = landPlaceLayerCountFindings(droppedInvalid, cleanEvidence);
    assert.ok(
      droppedFindings.some((line) => line === "invalid_bbl_count 0 != evidence invalid_bbls 1"),
      `expected dropped-invalid finding, got: ${droppedFindings.join("; ")}`,
    );

    // matched + invalid == total would claim complete coverage while absorbing invalids.
    const absorbedInvalid = structuredClone(cleanEntry);
    absorbedInvalid.valid_bbl_count = 2;
    absorbedInvalid.invalid_bbl_count = 1;
    for (const type of LAND_PLACE_LAYERS) {
      absorbedInvalid.layers[type] = {
        total_bbls: 2,
        matched_bbls: 1,
        uncovered_bbls: 0,
        ambiguous_bbls: 0,
        unavailable_bbls: 0,
        places: ["BK0101"],
      };
    }
    const absorbedFindings = landPlaceLayerCountFindings(absorbedInvalid);
    assert.ok(
      absorbedFindings.some(
        (line) => line === "layer nta2020 matched_bbls + invalid_bbl_count 2 == total_bbls 2",
      ),
      `expected matched+invalid absorption finding, got: ${absorbedFindings.join("; ")}`,
    );
  });

  it("repo builder returns 256 evidence shards and matches committed bytes when present", () => {
    const built = buildLandPlaceMembershipFromRepo(ROOT);
    assert.equal(Object.keys(built.evidenceShards).length, LAND_PLACE_EVIDENCE_SHARD_COUNT);
    assert.equal(built.index.schema, LAND_PLACE_MEMBERSHIP_SCHEMA);
    assert.equal(built.index.project_count, 244);
    assert.equal(built.index.association_kind, LAND_PLACE_ASSOCIATION_KIND);

    if (existsSync(INDEX_PATH)) {
      assert.equal(readFileSync(INDEX_PATH, "utf8"), built.indexText);
    }
  });

  it("catalog helper still builds independently of place membership", () => {
    const warehouse = readJson(join(ROOT, "site/data/zap_projects_warehouse_lookup.json"));
    const defaults = readJson(join(ROOT, "site/data/land_default_ulurp.json"));
    const catalog = buildLandProjectCatalog({ warehouse, defaults });
    assert.equal(catalog.project_count, 244);
  });
});
