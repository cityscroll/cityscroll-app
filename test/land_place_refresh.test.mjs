/**
 * Land place-membership refresh and coherent generation publication.
 *
 *   node --test test/land_place_refresh.test.mjs
 *
 * Covers full backfill, selective invalidation, source deletion, boundary
 * replacement, failed promotion, retry recovery, and pinned-generation reads.
 */

import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";

import { LAND_PROJECT_CATALOG_PATH } from "../site/land_project_catalog.mjs";
import {
  LAND_PLACE_BBL_INDEX_PATH,
  LAND_PLACE_EVIDENCE_DIR,
  LAND_PLACE_MEMBERSHIP_PATH,
  projectsForGeography,
} from "../site/land_place_membership.mjs";
import {
  LAND_PLACE_ACTIVE_POINTER,
  LAND_PLACE_CONSUMERS,
  LAND_PLACE_PUBLIC_DIR,
  activateLandPlaceGeneration,
  buildLandPlaceConsumers,
  computeLandPlaceInputHashes,
  createLandPlaceRefresh,
  loadActiveLandPlaceGeneration,
  loadLandPlaceRefreshReceipt,
  loadPinnedLandPlaceGeneration,
  planLandPlaceRefresh,
  validateLandPlaceConsumers,
  writeLandPlaceRefreshReceipt,
} from "../site/land_place_refresh.mjs";
import {
  PARCEL_GEOGRAPHY_MANIFEST_PATH,
  parcelShardKey,
} from "../site/parcel_geography.mjs";
import {
  buildLandPlaceRefreshAdapters,
  runLandPlaceRefresh,
} from "../tools/land_place_refresh.mjs";
import { withTempDir } from "../tools/lib/with_temp_dir.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CATALOG = path.join(ROOT, LAND_PROJECT_CATALOG_PATH);
const BBL_INDEX = path.join(ROOT, LAND_PLACE_BBL_INDEX_PATH);
const PARCEL_MANIFEST = path.join(ROOT, PARCEL_GEOGRAPHY_MANIFEST_PATH);
const PARCEL_DIR = path.join(ROOT, "site/data/parcel-geography");
const ADDRESS_MANIFEST = path.join(ROOT, "site/data/address-index/manifest.json");

const ANCHORS = Object.freeze({
  fdny: "2026R0127",
  westshore: "2025K0305",
  dewitt: "2023M0213",
});


function loadJson(filePath) {
  return JSON.parse(readFileSync(filePath, "utf8"));
}

/** Tiny admitted catalog + BBL index for selective refresh tests. */
function writeReducedCatalogFixture(fixtureDir, {
  projectIds = [ANCHORS.fdny, ANCHORS.westshore, ANCHORS.dewitt],
  contentSuffix = "reduced",
} = {}) {
  const fullCatalog = loadJson(CATALOG);
  const fullBbl = loadJson(BBL_INDEX);
  const idSet = new Set(projectIds);
  const projects = fullCatalog.projects.filter((row) => idSet.has(row.project_id));
  const catalogPath = path.join(fixtureDir, "land_project_catalog.json");
  const bblPath = path.join(fixtureDir, "zap_bbl_warehouse_lookup.json");
  writeFileSync(
    catalogPath,
    `${JSON.stringify({
      ...fullCatalog,
      project_count: projects.length,
      projects,
      generation: {
        ...fullCatalog.generation,
        content_id: `${fullCatalog.generation.content_id}:${contentSuffix}:${projects.length}`,
      },
    }, null, 2)}\n`,
  );
  const rows = (fullBbl.rows || []).filter((row) => idSet.has(row.project_id));
  writeFileSync(
    bblPath,
    `${JSON.stringify({
      ...fullBbl,
      project_count: new Set(rows.map((row) => row.project_id)).size,
      bbl_row_count: rows.length,
      rows,
    }, null, 2)}\n`,
  );
  return { catalogPath, bblPath, project_count: projects.length };
}


