/**
 * Board-neighborhood refresh and coherent generation publication.
 *
 *   node --test test/board_neighborhood_refresh.test.mjs
 *
 * Covers initial backfill, no-op, input correction, removed edge, failed
 * promotion, recovered publication, and pinned-generation reads.
 */

import assert from "node:assert/strict";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  BOARD_NEIGHBORHOOD_INDEX_PATH,
  boardsForNta,
  serializeBoardNeighborhoodIndex,
} from "../site/board_neighborhood_index.mjs";
import {
  BOARD_NEIGHBORHOOD_ACTIVE_POINTER,
  BOARD_NEIGHBORHOOD_CONSUMERS,
  BOARD_NEIGHBORHOOD_PUBLIC_DIR,
  activateBoardNeighborhoodGeneration,
  buildBoardNeighborhoodConsumers,
  computeBoardNeighborhoodInputHashes,
  createBoardNeighborhoodRefresh,
  loadActiveBoardNeighborhoodGeneration,
  loadBoardNeighborhoodRefreshReceipt,
  loadPinnedBoardNeighborhoodGeneration,
  planBoardNeighborhoodRefresh,
  validateBoardNeighborhoodConsumers,
  writeBoardNeighborhoodRefreshReceipt,
} from "../site/board_neighborhood_refresh.mjs";
import { runBoardNeighborhoodRefresh } from "../tools/board_neighborhood_refresh.mjs";
import { withTempDir } from "../tools/lib/with_temp_dir.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CROSSWALK = path.join(
  ROOT,
  "site/data/geography/crosswalks/nta2020__community_district/26B__2026-05-26.json",
);
const ONTOLOGY = path.join(ROOT, "site/data/community_board_geography_lookup.json");
const LABELS = path.join(ROOT, "site/data/geography/layers/nta2020/26B.json");
const MEETING_INDEX = path.join(ROOT, "site/data/community_board_meeting_index.json");

function loadJson(filePath) {
  return JSON.parse(readFileSync(filePath, "utf8"));
}

function seedFixtureDir(tempDir, {
  mutateOntology = null,
  mutateCrosswalk = null,
} = {}) {
  const fixtureDir = path.join(tempDir, "fixture");
  const publicDir = path.join(fixtureDir, "board-neighborhood-generations");
  const activeIndexPath = path.join(fixtureDir, "board_neighborhood_index.json");
  mkdirSync(publicDir, { recursive: true });

  let crosswalk = loadJson(CROSSWALK);
  let ontology = loadJson(ONTOLOGY);
  const labels = loadJson(LABELS);
  if (typeof mutateCrosswalk === "function") crosswalk = mutateCrosswalk(crosswalk);
  if (typeof mutateOntology === "function") ontology = mutateOntology(ontology);

  const crosswalkPath = path.join(fixtureDir, "crosswalk.json");
  const ontologyPath = path.join(fixtureDir, "community_board_geography_lookup.json");
  const labelsPath = path.join(fixtureDir, "nta2020.json");
  writeFileSync(crosswalkPath, `${JSON.stringify(crosswalk)}\n`);
  writeFileSync(ontologyPath, `${JSON.stringify(ontology)}\n`);
  writeFileSync(labelsPath, `${JSON.stringify(labels)}\n`);

  // Calendar-only sibling input that must not invalidate the join.
  if (existsSync(MEETING_INDEX)) {
    cpSync(MEETING_INDEX, path.join(fixtureDir, "community_board_meeting_index.json"));
  }

  return {
    fixtureDir,
    publicDir,
    activeIndexPath,
    crosswalkPath,
    ontologyPath,
    labelsPath,
  };
}

function refreshFromFixture(paths, runOptions = {}) {
  const crosswalkBytes = readFileSync(paths.crosswalkPath);
  const ontologyBytes = readFileSync(paths.ontologyPath);
  const labelBytes = readFileSync(paths.labelsPath);
  const refresh = createBoardNeighborhoodRefresh({
    loadSources: () => ({
      crosswalk: JSON.parse(crosswalkBytes.toString("utf8")),
      geography: JSON.parse(ontologyBytes.toString("utf8")),
      ntaLayer: JSON.parse(labelBytes.toString("utf8")),
      crosswalkBytes,
      ontologyBytes,
      labelBytes,
    }),
    loadPreviousReceipt: () => loadBoardNeighborhoodRefreshReceipt(paths.publicDir),
    saveReceipt: (receipt) => writeBoardNeighborhoodRefreshReceipt(paths.publicDir, receipt),
    loadActiveGeneration: () => (
      loadActiveBoardNeighborhoodGeneration(paths.publicDir)?.pointer?.active_generation || null
    ),
    activateGeneration: (activationArgs) => activateBoardNeighborhoodGeneration({
      publicDir: paths.publicDir,
      activeIndexPath: paths.activeIndexPath,
      ...activationArgs,
    }),
    activeIndexPath: paths.activeIndexPath,
  });
  return refresh.run({
    now: "2026-09-25T18:00:00.000Z",
    builtAt: "2026-08-12T00:00:00.000Z",
    ...runOptions,
  });
}

test("A1 [outcome] clean build activates one generation shared by directory and profile consumers", async () => {
  await withTempDir("board-neighborhood-refresh-a1-", (tempDir) => {
    const paths = seedFixtureDir(tempDir);
    const first = refreshFromFixture(paths);
    assert.equal(first.ok, true);
    assert.equal(first.status, "activated");
    assert.ok(first.active_generation);

    const active = loadActiveBoardNeighborhoodGeneration(paths.publicDir);
    assert.equal(active.pointer.active_generation, first.active_generation);
    assert.equal(active.index.generation.id, first.active_generation);
    assert.equal(active.directory.generation_id, first.active_generation);
    assert.equal(active.profile.generation_id, first.active_generation);
    assert.equal(active.index.inventory.board_associated_row_count, 411);
    assert.equal(active.index.inventory.board_identity_count, 59);

    const consumers = buildBoardNeighborhoodConsumers(active.index);
    const validation = validateBoardNeighborhoodConsumers(consumers, first.active_generation);
    assert.equal(validation.ok, true);
    assert.deepEqual([...BOARD_NEIGHBORHOOD_CONSUMERS], ["index", "directory", "profile"]);

    // Published asset paths belong under the existing committed read-model tree.
    assert.ok(paths.publicDir.includes("board-neighborhood-generations"));
    assert.ok(existsSync(path.join(paths.publicDir, BOARD_NEIGHBORHOOD_ACTIVE_POINTER)));
    assert.ok(existsSync(paths.activeIndexPath));
    assert.equal(
      path.relative(ROOT, path.join(ROOT, BOARD_NEIGHBORHOOD_PUBLIC_DIR)),
      BOARD_NEIGHBORHOOD_PUBLIC_DIR,
    );
    assert.equal(
      path.relative(ROOT, path.join(ROOT, BOARD_NEIGHBORHOOD_INDEX_PATH)),
      BOARD_NEIGHBORHOOD_INDEX_PATH,
    );
  });
});

test("A2 [outcome] covers/crosswalk changes rebuild; calendar-only and unchanged inputs do not rewrite bytes", async () => {
  await withTempDir("board-neighborhood-refresh-a2-", (tempDir) => {
    const paths = seedFixtureDir(tempDir);
    const first = refreshFromFixture(paths);
    assert.equal(first.status, "activated");
    const generation = first.active_generation;
    const indexBefore = readFileSync(paths.activeIndexPath);
    const pointerBefore = readFileSync(path.join(paths.publicDir, BOARD_NEIGHBORHOOD_ACTIVE_POINTER));
    const directoryBefore = readFileSync(
      path.join(paths.publicDir, generation, "directory.json"),
    );

    // Unchanged inputs → no-op; relationship bytes and pointer stay identical.
    const noop = refreshFromFixture(paths);
    assert.equal(noop.ok, true);
    assert.equal(noop.status, "unchanged");
    assert.equal(noop.active_generation, generation);
    assert.equal(readFileSync(paths.activeIndexPath).equals(indexBefore), true);
    assert.equal(
      readFileSync(path.join(paths.publicDir, BOARD_NEIGHBORHOOD_ACTIVE_POINTER)).equals(pointerBefore),
      true,
    );
    assert.equal(
      readFileSync(path.join(paths.publicDir, generation, "directory.json")).equals(directoryBefore),
      true,
    );

    // Calendar-only sibling bytes are outside the input hash set.
    const hashes = computeBoardNeighborhoodInputHashes({
      crosswalkBytes: readFileSync(paths.crosswalkPath),
      ontologyBytes: readFileSync(paths.ontologyPath),
      labelBytes: readFileSync(paths.labelsPath),
      boundaryGeneration: { nta2020: "26B", community_district: "2026-05-26" },
    });
    const plan = planBoardNeighborhoodRefresh({
      previousHashes: hashes,
      currentHashes: hashes,
      activeGeneration: generation,
    });
    assert.equal(plan.work_required, false);

    // Remove one covers edge → rebuild and new generation.
    const ontology = loadJson(paths.ontologyPath);
    ontology.public_edges = (ontology.public_edges || []).filter(
      (edge) => !(edge.type === "covers" && edge.from === "community-board:brooklyn-cb-14"),
    );
    writeFileSync(paths.ontologyPath, `${JSON.stringify(ontology)}\n`);
    const corrected = refreshFromFixture(paths);
    assert.equal(corrected.ok, true);
    assert.equal(corrected.status, "activated");
    assert.notEqual(corrected.active_generation, generation);
    assert.equal(corrected.previous_active_generation, generation);

    const active = loadActiveBoardNeighborhoodGeneration(paths.publicDir);
    assert.equal(active.pointer.previous_generation, generation);
    assert.ok(existsSync(path.join(paths.publicDir, generation)));
    const kensington = boardsForNta(active.index, "BK1203");
    assert.deepEqual(
      kensington.map((edge) => edge.board_id),
      ["brooklyn-cb-12"],
    );
  });
});