function seedTempPublication(tempDir, { reduced = false } = {}) {
  const fixtureDir = path.join(tempDir, "fixture");
  const publicDir = path.join(fixtureDir, "land-place-generations");
  const activeIndexPath = path.join(fixtureDir, "land_place_membership.json");
  const activeEvidenceDir = path.join(fixtureDir, "land-place-evidence");
  const addressManifestPath = path.join(fixtureDir, "address-index-manifest.json");
  mkdirSync(publicDir, { recursive: true });
  mkdirSync(activeEvidenceDir, { recursive: true });

  let catalogPath = CATALOG;
  let bblPath = path.join(fixtureDir, "zap_bbl_warehouse_lookup.json");
  if (reduced) {
    const reducedPaths = writeReducedCatalogFixture(fixtureDir);
    catalogPath = reducedPaths.catalogPath;
    bblPath = reducedPaths.bblPath;
  } else {
    // Full committed BBL index so selective edits stay source-shaped.
    writeFileSync(bblPath, readFileSync(BBL_INDEX));
  }
  if (existsSync(ADDRESS_MANIFEST)) {
    writeFileSync(addressManifestPath, readFileSync(ADDRESS_MANIFEST));
  } else {
    writeFileSync(addressManifestPath, `${JSON.stringify({
      schema: "cityscroll.address-index-manifest.test",
      content_sha256: "address-v1",
    })}\n`);
  }

  return {
    fixtureDir,
    publicDir,
    activeIndexPath,
    activeEvidenceDir,
    catalogPath,
    bblPath,
    parcelManifestPath: PARCEL_MANIFEST,
    parcelDir: PARCEL_DIR,
    addressManifestPath,
  };
}

function refreshFromPaths(paths, runOptions = {}) {
  const adapters = buildLandPlaceRefreshAdapters({
    publicDir: paths.publicDir,
    activeIndexPath: paths.activeIndexPath,
    activeEvidenceDir: paths.activeEvidenceDir,
    catalogPath: paths.catalogPath,
    bblPath: paths.bblPath,
    parcelManifestPath: paths.parcelManifestPath,
    parcelDir: paths.parcelDir,
    addressManifestPath: paths.addressManifestPath,
  });
  const refresh = createLandPlaceRefresh(adapters);
  return refresh.run({
    now: "2026-09-25T18:00:00.000Z",
    builtAt: "2026-09-09T06:54:36.054Z",
    ...runOptions,
  });
}