test("A3 [boundary] missing crosswalk, invalid ontology, and mixed-generation inputs retain last-good", async () => {
  await withTempDir("board-neighborhood-refresh-a3-", (tempDir) => {
    const paths = seedFixtureDir(tempDir);
    const first = refreshFromFixture(paths);
    const kept = first.active_generation;
    const indexBefore = readFileSync(paths.activeIndexPath);

    const missing = refreshFromFixture(paths, { injectFailure: "missing_crosswalk" });
    assert.equal(missing.ok, false);
    assert.equal(missing.status, "failed");
    assert.equal(missing.active_generation, kept);
    assert.equal(missing.receipt.last_good_preserved, true);
    assert.equal(missing.receipt.failed_at, "2026-09-25T18:00:00.000Z");
    assert.deepEqual(missing.receipt.vintages, first.receipt.vintages);
    assert.equal(readFileSync(paths.activeIndexPath).equals(indexBefore), true);

    const invalid = refreshFromFixture(paths, { injectFailure: "invalid_ontology" });
    assert.equal(invalid.ok, false);
    assert.equal(invalid.status, "failed");
    assert.equal(invalid.active_generation, kept);
    assert.equal(invalid.receipt.last_good_preserved, true);
    assert.equal(invalid.receipt.failure?.kind, "empty_association_table");

    const mixed = refreshFromFixture(paths, { injectFailure: "mixed_generation" });
    assert.equal(mixed.ok, false);
    assert.equal(mixed.status, "failed");
    assert.equal(mixed.active_generation, kept);
    assert.equal(mixed.receipt.failure?.kind, "consumer_validation_failed");
    assert.ok(mixed.receipt.failure?.validation_errors?.includes("generation_mismatch:profile"));
    assert.equal(
      loadActiveBoardNeighborhoodGeneration(paths.publicDir).pointer.active_generation,
      kept,
    );
    assert.equal(readFileSync(paths.activeIndexPath).equals(indexBefore), true);
  });
});

test("A4 [verification] command covers backfill, no-op, correction, removed edge, failed promotion, recovery", async () => {
  await withTempDir("board-neighborhood-refresh-a4-", (tempDir) => {
    const paths = seedFixtureDir(tempDir);

    const backfill = runBoardNeighborhoodRefresh({
      fixtureDir: paths.fixtureDir,
      publicDir: paths.publicDir,
      activeIndexPath: paths.activeIndexPath,
      crosswalkPath: paths.crosswalkPath,
      ontologyPath: paths.ontologyPath,
      labelsPath: paths.labelsPath,
      now: "2026-09-25T18:00:00.000Z",
      builtAt: "2026-08-12T00:00:00.000Z",
    });
    assert.equal(backfill.ok, true, JSON.stringify(backfill.receipt || backfill));
    assert.equal(backfill.status, "activated");
    const kept = backfill.active_generation;

    const noop = runBoardNeighborhoodRefresh({
      fixtureDir: paths.fixtureDir,
      publicDir: paths.publicDir,
      activeIndexPath: paths.activeIndexPath,
      crosswalkPath: paths.crosswalkPath,
      ontologyPath: paths.ontologyPath,
      labelsPath: paths.labelsPath,
      now: "2026-09-25T18:05:00.000Z",
      builtAt: "2026-08-12T00:00:00.000Z",
    });
    assert.equal(noop.status, "unchanged");
    assert.equal(noop.active_generation, kept);

    // Input correction: drop BK1203→K14 material row.
    const crosswalk = loadJson(paths.crosswalkPath);
    crosswalk.rows = (crosswalk.rows || []).filter((row) => !(
      String(row.from_key || "").endsWith(":BK1203")
      && String(row.to_key || "").endsWith(":K14")
      && row.material_for_navigation === true
    ));
    writeFileSync(paths.crosswalkPath, `${JSON.stringify(crosswalk)}\n`);
    const corrected = runBoardNeighborhoodRefresh({
      fixtureDir: paths.fixtureDir,
      publicDir: paths.publicDir,
      activeIndexPath: paths.activeIndexPath,
      crosswalkPath: paths.crosswalkPath,
      ontologyPath: paths.ontologyPath,
      labelsPath: paths.labelsPath,
      now: "2026-09-25T18:10:00.000Z",
      builtAt: "2026-08-12T00:00:00.000Z",
    });
    assert.equal(corrected.status, "activated");
    assert.notEqual(corrected.active_generation, kept);
    const afterCorrection = loadActiveBoardNeighborhoodGeneration(paths.publicDir);
    assert.deepEqual(
      boardsForNta(afterCorrection.index, "BK1203").map((edge) => edge.district_id),
      ["K12"],
    );

    const failed = spawnSync(
      process.execPath,
      [
        path.join(ROOT, "tools/board_neighborhood_refresh.mjs"),
        "--fixture-dir", paths.fixtureDir,
        "--public-dir", paths.publicDir,
        "--active-index", paths.activeIndexPath,
        "--crosswalk", paths.crosswalkPath,
        "--ontology", paths.ontologyPath,
        "--labels", paths.labelsPath,
        "--force",
        "--inject-failure", "before_activate",
      ],
      { cwd: ROOT, encoding: "utf8" },
    );
    assert.notEqual(failed.status, 0, failed.stdout + failed.stderr);
    const still = loadActiveBoardNeighborhoodGeneration(paths.publicDir);
    assert.equal(still.pointer.active_generation, corrected.active_generation);
    const failureReceipt = loadBoardNeighborhoodRefreshReceipt(paths.publicDir);
    assert.equal(failureReceipt.status, "failed");
    assert.ok(failureReceipt.failed_at);
    assert.deepEqual(failureReceipt.vintages, corrected.receipt.vintages);

    // Recovery: force a clean activation after the failed attempt.
    const recovered = runBoardNeighborhoodRefresh({
      fixtureDir: paths.fixtureDir,
      publicDir: paths.publicDir,
      activeIndexPath: paths.activeIndexPath,
      crosswalkPath: paths.crosswalkPath,
      ontologyPath: paths.ontologyPath,
      labelsPath: paths.labelsPath,
      force: true,
      now: "2026-09-25T18:20:00.000Z",
      builtAt: "2026-08-12T00:00:00.000Z",
    });
    assert.equal(recovered.ok, true);
    assert.equal(recovered.status, "activated");
    assert.equal(
      loadActiveBoardNeighborhoodGeneration(paths.publicDir).pointer.active_generation,
      recovered.active_generation,
    );
  });
});