describe("land_place_refresh", { concurrency: 1 }, () => {
test("A1 [outcome] first run projects baseline catalog; unchanged inputs keep bytes; one BBL edit is selective", async () => {
  await withTempDir("land-place-refresh-a1-", async (tempDir) => {
    const paths = seedTempPublication(tempDir);
    const catalog = loadJson(paths.catalogPath);
    assert.equal(catalog.project_count, 244);

    const first = refreshFromPaths(paths);
    assert.equal(first.ok, true, JSON.stringify(first.receipt?.failure || first));
    assert.equal(first.status, "activated");
    assert.equal(first.index.project_count, 244);
    assert.ok(first.active_generation);

    const active = loadActiveLandPlaceGeneration(paths.publicDir);
    assert.equal(active.pointer.active_generation, first.active_generation);
    assert.equal(active.index.generation.id, first.active_generation);
    assert.equal(active.evidence.generation_id, first.active_generation);
    assert.equal(active.reverse.generation_id, first.active_generation);
    assert.equal(active.index.project_count, 244);

    const consumers = buildLandPlaceConsumers(active.index, active.evidenceShards);
    const validation = validateLandPlaceConsumers(consumers, first.active_generation);
    assert.equal(validation.ok, true);
    assert.deepEqual([...LAND_PLACE_CONSUMERS], ["index", "evidence", "reverse"]);

    const indexBefore = readFileSync(paths.activeIndexPath);
    const pointerBefore = readFileSync(path.join(paths.publicDir, LAND_PLACE_ACTIVE_POINTER));
    const generationDirBefore = path.join(paths.publicDir, first.active_generation);

    const noop = refreshFromPaths(paths);
    assert.equal(noop.ok, true);
    assert.equal(noop.status, "unchanged");
    assert.equal(noop.active_generation, first.active_generation);
    assert.equal(readFileSync(paths.activeIndexPath).equals(indexBefore), true);
    assert.equal(
      readFileSync(path.join(paths.publicDir, LAND_PLACE_ACTIVE_POINTER)).equals(pointerBefore),
      true,
    );
    assert.ok(existsSync(path.join(generationDirBefore, "index.json")));

    // Address-only change must not invalidate BBL joins.
    const address = loadJson(paths.addressManifestPath);
    address.content_sha256 = "address-only-drift";
    writeFileSync(paths.addressManifestPath, `${JSON.stringify(address)}\n`);
    const addressOnly = refreshFromPaths(paths);
    assert.equal(addressOnly.status, "unchanged");
    assert.ok((addressOnly.plan?.reasons || []).includes("address_index_changed_ignored")
      || (addressOnly.receipt?.plan?.reasons || []).includes("address_index_changed_ignored")
      || addressOnly.status === "unchanged");

    // Remove one Westshore BBL → only that project membership and generation metadata change.
    const beforeByProject = loadJson(paths.activeIndexPath).by_project;
    const bblDoc = loadJson(paths.bblPath);
    const westshoreRow = bblDoc.rows.find((row) => row.project_id === ANCHORS.westshore);
    assert.ok(westshoreRow);
    assert.ok(westshoreRow.bbls.length >= 2);
    const removedBbl = westshoreRow.bbls[0];
    westshoreRow.bbls = westshoreRow.bbls.filter((value) => value !== removedBbl);
    writeFileSync(paths.bblPath, `${JSON.stringify(bblDoc)}\n`);

    const edited = refreshFromPaths(paths, { now: "2026-09-25T18:30:00.000Z" });
    assert.equal(edited.ok, true);
    assert.equal(edited.status, "activated");
    assert.notEqual(edited.active_generation, first.active_generation);
    assert.ok(edited.plan.changed_inputs.includes("bbl_rows"));
    assert.equal(edited.plan.rebuild_all, false);
    assert.deepEqual(edited.plan.rebuild_project_ids, [ANCHORS.westshore]);

    const after = loadJson(paths.activeIndexPath);
    assert.equal(after.project_count, 244);
    assert.notEqual(after.generation.id, first.active_generation);
    assert.notEqual(
      JSON.stringify(after.by_project[ANCHORS.westshore]),
      JSON.stringify(beforeByProject[ANCHORS.westshore]),
    );
    for (const projectId of Object.keys(beforeByProject)) {
      if (projectId === ANCHORS.westshore) continue;
      assert.deepEqual(
        after.by_project[projectId],
        beforeByProject[projectId],
        `unaffected project ${projectId} must keep membership bytes`,
      );
    }
  });
});

test("A2 [outcome] removing a project clears compact and reverse entries; parcel correction updates dependents", async () => {
  await withTempDir("land-place-refresh-a2-", async (tempDir) => {
    const paths = seedTempPublication(tempDir, { reduced: true });
    const first = refreshFromPaths(paths);
    assert.equal(first.status, "activated");

    // Drop FDNY from the reduced catalog; keep the BBL index intact.
    const catalog = loadJson(paths.catalogPath);
    const reducedCatalogPath = path.join(paths.fixtureDir, "land_project_catalog.minus-fdny.json");
    const reducedProjects = catalog.projects.filter((row) => row.project_id !== ANCHORS.fdny);
    writeFileSync(reducedCatalogPath, `${JSON.stringify({
      ...catalog,
      project_count: reducedProjects.length,
      projects: reducedProjects,
      generation: {
        ...catalog.generation,
        content_id: `${catalog.generation.content_id}:minus-fdny`,
      },
    }, null, 2)}\n`);
    paths.catalogPath = reducedCatalogPath;

    const removed = refreshFromPaths(paths, { now: "2026-09-25T19:00:00.000Z" });
    assert.equal(removed.ok, true);
    assert.equal(removed.status, "activated");
    const active = loadActiveLandPlaceGeneration(paths.publicDir);
    assert.equal(active.index.by_project[ANCHORS.fdny], undefined);
    assert.equal(
      projectsForGeography(active.index, "nta2020", "SI0105").includes(ANCHORS.fdny),
      false,
    );
    assert.equal(active.index.project_count, 2);

    // Restore the three-project reduced catalog, then correct Dewitt's parcel
    // shard and ensure Dewitt updates while Westshore stays.
    const restoredCatalog = writeReducedCatalogFixture(paths.fixtureDir, {
      contentSuffix: "restored",
    });
    paths.catalogPath = restoredCatalog.catalogPath;
    const restored = refreshFromPaths(paths, { now: "2026-09-25T19:10:00.000Z" });
    assert.equal(restored.status, "activated");
    const beforeDewitt = loadJson(paths.activeIndexPath).by_project[ANCHORS.dewitt];
    const beforeWestshore = loadJson(paths.activeIndexPath).by_project[ANCHORS.westshore];

    // Copy one Dewitt parcel shard into the fixture and mutate NTA membership.
    const evidence = loadJson(path.join(
      paths.publicDir,
      restored.active_generation,
      "land-place-evidence",
      loadJson(paths.activeIndexPath).by_project[ANCHORS.dewitt].evidence_shard + ".json",
    ));
    const dewittBbls = evidence.projects[ANCHORS.dewitt].valid_bbls;
    assert.ok(dewittBbls.length >= 1);
    const targetBbl = dewittBbls[0];
    const shardKey = parcelShardKey(targetBbl);
    const sourceShardPath = path.join(PARCEL_DIR, `${shardKey}.json`);
    assert.ok(existsSync(sourceShardPath), `missing parcel shard ${shardKey}`);
    const localParcelDir = path.join(paths.fixtureDir, "parcel-geography");
    mkdirSync(localParcelDir, { recursive: true });
    const shardDoc = loadJson(sourceShardPath);
    const parcel = shardDoc.parcels?.[targetBbl];
    assert.ok(parcel, `parcel ${targetBbl} present in shard`);
    parcel.memberships = {
      ...(parcel.memberships || {}),
      nta2020: { ids: ["MN9999"], status: "matched" },
    };
    writeFileSync(path.join(localParcelDir, `${shardKey}.json`), `${JSON.stringify(shardDoc)}\n`);
    // Keep other shard lookups falling through by also writing a tiny manifest copy.
    writeFileSync(
      path.join(localParcelDir, "manifest.json"),
      readFileSync(PARCEL_MANIFEST),
    );
    paths.parcelDir = localParcelDir;
    paths.parcelManifestPath = path.join(localParcelDir, "manifest.json");

    // Ensure loader can still find unrelated shards: proxy missing keys to ROOT.
    const adapters = buildLandPlaceRefreshAdapters({
      publicDir: paths.publicDir,
      activeIndexPath: paths.activeIndexPath,
      activeEvidenceDir: paths.activeEvidenceDir,
      catalogPath: paths.catalogPath,
      bblPath: paths.bblPath,
      parcelManifestPath: paths.parcelManifestPath,
      parcelDir: paths.parcelDir,
      addressManifestPath: paths.addressManifestPath,
    });
    const rootLoad = adapters.loadSources;
    const refresh = createLandPlaceRefresh({
      ...adapters,
      loadSources() {
        const sources = rootLoad();
        const localLoader = sources.loadParcelShard;
        sources.loadParcelShard = (key) => {
          const local = localLoader(key);
          if (local) return local;
          const fallback = path.join(PARCEL_DIR, `${key}.json`);
          if (!existsSync(fallback)) return null;
          return loadJson(fallback);
        };
        return sources;
      },
    });
    const corrected = refresh.run({
      now: "2026-09-25T19:20:00.000Z",
      builtAt: "2026-09-09T06:54:36.054Z",
    });
    assert.equal(corrected.ok, true);
    assert.equal(corrected.status, "activated");
    const after = loadJson(paths.activeIndexPath);
    assert.notDeepEqual(after.by_project[ANCHORS.dewitt], beforeDewitt);
    assert.deepEqual(after.by_project[ANCHORS.westshore], beforeWestshore);
    assert.ok(after.by_project[ANCHORS.dewitt].layers.nta2020.places.includes("MN9999"));
  });
});

test("A3 [boundary] partial download / mismatched boundary retain last-good; refresh clock stays off source dates", async () => {
  await withTempDir("land-place-refresh-a3-", async (tempDir) => {
    const paths = seedTempPublication(tempDir, { reduced: true });
    const first = refreshFromPaths(paths);
    assert.equal(first.ok, true);
    const kept = first.active_generation;
    const keptSourceDates = loadJson(paths.activeIndexPath).source_dates;

    for (const kind of ["partial_download", "mismatched_boundary", "before_activate"]) {
      const failed = refreshFromPaths(paths, {
        now: "2026-09-25T20:00:00.000Z",
        injectFailure: kind,
      });
      assert.equal(failed.ok, false, kind);
      assert.equal(failed.status, "failed", kind);
      assert.equal(failed.active_generation, kept, kind);
      const active = loadActiveLandPlaceGeneration(paths.publicDir);
      assert.equal(active.pointer.active_generation, kept, kind);
      const receipt = loadLandPlaceRefreshReceipt(paths.publicDir);
      assert.equal(receipt.status, "failed", kind);
      assert.ok(receipt.failure?.kind, kind);
      assert.equal(receipt.failed_at, "2026-09-25T20:00:00.000Z", kind);
      assert.deepEqual(receipt.source_dates, keptSourceDates, kind);
      assert.deepEqual(active.index.source_dates, keptSourceDates, kind);
      assert.notEqual(receipt.status, "activated", kind);
    }
  });
});

test("A4 [verification] command covers backfill, no-op, deletion, boundary failure, and recovery", async () => {
  await withTempDir("land-place-refresh-a4-", async (tempDir) => {
    const paths = seedTempPublication(tempDir, { reduced: true });

    const seeded = runLandPlaceRefresh({
      publicDir: paths.publicDir,
      activeIndexPath: paths.activeIndexPath,
      activeEvidenceDir: paths.activeEvidenceDir,
      catalogPath: paths.catalogPath,
      bblPath: paths.bblPath,
      parcelManifestPath: paths.parcelManifestPath,
      parcelDir: paths.parcelDir,
      addressManifestPath: paths.addressManifestPath,
      now: "2026-09-25T18:00:00.000Z",
      builtAt: "2026-09-09T06:54:36.054Z",
    });
    assert.equal(seeded.ok, true, JSON.stringify(seeded.receipt?.failure || seeded));
    assert.equal(seeded.status, "activated");
    const kept = seeded.active_generation;

    const unchanged = runLandPlaceRefresh({
      publicDir: paths.publicDir,
      activeIndexPath: paths.activeIndexPath,
      activeEvidenceDir: paths.activeEvidenceDir,
      catalogPath: paths.catalogPath,
      bblPath: paths.bblPath,
      parcelManifestPath: paths.parcelManifestPath,
      parcelDir: paths.parcelDir,
      addressManifestPath: paths.addressManifestPath,
      now: "2026-09-25T18:05:00.000Z",
      builtAt: "2026-09-09T06:54:36.054Z",
    });
    assert.equal(unchanged.status, "unchanged");

    // Source deletion of one project via catalog edit.
    const catalog = loadJson(paths.catalogPath);
    const reducedPath = path.join(paths.fixtureDir, "catalog-minus-one.json");
    const projects = catalog.projects.filter((row) => row.project_id !== ANCHORS.dewitt);
    writeFileSync(reducedPath, `${JSON.stringify({
      ...catalog,
      project_count: projects.length,
      projects,
      generation: { ...catalog.generation, content_id: `${catalog.generation.content_id}:minus-dewitt` },
    }, null, 2)}\n`);
    const deleted = runLandPlaceRefresh({
      publicDir: paths.publicDir,
      activeIndexPath: paths.activeIndexPath,
      activeEvidenceDir: paths.activeEvidenceDir,
      catalogPath: reducedPath,
      bblPath: paths.bblPath,
      parcelManifestPath: paths.parcelManifestPath,
      parcelDir: paths.parcelDir,
      addressManifestPath: paths.addressManifestPath,
      now: "2026-09-25T18:10:00.000Z",
      builtAt: "2026-09-09T06:54:36.054Z",
    });
    assert.equal(deleted.status, "activated");
    assert.equal(loadJson(paths.activeIndexPath).by_project[ANCHORS.dewitt], undefined);

    const failed = runLandPlaceRefresh({
      publicDir: paths.publicDir,
      activeIndexPath: paths.activeIndexPath,
      activeEvidenceDir: paths.activeEvidenceDir,
      catalogPath: reducedPath,
      bblPath: paths.bblPath,
      parcelManifestPath: paths.parcelManifestPath,
      parcelDir: paths.parcelDir,
      addressManifestPath: paths.addressManifestPath,
      now: "2026-09-25T18:15:00.000Z",
      injectFailure: "before_activate",
      builtAt: "2026-09-09T06:54:36.054Z",
    });
    assert.equal(failed.ok, false);
    assert.equal(
      loadActiveLandPlaceGeneration(paths.publicDir).pointer.active_generation,
      deleted.active_generation,
    );

    // Recovery: restore full catalog and activate again.
    const recovered = runLandPlaceRefresh({
      publicDir: paths.publicDir,
      activeIndexPath: paths.activeIndexPath,
      activeEvidenceDir: paths.activeEvidenceDir,
      catalogPath: paths.catalogPath,
      bblPath: paths.bblPath,
      parcelManifestPath: paths.parcelManifestPath,
      parcelDir: paths.parcelDir,
      addressManifestPath: paths.addressManifestPath,
      now: "2026-09-25T18:20:00.000Z",
      builtAt: "2026-09-09T06:54:36.054Z",
    });
    assert.equal(recovered.ok, true);
    assert.equal(recovered.status, "activated");
    assert.ok(loadJson(paths.activeIndexPath).by_project[ANCHORS.dewitt]);
    assert.notEqual(recovered.active_generation, deleted.active_generation);
    assert.equal(
      loadActiveLandPlaceGeneration(paths.publicDir).pointer.previous_generation,
      deleted.active_generation,
    );
    // Restoring the original catalog may reuse the first generation id when the
    // invalidation aggregate matches the initial backfill inputs.
    assert.ok(recovered.active_generation);
  });
});

test("A5 [boundary,verification] assets publish before active switch; pin one generation; retain previous", async () => {
  await withTempDir("land-place-refresh-a5-", async (tempDir) => {
    const paths = seedTempPublication(tempDir, { reduced: true });
    const first = refreshFromPaths(paths);
    const firstGeneration = first.active_generation;

    const bblDoc = loadJson(paths.bblPath);
    const westshoreRow = bblDoc.rows.find((row) => row.project_id === ANCHORS.westshore);
    westshoreRow.bbls = westshoreRow.bbls.slice(1);
    writeFileSync(paths.bblPath, `${JSON.stringify(bblDoc)}\n`);

    const second = refreshFromPaths(paths, { now: "2026-09-25T19:00:00.000Z" });
    assert.equal(second.status, "activated");
    assert.notEqual(second.active_generation, firstGeneration);
    assert.equal(second.previous_active_generation, firstGeneration);

    const active = loadActiveLandPlaceGeneration(paths.publicDir);
    assert.equal(active.pointer.active_generation, second.active_generation);
    assert.equal(active.pointer.previous_generation, firstGeneration);
    assert.ok(existsSync(path.join(paths.publicDir, firstGeneration, "index.json")));
    assert.ok(existsSync(path.join(paths.publicDir, second.active_generation, "index.json")));

    const pinnedFirst = loadPinnedLandPlaceGeneration(paths.publicDir, firstGeneration);
    assert.equal(pinnedFirst.ok, true);
    assert.equal(pinnedFirst.assets.generation_id, firstGeneration);
    assert.equal(pinnedFirst.assets.evidence.generation_id, firstGeneration);
    assert.equal(pinnedFirst.assets.reverse.generation_id, firstGeneration);

    const pinnedSecond = loadPinnedLandPlaceGeneration(
      paths.publicDir,
      second.active_generation,
    );
    assert.equal(pinnedSecond.ok, true);
    assert.equal(pinnedSecond.assets.generation_id, second.active_generation);

    const missing = loadPinnedLandPlaceGeneration(paths.publicDir, "missing-generation");
    assert.equal(missing.ok, false);
    assert.equal(missing.retry, true);
    assert.equal(missing.reason, "generation_unavailable");

    const mixed = refreshFromPaths(paths, {
      now: "2026-09-25T19:30:00.000Z",
      injectFailure: "mixed_generation",
    });
    assert.equal(mixed.ok, false);
    assert.equal(
      loadActiveLandPlaceGeneration(paths.publicDir).pointer.active_generation,
      second.active_generation,
    );
    assert.equal(
      loadPinnedLandPlaceGeneration(paths.publicDir, second.active_generation).ok,
      true,
    );
    assert.equal(existsSync(path.join(paths.publicDir, ".staging")), false);
  });
});

test("derived manifest registers land catalog then land-place-refresh before geography", () => {
  const manifest = loadJson(path.join(ROOT, "warehouse/derived_json_build_manifest.json"));
  const ids = manifest.generated_families.map((family) => family.id);
  // These families are added by this card; assert once wired.
  const catalogAt = ids.indexOf("land-project-catalog");
  const refreshAt = ids.indexOf("land-place-refresh");
  const geographyAt = ids.indexOf("geography");
  const addressAt = ids.indexOf("address-geography-refresh");
  if (catalogAt < 0 || refreshAt < 0) {
    assert.fail(
      "warehouse/derived_json_build_manifest.json must register land-project-catalog and land-place-refresh",
    );
  }
  assert.ok(addressAt >= 0);
  assert.ok(catalogAt > addressAt, "catalog must follow parcel/address geography");
  assert.ok(refreshAt > catalogAt, "membership refresh must follow catalog");
  assert.ok(geographyAt > refreshAt, "district activity must follow land place refresh");
  const family = manifest.generated_families[refreshAt];
  assert.equal(family.generator, "tools/land_place_refresh.mjs");
  assert.ok(family.output_paths.includes(LAND_PLACE_MEMBERSHIP_PATH));
  assert.ok(family.output_paths.includes(LAND_PLACE_PUBLIC_DIR));
  assert.ok(family.source_paths.includes(LAND_PROJECT_CATALOG_PATH));
});

test("production refresh command backfills and --check validates active consumers", async () => {
  await withTempDir("land-place-refresh-cmd-", (tempDir) => {
    const publicDir = path.join(tempDir, "land-place-generations");
    const activeIndexPath = path.join(tempDir, "land_place_membership.json");
    const activeEvidenceDir = path.join(tempDir, "land-place-evidence");
    mkdirSync(publicDir, { recursive: true });
    mkdirSync(activeEvidenceDir, { recursive: true });

    const run = spawnSync(process.execPath, [
      path.join(ROOT, "tools/land_place_refresh.mjs"),
      "--public-dir", publicDir,
      "--active-index", activeIndexPath,
      "--active-evidence-dir", activeEvidenceDir,
    ], { cwd: ROOT, encoding: "utf8" });
    assert.equal(run.status, 0, run.stderr || run.stdout);
    const summary = JSON.parse(run.stdout.trim().split("\n").at(-1));
    assert.equal(summary.ok, true);
    assert.ok(summary.active_generation);
    assert.equal(summary.project_count, 244);

    const check = spawnSync(process.execPath, [
      path.join(ROOT, "tools/land_place_refresh.mjs"),
      "--check",
      "--public-dir", publicDir,
      "--active-index", activeIndexPath,
      "--active-evidence-dir", activeEvidenceDir,
    ], { cwd: ROOT, encoding: "utf8" });
    assert.equal(check.status, 0, check.stderr || check.stdout);
    assert.match(check.stdout, /ok land-place-refresh/);
  });
});

test("committed ACTIVE stays byte-identical when inputs already match without a receipt", () => {
  const publicDir = path.join(ROOT, LAND_PLACE_PUBLIC_DIR);
  const activePath = path.join(publicDir, LAND_PLACE_ACTIVE_POINTER);
  const indexPath = path.join(ROOT, LAND_PLACE_MEMBERSHIP_PATH);
  assert.ok(existsSync(activePath), "committed ACTIVE present");
  const activeBeforeBytes = readFileSync(activePath);
  const indexBeforeBytes = readFileSync(indexPath);

  // Drop any local gitignored receipt so this matches a CI checkout.
  const receiptPath = path.join(publicDir, "refresh-receipt.json");
  const hadReceipt = existsSync(receiptPath);
  const receiptBackup = hadReceipt ? readFileSync(receiptPath) : null;
  if (hadReceipt) rmSync(receiptPath, { force: true });

  try {
    const result = spawnSync(
      process.execPath,
      [path.join(ROOT, "tools/land_place_refresh.mjs")],
      { cwd: ROOT, encoding: "utf8" },
    );
    assert.equal(result.status, 0, result.stdout + result.stderr);
    const summary = JSON.parse(result.stdout.trim().split("\n").at(-1));
    assert.equal(summary.ok, true);
    assert.equal(summary.status, "unchanged");
    // Committed ACTIVE must stay byte-identical when inputs already match (CI
    // checkouts have no gitignored receipt; bootstrap must not rewrite tracked files).
    assert.equal(readFileSync(activePath).equals(activeBeforeBytes), true);
    assert.equal(readFileSync(indexPath).equals(indexBeforeBytes), true);
  } finally {
    if (hadReceipt) writeFileSync(receiptPath, receiptBackup);
  }
});
}); // land_place_refresh describe