test("A5 [boundary,verification] assets publish before active switch; pin one generation; retain previous", async () => {
  await withTempDir("board-neighborhood-refresh-a5-", (tempDir) => {
    const paths = seedFixtureDir(tempDir);
    const first = refreshFromFixture(paths);
    const firstGeneration = first.active_generation;

    // Second generation via ontology edit.
    const ontology = loadJson(paths.ontologyPath);
    ontology.public_edges = (ontology.public_edges || []).filter(
      (edge) => !(edge.type === "covers" && edge.from === "community-board:brooklyn-cb-12"),
    );
    writeFileSync(paths.ontologyPath, `${JSON.stringify(ontology)}\n`);
    const second = refreshFromFixture(paths, { now: "2026-09-25T19:00:00.000Z" });
    assert.equal(second.status, "activated");
    assert.notEqual(second.active_generation, firstGeneration);
    assert.equal(second.previous_active_generation, firstGeneration);

    const active = loadActiveBoardNeighborhoodGeneration(paths.publicDir);
    assert.equal(active.pointer.active_generation, second.active_generation);
    assert.equal(active.pointer.previous_generation, firstGeneration);
    assert.ok(existsSync(path.join(paths.publicDir, firstGeneration, "index.json")));
    assert.ok(existsSync(path.join(paths.publicDir, second.active_generation, "index.json")));

    const pinnedFirst = loadPinnedBoardNeighborhoodGeneration(paths.publicDir, firstGeneration);
    assert.equal(pinnedFirst.ok, true);
    assert.equal(pinnedFirst.assets.generation_id, firstGeneration);
    assert.equal(pinnedFirst.assets.directory.generation_id, firstGeneration);
    assert.equal(pinnedFirst.assets.profile.generation_id, firstGeneration);

    const pinnedSecond = loadPinnedBoardNeighborhoodGeneration(
      paths.publicDir,
      second.active_generation,
    );
    assert.equal(pinnedSecond.ok, true);
    assert.equal(pinnedSecond.assets.generation_id, second.active_generation);

    const missing = loadPinnedBoardNeighborhoodGeneration(paths.publicDir, "missing-generation");
    assert.equal(missing.ok, false);
    assert.equal(missing.retry, true);
    assert.equal(missing.reason, "generation_unavailable");

    // Fail-before-activate leaves staged assets unpublished and the prior pin usable.
    const thirdAttempt = refreshFromFixture(paths, {
      now: "2026-09-25T19:30:00.000Z",
      injectFailure: "before_activate",
    });
    assert.equal(thirdAttempt.ok, false);
    assert.equal(
      loadActiveBoardNeighborhoodGeneration(paths.publicDir).pointer.active_generation,
      second.active_generation,
    );
    assert.equal(
      loadPinnedBoardNeighborhoodGeneration(paths.publicDir, second.active_generation).ok,
      true,
    );
    assert.equal(existsSync(path.join(paths.publicDir, ".staging")), false);
  });
});

test("derived manifest registers board-neighborhood-refresh before constellation", () => {
  const manifest = loadJson(path.join(ROOT, "warehouse/derived_json_build_manifest.json"));
  const ids = manifest.generated_families.map((family) => family.id);
  const refreshAt = ids.indexOf("board-neighborhood-refresh");
  const constellationAt = ids.indexOf("community-board-constellation");
  assert.ok(refreshAt >= 0);
  assert.ok(constellationAt > refreshAt);
  const family = manifest.generated_families[refreshAt];
  assert.equal(family.generator, "tools/board_neighborhood_refresh.mjs");
  assert.ok(family.output_paths.includes("site/data/board_neighborhood_index.json"));
  assert.ok(family.output_paths.includes("site/data/board-neighborhood-generations"));
  const constellation = manifest.generated_families[constellationAt];
  assert.ok(constellation.source_paths.includes("site/data/board_neighborhood_index.json"));
  assert.ok(constellation.source_paths.includes("site/data/board-neighborhood-generations/ACTIVE"));
});

test("production refresh command backfills and --check validates active consumers", () => {
  const publicDir = path.join(ROOT, BOARD_NEIGHBORHOOD_PUBLIC_DIR);
  const activePath = path.join(publicDir, BOARD_NEIGHBORHOOD_ACTIVE_POINTER);
  const activeBeforeBytes = readFileSync(activePath);

  const result = spawnSync(
    process.execPath,
    [path.join(ROOT, "tools/board_neighborhood_refresh.mjs")],
    { cwd: ROOT, encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const summary = JSON.parse(result.stdout.trim().split("\n").at(-1));
  assert.ok(summary.ok);
  assert.ok(["activated", "unchanged"].includes(summary.status));
  // Committed ACTIVE must stay byte-identical when inputs already match (CI
  // checkouts have no gitignored receipt; bootstrap must not rewrite tracked files).
  assert.equal(readFileSync(activePath).equals(activeBeforeBytes), true);

  const check = spawnSync(
    process.execPath,
    [path.join(ROOT, "tools/board_neighborhood_refresh.mjs"), "--check"],
    { cwd: ROOT, encoding: "utf8" },
  );
  assert.equal(check.status, 0, check.stdout + check.stderr);
  assert.match(check.stdout, /ok board-neighborhood-refresh/);

  const active = loadActiveBoardNeighborhoodGeneration(publicDir);
  assert.ok(active);
  assert.equal(active.index.generation.id, active.pointer.active_generation);
  assert.equal(active.directory.generation_id, active.pointer.active_generation);
  assert.equal(active.profile.generation_id, active.pointer.active_generation);

  // Convenience index stays byte-identical to the generation asset.
  const committed = readFileSync(path.join(ROOT, BOARD_NEIGHBORHOOD_INDEX_PATH), "utf8");
  const generationIndex = serializeBoardNeighborhoodIndex(active.index);
  assert.equal(committed, generationIndex);
});
